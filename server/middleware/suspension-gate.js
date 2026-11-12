'use strict';

const { pool } = require('../models/database');
const Logger = require('../logger');
const { isTeamEditionCached } = require('../utils/instance-edition');
const { suspensionState } = require('../utils/policy/suspension');

const CACHE_TTL_MS = 10_000;
const cache = new Map();

const ALLOW_PREFIXES = [
  '/api/user/notifications',
  '/api/user/notification-settings',
  '/api/user/popup-notices',
  '/api/user/suspension',
  '/api/user/policies',
  '/api/user/policy-appeals',
  '/api/user/policy-approvals',
  '/api/csrf-token',
  '/api/instance',
  '/api/setup/status',
];

function pathnameOf(req) {
  return String(req.originalUrl || req.url || req.path || '/').split('?')[0];
}

function isAllowedPath(pathname) {
  return ALLOW_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isGatewayOrEventPath(pathname) {
  return pathname.startsWith('/api/client-events/')
    || pathname.startsWith('/api/chat/')
    || pathname.startsWith('/api/messages')
    || pathname.startsWith('/api/responses');
}

function invalidateSuspensionCache(userId) {
  if (userId == null) cache.clear();
  else cache.delete(Number(userId));
}

async function loadState(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.state;
  const result = await pool.query(
    `SELECT suspended_at, suspended_until, suspended_reason, suspended_scope
       FROM users WHERE id = $1`,
    [userId]
  );
  const state = suspensionState(result.rows[0]);
  if (state.expired) {
    cache.delete(userId);
    pool.query(
      `UPDATE users SET suspended_at = NULL, suspended_until = NULL, suspended_reason = NULL,
          suspended_scope = 'all', suspended_by = NULL
        WHERE id = $1 AND suspended_until IS NOT NULL AND suspended_until <= NOW()`,
      [userId]
    ).catch(() => {});
    return { suspended: false };
  }
  cache.set(userId, { state, at: Date.now() });
  if (cache.size > 5000) {
    const cutoff = Date.now() - CACHE_TTL_MS * 4;
    for (const [key, value] of cache) if (value.at < cutoff) cache.delete(key);
  }
  return state;
}

async function suspensionGate(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (req.authActor?.type !== 'session' || !req.session?.user) return next();
  const pathname = pathnameOf(req);
  if (isGatewayOrEventPath(pathname) || isAllowedPath(pathname)) return next();
  try {
    if (!(await isTeamEditionCached())) return next();
    const state = await loadState(Number(req.session.user.id));
    if (!state.suspended) return next();
    if (state.scope === 'api') return next();
    return res.status(403).json({
      error: `账号已被暂停${state.reason ? `：${state.reason}` : ''}`,
      type: 'member_suspended',
      code: 'member_suspended',
      suspended_until: state.until ? state.until.toISOString() : null,
      suspended_reason: state.reason || '',
      suspended_scope: state.scope || 'all',
    });
  } catch (error) {
    Logger.warn(`[策略] 暂停状态检查失败: ${error.message}`);
    return next();
  }
}

module.exports = { suspensionGate, invalidateSuspensionCache };
