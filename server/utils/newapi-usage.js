'use strict';

const { quotaRequest } = require('./quota-http');
const { getPrimaryApiKey } = require('./provider-keys');

// new-api（及 one-api 系）站点的 OpenAI 旧版兼容额度接口。
// 路由注册见 new-api router/dashboard.go，TokenAuth 鉴权（即聊天用令牌）：
//   GET /dashboard/billing/subscription → hard_limit_usd = 剩余 + 已用（站点展示单位换算后的金额）
//   GET /dashboard/billing/usage        → total_usage = 已用，单位为美分（金额 × 100）
// 错误时不返回 4xx/5xx 而是 HTTP 200 + {"error":{"message":...}}。
const SUBSCRIPTION_PATHS = ['/dashboard/billing/subscription', '/v1/dashboard/billing/subscription'];
const USAGE_PATHS = ['/dashboard/billing/usage', '/v1/dashboard/billing/usage'];

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || '').trim().replace(/\/+$/, '');
}

/**
 * 提取带路径的 base URL 的根（origin + 可选顶层路径前缀），
 * 使 /dashboard/billing/... 能拼在 /v1 等代理路径之外。
 */
function rootOf(baseUrl) {
  const cleaned = normalizeBaseUrl(baseUrl);
  const match = cleaned.match(/^(https?:\/\/[^/]+)/);
  if (match) return match[1];
  return cleaned;
}

function pickNumber(value) {
  if (value && typeof value === 'object') {
    return pickNumber(value.amount ?? value.value ?? value.quota);
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** 站点报错时返回 200 + {"error":{...}}；其余按消息处理 */
function extractError(data, status) {
  if (data && data.error) {
    const err = data.error;
    const message = typeof err === 'string' ? err : (err.message || err.type || JSON.stringify(err));
    return `HTTP ${status}: ${message}`;
  }
  if (status >= 400) return `HTTP ${status}`;
  return null;
}

async function fetchJson(url, apiKey, provider, label) {
  const response = await quotaRequest(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'crewrouter-quota/1.0',
    },
    signal: AbortSignal.timeout(15000),
  }, provider);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {
    throw new Error(`${label} 响应非 JSON（HTTP ${response.status}）`);
  }
  const error = extractError(data, response.status);
  if (error) throw new Error(`${label} 查询失败（${error}）`);
  return { data, status: response.status };
}

/** 依次尝试 /dashboard 与 /v1/dashboard 两个路径，返回第一个成功者 */
async function fetchWithFallback(baseUrl, paths, apiKey, provider, label) {
  let lastError;
  for (const path of paths) {
    try {
      const result = await fetchJson(`${baseUrl}${path}`, apiKey, provider, label);
      const data = result.data;
      if (data && (data.object || data.hard_limit_usd !== undefined || data.total_usage !== undefined)) {
        return data;
      }
      lastError = new Error(`${label} 响应缺少额度字段`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function normalizeNewApiUsage({ subscription, usage, providerName }) {
  // subscription：总额度 = hard_limit_usd（= soft/system_hard，站点已按展示单位换算成美元口径）
  const total = pickNumber(subscription?.hard_limit_usd)
    ?? pickNumber(subscription?.system_hard_limit_usd)
    ?? pickNumber(subscription?.soft_limit_usd)
    ?? 0;
  // usage：已用额度，单位为美分（0.01 美元）
  const usedCents = pickNumber(usage?.total_usage) ?? 0;
  const used = usedCents / 100;

  const unlimited = pickNumber(subscription?.hard_limit_usd) >= 100000000;
  const remaining = Math.max(0, total - used);
  const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0;

  const expiredAt = pickNumber(subscription?.access_until);
  const parts = [];
  if (unlimited) parts.push('令牌为无限额度');
  if (expiredAt > 0) parts.push(`令牌过期于 ${new Date(expiredAt * 1000).toLocaleString('zh-CN', { hour12: false })}`);
  if (!usage) parts.push('站点未开放 usage 接口，已用按 0 计');

  return {
    planName: providerName || 'new-api',
    unit: 'balance',
    total,
    used,
    remaining,
    periods: [],
    extra: parts.join(' · '),
  };
}

async function fetchNewApiUsage(provider) {
  const apiKey = (getPrimaryApiKey(provider) || '').trim();
  if (!apiKey) throw new Error('未配置 API Key');

  const baseUrl = rootOf(provider.base_url || '');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('供应商 Base URL 无效');

  const [subscription, usage] = await Promise.all([
    fetchWithFallback(baseUrl, SUBSCRIPTION_PATHS, apiKey, provider, 'subscription 额度'),
    // usage 端点部分站点未开放，失败不致命
    fetchWithFallback(baseUrl, USAGE_PATHS, apiKey, provider, 'usage 用量').catch(() => null),
  ]);

  return normalizeNewApiUsage({ subscription, usage, providerName: provider.name });
}

module.exports = {
  SUBSCRIPTION_PATHS,
  USAGE_PATHS,
  fetchNewApiUsage,
  normalizeNewApiUsage,
  rootOf,
  pickNumber,
  extractError,
};
