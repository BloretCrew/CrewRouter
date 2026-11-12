'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { IncomingForm, multipart } = require('formidable');
const { extractDocumentText } = require('./document-extract');

const MAX_FILES = 5;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_DOC_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES_PER_THREAD = 50;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_FORM_BYTES = MAX_TOTAL_BYTES + 256 * 1024;
const MAX_VISION_IMAGES = 3;
const MAX_VISION_BYTES = 10 * 1024 * 1024;

class AttachmentError extends Error {
  constructor(message, status = 400, code = 'attachment_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function deadlineSignal(parent, timeoutMs, message) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new AttachmentError(message, 504, 'upload_timeout')), timeoutMs);
  return {
    signal: controller.signal,
    abort(reason) { controller.abort(reason); },
    cleanup() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    }
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
      if (!signal.aborted) reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

function cleanFilename(value) {
  return String(value || 'file')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 200) || 'file';
}

async function readAgentUploads(req, { signal, tempRoot = os.tmpdir(), timeoutMs = 30_000 } = {}) {
  if (!/^multipart\/form-data(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new AttachmentError('请使用 multipart 表单上传附件', 415, 'invalid_content_type');
  }
  if (Number(req.headers['content-length']) > MAX_FORM_BYTES) {
    throw new AttachmentError('附件总量超过 20 MiB', 413, 'upload_too_large');
  }
  const deadline = deadlineSignal(signal, timeoutMs, '附件上传超时');
  let directory;
  const onAbort = () => req.destroy();
  try {
    deadline.signal.throwIfAborted();
    directory = await fs.mkdtemp(path.join(tempRoot, 'crewrouter-agent-'));
    deadline.signal.throwIfAborted();
    const form = new IncomingForm({
      uploadDir: directory,
      enabledPlugins: [multipart],
      maxFileSize: MAX_DOC_BYTES,
      maxTotalFileSize: MAX_TOTAL_BYTES,
      maxFiles: MAX_FILES,
      maxFields: 2,
      maxFieldsSize: 2048
    });
    form.on('progress', received => {
      if (received > MAX_FORM_BYTES) {
        deadline.abort(new AttachmentError('附件总量超过 20 MiB', 413, 'upload_too_large'));
      }
    });
    deadline.signal.addEventListener('abort', onAbort, { once: true });
    const [fields, files] = await abortable(form.parse(req), deadline.signal);
    const entries = Object.values(files || {}).flat().filter(Boolean);
    if (!entries.length) throw new AttachmentError('未选择附件', 400, 'no_files');
    if (entries.length > MAX_FILES) throw new AttachmentError(`一次最多上传 ${MAX_FILES} 个附件`, 400, 'too_many_files');
    const result = [];
    for (const file of entries) {
      const data = await fs.readFile(file.filepath, { signal: deadline.signal });
      deadline.signal.throwIfAborted();
      if (!data.length) continue;
      result.push({
        data,
        filename: cleanFilename(file.originalFilename),
        mimetype: String(file.mimetype || '')
      });
    }
    if (!result.length) throw new AttachmentError('附件为空', 400, 'empty_file');
    const fieldValue = name => {
      const value = fields?.[name];
      return Array.isArray(value) ? value[0] : value;
    };
    return { files: result, threadId: fieldValue('thread_id') };
  } catch (error) {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    if (error.httpCode === 413) throw new AttachmentError('附件总量超过 20 MiB', 413, 'upload_too_large');
    if (error.httpCode === 400) throw new AttachmentError('附件上传请求无效', 400, 'invalid_upload');
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError(error.message || '附件上传失败', 400, 'upload_failed');
  } finally {
    deadline.signal.removeEventListener('abort', onAbort);
    deadline.cleanup();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}

function mapAttachment(row) {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    filename: row.filename,
    mime: row.mime,
    bytes: Number(row.byte_size || 0),
    chars: Number(row.text_chars || 0),
    truncated: row.truncated === true,
    url: row.meta?.url || null,
    created_at: row.created_at
  };
}

async function countThreadAttachments(db, { userId, threadId }) {
  if (!threadId) return 0;
  const result = await db.query(
    'SELECT COUNT(*)::int AS count FROM agent_attachments WHERE user_id = $1 AND thread_id = $2',
    [userId, threadId]
  );
  return Number(result.rows[0]?.count || 0);
}

async function storeAttachment(db, {
  userId, threadId = null, source = 'upload', kind, filename, mime,
  bytes = null, byteSize = 0, sourceBytes = null, extractedText = '', textChars = 0,
  truncated = false, meta = {}
}) {
  const digest = crypto.createHash('sha256')
    .update(bytes || sourceBytes || Buffer.from(extractedText || ''))
    .digest('hex');
  const existing = await db.query(
    `SELECT * FROM agent_attachments
     WHERE user_id = $1 AND sha256 = $2 AND (thread_id IS NULL OR thread_id = $3)
     ORDER BY id LIMIT 1`,
    [userId, digest, threadId]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (threadId && row.thread_id === null) {
      const bound = await db.query(
        'UPDATE agent_attachments SET thread_id = $2 WHERE id = $1 RETURNING *',
        [row.id, threadId]
      );
      return { attachment: mapAttachment(bound.rows[0] || row), reused: true };
    }
    return { attachment: mapAttachment(row), reused: true };
  }
  const result = await db.query(
    `INSERT INTO agent_attachments
       (user_id, thread_id, source, kind, filename, mime, byte_size, sha256, bytes,
        extracted_text, text_chars, truncated, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     RETURNING *`,
    [
      userId, threadId, source, kind, cleanFilename(filename), String(mime || '').slice(0, 128),
      Number(byteSize || bytes?.length || Buffer.byteLength(extractedText || '')), digest,
      kind === 'image' ? bytes : null, extractedText || '', Number(textChars || 0),
      truncated === true, JSON.stringify(meta || {})
    ]
  );
  return { attachment: mapAttachment(result.rows[0]), reused: false };
}

async function processUploads(db, { files, userId, threadId = null }) {
  const attachments = [];
  const errors = [];
  let existingCount = await countThreadAttachments(db, { userId, threadId });
  for (const file of files) {
    try {
      if (file.data.length > MAX_DOC_BYTES) {
        throw new AttachmentError(`文件「${file.filename}」超过 8 MiB`, 413, 'file_too_large');
      }
      const extracted = await extractDocumentText({
        bytes: file.data,
        filename: file.filename,
        mime: file.mimetype
      });
      if (!extracted.ok) {
        throw new AttachmentError(extracted.error || '附件解析失败', 400, extracted.code || 'extract_failed');
      }
      if (extracted.kind === 'image' && file.data.length > MAX_IMAGE_BYTES) {
        throw new AttachmentError(`图片「${file.filename}」超过 4 MiB`, 413, 'image_too_large');
      }
      if (threadId && existingCount >= MAX_FILES_PER_THREAD) {
        throw new AttachmentError(`每个对话最多 ${MAX_FILES_PER_THREAD} 个附件`, 400, 'thread_attachment_limit');
      }
      const stored = await storeAttachment(db, {
        userId,
        threadId,
        source: 'upload',
        kind: extracted.kind,
        filename: file.filename,
        mime: extracted.mime,
        bytes: extracted.kind === 'image' ? file.data : null,
        byteSize: file.data.length,
        sourceBytes: file.data,
        extractedText: extracted.text || '',
        textChars: (extracted.text || '').length,
        truncated: extracted.truncated === true,
        meta: { warnings: extracted.warnings || [], ...(extracted.meta || {}) }
      });
      if (!stored.reused) existingCount += 1;
      attachments.push(stored.attachment);
    } catch (error) {
      errors.push({
        filename: file.filename,
        code: error.code || 'attachment_failed',
        error: error.message || '附件处理失败'
      });
    }
  }
  return { attachments, errors };
}

async function bindAttachments(db, { userId, threadId, ids }) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  if (!unique.length) return [];
  if (unique.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AttachmentError(`一条消息最多附加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`, 400, 'too_many_attachments');
  }
  const thread = await db.query(
    "SELECT id FROM agent_threads WHERE id = $1 AND user_id = $2 AND mode = 'manage'",
    [threadId, userId]
  );
  if (!thread.rows[0]) throw new AttachmentError('对话不存在', 404, 'thread_not_found');
  const [currentCount, alreadyBound] = await Promise.all([
    countThreadAttachments(db, { userId, threadId }),
    db.query(
      `SELECT COUNT(*)::int AS count FROM agent_attachments
       WHERE id = ANY($1::int[]) AND user_id = $2 AND thread_id = $3`,
      [unique, userId, threadId]
    )
  ]);
  const incoming = unique.length - Number(alreadyBound.rows[0]?.count || 0);
  if (currentCount + incoming > MAX_FILES_PER_THREAD) {
    throw new AttachmentError(`每个对话最多 ${MAX_FILES_PER_THREAD} 个附件`, 400, 'thread_attachment_limit');
  }
  const result = await db.query(
    `UPDATE agent_attachments
     SET thread_id = $3
     WHERE id = ANY($1::int[]) AND user_id = $2 AND (thread_id IS NULL OR thread_id = $3)
     RETURNING *`,
    [unique, userId, threadId]
  );
  if (result.rows.length !== unique.length) {
    throw new AttachmentError('部分附件不存在、不属于当前用户或已绑定其他对话', 409, 'attachment_unavailable');
  }
  return result.rows.map(mapAttachment);
}

async function listThreadAttachments(db, { userId, threadId }) {
  if (!threadId) return [];
  const result = await db.query(
    `SELECT * FROM agent_attachments
     WHERE user_id = $1 AND thread_id = $2
     ORDER BY id`,
    [userId, threadId]
  );
  return result.rows.map(mapAttachment);
}

async function deleteAttachment(db, { id, userId, threadId = null }) {
  const result = await db.query(
    `DELETE FROM agent_attachments
     WHERE id = $1 AND user_id = $2 AND (thread_id IS NULL OR thread_id = $3)
     RETURNING id`,
    [id, userId, threadId]
  );
  return Boolean(result.rows[0]);
}

async function getAttachmentContent(db, { id, userId }) {
  const result = await db.query(
    `SELECT id, kind, mime, bytes FROM agent_attachments
     WHERE id = $1 AND user_id = $2 AND kind = 'image'`,
    [id, userId]
  );
  return result.rows[0] || null;
}

async function cleanupDraftAttachments(db, userId) {
  try {
    await db.query(
      `DELETE FROM agent_attachments
       WHERE user_id = $1 AND thread_id IS NULL
         AND created_at < NOW() - INTERVAL '24 hours'`,
      [userId]
    );
  } catch (_) { /* 清理失败不影响主流程 */ }
}

async function loadVisionImages(db, { userId, threadId, ids = [], maxImages = MAX_VISION_IMAGES }) {
  if (!threadId) return [];
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))].slice(0, maxImages);
  if (!unique.length) return [];
  const result = await db.query(
    `SELECT id, mime, bytes, byte_size FROM agent_attachments
     WHERE id = ANY($1::int[]) AND user_id = $2 AND thread_id = $3 AND kind = 'image'
     ORDER BY id`,
    [unique, userId, threadId]
  );
  const images = [];
  let total = 0;
  for (const row of result.rows) {
    const bytes = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes || []);
    if (!bytes.length || total + bytes.length > MAX_VISION_BYTES) continue;
    total += bytes.length;
    images.push({
      attachment_id: Number(row.id),
      mime: row.mime,
      base64: bytes.toString('base64')
    });
  }
  return images;
}

function attachmentManifest(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  const lines = attachments.map(item => {
    const size = item.kind === 'image'
      ? `${Math.max(1, Math.round(item.bytes / 1024))} KiB`
      : `${item.chars || 0} 字符`;
    return `- [附件 #${item.id}] ${item.filename} (${item.kind}, ${size}${item.truncated ? ', 已截断' : ''})`;
  });
  return ['[用户上传资料]', ...lines].join('\n');
}

function toMessageAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : []).map(item => ({
    id: item.id,
    kind: item.kind,
    filename: item.filename,
    mime: item.mime,
    byte_size: item.bytes,
    truncated: item.truncated === true,
    source: item.source || 'upload',
    url: item.url || null
  }));
}

module.exports = {
  ATTACHMENT_LIMITS: {
    MAX_FILES,
    MAX_IMAGE_BYTES,
    MAX_DOC_BYTES,
    MAX_TOTAL_BYTES,
    MAX_FILES_PER_THREAD,
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_VISION_IMAGES,
    MAX_VISION_BYTES
  },
  AttachmentError,
  readAgentUploads,
  processUploads,
  bindAttachments,
  listThreadAttachments,
  deleteAttachment,
  getAttachmentContent,
  cleanupDraftAttachments,
  loadVisionImages,
  attachmentManifest,
  toMessageAttachments,
  mapAttachment
};
