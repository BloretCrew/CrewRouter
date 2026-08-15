const Logger = require('./logger');

const MODELS_DEV_URL = 'https://models.dev/api.json';
let providersCache = null;
let cacheTime = 0;
const CACHE_TTL = 3600000; // 1小时

// 缓存统计
const cacheStats = {
  hits: 0,
  misses: 0,
  lastHitTime: null,
  lastMissTime: null,
  totalRequests: 0
};

function getCacheStatus() {
  const now = Date.now();
  const isValid = providersCache && (now - cacheTime) < CACHE_TTL;
  const remainingTTL = isValid ? Math.max(0, CACHE_TTL - (now - cacheTime)) : 0;
  
  return {
    isValid,
    remainingTTL,
    lastFetchTime: cacheTime ? new Date(cacheTime).toISOString() : null,
    providerCount: providersCache ? Object.keys(providersCache).length : 0,
    stats: {
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      hitRate: cacheStats.totalRequests > 0 
        ? ((cacheStats.hits / cacheStats.totalRequests) * 100).toFixed(2) + '%'
        : '0%',
      totalRequests: cacheStats.totalRequests,
      lastHitTime: cacheStats.lastHitTime ? new Date(cacheStats.lastHitTime).toISOString() : null,
      lastMissTime: cacheStats.lastMissTime ? new Date(cacheStats.lastMissTime).toISOString() : null
    }
  };
}

function resetCacheStats() {
  cacheStats.hits = 0;
  cacheStats.misses = 0;
  cacheStats.lastHitTime = null;
  cacheStats.lastMissTime = null;
  cacheStats.totalRequests = 0;
}

async function fetchProvidersIndex() {
  const now = Date.now();
  cacheStats.totalRequests++;
  
  if (providersCache && (now - cacheTime) < CACHE_TTL) {
    cacheStats.hits++;
    cacheStats.lastHitTime = now;
    return providersCache;
  }

  cacheStats.misses++;
  cacheStats.lastMissTime = now;

  try {
    const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    providersCache = data;
    cacheTime = now;
    Logger.info(`[ProviderLookup] 从 models.dev 加载了 ${Object.keys(data).length} 个供应商`);
    return data;
  } catch (error) {
    Logger.warn(`[ProviderLookup] 获取 models.dev 数据失败: ${error.message}`);
    return providersCache || {};
  }
}

function inferFormat(npm, providerId) {
  if (!npm) {
    if (providerId.includes('anthropic')) return 'anthropic';
    return 'openai';
  }
  if (npm.includes('anthropic')) return 'anthropic';
  return 'openai';
}

async function lookupProvider(providerId) {
  const index = await fetchProvidersIndex();
  const entry = index[providerId];
  if (!entry) return null;

  return {
    id: entry.id,
    name: entry.name,
    base_url: entry.api || '',
    format: inferFormat(entry.npm, entry.id),
    npm: entry.npm,
    env: entry.env || [],
    doc: entry.doc || ''
  };
}

async function searchProviders(keyword) {
  const index = await fetchProvidersIndex();
  const results = [];
  const kw = keyword.toLowerCase();

  for (const [id, entry] of Object.entries(index)) {
    if (id.includes(kw) || entry.name.toLowerCase().includes(kw)) {
      results.push({
        id: entry.id,
        name: entry.name,
        base_url: entry.api || '',
        format: inferFormat(entry.npm, entry.id),
        npm: entry.npm
      });
    }
  }

  return results.slice(0, 20);
}

module.exports = { lookupProvider, searchProviders, fetchProvidersIndex, getCacheStatus, resetCacheStats };
