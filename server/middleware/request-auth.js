'use strict';

const { pool } = require('../models/database');
const Logger = require('../logger');
const { extractApiKey, isOAuthBearer, loadApiKeyIdentity } = require('../utils/api-key-identity');

// These routes depend on session state or change credentials; API Key must never
// satisfy them, even if the key belongs to an administrator.
const SESSION_ONLY = [
  /^\/auth(?:\/|$)/,
  /^\/api\/2fa(?:\/|$)/,
  /^\/api\/passkey(?:\/|$)/,
  /^\/api\/setup(?:\/|$)/,
  /^\/api\/admin\/update(?:\/|$)/,
  /^\/oauth\/authorize(?:\/|$)/,
  /^\/oauth\/authorizations(?:\/|$)/,
  /^\/api\/user\/model-trace(?:\/|$)/,
];

// Existing oauthBearer endpoints validate raw API keys themselves, including
// gateway-specific quotas/model policy. Avoid resolving the same key twice.
const GATEWAY_OR_EVENTS = [
  /^\/v1(?:\/|$)/,
  /^\/api\/(?:chat\/completions|models|messages|responses)(?:\/|$)/,
  /^\/api\/client-events(?:\/|$)/,
];

const PUBLIC_PREFIXES = [
  /^\/api\/i18n(?:\/|$)/,
  /^\/api\/version(?:\/|$)/,
  /^\/api\/config(?:\/|$)/,
  /^\/api\/instance(?:\/|$)/,
  /^\/api\/updates\/latest(?:\/|$)/,
  /^\/api\/csrf-token(?:\/|$)/,
  /^\/api\/login-report(?:\/|$)/,
  /^\/api\/stats-report(?:\/|$)/,
  /^\/api\/user\/docs-content(?:\/|$)/,
  /^\/oauth\/token(?:\/|$)/,
  /^\/oauth\/revoke(?:\/|$)/,
  /^\/oauth\/desktop-session(?:\/|$)/,
  /^\/\.well-known(?:\/|$)/,
  /^\/store(?:\/|$)/,
];

function matches(list, pathname) {
  return list.some((regex) => regex.test(pathname));
}

function authError(res, status, error, code) {
  return res.status(status).json({ error, ...(code ? { code } : {}) });
}

/**
 * Request-scoped actor resolution.
 *
 * - API Key header present: resolve the key owner as the actor; never fall back
 *   to the session if the key is invalid.
 * - OAuth Bearer token: leave it to oauthBearer on gateway/event paths; reject
 *   it on console paths so it cannot borrow a browser session.
 * - No key: session actor (isAdmin is refreshed by requireAuth).
 */
async function resolveRequestAuth(req, res, next) {
  req.authActor = null;
  req.authUser = null;
  const pathname = String(req.path || '/');
  const key = extractApiKey(req);

  if (!key) {
    if (req.session?.user) {
      req.authActor = { type: 'session', user: req.session.user, key: null };
      req.authUser = req.session.user;
    }
    if (isOAuthBearer(req) && !matches(GATEWAY_OR_EVENTS, pathname) && !matches(PUBLIC_PREFIXES, pathname)) {
      if (matches(SESSION_ONLY, pathname)) return authError(res, 403, '该接口仅支持登录会话', 'session_required');
      return authError(res, 401, 'OAuth 访问令牌不能用于该接口', 'oauth_token_not_allowed');
    }
    return next();
  }

  if (matches(SESSION_ONLY, pathname)) {
    return authError(res, 403, '该接口仅支持登录会话', 'session_required');
  }

  // Gateway and client-events routes keep their existing validator so quotas,
  // model policy, plugin hooks and OAuth-bound keys continue to work unchanged.
  if (matches(GATEWAY_OR_EVENTS, pathname) || matches(PUBLIC_PREFIXES, pathname)) return next();

  try {
    const result = await loadApiKeyIdentity(pool, key);
    if (!result.actor) {
      if (result.error === 'disabled') return authError(res, 403, 'API Key 已停用', 'key_disabled');
      if (result.error === 'expired') return authError(res, 401, 'API Key 已过期', 'key_expired');
      return authError(res, 401, '无效的 API Key', 'invalid_api_key');
    }
    req.authActor = result.actor;
    req.authUser = result.actor.user;
    return next();
  } catch (error) {
    Logger.error('[Key鉴权] 解析失败:', error.message);
    return authError(res, 503, '鉴权暂不可用', 'auth_unavailable');
  }
}

module.exports = { resolveRequestAuth, SESSION_ONLY, GATEWAY_OR_EVENTS, PUBLIC_PREFIXES };
