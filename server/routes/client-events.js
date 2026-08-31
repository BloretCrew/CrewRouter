/**
 * 客户端事件上报接收端（主站专用，demo 分支不挂载）
 *
 * 各 AI 客户端（Claude Code / Qwen Code / OpenCode / Codex / Grok / Hermes /
 * OpenClaw / DeepSeek Harness）通过统一上报器 cr-report.py 将本地 hook 事件
 * （会话开始/结束、工具调用）POST 到本端点，用于控制台「实时活动」看板。
 *
 * 设计要点：
 *  - 双鉴权：Bearer crh_ 前缀走自有 OAuth access token（middleware/oauth-bearer.js），
 *    其余回落网关 API Key（Authorization: Bearer cr-sk-...）
 *  - harness 必须是 request-source.js 定义的 8 种之一（与用量统计同一套标识）
 *  - 落库失败只记日志、仍返回 ok —— 上报绝不能阻塞客户端工具执行
 *  - 表结构自行 ensure（CREATE TABLE IF NOT EXISTS），不动 init-db.js DDL
 */

const express = require('express');
const { pool } = require('../models/database');
const Logger = require('../logger');
const { HARNESS_SOURCES } = require('../utils/request-source');
const { oauthBearer } = require('../middleware/oauth-bearer');
const { requireAuth } = require('../middleware/auth');
const { createNotification, sendBark } = require('../utils/notifications');

const router = express.Router();

const HARNESS_SET = new Set(HARNESS_SOURCES);
const EVENT_TYPES = new Set([
  'session_start', 'session_end', 'prompt_submit', 'tool_use', 'tool_use_failure',
  'permission_denied', 'notification', 'response_stop', 'response_stop_failure',
  'subagent_start', 'subagent_stop', 'pre_compact', 'post_compact',
]);

// ---------- 事件推送（订阅规则命中 → 站内通知 + Bark） ----------
// 频控：同 (userId, harness, sessionId, event) 60 秒内只推一次（内存即可，重启清零可接受）
const pushRateLimitMap = new Map();
const PUSH_RATE_LIMIT_MS = 60 * 1000;

// 工具名 glob 匹配：'*' 通配任意串，其余字符按字面匹配
function globMatch(pattern, value) {
  const p = String(pattern || '').trim();
  if (!p || p === '*') return true;
  if (!value) return false;
  const regex = new RegExp('^' + p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return regex.test(String(value));
}

async function notifyHookEvent({ userId, harness, event, sessionId, toolName, cwd }) {
  // 总开关关 → 跳过
  const setting = await pool.query(
    'SELECT hook_notify_push_enabled FROM users WHERE id = $1', [userId]
  );
  if (!setting.rows[0] || setting.rows[0].hook_notify_push_enabled !== true) return;


  // 单条 SQL 取全部启用规则，JS 侧逐条匹配
  const rules = await pool.query(
    `SELECT id, harness, event_type, tool_name_pattern FROM hook_notify_rules
      WHERE user_id = $1 AND enabled = TRUE`,
    [userId]
  );
  const matched = (rules.rows || []).find(r =>
    (r.harness === '*' || r.harness === harness) &&
    (r.event_type === '*' || r.event_type === event) &&
    globMatch(r.tool_name_pattern, toolName)
  );
  if (!matched) return;

  // 频控键：无 sessionId 时退化为 (userId, harness, event)
  const rateKey = `${userId}|${harness}|${sessionId || ''}|${event}`;
  const now = Date.now();
  const last = pushRateLimitMap.get(rateKey) || 0;
  if (now - last < PUSH_RATE_LIMIT_MS) return;
  pushRateLimitMap.set(rateKey, now);
  // 防 Map 无界增长：只保留最近 2000 个键
  if (pushRateLimitMap.size > 2000) {
    for (const k of pushRateLimitMap.keys()) {
      pushRateLimitMap.delete(k);
      if (pushRateLimitMap.size <= 1000) break;
    }
  }

  const titleParts = [harness];
  if (event === 'tool_use') titleParts.push(toolName || 'tool_use');
  else titleParts.push(event);
  const bodyParts = [
    sessionId ? `session: ${String(sessionId).slice(0, 24)}` : '',
    toolName ? `tool: ${String(toolName).slice(0, 64)}` : '',
    cwd ? `cwd: ...${String(cwd).slice(-64)}` : '',
  ].filter(Boolean);

  await createNotification(userId, 'hook_event', `[CrewRouter] ${titleParts.join(' · ')}`, bodyParts.join('\n') || event, {
    harness, event, sessionId, toolName,
  });
  await sendBark(userId, `[CrewRouter] ${titleParts.join(' · ')}`, bodyParts.join('\n') || event);
}

// ---------- 建表（懒执行一次） ----------
let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_events (
      id BIGSERIAL PRIMARY KEY,
      api_key_id INTEGER,
      user_id INTEGER,
      harness TEXT NOT NULL,
      event TEXT NOT NULL,
      session_id TEXT,
      tool_name TEXT,
      cwd TEXT,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      payload JSONB DEFAULT '{}'::jsonb
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_events_ts ON client_events (ts DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_client_events_session ON client_events (session_id)`);
  tableReady = true;
}

function strOrNull(v, maxLen = 512) {
  if (typeof v !== 'string' || v.length === 0) return null;
  return v.length > maxLen ? v.slice(0, maxLen) : v;
}

function safeDetail(detail, maxBytes = 8192) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return {};
  const serialized = JSON.stringify(detail);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return detail;
  return {
    truncated: true,
    preview: serialized.slice(0, maxBytes - 64),
  };
}

// ---------- 上报 ----------
// 双鉴权：Bearer crh_ 前缀走自有 OAuth access token，其余回落 API Key 校验
router.post('/', oauthBearer, async (req, res) => {
  const body = req.body || {};
  const harness = strOrNull(body.harness, 64);
  const event = strOrNull(body.event, 32);

  if (!harness || !HARNESS_SET.has(harness)) {
    return res.status(400).json({ ok: false, error: 'invalid harness' });
  }
  if (!event || !EVENT_TYPES.has(event)) {
    return res.status(400).json({ ok: false, error: 'invalid event' });
  }

  try {
    await ensureTable();
    // 控制体积：hook 原始输入可能很大（如 Bash 命令全文），截断保护。
    const payload = safeDetail(body.detail);
    if (body.machine_id) payload.machine_id = strOrNull(body.machine_id, 32);
    if (body.machine_name) payload.machine_name = strOrNull(body.machine_name, 64);
    if (Number.isFinite(Number(body.latency_ms))) payload.latency_ms = Math.max(0, Math.min(600000, Number(body.latency_ms)));
    const eventId = strOrNull(body.event_id, 128);
    // 旧客户端没有 event_id；新客户端用 user/harness/event_id 在应用层去重。
    if (eventId) {
      const existing = await pool.query(
        "SELECT id FROM client_events WHERE user_id = $1 AND harness = $2 AND payload->>'event_id' = $3 LIMIT 1",
        [userId, harness, eventId]
      );
      if (existing.rows.length) return res.json({ ok: true, duplicate: true });
      payload.event_id = eventId;
    }
    await pool.query(
      `INSERT INTO client_events (api_key_id, user_id, harness, event, session_id, tool_name, cwd, ts, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()), $9)`,
      [
        req.apiUser?.keyId || null,
        req.apiUser?.userId || null,
        harness,
        event,
        strOrNull(body.session_id, 128),
        strOrNull(body.tool_name, 128),
        strOrNull(body.cwd, 512),
        typeof body.ts === 'number' ? new Date(body.ts < 1e12 ? body.ts * 1000 : body.ts) : null,
        JSON.stringify(payload),
      ]
    );
  } catch (err) {
    Logger.error('[客户端事件] 落库失败:', err.message);
  }
  // 订阅规则推送：异步执行，失败只记日志，绝不阻塞客户端上报应答
  if (req.apiUser?.userId) {
    notifyHookEvent({
      userId: req.apiUser.userId,
      harness,
      event,
      sessionId: strOrNull(body.session_id, 128),
      toolName: strOrNull(body.tool_name, 128),
      cwd: strOrNull(body.cwd, 512),
    }).catch(err => Logger.warn(`[客户端事件] 事件推送失败: ${err.message}`));
  }
  // 无论落库成败都对客户端返回 ok，避免阻塞其工具流
  res.json({ ok: true });
});

// ---------- 客户端能力与最近事件（只读、最小字段） ----------
function clientEventsAuth(req, res, next) { if (req.session?.user) { req.apiUser = req.apiUser || { userId: req.session.user.id }; return next(); } return oauthBearer(req, res, next); }
router.get('/capabilities', clientEventsAuth, (req, res) => res.json({ helper: { event_schema: 1, events: Array.from(EVENT_TYPES) }, server: { event_schema: 1, remote_tests: true } }));
router.get('/recent-events', clientEventsAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  try { await ensureTable(); const result = await pool.query('SELECT harness, event, session_id, ts FROM client_events WHERE user_id = $1 ORDER BY ts DESC LIMIT $2', [req.apiUser?.userId || null, limit]);
    res.json({ events: result.rows.map(row => ({ harness: row.harness, event: row.event, session: row.session_id ? String(row.session_id).slice(0, 24) : null, time: row.ts })) });
  } catch (err) { Logger.error('[客户端事件] recent 查询失败:', err.message); res.status(500).json({ error: 'query failed' }); }
});

// ---------- 看板：最近窗口内各 harness 活跃度 ----------
router.get('/live', clientEventsAuth, async (req, res) => {
  const windowSec = Math.min(Math.max(parseInt(req.query.window, 10) || 300, 30), 86400);
  try {
    await ensureTable();
    const agg = await pool.query(
      `SELECT harness,
              COUNT(DISTINCT session_id) AS active_sessions,
              COUNT(*) FILTER (WHERE event = 'tool_use') AS tool_calls,
              COUNT(*) FILTER (WHERE event IN ('tool_use_failure','response_stop_failure')) AS failure_count,
              COUNT(*) AS total_events,
              MAX(ts) AS last_event_at,
              AVG(NULLIF((payload->>'latency_ms')::numeric, 0)) AS avg_latency_ms
         FROM client_events
        WHERE user_id = $2 AND ts > now() - ($1 || ' seconds')::interval
        GROUP BY harness`,
      [windowSec, req.apiUser.userId]
    );
    const sessions = await pool.query(
      `SELECT DISTINCT ON (session_id)
              harness, session_id, cwd, tool_name, ts, payload->>'machine_id' AS machine_id, payload->>'machine_name' AS machine_name
         FROM client_events
        WHERE user_id = $2 AND ts > now() - ($1 || ' seconds')::interval AND session_id IS NOT NULL
        ORDER BY session_id, ts DESC`,
      [windowSec, req.apiUser.userId]
    );
    res.json({
      window: windowSec,
      sources: agg.rows.map(row => ({ ...row, failure_count: Number(row.failure_count) || 0, avg_latency_ms: Number(row.avg_latency_ms) || 0, suspected_offline: row.last_event_at ? (Date.now() - new Date(row.last_event_at).getTime() > Math.max(windowSec * 1000, 120000)) : true })),
      machines: sessions.rows.reduce((out, row) => { const id = row.machine_id || `${row.harness}:unknown`; if (!out[id]) out[id] = { id, name: row.machine_name || '未命名机器', harness: row.harness, last_event_at: row.ts, last_session: row.session_id, failure_count: 0, latency_ms: 0, suspected_offline: Date.now() - new Date(row.ts).getTime() > Math.max(windowSec * 1000, 120000) }; return out; }, {}),
      sessions: sessions.rows,
    });
  } catch (err) {
    Logger.error('[客户端事件] live 查询失败:', err.message);
    res.status(500).json({ error: 'query failed' });
  }
});

module.exports = router;
