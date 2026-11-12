'use strict';

const net = require('net');
const { pool } = require('../../models/database');
const Logger = require('../../logger');

const MAX_BATCH = 500;
const FLUSH_INTERVAL_MS = 1000;
const queue = [];
let timer = null;
let flushing = false;

function safeIp(value) {
  const ip = String(value || '').replace(/^::ffff:/, '');
  return net.isIP(ip) ? ip : null;
}

const BLOCKING_ACTIONS = new Set(['block', 'custom', 'suspend', 'revoke_key', 'approval', 'step_up']);

function rowFromDecision(signals, decision, { requestId, resolvedModel, providerId, statusCode } = {}) {
  const policy = decision.policy || {};
  return {
    policy_id: policy.id || null,
    policy_name: policy.name || null,
    policy_version: policy.version || null,
    effect: policy.id ? (policy.effect || 'deny') : 'deny',
    action: decision.action || 'block',
    decision: BLOCKING_ACTIONS.has(decision.action) ? 'block' : 'allow',
    scope_type: policy.scope_type || null,
    scope_id: policy.scope_id || null,
    team_id: signals.actor?.teamId || null,
    user_id: signals.actor?.userId || null,
    api_key_id: signals.actor?.keyId || null,
    request_source: signals.identity?.harness || null,
    request_semantics: signals.semantics?.type || null,
    protocol: signals.identity?.protocol || null,
    requested_model: signals.request?.model || null,
    resolved_model: resolvedModel || null,
    provider_id: providerId || null,
    ip: safeIp(signals.network?.ip),
    user_agent: signals.identity?.userAgent || null,
    method: signals.identity?.method || null,
    path: signals.identity?.path || null,
    status_code: statusCode || decision.statusCode || null,
    reason: decision.code || null,
    matched_conditions: JSON.stringify(decision.reasons ? { reasons: decision.reasons } : {}),
    request_id: requestId || null,
    eval_ms: null,
    metadata: JSON.stringify({
      allowlist_misses: decision.allowlistMisses || [],
      original_action: decision.originalAction || null,
    }),
  };
}

function recordHit(row) {
  if (!row) return;
  queue.push(row);
  if (queue.length >= MAX_BATCH) void flush();
  else schedule();
}

function recordDecisionHits(signals, finalDecision, context = {}) {
  if (!finalDecision) return;
  const decisions = Array.isArray(finalDecision.decisions) && finalDecision.decisions.length
    ? finalDecision.decisions
    : [finalDecision];
  for (let index = 0; index < decisions.length && index < 10; index += 1) {
    const decision = decisions[index];
    const effective = index === 0 && finalDecision.action
      ? { ...decision, action: finalDecision.action }
      : decision;
    const row = rowFromDecision(signals, effective, {
      ...context,
      statusCode: index === 0 ? (context.statusCode || finalDecision.statusCode) : decision.statusCode,
    });
    row.eval_ms = finalDecision.evalMs || null;
    recordHit(row);
  }
}

function recordSuspensionHit(signals, { requestId, reason, until } = {}) {
  recordHit({
    policy_id: null,
    policy_name: null,
    policy_version: null,
    effect: 'deny',
    action: 'block',
    decision: 'block',
    scope_type: null,
    scope_id: null,
    team_id: signals?.actor?.teamId || null,
    user_id: signals?.actor?.userId || null,
    api_key_id: signals?.actor?.keyId || null,
    request_source: signals?.identity?.harness || null,
    request_semantics: signals?.semantics?.type || null,
    protocol: signals?.identity?.protocol || null,
    requested_model: signals?.request?.model || null,
    resolved_model: null,
    provider_id: null,
    ip: safeIp(signals?.network?.ip),
    user_agent: signals?.identity?.userAgent || null,
    method: signals?.identity?.method || null,
    path: signals?.identity?.path || null,
    status_code: 403,
    reason: reason || 'member_suspended',
    matched_conditions: '{}',
    request_id: requestId || null,
    eval_ms: null,
    metadata: JSON.stringify({ suspended_until: until || null }),
  });
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
  timer.unref?.();
}

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    await pool.query(
      `INSERT INTO policy_hits (
         policy_id, policy_name, policy_version, effect, action, decision,
         scope_type, scope_id, team_id, user_id, api_key_id,
         request_source, request_semantics, protocol, requested_model, resolved_model, provider_id,
         ip, user_agent, method, path, status_code, reason, matched_conditions,
         request_id, eval_ms, metadata
       )
       SELECT policy_id, policy_name, policy_version, effect, action, decision,
              scope_type, scope_id, team_id, user_id, api_key_id,
              request_source, request_semantics, protocol, requested_model, resolved_model, provider_id,
              NULLIF(ip, '')::inet, user_agent, method, path, status_code, reason,
              COALESCE(matched_conditions::jsonb, '{}'::jsonb) AS matched_conditions,
              request_id, eval_ms, COALESCE(metadata::jsonb, '{}'::jsonb) AS metadata
       FROM jsonb_to_recordset($1::jsonb) AS x(
         policy_id int, policy_name text, policy_version int, effect text, action text, decision text,
         scope_type text, scope_id int, team_id int, user_id int, api_key_id int,
         request_source text, request_semantics text, protocol text, requested_model text,
         resolved_model text, provider_id text, ip text, user_agent text, method text, path text,
         status_code int, reason text, matched_conditions text, request_id text, eval_ms int, metadata text
       )`,
      [JSON.stringify(batch.map(row => ({ ...row, matched_conditions: row.matched_conditions || '{}', metadata: row.metadata || '{}' })))]
    );
  } catch (error) {
    Logger.warn(`[策略] 写入命中记录失败: ${error.message}`);
  } finally {
    flushing = false;
    if (queue.length) schedule();
  }
}

module.exports = { recordHit, recordDecisionHits, recordSuspensionHit, flush, rowFromDecision, safeIp };
