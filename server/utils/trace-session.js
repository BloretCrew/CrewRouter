'use strict';

const crypto = require('crypto');
const { pool } = require('../models/database');
const Logger = require('../logger');
const { clientMetaFromReq } = require('./request-source');

const MAX_TEXT = 100000;
function clamp(value, max = MAX_TEXT) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}\n...[已截断]` : text;
}
function json(value) { try { return value == null ? null : JSON.parse(JSON.stringify(value)); } catch (_) { return null; } }
function publicId() { return crypto.randomBytes(6).toString('hex'); }

async function getActiveSession(keyId) {
  if (!keyId) return null;
  const r = await pool.query(`SELECT ts.* FROM trace_sessions ts JOIN api_keys ak ON ak.active_trace_session_id = ts.id WHERE ak.id = $1 AND ts.status = 'recording' LIMIT 1`, [keyId]);
  return r.rows[0] || null;
}

async function startSession({ userId, keyId, source = 'unknown', userAgent = null }) {
  const existing = await getActiveSession(keyId);
  if (existing) return existing;
  if (typeof pool.connect !== 'function') throw new Error('数据库连接不可用');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`INSERT INTO trace_sessions (public_id,user_id,api_key_id,request_source,user_agent) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [publicId(), userId, keyId, source, userAgent]);
    await client.query('UPDATE api_keys SET active_trace_session_id = $1 WHERE id = $2 AND active_trace_session_id IS NULL', [r.rows[0].id, keyId]);
    await client.query('COMMIT');
    return (await getActiveSession(keyId)) || r.rows[0];
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

async function endSession(keyId) {
  const active = await getActiveSession(keyId);
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
    const session = await getActiveSession(keyId);
    if (!session) return null;
    const meta = clientMetaFromReq(req || {});
    const r = await pool.query(`INSERT INTO trace_events (session_id,usage_record_id,ok,http_status,error,request_type,request_source,user_agent,ip_address,model_id,provider_id,tokens_used,prompt_tokens,completion_tokens,cached_tokens,weighted_tokens,cost,latency_ms,messages,response,reasoning_content,request_params,finish_reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`, [session.id,payload.usageRecordId || null,payload.ok !== false,payload.httpStatus ?? null,clamp(payload.error,10000),payload.requestType || 'chat',payload.requestSource || meta.requestSource,payload.userAgent || meta.userAgent,payload.ipAddress || null,payload.modelId || null,payload.providerId || null,Number(payload.tokensUsed || 0),Number(payload.promptTokens || 0),Number(payload.completionTokens || 0),Number(payload.cachedTokens || 0),Number(payload.weightedTokens || 0),Number(payload.cost || 0),payload.latencyMs == null ? null : Math.round(payload.latencyMs),json(payload.messages),clamp(payload.response),clamp(payload.reasoningContent),json(payload.requestParams),payload.finishReason || null]);
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
