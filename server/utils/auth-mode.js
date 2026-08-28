const { pool } = require('../models/database');

const MODES = new Set(['feishu', 'passport']);
const AUTH_MODE_LOCK = 731946;

function decodeMode(value) {
  if (typeof value !== 'string') return null;
  try {
    const decoded = JSON.parse(value);
    return MODES.has(decoded) ? decoded : (MODES.has(value) ? value : null);
  } catch (_) {
    return MODES.has(value) ? value : null;
  }
}

async function getAuthMode(db = pool) {
  const result = await db.query("SELECT value FROM settings WHERE key = 'auth_mode'");
  return result.rows.length ? (decodeMode(result.rows[0].value) || 'feishu') : 'feishu';
}

async function setAuthMode(mode, db = pool) {
  if (!MODES.has(mode)) throw new Error('auth_mode must be feishu or passport');
  const ownsClient = db === pool;
  const client = ownsClient ? await pool.connect() : db;
  try {
    if (ownsClient) await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [AUTH_MODE_LOCK]);
    const frozen = await client.query("SELECT 1 FROM settings WHERE key = 'setup_complete' LIMIT 1");
    if (frozen.rows.length) throw new Error('auth_mode is frozen after setup completion');
    const existing = await client.query("SELECT value FROM settings WHERE key = 'auth_mode' FOR UPDATE");
    if (existing.rows.length) {
      const current = decodeMode(existing.rows[0].value);
      if (current && current !== mode) throw new Error('auth_mode can only be selected once');
      if (current === mode) { if (ownsClient) await client.query('COMMIT'); return mode; }
      await client.query("UPDATE settings SET value = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE key = 'auth_mode'", [JSON.stringify(mode)]);
    } else {
      await client.query("INSERT INTO settings (key, value) VALUES ('auth_mode', $1::jsonb)", [JSON.stringify(mode)]);
    }
    if (ownsClient) await client.query('COMMIT');
    return mode;
  } catch (err) {
    if (ownsClient) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { if (ownsClient) client.release(); }
}

async function isAuthModeFrozen(db = pool) {
  const result = await db.query("SELECT 1 FROM settings WHERE key = 'setup_complete' LIMIT 1");
  return result.rows.length > 0;
}

module.exports = { MODES, AUTH_MODE_LOCK, decodeMode, getAuthMode, setAuthMode, isAuthModeFrozen };
