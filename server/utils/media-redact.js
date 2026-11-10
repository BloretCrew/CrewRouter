'use strict';

const crypto = require('node:crypto');

const REDACTED_PREFIX = '[media redacted:';
const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'document', 'file', 'input_image', 'input_file', 'image_url']);

function isDataUri(value) {
  return typeof value === 'string' && /^data:/i.test(value);
}

function isRedacted(value) {
  return typeof value === 'string' && value.startsWith(REDACTED_PREFIX);
}

function parseDataUri(value) {
  if (typeof value !== 'string') return null;
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is.exec(value);
  if (!match) return null;
  return { mimeType: match[1] || 'application/octet-stream', data: match[2] };
}

function base64Bytes(data) {
  const clean = String(data || '').replace(/\s+/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : (clean.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
}

function redactValue(value, mimeType, force = false) {
  if (typeof value !== 'string' || !value) return value;
  if (isRedacted(value)) return value;
  const parsed = parseDataUri(value);
  if (!parsed && !force) return value;
  const raw = parsed ? parsed.data : value;
  if (!raw) return value;
  const mime = parsed?.mimeType || mimeType || 'application/octet-stream';
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `[media redacted: ${mime}, ${base64Bytes(raw)} bytes, sha256:${hash}]`;
}

function redactObject(value, context = {}) {
  const mediaObject = context.media === true
    || MEDIA_TYPES.has(value.type)
    || value.inlineData !== undefined
    || value.fileData !== undefined
    || value.input_audio !== undefined;
  const result = {};

  for (const [key, item] of Object.entries(value)) {
    if (key === 'data' && mediaObject) {
      result[key] = redactValue(item, value.mimeType || value.media_type || value.mime_type, true);
      continue;
    }
    if (key === 'image_url') {
      if (typeof item === 'string') result[key] = redactValue(item);
      else if (item && typeof item === 'object' && typeof item.url === 'string') {
        result[key] = { ...item, url: redactValue(item.url) };
      } else result[key] = item;
      continue;
    }
    if (key === 'file_data') {
      result[key] = redactValue(item, undefined, true);
      continue;
    }
    if ((key === 'inlineData' || key === 'fileData') && item && typeof item === 'object') {
      result[key] = typeof item.data === 'string'
        ? { ...item, data: redactValue(item.data, item.mimeType, true) }
        : item;
      continue;
    }
    if (key === 'input_audio' && item && typeof item === 'object') {
      result[key] = typeof item.data === 'string'
        ? { ...item, data: redactValue(item.data, undefined, true) }
        : item;
      continue;
    }
    if (key === 'source' && item && typeof item === 'object') {
      result[key] = typeof item.data === 'string'
        ? { ...item, data: redactValue(item.data, item.media_type, true) }
        : item;
      continue;
    }
    if (key === 'file' && item && typeof item === 'object') {
      result[key] = redactObject(item, { media: true });
      continue;
    }
    result[key] = redactMediaForStorage(item, { media: mediaObject });
  }
  return result;
}

/**
 * 把请求/响应中的 base64 媒体替换为“mime + 大小 + sha256 前缀”占位符。
 * 用于 usage_records 等日志存储，避免数十 MB base64 入库。
 * 纯函数，可重复调用（幂等）。
 */
function redactMediaForStorage(value, context = {}) {
  if (typeof value === 'string') {
    return isDataUri(value) ? redactValue(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactMediaForStorage(item, context));
  }
  if (!value || typeof value !== 'object') return value;
  return redactObject(value, context);
}

function stringifyMediaForStorage(value) {
  return JSON.stringify(redactMediaForStorage(value));
}

module.exports = {
  REDACTED_PREFIX,
  redactMediaForStorage,
  stringifyMediaForStorage,
  redactValue
};
