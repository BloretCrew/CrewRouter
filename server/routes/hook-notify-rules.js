/**
 * hook 事件通知订阅规则（挂载于 /api/user，requireAuth）
 *
 * 用户可管理「哪些 harness、哪些事件类型、哪些工具名命中才推送」的订阅规则；
 * 总开关存 users.hook_notify_push_enabled（默认关）。
 * 变更无需失效网关缓存：推送判断在 client-events 写路径实时读库。
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const Logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { HARNESS_SOURCES } = require('../utils/request-source');

const HARNESS_SET = new Set(HARNESS_SOURCES);
const EVENT_TYPE_SET = new Set(['session_start', 'session_end', 'tool_use']);

function userIdOf(req) {
  return req.session && req.session.user ? req.session.user.id : null;
}

function cleanText(v, maxLen) {
  const s = String(v == null ? '' : v).trim();
  return s.slice(0, maxLen);
}

// '*' = 全部；否则必须是 8 种 harness 之一
function normalizeHarness(v) {
  const s = cleanText(v, 64) || '*';
  if (s === '*') return '*';
  return HARNESS_SET.has(s) ? s : null;
}

// '*' | session_start | session_end | tool_use
function normalizeEventType(v) {
  const s = cleanText(v, 32) || '*';
  return EVENT_TYPE_SET.has(s) ? s : null;
}

async function listRules(userId) {
  const result = await pool.query(
    `SELECT id, name, harness, event_type, tool_name_pattern, enabled, created_at
       FROM hook_notify_rules WHERE user_id = $1 ORDER BY id ASC`,
    [userId]
  );
  return result.rows.map(r => ({
    id: r.id,
    name: r.name || '',
    harness: r.harness,
    eventType: r.event_type,
    toolNamePattern: r.tool_name_pattern || '',
    enabled: r.enabled === true,
    createdAt: r.created_at,
  }));
}

router.get('/hook-notify-rules', requireAuth, async (req, res) => {
  try {
    const uid = userIdOf(req);
    const settings = await pool.query(
      'SELECT hook_notify_push_enabled FROM users WHERE id = $1', [uid]
    );
    res.json({
      pushEnabled: settings.rows[0]?.hook_notify_push_enabled === true,
      rules: await listRules(uid),
    });
  } catch (error) {
    Logger.error('[事件通知] 规则列表获取失败:', error.message);
    res.status(500).json({ error: '获取事件通知规则失败' });
  }
});

router.put('/hook-notify-rules/push-enabled', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET hook_notify_push_enabled = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [userIdOf(req), !!(req.body || {}).enabled]
    );
    res.json({ success: true });
  } catch (error) {
    Logger.error('[事件通知] 总开关更新失败:', error.message);
    res.status(500).json({ error: '更新事件通知总开关失败' });
  }
});

router.post('/hook-notify-rules', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const harness = normalizeHarness(body.harness);
    const eventType = normalizeEventType(body.eventType);
    if (!harness) return res.status(400).json({ error: '无效的 harness' });
    if (!eventType) return res.status(400).json({ error: '无效的事件类型' });
    const result = await pool.query(
      `INSERT INTO hook_notify_rules (user_id, name, harness, event_type, tool_name_pattern)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userIdOf(req), cleanText(body.name, 100), harness, eventType, cleanText(body.toolNamePattern, 128)]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    Logger.error('[事件通知] 规则创建失败:', error.message);
    res.status(500).json({ error: '创建规则失败' });
  }
});

router.put('/hook-notify-rules/:id', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    // 属主校验：UPDATE 带 user_id 条件，rowCount=0 即不存在或非本人
    const sets = [];
    const params = [req.params.id, userIdOf(req)];
    if (body.name !== undefined) { params.push(cleanText(body.name, 100)); sets.push(`name = $${params.length}`); }
    if (body.harness !== undefined) {
      const harness = normalizeHarness(body.harness);
      if (!harness) return res.status(400).json({ error: '无效的 harness' });
      params.push(harness); sets.push(`harness = $${params.length}`);
    }
    if (body.eventType !== undefined) {
      const eventType = normalizeEventType(body.eventType);
      if (!eventType) return res.status(400).json({ error: '无效的事件类型' });
      params.push(eventType); sets.push(`event_type = $${params.length}`);
    }
    if (body.toolNamePattern !== undefined) { params.push(cleanText(body.toolNamePattern, 128)); sets.push(`tool_name_pattern = $${params.length}`); }
    if (body.enabled !== undefined) { params.push(!!body.enabled); sets.push(`enabled = $${params.length}`); }
    if (!sets.length) return res.json({ success: true });
    const result = await pool.query(
      `UPDATE hook_notify_rules SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: '规则不存在' });
    res.json({ success: true });
  } catch (error) {
    Logger.error('[事件通知] 规则更新失败:', error.message);
    res.status(500).json({ error: '更新规则失败' });
  }
});

router.delete('/hook-notify-rules/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM hook_notify_rules WHERE id = $1 AND user_id = $2',
      [req.params.id, userIdOf(req)]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: '规则不存在' });
    res.json({ success: true });
  } catch (error) {
    Logger.error('[事件通知] 规则删除失败:', error.message);
    res.status(500).json({ error: '删除规则失败' });
  }
});

module.exports = router;
