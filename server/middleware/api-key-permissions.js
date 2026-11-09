'use strict';

const { matchPermission } = require('../utils/api-key-permissions');
const { PUBLIC_PREFIXES } = require('./request-auth');

function publicPath(pathname) {
  return PUBLIC_PREFIXES.some((regex) => regex.test(pathname));
}

/**
 * Enforce API Key permissions. Session requests keep using the existing account
 * authorization model; OAuth access tokens never reach this branch.
 */
function requireApiKeyPermission(req, res, next) {
  const actor = req.authActor;
  if (!actor || actor.type === 'session') return next();
  if (actor.type !== 'api_key') return next();

  let pathname = String(req.originalUrl || req.url || req.path || '/');
  try { pathname = new URL(pathname, 'http://local').pathname; } catch { /* keep original */ }
  if (publicPath(pathname)) return next();

  const permission = matchPermission(req.method, pathname);
  if (!permission) {
    return res.status(403).json({
      error: '该接口未配置 API Key 权限',
      code: 'permission_not_configured',
    });
  }
  if (permission.adminOnly && actor.user?.isAdmin !== true) {
    return res.status(403).json({
      error: '该权限仅限管理员',
      code: 'admin_required',
      permission: permission.id,
    });
  }
  const granted = Array.isArray(actor.key?.permissions) ? actor.key.permissions : [];
  if (!granted.includes(permission.id)) {
    return res.status(403).json({
      error: 'API Key 没有该权限',
      code: 'permission_denied',
      permission: permission.id,
    });
  }
  req.apiKeyPermission = permission.id;
  return next();
}

module.exports = { requireApiKeyPermission };
