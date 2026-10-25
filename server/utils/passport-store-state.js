'use strict';

const crypto = require('node:crypto');

const STATE_TTL_MS = 5 * 60 * 1000;
const MAX_CONSUMED_STATES = 10_000;
const RETURN_ORIGIN = 'https://crewrouter.invalid';
// Issuance is self-contained in a signed browser cookie so independent store
// instances can validate the callback. This cache catches same-process replay;
// code consumption at the IdP remains necessary across processes.
const consumedStates = new Map();

function stateError() {
  return Object.assign(new Error('商店登录状态无效或已过期，请重新发起登录。'), { code: 'PASSPORT_STATE_INVALID' });
}

function safeReturnTo(value) {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('/')
      || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) return '/store';
  try {
    const parsed = new URL(value, RETURN_ORIGIN);
    if (parsed.origin !== RETURN_ORIGIN || parsed.pathname.startsWith('//')) return '/store';
    return parsed.pathname + parsed.search + parsed.hash;
  } catch { return '/store'; }
}

function successReturnTo(value) {
  const parsed = new URL(safeReturnTo(value), RETURN_ORIGIN);
  parsed.searchParams.set('auth', 'ok');
  return parsed.pathname + parsed.search + parsed.hash;
}

function callbackUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw stateError(); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw stateError();
  parsed.searchParams.delete('state');
  return parsed;
}

function contextFor(cfg, redirectUri) {
  if (!cfg?.isConfigured || !cfg.appId || !cfg.appSecret || typeof cfg.sessionSecret !== 'string' || !cfg.sessionSecret) throw stateError();
  return crypto.createHash('sha256').update(JSON.stringify([cfg.baseUrl, cfg.appId, callbackUrl(redirectUri).toString()])).digest('hex');
}

function cookieOptions(req) {
  return { httpOnly: true, secure: req.secure === true, sameSite: 'lax', path: '/' };
}

function cookieName(req) {
  // On HTTPS the browser rejects Domain cookies with this prefix, preventing a
  // sibling domain from planting an attacker's signed login-flow cookie.
  return req.secure === true ? '__Host-cr-store-oauth' : 'cr_store_oauth';
}

function signature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(`crewrouter-store-oauth\0${payload}`).digest('base64url');
}

function readCookie(req) {
  const name = cookieName(req);
  const values = String(req.headers?.cookie || '').split(';').map(part => part.trim())
    .filter(part => part.slice(0, part.indexOf('=')) === name)
    .map(part => part.slice(part.indexOf('=') + 1));
  if (values.length !== 1 || values[0].length > 4096) throw stateError();
  try { return decodeURIComponent(values[0]); } catch { throw stateError(); }
}

function issueState(req, res, cfg, redirectUri, returnTo, now = Date.now()) {
  const context = contextFor(cfg, redirectUri);
  const state = crypto.randomBytes(32).toString('hex');
  const body = { state, context, returnTo: safeReturnTo(returnTo), expiresAt: now + STATE_TTL_MS };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  const value = `${payload}.${signature(payload, cfg.sessionSecret)}`;
  if (value.length > 3800) throw stateError();
  res.cookie(cookieName(req), value, { ...cookieOptions(req), maxAge: STATE_TTL_MS });
  const callback = callbackUrl(redirectUri);
  callback.searchParams.set('state', state);
  return { state, redirectUri: callback.toString() };
}

function consumeState(req, res, cfg, redirectUri, now = Date.now()) {
  const state = req.query?.state;
  const code = req.query?.code;
  if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)
      || typeof code !== 'string' || !code.trim() || code.length > 4096) throw stateError();
  const context = contextFor(cfg, redirectUri);
  const [payload, actual, extra] = readCookie(req).split('.');
  if (!payload || !actual || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload)) throw stateError();
  const expected = signature(payload, cfg.sessionSecret);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  if (expectedBytes.length !== actualBytes.length || !crypto.timingSafeEqual(expectedBytes, actualBytes)) throw stateError();
  let body;
  try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw stateError(); }
  if (!body || body.state !== state || body.context !== context || !Number.isFinite(body.expiresAt)
      || body.expiresAt <= now || body.expiresAt > now + STATE_TTL_MS) throw stateError();
  for (const [key, expiresAt] of consumedStates) if (expiresAt <= now) consumedStates.delete(key);
  const key = crypto.createHash('sha256').update(`${context}\0${state}`).digest('hex');
  if (consumedStates.has(key) || consumedStates.size >= MAX_CONSUMED_STATES) throw stateError();
  consumedStates.set(key, body.expiresAt);
  res.clearCookie(cookieName(req), cookieOptions(req));
  return { code, returnTo: safeReturnTo(body.returnTo) };
}

module.exports = { STATE_TTL_MS, safeReturnTo, successReturnTo, issueState, consumeState };
