const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PREFIXES = ['/auth/', '/oauth/', '/.well-known/'];

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
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  return `${protocol}://${host}`.replace(/\/$/, '');
}

function ensureCsrfToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

function csrfProtection(req, res, next) {
  if (!req.session || SAFE_METHODS.has(req.method)) return next();
  if (EXEMPT_PREFIXES.some(prefix => req.path.startsWith(prefix))) return next();
  // Bearer/OAuth API requests do not use the browser session cookie.
  if (req.headers.authorization?.startsWith('Bearer ')) return next();

  const expected = requestOrigin(req);
  const suppliedOrigin = getOrigin(req);
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
