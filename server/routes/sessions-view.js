'use strict';

/**
 * 「会话」Tab 只读视图：把经过网关的客户端会话按逻辑会话聚合展示。
 * 数据源 usage_records（messages/response 全文与 plugin_meta.attribution 归因），纯只读，不改转发。
 * 隐私红线：所有查询强制 WHERE user_id = 当前用户；messages 大字段一律服务端截断，
 * 不提供任何完整原文导出接口。
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const Logger = require('../logger');

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const DEFAULT_PAGE_SIZE = 20;
const DETAIL_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

// 与前端展示一致的上下文压力阈值（复用 /context-pressure 的 128k 保守估算）
const PRESSURE_WINDOW_TOKENS = 131072;
const PRESSURE_WARNING_PCT = 85;
const PRESSURE_CRITICAL_PCT = 93;

// 截断上限（服务端截断，前端只做 escapeHtml 展示）
const LIMIT_TEXT = 2000;
const LIMIT_TOOL_ARGS = 500;
const LIMIT_TOOL_RESULT = 800;
const LIMIT_THINKING = 300;

/** 会话键表达式：优先归因 sessionId，否则回退「key + 小时窗」启发式分桶 */
const SESSION_KEY_SQL = `COALESCE(
  NULLIF(u.plugin_meta->'attribution'->>'sessionId', ''),
  'bucket-' || md5(COALESCE(u.api_key_id::text, 'none') || '|' || to_char(date_trunc('hour', u.created_at), 'YYYY-MM-DD"T"HH24:MI'))
)`;

function daysParam(value) {
  return Math.min(Math.max(parseInt(value, 10) || DEFAULT_DAYS, 1), MAX_DAYS);
}

function pageParams(query, defaultSize) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || defaultSize, 1), MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function truncStr(value, max) {
  if (value == null) return '';
  const str = typeof value === 'string' ? value : String(value);
  return str.length > max ? str.slice(0, max) : str;
}

function pressureLevel(totalTokens) {
  const pct = (Number(totalTokens) || 0) / PRESSURE_WINDOW_TOKENS * 100;
  return pct >= PRESSURE_CRITICAL_PCT ? 'critical' : pct >= PRESSURE_WARNING_PCT ? 'warning' : 'ok';
}

/** content（string | 多模态 blocks 数组 | 对象）→ 可读文本，跳过图片块 */
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const part of content) {
      if (typeof part === 'string') out += `${part}\n`;
      else if (part && typeof part === 'object') {
        if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') continue;
        for (const key of ['text', 'content', 'input_text']) {
          if (typeof part[key] === 'string') { out += `${part[key]}\n`; break; }
        }
      }
    }
    return out;
  }
  try { return JSON.stringify(content); } catch { return ''; }
}

/**
 * 单条转发请求的 messages 数组 → 前端时间线事件流。
 * 识别规则：
 *   role='tool' 或 content 数组含 tool_result 块 → tool_result
 *   assistant 消息里 tool_calls / tool_use 块 → tool_call
 *   reasoning_content 非空 → thinking
 */
function parseMessagesToEvents(messages) {
  const events = [];
  const pendingToolNames = Object.create(null); // tool_call_id → name
  const list = Array.isArray(messages) ? messages : [];

  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const role = String(m.role || '');

    if (role === 'system' || role === 'developer') {
      const text = contentToText(m.content).trim();
      if (text) events.push({ type: 'text', role: 'system', text: truncStr(text, LIMIT_TEXT), truncated: text.length > LIMIT_TEXT });
      continue;
    }

    if (role === 'user') {
      if (Array.isArray(m.content)) {
        // Anthropic 风格：tool_result 块内嵌在 user 消息里
        for (const block of m.content) {
          if (block && block.type === 'tool_result') {
            events.push({
              type: 'tool_result',
              name: block.name || pendingToolNames[block.tool_use_id] || null,
              is_error: block.is_error === true,
              resultPreview: truncStr(contentToText(block.content), LIMIT_TOOL_RESULT),
            });
          }
        }
        const text = m.content
          .filter(b => b && b.type !== 'tool_result')
          .map(b => contentToText(b))
          .join('\n').trim();
        if (text) events.push({ type: 'text', role: 'user', text: truncStr(text, LIMIT_TEXT), truncated: text.length > LIMIT_TEXT });
      } else {
        const text = contentToText(m.content).trim();
        if (text) events.push({ type: 'text', role: 'user', text: truncStr(text, LIMIT_TEXT), truncated: text.length > LIMIT_TEXT });
      }
      continue;
    }

    if (role === 'tool') {
      const toolText = contentToText(m.content);
      const errSniff = /^\s*(Error|ERROR|Traceback|fatal:) /.test(toolText) || m.is_error === true;
      events.push({
        type: 'tool_result',
        name: m.name || pendingToolCallsLookup(m.tool_call_id, pendingToolNames),
        is_error: errSniff,
        resultPreview: truncStr(toolText, LIMIT_TOOL_RESULT),
      });
      continue;
    }

    if (role === 'assistant') {
      if (m.reasoning_content) {
        const raw = String(m.reasoning_content).trim();
        if (raw) events.push({ type: 'thinking', preview: truncStr(raw, LIMIT_THINKING), truncated: raw.length > LIMIT_THINKING });
      }
      const text = contentToText(m.content).replace(/\n+$/, '').trim();
      if (text) {
        events.push({ type: 'text', role: 'assistant', text: truncStr(text, LIMIT_TEXT), truncated: text.length > LIMIT_TEXT });
      }
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block && block.type === 'tool_use') {
            if (block.id) pendingToolNames[block.id] = block.name || 'unknown';
            events.push({
              type: 'tool_call',
              name: block.name || 'unknown',
              argsPreview: truncStr(safeStringify(block.input), LIMIT_TOOL_ARGS),
              argsObj: (block.input && typeof block.input === 'object') ? block.input : null,
            });
          }
        }
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          const name = tc.function?.name || tc.name || 'unknown';
          if (tc.id) pendingToolNames[tc.id] = name;
          const args = tc.function?.arguments ?? tc.arguments ?? tc.input;
          let argsObj = null;
          if (args && typeof args === 'object') argsObj = args;
          else if (typeof args === 'string') { try { argsObj = JSON.parse(args); } catch (_) {} }
          events.push({
            type: 'tool_call',
            name,
            argsPreview: truncStr(typeof args === 'string' ? args : safeStringify(args), LIMIT_TOOL_ARGS),
            argsObj,
          });
        }
      }
      continue;
    }
  }
  return events;
}

function pendingToolCallsLookup(id, map) {
  return (id && map[id]) || null;
}

function safeStringify(value) {
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return ''; }
}

/** 从 messages 的 system 段提取 cwd / 项目目录痕迹（尽力而为） */
function extractCwd(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    const role = m && typeof m === 'object' ? String(m.role || '') : '';
    if (role !== 'system' && role !== 'developer') continue;
    const head = truncStr(contentToText(m && m.content), 4000);
    const patterns = [
      /<cwd>([\s\S]{1,200}?)<\/cwd>/i,
      /[Ww]orking [Dd]irectory[:：]\s*([^\n\r]{1,200})/,
      /当前工作目录[:：]\s*([^\n\r]{1,200})/,
    ];
    for (const pattern of patterns) {
      const matched = head.match(pattern);
      if (matched && matched[1]) return truncStr(matched[1].trim(), 200);
    }
    break; // 只看第一条 system 消息
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /sessions?days=7&source=&page=&pageSize=
// 按逻辑会话聚合（归因 sessionId → 无则回退「key + 小时窗」分桶）
// ---------------------------------------------------------------------------
router.get('/sessions', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const days = daysParam(req.query.days);
  const source = String(req.query.source || '').trim();
  const { page, pageSize, offset } = pageParams(req.query, DEFAULT_PAGE_SIZE);

  try {
    const params = [userId, days];
    let sourceFilter = '';
    if (source) {
      params.push(source);
      sourceFilter = `AND COALESCE(u.request_source, 'unknown') = $${params.length}`;
    }

    const aggregated = await pool.query(`
      WITH agg AS (
        SELECT
          ${SESSION_KEY_SQL} AS session_key,
          (array_agg(u.id ORDER BY u.created_at DESC))[1] AS last_record_id,
          MIN(u.created_at) AS first_seen,
          MAX(u.created_at) AS last_seen,
          COUNT(*)::int AS request_count,
          COALESCE(SUM(u.tokens_used), 0)::bigint AS total_tokens,
          COALESCE(SUM(u.cached_tokens), 0)::bigint AS total_cached_tokens,
          mode() WITHIN GROUP (ORDER BY COALESCE(u.request_source, 'unknown')) AS harness,
          array_agg(DISTINCT u.model_id) FILTER (WHERE u.model_id IS NOT NULL AND u.model_id <> '') AS models
        FROM usage_records u
        WHERE u.user_id = $1
          AND u.created_at >= NOW() - ($2::int * INTERVAL '1 day')
          ${sourceFilter}
        GROUP BY 1
      )
      SELECT session_key, last_record_id, first_seen, last_seen, request_count,
             total_tokens, total_cached_tokens, harness, models,
             COUNT(*) OVER ()::int AS grand_total
      FROM agg
      ORDER BY last_seen DESC
      OFFSET ${offset} LIMIT ${pageSize}
    `, params);

    const rows = aggregated.rows;
    const total = rows.length ? Number(rows[0].grand_total || 0) : 0;

    // 本页会话的最后一条记录 → 工具调用统计 / 最近工具名 / cwd 痕迹。
    // 转发请求带全量历史消息，最后一条记录即覆盖整个会话的累计工具调用。
    const details = new Map();
    if (rows.length) {
      const ids = rows.map(r => r.last_record_id);
      const detailRows = await pool.query(`
        SELECT id,
          (
            SELECT COUNT(*)::int FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(u.messages) = 'array' THEN u.messages ELSE '[]'::jsonb END
            ) e
            WHERE (e->>'role') = 'tool'
          ) AS tool_call_count,
          COALESCE(
            (SELECT e->>'name'
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(u.messages) = 'array' THEN u.messages ELSE '[]'::jsonb END) WITH ORDINALITY t(e, ord)
             WHERE (e->>'role') = 'tool' AND NULLIF(e->>'name', '') IS NOT NULL
             ORDER BY t.ord DESC LIMIT 1),
            (SELECT tc->'function'->>'name'
             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(u.messages) = 'array' THEN u.messages ELSE '[]'::jsonb END) WITH ORDINALITY tm(m, mo),
                  jsonb_array_elements(COALESCE(m->'tool_calls', '[]'::jsonb)) WITH ORDINALITY tt(tc, tn)
             WHERE (m->>'role') = 'assistant' AND NULLIF(tc->'function'->>'name', '') IS NOT NULL
             ORDER BY tm.mo DESC, tt.tn DESC LIMIT 1)
          ) AS last_tool_name,
          (SELECT LEFT(e->>'content', 4000)
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(u.messages) = 'array' THEN u.messages ELSE '[]'::jsonb END) e
           WHERE (e->>'role') IN ('system', 'developer')
           LIMIT 1) AS system_head
        FROM usage_records u
        WHERE u.id = ANY($1::int[])
      `, [ids]);
      // system_head 里补 cwd 提取（content 可能是 blocks 数组，SQL 取不到文本时 Node 兜底）
      const needNodeParse = detailRows.rows.filter(r => !r.last_tool_name || r.tool_call_count === null || r.system_head);
      const parsedById = new Map();
      if (needNodeParse.length) {
        const rawRows = await pool.query(
          'SELECT id, messages FROM usage_records WHERE id = ANY($1::int[])',
          [needNodeParse.map(r => r.id)]
        );
        for (const row of rawRows.rows) parsedById.set(row.id, row.messages);
      }
      for (const row of detailRows.rows) {
        let toolCallCount = Number(row.tool_call_count || 0);
        let lastToolName = row.last_tool_name || null;
        let cwd = null;
        const rawMessages = parsedById.get(row.id);
        if (rawMessages) {
          const events = parseMessagesToEvents(rawMessages);
          if (!row.tool_call_count) {
            toolCallCount = events.filter(e => e.type === 'tool_call').length;
          }
          if (!lastToolName) {
            const calls = events.filter(e => e.type === 'tool_call');
            lastToolName = calls.length ? calls[calls.length - 1].name : null;
          }
          cwd = extractCwd(rawMessages);
        } else if (row.system_head) {
          cwd = extractCwd([{ role: 'system', content: row.system_head }]);
        }
        details.set(row.id, { toolCallCount, lastToolName, cwd });
      }
    }

    const items = rows.map(row => {
      const meta = details.get(row.last_record_id) || {};
      const models = Array.isArray(row.models) ? row.models.slice(0, 10) : [];
      return {
        sessionKey: row.session_key,
        harness: row.harness || 'unknown',
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        requestCount: Number(row.request_count || 0),
        totalTokens: Number(row.total_tokens || 0),
        totalCachedTokens: Number(row.total_cached_tokens || 0),
        models,
        toolCallCount: Number(meta.toolCallCount || 0),
        lastToolName: meta.lastToolName || null,
        cwd: meta.cwd || null,
        pressureLevel: pressureLevel(Number(row.total_tokens || 0)),
      };
    });

    res.json({ days, page, pageSize, total, items });
  } catch (error) {
    Logger.error('[会话列表] 查询错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ---------------------------------------------------------------------------
// GET /sessions/:sessionKey/messages?page=&pageSize=
// 该会话的消息时间线（created_at ASC 分页展开为事件流）
// ---------------------------------------------------------------------------
router.get('/sessions/:sessionKey/messages', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const sessionKey = String(req.params.sessionKey || '').slice(0, 200).trim();
  if (!sessionKey) return res.status(400).json({ error: '缺少 sessionKey' });
  const { page, pageSize, offset } = pageParams(req.query, DETAIL_PAGE_SIZE);

  try {
    const baseWhere = `
      user_id = $1
      AND created_at >= NOW() - INTERVAL '90 days'
      AND ${SESSION_KEY_SQL.replace(/u\./g, '')} = $2
    `;
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM usage_records WHERE ${baseWhere}`,
      [userId, sessionKey]
    );
    const total = Number(countResult.rows[0]?.total || 0);
    if (!total) return res.json({ sessionKey, page, pageSize, total: 0, records: [] });

    const recordsResult = await pool.query(`
      SELECT id, created_at, model_id, tokens_used, cached_tokens, latency_ms,
             COALESCE(request_source, 'unknown') AS request_source,
             messages, response, reasoning_content
      FROM usage_records
      WHERE ${baseWhere}
      ORDER BY created_at ASC
      OFFSET ${offset} LIMIT ${pageSize}
    `, [userId, sessionKey]);

    let prevEvents = null; // 上一条记录的完整事件流（跨页时从缓存恢复）
    const records = recordsResult.rows.map(row => {
      const events = parseMessagesToEvents(row.messages);
      // 列级 reasoning_content（响应侧思考）有而消息流里没有 thinking 时补充
      const reasoningHead = truncStr(String(row.reasoning_content || '').trim(), LIMIT_THINKING);
      if (reasoningHead && !events.some(e => e.type === 'thinking')) {
        events.unshift({ type: 'thinking', preview: reasoningHead, truncated: String(row.reasoning_content).length > LIMIT_THINKING });
      }
      // 响应正文（模型最终回复）作为 assistant 文本事件追加
      const responseText = truncStr(String(row.response || '').trim(), LIMIT_TEXT);
      if (responseText) {
        events.push({ type: 'text', role: 'assistant', text: responseText, truncated: String(row.response).length > LIMIT_TEXT });
      }
      // 跨请求增量去重：客户端每请求重放全量上下文，相邻记录的 events 有长公共前缀。
      // 只保留相对前一条记录新增的尾部事件；完全相同则 events 置空（前端跳过渲染）。
      let newEvents = events;
      if (prevEvents) {
        const ser = (e) => JSON.stringify(e);
        const a = events.map(ser);
        const b = prevEvents.map(ser);
        let common = 0;
        const maxCommon = Math.min(a.length, b.length);
        while (common < maxCommon && a[common] === b[common]) common++;
        // 公共前缀超过一半视为上下文重放，只展示新增尾部；否则保留全量（可能是并行请求）
        if (common >= Math.ceil(a.length / 2) || common === a.length) {
          newEvents = events.slice(common);
        }
      }
      prevEvents = events;

      return {
        id: row.id,
        ts: row.created_at,
        model: row.model_id || null,
        tokens: Number(row.tokens_used || 0),
        cachedTokens: Number(row.cached_tokens || 0),
        latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
        harness: row.request_source,
        eventsCount: events.length,
        events: newEvents,
      };
    });

    res.json({ sessionKey, page, pageSize, total, records });
  } catch (error) {
    Logger.error('[会话详情] 查询错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
