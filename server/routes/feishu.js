const express = require('express');
const router = express.Router();
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
const { normalizeEmail, isUniqueViolation } = require('../utils/user-identity');
const { loadPersistedEdition } = require('../utils/instance-edition');
const { pinnedAxiosRequest } = require('../utils/pinned-axios');
const { ACTIONS, logAction } = require('../utils/audit-log');

const FEISHU_STATE_TTL_MS = 10 * 60 * 1000;
const BIND_TTL_MS = 5 * 60 * 1000;
const BIND_ATTEMPT_LIMIT = 5;
const BIND_WINDOW_MS = 15 * 60 * 1000;
const bindingAttempts = new Map();
setInterval(() => {
  for (const [key, value] of bindingAttempts) {
    if (value.expiresAt <= Date.now()) bindingAttempts.delete(key);
  }
}, BIND_WINDOW_MS).unref?.();

const saveSession = (req) => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
const regenerateSession = (req) => new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));

async function discardFailedLogin(req) {
  const failedSession = req.session;
  delete req.session;
  if (!failedSession) return;
  delete failedSession.user;
  await new Promise(resolve => {
    const done = error => {
      if (error) Logger.warn('[飞书登录] 失败会话清理失败:', error.code || error.name || 'unknown');
      resolve();
    };
    try { failedSession.destroy(done); } catch (error) { done(error); }
  });
}

function configurationHash(cfg) {
  return crypto.createHash('sha256').update(JSON.stringify([cfg.appId, cfg.appSecret, cfg.tenantKey || ''])).digest('hex');
}

async function feishuMethodEnabled() {
  const { metadata } = require('../utils/instance-edition');
  const edition = await loadPersistedEdition(pool) || require('../config-loader').edition || 'personal';
  return metadata(edition, { runtime: process.env.CR_RUNTIME || 'server', authMode: await require('../utils/auth-mode').getAuthMode() }).auth.methods.includes('feishu');
}

function pendingBinding(req) {
  const pending = req.session?.feishuPending;
  if (!pending || typeof pending.feishuOpenId !== 'string' || !pending.feishuOpenId
      || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= Date.now()
      || !Number.isInteger(pending.attempts) || pending.attempts >= BIND_ATTEMPT_LIMIT) {
    if (req.session) delete req.session.feishuPending;
    return null;
  }
  return pending;
}

function consumeBindingAttempt(req, userId) {
  const key = `${req.ip || 'unknown'}:${userId}`;
  let entry = bindingAttempts.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (!entry && bindingAttempts.size >= 10000) return false;
    entry = { count: 0, expiresAt: Date.now() + BIND_WINDOW_MS };
    bindingAttempts.set(key, entry);
  }
  if (entry.count >= BIND_ATTEMPT_LIMIT) return false;
  entry.count += 1;
  return true;
}

function bindingTotpValid(user, code) {
  if (!user.two_factor_enabled) return true;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  let secret = user.totp_secret;
  for (let i = 0; i < 2 && typeof secret === 'string'; i++) {
    try { secret = JSON.parse(secret); } catch { secret = { base32: secret }; }
  }
  if (!secret || typeof secret.base32 !== 'string' || !secret.base32) return false;
  return require('speakeasy').totp.verify({ secret: secret.base32, encoding: 'base32', token: code, window: 1 });
}

async function requestBinding(req, res, user, identity, cfg) {
  if (user.feishu_open_id && user.feishu_open_id !== identity.feishuOpenId) {
    return res.redirect('/?error=feishu_conflict');
  }
  await regenerateSession(req);
  req.session.feishuPending = {
    ...identity, existingUserId: user.id, existingUsername: user.username,
    requiresTwoFactor: user.two_factor_enabled === true,
    configurationHash: configurationHash(cfg),
    expiresAt: Date.now() + BIND_TTL_MS, attempts: 0,
  };
  await saveSession(req);
  return res.redirect('/feishu-bind');
}

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
  const res = await pinnedAxiosRequest(
    'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
    {
      method: 'POST',
      data: { app_id: cfg.appId, app_secret: cfg.appSecret },
    }
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
    const { metadata } = require('../utils/instance-edition');
    const edition = await loadPersistedEdition(pool) || require('../config-loader').edition || 'personal';
    const mode = await require('../utils/auth-mode').getAuthMode();
    if (!metadata(edition, { runtime: process.env.CR_RUNTIME || 'server', authMode: mode }).auth.methods.includes('feishu')) {
      return res.status(403).json({ error: '当前实例不支持飞书登录', type: 'auth_method_disabled' });
    }
    const cfg = await getFeishuConfig();
    if (!cfg.enabled || !cfg.appId) {
      Logger.warn(`[飞书登录] 未启用或未配置: enabled=${cfg.enabled}, hasAppId=${!!cfg.appId}, source=${cfg.source}`);
      return res.status(503).json({ error: '飞书登录未启用或未配置' });
    }

    const redirectUriValue = buildRedirectUri(req);
    const redirectUri = encodeURIComponent(redirectUriValue);
    const state = crypto.randomBytes(16).toString('hex');

    req.session.feishuState = state;
    req.session.feishuStateExpiresAt = Date.now() + FEISHU_STATE_TTL_MS;
    req.session.feishuStateConfiguration = configurationHash(cfg);

    const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?` +
      `app_id=${cfg.appId}&redirect_uri=${redirectUri}&state=${state}`;

    Logger.info(`[飞书登录] 重定向到授权页, redirectUri=${redirectUriValue}`);
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

  // 校验 state
  if (typeof state !== 'string' || !state || state !== req.session.feishuState
      || !Number.isFinite(req.session.feishuStateExpiresAt) || req.session.feishuStateExpiresAt <= Date.now()) {
    Logger.warn('[飞书回调] State 校验失败');
    return res.redirect('/?error=feishu_state_invalid');
  }
  const stateConfiguration = req.session.feishuStateConfiguration;
  delete req.session.feishuState;
  delete req.session.feishuStateExpiresAt;
  delete req.session.feishuStateConfiguration;

  if (typeof code !== 'string' || !code || code.length > 4096) {
    return res.redirect('/?error=feishu_no_code');
  }

  try {
    await saveSession(req);
    if (!await feishuMethodEnabled()) return res.redirect('/?error=feishu_disabled');
    const cfg = await getFeishuConfig();
    if (!cfg.enabled || !cfg.appId || !cfg.appSecret) {
      Logger.warn('[飞书回调] 配置已失效或不完整');
      return res.redirect('/?error=feishu_error');
    }
    if (stateConfiguration !== configurationHash(cfg)) return res.redirect('/?error=feishu_state_invalid');

    // 1. 用 code 换取 user access_token
    const appToken = await getAppAccessToken();
    const tokenRes = await pinnedAxiosRequest(
      'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token',
      {
        method: 'POST',
        data: { grant_type: 'authorization_code', code },
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
    const userRes = await pinnedAxiosRequest(
      'https://open.feishu.cn/open-apis/authen/v1/user_info',
      { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}` } }
    );

    if (userRes.data.code !== 0) {
      Logger.error(`[飞书回调] 获取用户信息失败: code=${userRes.data.code}, msg=${userRes.data.msg}`);
      return res.redirect('/?error=feishu_userinfo_failed');
    }

    const userInfo = userRes.data.data;
    const feishuOpenId = userInfo?.open_id;
    if (typeof feishuOpenId !== 'string' || !feishuOpenId.trim() || feishuOpenId.length > 255) {
      return res.redirect('/?error=feishu_userinfo_failed');
    }
    Logger.info(`[飞书回调] 用户信息: name=${userInfo.name}, open_id=${userInfo.open_id}, tenant=${userInfo.tenant_key}, email=${userInfo.email}`);

    // 如果没有邮箱，尝试通过 contact API 获取
    if (!userInfo.email && userInfo.open_id) {
      try {
        Logger.info(`[飞书回调] 尝试通过 contact API 获取邮箱, open_id=${userInfo.open_id}`);
        const contactRes = await pinnedAxiosRequest(
          `https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(feishuOpenId)}?user_id_type=open_id`,
          { method: 'GET', headers: { 'Authorization': `Bearer ${await getAppAccessToken()}` } }
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
    const email = userInfo.email || `${feishuOpenId}@feishu.local`;
    let normalizedEmail;
    try { normalizedEmail = normalizeEmail(email); } catch (error) { return res.redirect('/?error=invalid_email'); }
    const avatar = userInfo.avatar_url || null;

    Logger.info(`[飞书回调] 查找用户: feishu_open_id=${feishuOpenId}, email=${normalizedEmail}`);

    // 先按 feishu_open_id 查找
    let user = null;
    const byOpenId = await pool.query('SELECT * FROM users WHERE feishu_open_id = $1', [feishuOpenId]);
    Logger.info(`[飞书回调] 按 open_id 查询: ${byOpenId.rows.length} 条记录`);
    if (byOpenId.rows.length > 0) {
      user = byOpenId.rows[0];
      // 更新头像和邮箱
      try {
        await pool.query(
          'UPDATE users SET avatar = COALESCE($1, avatar), email = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [avatar, normalizedEmail, user.id]
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        Logger.warn(`[飞书登录] 邮箱已被其他用户占用，登录失败: ${user.username}`);
        return res.redirect('/?error=email_conflict');
      }
      Logger.info(`[飞书登录] 已有用户登录: ${user.username} (id=${user.id})`);
    } else {
      // 按邮箱查找（可能通过其他方式注册过）
      const byEmail = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
      Logger.info(`[飞书回调] 按邮箱查询: ${byEmail.rows.length} 条记录`);
      if (byEmail.rows.length > 0) {
        return await requestBinding(req, res, byEmail.rows[0], {
          feishuOpenId, feishuName: userInfo.name || normalizedEmail.split('@')[0], email: normalizedEmail, avatar,
        }, cfg);
      } else {
        // 按飞书用户名查找
        const feishuName = userInfo.name || normalizedEmail.split('@')[0];
        const byUsername = await pool.query('SELECT * FROM users WHERE username = $1', [feishuName]);
        Logger.info(`[飞书回调] 按用户名查询: ${byUsername.rows.length} 条记录`);

        if (byUsername.rows.length > 0) {
          // 用户名已存在，需要验证密码后绑定
          return await requestBinding(req, res, byUsername.rows[0], {
            feishuOpenId, feishuName, email: normalizedEmail, avatar,
          }, cfg);
        }

        // 用户名不存在，创建新用户
        let newUser;
        try {
          newUser = await pool.query(
            `INSERT INTO users (username, email, feishu_open_id, avatar, email_verified, balance)
             VALUES ($1, $2, $3, $4, TRUE, 10) RETURNING *`,
            [feishuName, normalizedEmail, feishuOpenId, avatar]
          );
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          Logger.warn(`[飞书登录] 并发创建邮箱或飞书账号冲突: ${normalizedEmail}`);
          return res.redirect('/?error=email_conflict');
        }
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
            await require('../utils/team-membership').setUserTeam(pool, user.id, teamId);
            Logger.info(`[飞书注册] 用户 ${feishuName} 已自动加入默认 Team (id=${teamId})`);
          }
        } catch (teamErr) {
          Logger.error('[飞书注册] 自动加入默认 Team 失败:', teamErr);
        }


        // 自动创建默认 API Key（与普通 Key 无异，可删除）
        try {
          const rawKey = `sk-${crypto.randomBytes(24).toString('hex')}`;
          const keyPrefix = rawKey.substring(0, 12);
          await pool.query(
            `INSERT INTO api_keys (user_id, key_hash, key_value, key_prefix, name, custom_model_name)
             VALUES ($1, $2, $3, $4, 'CrewRouter', 'claude-fable-5')`,
            [user.id, require('../utils/key-hash').sha256Hex(rawKey), rawKey, keyPrefix]
          );
          Logger.info(`[飞书注册] 已为用户 ${feishuName} 创建默认 API Key`);
        } catch (keyErr) {
          Logger.error('[飞书注册] 创建默认 API Key 失败:', keyErr);
        }

        // 无默认 Team 时创建个人账户 Team
        try {
          const defaultTeam = await pool.query('SELECT id FROM teams WHERE is_default = TRUE LIMIT 1');
          if (defaultTeam.rows.length) throw Object.assign(new Error('默认 Team 已分配'), { code: 'TEAM_ASSIGNED' });
          const assigned = await pool.query('SELECT team_id FROM user_teams WHERE user_id = $1', [user.id]);
          if (assigned.rows.length) throw Object.assign(new Error('用户已有 Team 归属'), { code: 'TEAM_ASSIGNED' });
          const teamName = `${feishuName} 的个人账户`;
          const teamResult = await pool.query(
            'INSERT INTO teams (name, description, is_personal) VALUES ($1, $2, TRUE) RETURNING id',
            [teamName, '个人账户，系统自动创建']
          );
          await require('../utils/team-membership').setUserTeam(pool, user.id, teamResult.rows[0].id);
          Logger.info(`[飞书注册] 已为用户 ${feishuName} 创建个人账户 Team`);
        } catch (teamErr) {
          if (teamErr.code !== 'TEAM_ASSIGNED') Logger.error('[飞书注册] 创建个人账户 Team 失败:', teamErr);
        }
      }
    }

    // 重新读取最新用户（含 password_hash）
    const fresh = await pool.query('SELECT * FROM users WHERE id = $1', [user.id]);
    if (fresh.rows.length !== 1 || fresh.rows[0].feishu_open_id !== feishuOpenId) return res.redirect('/?error=feishu_conflict');
    user = fresh.rows[0];

    const needsPasswordSetup = user.password_hash == null || user.password_hash === '';

    // 设置 session
    await regenerateSession(req);
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

    try {
      await saveSession(req);
    } catch (error) {
      await discardFailedLogin(req);
      Logger.error('[飞书登录] Session 保存失败:', error.message);
      return res.redirect('/?error=session_failed');
    }
    reportLoginEvent(req);
    if (needsPasswordSetup) {
      Logger.info(`[飞书登录] 用户 ${user.username} 未设置密码，跳转设密页`);
      return res.redirect('/set-password');
    }
    res.redirect('/console');
  } catch (error) {
    Logger.error('[飞书回调] 错误:', error.message);
    res.redirect('/?error=feishu_error');
  }
});

// 获取待绑定信息（供绑定页面使用）
router.get('/feishu/pending', (req, res) => {
  const pending = pendingBinding(req);
  if (!pending) {
    return res.status(404).json({ error: '无待绑定信息' });
  }
  res.json({
    feishuName: pending.feishuName,
    existingUsername: pending.existingUsername,
    requiresTwoFactor: pending.requiresTwoFactor,
  });
});

// 验证密码并绑定飞书
router.post('/feishu/bind', async (req, res) => {
  const pending = pendingBinding(req);
  if (!pending) {
    return res.status(400).json({ error: '会话已过期，请重新通过飞书登录' });
  }

  const { password, code } = req.body || {};
  if (typeof password !== 'string' || !password || password.length > 1024) {
    return res.status(400).json({ error: '请输入密码' });
  }

  try {
    if (!await feishuMethodEnabled()) return res.status(403).json({ error: '当前实例不支持飞书登录' });
    const cfg = await getFeishuConfig();
    if (!cfg.enabled || !cfg.appId || !cfg.appSecret) return res.status(403).json({ error: '飞书登录已停用' });
    if (pending.configurationHash !== configurationHash(cfg)) {
      delete req.session.feishuPending;
      return res.status(400).json({ error: '飞书配置已变化，请重新通过飞书登录' });
    }
    if (!consumeBindingAttempt(req, pending.existingUserId)) return res.status(429).json({ error: '验证尝试过于频繁，请稍后再试' });
    pending.attempts += 1;
    await saveSession(req);
    const bcrypt = require('bcryptjs');
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [pending.existingUserId]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    let user = userResult.rows[0];
    if (user.feishu_open_id && user.feishu_open_id !== pending.feishuOpenId) {
      return res.status(409).json({ error: '该账号已绑定其他飞书身份，请先通过原登录方式管理绑定' });
    }

    if (!user.password_hash) {
      return res.status(400).json({ error: '该账号未设置密码，请联系管理员' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      Logger.warn(`[飞书绑定] 密码验证失败: ${pending.existingUsername}`);
      return res.status(401).json({ error: '密码错误' });
    }

    if (!bindingTotpValid(user, code)) {
      pending.requiresTwoFactor = true;
      return res.status(401).json({ error: '请输入该账号的有效 2FA 验证码', requiresTwoFactor: true });
    }
    if (pending.expiresAt <= Date.now()) {
      delete req.session.feishuPending;
      return res.status(400).json({ error: '会话已过期，请重新通过飞书登录' });
    }

    // 只绑定已验证的账号快照；凭据、2FA 或已有绑定并发改变时必须重新验证。
    try {
      const bound = await pool.query(
        `UPDATE users SET feishu_open_id = $1, avatar = COALESCE($2, avatar), updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND (feishu_open_id IS NULL OR feishu_open_id = $1)
           AND password_hash = $4 AND two_factor_enabled IS NOT DISTINCT FROM $5
           AND totp_secret IS NOT DISTINCT FROM $6::jsonb RETURNING *`,
        [pending.feishuOpenId, pending.avatar, user.id, user.password_hash, user.two_factor_enabled,
          user.totp_secret == null ? null : JSON.stringify(user.totp_secret)]
      );
      if (bound.rowCount !== 1) return res.status(409).json({ error: '账号验证信息已变化，请重新发起绑定' });
      user = bound.rows[0];
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return res.status(409).json({ error: '飞书账号或邮箱已被其他用户绑定' });
    }

    Logger.info(`[飞书绑定] 绑定成功: ${user.username} (id=${user.id})`);

    await logAction({ userId: user.id, username: user.username, isAdmin: !!user.is_admin,
      action: ACTIONS.AUTH_BIND_FEISHU, resourceType: 'user', resourceId: String(user.id),
      description: '验证本地账号后绑定飞书', details: { twoFactorVerified: user.two_factor_enabled === true },
      ip: req.ip, userAgent: req.headers['user-agent'], status: 200 });
    // 记录数据库变更后再轮换会话，轮换失败也不会遗漏已完成的绑定。
    delete req.session.feishuPending;
    await regenerateSession(req);

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

    try {
      await saveSession(req);
    } catch (error) {
      await discardFailedLogin(req);
      Logger.error('[飞书绑定] Session 保存失败:', error.message);
      return res.status(500).json({ error: '会话保存失败' });
    }
    reportLoginEvent(req);
    res.json({
      success: true,
      needsPasswordSetup,
      redirect: needsPasswordSetup ? '/set-password' : '/console',
    });
  } catch (error) {
    Logger.error('[飞书绑定] 错误:', error);
    res.status(500).json({ error: '绑定失败' });
  }
});

module.exports = router;
