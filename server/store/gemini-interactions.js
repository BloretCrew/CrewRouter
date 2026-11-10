'use strict';

const crypto = require('node:crypto');
const { pool: defaultPool } = require('../models/database');

const RETENTION_DAYS = 55;
const active = new Map();
let ensuredPromise = null;

function ready(pool = defaultPool) {
  if (!ensuredPromise) {
    ensuredPromise = ensureInteractionTables(pool).catch((error) => {
      ensuredPromise = null;
      throw error;
    });
  }
  return ensuredPromise;
}

function newInteractionId() {
  return `v1_${crypto.randomBytes(24).toString('base64url')}`;
}

async function ensureInteractionTables(pool = defaultPool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gemini_interactions (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      api_key_id BIGINT,
      model_id TEXT,
      provider_id BIGINT,
      status TEXT NOT NULL,
      store BOOLEAN NOT NULL DEFAULT TRUE,
      previous_interaction_id TEXT,
      request_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
      response_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
      usage JSONB,
      error JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_gemini_interactions_user_created ON gemini_interactions (user_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_gemini_interactions_previous ON gemini_interactions (previous_interaction_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_gemini_interactions_expires ON gemini_interactions (expires_at)');
}

async function createInteraction(record, pool = defaultPool) {
  await ready(pool);
  const id = record.id || newInteractionId();
  const expiresAt = record.expiresAt
    || new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await pool.query(`
    INSERT INTO gemini_interactions (
      id, user_id, api_key_id, model_id, provider_id, status, store,
      previous_interaction_id, request_steps, response_steps, usage, error,
      created_at, updated_at, expires_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,
      COALESCE($13::timestamptz, now()), COALESCE($14::timestamptz, now()), $15::timestamptz)
    ON CONFLICT (id) DO NOTHING
  `, [
    id,
    record.userId,
    record.apiKeyId || null,
    record.modelId || null,
    record.providerId || null,
    record.status || 'completed',
    record.store !== false,
    record.previousInteractionId || null,
    JSON.stringify(record.requestSteps || []),
    JSON.stringify(record.responseSteps || []),
    record.usage ? JSON.stringify(record.usage) : null,
    record.error ? JSON.stringify(record.error) : null,
    record.created || null,
    record.updated || null,
    expiresAt
  ]);
  return id;
}

async function updateInteraction(id, userId, patch = {}, pool = defaultPool) {
  await ready(pool);
  const result = await pool.query(`
    UPDATE gemini_interactions SET
      status = COALESCE($3, status),
      request_steps = COALESCE($4::jsonb, request_steps),
      response_steps = COALESCE($5::jsonb, response_steps),
      usage = COALESCE($6::jsonb, usage),
      error = COALESCE($7::jsonb, error),
      updated_at = now()
    WHERE id = $1 AND user_id = $2
    RETURNING *
  `, [
    id, userId,
    patch.status || null,
    patch.requestSteps ? JSON.stringify(patch.requestSteps) : null,
    patch.responseSteps ? JSON.stringify(patch.responseSteps) : null,
    patch.usage ? JSON.stringify(patch.usage) : null,
    patch.error ? JSON.stringify(patch.error) : null
  ]);
  return result.rows[0] || null;
}

async function getInteraction(id, userId, pool = defaultPool) {
  await ready(pool);
  const result = await pool.query(
    'SELECT * FROM gemini_interactions WHERE id = $1 AND user_id = $2 AND store = TRUE',
    [id, userId]
  );
  return result.rows[0] || null;
}

async function deleteInteraction(id, userId, pool = defaultPool) {
  await ready(pool);
  const result = await pool.query(
    'DELETE FROM gemini_interactions WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, userId]
  );
  return result.rowCount > 0;
}

async function cleanupExpired(pool = defaultPool) {
  try {
    const result = await pool.query(
      'DELETE FROM gemini_interactions WHERE expires_at IS NOT NULL AND expires_at < now()'
    );
    return result.rowCount;
  } catch {
    return 0;
  }
}

function registerActive(id, userId, controller) {
  active.set(String(id), { userId, controller, startedAt: Date.now() });
  return () => active.delete(String(id));
}

function abortActive(id, userId) {
  const entry = active.get(String(id));
  if (!entry || entry.userId !== userId) return false;
  try { entry.controller.abort(Object.assign(new Error('Interaction cancelled'), { code: 'interaction_cancelled' })); } catch { /* ignore */ }
  return true;
}

function isActive(id, userId) {
  const entry = active.get(String(id));
  return !!entry && entry.userId === userId;
}

module.exports = {
  RETENTION_DAYS,
  newInteractionId,
  ensureInteractionTables,
  createInteraction,
  updateInteraction,
  getInteraction,
  deleteInteraction,
  cleanupExpired,
  registerActive,
  abortActive,
  isActive
};
