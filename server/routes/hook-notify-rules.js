/**
 * hook 事件通知订阅（挂载于 /api/user，requireAuth）
 *
 * 开关式管理：GET 返回当前勾选状态（harness 集合 + 事件类型集合 + 总开关），
 * PUT /selection 批量保存——全删该用户规则后按勾选笛卡尔积重建
 * （harness='*' 表示全部工具；event_type='*' 表示全部事件）。
 * 匹配逻辑在 client-events.js 写路径（单条规则 AND 匹配 harness+event_type）。
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const Logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { HARNESS_SOURCES } = require('../utils/request-source');

const HARNESS_SET = new Set([...HARNESS_SOURCES, '*']);
const EVENT_TYPE_SET = new Set(['session_start', 'session_end', 'tool_use', '*']);

// GET：返回 pushEnabled + 当前勾选集合（从规则行反推）
router.get('/hook-notify-rules', requireAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const setting = await pool.query(
      'SELECT hook_notify_push_enabled FROM users WHERE id = $1', [uid]);
    const rules = await pool.query(
      `SELECT DISTINCT harness, event_type FROM hook_notify_rules
        WHERE user_id = $1 AND enabled = TRUE`,
      [uid]);
    // 反推勾选集：harness 维度取 event_type='*' 的行；事件维度取 harness='*' 的行；
    // 组合行（都非 *）按各自维度也计入（保守展示）
    const harnesses = new Set();
    const eventTypes = new Set();
    for (const r of rules.rows) {
      if (r.event_type === '*') harnesses.add(r.harness);
      if (r.harness === '*') eventTypes.add(r.event_type);
      if (r.harness !== '*' && r.event_type !== '*') {
        harnesses.add(r.harness); eventTypes.add(r.event_type);
      }
    }
    res.json({
      pushEnabled: setting.rows[0]?.hook_notify_push_enabled === true,
      rules: [],
      selection: { harnesses: [...harnesses], eventTypes: [...eventTypes] },
    });
  } catch (error) {
    Logger.error('[事件通知] 读取失败:', error);
    res.status(500).json({ error: '读取失败' });
  }
});

// PUT 总开关
router.put('/hook-notify-rules/push-enabled', requireAuth, async (req, res) => {
  try {
    const enabled = req.body?.enabled === true;
    await pool.query(
      'UPDATE users SET hook_notify_push_enabled = $2 WHERE id = $1',
      [req.session.user.id, enabled]
    );
    res.json({ success: true, pushEnabled: enabled });
  } catch (error) {
    Logger.error('[事件通知] 更新失败:', error);
    res.status(500).json({ error: '更新失败' });
  }
});

// PUT 勾选集批量保存：{harnesses:[...], eventTypes:[...]}
// 全删重建；harness/eventType 含 '*' 表示全部
router.put('/hook-notify-rules/selection', requireAuth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    let hs = Array.isArray(req.body?.harnesses) ? req.body.harnesses.filter(h => HARNESS_SET.has(h)) : [];
    let ets = Array.isArray(req.body?.eventTypes) ? req.body.eventTypes.filter(e => EVENT_TYPE_SET.has(e)) : [];
    hs = hs.length ? hs : ['*'];
    ets = ets.length ? ets : ['*'];

    await pool.query('BEGIN');
    await pool.query('DELETE FROM hook_notify_rules WHERE user_id = $1', [uid]);
    for (const h of hs) {
      for (const e of ets) {
        await pool.query(
          `INSERT INTO hook_notify_rules (user_id, name, harness, event_type, tool_name_pattern, enabled)
           VALUES ($1, '', $2, $3, '', TRUE)`,
          [uid, h, e]
        );
      }
    }
    await pool.query('COMMIT');
    res.json({ success: true, ruleCount: hs.length * ets.length });
  } catch (error) {
    try { await pool.query('ROLLBACK'); } catch (_) {}
    Logger.error('[事件通知] 保存失败:', error);
    res.status(500).json({ error: '保存失败' });
  }
});

module.exports = router;
