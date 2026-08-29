const express = require('express');
const crypto = require('crypto');
const { pool } = require('../models/database');
const { requireAdmin } = require('../middleware/auth');
const config = require('../config-loader');

const router = express.Router();

function getPublicOrigin(req) {
  const configured = config.app?.publicOrigin;
  if (configured) {
    const url = new URL(configured);
    return url.origin;
  }
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  if (!host) throw new Error('无法安全确定公开 origin');
  return `${protocol}://${host}`;
}
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

router.post('/auth-invites', requireAdmin, async (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO auth_invites (token_hash, created_by, expires_at) VALUES ($1, $2, $3)`,
      [hashToken(token), req.session.user.id, expiresAt]
    );
    const origin = getPublicOrigin(req);
    res.json({ token, url: `${origin}/?invite=${encodeURIComponent(token)}`, expires_at: expiresAt.toISOString() });
  } catch (err) {
    res.status(500).json({ error: '生成邀请链接失败' });
  }
});

router.get('/auth-invites', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, created_by, created_at, expires_at, used, used_by, used_at,
        CASE WHEN used THEN 'used' WHEN expires_at <= CURRENT_TIMESTAMP THEN 'expired' ELSE 'active' END AS status
      FROM auth_invites ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: '加载邀请链接失败' }); }
});

router.post('/auth-invites/:id/revoke', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE auth_invites SET expires_at = CURRENT_TIMESTAMP WHERE id = $1 AND used = FALSE RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: '邀请不存在或已使用' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '撤销邀请失败' }); }
});

async function validateInvite(token, client = pool) {
  if (!token) return null;
  const result = await client.query(
    `SELECT * FROM auth_invites WHERE token_hash = $1 AND used = FALSE AND expires_at > CURRENT_TIMESTAMP FOR UPDATE`,
    [hashToken(String(token))]
  );
  return result.rows[0] || null;
}

module.exports = router;
module.exports.validateInvite = validateInvite;
