'use strict';

const { validateUrl } = require('./url-validator');
const { pinnedFetchValidated } = require('../proxy-pool');
const { decodeText, extractDocumentText, sniffImageMime, MAX_EXTRACTED_CHARS } = require('./document-extract');
const { storeAttachment } = require('./agent-attachments');
const { htmlToText } = require('./html-text');

const MAX_REDIRECTS = 5;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const ALLOWED_PORTS = new Set(['', '80', '443']);

class FetchError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function assertSafeUrl(url) {
  if (url.username || url.password) throw new FetchError('fetch_blocked', '链接不能包含用户名或密码');
  if (!ALLOWED_PORTS.has(url.port)) throw new FetchError('fetch_blocked', `不允许的端口: ${url.port}`);
}

async function fetchWithRedirects(rawUrl, signal) {
  let current;
  try { current = new URL(String(rawUrl || '')); }
  catch (_) { throw new FetchError('fetch_invalid_url', '链接格式无效'); }
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    assertSafeUrl(current);
    const check = await validateUrl(current.toString(), { allowPrivate: false });
    if (!check.ok) throw new FetchError('fetch_blocked', check.error || '链接未通过安全校验');
    const response = await pinnedFetchValidated(check, {
      signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'CrewRouter-Agent/1.0',
        Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,application/json,text/csv;q=0.9,*/*;q=0.5'
      }
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current };
    }
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location) throw new FetchError('fetch_http_error', '重定向缺少 Location', 502);
    let next;
    try { next = new URL(location, current); }
    catch (_) { throw new FetchError('fetch_invalid_url', '重定向地址无效'); }
    if (current.protocol === 'https:' && next.protocol !== 'https:') {
      throw new FetchError('fetch_blocked', '拒绝从 HTTPS 降级到非 HTTPS');
    }
    if (redirects === MAX_REDIRECTS) throw new FetchError('fetch_too_many_redirects', '重定向次数过多');
    current = next;
  }
  throw new FetchError('fetch_too_many_redirects', '重定向次数过多');
}

async function readBody(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) {
    throw new FetchError('fetch_too_large', '响应超过 8 MiB', 413);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new FetchError('fetch_too_large', '响应超过 8 MiB', 413);
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

function contentTypeOf(response) {
  return String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

function looksLikePdf(buffer) {
  return buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-';
}

function isOfficeType(mime, url) {
  return /wordprocessingml|spreadsheetml|officedocument/.test(mime)
    || /\.(docx|xlsx)(?:$|[?#])/i.test(url);
}

/**
 * 抓取链接并保存为当前对话附件。返回给 Agent 的预览。
 */
async function fetchUrlAsAttachment(db, { url, userId, threadId, maxChars = 6000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new FetchError('fetch_timeout', '抓取超时', 504)), TIMEOUT_MS);
  try {
    const { response, finalUrl } = await fetchWithRedirects(url, controller.signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new FetchError('fetch_http_error', `上游返回 ${response.status}`, response.status >= 500 ? 502 : 400);
    }
    const buffer = await readBody(response);
    const contentType = contentTypeOf(response);
    const warnings = [];
    let kind = 'url';
    let mime = contentType || 'text/plain';
    let text = '';
    let truncated = false;
    let title = '';
    let meta = { url, final_url: finalUrl.toString(), content_type: contentType };

    const imageMime = sniffImageMime(buffer);
    if (imageMime || contentType.startsWith('image/')) {
      throw new FetchError('fetch_unsupported_type', '图片链接请改用附件上传，以便视觉模型读取');
    }
    if (contentType === 'application/pdf' || looksLikePdf(buffer)) {
      const parsed = await extractDocumentText({ bytes: buffer, filename: `${finalUrl.pathname || 'link'}.pdf`, mime: 'application/pdf' });
      if (!parsed.ok) throw new FetchError('fetch_unsupported_type', parsed.error || 'PDF 解析失败');
      text = parsed.text;
      truncated = parsed.truncated;
      warnings.push(...(parsed.warnings || []));
      kind = 'document';
      mime = 'application/pdf';
      meta = { ...meta, ...(parsed.meta || {}) };
      title = finalUrl.pathname.split('/').pop() || '';
    } else if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
      const decoded = decodeText(buffer);
      if (decoded === null) throw new FetchError('fetch_unsupported_type', '网页编码无法识别');
      const parsed = htmlToText(decoded, { maxChars: MAX_EXTRACTED_CHARS });
      text = parsed.text;
      truncated = parsed.truncated;
      title = parsed.title;
      mime = 'text/html';
    } else if (isOfficeType(contentType, finalUrl.toString())) {
      const filename = finalUrl.pathname.split('/').pop() || 'document';
      const parsed = await extractDocumentText({ bytes: buffer, filename, mime: contentType });
      if (!parsed.ok) throw new FetchError('fetch_unsupported_type', parsed.error || '文档解析失败');
      text = parsed.text;
      truncated = parsed.truncated;
      warnings.push(...(parsed.warnings || []));
      kind = 'document';
      mime = parsed.mime || contentType;
      title = filename;
    } else if (contentType.startsWith('text/') || contentType === 'application/json'
        || contentType === 'application/xml' || contentType === 'application/x-yaml') {
      const decoded = decodeText(buffer);
      if (decoded === null) throw new FetchError('fetch_unsupported_type', '文本编码无法识别');
      text = decoded.slice(0, MAX_EXTRACTED_CHARS);
      truncated = decoded.length > MAX_EXTRACTED_CHARS;
    } else if (!contentType) {
      const decoded = decodeText(buffer);
      if (decoded === null) {
        const parsed = await extractDocumentText({
          bytes: buffer,
          filename: finalUrl.pathname.split('/').pop() || 'link',
          mime: ''
        });
        if (!parsed.ok) throw new FetchError('fetch_unsupported_type', parsed.error || '不支持的内容类型');
        text = parsed.text;
        truncated = parsed.truncated;
        warnings.push(...(parsed.warnings || []));
        kind = parsed.kind === 'image' ? 'url' : 'document';
        mime = parsed.mime;
      } else if (/<html[\s>]|<body[\s>]|<div[\s>]|<p[\s>]/i.test(decoded)) {
        const parsed = htmlToText(decoded, { maxChars: MAX_EXTRACTED_CHARS });
        text = parsed.text;
        truncated = parsed.truncated;
        title = parsed.title;
        mime = 'text/html';
      } else {
        text = decoded.slice(0, MAX_EXTRACTED_CHARS);
        truncated = decoded.length > MAX_EXTRACTED_CHARS;
      }
    } else {
      throw new FetchError('fetch_unsupported_type', `不支持的内容类型: ${contentType}`);
    }

    text = text || '';
    if (text.length < 20) warnings.push('empty_content');
    const stored = await storeAttachment(db, {
      userId,
      threadId,
      source: 'url',
      kind,
      filename: (title || finalUrl.hostname || 'link').slice(0, 200),
      mime,
      bytes: null,
      byteSize: buffer.length,
      extractedText: text,
      textChars: text.length,
      truncated,
      meta: { ...meta, title, warnings: [...new Set(warnings)] }
    });
    const preview = text.slice(0, Math.min(Math.max(Number(maxChars) || 6000, 1000), 24000));
    return {
      attachment_id: stored.attachment.id,
      final_url: finalUrl.toString(),
      title: title || finalUrl.hostname,
      mime,
      chars: text.length,
      truncated,
      preview,
      warnings: [...new Set(warnings)],
      trust: 'untrusted'
    };
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof FetchError) {
      throw controller.signal.reason;
    }
    if (error instanceof FetchError) throw error;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new FetchError('fetch_timeout', '抓取超时', 504);
    }
    throw new FetchError('fetch_failed', `抓取失败: ${error.message || '未知错误'}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  MAX_BYTES,
  MAX_REDIRECTS,
  TIMEOUT_MS,
  FetchError,
  fetchUrlAsAttachment,
  fetchWithRedirects,
  readBody
};
