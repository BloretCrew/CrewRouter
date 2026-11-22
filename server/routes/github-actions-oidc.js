'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { pool } = require('../models/database');
const config = require('../config-loader');
const Logger = require('../logger');
const githubOidc = require('../utils/github-oidc');
const { ensureOAuthTables } = require('./oauth');

const router = express.Router();
const ACCESS_TOKEN_TTL_SEC = 10 * 60;
const ASSERTION_TTL_SEC = 10 * 60;
const CLIENT_ID = 'github-actions-oidc';
const SCOPE = 'gateway:invoke';
let replayTableReady = false;

async function ensureReplayTable() {
  if (replayTableReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS github_actions_oidc_assertions (
    jti_hash TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query('DELETE FROM github_actions_oidc_assertions WHERE expires_at < now() - interval \'1 day\'');
  replayTableReady = true;
}
const JWT_MAX = 16_384;
const EXCHANGE_RATE_LIMIT = 20;
const MAX_RATE_BUCKETS = 10_000;
const exchangeAttempts = new Map();

setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, timestamps] of exchangeAttempts) {
    const current = timestamps.filter(timestamp => timestamp > cutoff);
    if (current.length) exchangeAttempts.set(key, current);
    else exchangeAttempts.delete(key);
  }
}, 60_000).unref?.();

function allowExchange(key) {
  const cutoff = Date.now() - 60_000;
  const recent = (exchangeAttempts.get(key) || []).filter(timestamp => timestamp > cutoff);
  if (recent.length >= EXCHANGE_RATE_LIMIT) return false;
  if (!exchangeAttempts.has(key) && exchangeAttempts.size >= MAX_RATE_BUCKETS) return false;
  recent.push(Date.now());
  exchangeAttempts.set(key, recent);
  return true;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

router.post('/oauth/github-actions', async (req, res) => {
  const trust = githubOidc.getTrustPolicy(config);
  if (!trust) return res.status(404).json({ error: 'not_found' });
  const assertion = req.body?.assertion;
  if (typeof assertion !== 'string' || assertion.length > JWT_MAX) return res.status(400).json({ error: 'invalid_request' });
  if (!allowExchange(String(req.ip || req.socket?.remoteAddress || 'unknown'))) return res.status(429).json({ error: 'slow_down' });
  try {
    const verified = await githubOidc.verifyGitHubActionsToken(assertion, trust);
    if (verified.error) {
      Logger.warn(`[GitHub OIDC] assertion rejected: ${verified.error}`);
      return res.status(401).json({ error: 'invalid_grant' });
    }
    await ensureOAuthTables();
    await ensureReplayTable();
    const assertionUse = await pool.query(
      `INSERT INTO github_actions_oidc_assertions (jti_hash, expires_at)
       VALUES ($1, to_timestamp($2)) ON CONFLICT (jti_hash) DO NOTHING RETURNING jti_hash`,
      [sha256Hex(verified.claims.jti), Math.min(verified.claims.exp, Math.floor(Date.now() / 1000) + ASSERTION_TTL_SEC)]
    );
    if (!assertionUse.rowCount) return res.status(401).json({ error: 'invalid_grant' });
    const key = await pool.query(
      `SELECT ak.id
         FROM api_keys ak
         JOIN users u ON u.id = ak.user_id
        WHERE ak.user_id = $1 AND ak.enabled = TRUE
          AND (ak.expires_at IS NULL OR ak.expires_at > now())
          AND ak.permissions @> '["gateway.chat"]'::jsonb
          AND (ak.schedule_enabled IS DISTINCT FROM TRUE OR (
            (ak.schedule_days IS NULL OR EXTRACT(DOW FROM (now() AT TIME ZONE COALESCE(ak.schedule_timezone, 'UTC')))::int = ANY(ak.schedule_days))
            AND (
              ak.schedule_on_time IS NULL OR ak.schedule_off_time IS NULL
              OR (ak.schedule_on_time <= ak.schedule_off_time AND (now() AT TIME ZONE COALESCE(ak.schedule_timezone, 'UTC'))::time BETWEEN ak.schedule_on_time AND ak.schedule_off_time)
              OR (ak.schedule_on_time > ak.schedule_off_time AND ((now() AT TIME ZONE COALESCE(ak.schedule_timezone, 'UTC'))::time >= ak.schedule_on_time OR (now() AT TIME ZONE COALESCE(ak.schedule_timezone, 'UTC'))::time <= ak.schedule_off_time)
            )
          ))
          AND (u.suspended_at IS NULL OR (u.suspended_until IS NOT NULL AND u.suspended_until <= now()))
        ORDER BY ak.created_at DESC LIMIT 1`,
      [trust.userId]
    );
    if (!key.rows[0]) return res.status(403).json({ error: 'access_denied' });

    const accessToken = `crh_${crypto.randomBytes(32).toString('base64url')}`;
    await pool.query(
      `INSERT INTO oauth_tokens (token_hash, user_id, api_key_id, client_id, scope, kind, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'access', now() + ($6 || ' seconds')::interval)`,
      [sha256Hex(accessToken), trust.userId, key.rows[0].id, CLIENT_ID, SCOPE, String(ACCESS_TOKEN_TTL_SEC)]
    );
    return res.set('Cache-Control', 'no-store').json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
      scope: SCOPE,
    });
  } catch (error) {
    Logger.error('[GitHub OIDC] federation endpoint unavailable:', error.message);
    return res.status(503).json({ error: 'temporarily_unavailable' });
  }
});

module.exports = router;
