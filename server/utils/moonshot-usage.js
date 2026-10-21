'use strict';

const { quotaRequest } = require('./quota-http');
const { getPrimaryApiKey } = require('./provider-keys');

// Moonshot（Kimi）开放平台余额接口：
//   GET /v1/users/me/balance
// 国内站 api.moonshot.cn 金额单位为 CNY，国际站 api.moonshot.ai 为 USD。
const DEFAULT_API_BASE = process.env.MOONSHOT_API_BASE || 'https://api.moonshot.cn';
const BALANCE_PATH = '/v1/users/me/balance';

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return DEFAULT_API_BASE;
  }
}

function currencyFor(url) {
  try {
    return /(^|\.)moonshot\.ai$/i.test(new URL(url).hostname) ? 'USD' : 'CNY';
  } catch {
    return 'CNY';
  }
}

function toAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadOf(data) {
  return isRecord(data?.data) ? data.data : data;
}

function normalizeMoonshotBalance(data, { providerName, currency = 'CNY' } = {}) {
  const payload = payloadOf(data);
  if (!isRecord(payload)) throw new Error('Moonshot 返回无效余额数据');
  if (data?.status === false || (data?.code !== undefined && Number(data.code) !== 0)) {
    throw new Error(data?.message || data?.error?.message || `错误码 ${data.code}`);
  }
  const available = toAmount(payload.available_balance);
  if (available === null) throw new Error('Moonshot 响应缺少 available_balance');
  const cash = toAmount(payload.cash_balance);
  const voucher = toAmount(payload.voucher_balance);

  const parts = [currency];
  if (voucher !== null) parts.push(`赠金 ${voucher.toFixed(2)}`);
  if (cash !== null) parts.push(`现金 ${cash.toFixed(2)}`);
  if (available <= 0) parts.push('余额不足，模型调用将被拒绝');

  return {
    planName: providerName || 'Moonshot',
    unit: 'balance',
    currency,
    total: available,
    used: null,
    remaining: available,
    periods: [],
    extra: parts.join(' · '),
  };
}

async function fetchMoonshotUsage(provider) {
  const apiKey = (getPrimaryApiKey(provider) || '').trim();
  if (!apiKey) throw new Error('未配置 Moonshot API Key');
  const apiBase = originOf(provider.base_url || '');
  const currency = currencyFor(apiBase);

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
    throw new Error(`Moonshot 余额响应非 JSON（HTTP ${response.status}）`);
  }
  const error = data?.error?.message || (typeof data?.error === 'string' ? data.error : '');
  if (error) throw new Error(`Moonshot 余额查询失败（HTTP ${response.status}: ${error}）`);
  if (!response.ok) throw new Error(`Moonshot 余额查询失败（HTTP ${response.status}）`);
  return normalizeMoonshotBalance(data, { providerName: provider.name, currency });
}

module.exports = {
  DEFAULT_API_BASE,
  BALANCE_PATH,
  fetchMoonshotUsage,
  normalizeMoonshotBalance,
  originOf,
  currencyFor,
};
