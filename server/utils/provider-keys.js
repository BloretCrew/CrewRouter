/**
 * 供应商多 API Key 工具：
 * - 主 Key：列表第一项，用于获取模型列表 / 额度 / 连通性等
 * - 顺序模式：调用时按排序依次 fallback
 * - 权重模式：首次按权重随机，失败后按权重降序 fallback（剔除已失败项）
 */

const { decryptSecret } = require('./secret-crypto');

function parseApiKeysRaw(raw) {
  if (raw == null || raw === '') return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') {
    // pg 可能已解析为 object 但非数组
    return Array.isArray(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 规范化权重：正数，默认 1
 * @param {*} w
 * @returns {number}
 */
function normalizeWeight(w) {
  const n = Number(w);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(n, 1000000);
}

/**
 * 从供应商行解析 Key 列表（固定密钥模式用）
 * @param {object} provider
 * @returns {{ key: string, weight: number }[]}
 */
function normalizeProviderKeyEntries(provider) {
  if (!provider) return [];
  const fromJson = parseApiKeysRaw(provider.api_keys);
  if (fromJson && fromJson.length > 0) {
    const entries = fromJson
      .map((item) => {
        if (typeof item === 'string') {
          const key = decryptSecret(String(item || '').trim());
          return key ? { key, weight: 1, enabled: true } : null;
        }
        if (item && typeof item === 'object') {
          const key = decryptSecret(String(item.key || item.api_key || '').trim());
          if (!key) return null;
          return { key, weight: normalizeWeight(item.weight), enabled: item.enabled !== false };
        }
        return null;
      })
      .filter(Boolean);
    if (entries.length > 0) return entries;
  }
  const single = decryptSecret(String(provider.api_key || '').trim());
  return single ? [{ key: single, weight: 1, enabled: true }] : [];
}

/**
 * 主 Key（列表第一项；脚本模式仍可能走 api_key 缓存）
 * @param {object} provider
 * @returns {string}
 */
function getPrimaryApiKey(provider) {
  const entries = normalizeProviderKeyEntries(provider);
  const primary = entries.find((e) => e.enabled !== false);
  if (primary) return primary.key;
  return String(provider?.api_key || '').trim();
}

/**
 * 选择模式：order | weight
 * @param {object} provider
 * @returns {'order'|'weight'}
 */
function getApiKeySelectMode(provider) {
  const mode = String(provider?.api_key_select_mode || 'order').toLowerCase();
  return mode === 'weight' ? 'weight' : 'order';
}

/**
 * 按权重随机抽取一项
 * @param {{ key: string, weight: number }[]} entries
 */
function pickWeightedEntry(entries) {
  if (!entries || entries.length === 0) return null;
  if (entries.length === 1) return entries[0];
  const total = entries.reduce((s, e) => s + (e.weight || 1), 0);
  if (total <= 0) return entries[0];
  let r = Math.random() * total;
  for (const e of entries) {
    r -= e.weight || 1;
    if (r <= 0) return e;
  }
  return entries[entries.length - 1];
}

/**
 * 构建调用时的 Key 尝试顺序（仅固定密钥；脚本模式由调用方单独处理）
 * - order：原序
 * - weight：先权重随机选一个，其余按权重降序
 * @param {object} provider
 * @returns {string[]}
 */
function buildKeyAttemptOrder(provider) {
  const entries = normalizeProviderKeyEntries(provider).filter((e) => e.enabled !== false);
  if (entries.length === 0) return [];
  if (entries.length === 1) return [entries[0].key];

  if (getApiKeySelectMode(provider) !== 'weight') {
    return entries.map((e) => e.key);
  }

  const first = pickWeightedEntry(entries);
  if (!first) return entries.map((e) => e.key);
  const rest = entries
    .filter((e) => e.key !== first.key)
    .sort((a, b) => (b.weight || 1) - (a.weight || 1) || 0);
  // 若存在相同 key 的重复项，用 index 区分
  const used = new Set([first.key]);
  const order = [first.key];
  for (const e of rest) {
    if (used.has(e.key)) continue;
    used.add(e.key);
    order.push(e.key);
  }
  // 同 key 去重后若还有未加入的（相同 key 副本）已跳过，符合预期
  // 若全部 key 相同，至少返回一个
  return order.length ? order : [first.key];
}

/**
 * 规范化前端提交的多 Key 列表
 * @param {any} apiKeys
 * @param {string} [fallbackApiKey]
 * @returns {{ key: string, weight: number }[]|null} null 表示未提供有效更新
 */
function normalizeKeysInput(apiKeys, fallbackApiKey) {
  if (Array.isArray(apiKeys)) {
    const entries = apiKeys
      .map((item) => {
        if (typeof item === 'string') {
          const key = decryptSecret(String(item || '').trim());
          return key ? { key, weight: 1, enabled: true } : null;
        }
        if (item && typeof item === 'object') {
          const key = decryptSecret(String(item.key || item.api_key || '').trim());
          if (!key) return null;
          return { key, weight: normalizeWeight(item.weight), enabled: item.enabled !== false };
        }
        return null;
      })
      .filter(Boolean);
    if (entries.length > 0) return entries;
    // 显式传空数组：表示清空？通常不允许；返回 null 表示不更新
    return null;
  }
  const single = String(fallbackApiKey || '').trim();
  if (single) return [{ key: single, weight: 1, enabled: true }];
  return null;
}

/**
 * 写入 DB 时：主 Key + JSON 列表
 * @param {{ key: string, weight: number, enabled?: boolean }[]} entries
 */
function toStorageFields(entries) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && e.key) : [];
  const primary = list.find((e) => e.enabled !== false);
  return {
    api_key: primary?.key || list[0]?.key || '',
    api_keys: list.length > 0 ? list : null
  };
}

/**
 * 列表脱敏用：Key 数量
 * @param {object} provider
 */
function countProviderApiKeys(provider) {
  return normalizeProviderKeyEntries(provider).filter((e) => e.enabled !== false).length;
}

module.exports = {
  parseApiKeysRaw,
  normalizeWeight,
  normalizeProviderKeyEntries,
  getPrimaryApiKey,
  getApiKeySelectMode,
  pickWeightedEntry,
  buildKeyAttemptOrder,
  normalizeKeysInput,
  toStorageFields,
  countProviderApiKeys
};
