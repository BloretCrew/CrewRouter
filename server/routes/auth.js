const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../models/database');
const Logger = require('../logger');
const { ACTIONS, logAction } = require('../utils/audit-log');
const { reportLoginEvent, reportLogoutEvent } = require('../utils/login-reporter');

const loginRateLimits = new Map();
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function consumeLoginAttempt(key) {
  const now = Date.now();
  const current = loginRateLimits.get(key);
  if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
    loginRateLimits.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= LOGIN_LIMIT) return false;
  current.count += 1;
  return true;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    if (typeof req.session.regenerate !== 'function') return resolve();
    req.session.regenerate(err => err ? reject(err) : resolve());
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [key, item] of loginRateLimits) {
    if (now - item.startedAt >= LOGIN_WINDOW_MS) loginRateLimits.delete(key);
  }
}, LOGIN_WINDOW_MS).unref?.();

// 邮箱格式验证
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// 登录页按账号系统模式读取展示配置
router.get('/status', async (req, res) => {
  try {
    const { getAuthMode } = require('../utils/auth-mode');
    const mode = await getAuthMode();
    const { isFeishuLoginAvailable } = require('../utils/feishu-config');
    res.json({ authMode: mode, feishuEnabled: await isFeishuLoginAvailable() });
  } catch (error) { res.status(503).json({ error: '认证状态暂不可用' }); }
});

// 登录
router.post('/login', async (req, res) => {
  try {
    const { login, email, password } = req.body;
    const loginValue = login || email;

    if (!loginValue || !password) {
      return res.status(400).json({ error: '请提供用户名或邮箱和密码' });
    }

    const rateKey = `${req.ip || 'unknown'}:${String(loginValue).toLowerCase().trim()}`;
    if (!consumeLoginAttempt(rateKey)) {
      return res.status(429).json({ error: '登录尝试过于频繁，请稍后再试' });
    }

    // 统一转小写，不区分大小写
    const normalized = loginValue.toLowerCase().trim();
    const isEmail = isValidEmail(normalized);

    // 查找用户：邮箱匹配或用户名匹配
    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1)',
      [normalized]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: '用户名/邮箱或密码错误' });
    }

    const user = result.rows[0];

    // 检查密码是否存在（兼容旧用户，init-db会自动设置默认密码）
    if (!user.password_hash) {
      return res.status(401).json({ error: '该账号尚未设置密码，请联系管理员' });
    }

    // 验证密码
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: '用户名/邮箱或密码错误' });
    }

    // 检查是否启用了 2FA
    if (user.two_factor_enabled) {
      // 返回需要 2FA 验证的提示，携带用户 ID 用于后续验证
      return res.json({ 
        require2FA: true, 
        userId: user.id,
        message: '需要进行 2FA 验证' 
      });
    }

    // 设置会话
    await regenerateSession(req);
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      avatar: user.avatar,
      isAdmin: user.is_admin,
      balance: user.balance,
      refund_balance: user.refund_balance || 0,
      api_signature_enabled: user.api_signature_enabled === true,
      api_signature_template: user.api_signature_template || '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}'
    };

    Logger.info(`[登录] 用户登录: ${email}`);

    // 异步检查异常登录（不阻塞登录流程）
    const { checkAbnormalLogin } = require('../utils/balance-alert');
    const loginIp = req.ip || req.connection?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    checkAbnormalLogin(user.id, loginIp, userAgent).catch(err => {
      Logger.warn(`[登录] 异常登录检查失败: ${err.message}`);
    });

    req.session.save((err) => {
      if (err) {
        Logger.error('[登录] Session保存失败:', err);
        return res.status(500).json({ error: '登录失败，请稍后重试' });
      }
      logAction({
        userId: user.id,
        username: user.username,
        action: ACTIONS.AUTH_LOGIN,
        resourceType: 'auth',
        description: `用户登录`,
        details: { method: 'password' },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        status: 200,
      });
      // 登录状态上报（fire-and-forget，不阻塞响应）
      reportLoginEvent(req);
      res.json(req.session.user);
    });
  } catch (error) {
    Logger.error('[登录] 错误:', error);
    res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

// 2FA 登录验证
router.post('/login/2fa', async (req, res) => {
  try {
    const { userId, code } = req.body;

    if (!userId || !code) {
      return res.status(400).json({ error: '缺少必要参数' });
    }
    if (!consumeLoginAttempt(`${req.ip || 'unknown'}:2fa:${userId}`)) {
      return res.status(429).json({ error: '验证尝试过于频繁，请稍后再试' });
    }

    // 查找用户
    const result = await pool.query('SELECT * FROM users WHERE id = $1 AND two_factor_enabled = TRUE', [userId]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: '无效的验证请求' });
    }

    const user = result.rows[0];

    // 验证 TOTP（兼容 JSONB 对象 / 字符串 / 双重 stringify）
    const speakeasy = require('speakeasy');
    let secret = user.totp_secret;
    if (typeof secret === 'string') {
      try { secret = JSON.parse(secret); } catch { /* keep */ }
    }
    if (typeof secret === 'string') {
      try { secret = JSON.parse(secret); } catch { secret = { base32: secret }; }
    }
    if (!secret?.base32) {
      return res.status(400).json({ error: '用户 2FA 配置异常' });
    }

    const verified = speakeasy.totp.verify({
      secret: secret.base32,
      encoding: 'base32',
      token: String(code).replace(/\s/g, ''),
      window: 1
    });

    if (!verified) {
      return res.status(401).json({ error: '验证码错误' });
    }

    // 设置会话
    await regenerateSession(req);
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      avatar: user.avatar,
      isAdmin: user.is_admin,
      balance: user.balance,
      refund_balance: user.refund_balance || 0,
      api_signature_enabled: user.api_signature_enabled === true,
      api_signature_template: user.api_signature_template || '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}'
    };

    Logger.info(`[登录] 用户 ${user.username} 通过 2FA 验证登录`);
    req.session.save((err) => {
      if (err) {
        Logger.error('[登录] Session保存失败:', err);
        return res.status(500).json({ error: '登录失败，请稍后重试' });
      }
      logAction({
        userId: user.id,
        username: user.username,
        action: ACTIONS.AUTH_LOGIN_2FA,
        resourceType: 'auth',
        description: `用户通过 2FA 登录`,
        details: { method: '2fa' },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        status: 200,
      });
      // 登录状态上报（fire-and-forget，不阻塞响应）
      reportLoginEvent(req);
      res.json(req.session.user);
    });
  } catch (error) {
    Logger.error('[登录 2FA] 错误:', error);
    res.status(500).json({ error: '验证失败，请稍后重试' });
  }
});

// 登出
router.get('/logout', (req, res) => {
  const user = req.session.user;
  if (user) {
    logAction({
      userId: user.id,
      username: user.username,
      action: ACTIONS.AUTH_LOGOUT,
      resourceType: 'auth',
      description: `用户登出`,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      status: 200,
    });
    // 登出状态上报（fire-and-forget）
    reportLogoutEvent(req);
  }
  req.session.destroy((err) => {
    if (err) {
      Logger.error('[登出] 错误:', err);
    }
    res.redirect('/');
  });
});

function isPasswordMissing(passwordHash) {
  return passwordHash == null || passwordHash === '';
}

// 获取当前用户信息
router.get('/me', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const result = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.session.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: '未登录' });
    }
    const needsPasswordSetup = isPasswordMissing(result.rows[0].password_hash);
    // 同步 session 标记
    if (req.session.user.needsPasswordSetup !== needsPasswordSetup) {
      req.session.user.needsPasswordSetup = needsPasswordSetup;
    }
    res.json({ ...req.session.user, needsPasswordSetup });
  } catch (error) {
    Logger.error('[me] 错误:', error);
    res.json({ ...req.session.user, needsPasswordSetup: !!req.session.user.needsPasswordSetup });
  }
});

/**
 * 首次设置密码（仅当账号尚无 password_hash，例如飞书注册用户）
 */
router.post('/set-password', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ error: '请先登录' });
    }

    const { password, confirmPassword } = req.body || {};
    if (!password || !confirmPassword) {
      return res.status(400).json({ error: '请填写密码并确认' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度至少6位' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: '两次输入的密码不一致' });
    }

    const result = await pool.query('SELECT id, password_hash, email, username FROM users WHERE id = $1', [
      req.session.user.id,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = result.rows[0];
    if (!isPasswordMissing(user.password_hash)) {
      return res.status(400).json({ error: '密码已设置，请使用「修改密码」' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [passwordHash, user.id]
    );

    req.session.user.needsPasswordSetup = false;
    Logger.info(`[设置密码] 用户 ${user.username || user.email} 完成首次密码设置`);

    logAction({
      userId: user.id,
      username: user.username,
      action: ACTIONS.AUTH_SET_PASSWORD,
      resourceType: 'auth',
      description: `首次设置密码`,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      status: 200,
    });

    req.session.save((err) => {
      if (err) {
        Logger.error('[设置密码] Session 保存失败:', err);
        // 密码已写入，仍返回成功
      }
      res.json({ success: true, message: '密码设置成功' });
    });
  } catch (error) {
    Logger.error('[设置密码] 错误:', error);
    res.status(500).json({ error: '设置密码失败，请稍后重试' });
  }
});

// 修改密码
router.post('/change-password', async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!req.session.user) {
      return res.status(401).json({ error: '请先登录' });
    }

    if (!newPassword) {
      return res.status(400).json({ error: '请提供新密码' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: '新密码长度至少6位' });
    }

    // 获取用户信息
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = result.rows[0];

    // 尚无密码：允许直接设置（兼容控制台设置页）
    if (!user.password_hash) {
      const salt = await bcrypt.genSalt(10);
      const newPasswordHash = await bcrypt.hash(newPassword, salt);
      await pool.query(
        'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [newPasswordHash, req.session.user.id]
      );
      req.session.user.needsPasswordSetup = false;
      Logger.info(`[修改密码] 用户 ${req.session.user.email} 首次设置密码`);
      return res.json({ message: '密码设置成功', success: true });
    }

    if (!oldPassword) {
      return res.status(400).json({ error: '请提供旧密码和新密码' });
    }

    const isMatch = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: '旧密码错误' });
    }

    // 更新密码
    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(newPassword, salt);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newPasswordHash, req.session.user.id]);

    Logger.info(`[修改密码] 用户 ${req.session.user.email} 修改了密码`);
    logAction({
      userId: req.session.user.id,
      username: req.session.user.username,
      action: ACTIONS.AUTH_CHANGE_PASSWORD,
      resourceType: 'auth',
      description: `修改密码`,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      status: 200,
    });
    res.json({ message: '密码修改成功' });
  } catch (error) {
    Logger.error('[修改密码] 错误:', error);
    res.status(500).json({ error: '修改密码失败，请稍后重试' });
  }
});

module.exports = router;
