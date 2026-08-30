const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../models/database');
const config = require('../config-loader');
const Logger = require('../logger');
const { normalizeEmail, isUniqueViolation } = require('../utils/user-identity');
const { getAuthMode } = require('../utils/auth-mode');

const router = express.Router();
const passport = config.passport || {};
const baseUrl = String(passport.baseUrl || 'https://passport.bloret.net').replace(/\/$/, '');

function getRedirectUri(req) {
  const requestedOrigin = String(req.query.redirect_origin || '').trim().replace(/\/$/, '');
  if (requestedOrigin) {
    const parsed = new URL(requestedOrigin);
    return `${parsed.origin}/auth/passport/callback`;
  }

  const protocol = String(req.protocol || '').toLowerCase() || 'http:';
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || String(req.get('host') || '').trim();
  if (!host) throw new Error('无法确定当前访问地址');
  return `${protocol}//${host}/auth/passport/callback`;
}
router.get('/passport/redirect-uri', (req, res) => {
  try {
    res.json({ redirectUri: getRedirectUri(req) });
  } catch (err) {
    res.json({ requiresConfirmation: true, error: err.message });
  }
});

function sessionUser(user) {
  return { id: user.id, username: user.username, email: user.email, avatar: user.avatar, isAdmin: user.is_admin, balance: parseFloat(user.balance || 0), refund_balance: parseFloat(user.refund_balance || 0), api_signature_enabled: user.api_signature_enabled === true, api_signature_template: user.api_signature_template || '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}' };
}
function saveSession(req, res, next) { req.session.save((err) => err ? next(err) : next()); }

async function verifyPassport(code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${baseUrl}/app/verify`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ app_id: passport.appId, app_secret: passport.appSecret, code }),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error('PassPort 返回了非 JSON 响应'); }
    if (!response.ok || data.error || (data.code !== undefined && data.code !== 0)) throw new Error(data.error || data.message || data.msg || 'PassPort 验证失败');
    const payload = data.data && typeof data.data === 'object' ? data.data : data;
    if (!String(payload.username || '').trim() || !String(payload.apptoken || '').trim()) throw new Error('PassPort 响应缺少 username 或 apptoken');
    return payload;
  } finally { clearTimeout(timer); }
}

async function seedPassportUser(client, user, username, invite = null) {
  const rawKey = `sk-${crypto.randomBytes(24).toString('hex')}`;
  await client.query(
    `INSERT INTO api_keys (user_id, key_hash, key_value, key_prefix, name, custom_model_name) VALUES ($1, $2, $3, $4, 'CrewRouter', 'claude-fable-5')`,
    [user.id, require('../utils/key-hash').sha256Hex(rawKey), rawKey, rawKey.substring(0, 12)]
  );
  const teamName = `${username} 的个人账户`;
  const personal = await client.query('INSERT INTO teams (name, description, is_personal) VALUES ($1, $2, TRUE) RETURNING id', [teamName, '个人账户，系统自动创建']);
  await client.query('INSERT INTO user_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, personal.rows[0].id]);
  if (invite?.team_id) {
    await client.query('INSERT INTO user_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, invite.team_id]);
  }
  if (invite?.group_id) {
    await client.query('UPDATE users SET group_id = $1 WHERE id = $2', [invite.group_id, user.id]);
  } else {
    const group = await client.query('SELECT id FROM user_groups WHERE is_default = TRUE LIMIT 1');
    if (group.rows.length) await client.query('UPDATE users SET group_id = $1 WHERE id = $2', [group.rows[0].id, user.id]);
  }
  await require('../utils/inject-prompt').seedDefaultPrompt(user.id, client);
}

router.get('/passport', async (req, res) => {
  try {
    if (await getAuthMode() !== 'passport') return res.redirect('/?error=passport_disabled');
    if (!passport.appId || !passport.appSecret) return res.redirect('/?error=passport_not_configured');
    const redirectUri = getRedirectUri(req);
    const state = crypto.randomBytes(24).toString('hex');
    const invite = typeof req.query.invite === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(req.query.invite) ? req.query.invite : '';
    req.session.passportState = state;
    req.session.passportInvite = invite;
    saveSession(req, res, (err) => {
      if (err) return res.status(500).send('登录状态保存失败，请重试。');
      const params = new URLSearchParams({
        app_id: passport.appId,
        redirect_uri: redirectUri,
        state,
      });
      res.redirect(`${baseUrl}/app/oauth?${params.toString()}`);
    });
  } catch (err) { Logger.error('[PassPort] OAuth 入口失败:', err.message); res.status(500).send(`PassPort 授权入口配置错误：${err.message}`); }
});

router.get('/passport/callback', async (req, res) => {
  const { code, state } = req.query;
  const sessionState = req.session.passportState;
  const setupState = await pool.query("SELECT 1 FROM settings WHERE key = 'setup_complete' LIMIT 1");
  const isInitialSetup = setupState.rows.length === 0;
  // PassPort 完成授权后可能只回传 code。首次初始化允许无 state；已完成初始化后，有 state 则必须匹配。
  if (state && sessionState && state !== sessionState) {
    return res.status(400).send('PassPort 登录状态无效，请返回重试。');
  }
  if (!isInitialSetup && !code) {
    return res.status(400).send('PassPort 登录状态无效，请返回重试。');
  }
  const invite = req.session.passportInvite;
  delete req.session.passportState;
  delete req.session.passportInvite;
  if (!code) return res.status(400).send('PassPort 未返回授权码。');
  try {
    const data = await verifyPassport(code);
    const passportUsername = String(data.username).trim().slice(0, 255);
    const inviteForUser = String(invite || '');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [731947]);
      let result = await client.query('SELECT * FROM users WHERE passport_username = $1 FOR UPDATE', [passportUsername]);
      let user = result.rows[0];
      if (!user) {
        const adminCount = await client.query('SELECT COUNT(*)::int AS count FROM users WHERE is_admin = TRUE');
        const isFirstAdmin = adminCount.rows[0].count === 0;
        let inviteRow = null;
        if (!isFirstAdmin) {
          const { validateInvite } = require('./auth-invites');
          inviteRow = await validateInvite(inviteForUser, client);
          if (!inviteRow) { await client.query('ROLLBACK'); return res.status(403).send('该登录需要有效邀请链接，请使用管理员提供的邀请链接访问。'); }
        }
        const nickname = String(data.nickname || passportUsername).trim().slice(0, 255) || passportUsername;
        let username = nickname;
        for (let suffix = 0; suffix < 1000; suffix++) {
          const candidate = suffix ? `${nickname.slice(0, 255 - String(suffix).length - 3)}_pp${suffix}` : username;
          const collision = await client.query('SELECT 1 FROM users WHERE username = $1', [candidate]);
          if (!collision.rows.length) { username = candidate; break; }
          if (suffix === 999) throw new Error('无法生成唯一用户名');
        }
        const email = normalizeEmail(data.email);
        let inserted;
        try {
          inserted = await client.query(`INSERT INTO users (username, passport_username, email, avatar, is_admin, email_verified, balance) VALUES ($1, $2, $3, $4, $5, TRUE, 10) RETURNING *`, [username, passportUsername, email, String(data.avatar || '').slice(0, 500) || null, isFirstAdmin]);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw Object.assign(new Error('该邮箱或用户标识已被其他用户使用'), { code: 'EMAIL_OR_ID_CONFLICT' });
          }
          throw error;
        }
        user = inserted.rows[0];
        if (inviteRow) {
          const { consumeInvite } = require('./auth-invites');
          const consumed = await consumeInvite(inviteRow, user.id, client);
          if (!consumed) throw new Error('邀请已被使用或已过期');
        }
        await seedPassportUser(client, user, username, inviteRow);
        if (isFirstAdmin) {
          await client.query(
            "INSERT INTO settings (key, value) VALUES ('setup_complete', $1::jsonb) ON CONFLICT (key) DO NOTHING",
            [JSON.stringify({ completed_at: new Date().toISOString(), method: 'passport-authorized' })]
          );
          Logger.info(`[OOBE] PassPort 管理员授权完成: ${passportUsername}`);
        }
      }
      await client.query('COMMIT');
      req.session.user = sessionUser(user);
      req.session.user.passportUsername = passportUsername;
      saveSession(req, res, (err) => {
        if (err) return res.status(500).send('登录会话保存失败，请重试。');
        try { require('../utils/login-reporter').reportLoginEvent(req); } catch (_) {}
        res.redirect('/console');
      });
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
  } catch (err) {
    Logger.error('[PassPort] 回调失败:', err.message);
    if (err.code === 'invalid_email') return res.status(400).send('PassPort 返回的邮箱格式无效。');
    if (err.code === 'EMAIL_OR_ID_CONFLICT') return res.status(409).send('邮箱或账号标识已被其他用户使用，请重试。');
    res.status(502).send('PassPort 登录失败，请稍后重试。');
  }
});

module.exports = router;
