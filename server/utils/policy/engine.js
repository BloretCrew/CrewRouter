'use strict';

const crypto = require('crypto');
const {
  getPolicySnapshot,
  resolveSettings,
  isKillSwitchActive,
  applicablePolicies,
  activeExemptions,
} = require('./cache');
const { matchPolicy, hasConditionDimension } = require('./matcher');
const runtime = require('./runtime-store');
const { queryUsage } = require('./usage');
const concurrency = require('./concurrency');

const ACTION_SEVERITY = Object.freeze({
  revoke_key: 100,
  suspend: 95,
  block: 90,
  custom: 80,
  approval: 78,
  step_up: 76,
  queue: 70,
  throttle: 65,
  downgrade: 55,
  warn: 40,
  notify: 30,
  shadow: 10,
  allow: 0,
});
const BLOCKING_ACTIONS = new Set(['block', 'custom', 'suspend', 'revoke_key', 'approval', 'step_up']);
const SCOPE_RANK = { member: 3, team: 2, global: 1 };

function severityOf(action) {
  return ACTION_SEVERITY[action] ?? 0;
}

function compareDecisions(a, b) {
  const bySeverity = severityOf(b.action) - severityOf(a.action);
  if (bySeverity) return bySeverity;
  const byScope = (SCOPE_RANK[b.policy?.scope_type] || 0) - (SCOPE_RANK[a.policy?.scope_type] || 0);
  if (byScope) return byScope;
  const byPriority = Number(b.policy?.priority || 0) - Number(a.policy?.priority || 0);
  if (byPriority) return byPriority;
  return Number(a.policy?.id || 0) - Number(b.policy?.id || 0);
}

function rolloutHash(policyId, userId) {
  return parseInt(crypto.createHash('sha256').update(`${policyId}:${userId}`).digest('hex').slice(0, 8), 16) % 100;
}

function inRollout(policy, userId) {
  const percent = Number(policy.rollout_percent);
  if (!Number.isFinite(percent) || percent >= 100) return true;
  if (percent <= 0) return false;
  return rolloutHash(policy.id, userId) < percent;
}

function fillTemplate(template, values) {
  let text = String(template || '');
  for (const [key, value] of Object.entries(values)) {
    text = text.split(`{${key}}`).join(String(value == null ? '' : value));
  }
  return text;
}

function buildMessage(policy, signals, allowlistMisses) {
  const values = {
    policy: policy?.name || '',
    client: signals.identity?.harness || 'unknown',
    model: signals.request?.model || '',
    user: signals.actor?.username || '',
    reason: policy?.description || '',
  };
  if (policy?.message_template) {
    const custom = fillTemplate(policy.message_template, values);
    if (custom.trim()) return custom.trim();
  }
  if (allowlistMisses?.length) {
    return `请求未匹配团队白名单维度：${allowlistMisses.join(', ')}`;
  }
  if (policy?.category === 'usage') {
    return `请求已超过团队策略「${policy.name}」的用量上限`;
  }
  return `请求被团队策略「${policy?.name || '未命名策略'}」拦截`;
}

function codeFor(policy, allowlistMisses) {
  if (allowlistMisses?.length) return 'policy_allowlist_miss';
  if (policy?.category === 'usage') return 'policy_usage_limit';
  if (policy?.action === 'queue') return 'policy_queue_full';
  return 'policy_blocked';
}

function statusFor(policy, allowlistMisses) {
  if (allowlistMisses?.length) return 403;
  if (policy?.category === 'usage') return 429;
  if (policy?.action === 'queue') return 429;
  return policy?.status_code || 403;
}

function subjectForSignals(signals) {
  return { type: 'user', id: signals.actor?.userId };
}

function exemptionReason(exemption, policyId) {
  if (exemption.policy_id == null) return true;
  return Number(exemption.policy_id) === Number(policyId);
}

function noteExemptionUse(exemptionId) {
  const { pool } = require('../../models/database');
  pool.query('UPDATE policy_exemptions SET used_count = used_count + 1 WHERE id = $1', [exemptionId])
    .catch(() => {});
}

async function evaluatePolicies(signals, deps = {}) {
  const started = Date.now();
  const base = {
    outcome: 'allow',
    blocked: false,
    action: null,
    originalAction: null,
    severity: 0,
    statusCode: null,
    code: null,
    message: null,
    policy: null,
    decisions: [],
    allowlistMisses: [],
    exemptionsApplied: [],
    settings: null,
    trace: [],
    evalMs: 0,
    modelQueueOverride: null,
    effectiveRateLimits: null,
  };
  const userId = signals.actor?.userId;
  const teamId = signals.actor?.teamId;
  if (!userId || !teamId) return base;

  const snapshot = await (deps.getSnapshot || getPolicySnapshot)();
  const settings = resolveSettings(snapshot, teamId);
  base.settings = settings;
  if (isKillSwitchActive(settings)) {
    return { ...base, evalMs: Date.now() - started, trace: [{ reason: 'kill_switch' }] };
  }

  const now = signals.now instanceof Date ? signals.now : new Date();
  const bypassUntil = signals.actor?.policyBypassUntil ? new Date(signals.actor.policyBypassUntil).getTime() : null;
  if (signals.actor?.policyBypass && (!bypassUntil || bypassUntil > now.getTime())) {
    return { ...base, evalMs: Date.now() - started, trace: [{ reason: 'member_bypass' }] };
  }

  const exemptions = activeExemptions(snapshot, { userId, teamId, keyId: signals.actor?.keyId, now })
    .filter(exemption => exemption.policy_id == null || snapshot.policies.some(policy => exemptionReason(exemption, policy.id)));
  const exemptAll = exemptions.some(exemption => exemption.policy_id == null);
  const exemptPolicyIds = new Set(exemptions.filter(e => e.policy_id != null).map(e => Number(e.policy_id)));
  if (exemptAll) {
    base.exemptionsApplied = exemptions.map(e => e.id);
    return { ...base, evalMs: Date.now() - started, trace: [{ reason: 'exemption_all' }] };
  }

  const matchDeps = {
    queryUsage: deps.queryUsage || queryUsage,
    getConcurrency: deps.getConcurrency || concurrency.getActive,
  };
  const policies = applicablePolicies(snapshot, { userId, teamId, now })
    .filter(policy => !exemptPolicyIds.has(Number(policy.id)))
    .filter(policy => inRollout(policy, userId));

  const decisions = [];
  const allowPolicies = [];
  for (const policy of policies) {
    const result = await matchPolicy(policy, signals, matchDeps);
    if (signals.trace) base.trace.push({ policyId: policy.id, name: policy.name, match: result.match, reasons: result.reasons });
    if (!result.match) continue;
    if (policy.effect === 'allow') {
      allowPolicies.push(policy);
      continue;
    }
    let action = policy.action;
    let options = policy.action_options || {};
    if (Array.isArray(policy.ladder) && policy.ladder.length) {
      const hits = runtime.record(policy.id, subjectForSignals(signals), options.ladder_window_seconds || 300);
      const tier = runtime.ladderAction(policy.ladder, hits);
      if (tier) {
        action = tier.action;
        options = tier.options || {};
      }
    }
    decisions.push({
      policy,
      action,
      severity: severityOf(action),
      options,
      reasons: result.reasons,
      statusCode: statusFor(policy, []),
      code: codeFor(policy, []),
      message: buildMessage(policy, signals, []),
    });
  }

  if (exemptions.length) {
    base.exemptionsApplied = exemptions.map(e => e.id);
  }

  // 白名单维度
  const misses = [];
  for (const dimension of settings.allowlist_dimensions || []) {
    const candidates = allowPolicies.filter(policy => hasConditionDimension(policy.conditions, dimension));
    const covered = candidates.length > 0;
    if (!covered) misses.push(dimension);
  }
  if (misses.length) {
    decisions.push({
      policy: null,
      action: 'block',
      severity: severityOf('block'),
      options: {},
      reasons: ['allowlist_miss'],
      statusCode: 403,
      code: 'policy_allowlist_miss',
      message: buildMessage(null, signals, misses),
    });
  }

  if (!decisions.length) {
    return { ...base, evalMs: Date.now() - started };
  }

  decisions.sort(compareDecisions);
  const enforcementShadow = settings.enforcement_mode === 'shadow';
  const chosen = decisions[0];
  const originalAction = chosen.action;
  const finalAction = enforcementShadow ? 'shadow' : originalAction;
  const blocked = !enforcementShadow && BLOCKING_ACTIONS.has(originalAction);
  let modelQueueOverride = null;
  if (!enforcementShadow && originalAction === 'downgrade') {
    const target = String(chosen.options?.downgrade_to || '').trim();
    if (target) modelQueueOverride = [target];
  }
  let effectiveRateLimits = null;
  if (!enforcementShadow && chosen.options && (chosen.options.rpm || chosen.options.tpm)) {
    effectiveRateLimits = {
      rpm: Number(chosen.options.rpm) || null,
      tpm: Number(chosen.options.tpm) || null,
    };
  }

  return {
    ...base,
    outcome: 'deny',
    blocked,
    action: finalAction,
    originalAction,
    severity: chosen.severity,
    statusCode: blocked ? chosen.statusCode : (originalAction === 'queue' ? 429 : null),
    code: chosen.code,
    message: chosen.message,
    policy: chosen.policy ? {
      id: chosen.policy.id,
      name: chosen.policy.name,
      scope_type: chosen.policy.scope_type,
      scope_id: chosen.policy.scope_id,
      version: chosen.policy.version,
      category: chosen.policy.category,
    } : null,
    decisions,
    allowlistMisses: misses,
    exemptionsApplied: base.exemptionsApplied,
    modelQueueOverride,
    effectiveRateLimits,
    evalMs: Date.now() - started,
  };
}

module.exports = {
  evaluatePolicies,
  ACTION_SEVERITY,
  BLOCKING_ACTIONS,
  buildMessage,
  codeFor,
  statusFor,
  inRollout,
};
