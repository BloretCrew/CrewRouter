'use strict';

const { quotaRequest } = require('./quota-http');
const { getPrimaryApiKey } = require('./provider-keys');

// OpenRouter 额度接口：
//   GET /api/v1/credits → 账户累计购买 total_credits 与累计消耗 total_usage（需要 Management Key）
//   GET /api/v1/key     → 当前普通推理 Key 的 limit / limit_remaining 与日/周/月用量
// 两种 Key 不通用：先查账户 Credits，失败后回退到普通 Key 额度。
const DEFAULT_API_BASE = process.env.OPENROUTER_API_BASE || 'https://openrouter.ai';
const CREDITS_PATH = '/api/v1/credits';
const KEY_PATH = '/api/v1/key';

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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadOf(data) {
  return isRecord(data?.data) ? data.data : data;
}

function readError(data) {
  const error = data && (data.error || data.message);
  if (!error) return '';
  if (typeof error === 'string') return error;
  return error.message || error.type || JSON.stringify(error);
}

async function requestJson(url, apiKey, provider, label) {
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
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label}响应非 JSON（HTTP ${response.status}）`);
  }
  const error = readError(data);
  if (error) throw new Error(`${label}查询失败（HTTP ${response.status}: ${error}）`);
  if (!response.ok) throw new Error(`${label}查询失败（HTTP ${response.status}）`);
  return payloadOf(data);
}

/** 账户 Credits：total_credits 是累计购买，total_usage 是累计消耗，剩余为两者差值。 */
function normalizeOpenRouterCredits(data, providerName) {
  const payload = payloadOf(data);
  if (!isRecord(payload)) throw new Error('OpenRouter credits 返回无效数据');
  const total = toAmount(payload.total_credits);
  if (total === null) throw new Error('OpenRouter credits 响应缺少 total_credits');
  const used = toAmount(payload.total_usage) ?? 0;
  const remaining = Math.max(0, total - used);
  return {
    planName: providerName || 'OpenRouter',
    unit: 'balance',
    currency: 'USD',
    total,
    used,
    remaining,
    periods: [],
    extra: '账户 Credits（Management Key）',
  };
}

/** 普通推理 Key：limit_remaining 可能为 null（无额度上限），此时只展示累计用量。 */
function normalizeOpenRouterKey(data, providerName) {
  const payload = payloadOf(data);
  if (!isRecord(payload)) throw new Error('OpenRouter key 返回无效数据');
  const limit = toAmount(payload.limit);
  const limitRemaining = toAmount(payload.limit_remaining);
  const usage = toAmount(payload.usage);
  if (limit === null && limitRemaining === null && usage === null) {
    throw new Error('OpenRouter key 响应缺少 limit / limit_remaining / usage');
  }
  const used = usage ?? 0;
  const total = limit !== null ? limit : limitRemaining !== null ? limitRemaining + used : null;
  const remaining = limitRemaining !== null ? limitRemaining : total !== null ? Math.max(0, total - used) : null;

  const parts = ['普通 Key 额度'];
  if (limit === null && limitRemaining === null) parts.push('Key 无额度上限');
  else if (limit !== null) parts.push(`Key 上限 $${limit.toFixed(2)}`);
  if (payload.limit_reset) {
    const resets = { daily: '每日', weekly: '每周', monthly: '每月' };
    parts.push(`${resets[payload.limit_reset] || payload.limit_reset}重置`);
  }
  for (const [field, label] of [['usage_daily', '日用量'], ['usage_weekly', '周用量'], ['usage_monthly', '月用量']]) {
    const value = toAmount(payload[field]);
    if (value !== null) parts.push(`${label} $${value.toFixed(2)}`);
  }
  return {
    planName: providerName || 'OpenRouter',
    unit: 'balance',
    currency: 'USD',
    total,
    used,
    remaining,
    periods: [],
    extra: parts.join(' · '),
  };
}

async function fetchOpenRouterUsage(provider) {
  const apiKey = (getPrimaryApiKey(provider) || '').trim();
  if (!apiKey) throw new Error('未配置 OpenRouter API Key');
  const apiBase = originOf(provider.base_url || '');

  let creditsError;
  try {
    const payload = await requestJson(`${apiBase}${CREDITS_PATH}`, apiKey, provider, 'OpenRouter credits ');
    return normalizeOpenRouterCredits(payload, provider.name);
  } catch (error) {
    creditsError = error;
  }
  try {
    const payload = await requestJson(`${apiBase}${KEY_PATH}`, apiKey, provider, 'OpenRouter key ');
    return normalizeOpenRouterKey(payload, provider.name);
  } catch (keyError) {
    throw new Error(`OpenRouter 额度查询失败（${creditsError.message}；${keyError.message}）`);
  }
}

module.exports = {
  DEFAULT_API_BASE,
  CREDITS_PATH,
  KEY_PATH,
  fetchOpenRouterUsage,
  normalizeOpenRouterCredits,
  normalizeOpenRouterKey,
  originOf,
};
