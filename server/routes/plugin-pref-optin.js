const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const Logger = require('../logger');

const OPTIN_KEY = 'plugin_pref_optin';

async function readOptinUsers() {
  const r = await pool.query('SELECT value FROM settings WHERE key = $1', [OPTIN_KEY]);
  const v = r.rows[0]?.value;
  const users = Array.isArray(v?.users) ? v.users : [];
  return new Set(users.map(Number));
}

// 查询当前用户是否已授权插件读取偏好
router.get('/plugin-pref-optin', requireAuth, async (req, res) => {
  try {
    const users = await readOptinUsers();
    res.json({ optedIn: users.has(Number(req.session.user.id)) });
  } catch (error) {
    Logger.error('[插件偏好授权] 读取失败:', error);
    res.status(500).json({ error: '读取授权状态失败' });
  }
});

// 设置当前用户是否授权插件读取偏好
router.put('/plugin-pref-optin', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.session.user.id);
    const enabled = req.body?.enabled === true;
    const users = await readOptinUsers();
    if (enabled) users.add(userId); else users.delete(userId);
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [OPTIN_KEY, JSON.stringify({ users: [...users] })]
    );
    res.json({ success: true, optedIn: enabled });
  } catch (error) {
    Logger.error('[插件偏好授权] 保存失败:', error);
    res.status(500).json({ error: '保存授权状态失败' });
  }
});

module.exports = router;
