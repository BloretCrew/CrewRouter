'use strict';

/**
 * Per-request latency / throughput metrics for gateway calls.
 *
 * Timing starts when the request reaches the server (before body parsing when
 * the caller provides `req._requestStartedAt`). One request may make several
 * upstream attempts (model queue fallback, key fallback); only the last
 * successful attempt is used for the usage record.
 */

const MAX_RATE_LIMIT_HEADERS = 40;
const MAX_HEADER_VALUE = 128;
const MAX_FORWARDED_VALUE = 1024;
const MAX_PROCESSING_MS = 24 * 60 * 60 * 1000;

const RATE_LIMIT_PREFIXES = ['x-ratelimit-', 'anthropic-ratelimit-', 'anthropic-fast-'];
const FORWARDED_HEADERS = new Set(['openai-processing-ms']);

const METRIC_COLUMNS = [
  'is_stream',
  'ttft_ms',
  'upstream_first_byte_ms',
  'generation_ms',
  'tpot_ms',
  'output_tps',
  'e2e_ms',
  'upstream_processing_ms',
  'service_tier',
  'rate_limit',
];

const USAGE_METRIC_COLUMNS = METRIC_COLUMNS.join(', ');

function now() {
  return Date.now();
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundInt(value) {
  if (value == null) return null;
  const n = Math.round(value);
  return Number.isFinite(n) ? n : null;
}

function round3(value) {
  if (value == null) return null;
  return Math.round(value * 1000) / 1000;
}

function sanitizeHeaderValue(value, maxLength = MAX_HEADER_VALUE) {
  if (value == null) return null;
  const text = String(value).replace(/[\r\n\0]/g, ' ').trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeHeaders(headers) {
  const result = new Map();
  if (!headers) return result;
  if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
    headers.forEach((value, key) => {
      const name = String(key || '').toLowerCase();
      if (name) result.set(name, String(value));
    });
    return result;
  }
  if (typeof headers.entries === 'function') {
    for (const [key, value] of headers.entries()) {
      const name = String(key || '').toLowerCase();
      if (name) result.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    }
    return result;
  }
  for (const [key, value] of Object.entries(headers)) {
    const name = String(key || '').toLowerCase();
    if (!name) continue;
    result.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return result;
}

function parseIntegerHeader(value, min, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const n = Math.round(Number(text));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function parseRateLimitHeaders(headers) {
  const map = normalizeHeaders(headers);
  const values = {};
  let openai = false;
  let anthropic = false;
  let fast = false;

  for (const [name, rawValue] of map) {
    const matched = RATE_LIMIT_PREFIXES.some(prefix => name.startsWith(prefix));
    if (!matched) continue;
    if (Object.keys(values).length >= MAX_RATE_LIMIT_HEADERS) break;
    const value = sanitizeHeaderValue(rawValue);
    if (!value) continue;
    values[name] = value;
    if (name.startsWith('x-ratelimit-')) openai = true;
    if (name.startsWith('anthropic-ratelimit-')) anthropic = true;
    if (name.startsWith('anthropic-fast-')) fast = true;
  }

  const processingMs = parseIntegerHeader(map.get('openai-processing-ms'), 0, MAX_PROCESSING_MS);
  const retryAfter = sanitizeHeaderValue(map.get('retry-after'));
  const requestId = sanitizeHeaderValue(map.get('x-request-id') || map.get('anthropic-request-id') || map.get('request-id'));

  if (!Object.keys(values).length && processingMs == null && !retryAfter) return null;

  let vendor = 'unknown';
  if ((openai || fast) && anthropic) vendor = 'mixed';
  else if (openai || fast) vendor = 'openai';
  else if (anthropic) vendor = 'anthropic';

  return {
    vendor,
    headers: values,
    retry_after: retryAfter,
    processing_ms: processingMs,
    request_id: requestId,
  };
}

function normalizeServiceTier(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(text)) return null;
  return text;
}

function isObservableHeader(name) {
  return FORWARDED_HEADERS.has(name) || RATE_LIMIT_PREFIXES.some(prefix => name.startsWith(prefix));
}

function forwardUpstreamHeaders(res, headers) {
  if (!res || res.headersSent) return;
  const map = normalizeHeaders(headers);
  let forwarded = 0;
  for (const [name, rawValue] of map) {
    if (forwarded >= MAX_RATE_LIMIT_HEADERS) break;
    if (!isObservableHeader(name)) continue;
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    const value = sanitizeHeaderValue(rawValue, MAX_FORWARDED_VALUE);
    if (!value) continue;
    res.setHeader(name, value);
    forwarded++;
  }
}

class AttemptMetrics {
  constructor(owner, options = {}) {
    this.owner = owner;
    this.stream = !!options.stream;
    this.model = options.model || null;
    this.providerId = options.providerId || null;
    this.format = options.format || null;
    this.startedAt = now();
    this.headersAt = null;
    this.firstByteAt = null;
    this.firstTokenAt = null;
    this.lastTokenAt = null;
    this.tokenKinds = new Set();
    this.rateLimit = null;
    this.processingMs = null;
    this.requestId = null;
    this.serviceTier = normalizeServiceTier(options.serviceTier);
    this.snapshot = null;
  }

  captureHeaders(headers) {
    if (this.headersAt == null) this.headersAt = now();
    const parsed = parseRateLimitHeaders(headers);
    if (!parsed) return;
    this.rateLimit = parsed;
    this.processingMs = parsed.processing_ms;
    this.requestId = parsed.request_id || this.requestId;
  }

  markFirstByte() {
    if (this.firstByteAt == null) this.firstByteAt = now();
  }

  markToken(kind = 'content') {
    this.markFirstByte();
    const at = now();
    if (this.firstTokenAt == null) this.firstTokenAt = at;
    this.lastTokenAt = at;
    if (kind) this.tokenKinds.add(kind);
  }

  setServiceTier(value) {
    const tier = normalizeServiceTier(value);
    if (tier) this.serviceTier = tier;
  }

  finish({ promptTokens = null, completionTokens = null, completed = true } = {}) {
    if (this.snapshot) return this.snapshot;

    const endedAt = now();
    const prompt = toFiniteNumber(promptTokens);
    const completion = toFiniteNumber(completionTokens);
    const firstByteAt = this.firstByteAt != null ? this.firstByteAt : this.headersAt;

    const ttftMs = this.firstTokenAt != null ? Math.max(0, this.firstTokenAt - this.owner.startedAt) : null;
    const generationMs = this.firstTokenAt != null && this.lastTokenAt != null
      ? Math.max(0, this.lastTokenAt - this.firstTokenAt)
      : null;

    let tpotMs = null;
    if (generationMs != null && completion != null && completion > 1) {
      tpotMs = generationMs / (completion - 1);
    }

    let outputTps = null;
    if (generationMs != null && generationMs > 0 && completion != null && completion > 0) {
      outputTps = completion / (generationMs / 1000);
    }

    this.snapshot = {
      isStream: this.stream,
      ttftMs: roundInt(ttftMs),
      upstreamFirstByteMs: firstByteAt != null ? roundInt(firstByteAt - this.startedAt) : null,
      generationMs: roundInt(generationMs),
      tpotMs: round3(tpotMs),
      outputTps: round3(outputTps),
      e2eMs: roundInt(Math.max(0, endedAt - this.owner.startedAt)),
      upstreamProcessingMs: this.processingMs,
      serviceTier: this.serviceTier,
      rateLimit: this.rateLimit,
      promptTokens: prompt,
      completionTokens: completion,
      completed: completed !== false,
      model: this.model,
      providerId: this.providerId,
      format: this.format,
      tokenKinds: Array.from(this.tokenKinds),
    };
    this.owner.lastSnapshot = this.snapshot;
    return this.snapshot;
  }
}

class RequestMetrics {
  constructor(req) {
    this.req = req;
    const provided = Number(req && req._requestStartedAt);
    this.startedAt = Number.isFinite(provided) && provided > 0 ? provided : now();
    this.current = null;
    this.lastSnapshot = null;
  }

  beginAttempt(options = {}) {
    const attempt = new AttemptMetrics(this, options);
    this.current = attempt;
    this.lastSnapshot = null;
    if (this.req && this.req._upstreamAttemptContext) {
      this.req._upstreamAttemptContext.metrics = attempt;
    }
    return attempt;
  }

  fallbackSnapshot({ stream = false, completionTokens = null, promptTokens = null, serviceTier = null } = {}) {
    const attempt = new AttemptMetrics(this, { stream, serviceTier });
    const snapshot = attempt.finish({ promptTokens, completionTokens, completed: true });
    return snapshot;
  }
}

function getRequestMetrics(req) {
  if (!req) return new RequestMetrics(null);
  if (req._requestMetrics instanceof RequestMetrics) return req._requestMetrics;
  const metrics = new RequestMetrics(req);
  req._requestMetrics = metrics;
  return metrics;
}

function getActiveAttempt(req) {
  return getRequestMetrics(req).current;
}

function markActiveToken(req, kind = 'content') {
  const attempt = getActiveAttempt(req);
  if (attempt) attempt.markToken(kind);
}

function markActiveFirstByte(req) {
  const attempt = getActiveAttempt(req);
  if (attempt) attempt.markFirstByte();
}

function usageMetricPlaceholders(baseIndex) {
  const start = Number.isInteger(baseIndex) && baseIndex > 0 ? baseIndex : 1;
  return METRIC_COLUMNS.map((_, index) => `$${start + index}`).join(', ');
}

function usageMetricValues(snapshot) {
  const s = snapshot || {};
  return [
    typeof s.isStream === 'boolean' ? s.isStream : null,
    roundInt(s.ttftMs),
    roundInt(s.upstreamFirstByteMs),
    roundInt(s.generationMs),
    round3(s.tpotMs),
    round3(s.outputTps),
    roundInt(s.e2eMs),
    roundInt(s.upstreamProcessingMs),
    normalizeServiceTier(s.serviceTier),
    s.rateLimit || null,
  ];
}

module.exports = {
  METRIC_COLUMNS,
  USAGE_METRIC_COLUMNS,
  RequestMetrics,
  AttemptMetrics,
  getRequestMetrics,
  getActiveAttempt,
  markActiveFirstByte,
  markActiveToken,
  normalizeServiceTier,
  parseRateLimitHeaders,
  usageMetricPlaceholders,
  usageMetricValues,
  forwardUpstreamHeaders,
};
