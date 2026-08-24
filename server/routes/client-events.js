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

const router = express.Router();

const HARNESS_SET = new Set(HARNESS_SOURCES);
const EVENT_TYPES = new Set(['session_start', 'session_end', 'tool_use']);

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
    let payload = {};
    if (body.detail && typeof body.detail === 'object' && !Array.isArray(body.detail)) {
      // 控制体积：hook 原始输入可能很大（如 Bash 命令全文），截断保护
      const s = JSON.stringify(body.detail);
      payload = JSON.parse(s.length > 8192 ? s.slice(0, 8192) : s);
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
  // 无论落库成败都对客户端返回 ok，避免阻塞其工具流
  res.json({ ok: true });
});

// ---------- 看板：最近窗口内各 harness 活跃度 ----------
router.get('/live', requireAuth, async (req, res) => {
  const windowSec = Math.min(Math.max(parseInt(req.query.window, 10) || 300, 30), 86400);
  try {
    await ensureTable();
    const agg = await pool.query(
      `SELECT harness,
              COUNT(DISTINCT session_id) AS active_sessions,
              COUNT(*) FILTER (WHERE event = 'tool_use') AS tool_calls,
              COUNT(*) AS total_events,
              MAX(ts) AS last_event_at
         FROM client_events
        WHERE ts > now() - ($1 || ' seconds')::interval
        GROUP BY harness`,
      [windowSec]
    );
    const sessions = await pool.query(
      `SELECT DISTINCT ON (session_id)
              harness, session_id, cwd, tool_name, ts
         FROM client_events
        WHERE ts > now() - ($1 || ' seconds')::interval AND session_id IS NOT NULL
        ORDER BY session_id, ts DESC`,
      [windowSec]
    );
    res.json({
      window: windowSec,
      sources: agg.rows,
      sessions: sessions.rows,
    });
  } catch (err) {
    Logger.error('[客户端事件] live 查询失败:', err.message);
    res.status(500).json({ error: 'query failed' });
  }
});

module.exports = router;
