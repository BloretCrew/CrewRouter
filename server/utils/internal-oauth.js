const crypto = require('crypto');
const { pool } = require('../models/database');
const { ensureOAuthTables } = require('../routes/oauth');
const { sha256Hex } = require('./key-hash');

async function getInternalAccessToken(userId) {
  await ensureOAuthTables();
  const key = await pool.query(
    "SELECT id FROM api_keys WHERE user_id = $1 AND enabled = TRUE AND name ILIKE 'crewrouter' ORDER BY id ASC LIMIT 1",
    [userId]
  );
  if (!key.rows[0]) throw new Error('未找到 CrewRouter 密钥');
  const apiKeyId = key.rows[0].id;
  const token = `crh_${crypto.randomBytes(32).toString('base64url')}`;
  await pool.query(
    `INSERT INTO oauth_tokens (token_hash, user_id, api_key_id, client_id, scope, kind, expires_at)
     VALUES ($1, $2, $3, 'crewrouter-internal', 'gateway:invoke', 'access', now() + interval '24 hours')`,
    [sha256Hex(token), userId, apiKeyId]
  );
  return token;
}

module.exports = { getInternalAccessToken };
