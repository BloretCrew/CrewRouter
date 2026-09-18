'use strict';

const { quotaRequest } = require('./quota-http');
const { getPrimaryApiKey } = require('./provider-keys');

// Command Code（commandcode.ai）额度接口。/alpha/* 是官方 CLI（cmdc）使用的
// 非公开接口，字段可能变化；GOAT / Pro / Max / Provider 等套餐可用，
// Go 套餐不含 API 权限（四个端点全部 404）。
const DEFAULT_API_BASE = process.env.COMMANDCODE_API_BASE || 'https://api.commandcode.ai';
const ENDPOINTS = Object.freeze({
  whoami: '/alpha/whoami',
  usage: '/alpha/usage/summary',
  credits: '/alpha/billing/credits',
  subscription: '/alpha/billing/subscriptions',
});
const CLI_VERSION = process.env.COMMANDCODE_CLI_VERSION || '1.54.2';

const SUBSCRIPTION_PLANS = Object.freeze({
  'individual-go': { name: 'Go', monthlyCredits: 10 },
  'individual-goat': { name: 'GOAT', monthlyCredits: 70 },
  'individual-pro': { name: 'Pro', monthlyCredits: 30 },
  'individual-pro-v1': { name: 'Pro', monthlyCredits: 80 },
  'individual-provider': { name: 'Provider', monthlyCredits: 15 },
  'individual-max': { name: 'Max', monthlyCredits: 150 },
  'individual-ultra': { name: 'Ultra', monthlyCredits: 300 },
  'teams-pro': { name: 'Teams Pro', monthlyCredits: 40 },
});
const PLAN_PREFIXES = Object.keys(SUBSCRIPTION_PLANS).sort((a, b) => b.length - a.length);

const CAP_TOLERANCE = 0.25;

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toNumberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatResetAt(timestamp) {
  const ms = toNumber(timestamp, 0);
  if (!ms) return '';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 官方 baseURL 带路径（https://api.commandcode.ai/provider/v1），而 /alpha/*
 * 在主机根路径上。只保留 origin，既纠正路径又保留用户自选主机（如 staging）。
 */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return DEFAULT_API_BASE;
  }
}

function subscriptionPlanInfo(planId) {
  if (typeof planId !== 'string' || planId === '') return undefined;
  const normalized = planId.toLowerCase().replace(/_/g, '-');
  const prefix = PLAN_PREFIXES.find((candidate) => normalized.startsWith(candidate));
  return prefix === undefined ? undefined : SUBSCRIPTION_PLANS[prefix];
}

function parseWindow(block, label) {
  if (!isRecord(block)) return null;
  const used = toNumberOrUndefined(block.used);
  const cap = toNumberOrUndefined(block.cap);
  if (used === undefined && cap === undefined) return null;
  const percent = used !== undefined && cap !== undefined && cap > 0
    ? Math.min(100, (used / cap) * 100)
    : null;
  return {
    key: label,
    label,
    percent,
    used,
    cap,
    exceeded: block.exceeded === true,
    resetsAt: formatResetAt(block.resetAt),
  };
}

function normalizeCommandCodeUsage({ usage, credits, subscription, user }) {
  const creditData = isRecord(credits) && isRecord(credits.credits) ? credits.credits : {};
  const windowLimits = isRecord(credits) && isRecord(credits.windowLimits) ? credits.windowLimits : {};
  const subData = isRecord(subscription) && isRecord(subscription.data) ? subscription.data : {};

  const planId = subData.planId || creditData.planId || '';
  const planInfo = subscriptionPlanInfo(planId);
  const planName = planInfo?.name || planId || 'Command Code';

  const usedCredits = toNumber(usage?.totalCredits, 0);
  const remainingCredits = toNumberOrUndefined(creditData.monthlyCredits);
  // 月度上限 = 已用 + 剩余（两个端点拼出）；计划名义额度做兜底
  const nominal = planInfo?.monthlyCredits;
  const monthlyCap = remainingCredits !== undefined
    ? usedCredits + remainingCredits
    : (nominal ?? 0);

  // 上限与名义额度偏差过大说明跨了账期边界（used/remaining 不同时刻），百分比不可信
  const capSuspect = nominal !== undefined && nominal > 0 && monthlyCap > 0
    && (monthlyCap / nominal < 1 - CAP_TOLERANCE || monthlyCap / nominal > 1 + CAP_TOLERANCE);

  const periods = [];
  const fiveHour = parseWindow(windowLimits.fiveHour, '5 小时窗口');
  const weekly = parseWindow(windowLimits.weekly, '每周窗口');
  if (fiveHour) periods.push(fiveHour);
  if (weekly) periods.push(weekly);

  // 月度窗口：无 5h/周窗口时作为主展示；有则排在后面（前端按 periods 顺序渲染）
  const monthlyPercent = !capSuspect && monthlyCap > 0
    ? Math.min(100, (usedCredits / monthlyCap) * 100)
    : null;
  const monthly = {
    key: 'monthly',
    label: '月度额度',
    percent: monthlyPercent,
    used: usedCredits,
    cap: monthlyCap,
    exceeded: false,
    resetsAt: formatResetAt(subData.currentPeriodEnd ? Date.parse(subData.currentPeriodEnd) : 0),
  };
  if (!periods.length) {
    periods.push(monthly);
  } else if (monthlyPercent !== null) {
    periods.push(monthly);
  }

  const primary = periods[0] || monthly;
  const parts = [];
  if (planInfo && nominal !== undefined) parts.push(`Plan ${planName}（名义 $${nominal}/月）`);
  if (capSuspect) parts.push('额度上限异常，百分比仅供参考');
  if (usage?.totalCount !== undefined) parts.push(`请求 ${toNumber(usage.totalCount, 0).toLocaleString()} 次`);
  if (usage?.periodBasis) parts.push(`统计口径 ${usage.periodBasis}`);

  return {
    planName,
    unit: 'percent',
    total: 100,
    used: primary.percent !== null && primary.percent !== undefined ? primary.percent : 0,
    remaining: primary.percent !== null && primary.percent !== undefined
      ? Math.max(0, 100 - primary.percent)
      : 0,
    periods: periods.map((p) => ({ ...p, percent: p.percent ?? 0 })),
    extra: parts.join(' · '),
    monthly: {
      used: usedCredits,
      remaining: remainingCredits,
      cap: monthlyCap,
      percent: monthlyPercent,
      capSuspect,
      freeCredits: toNumberOrUndefined(creditData.freeCredits),
      purchasedCredits: toNumberOrUndefined(creditData.purchasedCredits),
    },
    totals: {
      requests: toNumberOrUndefined(usage?.totalCount),
      completed: toNumberOrUndefined(usage?.completedCount),
      failed: toNumberOrUndefined(usage?.failedCount),
      tokensIn: toNumberOrUndefined(usage?.totalTokensIn),
      tokensOut: toNumberOrUndefined(usage?.totalTokensOut),
    },
    account: user && typeof user === 'object'
      ? { name: user.name || '', userName: user.userName || '' }
      : null,
  };
}

async function fetchCommandCodeUsage(provider) {
  const apiKey = (getPrimaryApiKey(provider) || '').trim();
  if (!apiKey) throw new Error('未配置 Command Code API Key');
  const apiBase = originOf(provider.base_url || '') || DEFAULT_API_BASE;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'x-command-code-version': CLI_VERSION,
    'x-cli-environment': 'production',
    'User-Agent': 'crewrouter-quota/1.0',
  };

  const getJson = async (pathWithQuery) => {
    const response = await quotaRequest(`${apiBase}${pathWithQuery}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000),
    }, provider);
    const text = await response.text();
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || parsed?.message || parsed?.error || detail;
        if (typeof detail !== 'string') detail = `HTTP ${response.status}`;
      } catch { /* 保留 HTTP 状态码描述 */ }
      throw new Error(`Command Code ${pathWithQuery.split('?')[0]} 查询失败（${detail}）`);
    }
    try { return text ? JSON.parse(text) : {}; } catch {
      throw new Error(`Command Code ${pathWithQuery.split('?')[0]} 响应非 JSON`);
    }
  };

  const [usage, credits, subscription] = await Promise.all([
    getJson(ENDPOINTS.usage),
    getJson(ENDPOINTS.credits),
    getJson(ENDPOINTS.subscription),
  ]);
  return normalizeCommandCodeUsage({ usage, credits, subscription });
}

module.exports = {
  DEFAULT_API_BASE,
  ENDPOINTS,
  SUBSCRIPTION_PLANS,
  CAP_TOLERANCE,
  fetchCommandCodeUsage,
  normalizeCommandCodeUsage,
  parseWindow,
  subscriptionPlanInfo,
  originOf,
};
