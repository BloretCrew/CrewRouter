'use strict';

/**
 * 管理员维护第三方 OAuth 客户端。
 *
 * 内置首方客户端（Desktop / Helper / CLI）不可编辑；config.oauth.clients 声明的
 * 客户端只读；其余登记在 oauth_clients 表中，可在此创建、修改、轮换密钥和删除。
 */

const express = require('express');
const crypto = require('node:crypto');
const { pool } = require('../models/database');
const Logger = require('../logger');
const config = require('../config-loader');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { ACTIONS, logAction } = require('../utils/audit-log');
const oauthClients = require('../utils/oauth-clients');
const { ensureOAuthTables } = require('./oauth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{3,128}$/;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;

function failure(res, status, error, code) {
  return res.status(status).json({ success: false, error, ...(code ? { code } : {}) });
}

function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function generateClientId() {
  return `app_${crypto.randomBytes(16).toString('hex')}`;
}

function generateClientSecret() {
  return `crs_${crypto.randomBytes(32).toString('base64url')}`;
}

function parseScopes(input) {
  const scopes = oauthClients.normalizeScopes(input);
  if (!scopes || scopes.length === 0) return null;
  return scopes;
}

function parseRedirectUris(input) {
  const result = oauthClients.normalizeRedirectUris(input || []);
  if (!result.ok) return result;
  return { ok: true, value: result.value };
}

function validateClientPayload(body, { creating }) {
  const input = body || {};
  const name = cleanString(input.name, MAX_NAME_LENGTH);
  if (!name) return { error: '应用名称不能为空' };
  const type = input.type === 'confidential' ? 'confidential' : (input.type === 'public' ? 'public' : null);
  if (!type) return { error: '客户端类型只能是 public 或 confidential' };
  const scopes = parseScopes(input.scopes);
  if (!scopes) return { error: '至少选择一个有效权限' };
  const redirects = parseRedirectUris(input.redirectUris || input.redirect_uris);
  if (!redirects.ok) return { error: redirects.error };
  const allowLoopbackAnyPath = input.allowLoopbackAnyPath === true;
  if (redirects.value.length === 0 && !allowLoopbackAnyPath) {
    return { error: '至少填写一个回调地址' };
  }
  const description = cleanString(input.description, MAX_DESCRIPTION_LENGTH);
  const enabled = input.enabled !== false;
  let clientId = null;
  if (creating && input.clientId !== undefined && input.clientId !== '') {
    clientId = cleanString(input.clientId, 128);
    if (!CLIENT_ID_RE.test(clientId)) return { error: '客户端 ID 格式无效' };
  }
  return {
    value: {
      client_id: clientId,
      name,
      type,
      scopes,
      redirect_uris: redirects.value,
      allow_loopback_any_path: allowLoopbackAnyPath,
      description,
      enabled,
    },
  };
}

function audit(req, action, clientId, details) {
  const user = req.authUser || req.session?.user || {};
  logAction({
    userId: user.id,
    username: user.username,
    isAdmin: true,
    action: ACTIONS.ADMIN_OAUTH_CLIENT,
    resourceType: 'oauth_client',
    resourceId: clientId,
    description: details.description,
    details: details.data || {},
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    status: details.status || 200,
  }).catch(() => {});
}

function sortedScopes(value) {
  return JSON.stringify([...new Set(oauthClients.normalizeScopes(value, { allowReserved: true }) || [])].sort());
}

async function revokeClientTokens(conn, clientId) {
  const result = await conn.query(
    'UPDATE oauth_tokens SET revoked = TRUE WHERE client_id = $1 AND revoked = FALSE',
    [clientId]
  );
  return result.rowCount;
}

router.get('/', async (req, res) => {
  try {
    await ensureOAuthTables();
    const clients = await oauthClients.listClients(pool, config);
    res.json({
      success: true,
      clients: clients.map(oauthClients.adminClientView),
      scopes: Object.entries(oauthClients.SCOPE_DEFINITIONS)
        .filter(([, item]) => item.assignable)
        .map(([scope, item]) => ({ scope, description: item.description })),
    });
  } catch (error) {
    Logger.error('[OAuth客户端] 列表查询失败:', error.message);
    return failure(res, 503, 'OAuth 客户端暂不可用');
  }
});

router.post('/', async (req, res) => {
  const parsed = validateClientPayload(req.body, { creating: true });
  if (parsed.error) return failure(res, 400, parsed.error);
  const value = parsed.value;
  if (value.client_id && (oauthClients.BUILTIN_CLIENTS.some((client) => client.client_id === value.client_id)
      || oauthClients.configClients(config).some((client) => client.client_id === value.client_id))) {
    return failure(res, 409, '客户端 ID 已被内置或配置客户端占用', 'CLIENT_ID_CONFLICT');
  }

  const secret = value.type === 'confidential' ? generateClientSecret() : null;
  const clientId = value.client_id || generateClientId();
  try {
    await ensureOAuthTables();
    const result = await pool.query(
      `INSERT INTO oauth_clients
         (client_id, name, first_party, client_type, redirect_uris, scopes,
          allow_loopback_any_path, secret_hash, secret_hint, description, enabled)
       VALUES ($1, $2, FALSE, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10)
       ON CONFLICT (client_id) DO NOTHING
       RETURNING *`,
      [
        clientId,
        value.name,
        value.type,
        JSON.stringify(value.redirect_uris),
        JSON.stringify(value.scopes),
        value.allow_loopback_any_path,
        secret ? oauthClients.sha256Hex(secret) : null,
        secret ? secret.slice(0, 6) : null,
        value.description,
        value.enabled,
      ]
    );
    if (result.rows.length === 0) {
      return failure(res, 409, '客户端 ID 已存在', 'CLIENT_ID_CONFLICT');
    }
    const client = oauthClients.adminClientView({
      client_id: result.rows[0].client_id,
      name: result.rows[0].name,
      type: result.rows[0].client_type,
      first_party: false,
      enabled: result.rows[0].enabled,
      scopes: result.rows[0].scopes,
      redirect_uris: result.rows[0].redirect_uris,
      allow_loopback_any_path: result.rows[0].allow_loopback_any_path === true,
      secret_hash: result.rows[0].secret_hash,
      secret_hint: result.rows[0].secret_hint,
      description: result.rows[0].description,
      created_at: result.rows[0].created_at,
      updated_at: result.rows[0].updated_at,
      source: 'database',
      editable: true,
      builtin: false,
    });
    audit(req, ACTIONS.ADMIN_OAUTH_CLIENT, clientId, {
      description: `创建 OAuth 客户端「${value.name}」`,
      data: { type: value.type, scopes: value.scopes, redirectUris: value.redirect_uris },
    });
    res.status(201).json({
      success: true,
      client,
      ...(secret ? { client_secret: secret, warning: '客户端密钥只显示一次，请立即保存。' } : {}),
    });
  } catch (error) {
    Logger.error('[OAuth客户端] 创建失败:', error.message);
    return failure(res, 503, '创建 OAuth 客户端失败');
  }
});

async function loadEditableClient(clientId) {
  if (oauthClients.BUILTIN_CLIENTS.some((client) => client.client_id === clientId)) {
    return { error: '内置客户端不可编辑', status: 403, code: 'BUILTIN_CLIENT' };
  }
  if (oauthClients.configClients(config).some((client) => client.client_id === clientId)) {
    return { error: '配置文件声明的客户端不可在后台编辑', status: 403, code: 'CONFIG_CLIENT' };
  }
  const result = await pool.query('SELECT * FROM oauth_clients WHERE client_id = $1 LIMIT 1', [clientId]);
  if (!result.rows[0]) return { error: '客户端不存在', status: 404, code: 'NOT_FOUND' };
  return { row: result.rows[0] };
}

router.put('/:clientId', async (req, res) => {
  const clientId = String(req.params.clientId || '');
  if (!CLIENT_ID_RE.test(clientId)) return failure(res, 400, '客户端 ID 格式无效');
  const parsed = validateClientPayload(req.body, { creating: false });
  if (parsed.error) return failure(res, 400, parsed.error);
  const value = parsed.value;
  const rotateSecret = req.body?.rotateSecret === true;

  let conn;
  try {
    await ensureOAuthTables();
    const loaded = await loadEditableClient(clientId);
    if (loaded.error) return failure(res, loaded.status, loaded.error, loaded.code);
    const current = loaded.row;
    const needsSecret = value.type === 'confidential' && !current.secret_hash;
    if (needsSecret && !rotateSecret) {
      return failure(res, 400, '机密客户端需要密钥，请同时执行轮换密钥', 'SECRET_REQUIRED');
    }
    const secret = value.type === 'confidential' && (needsSecret || rotateSecret) ? generateClientSecret() : null;
    const shouldRevokeTokens = value.enabled === false
      || Boolean(secret)
      || current.client_type !== value.type
      || sortedScopes(current.scopes) !== sortedScopes(value.scopes);
    conn = await pool.connect();
    await conn.query('BEGIN');
    const result = await conn.query(
      `UPDATE oauth_clients
          SET name = $2, client_type = $3, redirect_uris = $4::jsonb, scopes = $5::jsonb,
              description = $6, enabled = $7, allow_loopback_any_path = $8,
              secret_hash = CASE WHEN $9::text IS NULL THEN secret_hash ELSE $9 END,
              secret_hint = CASE WHEN $9::text IS NULL THEN secret_hint ELSE $10 END,
              updated_at = now()
        WHERE client_id = $1
        RETURNING *`,
      [
        clientId,
        value.name,
        value.type,
        JSON.stringify(value.redirect_uris),
        JSON.stringify(value.scopes),
        value.description,
        value.enabled,
        value.allow_loopback_any_path,
        secret ? oauthClients.sha256Hex(secret) : null,
        secret ? secret.slice(0, 6) : null,
      ]
    );
    let revokedTokens = 0;
    if (shouldRevokeTokens) revokedTokens = await revokeClientTokens(conn, clientId);
    await conn.query('COMMIT');
    const row = result.rows[0];
    const client = oauthClients.adminClientView({
      client_id: row.client_id,
      name: row.name,
      type: row.client_type,
      first_party: row.first_party === true,
      enabled: row.enabled,
      scopes: row.scopes,
      redirect_uris: row.redirect_uris,
      allow_loopback_any_path: row.allow_loopback_any_path === true,
      secret_hash: row.secret_hash,
      secret_hint: row.secret_hint,
      description: row.description,
      created_at: row.created_at,
      updated_at: row.updated_at,
      source: 'database',
      editable: true,
      builtin: false,
    });
    audit(req, ACTIONS.ADMIN_OAUTH_CLIENT, clientId, {
      description: `更新 OAuth 客户端「${value.name}」`,
      data: { type: value.type, scopes: value.scopes, redirectUris: value.redirect_uris, enabled: value.enabled, rotatedSecret: Boolean(secret), revokedTokens },
    });
    res.json({
      success: true,
      client,
      revokedTokens,
      ...(secret ? { client_secret: secret, warning: '客户端密钥只显示一次，请立即保存。' } : {}),
    });
  } catch (error) {
    if (conn) await conn.query('ROLLBACK').catch(() => {});
    Logger.error('[OAuth客户端] 更新失败:', error.message);
    return failure(res, 503, '更新 OAuth 客户端失败');
  } finally {
    if (conn) conn.release();
  }
});

router.post('/:clientId/rotate-secret', async (req, res) => {
  const clientId = String(req.params.clientId || '');
  if (!CLIENT_ID_RE.test(clientId)) return failure(res, 400, '客户端 ID 格式无效');
  let conn;
  try {
    await ensureOAuthTables();
    const loaded = await loadEditableClient(clientId);
    if (loaded.error) return failure(res, loaded.status, loaded.error, loaded.code);
    if (loaded.row.client_type !== 'confidential') {
      return failure(res, 409, '公共客户端不使用客户端密钥', 'PUBLIC_CLIENT');
    }
    const secret = generateClientSecret();
    conn = await pool.connect();
    await conn.query('BEGIN');
    const result = await conn.query(
      `UPDATE oauth_clients
          SET secret_hash = $2, secret_hint = $3, updated_at = now()
        WHERE client_id = $1
        RETURNING *`,
      [clientId, oauthClients.sha256Hex(secret), secret.slice(0, 6)]
    );
    const revokedTokens = await revokeClientTokens(conn, clientId);
    await conn.query('COMMIT');
    const row = result.rows[0];
    audit(req, ACTIONS.ADMIN_OAUTH_CLIENT, clientId, {
      description: `轮换 OAuth 客户端「${row.name}」密钥`,
      data: { rotatedSecret: true, revokedTokens },
    });
    res.json({
      success: true,
      client: oauthClients.adminClientView({
        client_id: row.client_id,
        name: row.name,
        type: row.client_type,
        first_party: row.first_party === true,
        enabled: row.enabled,
        scopes: row.scopes,
        redirect_uris: row.redirect_uris,
        allow_loopback_any_path: row.allow_loopback_any_path === true,
        secret_hash: row.secret_hash,
        secret_hint: row.secret_hint,
        description: row.description,
        created_at: row.created_at,
        updated_at: row.updated_at,
        source: 'database',
        editable: true,
        builtin: false,
      }),
      client_secret: secret,
      revokedTokens,
      warning: '客户端密钥只显示一次，请立即保存。',
    });
  } catch (error) {
    if (conn) await conn.query('ROLLBACK').catch(() => {});
    Logger.error('[OAuth客户端] 轮换密钥失败:', error.message);
    return failure(res, 503, '轮换客户端密钥失败');
  } finally {
    if (conn) conn.release();
  }
});

router.delete('/:clientId', async (req, res) => {
  const clientId = String(req.params.clientId || '');
  if (!CLIENT_ID_RE.test(clientId)) return failure(res, 400, '客户端 ID 格式无效');
  let conn;
  try {
    await ensureOAuthTables();
    const loaded = await loadEditableClient(clientId);
    if (loaded.error) return failure(res, loaded.status, loaded.error, loaded.code);
    conn = await pool.connect();
    await conn.query('BEGIN');
    const deleted = await conn.query('DELETE FROM oauth_clients WHERE client_id = $1 RETURNING client_id', [clientId]);
    if (deleted.rowCount === 0) {
      await conn.query('ROLLBACK');
      return failure(res, 404, '客户端不存在', 'NOT_FOUND');
    }
    await conn.query('DELETE FROM oauth_auth_codes WHERE client_id = $1', [clientId]);
    const revoked = await conn.query(
      'UPDATE oauth_tokens SET revoked = TRUE WHERE client_id = $1 AND revoked = FALSE',
      [clientId]
    );
    await conn.query('COMMIT');
    audit(req, ACTIONS.ADMIN_OAUTH_CLIENT, clientId, {
      description: `删除 OAuth 客户端「${loaded.row.name}」`,
      data: { revokedTokens: revoked.rowCount },
    });
    res.json({ success: true, revokedTokens: revoked.rowCount });
  } catch (error) {
    if (conn) await conn.query('ROLLBACK').catch(() => {});
    Logger.error('[OAuth客户端] 删除失败:', error.message);
    return failure(res, 503, '删除 OAuth 客户端失败');
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
