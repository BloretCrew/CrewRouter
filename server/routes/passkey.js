const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const passkeyManager = require('../utils/PassKey');
const {
  getWebAuthnConfig,
  normalizePasskeys,
  bufferToBase64url,
} = require('../utils/PassKey');
const Logger = require('../logger');

// PassKey 仅更新 passkeys，不创建或修改 users.email；邮箱归一化由实际邮箱写入路径处理。
function buildSessionUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    avatar: user.avatar,
    isAdmin: user.is_admin,
    balance: user.balance,
    refund_balance: user.refund_balance || 0,
    api_signature_enabled: user.api_signature_enabled === true,
    api_signature_template: user.api_signature_template || '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}',
  };
}

function parsePasskeys(raw) {
  return normalizePasskeys(raw);
}

/**
 * 按 credentialID 查找用户（JSONB）
 */
async function findUserByCredentialId(credentialID) {
  if (!credentialID) return null;
  const result = await pool.query(
    `SELECT * FROM users
     WHERE EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(passkeys, '[]'::jsonb)) AS pk
       WHERE pk->>'credentialID' = $1
     )
     LIMIT 1`,
    [credentialID]
  );
  return result.rows[0] || null;
}

/**
 * 从 userHandle（注册时写入的 user.id UTF-8）解析用户
 */
async function findUserByHandle(userHandleBase64url) {
  if (!userHandleBase64url) return null;
  try {
    let base64 = String(userHandleBase64url).replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    if (pad) base64 += '='.repeat(4 - pad);
    const decoded = Buffer.from(base64, 'base64').toString('utf8');
    const userId = Number(decoded);
    if (!Number.isFinite(userId)) return null;
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

// 获取 PassKey 注册选项
router.get('/register/options', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { rpID } = getWebAuthnConfig(req);

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = userResult.rows[0];
    user.passkeys = parsePasskeys(user.passkeys);

    const options = await passkeyManager.getRegistrationOptions(user, {
      rpID,
      excludeCredentials: user.passkeys.map(pk => ({
        id: typeof pk.credentialID === 'string' ? pk.credentialID : bufferToBase64url(pk.credentialID),
        transports: pk.transports,
      })),
    });
    res.json(options);
  } catch (error) {
    Logger.error('[PassKey 注册选项] 错误:', error);
    res.status(500).json({ error: error.message || '获取注册选项失败' });
  }
});

// 验证 PassKey 注册
router.post('/register/verify', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const body = req.body;
    const { rpID, origin } = getWebAuthnConfig(req);

    if (!body || !body.id || !body.response) {
      return res.status(400).json({ error: '无效的注册响应' });
    }

    const newPasskey = await passkeyManager.verifyRegistration(userId, body, { origin, rpID });

    const userResult = await pool.query('SELECT passkeys FROM users WHERE id = $1', [userId]);
    let passkeys = parsePasskeys(userResult.rows[0]?.passkeys);

    // 避免重复 credentialID
    if (passkeys.some(pk => pk.credentialID === newPasskey.credentialID)) {
      return res.status(409).json({ error: '该通行密钥已注册' });
    }

    // 合并客户端 transports（若有）
    if (Array.isArray(body.response?.transports) && body.response.transports.length > 0) {
      newPasskey.transports = body.response.transports;
    }

    passkeys.push(newPasskey);

    await pool.query('UPDATE users SET passkeys = $1::jsonb WHERE id = $2', [
      JSON.stringify(passkeys),
      userId,
    ]);

    Logger.info(`[PassKey 注册] 用户 ${req.session.user.username} 注册了新的 PassKey`);
    res.json({
      success: true,
      passkey: {
        credentialID: newPasskey.credentialID,
        deviceType: newPasskey.deviceType,
        createdAt: newPasskey.createdAt,
      },
    });
  } catch (error) {
    Logger.error('[PassKey 注册验证] 错误:', error);
    res.status(500).json({ error: error.message || '注册验证失败' });
  }
});

// 获取 PassKey 登录选项（公开；username 可选，支持 usernameless）
router.post('/login/options', async (req, res) => {
  try {
    const { username } = req.body || {};
    const { rpID } = getWebAuthnConfig(req);

    let passkeys = [];
    if (username) {
      const normalized = String(username).toLowerCase().trim();
      const userResult = await pool.query(
        'SELECT passkeys FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1 LIMIT 1',
        [normalized]
      );
      if (userResult.rows.length > 0) {
        passkeys = parsePasskeys(userResult.rows[0].passkeys);
      }
    }

    const options = await passkeyManager.getAuthenticationOptions(passkeys, { rpID });
    res.json(options);
  } catch (error) {
    Logger.error('[PassKey 登录选项] 错误:', error);
    res.status(500).json({ error: error.message || '获取登录选项失败' });
  }
});

// 验证 PassKey 登录并建立 session
router.post('/login/verify', async (req, res) => {
  try {
    const { username, body: authBody, challenge } = req.body || {};
    const { rpID, origin } = getWebAuthnConfig(req);

    if (!authBody || !authBody.id || !challenge) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    let user = null;

    if (username) {
      const normalized = String(username).toLowerCase().trim();
      const userResult = await pool.query(
        'SELECT * FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1 LIMIT 1',
        [normalized]
      );
      user = userResult.rows[0] || null;
    }

    // 无用户名：用 credentialID 或 userHandle 反查
    if (!user) {
      user = await findUserByCredentialId(authBody.id);
    }
    if (!user && authBody.response?.userHandle) {
      user = await findUserByHandle(authBody.response.userHandle);
    }

    if (!user) {
      return res.status(401).json({ error: '未找到匹配的通行密钥，请先绑定后使用' });
    }

    let passkeys = parsePasskeys(user.passkeys);
    const passkey = passkeys.find(pk => pk.credentialID === authBody.id);
    if (!passkey) {
      return res.status(401).json({ error: '未找到匹配的 PassKey' });
    }

    if (!passkey.credentialPublicKey) {
      return res.status(401).json({ error: '通行密钥数据损坏，请删除后重新绑定' });
    }

    const verification = await passkeyManager.verifyAuthentication(
      passkey,
      authBody,
      challenge,
      { origin, rpID }
    );

    // 更新 counter
    passkey.counter = verification.newCounter;
    await pool.query('UPDATE users SET passkeys = $1::jsonb WHERE id = $2', [
      JSON.stringify(passkeys),
      user.id,
    ]);

    // 建立会话（与密码登录一致）
    req.session.user = buildSessionUser(user);

    Logger.info(`[PassKey 登录] 用户 ${user.username} 通过 PassKey 登录成功`);

    req.session.save((err) => {
      if (err) {
        Logger.error('[PassKey 登录] Session 保存失败:', err);
        return res.status(500).json({ error: '登录失败，请稍后重试' });
      }
      // 登录状态上报（fire-and-forget）
      require('../utils/login-reporter').reportLoginEvent(req);
      res.json({ success: true, user: req.session.user });
    });
  } catch (error) {
    Logger.error('[PassKey 登录验证] 错误:', error);
    res.status(500).json({ error: error.message || '登录验证失败' });
  }
});

// 删除 PassKey
router.delete('/:credentialID', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { credentialID } = req.params;

    const userResult = await pool.query('SELECT passkeys FROM users WHERE id = $1', [userId]);
    let passkeys = parsePasskeys(userResult.rows[0]?.passkeys);

    const filteredPasskeys = passkeys.filter(pk => pk.credentialID !== credentialID);

    if (filteredPasskeys.length === passkeys.length) {
      return res.status(404).json({ error: '未找到该 PassKey' });
    }

    await pool.query('UPDATE users SET passkeys = $1::jsonb WHERE id = $2', [
      JSON.stringify(filteredPasskeys),
      userId,
    ]);

    Logger.info(`[PassKey 删除] 用户 ${req.session.user.username} 删除了 PassKey`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[PassKey 删除] 错误:', error);
    res.status(500).json({ error: '删除 PassKey 失败' });
  }
});

// 获取用户 PassKey 列表
router.get('/list', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const userResult = await pool.query('SELECT passkeys FROM users WHERE id = $1', [userId]);

    const passkeys = parsePasskeys(userResult.rows[0]?.passkeys);

    const safePasskeys = passkeys.map(pk => ({
      credentialID: pk.credentialID,
      deviceType: pk.deviceType,
      createdAt: pk.createdAt,
    }));

    res.json(safePasskeys);
  } catch (error) {
    Logger.error('[PassKey 列表] 错误:', error);
    res.status(500).json({ error: '获取 PassKey 列表失败' });
  }
});

module.exports = router;
