'use strict';

const { pool } = require('../../models/database');
const Logger = require('../../logger');
const { recordHit } = require('./hit-recorder');

let lastScannedId = 0;

function matchOutput(text, condition) {
  if (!text || !condition) return null;
  const corpus = String(text).slice(0, 200000);
  if (Array.isArray(condition.contains) && condition.contains.length) {
    const hit = condition.contains.find(word => corpus.toLowerCase().includes(String(word).toLowerCase()));
    if (hit) return { type: 'contains', value: hit };
  }
  if (Array.isArray(condition.regex)) {
    for (const pattern of condition.regex) {
      try {
        const re = new RegExp(pattern, 'i');
        if (re.test(corpus)) return { type: 'regex', value: pattern };
      } catch (_) { /* ignore */ }
    }
  }
  return null;
}

/**
 * 扫描最近写入的响应内容，匹配 conditions.output。
 * 输出策略为事后告警（action=warn），不改变已发送的响应。
 */
async function scanOutputPolicies({ limit = 200, sinceMinutes = 10 } = {}) {
  const policies = await pool.query(
    `SELECT * FROM access_policies
      WHERE enabled = TRUE AND status = 'published'
        AND conditions ? 'output'
      ORDER BY priority DESC, id ASC`
  );
  if (!policies.rows.length) return { scanned: 0, matched: 0 };
  const rows = await pool.query(
    `SELECT u.id, u.user_id, u.api_key_id, u.request_source, u.requested_model, u.response, u.created_at,
            uu.team_id
       FROM usage_records u LEFT JOIN users uu ON uu.id = u.user_id
      WHERE u.id > $1 AND u.response IS NOT NULL
        AND u.created_at >= NOW() - ($2::int * INTERVAL '1 minute')
      ORDER BY u.id ASC LIMIT $3`,
    [lastScannedId, Math.max(1, sinceMinutes), Math.min(1000, Math.max(1, limit))]
  );
  let matched = 0;
  for (const row of rows.rows) {
    lastScannedId = Math.max(lastScannedId, Number(row.id));
    for (const policy of policies.rows) {
      if (policy.scope_type === 'team' && Number(policy.scope_id) !== Number(row.team_id)) continue;
      if (policy.scope_type === 'member' && Number(policy.scope_id) !== Number(row.user_id)) continue;
      const condition = policy.conditions?.output;
      const hit = matchOutput(row.response, condition);
      if (!hit) continue;
      matched += 1;
      recordHit({
        policy_id: policy.id,
        policy_name: policy.name,
        policy_version: policy.version,
        effect: 'deny',
        action: 'warn',
        decision: 'allow',
        scope_type: policy.scope_type,
        scope_id: policy.scope_id,
        team_id: row.team_id || null,
        user_id: row.user_id || null,
        api_key_id: row.api_key_id || null,
        request_source: row.request_source || null,
        request_semantics: null,
        protocol: null,
        requested_model: row.requested_model || null,
        resolved_model: null,
        provider_id: null,
        ip: null,
        user_agent: null,
        method: null,
        path: null,
        status_code: null,
        reason: 'output_match',
        matched_conditions: JSON.stringify({ output: hit }),
        request_id: null,
        eval_ms: null,
        metadata: JSON.stringify({ usage_id: row.id, output_match: hit }),
      });
    }
  }
  if (matched) Logger.warn(`[策略] 输出内容策略命中 ${matched} 次`);
  return { scanned: rows.rows.length, matched };
}

function resetOutputScanCursor() {
  lastScannedId = 0;
}

module.exports = { scanOutputPolicies, matchOutput, resetOutputScanCursor };
