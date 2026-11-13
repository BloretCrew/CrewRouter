'use strict';

const { pool } = require('../../models/database');
const {
  getPolicySnapshot,
  resolveSettings,
  isKillSwitchActive,
  applicablePolicies,
  activeExemptions,
} = require('./cache');
const { matchPolicy } = require('./matcher');
const { ACTION_SEVERITY, BLOCKING_ACTIONS } = require('./engine');
const { countRecentFailures } = require('./login-events');

const SCOPE_RANK = { member: 3, team: 2, global: 1 };

function compare(a, b) {
  const severity = (ACTION_SEVERITY[b.action] || 0) - (ACTION_SEVERITY[a.action] || 0);
  if (severity) return severity;
  const scope = (SCOPE_RANK[b.policy.scope_type] || 0) - (SCOPE_RANK[a.policy.scope_type] || 0);
  if (scope) return scope;
  const priority = Number(b.policy.priority || 0) - Number(a.policy.priority || 0);
  if (priority) return priority;
  return Number(a.policy.id || 0) - Number(b.policy.id || 0);
}

/**
 * 登录期策略：在密码/2FA/Passkey 校验通过后、建立会话前调用。
 * 只对包含 login/ips/schedule/identities 等可登录期匹配条件的策略生效。
 */
async function evaluateLoginPolicy({ userId, method = 'password', mfa = false, ip = null, userAgent = null, now = new Date() }) {
  const userResult = await pool.query(
    `SELECT id, team_id, is_admin, tags, policy_bypass, policy_bypass_until
       FROM users WHERE id = $1`,
    [userId]
  );
  if (!userResult.rows.length) return { allowed: false, code: 'invalid_user', message: '用户不存在' };
  const user = userResult.rows[0];
  const bypassUntil = user.policy_bypass_until ? new Date(user.policy_bypass_until).getTime() : null;
  if (user.policy_bypass === true && (!bypassUntil || bypassUntil > now.getTime())) {
    return { allowed: true };
  }
  const snapshot = await getPolicySnapshot();
  const settings = resolveSettings(snapshot, user.team_id);
  if (isKillSwitchActive(settings) || settings.enforcement_mode === 'shadow') return { allowed: true };

  const failedAttempts = await countRecentFailures({
    userId,
    ip,
    minutes: Number(snapshot.globalSettings?.login_window_minutes) || 30,
  }).catch(() => 0);

  const exemptions = activeExemptions(snapshot, { userId, teamId: user.team_id, keyId: null, now });
  const exemptAll = exemptions.some(exemption => exemption.policy_id == null);
  const exemptPolicyIds = new Set(exemptions.filter(exemption => exemption.policy_id != null).map(exemption => Number(exemption.policy_id)));

  const ctx = {
    identity: {
      harness: 'login', protocol: 'login', method: 'POST', path: '/auth/login',
      stream: false, userAgent: userAgent || '',
    },
    request: {
      model: null, modelCandidates: [], maxTokens: null, messageCount: 0, bodyBytes: 0,
      tools: [], mcpServers: [], imageCount: 0, hasAttachments: false,
    },
    semantics: { type: 'primary' },
    session: {},
    actor: {
      userId: user.id,
      teamId: user.team_id,
      isAdmin: user.is_admin === true,
      tags: Array.isArray(user.tags) ? user.tags : [],
    },
    network: { ip },
    login: { method, mfa: !!mfa, failedAttempts },
    now,
    getPromptCorpus: () => '',
  };

  const decisions = [];
  for (const policy of applicablePolicies(snapshot, { userId, teamId: user.team_id, now })) {
    if (policy.effect !== 'deny') continue;
    if (exemptAll || exemptPolicyIds.has(Number(policy.id))) continue;
    const conditions = { ...(policy._compiled || policy.conditions || {}) };
    const loginCondition = conditions.login;
    delete conditions.login;
    if (loginCondition) {
      const methodOk = !Array.isArray(loginCondition.methods) || !loginCondition.methods.length
        || loginCondition.methods.includes(method);
      const mfaOk = loginCondition.require_mfa !== true || mfa === true;
      const failedOk = loginCondition.max_failed_attempts == null
        || failedAttempts < Number(loginCondition.max_failed_attempts);
      // 登录条件描述的是“合规要求”；全部满足时不构成拒绝。
      if (methodOk && mfaOk && failedOk) continue;
    }
    const hasAnyCondition = Object.keys(conditions).some(key => !key.startsWith('_'));
    if (!hasAnyCondition && !loginCondition) continue;
    const result = hasAnyCondition
      ? await matchPolicy({ ...policy, _compiled: conditions }, ctx, {})
      : { match: true };
    if (!result.match) continue;
    decisions.push({
      policy,
      action: policy.action,
      options: policy.action_options || {},
      message: policy.message_template || `登录被团队策略「${policy.name}」拦截`,
      code: policy.category === 'identity' ? 'policy_login_blocked' : 'policy_blocked',
    });
  }
  if (settings.allowlist_dimensions?.includes('ips')) {
    const allowPolicies = applicablePolicies(snapshot, { userId, teamId: user.team_id, now })
      .filter(policy => policy.effect === 'allow' && policy.conditions?.ips);
    let covered = false;
    for (const policy of allowPolicies) {
      const result = await matchPolicy(policy, ctx, {});
      if (result.match) { covered = true; break; }
    }
    if (!covered) {
      return {
        allowed: false,
        code: 'policy_allowlist_miss',
        message: '登录 IP 不在团队允许范围内',
        failedAttempts,
      };
    }
  }

  if (!decisions.length) return { allowed: true, failedAttempts };
  decisions.sort(compare);
  const chosen = decisions[0];
  if (!BLOCKING_ACTIONS.has(chosen.action)) return { allowed: true, policy: chosen.policy, failedAttempts };
  return {
    allowed: false,
    policy: { id: chosen.policy.id, name: chosen.policy.name },
    code: chosen.code,
    message: chosen.message,
    failedAttempts,
  };
}

module.exports = { evaluateLoginPolicy };
