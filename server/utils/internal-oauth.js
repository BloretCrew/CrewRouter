const crypto = require('crypto');
const { pool } = require('../models/database');
const { ensureOAuthTables } = require('../routes/oauth');
const { sha256Hex } = require('./key-hash');

const TOKEN_TTL_MS = 5 * 60 * 1000;
const tokenCache = new Map();
const pendingTokens = new Map();

async function issueInternalToken(userId, apiKeyId) {
  await pool.query(
    `DELETE FROM oauth_tokens
     WHERE api_key_id = $1 AND client_id = 'crewrouter-internal'
       AND (revoked = TRUE OR expires_at <= now())`,
    [apiKeyId]
  );
  const token = `crh_${crypto.randomBytes(32).toString('base64url')}`;
  await pool.query(
    `INSERT INTO oauth_tokens (token_hash, user_id, api_key_id, client_id, scope, kind, expires_at)
     VALUES ($1, $2, $3, 'crewrouter-internal', 'gateway:invoke', 'access', now() + interval '24 hours')`,
    [sha256Hex(token), userId, apiKeyId]
  );
  tokenCache.set(apiKeyId, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

async function getInternalAccessToken(userId) {
  await ensureOAuthTables();
  const key = await pool.query(
    "SELECT id FROM api_keys WHERE user_id = $1 AND enabled = TRUE AND name ILIKE 'crewrouter' ORDER BY id ASC LIMIT 1",
    [userId]
  );
  if (!key.rows[0]) throw new Error('未找到 CrewRouter 密钥');
  const apiKeyId = key.rows[0].id;
  const cached = tokenCache.get(apiKeyId);
  if (cached && cached.expiresAt > Date.now()) {
    const valid = await pool.query(
      `SELECT 1 FROM oauth_tokens
       WHERE token_hash = $1 AND api_key_id = $2 AND kind = 'access'
         AND revoked = FALSE AND expires_at > now()`,
      [sha256Hex(cached.token), apiKeyId]
    );
    if (valid.rows[0]) return cached.token;
    tokenCache.delete(apiKeyId);
  } else {
    tokenCache.delete(apiKeyId);
  }
  if (pendingTokens.has(apiKeyId)) return pendingTokens.get(apiKeyId);

  const pending = issueInternalToken(userId, apiKeyId)
    .finally(() => pendingTokens.delete(apiKeyId));
  pendingTokens.set(apiKeyId, pending);
  return pending;
}

module.exports = { getInternalAccessToken };
