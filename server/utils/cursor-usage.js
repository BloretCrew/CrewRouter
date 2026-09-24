'use strict';

const { quotaRequest } = require('./quota-http');
const { getPrimaryApiKey } = require('./provider-keys');

// Cursor 个人 Pro/Pro+/Ultra 用量走 Agent 内部 Connect RPC，非公开文档。
// User API Key（crsr_...）先 POST /auth/exchange_user_api_key 换 accessToken（约 1 小时），
// 再 POST /aiserver.v1.DashboardService/<Method>。金额字段为美元美分。
// 2026-08 起部分账号 GetCurrentPeriodUsage 不再返回 planUsage，
// 此时用 GetAggregatedUsageEvents 的 totalCents 之和，上限取 GetPlanInfo 或 GetHardLimit。
const API_BASE = process.env.CURSOR_API_BASE || 'https://api2.cursor.sh';
const TOKEN_REFRESH_SKEW_SEC = 5 * 60;

const tokenCache = new Map();

function centsToUsd(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number / 100 : 0;
}

function jwtExpSec(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    const exp = Number(payload.exp);
    return Number.isFinite(exp) ? exp : 0;
  } catch {
    return 0;
  }
}

function formatCycleEnd(msValue) {
  const ms = Number(msValue);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function sumAggregatedCents(aggregated) {
  const list = Array.isArray(aggregated?.aggregations) ? aggregated.aggregations : [];
  return list.reduce((sum, item) => sum + (Number(item?.totalCents) || 0), 0);
}

function hasPlanUsage(period) {
  const usage = period?.planUsage;
  if (!usage || typeof usage !== 'object') return false;
  return usage.limit != null || usage.totalSpend != null || usage.includedSpend != null || usage.totalPercentUsed != null;
}

/**
 * 把 DashboardService 响应归一化为统一 quota 结构。金额为美元。
 */
function normalizeCursorUsage({ period, plan, aggregated, hardLimit }) {
  const planInfo = plan?.planInfo && typeof plan.planInfo === 'object' ? plan.planInfo : {};
  const planName = planInfo.planName || 'Cursor';
  const resetsAt = formatCycleEnd(period?.billingCycleEnd || planInfo.billingCycleEnd);
  const onDemandOff = hardLimit?.noUsageBasedAllowed === true;
  const notes = [];
  if (period?.displayMessage) notes.push(String(period.displayMessage));
  if (onDemandOff) notes.push('On-Demand 已关闭');

  if (hasPlanUsage(period)) {
    const usage = period.planUsage;
    const total = usage.limit != null ? centsToUsd(usage.limit) : centsToUsd(planInfo.includedAmountCents);
    const used = centsToUsd(usage.includedSpend ?? usage.totalSpend ?? 0);
    const remaining = usage.remaining != null ? centsToUsd(usage.remaining) : Math.max(0, total - used);
    const percent = usage.totalPercentUsed != null
      ? Number(usage.totalPercentUsed)
      : (total > 0 ? Math.min(100, (used / total) * 100) : 0);
    const periods = [];
    if (usage.autoPercentUsed != null) {
      periods.push({ key: 'auto', label: 'Auto', percent: Number(usage.autoPercentUsed), resetsAt });
    }
    if (usage.apiPercentUsed != null) {
      periods.push({ key: 'api', label: '指定模型', percent: Number(usage.apiPercentUsed), resetsAt });
    }
    if (!periods.length) {
      periods.push({ key: 'included', label: '套餐额度', percent, resetsAt });
    }
    return {
      planName,
      unit: 'balance',
      total,
      used,
      remaining,
      periods,
      extra: notes.join(' · '),
    };
  }

  const spent = sumAggregatedCents(aggregated) / 100;
  const included = centsToUsd(planInfo.includedAmountCents);
  const hardDollars = Number(hardLimit?.hardLimit);
  const total = included > 0 ? included : (Number.isFinite(hardDollars) && hardDollars > 0 ? hardDollars : 0);
  const remaining = Math.max(0, total - spent);
  const percent = total > 0 ? Math.min(100, (spent / total) * 100) : 0;
  notes.push('planUsage 缺失，花费来自按模型汇总');
  return {
    planName,
    unit: 'balance',
    total,
    used: spent,
    remaining,
    periods: [{ key: 'included', label: '套餐额度', percent, resetsAt }],
    extra: notes.join(' · '),
  };
}

async function readJson(response, label) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {
    throw new Error(`${label} 响应非 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const message = data?.message || data?.error || `HTTP ${response.status}`;
    const error = new Error(`${label} 失败（${typeof message === 'string' ? message : `HTTP ${response.status}`}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function exchangeUserApiKey(apiKey, provider) {
  const response = await quotaRequest(`${API_BASE}/auth/exchange_user_api_key`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'crewrouter-quota/1.0',
    },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  }, provider);
  const data = await readJson(response, 'Cursor API Key 兑换');
  if (!data.accessToken) throw new Error('Cursor API Key 兑换未返回 accessToken');
  return data.accessToken;
}

async function resolveAccessToken(apiKey, provider) {
  if (!apiKey.startsWith('crsr_')) return apiKey;
  const cached = tokenCache.get(apiKey);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp > now + TOKEN_REFRESH_SKEW_SEC) return cached.token;
  const token = await exchangeUserApiKey(apiKey, provider);
  const exp = jwtExpSec(token) || now + 3600;
  tokenCache.set(apiKey, { token, exp });
  return token;
}

async function dashboardCall(method, token, provider) {
  const response = await quotaRequest(`${API_BASE}/aiserver.v1.DashboardService/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      Accept: 'application/json',
      'User-Agent': 'crewrouter-quota/1.0',
    },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  }, provider);
  return readJson(response, `Cursor ${method}`);
}

async function fetchCursorUsage(provider) {
  const apiKey = (getPrimaryApiKey(provider) || '').trim();
  if (!apiKey) throw new Error('未配置 Cursor API Key');

  let token = await resolveAccessToken(apiKey, provider);
  let period;
  try {
    period = await dashboardCall('GetCurrentPeriodUsage', token, provider);
  } catch (error) {
    if (error.status === 401 && apiKey.startsWith('crsr_')) {
      tokenCache.delete(apiKey);
      token = await resolveAccessToken(apiKey, provider);
      period = await dashboardCall('GetCurrentPeriodUsage', token, provider);
    } else {
      throw error;
    }
  }

  let plan = null;
  let aggregated = null;
  let hardLimit = null;
  if (!hasPlanUsage(period)) {
    [plan, aggregated, hardLimit] = await Promise.all([
      dashboardCall('GetPlanInfo', token, provider).catch(() => null),
      dashboardCall('GetAggregatedUsageEvents', token, provider).catch(() => null),
      dashboardCall('GetHardLimit', token, provider).catch(() => null),
    ]);
  } else {
    plan = await dashboardCall('GetPlanInfo', token, provider).catch(() => null);
  }

  return normalizeCursorUsage({ period, plan, aggregated, hardLimit });
}

function clearCursorTokenCache() {
  tokenCache.clear();
}

module.exports = {
  API_BASE,
  fetchCursorUsage,
  normalizeCursorUsage,
  hasPlanUsage,
  centsToUsd,
  jwtExpSec,
  sumAggregatedCents,
  clearCursorTokenCache,
};
