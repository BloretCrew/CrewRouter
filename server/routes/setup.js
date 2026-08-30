const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../models/database');
const Logger = require('../logger');
const { getAuthMode, setAuthMode, decodeMode } = require('../utils/auth-mode');
const { normalizeEmail, isUniqueViolation } = require('../utils/user-identity');

/**
 * OOBE：飞书模式创建管理员；PassPort 模式由首次管理员授权完成初始化。
 * 供应商 / 模型 / Team 等在管理后台配置，避免多步向导与 schema 竞态。
 * 数据库建表与迁移必须在服务启动时完成（见 server/index.js startServer）。
 */

// 检查是否需要 OOBE
router.get('/setup/status', async (req, res) => {
  try {
    // 轻量探活：settings 可查且无 setup_complete → 需要初始化账号
    const result = await pool.query("SELECT value FROM settings WHERE key = 'setup_complete'");
    const needsSetup = result.rows.length === 0;
    Logger.info(`[OOBE] status 查询: needsSetup=${needsSetup}`);
    const authModeResult = await pool.query("SELECT value FROM settings WHERE key = 'auth_mode'");
    const authMode = authModeResult.rows[0] ? decodeMode(authModeResult.rows[0].value) : null;
    res.json({ needsSetup, dbReady: true, authMode });
  } catch (error) {
    // settings 表不存在 = 数据库尚未初始化完成
    Logger.warn(`[OOBE] status 失败（数据库可能未就绪）: ${error.message}`);
    res.status(503).json({
      needsSetup: true,
      dbReady: false,
      error: '数据库尚未就绪，请等待服务完成初始化后刷新',
    });
  }
});

// 中间件：仅在 OOBE 未完成时允许访问
async function requireSetupMode(req, res, next) {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'setup_complete'");
    if (result.rows.length > 0) {
      return res.status(403).json({ error: '系统已初始化，无法再次执行 OOBE' });
    }
    next();
  } catch (error) {
    Logger.warn(`[OOBE] requireSetupMode: 数据库未就绪: ${error.message}`);
    return res.status(503).json({ error: '数据库尚未就绪，请稍后重试' });
  }
}

// 首步：选择账号系统模式；setup_complete 写入后不可修改
router.post('/setup/mode', requireSetupMode, async (req, res) => {
  try {
    const mode = await setAuthMode(req.body?.mode);
    res.json({ success: true, authMode: mode });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// 飞书模式：创建管理员并完成 OOBE
router.post('/setup/admin', requireSetupMode, async (req, res) => {
  const { username, email, password } = req.body;
  let normalizedEmail;
  try { normalizedEmail = normalizeEmail(email); } catch (error) { return res.status(400).json({ error: error.message }); }
  const selectedMode = await getAuthMode();
  if (!selectedMode || !['feishu', 'passport'].includes(selectedMode)) {
    return res.status(400).json({ error: '请先选择账号系统模式' });
  }

  if (!username || !username.trim()) {
    return res.status(400).json({ error: '用户名不能为空' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [731946]);

    const bcrypt = require('bcryptjs');
    const passwordHash = bcrypt.hashSync(password, 10);

    const result = await client.query(
      `INSERT INTO users (username, email, password_hash, is_admin, email_verified, balance)
       VALUES ($1, $2, $3, TRUE, TRUE, 999)
       RETURNING id, username, email, is_admin`,
      [username.trim(), normalizedEmail, passwordHash]
    );

    Logger.info(`[OOBE] 管理员账号已创建: ${username}`);
    const adminId = result.rows[0].id;

    // 播种默认注入提示词（忽略 @CrewRouter；失败不阻断注册）
    try {
      const { seedDefaultPrompt } = require('../utils/inject-prompt');
      await seedDefaultPrompt(adminId);
    } catch (e) {
      Logger.warn('[OOBE] 默认注入提示词播种跳过:', e.message);
    }

    // 自动分配默认用户组（SAVEPOINT：失败不污染主事务）
    await client.query('SAVEPOINT sp_default_group');
    try {
      const defGroup = await client.query('SELECT id FROM user_groups WHERE is_default = TRUE LIMIT 1');
      if (defGroup.rows.length > 0) {
        await client.query('UPDATE users SET group_id = $1 WHERE id = $2', [defGroup.rows[0].id, adminId]);
        Logger.info(`[OOBE] 已分配默认用户组 id=${defGroup.rows[0].id}`);
      }
      await client.query('RELEASE SAVEPOINT sp_default_group');
    } catch (groupErr) {
      await client.query('ROLLBACK TO SAVEPOINT sp_default_group');
      Logger.warn('[OOBE] 分配默认用户组跳过:', groupErr.message);
    }

    // 自动创建默认 API Key（与普通 Key 无异，可删除）
    await client.query('SAVEPOINT sp_default_key');
    try {
      const rawKey = `sk-${crypto.randomBytes(24).toString('hex')}`;
      const keyPrefix = rawKey.substring(0, 12);
      await client.query(
        `INSERT INTO api_keys (user_id, key_hash, key_value, key_prefix, name, custom_model_name)
         VALUES ($1, $2, $3, $4, 'CrewRouter', 'claude-fable-5')`,
        [adminId, require('../utils/key-hash').sha256Hex(rawKey), rawKey, keyPrefix]
      );
      await client.query('RELEASE SAVEPOINT sp_default_key');
      Logger.info('[OOBE] 已为管理员创建默认 API Key');
    } catch (keyErr) {
      await client.query('ROLLBACK TO SAVEPOINT sp_default_key');
      Logger.warn('[OOBE] 创建默认 API Key 跳过:', keyErr.message);
    }

    // 自动创建个人账户 Team（SAVEPOINT）
    await client.query('SAVEPOINT sp_personal_team');
    try {
      const teamName = `${username.trim()} 的个人账户`;
      const teamResult = await client.query(
        'INSERT INTO teams (name, description, is_personal) VALUES ($1, $2, TRUE) RETURNING id',
        [teamName, '个人账户，系统自动创建']
      );
      await client.query(
        'INSERT INTO user_teams (user_id, team_id) VALUES ($1, $2)',
        [adminId, teamResult.rows[0].id]
      );
      await client.query('RELEASE SAVEPOINT sp_personal_team');
      Logger.info(`[OOBE] 已为管理员创建个人账户 Team: ${teamName}`);
    } catch (teamErr) {
      await client.query('ROLLBACK TO SAVEPOINT sp_personal_team');
      Logger.warn('[OOBE] 创建个人账户 Team 跳过:', teamErr.message);
    }

    // 标记 OOBE 完成；模式必须先存在且为合法值
    const selected = await client.query("SELECT value FROM settings WHERE key = 'auth_mode' FOR UPDATE");
    if (!selected.rows.length || !decodeMode(selected.rows[0].value)) {
      throw Object.assign(new Error('请先选择账号系统模式'), { code: 'AUTH_MODE_REQUIRED' });
    }
    await client.query(
      "INSERT INTO settings (key, value) VALUES ('setup_complete', $1::jsonb) ON CONFLICT (key) DO NOTHING",
      [JSON.stringify({ completed_at: new Date().toISOString(), method: 'admin-created' })]
    );
    Logger.info('[OOBE] 初始化完成（仅管理员一步）');

    await client.query('COMMIT');
    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) { /* ignore */ }
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: '用户名或邮箱已存在' });
    }
    Logger.error('[OOBE] 创建管理员失败:', error);
    res.status(500).json({ error: '服务器错误: ' + (error.message || '未知') });
  } finally {
    client.release();
  }
});

module.exports = router;
