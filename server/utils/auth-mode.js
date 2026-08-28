const { pool } = require('../models/database');

const MODES = new Set(['feishu', 'passport']);

async function getAuthMode() {
  const result = await pool.query("SELECT value FROM settings WHERE key = 'auth_mode'");
  if (!result.rows.length) return 'feishu';
  const value = result.rows[0].value;
  return MODES.has(value) ? value : 'feishu';
}

async function setAuthMode(mode) {
  if (!MODES.has(mode)) throw new Error('auth_mode must be feishu or passport');
  if (await isAuthModeFrozen()) throw new Error('auth_mode is frozen after setup completion');
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('auth_mode', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [mode]
  );
  return mode;
}

async function isAuthModeFrozen() {
  const result = await pool.query("SELECT 1 FROM settings WHERE key = 'setup_complete' LIMIT 1");
  return result.rows.length > 0;
}

module.exports = { MODES, getAuthMode, setAuthMode, isAuthModeFrozen };
