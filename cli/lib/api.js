'use strict';

const { ApiError } = require('./client');

const FALLBACK_STATUS = new Set([401, 403, 404, 405, 501]);

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function getVersion(client) { return client.get('/api/version'); }
async function getInstance(client) { return client.get('/api/instance'); }
async function getSetupStatus(client) { return client.get('/api/setup/status'); }
async function getMe(client) { return client.get('/auth/me'); }
async function getBalance(client) { return client.get('/api/user/balance'); }
async function getStats(client, days = 30, filters = {}) {
  return client.get('/api/user/stats', { query: { days, ...filters } });
}
async function getStatsFilters(client) { return client.get('/api/user/stats/filters'); }
async function getLatencyStats(client, query = {}) { return client.get('/api/user/stats/latency', { query }); }
async function getMessageStats(client, query = {}) { return client.get('/api/user/message-stats', { query }); }
async function getUsage(client) { return client.get('/api/user/usage'); }
async function getCodeBalances(client) { return client.get('/api/user/code-balances'); }
async function getCurrentModel(client) { return client.get('/api/user/current-model'); }
async function setCurrentModel(client, modelId) {
  return client.put('/api/user/current-model', { modelId });
}

async function listApiKeys(client) {
  return arrayOrEmpty(await client.get('/api/user/api-keys'));
}
async function createApiKey(client, { name, expiresIn, customModelName }) {
  return client.post('/api/user/api-keys', {
    name,
    ...(expiresIn ? { expiresIn } : {}),
    ...(customModelName ? { customModelName } : {}),
  });
}
async function toggleApiKey(client, id, enabled) {
  return client.put(`/api/user/api-keys/${encodeURIComponent(id)}/enabled`, { enabled: !!enabled });
}
async function renameApiKey(client, id, name) {
  return client.put(`/api/user/api-keys/${encodeURIComponent(id)}`, { name });
}
async function deleteApiKey(client, id) {
  return client.delete(`/api/user/api-keys/${encodeURIComponent(id)}`);
}
async function getApiKeyConfig(client, id) {
  return client.get(`/api/user/api-keys/${encodeURIComponent(id)}/config`);
}
async function getApiKeyUsage(client, id) {
  return client.get(`/api/user/api-keys/${encodeURIComponent(id)}/usage`);
}

async function fallbackUserProviders(client, { search = '' } = {}) {
  try {
    const own = arrayOrEmpty(await client.get('/api/user/my-providers'));
    if (own.length) {
      const items = own.filter(item => !search || [item.name, item.id, item.base_url].some(value => String(value || '').toLowerCase().includes(String(search).toLowerCase())));
      return { scope: 'user', items, total: own.length, stats: null };
    }
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) throw error;
  }
  const visible = arrayOrEmpty(await client.get('/api/user/providers'));
  return {
    scope: 'visible',
    items: visible.map(item => ({ ...item, enabled: item.enabled !== false, has_api_key: null }))
      .filter(item => !search || [item.name, item.id, item.base_url].some(value => String(value || '').toLowerCase().includes(String(search).toLowerCase()))),
    total: visible.length,
    stats: null,
  };
}

async function listProviders(client, { search = '', status = '', scope = '', keyMode = '', tagId = '', page = 1, limit = 100 } = {}) {
  try {
    const data = await client.get('/api/admin/providers', { query: { page, limit, q: search, status, scope, key_mode: keyMode, tag_id: tagId } });
    if (data && Array.isArray(data.items)) {
      return { scope: 'admin', items: data.items, total: Number(data.total) || data.items.length, stats: data.stats || null };
    }
    if (Array.isArray(data)) {
      return { scope: 'admin', items: data, total: data.length, stats: null };
    }
  } catch (error) {
    if (!(error instanceof ApiError) || !FALLBACK_STATUS.has(error.statusCode)) throw error;
    if (error.statusCode === 401) throw error;
  }
  return fallbackUserProviders(client, { search });
}

async function pingProvider(client, id) {
  try {
    return await client.get(`/api/admin/providers/${encodeURIComponent(id)}/ping`, { timeoutMs: 30000 });
  } catch (error) {
    if (!(error instanceof ApiError) || !FALLBACK_STATUS.has(error.statusCode)) throw error;
    if (error.statusCode === 401) throw error;
  }
  return client.get(`/api/user/providers/${encodeURIComponent(id)}/ping`, { timeoutMs: 30000 });
}

async function toggleProvider(client, id, enabled) {
  return client.post(`/api/admin/providers/${encodeURIComponent(id)}/toggle-enabled`, { enabled: !!enabled });
}

async function listModels(client, { search = '', page = 1, limit = 100 } = {}) {
  try {
    const data = await client.get('/api/admin/models', { query: { page, limit, q: search } });
    if (data && Array.isArray(data.items)) {
      return { scope: 'admin', items: data.items, total: Number(data.total) || data.items.length, page: Number(data.page) || page, stats: data.stats || null };
    }
    if (Array.isArray(data)) {
      return { scope: 'admin', items: data, total: data.length, page: 1, stats: null };
    }
  } catch (error) {
    if (!(error instanceof ApiError) || !FALLBACK_STATUS.has(error.statusCode)) throw error;
    if (error.statusCode === 401) throw error;
  }
  let items = arrayOrEmpty(await client.get('/api/user/models')).map(item => ({ ...item, enabled: item.enabled !== false }));
  if (search) {
    const query = String(search).toLowerCase();
    items = items.filter(item => [item.id, item.name, item.upstream_model_id, item.provider, item.provider_name]
      .some(value => String(value || '').toLowerCase().includes(query)));
  }
  return { scope: 'user', items, total: items.length, page: 1, stats: null };
}

async function testModel(client, id) {
  try {
    return await client.post(`/api/admin/models/${encodeURIComponent(id)}/test`, {}, { timeoutMs: 60000 });
  } catch (error) {
    if (!(error instanceof ApiError) || !FALLBACK_STATUS.has(error.statusCode)) throw error;
    if (error.statusCode === 401) throw error;
  }
  return client.post(`/api/user/models/${encodeURIComponent(id)}/test`, {}, { timeoutMs: 60000 });
}

async function listSessions(client, { days = 30, page = 1, pageSize = 30 } = {}) {
  return client.get('/api/user/sessions', { query: { days, page, pageSize } });
}
async function getSessionMessages(client, key, { page = 1, pageSize = 20 } = {}) {
  return client.get(`/api/user/sessions/${encodeURIComponent(key)}/messages`, { query: { page, pageSize } });
}
async function searchSessions(client, { q, days = 30 } = {}) {
  return client.get('/api/user/sessions/search', { query: { q, days } });
}
async function getUsageLogs(client, { page = 1, pageSize = 20, ...filters } = {}) {
  return client.get('/api/user/usage-logs', { query: { page, pageSize, ...filters } });
}

async function listUsers(client, { search = '', page = 1, limit = 100 } = {}) {
  return client.get('/api/admin/users', { query: { page, limit, q: search } });
}

function statsSummary(stats) {
  const source = objectOrEmpty(stats);
  const summary = objectOrEmpty(source.summary);
  return {
    requests: Number(summary.total_requests || 0),
    tokens: Number(summary.total_tokens || 0),
    promptTokens: Number(summary.total_prompt_tokens || 0),
    completionTokens: Number(summary.total_completion_tokens || 0),
    cachedTokens: Number(summary.total_cached_tokens || 0),
    cost: Number(summary.total_cost || 0),
    avgLatency: Number(summary.avg_latency || 0),
    knownRequests: Number(summary.known_requests || 0),
    unknownRequests: Number(summary.unknown_requests || 0),
    identifiedRate: Number(summary.identified_rate || 0),
    activeSources: Number(summary.active_sources || 0),
    daily: arrayOrEmpty(source.daily),

    byModel: arrayOrEmpty(source.byModel),
    byProvider: arrayOrEmpty(source.byProvider),
    byApiKey: arrayOrEmpty(source.byApiKey),
    bySource: arrayOrEmpty(source.bySource),
  };
}

module.exports = {
  getVersion,
  getInstance,
  getSetupStatus,
  getMe,
  getBalance,
  getStats,
  getStatsFilters,
  getLatencyStats,
  getMessageStats,
  getUsage,
  getCodeBalances,
  getCurrentModel,
  setCurrentModel,
  listApiKeys,
  createApiKey,
  toggleApiKey,
  renameApiKey,
  deleteApiKey,
  getApiKeyConfig,
  getApiKeyUsage,
  listProviders,
  pingProvider,
  toggleProvider,
  listModels,
  testModel,
  listSessions,
  getSessionMessages,
  searchSessions,
  getUsageLogs,
  listUsers,
  statsSummary,
};
