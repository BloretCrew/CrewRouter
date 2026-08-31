'use strict';

const crypto = require('crypto');
const { pool } = require('../models/database');
const Logger = require('../logger');
const { clientMetaFromReq } = require('./request-source');
const { extractRequestIdentity } = require('./session-identity');

const MAX_TEXT = 100000;
function clamp(value, max = MAX_TEXT) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}\n...[已截断]` : text;
}
function json(value) { try { return value == null ? null : JSON.parse(JSON.stringify(value)); } catch (_) { return null; } }
function publicId() { return crypto.randomBytes(6).toString('hex'); }

function requestIdentity(req, payload, meta) {
  if (payload?.identity?.logicalSessionKey) return payload.identity;
  return extractRequestIdentity(req || {}, {
    requestSource: payload?.requestSource || meta?.requestSource,
    attribution: payload?.attribution,
  });
}

/** 只按明确身份键取录制会话；未知身份不得落入最近的会话。 */
async function getActiveSession(keyId, identity = null, options = {}) {
  if (!keyId) return null;
  const params = [keyId];
  let identityWhere = '';
  if (identity?.logicalSessionKey) {
    params.push(identity.logicalSessionKey);
    identityWhere = `AND ts.logical_session_key = $${params.length}`;
  } else if (!options.allowUnattributed) {
    return null;
  } else {
    identityWhere = 'AND ts.logical_session_key IS NULL';
  }
  const r = await pool.query(`
    SELECT ts.* FROM trace_sessions ts
    WHERE ts.api_key_id = $1 AND ts.status = 'recording' ${identityWhere}
    ORDER BY ts.id DESC LIMIT 1`, params);
  return r.rows[0] || null;
}

async function startSession({ userId, keyId, source = 'unknown', userAgent = null, identity = null }) {
  const existing = await getActiveSession(keyId, identity, { allowUnattributed: !identity?.logicalSessionKey });
  if (existing) return existing;
  if (typeof pool.connect !== 'function') throw new Error('数据库连接不可用');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 同一用户、Key、Harness、明确逻辑键只允许一个 recording 会话；不再依赖 api_keys.active_trace_session_id。
    const logicalKey = identity?.logicalSessionKey || null;
    const harness = identity?.harness || source || 'unknown';
    const lookup = await client.query(
      `SELECT * FROM trace_sessions
       WHERE user_id = $1 AND api_key_id = $2 AND request_source = $3
         AND status = 'recording' AND logical_session_key IS NOT DISTINCT FROM $4
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [userId, keyId, harness, logicalKey]
    );
    if (lookup.rows[0]) {
      await client.query('COMMIT');
      return lookup.rows[0];
    }
    const r = await client.query(
      `INSERT INTO trace_sessions
       (public_id,user_id,api_key_id,request_source,user_agent,logical_session_key,client_session_id,parent_session_key,session_id_source,session_confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [publicId(), userId, keyId, harness, userAgent, logicalKey, identity?.sessionId || null,
        identity?.parentSessionKey || null, identity?.sessionIdSource || 'unknown', identity?.confidence || 'unknown']
    );
    // 保留旧字段供旧版报告/命令兼容，但它不再参与带身份请求的选会话。
    if (!logicalKey) {
      await client.query('UPDATE api_keys SET active_trace_session_id = $1 WHERE id = $2', [r.rows[0].id, keyId]);
    }
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

async function endSession(keyId, identity = null) {
  const active = await getActiveSession(keyId, identity, { allowUnattributed: !identity?.logicalSessionKey });
  if (!active) return null;
  if (typeof pool.connect !== 'function') throw new Error('数据库连接不可用');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await client.query(`SELECT COUNT(*)::int requests, COUNT(*) FILTER (WHERE ok)::int succeeded, COUNT(*) FILTER (WHERE NOT ok)::int failed, COALESCE(SUM(tokens_used),0)::bigint tokens, COALESCE(SUM(prompt_tokens),0)::bigint prompt_tokens, COALESCE(SUM(completion_tokens),0)::bigint completion_tokens, COALESCE(SUM(cost),0)::numeric cost, COALESCE(AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL),0)::numeric avg_latency_ms FROM trace_events WHERE session_id = $1`, [active.id]);
    const r = await client.query(`UPDATE trace_sessions SET status='completed',ended_at=CURRENT_TIMESTAMP,summary=$1 WHERE id=$2 RETURNING *`, [JSON.stringify(s.rows[0] || {}), active.id]);
    await client.query('UPDATE api_keys SET active_trace_session_id = NULL WHERE id = $1 AND active_trace_session_id = $2', [keyId, active.id]);
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

async function recordEvent(req, payload = {}) {
  const keyId = req?.apiUser?.keyId || payload.apiKeyId;
  if (!keyId) return null;
  try {
    const meta = clientMetaFromReq(req || {});
    const identity = requestIdentity(req, payload, meta);
    const session = await getActiveSession(keyId, identity);
    if (!session) return null;
    const r = await pool.query(
      `INSERT INTO trace_events (session_id,usage_record_id,logical_session_key,client_session_id,parent_session_key,session_id_source,session_confidence,ok,http_status,error,request_type,request_source,user_agent,ip_address,model_id,provider_id,tokens_used,prompt_tokens,completion_tokens,cached_tokens,weighted_tokens,cost,latency_ms,messages,response,reasoning_content,request_params,finish_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28) RETURNING id`,
      [session.id,payload.usageRecordId || null,identity?.logicalSessionKey || null,identity?.sessionId || null,identity?.parentSessionKey || null,identity?.sessionIdSource || 'unknown',identity?.confidence || 'unknown',payload.ok !== false,payload.httpStatus ?? null,clamp(payload.error,10000),payload.requestType || 'chat',payload.requestSource || meta.requestSource,payload.userAgent || meta.userAgent,payload.ipAddress || null,payload.modelId || null,payload.providerId || null,Number(payload.tokensUsed || 0),Number(payload.promptTokens || 0),Number(payload.completionTokens || 0),Number(payload.cachedTokens || 0),Number(payload.weightedTokens || 0),Number(payload.cost || 0),payload.latencyMs == null ? null : Math.round(payload.latencyMs),json(payload.messages),clamp(payload.response),clamp(payload.reasoningContent),json(payload.requestParams),payload.finishReason || null]
    );
    return r.rows[0];
  } catch (e) { Logger.warn(`[跟踪记录] 写入失败: ${e.message}`); return null; }
}

async function recordUsageEvent(req, usageId) {
  const r = await pool.query('SELECT * FROM usage_records WHERE id = $1', [usageId]);
  const row = r.rows[0];
  if (!row) return null;
  return recordEvent(req, { usageRecordId: row.id, requestType: row.request_type, requestSource: row.request_source, userAgent: row.user_agent, ipAddress: row.ip_address, modelId: row.model_id, providerId: row.provider_id, tokensUsed: row.tokens_used, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens, cachedTokens: row.cached_tokens, weightedTokens: row.weighted_tokens, cost: row.cost, latencyMs: row.latency_ms, messages: row.messages, response: row.response, reasoningContent: row.reasoning_content, requestParams: row.request_params, finishReason: row.finish_reason });
}

module.exports = { getActiveSession, startSession, endSession, recordEvent, recordUsageEvent };
