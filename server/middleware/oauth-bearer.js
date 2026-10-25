/**
 * OAuth Bearer 鉴权中间件（双鉴权入口）
 *
 * Authorization: Bearer crh_... → 走自有 oauth_tokens 校验（sha256 哈希比对、
 *   kind=access、未吊销未过期），由普通 Key 鉴权流程加载绑定的所有人及策略
 *   （不缓存 OAuth 凭据，另附 viaOAuth/oauthScope 标记）。
 * 其他凭证（cr-sk-... 等）→ 原样回落已导出的 api.js validateApiKey，老路径零影响。
 */

const crypto = require('crypto');
const { pool } = require('../models/database');
const Logger = require('../logger');
const { ensureOAuthTables } = require('../routes/oauth');

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** 按 OAuth token 所调用的端点族确定必需 scope */
function requiredScope(req) {
  const base = req.baseUrl || '';
  const url = req.originalUrl || req.url || '';
  if (base.includes('client-events') || url.startsWith('/api/client-events')) return 'events:report';
  // 网关端点（/v1/* 及同路由表的 /api/chat|models|messages|responses）一律要求 gateway:invoke
  return 'gateway:invoke';
}

async function oauthBearer(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith(`Bearer crh_`)) {
    // 惰性解引用：本模块与 routes/api.js 存在加载环（api.js 挂载点引用了本模块），
    // 请求期再取 validateApiKey 可避开循环初始化拿到 undefined
    const { validateApiKey } = require('../routes/api');
    return validateApiKey(req, res, next);
  }
  return authenticateOAuthAccessToken(req, res, next);
}

module.exports = { oauthBearer };

async function authenticateOAuthAccessToken(req, res, next) {
  const token = req.headers.authorization.slice('Bearer '.length);

  const deny = (status, error, message) => {
    res.set('WWW-Authenticate', `Bearer error="${error}"`);
    return res.status(status).json({ ok: false, error: message || error });
  };

  try {
    await ensureOAuthTables();

    const found = await pool.query(`SELECT * FROM oauth_tokens WHERE token_hash = $1`, [sha256Hex(token)]);
    const row = found.rows[0];
    if (!row || row.kind !== 'access') {
      return deny(401, 'invalid_token', 'invalid access token');
    }
    if (row.revoked) {
      return deny(401, 'invalid_token', 'token has been revoked');
    }
    if (!Number.isFinite(new Date(row.expires_at).getTime()) || new Date(row.expires_at).getTime() <= Date.now()) {
      return deny(401, 'invalid_token', 'token expired');
    }

    // scope 校验：网关端点需 gateway:invoke，client-events 需 events:report
    const required = requiredScope(req);
    const granted = String(row.scope || '').split(/\s+/).filter(Boolean);
    if (!granted.includes(required)) {
      Logger.warn(`[OAuth鉴权] scope 不足: 需要 ${required}, 实际 "${row.scope}", path=${req.originalUrl}`);
      return deny(403, 'insufficient_scope', `token missing required scope: ${required}`);
    }

    // Use the ordinary key pipeline for ownership, lifecycle, model access,
    // quotas, limits and all per-key settings. Never cache an OAuth token as a key.
    const { validateBoundApiKey } = require('../routes/api');
    return await validateBoundApiKey(req, res, () => {
      req.apiUser.viaOAuth = true;
      req.apiUser.oauthClientId = row.client_id;
      req.apiUser.oauthScope = row.scope;
      pool.query(`UPDATE oauth_tokens SET last_used_at = now() WHERE id = $1`, [row.id])
        .catch((err) => Logger.warn('[OAuth鉴权] 更新 last_used_at 失败:', err.message));
      return next();
    }, { keyId: row.api_key_id, userId: row.user_id });
  } catch (err) {
    Logger.error('[OAuth鉴权] 错误:', err.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
}
