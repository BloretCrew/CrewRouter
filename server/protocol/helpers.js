'use strict';

function omitKnown(value, known) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!known.has(key)) result[key] = item;
  }
  return result;
}

function withPassthrough(base, passthrough) {
  return { ...(passthrough || {}), ...base };
}

function safeParseJson(value, fallback = {}) {
  if (typeof value !== 'string') return value == null ? fallback : value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map(block => {
    if (typeof block === 'string') return block;
    return block?.text || '';
  }).join('\n');
}

const DEFAULT_IMAGE_MIME = 'image/png';

/** 解析 base64 data URI；非 base64 或非法输入返回 null。 */
function parseDataUri(value) {
  if (typeof value !== 'string') return null;
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/is.exec(value);
  if (!match) return null;
  return { mimeType: match[1] || 'application/octet-stream', data: match[2] };
}

function toDataUri(mimeType, data) {
  return `data:${mimeType || 'application/octet-stream'};base64,${data || ''}`;
}

function withDetail(canonical, detail) {
  if (!canonical || detail === undefined) return canonical;
  return { ...canonical, detail };
}

/**
 * 把各协议里的图片 source 归一化为 canonical 形状：
 *   { kind:'data', mimeType, data, dataUri }
 *   { kind:'url', url, mimeType?, detail? }
 *   { kind:'file', fileId, detail? }
 * 无法识别（含无法解析的 data:）返回 null。
 */
function normalizeImageSource(source) {
  if (typeof source === 'string') {
    if (/^data:/i.test(source)) {
      const parsed = parseDataUri(source);
      if (!parsed) return null;
      return {
        kind: 'data',
        mimeType: parsed.mimeType,
        data: parsed.data,
        dataUri: toDataUri(parsed.mimeType, parsed.data)
      };
    }
    return { kind: 'url', url: source };
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;

  const detail = source.detail;
  if (source.image_url !== undefined) {
    return withDetail(normalizeImageSource(source.image_url), detail);
  }
  if (source.image !== undefined) {
    return withDetail(normalizeImageSource(source.image), detail);
  }
  if (source.inlineData) {
    const mimeType = source.inlineData.mimeType || DEFAULT_IMAGE_MIME;
    const data = source.inlineData.data || '';
    if (!data) return null;
    return { kind: 'data', mimeType, data, dataUri: toDataUri(mimeType, data) };
  }
  if (source.fileData) {
    const url = source.fileData.fileUri;
    if (!url) return null;
    return withDetail({ kind: 'url', url, mimeType: source.fileData.mimeType }, detail);
  }
  if (source.type === 'base64') {
    const data = typeof source.data === 'string' ? source.data : '';
    if (!data) return null;
    const mimeType = source.media_type || source.mime_type || source.mimeType || DEFAULT_IMAGE_MIME;
    return withDetail({ kind: 'data', mimeType, data, dataUri: toDataUri(mimeType, data) }, detail);
  }
  if (source.type === 'url') {
    if (!source.url) return null;
    return withDetail(normalizeImageSource(source.url), detail);
  }
  if (source.type === 'file') {
    const fileId = source.file_id || source.fileId;
    return fileId ? withDetail({ kind: 'file', fileId }, detail) : null;
  }
  if (typeof source.url === 'string' && source.url) {
    return withDetail(normalizeImageSource(source.url), detail);
  }
  if (typeof source.data === 'string' && source.data) {
    const mimeType = source.media_type || source.mimeType || source.mime_type || DEFAULT_IMAGE_MIME;
    return withDetail({ kind: 'data', mimeType, data: source.data, dataUri: toDataUri(mimeType, source.data) }, detail);
  }
  const fileId = source.file_id || source.fileId;
  return fileId ? withDetail({ kind: 'file', fileId }, detail) : null;
}

function detailField(canonical) {
  return canonical.detail === undefined ? {} : { detail: canonical.detail };
}

/** 输出 OpenAI Chat Completions 的 image_url 值（字符串或 {url, detail}）。 */
function imageSourceToOpenAI(source) {
  if (typeof source === 'string') {
    if (/^data:/i.test(source)) {
      const parsed = parseDataUri(source);
      return parsed ? { url: toDataUri(parsed.mimeType, parsed.data) } : null;
    }
    return source ? { url: source } : null;
  }
  if (source && typeof source === 'object'
    && typeof source.url === 'string'
    && source.type === undefined
    && source.image_url === undefined
    && source.inlineData === undefined
    && source.fileData === undefined) {
    return source;
  }
  const canonical = normalizeImageSource(source);
  if (!canonical) return null;
  if (canonical.kind === 'data') return { url: canonical.dataUri, ...detailField(canonical) };
  if (canonical.kind === 'url') return { url: canonical.url, ...detailField(canonical) };
  return null; // Chat Completions 的 image_url 没有 file_id 等价物
}

/** 输出 Anthropic Messages 的 image.source。 */
function imageSourceToAnthropic(source) {
  if (source && typeof source === 'object') {
    if (source.type === 'base64' && source.data) {
      return { ...source, media_type: source.media_type || source.mime_type || DEFAULT_IMAGE_MIME };
    }
    if (source.type === 'url' && source.url) return source;
    if (source.type === 'file' && (source.file_id || source.fileId)) return source;
  }
  const canonical = normalizeImageSource(source);
  if (!canonical) return null;
  if (canonical.kind === 'data') {
    return { type: 'base64', media_type: canonical.mimeType || DEFAULT_IMAGE_MIME, data: canonical.data };
  }
  if (canonical.kind === 'url') return { type: 'url', url: canonical.url };
  return { type: 'file', file_id: canonical.fileId };
}

/** 输出 OpenAI Responses 的 input_image part。 */
function imageSourceToResponses(source) {
  if (typeof source === 'string') {
    return source ? { type: 'input_image', image_url: source } : null;
  }
  if (source && typeof source === 'object' && (source.type === 'input_image' || source.type === 'image')) {
    if (source.image_url !== undefined || source.file_id !== undefined) {
      return { ...source, type: 'input_image' };
    }
  }
  const canonical = normalizeImageSource(source);
  if (!canonical) return null;
  if (canonical.kind === 'file') {
    return { type: 'input_image', file_id: canonical.fileId, ...detailField(canonical) };
  }
  if (canonical.kind === 'data') {
    return { type: 'input_image', image_url: canonical.dataUri, ...detailField(canonical) };
  }
  return { type: 'input_image', image_url: canonical.url, ...detailField(canonical) };
}

/** 输出 Gemini 的媒体表示（fileUri 或 inlineData）。 */
function imageSourceToGemini(source) {
  const canonical = normalizeImageSource(source);
  if (!canonical) return null;
  if (canonical.kind === 'data') {
    return {
      type: 'media',
      mediaType: 'image',
      mimeType: canonical.mimeType || DEFAULT_IMAGE_MIME,
      data: canonical.data
    };
  }
  if (canonical.kind === 'url') {
    return {
      type: 'media',
      mediaType: 'image',
      mimeType: canonical.mimeType || DEFAULT_IMAGE_MIME,
      fileUri: canonical.url
    };
  }
  return null; // Gemini 没有 OpenAI/Anthropic file_id 的等价物
}

function isMediaBlock(block) {
  return !!block && (block.type === 'image' || block.type === 'media');
}

/** 把内容块拆成文本块与媒体块；tool_result 等目标通道不支持媒体时使用。 */
function splitMediaBlocks(blocks) {
  const text = [];
  const media = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (isMediaBlock(block)) media.push(block);
    else text.push(block);
  }
  return { text, media };
}

function base64Bytes(data) {
  return Math.floor(String(data || '').length * 3 / 4);
}

/** 目标协议无法表达媒体时的文本占位符，避免静默丢内容。 */
function mediaPlaceholder(block) {
  if (!block || typeof block !== 'object') return '[media omitted]';
  if (block.type === 'image') {
    const canonical = normalizeImageSource(block.source);
    if (canonical?.kind === 'data') {
      return `[media omitted: ${canonical.mimeType}, ${base64Bytes(canonical.data)} bytes]`;
    }
    if (canonical?.kind === 'url') return `[media omitted: ${canonical.url}]`;
    if (canonical?.kind === 'file') return `[media omitted: file ${canonical.fileId}]`;
    return '[media omitted]';
  }
  const mime = block.mimeType || 'application/octet-stream';
  const bytes = block.data ? `, ${base64Bytes(block.data)} bytes` : '';
  const name = block.filename ? `, ${block.filename}` : '';
  return `[media omitted: ${mime}${bytes}${name}]`;
}

function placeholderBlock(block) {
  return { type: 'text', text: mediaPlaceholder(block) };
}

module.exports = {
  omitKnown,
  withPassthrough,
  safeParseJson,
  contentToText,
  DEFAULT_IMAGE_MIME,
  parseDataUri,
  toDataUri,
  normalizeImageSource,
  imageSourceToOpenAI,
  imageSourceToAnthropic,
  imageSourceToResponses,
  imageSourceToGemini,
  isMediaBlock,
  splitMediaBlocks,
  mediaPlaceholder,
  placeholderBlock
};
