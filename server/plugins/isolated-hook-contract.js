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
  const ownMeta = scalarFields(result.meta, key => key === `plugin:${pluginId}` || key.startsWith(`dim:${pluginId}:`));
  return { ...original, meta: { ...(original.meta || {}), ...ownMeta } };
}

module.exports = { scalarFields, sanitizeIsolatedHookInput, sanitizeIsolatedHookResult };
