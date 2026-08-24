/**
 * CrewRouter 自有 OAuth 2.0 授权服务（一期，方案 C）
 *
 * 与 Bloret Passport 无关；SSO 复用控制台自身 session（middleware/auth.js 的 requireAuth）。
 *
 * 端点：
 *  - GET  /oauth/authorize                        授权入口（requireAuth，渲染确认页）
 *  - GET  /oauth/authorize/info                   确认页数据（client 名/scope/用户 API Key 列表）
 *  - POST /oauth/authorize/approve                用户同意/拒绝 → 302 回 loopback（10min 一次性 code）
 *  - POST /oauth/token                            authorization_code + refresh_token 双 grant
 *  - GET  /.well-known/oauth-authorization-server RFC 8414 元数据
 *
 * 设计要点（见 .hermes/plans/20260824_oauth_server_plan_c.md）：
 *  - PKCE S256 强制，所有 client 不设例外
 *  - loopback 回调放开端口：^http://127\.0\.0\.1:\d+/（RFC 8252 惯例）
 *  - token 库内只存 sha256，原文仅签发响应出现一次
 *  - refresh 轮换 + 重用侦测：旧 refresh 第二次使用 → 吊销同链全部 token
 *    （access 行的 rotated_from 指向同批签发的 refresh 行，使链上遍历可覆盖每代 access）
 *  - 三张表在路由内懒建（参考 client-events.js），不动 init-db.js DDL
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('../models/database');
const Logger = require('../logger');
const config = require('../config-loader');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ---------- 常量 ----------
const ACCESS_TTL_SEC = 24 * 3600;          // access 24h
const REFRESH_TTL_SEC = 30 * 24 * 3600;    // refresh 30d
const CODE_TTL_SEC = 10 * 60;              // 授权码 10min、一次性
const OAUTH_TOKEN_PREFIX = 'crh_';

// loopback 回调放开端口（RFC 8252）；一期只有首方 client，不做第三方注册
const LOOPBACK_REDIRECT_RE = /^http:\/\/127\.0\.0\.1:\d+\/.*/;

// 首方 client 种子与其 scope 白名单（scope 枚举第三项 console:read 预留、暂无 client 使用）
const FIRST_PARTY_CLIENTS = [
  { client_id: 'crewrouter-helper', name: 'CrewRouter Helper', scopes: ['events:report'] },
  { client_id: 'crewrouter-cli', name: 'CrewRouter CLI', scopes: ['gateway:invoke'] },
];

function getClient(clientId) {
  return FIRST_PARTY_CLIENTS.find((c) => c.client_id === clientId) || null;
}

/** 解析并校验 scope：空则取 client 默认全集；含白名单之外的项返回 null */
function normalizeScope(scopeStr, client) {
  const requested = String(scopeStr || '').split(/[\s+]+/).filter(Boolean);
  const list = requested.length > 0 ? requested : client.scopes;
  if (!list.every((s) => client.scopes.includes(s))) return null;
  return list.join(' ');
}

// ---------- 静态页路径（开发 server/ 下 public 在上层；构建后 dist/ 内同级） ----------
const PUBLIC_DIR = (() => {
  const candidates = [path.join(__dirname, '../../public'), path.join(__dirname, '../public')];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(__dirname, '../public');
})();

// ---------- 工具 ----------
function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function randomToken() {
  return OAUTH_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function randomCode() {
  return crypto.randomBytes(32).toString('base64url');
}

/** PKCE S256：base64url(sha256(verifier)) 与 challenge 恒时比较 */
function pkceMatches(verifier, challenge) {
  try {
    const digest = crypto.createHash('sha256').update(String(verifier), 'ascii').digest();
    const expected = Buffer.from(String(challenge), 'base64url');
    return digest.length === expected.length && crypto.timingSafeEqual(digest, expected);
  } catch (e) {
    return false;
  }
}

/** 给 redirect_uri 追加查询参数（目标可能是带 query 的 loopback 地址） */
function appendQuery(uri, params) {
  const sep = uri.includes('?') ? '&' : '?';
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return uri + sep + qs;
}

// ---------- 建表（懒执行一次；并发下 CREATE IF NOT EXISTS 幂等） ----------
let tablesReady = false;

async function ensureOAuthTables() {
  if (tablesReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id  TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      first_party BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_auth_codes (
      code           TEXT PRIMARY KEY,
      client_id      TEXT NOT NULL,
      user_id        INTEGER NOT NULL,
      api_key_id     INTEGER,
      scope          TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      expires_at     TIMESTAMPTZ NOT NULL,
      used           BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id            BIGSERIAL PRIMARY KEY,
      token_hash    TEXT NOT NULL UNIQUE,
      user_id       INTEGER NOT NULL,
      api_key_id    INTEGER,
      client_id     TEXT NOT NULL,
      scope         TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('access','refresh')),
      expires_at    TIMESTAMPTZ NOT NULL,
      revoked       BOOLEAN NOT NULL DEFAULT FALSE,
      rotated_from  BIGINT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at  TIMESTAMPTZ
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expires ON oauth_auth_codes (expires_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_oauth_tokens_rotated_from ON oauth_tokens (rotated_from)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens (user_id)`);

  // 首方种子 client：存在即跳过
  for (const c of FIRST_PARTY_CLIENTS) {
    await pool.query(
      `INSERT INTO oauth_clients (client_id, name, first_party) VALUES ($1, $2, TRUE)
       ON CONFLICT (client_id) DO NOTHING`,
      [c.client_id, c.name]
    );
  }

  // 轻量清理：超过 1 天的过期授权码
  await pool.query(`DELETE FROM oauth_auth_codes WHERE expires_at < now() - interval '1 day'`);

  tablesReady = true;
}

// ---------- authorize 参数校验（GET 页面 / info / approve 共用） ----------
function validateAuthorizeParams(query) {
  const client = getClient(query.client_id);
  if (!client) return { error: 'invalid_client' };
  if (query.response_type && query.response_type !== 'code') return { error: 'unsupported_response_type' };
  const redirectUri = String(query.redirect_uri || '');
  if (!LOOPBACK_REDIRECT_RE.test(redirectUri)) return { error: 'invalid_redirect_uri' };
  const scope = normalizeScope(query.scope, client);
  if (!scope) return { error: 'invalid_scope' };
  const challenge = String(query.code_challenge || '');
  if (!challenge) return { error: 'invalid_request' };
  if (query.code_challenge_method && query.code_challenge_method !== 'S256') {
    return { error: 'invalid_request' };
  }
  return {
    client,
    redirectUri,
    scope,
    codeChallenge: challenge,
    state: String(query.state || ''),
  };
}

/** HTML 导航入口未登录 → 302 登录页（JSON 401 只适合 XHR） */
function requireAuthHtml(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/?error=login_required');
  }
  next();
}

function renderAuthorizeError(res, desc) {
  res.status(400).send(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">` +
    `<link rel="stylesheet" href="/css/themes.css"><link rel="stylesheet" href="/css/main.css">` +
    `<title>授权失败</title></head><body style="font-family:var(--font-sans,system-ui);` +
    `background:var(--background,#f9fafb);display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">` +
    `<div style="background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:14px;` +
    `padding:32px;max-width:420px;text-align:center;"><div style="font-size:16px;font-weight:600;margin-bottom:8px;">` +
    `无法继续授权</div><div style="font-size:14px;color:var(--muted-foreground,#6b7280);">${desc}</div>` +
    `</div></body></html>`
  );
}

// ---------- 授权入口（控制台 session 即 SSO） ----------
router.get('/oauth/authorize', requireAuthHtml, async (req, res) => {
  await ensureOAuthTables();
  const v = validateAuthorizeParams(req.query);
  if (v.error) {
    Logger.warn(`[OAuth授权] 参数校验失败: ${v.error} client=${req.query.client_id}`);
    return renderAuthorizeError(res, '授权链接无效或已过期，请从客户端重新发起。');
  }
  // 校验通过后交由独立确认页（读取 URL 参数自行拉取 info 数据）
  res.sendFile(path.join(PUBLIC_DIR, 'pages/oauth-consent.html'));
});

// ---------- 确认页数据：应用名 / scope / 该用户的 API Key 列表 ----------
router.get('/oauth/authorize/info', requireAuth, async (req, res) => {
  await ensureOAuthTables();
  const v = validateAuthorizeParams(req.query);
  if (v.error) {
    return res.status(400).json({ ok: false, error: v.error });
  }
  const keys = await pool.query(
    `SELECT id, name FROM api_keys WHERE user_id = $1 AND enabled = TRUE ORDER BY id ASC LIMIT 100`,
    [req.session.user.id]
  );
  res.json({
    client: { id: v.client.client_id, name: v.client.name },
    scopes: v.scope.split(/\s+/),
    redirectUri: v.redirectUri,
    state: v.state,
    apiKeys: keys.rows.map((k) => ({ id: k.id, name: k.name || '' })),
    defaultApiKeyId: keys.rows.length > 0 ? keys.rows[0].id : null,
  });
});

// ---------- 同意/拒绝：签发一次性 code 并 302 回 loopback ----------
router.post('/oauth/authorize/approve', requireAuth, async (req, res) => {
  await ensureOAuthTables();
  const body = req.body || {};
  const decision = body.decision === 'deny' ? 'deny' : 'approve';
  const v = validateAuthorizeParams(body);
  if (v.error) {
    Logger.warn(`[OAuth授权] approve 参数校验失败: ${v.error} user=${req.session.user.id}`);
    return renderAuthorizeError(res, '授权请求参数无效，请从客户端重新发起。');
  }

  // 拒绝：按 RFC 6749 §4.1.2.1 回 error=access_denied
  if (decision === 'deny') {
    Logger.info(`[OAuth授权] 用户 ${req.session.user.username} 拒绝了 ${v.client.client_id} 的授权`);
    return res.redirect(302, appendQuery(v.redirectUri, { error: 'access_denied', state: v.state }));
  }

  // 所选 API Key 必须属于当前用户且启用（默认取第一个启用的 key）
  let apiKeyId = parseInt(body.api_key_id, 10);
  if (!Number.isInteger(apiKeyId)) {
    const first = await pool.query(
      `SELECT id FROM api_keys WHERE user_id = $1 AND enabled = TRUE ORDER BY id ASC LIMIT 1`,
      [req.session.user.id]
    );
    apiKeyId = first.rows[0]?.id ?? null;
  } else {
    const own = await pool.query(
      `SELECT id FROM api_keys WHERE id = $1 AND user_id = $2 AND enabled = TRUE`,
      [apiKeyId, req.session.user.id]
    );
    if (own.rows.length === 0) {
      return renderAuthorizeError(res, '所选 API Key 不存在或已停用。');
    }
  }

  const code = randomCode();
  await pool.query(
    `INSERT INTO oauth_auth_codes (code, client_id, user_id, api_key_id, scope, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)`,
    [code, v.client.client_id, req.session.user.id, apiKeyId, v.scope, v.codeChallenge, String(CODE_TTL_SEC)]
  );

  Logger.info(`[OAuth授权] 用户 ${req.session.user.username} 同意 ${v.client.client_id}（scope=${v.scope}, key=${apiKeyId}）`);
  res.redirect(302, appendQuery(v.redirectUri, { code, state: v.state }));
});

// ---------- 签发 token 对（库内只存哈希） ----------
// access 行的 rotated_from 指向同批签发的 refresh 行：让吊销链遍历能覆盖每一代 access
async function issueTokenPair(clientId, userId, apiKeyId, scope) {
  const accessToken = randomToken();
  const refreshToken = randomToken();

  const r = await pool.query(
    `INSERT INTO oauth_tokens (token_hash, user_id, api_key_id, client_id, scope, kind, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'refresh', now() + ($6 || ' seconds')::interval)
     RETURNING id`,
    [sha256Hex(refreshToken), userId, apiKeyId, clientId, scope, String(REFRESH_TTL_SEC)]
  );
  const refreshId = r.rows[0].id;

  await pool.query(
    `INSERT INTO oauth_tokens (token_hash, user_id, api_key_id, client_id, scope, kind, expires_at, rotated_from)
     VALUES ($1, $2, $3, $4, $5, 'access', now() + ($6 || ' seconds')::interval, $7)`,
    [sha256Hex(accessToken), userId, apiKeyId, clientId, scope, String(ACCESS_TTL_SEC), refreshId]
  );

  return { accessToken, refreshToken, refreshId };
}

// ---------- 吊销整条轮换链：向上找根，再向下递归吊销全部后代 ----------
// （rotated_from 同时承载两种父子边：refresh→下一代 refresh、refresh→同批 access，
//   因此自根向下的递归可覆盖链上每一代 token）
async function revokeChain(tokenRow, reason = '检测到 refresh 重用') {
  let rootId = tokenRow.id;
  for (let i = 0; i < 64; i++) {
    const up = await pool.query(`SELECT rotated_from FROM oauth_tokens WHERE id = $1`, [rootId]);
    const parent = up.rows[0]?.rotated_from;
    if (!parent) break;
    rootId = parent;
  }
  await pool.query(
    `WITH RECURSIVE down AS (
       SELECT id FROM oauth_tokens WHERE id = $1
       UNION ALL
       SELECT t.id FROM oauth_tokens t JOIN down d ON t.rotated_from = d.id
     )
     UPDATE oauth_tokens SET revoked = TRUE WHERE id IN (SELECT id FROM down)`,
    [rootId]
  );
  Logger.warn(`[OAuth授权] ${reason}，已吊销全链（root=#${rootId} client=${tokenRow.client_id} user=${tokenRow.user_id}）`);
}

function sendTokenError(res, error, description) {
  return res.status(400).json({ error, ...(description ? { error_description: description } : {}) });
}

// ---------- token 端点（机器调用，无 session） ----------
router.post('/oauth/token', async (req, res) => {
  await ensureOAuthTables();
  const p = req.body || {};

  if (p.grant_type === 'authorization_code') {
    return handleAuthorizationCodeGrant(p, res);
  }
  if (p.grant_type === 'refresh_token') {
    return handleRefreshTokenGrant(p, res);
  }
  return sendTokenError(res, 'unsupported_grant_type');
});

async function handleAuthorizationCodeGrant(p, res) {
  const { code, client_id: clientId, code_verifier: verifier } = p;
  if (!code || !clientId || !verifier) {
    return sendTokenError(res, 'invalid_request', 'code / client_id / code_verifier 均为必填');
  }

  const found = await pool.query(`SELECT * FROM oauth_auth_codes WHERE code = $1`, [String(code)]);
  const row = found.rows[0];
  if (!row || row.client_id !== clientId) {
    return sendTokenError(res, 'invalid_grant');
  }

  // 原子认领保证一次性：并发/重放只可能有一方成功
  // （先认领后验 PKCE：错误 verifier 也会烧掉 code，阻止对 challenge 的暴力枚举）
  const claim = await pool.query(`UPDATE oauth_auth_codes SET used = TRUE WHERE code = $1 AND used = FALSE RETURNING code`, [String(code)]);
  if (claim.rowCount === 0) {
    Logger.warn(`[OAuth授权] code 重放被拒: client=${clientId}`);
    return sendTokenError(res, 'invalid_grant', '授权码已被使用或不存在');
  }

  if (new Date(row.expires_at) < new Date()) {
    return sendTokenError(res, 'invalid_grant', '授权码已过期');
  }
  if (!pkceMatches(verifier, row.code_challenge)) {
    Logger.warn(`[OAuth授权] PKCE 校验失败: client=${clientId}`);
    return sendTokenError(res, 'invalid_grant', 'PKCE 校验失败');
  }

  const { accessToken, refreshToken } = await issueTokenPair(row.client_id, row.user_id, row.api_key_id, row.scope);
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SEC,
    refresh_token: refreshToken,
    scope: row.scope,
  });
}

async function handleRefreshTokenGrant(p, res) {
  const presented = p.refresh_token;
  const clientId = p.client_id;
  if (!presented || !clientId) {
    return sendTokenError(res, 'invalid_request', 'refresh_token / client_id 均为必填');
  }

  const hash = sha256Hex(String(presented));
  const found = await pool.query(`SELECT * FROM oauth_tokens WHERE token_hash = $1`, [hash]);
  const row = found.rows[0];
  if (!row || row.kind !== 'refresh' || row.client_id !== clientId) {
    return sendTokenError(res, 'invalid_grant');
  }

  // 事务 + advisory lock 串行化同一 refresh 的并发使用，杜绝双花
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [hash]);

    const cur = await conn.query(`SELECT * FROM oauth_tokens WHERE id = $1 FOR UPDATE`, [row.id]);
    const fresh = cur.rows[0];

    if (!fresh || fresh.revoked || new Date(fresh.expires_at) < new Date()) {
      await conn.query('ROLLBACK');
      // 已吊销仍被出示 = 重放信号：吊销同链兜底
      if (fresh && fresh.revoked) {
        await revokeChain(fresh);
      }
      return sendTokenError(res, 'invalid_grant', 'refresh_token 已失效');
    }

    // 消费判定只认「子代 refresh」：access 行虽也挂在 rotated_from 上（同批链接，
    // 供吊销链遍历覆盖每代 access），但不代表该 refresh 已被轮换消费
    const child = await conn.query(`SELECT id FROM oauth_tokens WHERE rotated_from = $1 AND kind = 'refresh' LIMIT 1`, [fresh.id]);
    if (child.rows.length > 0) {
      await conn.query('ROLLBACK');
      await revokeChain(fresh); // 重用侦测：旧 refresh 第二次使用 → 全链吊销
      return sendTokenError(res, 'invalid_grant', 'refresh_token 已被使用，相关授权已全部吊销');
    }

    // 轮换：新 token 对发出，access 指向新 refresh；旧 refresh 经子行存在性标记为已消费
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const insR = await conn.query(
      `INSERT INTO oauth_tokens (token_hash, user_id, api_key_id, client_id, scope, kind, expires_at, rotated_from)
       VALUES ($1, $2, $3, $4, $5, 'refresh', now() + ($6 || ' seconds')::interval, $7)
       RETURNING id`,
      [sha256Hex(refreshToken), fresh.user_id, fresh.api_key_id, fresh.client_id, fresh.scope, String(REFRESH_TTL_SEC), fresh.id]
    );
    const newRefreshId = insR.rows[0].id;
    await conn.query(
      `INSERT INTO oauth_tokens (token_hash, user_id, api_key_id, client_id, scope, kind, expires_at, rotated_from)
       VALUES ($1, $2, $3, $4, $5, 'access', now() + ($6 || ' seconds')::interval, $7)`,
      [sha256Hex(accessToken), fresh.user_id, fresh.api_key_id, fresh.client_id, fresh.scope, String(ACCESS_TTL_SEC), newRefreshId]
    );
    await conn.query(`UPDATE oauth_tokens SET last_used_at = now() WHERE id = $1`, [fresh.id]);
    await conn.query('COMMIT');

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refreshToken,
      scope: fresh.scope,
    });
  } catch (err) {
    try { await conn.query('ROLLBACK'); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

// ---------- 授权管理：当前用户活跃授权链分组列表（控制台「授权管理」卡片数据源） ----------
// 每次同意授权产生一条以根 refresh 为起点的轮换链；按链分组，组内任一 token 存活即视为活跃
router.get('/oauth/authorizations', requireAuth, async (req, res) => {
  try {
    await ensureOAuthTables();
    const r = await pool.query(
      `WITH RECURSIVE tree AS (
         SELECT id, rotated_from, kind, client_id, api_key_id, scope,
                expires_at, revoked, created_at, last_used_at,
                id AS root_id
           FROM oauth_tokens
          WHERE user_id = $1 AND kind = 'refresh' AND rotated_from IS NULL
         UNION ALL
         SELECT t.id, t.rotated_from, t.kind, t.client_id, t.api_key_id, t.scope,
                t.expires_at, t.revoked, t.created_at, t.last_used_at,
                tree.root_id
           FROM oauth_tokens t
           JOIN tree ON t.rotated_from = tree.id
       )
       SELECT root_id,
              max(client_id)  AS client_id,
              max(scope)      AS scope,
              max(api_key_id) AS api_key_id,
              min(created_at) AS authorized_at,
              max(last_used_at) FILTER (WHERE NOT revoked)                      AS last_used_at,
              max(expires_at)   FILTER (WHERE kind = 'refresh' AND NOT revoked)  AS refresh_expires_at
         FROM tree
        GROUP BY root_id
       HAVING count(*) FILTER (WHERE NOT revoked) > 0
     )
     SELECT g.*, ak.name AS api_key_name
       FROM g LEFT JOIN api_keys ak ON ak.id = g.api_key_id
      ORDER BY g.authorized_at DESC`,
      [req.session.user.id]
    );

    const clientName = (cid) => getClient(cid)?.name || cid;
    const authorizations = r.rows.map((row) => ({
      id: row.root_id,
      client_id: row.client_id,
      client_name: clientName(row.client_id),
      scope: row.scope || '',
      api_key_id: row.api_key_id,
      api_key_name: row.api_key_name || '',
      authorized_at: row.authorized_at,
      last_used_at: row.last_used_at,
      expires_at: row.refresh_expires_at,
      expired: !row.refresh_expires_at || new Date(row.refresh_expires_at) < new Date(),
    }));
    res.json({ ok: true, authorizations });
  } catch (err) {
    Logger.error('[OAuth授权] 查询授权列表失败:', err.message);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ---------- 吊销指定授权链（该 refresh 及其派生的所有 access 全部标 revoked） ----------
router.post('/oauth/authorizations/revoke', requireAuth, async (req, res) => {
  try {
    await ensureOAuthTables();
    const id = parseInt((req.body || {}).id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ ok: false, error: 'invalid id' });
    }
    const found = await pool.query(
      `SELECT * FROM oauth_tokens WHERE id = $1 AND user_id = $2`,
      [id, req.session.user.id]
    );
    const row = found.rows[0];
    if (!row) {
      return res.status(404).json({ ok: false, error: 'authorization not found' });
    }
    await revokeChain(row, `用户 ${req.session.user.username} 在控制台吊销授权`);
    res.json({ ok: true });
  } catch (err) {
    Logger.error('[OAuth授权] 吊销授权失败:', err.message);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ---------- RFC 7009 风格吊销：按 token 哈希找到所属链整体吊销，永远返回 200 ----------
router.post('/oauth/revoke', async (req, res) => {
  await ensureOAuthTables();
  const token = String((req.body || {}).token || '');
  if (token) {
    try {
      const found = await pool.query(`SELECT * FROM oauth_tokens WHERE token_hash = $1`, [sha256Hex(token)]);
      if (found.rows[0]) {
        await revokeChain(found.rows[0], 'RFC7009 吊销请求');
      }
    } catch (err) {
      // RFC 7009 §2.1：即使处理异常也返回 200，不向客户端泄露 token 状态
      Logger.error('[OAuth授权] revoke 处理失败:', err.message);
    }
  }
  res.status(200).json({ ok: true });
});

// ---------- RFC 8414 元数据 ----------
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const issuer = process.env.OAUTH_ISSUER || configIssuer(req);
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'],
    code_challenge_methods: ['S256'],
    token_endpoint_auth_method: 'none',
    scopes_supported: ['events:report', 'gateway:invoke', 'console:read'],
  });
});

function configIssuer(req) {
  const explicit = config.oauth?.issuer;
  if (explicit) return String(explicit).replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

module.exports = router;
module.exports.ensureOAuthTables = ensureOAuthTables;
module.exports.OAUTH_TOKEN_PREFIX = OAUTH_TOKEN_PREFIX;
