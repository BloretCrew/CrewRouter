const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// These exchanges authenticate with the supplied token/code, never a browser session.
const TOKEN_ENDPOINTS = new Set(['/oauth/token', '/oauth/revoke']);

function allowedOrigins(req) {
  const configured = req.app?.locals?.csrfAllowedOrigins || [];
  const values = Array.isArray(configured) ? configured : [configured];
  return new Set([requestOrigin(req), ...values.map(value => String(value || '').replace(/\/$/, '')).filter(Boolean)]);
}

function getOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (origin) return origin.replace(/\/$/, '');
  const referer = String(req.headers.referer || '').trim();
  if (!referer) return '';
  try { return new URL(referer).origin; } catch (_) { return ''; }
}

function requestOrigin(req) {
  const host = req.get('host');
  if (!host) return '';
  // Express applies the configured proxy trust policy to req.protocol.
  const protocol = req.protocol;
  return `${protocol}://${host}`.replace(/\/$/, '');
}

function ensureCsrfToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

function csrfProtection(req, res, next) {
  if (!req.session || SAFE_METHODS.has(req.method)) return next();
  const path = String(req.path || '').toLowerCase().replace(/\/+$/, '');
  if (req.method === 'POST' && TOKEN_ENDPOINTS.has(path)) return next();
  const suppliedOrigin = getOrigin(req);
  // Electron's main process exchanges a one-time code using JSON without browser
  // headers. A browser form or cross-origin fetch must still pass the normal guard.
  const hasBrowserHeaders = Object.keys(req.headers).some(name =>
    name === 'origin' || name === 'referer' || name.startsWith('sec-fetch-'));
  if (req.method === 'POST' && path === '/oauth/desktop-session'
      && !hasBrowserHeaders
      && /^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return next();
  // Auth endpoints and the store's independent bl_store_session cookie never
  // become API-key requests merely because Core has no logged-in session user.
  if (!/^\/(?:auth|oauth|store)(?:\/|$)/.test(path) && !req.session.user
      && (req.headers.authorization?.startsWith('Bearer ') || req.headers['x-api-key'])) return next();

  const suppliedToken = req.get('x-csrf-token') || req.body?._csrf;
  const suppliedBuffer = Buffer.from(String(suppliedToken || ''));
  const expectedBuffer = Buffer.from(String(req.session.csrfToken || ''));
  const tokenValid = suppliedBuffer.length === expectedBuffer.length
    && suppliedBuffer.length > 0
    && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  if ((suppliedOrigin && allowedOrigins(req).has(suppliedOrigin)) || tokenValid) return next();
  return res.status(403).json({ error: 'CSRF 校验失败', type: 'csrf_failed' });
}

function csrfTokenRoute(req, res) {
  res.json({ token: ensureCsrfToken(req) });
}

module.exports = { csrfProtection, csrfTokenRoute, ensureCsrfToken };
