const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { pool } = require('../models/database');
const Logger = require('../logger');
const {
  getFeishuConfig,
  isFeishuLoginAvailable,
  buildRedirectUri,
  getCachedAppAccessToken,
  setCachedAppAccessToken,
} = require('../utils/feishu-config');
const { reportLoginEvent } = require('../utils/login-reporter');

async function getAppAccessToken() {
  const cached = getCachedAppAccessToken();
  if (cached) {
    return cached;
  }

  const cfg = await getFeishuConfig();
  if (!cfg.appId || !cfg.appSecret) {
    throw new Error('飞书 App ID / App Secret 未配置');
  }

  Logger.info(`[飞书] 正在获取 App Access Token, appId=${cfg.appId.slice(0, 8)}…`);
  const res = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
    { app_id: cfg.appId, app_secret: cfg.appSecret }
  );

  if (res.data.code !== 0) {
    throw new Error(`获取 App Access Token 失败: ${res.data.msg}`);
  }

  setCachedAppAccessToken(res.data.app_access_token, res.data.expire);
  Logger.info('[飞书] App Access Token 获取成功');
  return res.data.app_access_token;
}

// 公开：登录页用于判断是否展示飞书登录按钮
router.get('/feishu/status', async (req, res) => {
  try {
    const available = await isFeishuLoginAvailable();
    const cfg = await getFeishuConfig();
    Logger.info(`[飞书状态] available=${available}, enabled=${cfg.enabled}, hasAppId=${!!cfg.appId}, source=${cfg.source}`);
    res.json({ enabled: available });
  } catch (error) {
    Logger.error('[飞书状态] 查询失败:', error);
    res.json({ enabled: false });
  }
});

// 飞书登录入口
router.get('/feishu', async (req, res) => {
  try {
    const cfg = await getFeishuConfig();
    if (!cfg.enabled || !cfg.appId) {
      Logger.warn(`[飞书登录] 未启用或未配置: enabled=${cfg.enabled}, hasAppId=${!!cfg.appId}, source=${cfg.source}`);
      return res.status(503).json({ error: '飞书登录未启用或未配置' });
    }

    const redirectUri = encodeURIComponent(buildRedirectUri());
    const state = crypto.randomBytes(16).toString('hex');

    req.session.feishuState = state;

    const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?` +
      `app_id=${cfg.appId}&redirect_uri=${redirectUri}&state=${state}`;

    Logger.info(`[飞书登录] 重定向到授权页, state=${state}, redirectUri=${buildRedirectUri()}`);
    req.session.save((err) => {
      if (err) {
        Logger.error('[飞书登录] Session 保存失败:', err);
        return res.redirect('/?error=session_failed');
      }
      res.redirect(authUrl);
    });
  } catch (error) {
    Logger.error('[飞书登录] 入口错误:', error);
    res.status(500).json({ error: '飞书登录暂时不可用' });
  }
});

// 飞书回调
router.get('/feishu/callback', async (req, res) => {
  const { code, state } = req.query;

  Logger.info(`[飞书回调] 收到回调: code=${code ? '有' : '无'}, state=${state}, session_state=${req.session.feishuState}`);

  // 校验 state
  if (!state || state !== req.session.feishuState) {
    Logger.warn(`[飞书回调] State 校验失败: 期望=${req.session.feishuState}, 收到=${state}`);
    return res.redirect('/?error=feishu_state_invalid');
  }
  delete req.session.feishuState;

  if (!code) {
    return res.redirect('/?error=feishu_no_code');
  }

  try {
    const cfg = await getFeishuConfig();
    if (!cfg.enabled || !cfg.appId || !cfg.appSecret) {
      Logger.warn('[飞书回调] 配置已失效或不完整');
      return res.redirect('/?error=feishu_error');
    }

    // 1. 用 code 换取 user access_token
    const appToken = await getAppAccessToken();
    const tokenRes = await axios.post(
      'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token',
      { grant_type: 'authorization_code', code },
      {
        headers: {
          'Authorization': `Bearer ${appToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (tokenRes.data.code !== 0) {
      Logger.error(`[飞书回调] 换取 token 失败: code=${tokenRes.data.code}, msg=${tokenRes.data.msg}`);
      return res.redirect('/?error=feishu_token_failed');
    }

    const accessToken = tokenRes.data.data.access_token;
    Logger.info(`[飞书回调] 获取 access_token 成功`);

    // 2. 获取用户信息
    const userRes = await axios.get(
      'https://open.feishu.cn/open-apis/authen/v1/user_info',
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );

    if (userRes.data.code !== 0) {
      Logger.error(`[飞书回调] 获取用户信息失败: code=${userRes.data.code}, msg=${userRes.data.msg}`);
      return res.redirect('/?error=feishu_userinfo_failed');
    }

    const userInfo = userRes.data.data;
    Logger.info(`[飞书回调] 用户信息: name=${userInfo.name}, open_id=${userInfo.open_id}, tenant=${userInfo.tenant_key}, email=${userInfo.email}`);

    // 如果没有邮箱，尝试通过 contact API 获取
    if (!userInfo.email && userInfo.open_id) {
      try {
        Logger.info(`[飞书回调] 尝试通过 contact API 获取邮箱, open_id=${userInfo.open_id}`);
        const contactRes = await axios.get(
          `https://open.feishu.cn/open-apis/contact/v3/users/${userInfo.open_id}?user_id_type=open_id`,
          { headers: { 'Authorization': `Bearer ${await getAppAccessToken()}` } }
        );
        Logger.info(`[飞书回调] contact API 响应: code=${contactRes.data.code}`);
        if (contactRes.data.code === 0) {
          const contactUser = contactRes.data.data?.user;
          Logger.info(`[飞书回调] contact 用户信息: enterprise_email=${contactUser?.enterprise_email}, email=${contactUser?.email}`);
          if (contactUser?.enterprise_email) {
            userInfo.email = contactUser.enterprise_email;
          } else if (contactUser?.email) {
            userInfo.email = contactUser.email;
          }
        }
      } catch (e) {
        Logger.warn(`[飞书回调] 通过 contact API 获取邮箱失败: ${e.message}`);
      }
    }

    Logger.info(`[飞书回调] 最终用户信息: name=${userInfo.name}, email=${userInfo.email}, tenant=${userInfo.tenant_key}`);

    // 3. 校验 tenant_key（企业隔离）
    if (cfg.tenantKey && userInfo.tenant_key !== cfg.tenantKey) {
      Logger.warn(`[飞书回调] 非企业用户拒绝: ${userInfo.name}, tenant=${userInfo.tenant_key}, expected=${cfg.tenantKey}`);
      return res.redirect('/?error=feishu_not_enterprise');
    }

    // 4. 查找或创建用户
    const feishuOpenId = userInfo.open_id;
    const email = userInfo.email || `${feishuOpenId}@feishu.local`;
    const normalizedEmail = email.toLowerCase().trim();
    const avatar = userInfo.avatar_url || null;

    Logger.info(`[飞书回调] 查找用户: feishu_open_id=${feishuOpenId}, email=${normalizedEmail}`);

    // 先按 feishu_open_id 查找
    let user = null;
    const byOpenId = await pool.query('SELECT * FROM users WHERE feishu_open_id = $1', [feishuOpenId]);
    Logger.info(`[飞书回调] 按 open_id 查询: ${byOpenId.rows.length} 条记录`);
    if (byOpenId.rows.length > 0) {
      user = byOpenId.rows[0];
      // 更新头像和邮箱
      await pool.query(
        'UPDATE users SET avatar = COALESCE($1, avatar), email = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [avatar, normalizedEmail, user.id]
      );
      Logger.info(`[飞书登录] 已有用户登录: ${user.username} (id=${user.id})`);
    } else {
      // 按邮箱查找（可能通过其他方式注册过）
      const byEmail = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
      Logger.info(`[飞书回调] 按邮箱查询: ${byEmail.rows.length} 条记录`);
      if (byEmail.rows.length > 0) {
        user = byEmail.rows[0];
        await pool.query(
          'UPDATE users SET feishu_open_id = $1, avatar = COALESCE($2, avatar), updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [feishuOpenId, avatar, user.id]
        );
        Logger.info(`[飞书登录] 已有用户绑定飞书: ${user.username} (id=${user.id})`);
      } else {
        // 按飞书用户名查找
        const feishuName = userInfo.name || normalizedEmail.split('@')[0];
        const byUsername = await pool.query('SELECT * FROM users WHERE username = $1', [feishuName]);
        Logger.info(`[飞书回调] 按用户名查询: ${byUsername.rows.length} 条记录`);

        if (byUsername.rows.length > 0) {
          // 用户名已存在，需要验证密码后绑定
          req.session.feishuPending = {
            feishuOpenId,
            feishuName,
            email: normalizedEmail,
            avatar,
            existingUserId: byUsername.rows[0].id,
            existingUsername: byUsername.rows[0].username
          };
          Logger.info(`[飞书回调] 用户名 ${feishuName} 已存在，跳转绑定验证页`);
          return res.redirect('/feishu-bind');
        }

        // 用户名不存在，创建新用户
        const newUser = await pool.query(
          `INSERT INTO users (username, email, feishu_open_id, avatar, email_verified, balance)
           VALUES ($1, $2, $3, $4, TRUE, 10) RETURNING *`,
          [feishuName, normalizedEmail, feishuOpenId, avatar]
        );
        user = newUser.rows[0];
        Logger.info(`[飞书注册] 新用户注册: ${feishuName} (email=${normalizedEmail}, id=${user.id})`);

        // 播种默认注入提示词（忽略 @CrewRouter；失败不阻断注册）
        try {
          const { seedDefaultPrompt } = require('../utils/inject-prompt');
          await seedDefaultPrompt(user.id);
        } catch (e) {
          Logger.warn('[飞书注册] 默认注入提示词播种跳过:', e.message);
        }

        // 自动加入默认 Team
        try {
          const defaultTeam = await pool.query('SELECT id FROM teams WHERE is_default = TRUE LIMIT 1');
          if (defaultTeam.rows.length > 0) {
            const teamId = defaultTeam.rows[0].id;
            await pool.query(
              'INSERT INTO user_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT (user_id, team_id) DO NOTHING',
              [user.id, teamId]
            );
            await pool.query(
              'UPDATE users SET team_id = $1 WHERE id = $2 AND team_id IS NULL',
              [teamId, user.id]
            );
            Logger.info(`[飞书注册] 用户 ${feishuName} 已自动加入默认 Team (id=${teamId})`);
          }
        } catch (teamErr) {
          Logger.error('[飞书注册] 自动加入默认 Team 失败:', teamErr);
        }

        // 自动分配默认用户组
        try {
          const defGroup = await pool.query('SELECT id FROM user_groups WHERE is_default = TRUE LIMIT 1');
          if (defGroup.rows.length > 0) {
            await pool.query('UPDATE users SET group_id = $1 WHERE id = $2', [defGroup.rows[0].id, user.id]);
            Logger.info(`[飞书注册] 用户 ${feishuName} 已自动加入默认用户组 (id=${defGroup.rows[0].id})`);
          }
        } catch (groupErr) {
          Logger.error('[飞书注册] 自动分配默认用户组失败:', groupErr);
        }

        // 自动创建默认 API Key（与普通 Key 无异，可删除）
        try {
          const rawKey = `sk-${crypto.randomBytes(24).toString('hex')}`;
          const { sha256Hex } = require('../utils/key-hash');
          const keyHash = sha256Hex(rawKey);
          const keyPrefix = rawKey.substring(0, 12);
          await pool.query(
            `INSERT INTO api_keys (user_id, key_value, key_hash, key_prefix, name, custom_model_name)
             VALUES ($1, $2, $3, $4, 'CrewRouter', 'claude-fable-5')`,
            [user.id, null, keyHash, keyPrefix]
          );
          Logger.info(`[飞书注册] 已为用户 ${feishuName} 创建默认 API Key`);
        } catch (keyErr) {
          Logger.error('[飞书注册] 创建默认 API Key 失败:', keyErr);
        }

        // 自动创建个人账户 Team
        try {
          const teamName = `${feishuName} 的个人账户`;
          const teamResult = await pool.query(
            'INSERT INTO teams (name, description, is_personal) VALUES ($1, $2, TRUE) RETURNING id',
            [teamName, '个人账户，系统自动创建']
          );
          await pool.query(
            'INSERT INTO user_teams (user_id, team_id) VALUES ($1, $2)',
            [user.id, teamResult.rows[0].id]
          );
          Logger.info(`[飞书注册] 已为用户 ${feishuName} 创建个人账户 Team`);
        } catch (teamErr) {
          Logger.error('[飞书注册] 创建个人账户 Team 失败:', teamErr);
        }
      }
    }

    // 重新读取最新用户（含 password_hash）
    const fresh = await pool.query('SELECT * FROM users WHERE id = $1', [user.id]);
    if (fresh.rows.length > 0) {
      user = fresh.rows[0];
    }

    const needsPasswordSetup = user.password_hash == null || user.password_hash === '';

    // 设置 session
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      avatar: user.avatar || avatar,
      isAdmin: user.is_admin,
      balance: parseFloat(user.balance || 0),
      refund_balance: parseFloat(user.refund_balance || 0),
      api_signature_enabled: user.api_signature_enabled === true,
      api_signature_template: user.api_signature_template || '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}',
      needsPasswordSetup,
    };

    req.session.save((err) => {
      if (err) {
        Logger.error('[飞书登录] Session 保存失败:', err);
        return res.redirect('/?error=session_failed');
      }
      // 登录状态上报（fire-and-forget）
      reportLoginEvent(req);
      // 飞书注册/登录且未设置密码 → 强制设密
      if (needsPasswordSetup) {
        Logger.info(`[飞书登录] 用户 ${user.username} 未设置密码，跳转设密页`);
        return res.redirect('/set-password');
      }
      res.redirect('/console');
    });
  } catch (error) {
    Logger.error('[飞书回调] 错误:', error.response?.data || error.message);
    res.redirect('/?error=feishu_error');
  }
});

// 获取待绑定信息（供绑定页面使用）
router.get('/feishu/pending', (req, res) => {
  const pending = req.session.feishuPending;
  if (!pending) {
    return res.status(404).json({ error: '无待绑定信息' });
  }
  res.json({
    feishuName: pending.feishuName,
    existingUsername: pending.existingUsername
  });
});

// 验证密码并绑定飞书
router.post('/feishu/bind', async (req, res) => {
  const pending = req.session.feishuPending;
  if (!pending) {
    return res.status(400).json({ error: '会话已过期，请重新通过飞书登录' });
  }

  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: '请输入密码' });
  }

  try {
    const bcrypt = require('bcryptjs');
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [pending.existingUserId]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = userResult.rows[0];

    if (!user.password_hash) {
      return res.status(400).json({ error: '该账号未设置密码，请联系管理员' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      Logger.warn(`[飞书绑定] 密码验证失败: ${pending.existingUsername}`);
      return res.status(401).json({ error: '密码错误' });
    }

    // 密码正确，绑定飞书
    await pool.query(
      'UPDATE users SET feishu_open_id = $1, avatar = COALESCE($2, avatar), updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [pending.feishuOpenId, pending.avatar, user.id]
    );

    Logger.info(`[飞书绑定] 绑定成功: ${user.username} (id=${user.id})`);

    // 清除 pending
    delete req.session.feishuPending;

    const needsPasswordSetup = user.password_hash == null || user.password_hash === '';

    // 设置 session
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      avatar: user.avatar || pending.avatar,
      isAdmin: user.is_admin,
      balance: parseFloat(user.balance || 0),
      refund_balance: parseFloat(user.refund_balance || 0),
      api_signature_enabled: user.api_signature_enabled === true,
      api_signature_template: user.api_signature_template || '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}',
      needsPasswordSetup,
    };

    req.session.save((err) => {
      if (err) {
        Logger.error('[飞书绑定] Session 保存失败:', err);
        return res.status(500).json({ error: '会话保存失败' });
      }
      // 登录状态上报（fire-and-forget）
      reportLoginEvent(req);
      res.json({
        success: true,
        needsPasswordSetup,
        redirect: needsPasswordSetup ? '/set-password' : '/console',
      });
    });
  } catch (error) {
    Logger.error('[飞书绑定] 错误:', error);
    res.status(500).json({ error: '绑定失败' });
  }
});

module.exports = router;
