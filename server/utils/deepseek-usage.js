'use strict';

const { quotaRequest } = require('./quota-http');
const { getPrimaryApiKey } = require('./provider-keys');

// DeepSeek 开放平台余额接口（官方文档：https://api-docs.deepseek.com/zh-cn/api/get-user-balance）
//   GET /user/balance，Authorization: Bearer <API Key>
// 只返回当前余额，不包含历史用量；余额不足时模型接口返回 HTTP 402。
const DEFAULT_API_BASE = process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com';
const BALANCE_PATH = '/user/balance';

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return DEFAULT_API_BASE;
  }
}

function toAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readError(data) {
  const error = data && data.error;
  if (!error) return '';
  if (typeof error === 'string') return error;
  return error.message || error.type || error.code || JSON.stringify(error);
}

/**
 * 把 /user/balance 响应归一化为统一 quota 结构。
 * 余额是账户当前可用金额，没有额度上限，因此 total 与 remaining 相同、used 留空，
 * 避免把余额误报成「已用 0%」。多币种时以第一条为主展示，其余写入 extra。
 */
function normalizeDeepSeekBalance(data, providerName) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('DeepSeek 返回无效余额数据');
  const infos = Array.isArray(data.balance_infos)
    ? data.balance_infos.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
  if (!infos.length) throw new Error('DeepSeek 响应缺少 balance_infos');
  const primary = infos[0];
  const total = toAmount(primary.total_balance);
  if (total === null) throw new Error('DeepSeek 响应缺少 total_balance');
  const currency = typeof primary.currency === 'string' ? primary.currency.trim().toUpperCase() : '';
  const granted = toAmount(primary.granted_balance);
  const toppedUp = toAmount(primary.topped_up_balance);

  const parts = [];
  if (currency) parts.push(currency);
  if (granted !== null) parts.push(`赠金 ${granted.toFixed(2)}`);
  if (toppedUp !== null) parts.push(`充值 ${toppedUp.toFixed(2)}`);
  for (const other of infos.slice(1)) {
    const amount = toAmount(other.total_balance);
    if (amount === null) continue;
    const otherCurrency = typeof other.currency === 'string' ? other.currency.trim().toUpperCase() : '';
    parts.push(`${otherCurrency || '其他币种'} ${amount.toFixed(2)}`);
  }
  if (data.is_available === false) parts.push('余额不足，模型调用将返回 HTTP 402');

  return {
    planName: providerName || 'DeepSeek',
    unit: 'balance',
    currency,
    total,
    used: null,
    remaining: total,
    periods: [],
    extra: parts.join(' · '),
  };
}

async function fetchDeepSeekUsage(provider) {
  const apiKey = (getPrimaryApiKey(provider) || '').trim();
  if (!apiKey) throw new Error('未配置 DeepSeek API Key');
  const apiBase = originOf(provider.base_url || '');

  const response = await quotaRequest(`${apiBase}${BALANCE_PATH}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'crewrouter-quota/1.0',
    },
    signal: AbortSignal.timeout(15000),
  }, provider);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`DeepSeek 余额响应非 JSON（HTTP ${response.status}）`);
  }
  const error = readError(data);
  if (error) throw new Error(`DeepSeek 余额查询失败（HTTP ${response.status}: ${error}）`);
  if (!response.ok) throw new Error(`DeepSeek 余额查询失败（HTTP ${response.status}）`);
  return normalizeDeepSeekBalance(data, provider.name);
}

module.exports = {
  DEFAULT_API_BASE,
  BALANCE_PATH,
  fetchDeepSeekUsage,
  normalizeDeepSeekBalance,
  originOf,
};
