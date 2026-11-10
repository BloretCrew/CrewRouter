'use strict';

const protocolBridge = require('../protocol/bridge');
const { createSSEParser } = require('../protocol/sse');
const { cleanBaseUrl, upstreamUrl, validateUrl } = require('../utils/url-validator');
const { buildAuthHeaders } = require('../utils/request-policy');
const { parseDataUri, mediaTypeFromMime } = require('../protocol/gemini-schema');

const MEDIA_LIMIT_BYTES = 25 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 20000;

function encodeModelPath(model) {
  return String(model || '').split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function appendQuery(url, params) {
  let parsed;
  try { parsed = new URL(url); } catch { return url; }
  for (const [key, value] of Object.entries(params)) parsed.searchParams.set(key, value);
  return parsed.toString();
}

function buildUpstreamEndpoint(provider, model, options = {}) {
  const format = String(provider?.format || 'openai');
  const base = cleanBaseUrl(provider?.base_url || '');
  const stream = !!options.stream;
  if (format === 'gemini') {
    const action = options.action || (stream ? 'streamGenerateContent' : 'generateContent');
    let url = upstreamUrl(base, `/models/${encodeModelPath(model)}:${action}`, '/v1beta');
    if (stream) url = appendQuery(url, { alt: 'sse' });
    return { url, format };
  }
  if (format === 'anthropic') return { url: upstreamUrl(base, '/messages'), format };
  if (format === 'responses') return { url: upstreamUrl(base, '/responses'), format };
  return { url: upstreamUrl(base, '/chat/completions'), format };
}

function providerAuthHeaders(provider) {
  return buildAuthHeaders(provider?.format || 'openai', provider?.api_key);
}

function buildUpstreamPayload(provider, ir, options = {}) {
  const format = String(provider?.format || 'openai');
  const body = protocolBridge.encodeRequest(format, ir, {
    quirks: protocolBridge.getDialectCapability?.(format)?.quirks
  });
  if (options.stream) {
    if (format === 'openai') {
      body.stream = true;
      body.stream_options = { ...(body.stream_options || {}), include_usage: true };
    } else if (format === 'anthropic' || format === 'responses') {
      body.stream = true;
    }
    // Gemini encodeRequest deliberately does not put `stream` in the body;
    // the endpoint action and ?alt=sse carry it.
  } else if (format === 'openai') {
    delete body.stream;
  }
  return body;
}

function decodeUpstreamResponse(format, body) {
  return protocolBridge.decodeResponse(format, body || {});
}

function parseFrame(format, frame) {
  if (!frame || !frame.data) return null;
  if (frame.done) return { done: true, event: null };
  let parsed;
  try {
    parsed = JSON.parse(frame.data);
  } catch (error) {
    const wrapped = new Error(`Invalid JSON in ${format} SSE frame: ${error.message}`);
    wrapped.code = 'invalid_upstream_stream';
    throw wrapped;
  }
  if (parsed && typeof parsed === 'object' && parsed.error) {
    const error = new Error(parsed.error.message || 'Upstream stream error');
    error.code = parsed.error.code || parsed.error.status || 'upstream_stream_error';
    error.status = Number(parsed.error.code) || 502;
    throw error;
  }
  return { done: false, event: protocolBridge.decodeStreamEvent(format, parsed) };
}

async function* readUpstreamEvents(response, format, options = {}) {
  const body = response?.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSSEParser();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (options.signal?.aborted) break;
      const frames = parser.push(decoder.decode(value, { stream: true }));
      for (const frame of frames) {
        const parsed = parseFrame(format, frame);
        if (!parsed) continue;
        if (parsed.done) return;
        if (parsed.event) yield parsed.event;
      }
    }
    for (const frame of parser.end()) {
      const parsed = parseFrame(format, frame);
      if (!parsed || parsed.done) continue;
      if (parsed.event) yield parsed.event;
    }
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

function imageSourceToUri(source) {
  if (!source) return '';
  if (typeof source === 'string') return source;
  if (source.url) return source.url;
  if (source.data && source.media_type) return `data:${source.media_type};base64,${source.data}`;
  if (source.type === 'base64' && source.data) return `data:${source.media_type || 'image/png'};base64,${source.data}`;
  return '';
}

async function fetchMediaAsData(uri, options = {}) {
  const urlCheck = await validateUrl(uri, { allowPrivate: options.allowPrivate === true });
  if (!urlCheck.ok) {
    const error = new Error(`Media URL rejected: ${urlCheck.error}`);
    error.code = 'unsupported_media_source';
    throw error;
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const target = urlCheck.url ? urlCheck.url.toString() : uri;
  const response = await fetchImpl(target, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS)
  });
  if (!response.ok) {
    const error = new Error(`Media URL returned HTTP ${response.status}`);
    error.code = 'unsupported_media_source';
    throw error;
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MEDIA_LIMIT_BYTES) {
    const error = new Error(`Media exceeds ${MEDIA_LIMIT_BYTES} byte limit`);
    error.code = 'media_too_large';
    throw error;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MEDIA_LIMIT_BYTES) {
    const error = new Error(`Media exceeds ${MEDIA_LIMIT_BYTES} byte limit`);
    error.code = 'media_too_large';
    throw error;
  }
  const mimeType = (response.headers.get('content-type') || '').split(';')[0] || 'application/octet-stream';
  return { mimeType, data: bytes.toString('base64') };
}

function blockToMedia(block) {
  if (block.type === 'image') {
    const source = block.source;
    if (!source) return null;
    if (typeof source === 'string') return { type: 'media', mediaType: 'image', mimeType: 'image/png', uri: source, passthrough: block.passthrough };
    if (source.url) return { type: 'media', mediaType: 'image', mimeType: 'image/png', uri: source.url, passthrough: block.passthrough };
    if (source.type === 'base64') return { type: 'media', mediaType: 'image', mimeType: source.media_type || 'image/png', data: source.data || '', passthrough: block.passthrough };
    if (source.data) return { type: 'media', mediaType: 'image', mimeType: source.media_type || source.mimeType || 'image/png', data: source.data, passthrough: block.passthrough };
    return null;
  }
  return block;
}

/**
 * Resolve remote media to inline base64 before encoding. Gemini cannot fetch
 * arbitrary HTTP URLs; OpenAI/Anthropic also benefit from stable data URIs.
 * Gemini's Files API URIs (`fileUri`) are only valid for a Gemini target.
 */
async function materializeMedia(ir, provider, options = {}) {
  const targetFormat = String(provider?.format || 'openai');
  for (const message of ir?.messages || []) {
    const blocks = message.blocks || [];
    for (let index = 0; index < blocks.length; index += 1) {
      let block = blocks[index];
      if (block?.type === 'image') {
        const media = blockToMedia(block);
        if (!media) continue;
        block = media;
        blocks[index] = block;
      }
      if (block?.type !== 'media') continue;
      if (block.data) continue;
      if (block.fileUri) {
        if (targetFormat !== 'gemini') {
          const error = new Error('Gemini fileData/fileUri media can only be sent to a Gemini upstream');
          error.code = 'unsupported_media_source';
          throw error;
        }
        continue;
      }
      const uri = block.uri || block.url;
      if (!uri) continue;
      const dataUri = parseDataUri(uri);
      if (dataUri) {
        blocks[index] = {
          ...block,
          mimeType: dataUri.mimeType,
          mediaType: mediaTypeFromMime(dataUri.mimeType),
          data: dataUri.data,
          uri: undefined
        };
        continue;
      }
      if (!/^https?:\/\//i.test(uri)) {
        const error = new Error(`Unsupported media URI scheme: ${String(uri).slice(0, 40)}`);
        error.code = 'unsupported_media_source';
        throw error;
      }
      const fetched = await fetchMediaAsData(uri, options);
      blocks[index] = {
        ...block,
        mimeType: fetched.mimeType,
        mediaType: mediaTypeFromMime(fetched.mimeType),
        data: fetched.data,
        uri: undefined
      };
    }
  }
  return ir;
}

function usageFromIrResponse(ir) {
  const usage = ir?.usage || {};
  return {
    promptTokens: Number(usage.inputTokens || 0),
    completionTokens: Number(usage.outputTokens || 0),
    cachedTokens: Number(usage.cachedInputTokens || 0),
    reasoningTokens: Number(usage.reasoningTokens || 0)
  };
}

module.exports = {
  MEDIA_LIMIT_BYTES,
  encodeModelPath,
  buildUpstreamEndpoint,
  providerAuthHeaders,
  buildUpstreamPayload,
  decodeUpstreamResponse,
  readUpstreamEvents,
  materializeMedia,
  usageFromIrResponse
};
