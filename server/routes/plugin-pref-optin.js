const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const Logger = require('../logger');

const OPTIN_KEY = 'plugin_pref_optin';

async function readOptinUsers(db = pool, lock = false) {
  const r = await db.query(`SELECT value FROM settings WHERE key = $1${lock ? ' FOR UPDATE' : ''}`, [OPTIN_KEY]);
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Establish a lockable row even when two users are the first to opt in.
      await client.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING',
        [OPTIN_KEY, JSON.stringify({ users: [] })]
      );
      const users = await readOptinUsers(client, true);
      if (enabled) users.add(userId); else users.delete(userId);
      await client.query(
        'UPDATE settings SET value = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE key = $1',
        [OPTIN_KEY, JSON.stringify({ users: [...users] })]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    res.json({ success: true, optedIn: enabled });
  } catch (error) {
    Logger.error('[插件偏好授权] 保存失败:', error);
    res.status(500).json({ error: '保存授权状态失败' });
  }
});

module.exports = router;
