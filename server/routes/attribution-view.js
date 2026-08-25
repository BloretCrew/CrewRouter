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

// ---------- 任务树视图 ----------
//
// 归因层 attribution = {sessionId, parentThreadId, thread_id, subagent, isCompaction, source[], harness}
// 树结构：parentThreadId 为根节点，sessionId/thread_id 为子节点；无父子的独立会话作为单节点树。
// 仅统计有归因的记录（plugin_meta->'attribution'），属主校验与现有路由一致。

function taskTreeKeyOf(row) {
  return row.parent_thread_id || row.session_id || row.thread_id || '未归因';
}

router.get('/task-tree', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const days = daysParam(req.query.days);
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(NULLIF(u.plugin_meta->'attribution'->>'parentThreadId', ''), '') AS parent_thread_id,
        COALESCE(NULLIF(u.plugin_meta->'attribution'->>'sessionId', ''), '') AS session_id,
        COALESCE(NULLIF(u.plugin_meta->'attribution'->>'thread_id', ''), '') AS thread_id,
        COALESCE(u.plugin_meta->'attribution'->>'harness', '') AS harness,
        COALESCE(u.plugin_meta->'attribution'->>'subagent', '') AS subagent,
        u.tokens_used,
        u.created_at
      FROM usage_records u
      WHERE u.user_id = $1
        AND u.created_at >= NOW() - ($2::int * INTERVAL '1 day')
        AND u.plugin_meta ? 'attribution'
      ORDER BY u.created_at ASC
    `, [userId, days]);

    // 按根 key 分组，组内再按 child key（sessionId/thread_id）聚合子代理明细
    const rootMap = new Map();
    for (const row of result.rows) {
      const rootKey = taskTreeKeyOf(row);
      let root = rootMap.get(rootKey);
      if (!root) {
        root = {
          taskKey: rootKey,
          rootLabel: '',
          children: new Map(),
          totals: { requests: 0, tokens: 0 },
          earliest: null,
        };
        rootMap.set(rootKey, root);
      }

      const childKey = row.session_id || row.thread_id || rootKey;
      let child = root.children.get(childKey);
      if (!child) {
        child = { sessionId: childKey, requestCount: 0, totalTokens: 0, lastSeen: null, subagents: new Set() };
        root.children.set(childKey, child);
      }

      child.requestCount += 1;
      child.totalTokens += Number(row.tokens_used || 0);
      if (!child.lastSeen || row.created_at > child.lastSeen) child.lastSeen = row.created_at;
      if (row.subagent) child.subagents.add(row.subagent);

      root.totals.requests += 1;
      root.totals.tokens += Number(row.tokens_used || 0);
      if (!root.earliest || row.created_at < root.earliest.created_at) root.earliest = row;
    }

    const payload = [];
    for (const root of rootMap.values()) {
      const children = [...root.children.values()].map(c => ({
        sessionId: c.sessionId,
        requestCount: c.requestCount,
        totalTokens: c.totalTokens,
        lastSeen: c.lastSeen,
        subagent: [...c.subagents].sort().filter(Boolean).join('、') || '',
      }));
      const earliest = root.earliest;
      const label = [earliest.harness, earliest.created_at ? new Date(earliest.created_at).toLocaleString('zh-CN', { hour12: false }) : '']
        .filter(Boolean).join(' · ');
      payload.push({
        taskKey: root.taskKey,
        rootLabel: label || root.taskKey,
        children,
        totals: { requests: root.totals.requests, tokens: root.totals.tokens },
      });
    }

    res.json({ days, taskTree: payload });
  } catch (error) {
    Logger.error('[任务树聚合] 查询错误:', error);
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
