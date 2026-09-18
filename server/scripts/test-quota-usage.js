'use strict';

const assert = require('assert');
const {
  normalizeGrokUsage,
  unwrapGrokUsage,
  parseGrokAuthConfig,
  normalizeExpiresAt,
  isCreditLimitError,
} = require('../utils/grok-usage');
const { normalizeWhamUsage, parseCodexAuthConfig } = require('../utils/codex-usage');
const { isLikelyBlockedOfficialHost, describeNetworkError } = require('../utils/quota-http');

const grokCredits = {
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-08-15T01:09:57.847517+00:00',
      end: '2026-08-22T01:09:57.847517+00:00',
    },
    creditUsagePercent: 3.0,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [
      { product: 'GrokChat', usagePercent: 2.0 },
      { product: 'GrokBuild', usagePercent: 1.0 },
    ],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 1250 },
    history: [
      {
        billingCycle: { year: 2026, month: 7 },
        includedUsed: { val: 5200 },
        onDemandUsed: {},
        totalUsed: { val: 5400 },
      },
    ],
  },
  subscriptionTier: 'SuperGrok Heavy',
};

const unwrapped = unwrapGrokUsage(grokCredits);
assert.strictEqual(unwrapped.creditUsagePercent, 3);
assert.strictEqual(unwrapped.subscriptionTier, 'SuperGrok Heavy');

const legacy = normalizeGrokUsage({
  creditUsagePercent: 12.5,
  currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-08-01T00:00:00Z', end: '2026-08-08T00:00:00Z' },
  prepaidBalance: 10,
});
assert.strictEqual(legacy.currentPercent, 12.5);
assert.strictEqual(legacy.prepaidBalance, 10);

const grok = normalizeGrokUsage(grokCredits);
assert.strictEqual(grok.planName, 'SuperGrok Heavy');
assert.strictEqual(grok.currentPercent, 3);
assert.strictEqual(grok.prepaidBalance, 1250);
assert.strictEqual(grok.periods[0].key, 'current_period');
assert.strictEqual(grok.periods[0].percent, 3);
assert.match(grok.periods[0].label, /每周/);
assert.ok(grok.periods.some((p) => p.key === 'GrokBuild' && p.percent === 1));
// 历史周期：文档结构 billingCycle + 美分金额；无 monthlyLimit 时使用率为 null
const historyPeriod = grok.periods.find((p) => p.historical);
assert.ok(historyPeriod, '应解析出历史周期');
assert.strictEqual(historyPeriod.label, '2026-07');
assert.strictEqual(historyPeriod.percent, null);
assert.strictEqual(historyPeriod.amountCents.total, 5400);

// 遗留字段回退：无 creditUsagePercent 时按 monthlyLimit/used 推导百分比
const legacyOnly = normalizeGrokUsage({
  monthlyLimit: { val: 10000 },
  used: { val: 8800 },
  billingPeriodStart: '2026-08-01T00:00:00Z',
  billingPeriodEnd: '2026-09-01T00:00:00Z',
});
assert.strictEqual(legacyOnly.currentPercent, 88);
assert.strictEqual(legacyOnly.periods[0].percent, 88);
assert.match(legacyOnly.currentPeriod.resetsAt, /2026/);

// PAYG 溢出：包含池 100% 后按按需桶计算有效用量
const payg = normalizeGrokUsage({
  creditUsagePercent: 100,
  onDemandCap: { val: 2000 },
  onDemandUsed: { val: 500 },
});
assert.strictEqual(payg.currentPercent, 25);

// 额度耗尽判定（对应 grok-build is_credit_limit_error）
assert.strictEqual(isCreditLimitError(402, 'anything'), true);
assert.strictEqual(isCreditLimitError(403, 'status 403: run out of credits'), true);
assert.strictEqual(isCreditLimitError(429, 'You ran out of credits'), true);
assert.strictEqual(isCreditLimitError(200, 'status 402 upstream'), true);
assert.strictEqual(isCreditLimitError(403, 'content safety blocked'), false);
assert.strictEqual(isCreditLimitError(500, 'internal server error'), false);

const auth = parseGrokAuthConfig({
  'https://auth.x.ai': {
    key: 'tok',
    user_id: 'user-1',
    refresh_token: 'rt',
    oidc_issuer: 'https://auth.x.ai',
    oidc_client_id: 'client',
    expires_at: '1786795823',
  },
});
assert.strictEqual(auth.accessToken, 'tok');
assert.strictEqual(normalizeExpiresAt('1786795823'), 1786795823000);

const wham = normalizeWhamUsage({
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 12, reset_at: 1786800000, reset_after_seconds: 3600 },
    secondary_window: { used_percent: 40, reset_at: 1787400000, reset_after_seconds: 86400 },
  },
  credits: { has_credits: true, balance: '3' },
});
assert.strictEqual(wham.used, 12);
assert.strictEqual(wham.periods.length, 2);

const codexAuth = parseCodexAuthConfig({
  tokens: { access_token: 'at', refresh_token: 'rt', account_id: 'acc' },
});
assert.strictEqual(codexAuth.accountId, 'acc');

assert.strictEqual(isLikelyBlockedOfficialHost('https://chatgpt.com/backend-api/wham/usage'), true);
assert.strictEqual(isLikelyBlockedOfficialHost('https://cli-chat-proxy.grok.com/v1/billing'), false);

const timeout = describeNetworkError(Object.assign(new Error('fetch failed'), { name: 'TimeoutError' }), 'https://chatgpt.com/backend-api/wham/usage');
assert.match(timeout, /chatgpt.com/);
assert.match(timeout, /代理/);

// ── Command Code GOAT ──
const { normalizeCommandCodeUsage, subscriptionPlanInfo, originOf } = require('../utils/commandcode-usage');

assert.strictEqual(subscriptionPlanInfo('individual-goat').name, 'GOAT');
assert.strictEqual(subscriptionPlanInfo('individual-goat').monthlyCredits, 70);
assert.strictEqual(subscriptionPlanInfo('INDIVIDUAL_PRO_V1').monthlyCredits, 80);
assert.strictEqual(subscriptionPlanInfo('unknown-plan'), undefined);
assert.strictEqual(originOf('https://api.commandcode.ai/provider/v1'), 'https://api.commandcode.ai');
assert.strictEqual(originOf('not a url'), 'https://api.commandcode.ai');

// GOAT 典型响应：usage/credits/subscription 三端点 + 5h/周窗口
const goat = normalizeCommandCodeUsage({
  usage: { totalCredits: 12.5, totalCount: 341, completedCount: 330, failedCount: 11, totalTokensIn: 1000, totalTokensOut: 2000, periodBasis: 'month' },
  credits: {
    credits: { monthlyCredits: 57.73, planId: 'individual-goat', freeCredits: 70, purchasedCredits: 0 },
    windowLimits: {
      fiveHour: { used: 5, cap: 14, exceeded: false, resetAt: 1786800000000 },
      weekly: { used: 20, cap: 35, exceeded: false, resetAt: 1787400000000 },
    },
  },
  subscription: { data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: '2026-09-30T00:00:00Z' } },
  user: { name: 'Tester', userName: 'tester' },
});
assert.strictEqual(goat.planName, 'GOAT');
assert.strictEqual(goat.periods.length, 3);
assert.strictEqual(goat.periods[0].key, '5 小时窗口');
assert.strictEqual(goat.periods[0].percent, 5 / 14 * 100);
assert.strictEqual(goat.periods[1].key, '每周窗口');
assert.strictEqual(goat.periods[1].percent, 20 / 35 * 100);
assert.strictEqual(goat.periods[2].key, 'monthly');
// 月度上限 = 已用 12.5 + 剩余 57.73 = 70.23，与名义 70 偏差在容差内
assert.strictEqual(goat.monthly.cap.toFixed(2), '70.23');
assert.strictEqual(goat.monthly.capSuspect, false);
assert.strictEqual(goat.used, goat.periods[0].percent);
assert.strictEqual(goat.unit, 'percent');
assert.match(goat.extra, /Plan GOAT/);
assert.match(goat.extra, /341/);

// 套餐未知时 planName 回退 planId；monthly 剩余缺失时用名义额度兜底
const fallback = normalizeCommandCodeUsage({
  usage: { totalCredits: 3 },
  credits: { credits: { planId: 'individual-max' }, windowLimits: {} },
  subscription: { data: { planId: 'individual-max' } },
});
assert.strictEqual(fallback.planName, 'Max');
assert.strictEqual(fallback.periods[0].key, 'monthly');
assert.strictEqual(fallback.periods[0].percent, 3 / 150 * 100);
assert.strictEqual(fallback.monthly.cap, 150);

// 跨账期边界：used 与 remaining 拼出的上限偏离名义额度 → capSuspect 且不给月度百分比
const suspect = normalizeCommandCodeUsage({
  usage: { totalCredits: 70 },
  credits: { credits: { monthlyCredits: 70, planId: 'individual-goat' }, windowLimits: {} },
  subscription: { data: { planId: 'individual-goat' } },
});
assert.strictEqual(suspect.monthly.capSuspect, true);
assert.strictEqual(suspect.monthly.percent, null);

// Go 套餐（无 API 权限）特征：全部端点 404 会在 fetch 层抛错，归一化层只处理成功响应
const goPlan = normalizeCommandCodeUsage({
  usage: {},
  credits: { credits: {}, windowLimits: {} },
  subscription: { data: { planId: 'individual-go' } },
});
assert.strictEqual(goPlan.planName, 'Go');
assert.strictEqual(goPlan.periods.length, 1);
assert.strictEqual(goPlan.periods[0].percent, 0);

console.log('command code quota tests passed');
console.log('quota usage tests passed');
