'use strict';

const { validateUrl } = require('./url-validator');
const { pinnedFetchValidated } = require('../proxy-pool');

const PROVIDERS = new Set(['tavily', 'brave', 'serper']);
const MAX_RESULTS = 8;
const MAX_QUERY_CHARS = 400;
const MAX_SNIPPET_CHARS = 1200;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const RATE_LIMIT_PER_MINUTE = 12;

const DEFAULT_CONFIG = Object.freeze({
  search: Object.freeze({
    enabled: false,
    provider: 'tavily',
    apiKey: '',
    maxResults: 5,
    timeoutMs: DEFAULT_TIMEOUT_MS
  }),
  fetch: Object.freeze({
    enabled: true,
    maxBytes: 2 * 1024 * 1024,
    timeoutMs: 15000
  })
});

const rateBuckets = new Map();
const searchCache = new Map();
const SEARCH_CACHE_TTL_MS = 5 * 60_000;
const SEARCH_CACHE_MAX = 100;

class SearchError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

function normalizeAgentWebConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const search = source.search && typeof source.search === 'object' ? source.search : {};
  const fetchConfig = source.fetch && typeof source.fetch === 'object' ? source.fetch : {};
  return {
    search: {
      enabled: search.enabled === true,
      provider: PROVIDERS.has(String(search.provider || '').toLowerCase())
        ? String(search.provider).toLowerCase() : DEFAULT_CONFIG.search.provider,
      apiKey: typeof search.apiKey === 'string' ? search.apiKey.slice(0, 4096) : '',
      maxResults: clampNumber(search.maxResults, DEFAULT_CONFIG.search.maxResults, 1, MAX_RESULTS),
      timeoutMs: clampNumber(search.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 15000)
    },
    fetch: {
      enabled: fetchConfig.enabled !== false,
      maxBytes: clampNumber(fetchConfig.maxBytes, DEFAULT_CONFIG.fetch.maxBytes, 65536, 8 * 1024 * 1024),
      timeoutMs: clampNumber(fetchConfig.timeoutMs, DEFAULT_CONFIG.fetch.timeoutMs, 1000, 30000)
    }
  };
}

async function loadAgentWebConfig(db) {
  try {
    const result = await db.query("SELECT value FROM settings WHERE key = 'agent_web' LIMIT 1");
    let value = result.rows[0]?.value;
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (_) { value = {}; }
    }
    return normalizeAgentWebConfig(value);
  } catch (_) {
    return normalizeAgentWebConfig({});
  }
}

function maskAgentWebConfig(config) {
  return {
    ...config,
    search: {
      ...config.search,
      apiKey: config.search.apiKey ? '[configured]' : '',
      hasApiKey: Boolean(config.search.apiKey)
    }
  };
}

function mergeAgentWebConfig(current, patch) {
  const next = normalizeAgentWebConfig(current);
  const incoming = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  if (incoming.search && typeof incoming.search === 'object') {
    const search = incoming.search;
    if (typeof search.enabled === 'boolean') next.search.enabled = search.enabled;
    if (typeof search.provider === 'string') {
      const provider = search.provider.toLowerCase();
      if (!PROVIDERS.has(provider)) throw new SearchError('invalid_provider', '不支持的搜索服务');
      next.search.provider = provider;
    }
    if (typeof search.apiKey === 'string' && search.apiKey && search.apiKey !== '[configured]') {
      next.search.apiKey = search.apiKey;
    }
    if (search.maxResults !== undefined) {
      next.search.maxResults = clampNumber(search.maxResults, next.search.maxResults, 1, MAX_RESULTS);
    }
    if (search.timeoutMs !== undefined) {
      next.search.timeoutMs = clampNumber(search.timeoutMs, next.search.timeoutMs, 1000, 15000);
    }
    if (search.clearApiKey === true) next.search.apiKey = '';
  }
  if (incoming.fetch && typeof incoming.fetch === 'object') {
    const fetchConfig = incoming.fetch;
    if (typeof fetchConfig.enabled === 'boolean') next.fetch.enabled = fetchConfig.enabled;
    if (fetchConfig.maxBytes !== undefined) {
      next.fetch.maxBytes = clampNumber(fetchConfig.maxBytes, next.fetch.maxBytes, 65536, 8 * 1024 * 1024);
    }
    if (fetchConfig.timeoutMs !== undefined) {
      next.fetch.timeoutMs = clampNumber(fetchConfig.timeoutMs, next.fetch.timeoutMs, 1000, 30000);
    }
  }
  return next;
}

function checkRateLimit(userId) {
  const key = String(userId || 'anonymous');
  const now = Date.now();
  const bucket = (rateBuckets.get(key) || []).filter(timestamp => now - timestamp < 60_000);
  if (bucket.length >= RATE_LIMIT_PER_MINUTE) {
    rateBuckets.set(key, bucket);
    return false;
  }
  bucket.push(now);
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 1000) {
    for (const [id, entries] of rateBuckets) {
      if (!entries.some(timestamp => now - timestamp < 60_000)) rateBuckets.delete(id);
    }
  }
  return true;
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SearchError('web_search_too_large', '搜索响应过大', 502);
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock?.();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw new SearchError('web_search_invalid_response', '搜索服务返回了无效 JSON', 502); }
}

async function requestSearch(endpoint, { method = 'GET', headers = {}, body = null, timeoutMs }) {
  const check = await validateUrl(endpoint, { allowPrivate: false });
  if (!check.ok) throw new SearchError('web_search_blocked', check.error || '搜索服务地址未通过安全校验');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new SearchError('web_search_timeout', '搜索超时', 504)), timeoutMs);
  try {
    const response = await pinnedFetchValidated(check, {
      method,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'CrewRouter-Agent/1.0',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: 'manual'
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SearchError('web_search_failed', `搜索服务返回 ${response.status}`, response.status >= 500 ? 502 : 400);
    }
    return await readJson(response);
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof SearchError) throw controller.signal.reason;
    if (error instanceof SearchError) throw error;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new SearchError('web_search_timeout', '搜索超时', 504);
    }
    throw new SearchError('web_search_failed', `搜索失败: ${error.message || '未知错误'}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function searchTavily({ query, maxResults, timeoutMs, apiKey }) {
  const payload = await requestSearch('https://api.tavily.com/search', {
    method: 'POST',
    timeoutMs,
    body: { api_key: apiKey, query, max_results: maxResults, search_depth: 'basic', include_answer: false }
  });
  const results = Array.isArray(payload.results) ? payload.results : [];
  return results.map(item => ({
    title: String(item.title || '').slice(0, 300),
    url: String(item.url || '').slice(0, 2048),
    snippet: String(item.content || '').slice(0, MAX_SNIPPET_CHARS),
    published_at: item.published_date || null
  }));
}

async function searchBrave({ query, maxResults, timeoutMs, apiKey }) {
  const params = new URLSearchParams({ q: query, count: String(maxResults) });
  const payload = await requestSearch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
    timeoutMs,
    headers: { 'X-Subscription-Token': apiKey }
  });
  const results = Array.isArray(payload.web?.results) ? payload.web.results : [];
  return results.map(item => ({
    title: String(item.title || '').slice(0, 300),
    url: String(item.url || '').slice(0, 2048),
    snippet: String(item.description || '').slice(0, MAX_SNIPPET_CHARS),
    published_at: item.age || null
  }));
}

async function searchSerper({ query, maxResults, timeoutMs, apiKey }) {
  const payload = await requestSearch('https://google.serper.dev/search', {
    method: 'POST',
    timeoutMs,
    headers: { 'X-API-KEY': apiKey },
    body: { q: query, num: maxResults }
  });
  const results = Array.isArray(payload.organic) ? payload.organic : [];
  return results.map(item => ({
    title: String(item.title || '').slice(0, 300),
    url: String(item.link || '').slice(0, 2048),
    snippet: String(item.snippet || '').slice(0, MAX_SNIPPET_CHARS),
    published_at: item.date || null
  }));
}

const ADAPTERS = { tavily: searchTavily, brave: searchBrave, serper: searchSerper };

async function searchWeb(db, { query, maxResults, recencyDays, userId } = {}) {
  const config = await loadAgentWebConfig(db);
  if (!config.search.enabled || !config.search.apiKey) {
    return {
      error: 'web_search_not_configured',
      code: 'web_search_not_configured',
      message: '联网搜索未配置，管理员可在设置中填写搜索服务密钥；可改用链接抓取或上传资料。'
    };
  }
  const text = String(query || '').trim();
  if (!text || text.length > MAX_QUERY_CHARS) {
    return { error: '查询词必须为 1–400 字符', code: 'invalid_query' };
  }
  if (!checkRateLimit(userId)) {
    return { error: '搜索请求过于频繁，请稍后再试', code: 'web_search_rate_limited' };
  }
  const results = Math.min(
    Math.max(Number(maxResults) || config.search.maxResults, 1),
    MAX_RESULTS
  );
  const cacheKey = `${config.search.provider}|${results}|${text.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }
  const adapter = ADAPTERS[config.search.provider] || ADAPTERS.tavily;
  try {
    const items = await adapter({
      query: text,
      maxResults: results,
      timeoutMs: config.search.timeoutMs,
      apiKey: config.search.apiKey,
      recencyDays
    });
    const value = {
      provider: config.search.provider,
      query: text,
      results: items.slice(0, results),
      trust: 'untrusted'
    };
    searchCache.set(cacheKey, { at: Date.now(), value });
    while (searchCache.size > SEARCH_CACHE_MAX) {
      const oldest = searchCache.keys().next().value;
      searchCache.delete(oldest);
    }
    return value;
  } catch (error) {
    if (error instanceof SearchError) {
      return { error: error.message, code: error.code };
    }
    return { error: `搜索失败: ${error.message || '未知错误'}`, code: 'web_search_failed' };
  }
}

module.exports = {
  PROVIDERS,
  MAX_RESULTS,
  DEFAULT_CONFIG,
  normalizeAgentWebConfig,
  loadAgentWebConfig,
  maskAgentWebConfig,
  mergeAgentWebConfig,
  searchWeb,
  checkRateLimit
};
