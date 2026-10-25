'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { IncomingForm, multipart } = require('formidable');
const { validateUrl } = require('./url-validator');
const { createPinnedHttpAgents } = require('./pinned-http-agents');

const IMAGE_ORIGIN = 'https://img.bloret.net';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FORM_BYTES = MAX_IMAGE_BYTES + 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

class AvatarUploadError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function deadlineSignal(parent, timeoutMs, message) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new AvatarUploadError(message, 504)), timeoutMs);
  return {
    signal: controller.signal,
    abort(reason) { controller.abort(reason); },
    cleanup() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

// Use a private per-request directory; Formidable leaves successful uploads on disk.
async function readAvatarUpload(req, { signal, tempRoot = os.tmpdir(), timeoutMs = 30_000 } = {}) {
  if (!/^multipart\/form-data(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new AvatarUploadError('请使用图片上传表单', 415);
  }
  if (Number(req.headers['content-length']) > MAX_FORM_BYTES) {
    throw new AvatarUploadError('图片或表单超过上传限制', 413);
  }
  const deadline = deadlineSignal(signal, timeoutMs, '图片上传超时');
  let directory;
  const onAbort = () => req.destroy();
  try {
    deadline.signal.throwIfAborted();
    directory = await fs.mkdtemp(path.join(tempRoot, 'crewrouter-avatar-'));
    deadline.signal.throwIfAborted();
    const form = new IncomingForm({
      uploadDir: directory,
      enabledPlugins: [multipart],
      maxFileSize: MAX_IMAGE_BYTES,
      maxTotalFileSize: MAX_IMAGE_BYTES,
      maxFiles: 1,
      maxFields: 0,
      maxFieldsSize: 1024,
    });
    // File limits do not cover multipart headers; bound the entire wire body too.
    form.on('progress', received => {
      if (received > MAX_FORM_BYTES) {
        deadline.abort(new AvatarUploadError('图片或表单超过上传限制', 413));
      }
    });
    deadline.signal.addEventListener('abort', onAbort, { once: true });
    const [, files] = await abortable(form.parse(req), deadline.signal);
    const file = files.image?.[0];
    if (!file) throw new AvatarUploadError('未选择图片', 400);
    const data = await fs.readFile(file.filepath, { signal: deadline.signal });
    deadline.signal.throwIfAborted();
    if (!data.length || data.length > MAX_IMAGE_BYTES) {
      throw new AvatarUploadError('图片大小必须为 1 字节至 5 MiB', 413);
    }
    return { data, filename: file.originalFilename, mimetype: file.mimetype };
  } catch (error) {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    if (error.httpCode === 413) throw new AvatarUploadError('图片或表单超过上传限制', 413);
    if (error.httpCode === 400) throw new AvatarUploadError('图片上传请求无效', 400);
    throw error;
  } finally {
    deadline.signal.removeEventListener('abort', onAbort);
    deadline.cleanup();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}

function multipartBody(image) {
  if (!Buffer.isBuffer(image.data) || !image.data.length || image.data.length > MAX_IMAGE_BYTES) {
    throw new AvatarUploadError('图片大小必须为 1 字节至 5 MiB', 413);
  }
  const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
  const filename = String(image.filename || 'avatar.jpg').replace(/[\x00-\x1f\x7f"\\]/g, '_').slice(0, 128);
  const candidate = String(image.mimetype || 'image/jpeg').trim().toLowerCase();
  const mimetype = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(candidate)
    ? candidate : 'application/octet-stream';
  const header = '--' + boundary + '\r\n'
    + 'Content-Disposition: form-data; name="image"; filename="' + filename + '"\r\n'
    + 'Content-Type: ' + mimetype + '\r\n\r\n';
  return {
    boundary,
    body: Buffer.concat([Buffer.from(header), image.data, Buffer.from('\r\n--' + boundary + '--\r\n')]),
  };
}

function requestUploadJson(url, payload, agent, signal, request) {
  return new Promise((resolve, reject) => {
    let upstream;
    let response;
    let settled = false;
    let ended = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) {
        response?.destroy();
        upstream?.destroy();
        reject(error);
      } else resolve(value);
    };
    const onAbort = () => finish(signal.reason);
    if (signal.aborted) return finish(signal.reason);
    try {
      upstream = request(url, {
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + payload.boundary,
          'Content-Length': payload.body.length,
        },
      }, incoming => {
        response = incoming;
        response.on('error', error => finish(error));
        response.once('aborted', () => finish(new AvatarUploadError('图床响应中断')));
        response.once('close', () => {
          if (!ended) finish(new AvatarUploadError('图床响应中断'));
        });
        if (settled) return response.destroy();
        // Native HTTPS requests never follow redirects. Reject 3xx without reading a new target.
        if (!(response.statusCode >= 200 && response.statusCode < 300)) {
          return finish(new AvatarUploadError('图床返回 HTTP ' + response.statusCode));
        }
        if (Number(response.headers['content-length']) > MAX_RESPONSE_BYTES) {
          return finish(new AvatarUploadError('图床响应超过 64 KiB 限制'));
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            return finish(new AvatarUploadError('图床响应超过 64 KiB 限制'));
          }
          chunks.push(chunk);
        });
        response.once('end', () => {
          ended = true;
          if (settled) return;
          try {
            finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            finish(new AvatarUploadError('图床响应不是有效 JSON'));
          }
        });
      });
      upstream.on('error', error => finish(error));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      if (!settled) upstream.end(payload.body);
    } catch (error) {
      finish(error);
    }
  });
}

function avatarUrlFromResult(result) {
  if (result?.success !== true || typeof result.data?.url !== 'string'
      || !result.data.url.trim() || result.data.url.length > 2048) {
    throw new AvatarUploadError('图床未返回有效的头像地址');
  }
  let url;
  try { url = new URL(result.data.url, IMAGE_ORIGIN + '/'); } catch {
    throw new AvatarUploadError('图床返回的头像地址无效');
  }
  if (url.origin !== IMAGE_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new AvatarUploadError('图床返回的头像地址无效');
  }
  return url.toString();
}

async function uploadAvatarImage(image, {
  signal,
  timeoutMs = 10_000,
  validateTarget = validateUrl,
  createAgents = createPinnedHttpAgents,
  request = https.request,
} = {}) {
  const deadline = deadlineSignal(signal, timeoutMs, '图床请求超时');
  let agents;
  try {
    deadline.signal.throwIfAborted();
    const payload = multipartBody(image);
    const check = await abortable(validateTarget(IMAGE_ORIGIN + '/api/upload'), deadline.signal);
    if (!check.ok || check.url?.protocol !== 'https:' || check.url.origin !== IMAGE_ORIGIN
        || check.url.username || check.url.password) {
      throw new AvatarUploadError('图床地址安全校验失败');
    }
    deadline.signal.throwIfAborted();
    agents = createAgents(check);
    const result = await requestUploadJson(check.url, payload, agents.httpsAgent, deadline.signal, request);
    return avatarUrlFromResult(result);
  } finally {
    deadline.cleanup();
    agents?.destroy();
  }
}

function createAvatarUploadHandler({ pool, logger, readImage = readAvatarUpload, uploadImage = uploadAvatarImage }) {
  return async (req, res) => {
    const controller = new AbortController();
    const onAborted = () => controller.abort(new Error('客户端连接已关闭'));
    const onClose = () => { if (!res.writableEnded) onAborted(); };
    req.once('aborted', onAborted);
    res.once('close', onClose);
    try {
      if (req.aborted || res.destroyed) onAborted();
      controller.signal.throwIfAborted();
      const image = await readImage(req, { signal: controller.signal });
      const avatarUrl = await uploadImage(image, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const result = await pool.query(
        'UPDATE users SET avatar = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id',
        [req.session.user.id, avatarUrl]
      );
      if (result.rowCount !== 1) throw new AvatarUploadError('用户不存在，请重新登录', 401);
      controller.signal.throwIfAborted();
      req.session.user.avatar = avatarUrl;
      res.json({ success: true, url: avatarUrl });
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      logger.error('[上传头像] 错误:', error.message);
      const known = error instanceof AvatarUploadError;
      res.status(known ? error.status : 500).json({ error: known ? error.message : '头像保存失败，请稍后重试' });
    } finally {
      req.removeListener('aborted', onAborted);
      res.removeListener('close', onClose);
    }
  };
}

module.exports = { readAvatarUpload, uploadAvatarImage, createAvatarUploadHandler };
