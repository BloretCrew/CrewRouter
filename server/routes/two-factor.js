const express = require('express');
const router = express.Router();
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { pool } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const Logger = require('../logger');

/**
 * 解析 DB 中的 TOTP secret（兼容 JSONB 对象 / 字符串 / 双重 stringify）
 */
function parseTotpSecret(raw) {
  if (!raw) return null;
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // 可能本身就是 base32 字符串
      return { base32: raw };
    }
  }
  // 双重编码：JSONB 里存的是 JSON 字符串
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { base32: value };
    }
  }
  if (value && typeof value === 'object' && value.base32) {
    return value;
  }
  return null;
}

// 生成 2FA 密钥
router.get('/generate', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const userResult = await pool.query(
      'SELECT id, username, two_factor_enabled FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = userResult.rows[0];
    if (user.two_factor_enabled) {
      return res.status(400).json({ error: '双重认证已启用，请先关闭后再重新配置' });
    }

    const secret = speakeasy.generateSecret({
      length: 20,
      name: `CrewRouter (${user.username})`,
      issuer: 'CrewRouter',
    });

    // 仅持久化验证所需字段，避免把多余字段写入 JSONB
    const tempSecret = {
      base32: secret.base32,
      otpauth_url: secret.otpauth_url,
    };

    const dataUrl = await QRCode.toDataURL(secret.otpauth_url);

    // 直接传对象，由 node-pg 序列化为 JSONB
    await pool.query(
      'UPDATE users SET temp_totp_secret = $1::jsonb WHERE id = $2',
      [JSON.stringify(tempSecret), userId]
    );

    res.json({
      secret: secret.base32,
      qrcode: dataUrl,
    });
  } catch (error) {
    Logger.error('[2FA 生成] 错误:', error);
    res.status(500).json({ error: error.message || '生成二维码失败' });
  }
});

// 启用 2FA
router.post('/enable', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const token = String(req.body?.token || req.body?.code || '').replace(/\s/g, '');

    if (!token || !/^\d{6}$/.test(token)) {
      return res.status(400).json({ error: '请输入6位验证码' });
    }

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = userResult.rows[0];

    if (user.two_factor_enabled) {
      return res.status(400).json({ error: '双重认证已启用' });
    }

    const tempSecret = parseTotpSecret(user.temp_totp_secret);
    if (!tempSecret?.base32) {
      return res.status(400).json({ error: '请先点击「启用 2FA」生成二维码' });
    }

    const verified = speakeasy.totp.verify({
      secret: tempSecret.base32,
      encoding: 'base32',
      token,
      window: 1,
    });

    if (!verified) {
      return res.status(400).json({ error: '验证码错误或已过期，请重试' });
    }

    const permanentSecret = { base32: tempSecret.base32 };

    await pool.query(
      `UPDATE users
       SET two_factor_enabled = TRUE,
           totp_secret = $1::jsonb,
           temp_totp_secret = NULL
       WHERE id = $2`,
      [JSON.stringify(permanentSecret), userId]
    );

    Logger.info(`[2FA 启用] 用户 ${user.username} 启用了 2FA`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[2FA 启用] 错误:', error);
    res.status(500).json({ error: error.message || '启用 2FA 失败' });
  }
});

// 禁用 2FA
router.post('/disable', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: '请输入密码' });
    }

    // 获取用户信息
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = userResult.rows[0];
    const bcrypt = require('bcryptjs');

    // 验证密码
    if (!user.password_hash) {
      return res.status(400).json({ error: '该账号需要重置密码' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: '密码错误' });
    }

    // 禁用 2FA
    await pool.query(
      'UPDATE users SET two_factor_enabled = FALSE, totp_secret = NULL WHERE id = $1',
      [userId]
    );

    Logger.info(`[2FA 禁用] 用户 ${user.username} 禁用了 2FA`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[2FA 禁用] 错误:', error);
    res.status(500).json({ error: '禁用 2FA 失败' });
  }
});

// 验证 2FA（用于登录流程）
router.post('/verify', async (req, res) => {
  try {
    const { tempToken, code } = req.body;

    if (!tempToken || !code) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    // 查找临时 token 对应的用户
    const userResult = await pool.query(
      'SELECT * FROM users WHERE id = $1 AND two_factor_enabled = TRUE',
      [tempToken]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: '无效的验证请求' });
    }

    const user = userResult.rows[0];

    const secret = parseTotpSecret(user.totp_secret);
    if (!secret?.base32) {
      return res.status(400).json({ error: '用户 2FA 配置异常' });
    }

    const verified = speakeasy.totp.verify({
      secret: secret.base32,
      encoding: 'base32',
      token: String(code).replace(/\s/g, ''),
      window: 1,
    });

    if (verified) {
      res.json({ success: true, userId: user.id, username: user.username });
    } else {
      res.status(401).json({ error: '验证码错误' });
    }
  } catch (error) {
    Logger.error('[2FA 验证] 错误:', error);
    res.status(500).json({ error: '验证失败' });
  }
});

// 获取 2FA 状态
router.get('/status', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const userResult = await pool.query('SELECT two_factor_enabled FROM users WHERE id = $1', [userId]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    res.json({ enabled: userResult.rows[0].two_factor_enabled });
  } catch (error) {
    Logger.error('[2FA 状态] 错误:', error);
    res.status(500).json({ error: '获取状态失败' });
  }
});

module.exports = router;
