'use strict';

const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const Logger = require('../logger');

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const MAX_GROUPS = 100;
const MAX_DETAILS = 100;

function daysParam(value) {
  return Math.min(Math.max(parseInt(value, 10) || DEFAULT_DAYS, 1), MAX_DAYS);
}

function groupKey(row) {
  return row.task_id || '未归因';
}

router.get('/task-groups', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const days = daysParam(req.query.days);
  const taskId = String(req.query.taskId || '').trim();
  try {
    const params = [userId, days];
    let taskFilter = '';
    if (taskId) {
      params.push(taskId);
      taskFilter = `AND COALESCE(
        NULLIF(u.plugin_meta->'attribution'->>'parentThreadId', ''),
        NULLIF(u.plugin_meta->'attribution'->>'thread_id', ''),
        NULLIF(u.plugin_meta->'attribution'->>'sessionId', ''),
        '未归因'
      ) = $${params.length}`;
    }
    const groups = await pool.query(`
      SELECT
        COALESCE(
          NULLIF(u.plugin_meta->'attribution'->>'parentThreadId', ''),
          NULLIF(u.plugin_meta->'attribution'->>'thread_id', ''),
          NULLIF(u.plugin_meta->'attribution'->>'sessionId', ''),
          '未归因'
        ) AS task_id,
        COUNT(*)::int AS requests,
        COALESCE(SUM(u.tokens_used), 0)::bigint AS total_tokens,
        MIN(u.created_at) AS first_seen,
        MAX(u.created_at) AS last_seen,
        COUNT(DISTINCT u.model_id)::int AS model_count,
        COUNT(*) FILTER (WHERE COALESCE((u.plugin_meta->'attribution'->>'subagent') <> '', FALSE))::int AS subagent_count,
        COUNT(*) FILTER (WHERE COALESCE((u.plugin_meta->'attribution'->>'isCompaction')::boolean, FALSE))::int AS compaction_count
      FROM usage_records u
      WHERE u.user_id = $1
        AND u.created_at >= NOW() - ($2::int * INTERVAL '1 day')
        ${taskFilter}
      GROUP BY 1
      ORDER BY last_seen DESC
      LIMIT ${MAX_GROUPS}
    `, params);

    const payload = groups.rows.map(row => ({
      taskId: groupKey(row),
      requests: Number(row.requests || 0),
      totalTokens: Number(row.total_tokens || 0),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      modelCount: Number(row.model_count || 0),
      subagentCount: Number(row.subagent_count || 0),
      compactionCount: Number(row.compaction_count || 0),
    }));

    if (!taskId) return res.json({ days, groups: payload });

    const detailParams = [userId, days, taskId];
    const details = await pool.query(`
      SELECT u.id, u.created_at, u.model_id, u.tokens_used, u.prompt_tokens, u.completion_tokens,
             u.cached_tokens, u.request_type, COALESCE(u.request_source, 'unknown') AS request_source,
             COALESCE((u.plugin_meta->'attribution'->>'subagent') <> '', FALSE) AS is_subagent,
             COALESCE((u.plugin_meta->'attribution'->>'isCompaction')::boolean, FALSE) AS is_compaction
      FROM usage_records u
      WHERE u.user_id = $1
        AND u.created_at >= NOW() - ($2::int * INTERVAL '1 day')
        AND COALESCE(
          NULLIF(u.plugin_meta->'attribution'->>'parentThreadId', ''),
          NULLIF(u.plugin_meta->'attribution'->>'thread_id', ''),
          NULLIF(u.plugin_meta->'attribution'->>'sessionId', ''),
          '未归因'
        ) = $3
      ORDER BY u.created_at DESC
      LIMIT ${MAX_DETAILS}
    `, detailParams);
    res.json({ days, groups: payload, taskId, requests: details.rows });
  } catch (error) {
    Logger.error('[逻辑任务聚合] 查询错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.get('/context-pressure', requireAuth, async (req, res) => {
  const sessionId = String(req.query.sessionId || '').trim();
  if (!sessionId) return res.json({ pressureLevel: 'ok', estimatedWindowPct: 0, suggestion: '暂无会话标识，继续当前对话即可。' });
  try {
    const result = await pool.query(`
      SELECT COALESCE(SUM(tokens_used), 0)::bigint AS tokens, COUNT(*)::int AS requests
      FROM usage_records
      WHERE user_id = $1
        AND created_at >= NOW() - INTERVAL '7 days'
        AND COALESCE(
          NULLIF(plugin_meta->'attribution'->>'parentThreadId', ''),
          NULLIF(plugin_meta->'attribution'->>'thread_id', ''),
          NULLIF(plugin_meta->'attribution'->>'sessionId', '')
        ) = $2
    `, [req.session.user.id, sessionId]);
    const row = result.rows[0] || {};
    const tokens = Number(row.tokens || 0);
    if (!tokens) return res.json({ pressureLevel: 'ok', estimatedWindowPct: 0, suggestion: '暂无足够用量数据，继续当前对话即可。' });
    // 保守按 128k 窗口估算；实际供应商窗口可能更大或更小。
    const estimatedWindowPct = Math.min(100, Number((tokens / 131072 * 100).toFixed(1)));
    const pressureLevel = estimatedWindowPct >= 93 ? 'critical' : estimatedWindowPct >= 85 ? 'warning' : 'ok';
    const suggestion = pressureLevel === 'critical'
      ? '建议立即压缩或开启新会话，避免下一次请求超出上下文窗口。'
      : pressureLevel === 'warning'
        ? '建议尽快总结当前对话，必要时开启新会话。'
        : '当前上下文压力可接受。';
    res.json({ pressureLevel, estimatedWindowPct, suggestion, requests: Number(row.requests || 0) });
  } catch (error) {
    Logger.error('[上下文压力] 查询错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
