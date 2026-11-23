'use strict';

function scalarFields(value, allowed = () => true) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed(key) || !['string', 'number', 'boolean'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) continue;
    out[key.slice(0, 128)] = typeof item === 'string' ? item.slice(0, 512) : item;
  }
  return out;
}

function sanitizeIsolatedHookInput(pluginId, hookName, payload, meta) {
  const safeMeta = { requestType: String(meta?.requestType || '').slice(0, 64) };
  if (hookName === 'billing:calculate') {
    return { payload: scalarFields(payload, key => ['cost', 'ratio', 'weightedTokens'].includes(key)), meta: safeMeta };
  }
  if (hookName === 'stats:record') {
    const current = scalarFields(payload?.meta, key => key === `plugin:${pluginId}` || key.startsWith(`dim:${pluginId}:`));
    return { payload: { meta: current }, meta: safeMeta };
  }
  if (hookName === 'gateway:finalResponse') {
    return { payload: { statusCode: Number(payload?.statusCode) || 0, headers: {} }, meta: safeMeta };
  }
  if (hookName === 'models:list') {
    const models = Array.isArray(payload?.models) ? payload.models.slice(0, 500).map(model => ({ id: String(model?.id || '').slice(0, 256) })).filter(model => model.id) : [];
    return { payload: { models }, meta: safeMeta };
  }
  if (hookName === 'provider:select') {
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates.slice(0, 100).map(candidate => ({ id: String(candidate?.id || candidate?.provider_id || '').slice(0, 128), name: String(candidate?.name || '').slice(0, 128) })).filter(candidate => candidate.id) : [];
    return { payload: { candidates }, meta: { providerId: String(meta?.providerId || '').slice(0, 128), group: String(meta?.group || '').slice(0, 128) } };
  }
  throw new Error(`isolated-hooks 不支持 hook ${hookName}`);
}

function sanitizeIsolatedHookResult(pluginId, hookName, result, original) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('隔离 hook 返回格式必须是对象');
  if (hookName === 'billing:calculate') {
    const output = { ...original };
    for (const key of ['cost', 'ratio', 'weightedTokens']) {
      if (result[key] !== undefined) {
        const value = Number(result[key]);
        if (!Number.isFinite(value) || value < 0 || value > 1e12) throw new Error(`isolated billing hook invalid ${key}`);
        output[key] = value;
      }
    }
    return output;
  }
  if (hookName === 'models:list') {
    const allowed = new Set((original.models || []).map(model => String(model?.id || '')).filter(Boolean));
    const seen = new Set();
    const models = [];
    for (const model of Array.isArray(result.models) ? result.models.slice(0, 500) : []) {
      const id = String(model?.id || '').slice(0, 256);
      if (!allowed.has(id) || seen.has(id)) continue;
      seen.add(id);
      models.push({ ...((original.models || []).find(item => String(item.id) === id) || { id }) });
    }
    return { ...original, models };
  }
  if (hookName === 'provider:select') {
    const allowed = new Set((original.candidates || []).map(candidate => String(candidate?.id || candidate?.provider_id || '')).filter(Boolean));
    const seen = new Set();
    const candidates = [];
    for (const value of Array.isArray(result.candidateIds) ? result.candidateIds.slice(0, 100) : []) {
      const id = String(value || '').slice(0, 128);
      if (!allowed.has(id) || seen.has(id)) continue;
      seen.add(id);
      const candidate = (original.candidates || []).find(item => String(item?.id || item?.provider_id || '') === id);
      if (candidate) candidates.push(candidate);
    }
    return candidates.length ? { ...original, candidates } : original;
  }
  if (hookName === 'gateway:finalResponse') {
    const headers = {};
    if (result.headers && typeof result.headers === 'object' && !Array.isArray(result.headers)) {
      for (const [name, value] of Object.entries(result.headers)) {
        const key = String(name);
        const safeName = `x-plugin-${pluginId.toLowerCase()}-`;
        if (!key.toLowerCase().startsWith(safeName) || typeof value !== 'string' || value.length > 1024 || /[\r\n]/.test(value)) continue;
        headers[key] = value;
      }
    }
    const originalHeaders = {};
    for (const [name, value] of Object.entries(original.headers || {})) {
      const key = String(name);
      const safeName = `x-plugin-${pluginId.toLowerCase()}-`;
      if (key.toLowerCase().startsWith(safeName) && typeof value === 'string' && value.length <= 1024 && !/[\r\n]/.test(value)) originalHeaders[key] = value;
    }
    return { statusCode: original.statusCode, headers: { ...originalHeaders, ...headers } };
  }
  const ownMeta = scalarFields(result.meta, key => key === `plugin:${pluginId}` || key.startsWith(`dim:${pluginId}:`));
  return { ...original, meta: { ...(original.meta || {}), ...ownMeta } };
}

module.exports = { scalarFields, sanitizeIsolatedHookInput, sanitizeIsolatedHookResult };
