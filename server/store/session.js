/**
 * 插件商店：独立的签名 session cookie（HMAC-SHA256）
 *
 * 商店会话与 CrewRouter 的 express-session 完全隔离：
 *  - 不写 req.session、不建 user_sessions 行、不依赖 Core 的会话中间件；
 *  - 只把 { username, nickname, avatar, admin } 签名进 cookie `bl_store_session`。
 *
 * 每次解码都要验签，防篡改；cookie 中不携带 apptoken。
 */

const crypto = require('crypto');
const Logger = require('../logger');
const { displayName } = require('../display-name');

const COOKIE_NAME = 'bl_store_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/**
 * @param {object} user { username, nickname, avatar, admin }
 * @param {string} secret
 * @returns {string} cookie value
 */
function encodeSession(user, secret) {
  if (!secret) {
    const err = new Error('store sessionSecret 未配置');
    err.code = 'PASSPORT_NOT_CONFIGURED';
    throw err;
  }
  const body = {
    username: user.username,
    nickname: displayName(user, user.username),
    avatar: user.avatar || '',
    admin: !!user.admin,
    iat: Date.now(),
  };
  const payloadB64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = sign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

function decodeSession(cookieValue, secret) {
  if (!cookieValue || !secret) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = sign(payloadB64, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    Logger.warn('[store-session] 签名校验失败');
    return null;
  }
  try {
    const body = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!body.username || !body.iat) return null;
    if (Date.now() - body.iat > MAX_AGE_MS) {
      Logger.info('[store-session] 会话过期，username=', body.username);
      return null;
    }
    return {
      username: body.username,
      nickname: body.nickname || body.username,
      avatar: body.avatar || '',
      admin: !!body.admin,
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
  if (!secret) return null;
  const raw = parseCookieHeader(req.headers.cookie || '')[COOKIE_NAME];
  return decodeSession(raw, secret);
}

function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

module.exports = {
  COOKIE_NAME,
  MAX_AGE_MS,
  encodeSession,
  decodeSession,
  setSessionCookie,
  clearSessionCookie,
  readSessionFromReq,
};
