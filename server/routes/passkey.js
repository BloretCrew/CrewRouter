const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const passkeyManager = require('../utils/PassKey');
const { getWebAuthnConfig, normalizePasskeys } = passkeyManager;
const { withLockedPasskeys } = require('../utils/passkey-store');
const { metadata, loadPersistedEdition } = require('../utils/instance-edition');
const { getAuthMode } = require('../utils/auth-mode');
const { ACTIONS, logAction } = require('../utils/audit-log');
const Logger = require('../logger');

const attempts = new Map();
const WINDOW_MS = 5 * 60 * 1000;
function pruneAttempts() {
  for (const [key, item] of attempts) if (item.expiresAt <= Date.now()) attempts.delete(key);
}
setInterval(pruneAttempts, 60 * 1000).unref?.();
router.use((req, res, next) => {
  const key = req.ip || 'unknown';
  let item = attempts.get(key);
  if (!item || item.expiresAt <= Date.now()) {
    if (attempts.size >= 10000) pruneAttempts();
    if (attempts.size >= 10000) return res.status(429).json({ error: '请求过于频繁，请稍后重试' });
    item = { count: 0, expiresAt: Date.now() + WINDOW_MS };
    attempts.set(key, item);
  }
  if (++item.count > 60) return res.status(429).json({ error: '请求过于频繁，请稍后重试' });
  next();
});

async function requirePasskeyLogin(req, res, next) {
  try {
    const edition = await loadPersistedEdition(pool) || require('../config-loader').edition || 'personal';
    const allowed = metadata(edition, { runtime: process.env.CR_RUNTIME || 'server', authMode: await getAuthMode() }).auth.methods;
    if (!allowed.includes('password')) return res.status(403).json({ error: '当前实例不支持通行密钥登录', type: 'auth_method_disabled' });
    next();
  } catch (error) { respondError(res, error, '读取登录策略失败'); }
}

function buildSessionUser(user) {
  return {
    id: user.id, username: user.username, email: user.email, avatar: user.avatar,
    isAdmin: user.is_admin, balance: user.balance, refund_balance: user.refund_balance || 0,
    api_signature_enabled: user.api_signature_enabled === true,
    api_signature_template: user.api_signature_template || '{model} · {tokens} · 缓存命中 {cache_hit}% · {quota_info}',
  };
}
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function respondError(res, error, message) {
  Logger.error(`[PassKey] ${message}:`, error);
  const status = [400, 401, 404, 409, 429].includes(error.status) ? error.status : 500;
  return res.status(status).json({ error: status === 500 ? message : error.message });
}
function owner(req, create = false) {
  if (!req.session.passkeyOwner && create) req.session.passkeyOwner = crypto.randomBytes(32).toString('hex');
  if (!req.session.passkeyOwner) throw httpError(401, '请重新获取通行密钥选项');
  return req.session.passkeyOwner;
}
function saveSession(req) {
  return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}
async function discardSession(req) {
  const failed = req.session;
  delete req.session;
  if (!failed) return;
  delete failed.user;
  delete failed.pendingTwoFactor;
  if (typeof failed.destroy === 'function') await new Promise(resolve => {
    try { failed.destroy(() => resolve()); } catch { resolve(); }
  });
}
function audit(req, user, action, details) {
  logAction({ userId: user.id, username: user.username, isAdmin: !!(user.is_admin ?? user.isAdmin), action,
    resourceType: 'passkey', resourceId: details.credentialIdSha256 || null, details, ip: req.ip, userAgent: req.headers['user-agent'], status: 200 });
}

router.get('/register/options', requireAuth, requirePasskeyLogin, async (req, res) => {
  try {
    const user = (await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id])).rows[0];
    if (!user) throw httpError(404, '用户不存在');
    const options = await passkeyManager.getRegistrationOptions(user, { ...getWebAuthnConfig(req), owner: owner(req, true) });
    await saveSession(req);
    res.json(options);
  } catch (error) { respondError(res, error, '获取注册选项失败'); }
});

router.post('/register/verify', requireAuth, requirePasskeyLogin, async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body.id !== 'string' || !body.response) throw httpError(400, '无效的注册响应');
    let newPasskey;
    try {
      newPasskey = await passkeyManager.verifyRegistration(req.session.user.id, body, { ...getWebAuthnConfig(req), owner: owner(req) });
    } catch { throw httpError(401, '注册验证失败，请重新获取选项'); }
    await withLockedPasskeys(pool, req.session.user.id, (_user, passkeys) => { passkeys.push(newPasskey); }, newPasskey.credentialID);
    audit(req, req.session.user, ACTIONS.USER_PASSKEY_REGISTER, { method: 'passkey', credentialIdSha256: crypto.createHash('sha256').update(newPasskey.credentialID).digest('hex') });
    res.json({ success: true, passkey: { credentialID: newPasskey.credentialID, deviceType: newPasskey.deviceType, createdAt: newPasskey.createdAt } });
  } catch (error) { respondError(res, error, '注册验证失败'); }
});

router.post('/login/options', requirePasskeyLogin, async (req, res) => {
  try {
    const { username } = req.body || {};
    let passkeys = [];
    if (username) {
      const result = await pool.query('SELECT passkeys FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1 LIMIT 1', [String(username).toLowerCase().trim()]);
      passkeys = normalizePasskeys(result.rows[0]?.passkeys);
    }
    const options = await passkeyManager.getAuthenticationOptions(passkeys, { ...getWebAuthnConfig(req), owner: owner(req, true) });
    // Persist a browser-specific owner, including on previously anonymous visits.
    await saveSession(req);
    res.json(options);
  } catch (error) { respondError(res, error, '获取登录选项失败'); }
});

router.post('/login/verify', requirePasskeyLogin, async (req, res) => {
  let sessionChanged = false;
  try {
    const { body, challenge } = req.body || {};
    if (!body || typeof body.id !== 'string' || typeof challenge !== 'string' || !challenge) throw httpError(400, '缺少必要参数');
    const challengeOwner = owner(req);
    const result = await pool.query(`SELECT id FROM users WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(passkeys, '[]'::jsonb)) pk
      WHERE pk->>'credentialID' = $1) LIMIT 2`, [body.id]);
    // Ambiguous legacy credentials must never pick an arbitrary account.
    if (result.rows.length !== 1) throw httpError(401, '未找到唯一匹配的通行密钥');
    const user = await withLockedPasskeys(pool, result.rows[0].id, async (current, passkeys) => {
      const passkey = passkeys.find(pk => pk.credentialID === body.id);
      if (!passkey?.credentialPublicKey) throw httpError(401, '通行密钥已失效，请重新登录');
      let verification;
      try {
        verification = await passkeyManager.verifyAuthentication(passkey, body, challenge, { ...getWebAuthnConfig(req), owner: challengeOwner });
      } catch { throw httpError(401, '通行密钥验证失败，请重新获取选项'); }
      passkey.counter = verification.newCounter;
      return current;
    });
    sessionChanged = true;
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    if (user.two_factor_enabled) {
      req.session.pendingTwoFactor = { userId: user.id, expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0, method: 'passkey', credentialIdSha256: crypto.createHash('sha256').update(body.id).digest('hex') };
      await saveSession(req);
      return res.json({ success: true, require2FA: true, userId: user.id });
    }
    req.session.user = buildSessionUser(user);
    await saveSession(req);
    audit(req, user, ACTIONS.AUTH_LOGIN, { method: 'passkey', credentialIdSha256: crypto.createHash('sha256').update(body.id).digest('hex') });
    require('../utils/login-reporter').reportLoginEvent(req);
    res.json({ success: true, user: req.session.user });
  } catch (error) {
    if (sessionChanged) await discardSession(req);
    respondError(res, error, '登录验证失败，请稍后重试');
  }
});

router.delete('/:credentialID', requireAuth, async (req, res) => {
  try {
    await withLockedPasskeys(pool, req.session.user.id, (_user, passkeys) => {
      const index = passkeys.findIndex(pk => pk.credentialID === req.params.credentialID);
      if (index < 0) throw httpError(404, '未找到该通行密钥');
      passkeys.splice(index, 1);
    });
    audit(req, req.session.user, ACTIONS.USER_PASSKEY_DELETE, { method: 'passkey', credentialIdSha256: crypto.createHash('sha256').update(req.params.credentialID).digest('hex') });
    res.json({ success: true });
  } catch (error) { respondError(res, error, '删除通行密钥失败'); }
});

router.get('/list', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT passkeys FROM users WHERE id = $1', [req.session.user.id]);
    res.json(normalizePasskeys(result.rows[0]?.passkeys).map(pk => ({ credentialID: pk.credentialID, deviceType: pk.deviceType, createdAt: pk.createdAt })));
  } catch (error) { respondError(res, error, '获取通行密钥列表失败'); }
});

module.exports = router;
