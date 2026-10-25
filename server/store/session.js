/**
 * 插件商店：独立的签名 session cookie（HMAC-SHA256）
 *
 * 商店会话与 CrewRouter 的 express-session 完全隔离：
 *  - 不写 req.session、不建 user_sessions 行、不依赖 Core 的会话中间件；
 *  - 只把 { username, avatar, admin } 签名进 cookie `bl_store_session`。
 *
 * 每次解码都要验签，防篡改；cookie 中不携带 apptoken。
 */

const crypto = require('crypto');
const Logger = require('../logger');
const { isStoreSessionSecretValid } = require('../utils/store-session-secret');

const COOKIE_NAME = 'bl_store_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const MAX_COOKIE_LENGTH = 3800;
const MAX_COOKIE_HEADER_LENGTH = 16 * 1024;
const MAX_USERNAME_LENGTH = 255;
const MAX_AVATAR_LENGTH = 2048;

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function validString(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength
    && !/[\x00-\x1f\x7f]/.test(value)
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function validUser(user) {
  return user && typeof user === 'object' && !Array.isArray(user)
    && validString(user.username, MAX_USERNAME_LENGTH)
    && user.username.length > 0 && user.username.trim() === user.username
    && validString(user.avatar, MAX_AVATAR_LENGTH)
    && typeof user.admin === 'boolean';
}

function sessionError() {
  return Object.assign(new Error('商店会话字段无效或过长'), { code: 'PASSPORT_SESSION_INVALID' });
}

/**
 * @param {object} user { username, avatar, admin }
 * @param {string} secret
 * @returns {string} cookie value
 */
function encodeSession(user, secret) {
  if (!isStoreSessionSecretValid(secret)) {
    const err = new Error('商店会话签名密钥须配置为至少 32 字节的随机值，不能使用默认值');
    err.code = 'PASSPORT_NOT_CONFIGURED';
    throw err;
  }
  if (!user || typeof user !== 'object' || Array.isArray(user)) throw sessionError();
  const body = {
    username: user.username,
    avatar: user.avatar === undefined ? '' : user.avatar,
    admin: user.admin,
    iat: Date.now(),
  };
  if (!validUser(body)) throw sessionError();
  const payloadB64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = sign(payloadB64, secret);
  const value = `${payloadB64}.${sig}`;
  if (value.length > MAX_COOKIE_LENGTH) throw sessionError();
  return value;
}

function decodeSession(cookieValue, secret) {
  if (!isStoreSessionSecretValid(secret) || typeof cookieValue !== 'string'
      || !cookieValue || cookieValue.length > MAX_COOKIE_LENGTH) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  const expected = sign(payloadB64, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    Logger.warn('[store-session] 签名校验失败');
    return null;
  }
  try {
    const bytes = Buffer.from(payloadB64, 'base64url');
    if (bytes.toString('base64url') !== payloadB64) return null;
    const json = bytes.toString('utf8');
    if (!Buffer.from(json, 'utf8').equals(bytes)) return null;
    const body = JSON.parse(json);
    if (!validUser(body) || Object.keys(body).length !== 4
        || !Number.isSafeInteger(body.iat) || body.iat <= 0) return null;
    const now = Date.now();
    if (body.iat > now + MAX_CLOCK_SKEW_MS || now - body.iat >= MAX_AGE_MS) return null;
    return {
      username: body.username,
      avatar: body.avatar,
      admin: body.admin,
      iat: body.iat,
    };
  } catch (e) {
    Logger.warn('[store-session] 解码失败', e.message);
    return null;
  }
}

function setSessionCookie(res, user, secret, secure) {
  const value = encodeSession(user, secret);
  res.cookie(COOKIE_NAME, value, {
    httpOnly: true,
    secure: !!secure,
    sameSite: 'lax',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
  Logger.info('[store-session] 已写入 cookie，username=', user.username, 'admin=', !!user.admin);
}

function clearSessionCookie(res, secure) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: !!secure,
    sameSite: 'lax',
    path: '/',
  });
  Logger.info('[store-session] 已清除 cookie');
}

/**
 * 从请求读取商店登录态；需已启用 cookie-parser（或手写解析）。
 * CrewRouter 未用 cookie-parser，这里手动解析 Cookie 头。
 */
function readSessionFromReq(req, secret) {
  if (!isStoreSessionSecretValid(secret)) return null;
  const header = req?.headers?.cookie;
  if (typeof header !== 'string' || header.length > MAX_COOKIE_HEADER_LENGTH) return null;
  let raw;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k !== COOKIE_NAME) continue;
    // Duplicate cookies are ambiguous across paths/domains. Never choose one.
    if (raw !== undefined) return null;
    const v = part.slice(idx + 1).trim();
    if (v.length > MAX_COOKIE_LENGTH) return null;
    try { raw = decodeURIComponent(v); } catch { return null; }
  }
  return decodeSession(raw, secret);
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE_MS,
  MAX_CLOCK_SKEW_MS,
  encodeSession,
  decodeSession,
  setSessionCookie,
  clearSessionCookie,
  readSessionFromReq,
};
