'use strict';

const { quotaRequest } = require('./quota-http');
const { getPrimaryApiKey } = require('./provider-keys');

// SiliconFlow（硅基流动）账户信息接口：
//   GET /v1/user/info
// 国内站 api.siliconflow.cn 金额单位为 CNY，国际站 api.siliconflow.com 为 USD。
// totalBalance = chargeBalance（充值）+ balance（赠送）。
const DEFAULT_API_BASE = process.env.SILICONFLOW_API_BASE || 'https://api.siliconflow.cn';
const USER_INFO_PATH = '/v1/user/info';
const SUCCESS_CODE = 20000;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return DEFAULT_API_BASE;
  }
}

function currencyFor(url) {
  try {
    return /(^|\.)siliconflow\.com$/i.test(new URL(url).hostname) ? 'USD' : 'CNY';
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

function normalizeSiliconFlowBalance(data, { providerName, currency = 'CNY' } = {}) {
  if (!isRecord(data)) throw new Error('SiliconFlow 返回无效账户数据');
  if (data.status === false || (data.code !== undefined && Number(data.code) !== SUCCESS_CODE)) {
    throw new Error(data.message || data.error?.message || `错误码 ${data.code}`);
  }
  const payload = payloadOf(data);
  if (!isRecord(payload)) throw new Error('SiliconFlow 返回无效账户数据');
  const total = toAmount(payload.totalBalance ?? payload.total_balance);
  const gift = toAmount(payload.balance);
  const charge = toAmount(payload.chargeBalance ?? payload.charge_balance);
  if (total === null && gift === null && charge === null) {
    throw new Error('SiliconFlow 响应缺少 totalBalance / balance / chargeBalance');
  }
  const resolvedTotal = total !== null ? total : (gift ?? 0) + (charge ?? 0);

  const parts = [currency];
  if (gift !== null) parts.push(`赠金 ${gift.toFixed(2)}`);
  if (charge !== null) parts.push(`充值 ${charge.toFixed(2)}`);
  if (resolvedTotal <= 0) parts.push('余额不足，模型调用将被拒绝');

  return {
    planName: providerName || 'SiliconFlow',
    unit: 'balance',
    currency,
    total: resolvedTotal,
    used: null,
    remaining: resolvedTotal,
    periods: [],
    extra: parts.join(' · '),
  };
}

async function fetchSiliconFlowUsage(provider) {
  const apiKey = (getPrimaryApiKey(provider) || '').trim();
  if (!apiKey) throw new Error('未配置 SiliconFlow API Key');
  const apiBase = originOf(provider.base_url || '');
  const currency = currencyFor(apiBase);

  const response = await quotaRequest(`${apiBase}${USER_INFO_PATH}`, {
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
    throw new Error(`SiliconFlow 账户响应非 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const detail = data?.message || data?.error?.message || `HTTP ${response.status}`;
    throw new Error(`SiliconFlow 余额查询失败（${detail}）`);
  }
  return normalizeSiliconFlowBalance(data, { providerName: provider.name, currency });
}

module.exports = {
  DEFAULT_API_BASE,
  USER_INFO_PATH,
  SUCCESS_CODE,
  fetchSiliconFlowUsage,
  normalizeSiliconFlowBalance,
  originOf,
  currencyFor,
};
