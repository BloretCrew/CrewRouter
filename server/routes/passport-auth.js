const express = require('express');
const crypto = require('crypto');
const { pool } = require('../models/database');
const config = require('../config-loader');
const Logger = require('../logger');
const { normalizeEmail, isUniqueViolation } = require('../utils/user-identity');
const { getAuthMode, AUTH_MODE_LOCK } = require('../utils/auth-mode');
const { loadPersistedEdition } = require('../utils/instance-edition');
const { validateUrl } = require('../utils/url-validator');
const proxyPool = require('../proxy-pool');

const router = express.Router();
const passport = config.passport || {};
const localPassport = require('../utils/local-passport');
const passportLoginState = require('../utils/passport-login-state');
const isLocal = () => process.env.CR_RUNTIME === 'desktop-local';

const baseUrl = String(passport.baseUrl || 'https://passport.bloret.net').replace(/\/$/, '');
const loginContext = JSON.stringify([baseUrl, passport.appId || '']);

function normalizeOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('PassPort 回调来源地址无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('PassPort 回调来源地址无效');
  return parsed.origin;
}

function getRedirectUri(req) {
  if (isLocal()) {
    localPassport.validateLocalToken(req);
    return `${localPassport.localOrigin(req, config.app.port)}/auth/passport/callback`;
  }
  const protocol = String(req.protocol || '').toLowerCase();
  const host = String(req.get('host') || '').trim();
  if (!host) throw new Error('无法确定当前访问地址');
  // req.protocol follows Express's configured proxy trust policy. An arbitrary
  // forwarded host or query parameter must not select the code's recipient.
  const origin = normalizeOrigin(String(config.app?.publicOrigin || '').trim() || `${protocol}://${host}`);
  const requestedOrigin = req.query.redirect_origin;
  if (requestedOrigin !== undefined
      && (typeof requestedOrigin !== 'string' || normalizeOrigin(requestedOrigin.trim()) !== origin)) {
    throw new Error('PassPort 回调必须使用当前实例的来源地址');
  }
  return `${origin}/auth/passport/callback`;
}
router.get('/passport/redirect-uri', (req, res) => {
  try {
    res.json({ redirectUri: getRedirectUri(req) });
  } catch (err) {
    if (isLocal()) return res.status(403).json({ error: err.message });
    res.json({ requiresConfirmation: true, error: err.message });
  }
});

function sessionUser(user) {
  return { id: user.id, username: user.username, email: user.email, avatar: user.avatar, isAdmin: user.is_admin, balance: parseFloat(user.balance || 0), refund_balance: parseFloat(user.refund_balance || 0), api_signature_enabled: user.api_signature_enabled === true, api_signature_template: user.api_signature_template || '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}' };
}
function saveSession(req, res, next) { req.session.save((err) => err ? next(err) : next()); }

function persistSession(req) {
  return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}

async function discardFailedSession(req) {
  const failedSession = req.session;
  delete req.session;
  if (!failedSession) return;
  delete failedSession.user;
  await new Promise(resolve => {
    const done = error => {
      if (error) Logger.warn('[PassPort] 失败会话清理失败:', error.code || error.name || 'unknown');
      resolve();
    };
    try { failedSession.destroy(done); } catch (error) { done(error); }
  });
}

async function requirePassportLogin(db = pool) {
  const { metadata } = require('../utils/instance-edition');
  const edition = await loadPersistedEdition(db) || config.edition || 'personal';
  if (!metadata(edition, { runtime: process.env.CR_RUNTIME || 'server', authMode: await getAuthMode(db) }).auth.methods.includes('passport')) {
    throw Object.assign(new Error('当前实例不支持 PassPort 登录'), { code: 'PASSPORT_DISABLED' });
  }
  if (!passport.appId || !passport.appSecret) {
    throw Object.assign(new Error('PassPort 未配置'), { code: 'PASSPORT_NOT_CONFIGURED' });
  }
}

async function verifyPassport(code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const verificationUrl = `${baseUrl}/app/verify`;
    const urlCheck = await validateUrl(verificationUrl, { allowPrivate: false });
    if (!urlCheck.ok || urlCheck.url.protocol !== 'https:' || urlCheck.url.username || urlCheck.url.password) {
      throw new Error(`PassPort 地址安全校验失败: ${urlCheck.error || '必须使用无凭据的公网 HTTPS 地址'}`);
    }
    const response = await proxyPool.pinnedFetchValidated(urlCheck, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ app_id: passport.appId, app_secret: passport.appSecret, code }),
      redirect: 'manual',
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error('PassPort 返回了非 JSON 响应'); }
    if (!response.ok || data.error || (data.code !== undefined && data.code !== 0)) throw new Error(data.error || data.message || data.msg || 'PassPort 验证失败');
    const payload = data.data && typeof data.data === 'object' ? data.data : data;
    localPassport.passportIdentity(payload);
    return payload;
  } finally { clearTimeout(timer); }
}

async function seedPassportUser(client, user, username, invite = null) {
  const rawKey = `sk-${crypto.randomBytes(24).toString('hex')}`;
  await client.query(
    `INSERT INTO api_keys (user_id, key_hash, key_value, key_prefix, name, custom_model_name) VALUES ($1, $2, $3, $4, 'CrewRouter', 'claude-fable-5')`,
    [user.id, require('../utils/key-hash').sha256Hex(rawKey), rawKey, rawKey.substring(0, 12)]
  );
  const defaultTeam = await client.query('SELECT id FROM teams WHERE is_default = TRUE LIMIT 1');
  const selectedTeamId = invite?.team_id || defaultTeam.rows[0]?.id || null;
  let assignedTeamId = selectedTeamId;
  if (!assignedTeamId) {
    const teamName = `${username} 的个人账户`;
    const personal = await client.query('INSERT INTO teams (name, description, is_personal) VALUES ($1, $2, TRUE) RETURNING id', [teamName, '个人账户，系统自动创建']);
    assignedTeamId = personal.rows[0].id;
  }
  await client.query('DELETE FROM user_teams WHERE user_id = $1', [user.id]);
  if (assignedTeamId) {
    await client.query('INSERT INTO user_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT (user_id, team_id) DO NOTHING', [user.id, assignedTeamId]);
    await client.query('UPDATE users SET team_id = $1 WHERE id = $2', [assignedTeamId, user.id]);
  }
  await require('../utils/inject-prompt').seedDefaultPrompt(user.id, client);
}

router.get('/passport', async (req, res) => {
  try {
    if (isLocal()) localPassport.validateLocalToken(req);
    const { metadata } = require('../utils/instance-edition');
    const edition = await loadPersistedEdition(pool) || require('../config-loader').edition || 'personal';
    if (!metadata(edition, { runtime: process.env.CR_RUNTIME || 'server', authMode: await getAuthMode() }).auth.methods.includes('passport')) return res.redirect('/?error=passport_disabled');
    if (!passport.appId || !passport.appSecret) {
      if (isLocal()) return res.status(503).type('html').send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PassPort 未配置</title><p>Local PassPort 登录未配置，请配置应用 ID 和密钥后重试。</p></html>');
      return res.redirect('/?error=passport_not_configured');
    }
    const redirectUri = getRedirectUri(req);
    if (isLocal()) {
      localPassport.cancelSession(req, config.app.sessionSecret);
      await localPassport.regenerateSession(req);
    }
    const invite = typeof req.query.invite === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(req.query.invite) ? req.query.invite : '';
    const state = isLocal()
      ? localPassport.issueState(req, new URL(redirectUri).origin)
      : passportLoginState.issueState(req, new URL(redirectUri).origin, loginContext, invite);
    if (isLocal()) {
      req.session.passportState = state;
      req.session.passportInvite = invite;
    }
    saveSession(req, res, (err) => {
      if (err) return res.status(500).send('登录状态保存失败，请重试。');
      const callbackUri = new URL(redirectUri);
      // PassPort 的 /app/oauth 通过 redirect_uri 保留参数，回调只追加 code。
      callbackUri.searchParams.set('state', state);
      const params = new URLSearchParams({
        app_id: passport.appId,
        redirect_uri: callbackUri.toString(),
        state,
      });
      res.redirect(`${baseUrl}/app/oauth?${params.toString()}`);
    });
  } catch (err) { Logger.error('[PassPort] OAuth 入口失败:', err.message); res.status(err.code === 'LOCAL_PASSPORT_DENIED' ? 403 : 500).send(`PassPort 授权入口配置错误：${err.message}`); }
});

router.get('/passport/cancel', async (req, res) => {
  if (!isLocal()) return res.sendStatus(404);
  try {
    localPassport.validateLocalToken(req);
    localPassport.cancelSession(req, config.app.sessionSecret);
    await new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
    return res.sendStatus(204);
  } catch (error) {
    return res.status(error.code === 'LOCAL_PASSPORT_DENIED' ? 403 : 500).send('取消 PassPort 授权失败。');
  }
});

async function localCallback(req, res) {
  let pending;
  let authenticatedSession = false;
  try {
    localPassport.validateLocalToken(req);
    const origin = localPassport.localOrigin(req, config.app.port);
    pending = localPassport.consumeState(req, origin);
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    if (!passport.appId || !passport.appSecret) throw new Error('PassPort 未配置');
    const data = await verifyPassport(req.query.code);
    localPassport.assertActive(pending);
    const identity = localPassport.passportIdentity(data);
    const client = await pool.connect();
    let user;
    try {
      localPassport.assertActive(pending);
      await client.query('BEGIN');
      user = await localPassport.bindLocalUser(client, identity, async () => {
        const inserted = await client.query(
          `INSERT INTO users (username, passport_username, email, avatar, is_admin, email_verified, balance)
           VALUES ($1, $2, $3, $4, TRUE, TRUE, 10) RETURNING *`,
          [identity, identity, normalizeEmail(data.email), String(data.avatar || '').slice(0, 500) || null]
        );
        const created = inserted.rows[0];
        await seedPassportUser(client, created, created.username);
        return created;
      });
      const team = await localPassport.ensureDesktopLocalPersonalTeam(client, user);
      await localPassport.ensureDesktopLocalPersonalModels(client, team);
      await client.query(
        "INSERT INTO settings (key, value) VALUES ('setup_complete', $1::jsonb) ON CONFLICT (key) DO NOTHING",
        [JSON.stringify({ completed_at: new Date().toISOString(), method: 'local-passport-authorized' })]
      );
      localPassport.assertActive(pending);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    localPassport.assertActive(pending);
    await localPassport.regenerateSession(req);
    authenticatedSession = true;
    pending.sessionIds.add(req.sessionID);
    localPassport.assertActive(pending);
    req.session.user = { ...sessionUser(user), passportUsername: identity, needsPasswordSetup: false };
    req.session.localPassportAuth = true;
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    localPassport.assertActive(pending);
    res.redirect('/console');
  } catch (error) {
    if (authenticatedSession || (pending && (pending.revoked || pending.expiresAt <= Date.now()))) {
      await discardFailedSession(req);
    }
    Logger.error('[Local PassPort] 回调失败:', error.message);
    if (error.code === 'LOCAL_PASSPORT_DENIED') return res.status(403).send(error.message);
    if (error.code === 'invalid_email') return res.status(400).send('PassPort 返回的邮箱格式无效。');
    if (isUniqueViolation(error)) return res.status(409).send('邮箱或账号标识已被其他用户使用。');
    return res.status(502).send('PassPort 登录失败，请稍后重试。');
  } finally { if (pending) localPassport.finishState(pending); }
}

router.get('/passport/callback', async (req, res) => {
  if (isLocal()) return localCallback(req, res);
  let authenticatedSession = false;
  try {
    const origin = new URL(getRedirectUri(req)).origin;
    const { code, invite } = passportLoginState.consumeState(req, origin, loginContext);
    // Persist consumption before any external exchange. The shared session is
    // usable across instances; the helper also rejects same-process concurrent
    // stale copies. Cross-process atomicity still relies on the IdP's one-use code.
    await persistSession(req);
    await requirePassportLogin();
    const data = await verifyPassport(code);
    const passportUsername = localPassport.passportIdentity(data);
    const inviteForUser = String(invite || '');
    const client = await pool.connect();
    let user;
    try {
      await client.query('BEGIN');
      // Serialize with setup/auth-mode changes before deciding whether a new
      // identity may become the initial administrator.
      await client.query('SELECT pg_advisory_xact_lock($1)', [AUTH_MODE_LOCK]);
      await client.query('SELECT pg_advisory_xact_lock($1)', [731947]);
      await requirePassportLogin(client);
      let result = await client.query('SELECT * FROM users WHERE passport_username = $1 FOR UPDATE', [passportUsername]);
      user = result.rows[0];
      if (!user) {
        const setupState = await client.query("SELECT 1 FROM settings WHERE key = 'setup_complete' LIMIT 1");
        const userCount = await client.query('SELECT COUNT(*)::int AS count FROM users');
        const isFirstAdmin = setupState.rows.length === 0 && userCount.rows[0].count === 0;
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
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; } finally { client.release(); }
    await localPassport.regenerateSession(req);
    authenticatedSession = true;
    req.session.user = sessionUser(user);
    req.session.user.passportUsername = passportUsername;
    await persistSession(req);
    try { require('../utils/login-reporter').reportLoginEvent(req); } catch (_) {}
    res.redirect('/console');
  } catch (err) {
    if (authenticatedSession && req.session) {
      // A failed explicit save must not be retried with an authenticated user by
      // express-session while sending the error response.
      await discardFailedSession(req);
    }
    Logger.error('[PassPort] 回调失败:', err.message);
    if (err.code === 'PASSPORT_STATE_INVALID') return res.status(400).send('PassPort 登录状态无效或已过期，请重新发起登录。');
    if (err.code === 'PASSPORT_DISABLED') return res.status(403).send('当前实例不支持 PassPort 登录。');
    if (err.code === 'PASSPORT_NOT_CONFIGURED') return res.status(503).send('PassPort 登录未配置。');
    if (err.code === 'invalid_email') return res.status(400).send('PassPort 返回的邮箱格式无效。');
    if (err.code === 'EMAIL_OR_ID_CONFLICT') return res.status(409).send('邮箱或账号标识已被其他用户使用，请重试。');
    res.status(502).send('PassPort 登录失败，请稍后重试。');
  }
});

module.exports = router;
