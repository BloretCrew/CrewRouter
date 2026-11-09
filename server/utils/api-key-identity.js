'use strict';

const crypto = require('node:crypto');

const API_KEY_PREFIX = 'sk-';
const OAUTH_TOKEN_PREFIX = 'crh_';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * 提取请求中的原始 API Key。OAuth access token（crh_）不在这里处理，
 * 由 oauthBearer 按 scope 校验，避免把两种凭证混为一谈。
 */
function extractApiKey(req) {
  const header = req?.headers?.['x-api-key'];
  let value = typeof header === 'string' ? header.trim() : '';
  if (!value && typeof req?.headers?.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')) {
    value = req.headers.authorization.slice('Bearer '.length).trim();
  }
  if (!value || value.startsWith(OAUTH_TOKEN_PREFIX)) return null;
  return value;
}

function isOAuthBearer(req) {
  return typeof req?.headers?.authorization === 'string'
    && req.headers.authorization.startsWith(`Bearer ${OAUTH_TOKEN_PREFIX}`);
}

function normalizePermissions(value) {
  if (Array.isArray(value)) return [...new Set(value.filter((item) => typeof item === 'string' && item))];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? [...new Set(parsed.filter((item) => typeof item === 'string' && item))] : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 控制台/非网关 Key 鉴权使用的轻量查询：只校验 Key 生命周期与用户身份，
 * 不执行额度、模型授权、注入提示词、插件钩子等网关语义。
 */
async function loadApiKeyIdentity(db, rawKey) {
  if (typeof rawKey !== 'string' || !rawKey || rawKey.length > 512) return { error: 'invalid' };
  const result = await db.query(
    `SELECT ak.id, ak.user_id, ak.name, ak.enabled, ak.expires_at, ak.permissions,
            u.id AS owner_id, u.username, u.email, u.is_admin, u.team_id
       FROM api_keys ak
       JOIN users u ON u.id = ak.user_id
      WHERE ak.key_value = $1 OR ak.key_hash = $2
      LIMIT 1`,
    [rawKey, sha256Hex(rawKey)]
  );
  const row = result.rows[0];
  if (!row) return { error: 'invalid' };
  if (row.enabled === false) return { error: 'disabled' };
  if (row.expires_at != null) {
    const expiresAt = new Date(row.expires_at).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return { error: 'expired' };
  }
  return {
    actor: {
      type: 'api_key',
      user: {
        id: Number(row.owner_id),
        username: row.username || '',
        email: row.email || '',
        isAdmin: row.is_admin === true,
        teamId: row.team_id == null ? null : Number(row.team_id),
      },
      key: {
        id: Number(row.id),
        name: row.name || '',
        permissions: normalizePermissions(row.permissions),
        ownerUserId: Number(row.user_id),
      },
    },
  };
}

module.exports = {
  API_KEY_PREFIX,
  OAUTH_TOKEN_PREFIX,
  sha256Hex,
  extractApiKey,
  isOAuthBearer,
  normalizePermissions,
  loadApiKeyIdentity,
};
