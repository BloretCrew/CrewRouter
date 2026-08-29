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

function inviteStatus(row) {
  if (row.revoked) return 'revoked';
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  const maxUses = Number(row.max_uses || 1);
  const usedCount = Number(row.used_count || 0);
  if (usedCount >= maxUses) return 'used';
  return 'active';
}

async function resolveInviteTargets(teamId, groupId) {
  let team = null;
  let group = null;
  if (teamId) {
    const result = await pool.query('SELECT id, name FROM teams WHERE id = $1', [teamId]);
    if (!result.rows.length) throw new Error('指定的 Team 不存在');
    team = result.rows[0];
  }
  if (groupId) {
    const result = await pool.query('SELECT id, name FROM user_groups WHERE id = $1', [groupId]);
    if (!result.rows.length) throw new Error('指定的用户组不存在');
    group = result.rows[0];
  }
  return { team, group };
}

router.post('/auth-invites', requireAdmin, async (req, res) => {
  try {
    const maxUses = Math.max(1, Math.min(10000, parseInt(req.body?.maxUses || req.body?.max_uses || 1, 10) || 1));
    const days = Math.max(1, Math.min(365, parseInt(req.body?.days || 7, 10) || 7));
    const teamId = req.body?.teamId ? parseInt(req.body.teamId, 10) : null;
    const groupId = req.body?.groupId ? parseInt(req.body.groupId, 10) : null;
    const { team, group } = await resolveInviteTargets(Number.isInteger(teamId) ? teamId : null, Number.isInteger(groupId) ? groupId : null);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const inserted = await pool.query(
      `INSERT INTO auth_invites (token_hash, created_by, expires_at, max_uses, used_count, team_id, group_id)
       VALUES ($1, $2, $3, $4, 0, $5, $6)
       RETURNING id, created_at, expires_at, max_uses, used_count, team_id, group_id`,
      [hashToken(token), req.session.user.id, expiresAt, maxUses, team?.id || null, group?.id || null]
    );
    const origin = getPublicOrigin(req);
    const row = inserted.rows[0];
    res.json({
      id: row.id,
      token,
      url: `${origin}/?invite=${encodeURIComponent(token)}`,
      expires_at: row.expires_at,
      max_uses: row.max_uses,
      used_count: row.used_count,
      team_id: row.team_id,
      team_name: team?.name || null,
      group_id: row.group_id,
      group_name: group?.name || null,
      status: 'active',
    });
  } catch (err) {
    res.status(400).json({ error: err.message || '生成邀请链接失败' });
  }
});

router.get('/auth-invites', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT i.id, i.created_by, i.created_at, i.expires_at, i.used, i.used_by, i.used_at,
             i.max_uses, i.used_count, i.team_id, i.group_id,
             t.name AS team_name, g.name AS group_name,
             CASE
               WHEN i.expires_at <= CURRENT_TIMESTAMP THEN 'expired'
               WHEN COALESCE(i.used_count, 0) >= COALESCE(i.max_uses, 1) OR i.used THEN 'used'
               ELSE 'active'
             END AS status
      FROM auth_invites i
      LEFT JOIN teams t ON t.id = i.team_id
      LEFT JOIN user_groups g ON g.id = i.group_id
      ORDER BY i.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: '加载邀请链接失败' }); }
});

router.post('/auth-invites/:id/revoke', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE auth_invites SET expires_at = CURRENT_TIMESTAMP WHERE id = $1 AND COALESCE(used_count, 0) < COALESCE(max_uses, 1) AND expires_at > CURRENT_TIMESTAMP RETURNING id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: '邀请不存在或已使用' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '撤销邀请失败' }); }
});

async function validateInvite(token, client = pool) {
  if (!token) return null;
  const result = await client.query(
    `SELECT * FROM auth_invites
      WHERE token_hash = $1
        AND expires_at > CURRENT_TIMESTAMP
        AND COALESCE(used_count, 0) < COALESCE(max_uses, 1)
      FOR UPDATE`,
    [hashToken(String(token))]
  );
  return result.rows[0] || null;
}

async function consumeInvite(invite, userId, client = pool) {
  if (!invite) return null;
  const result = await client.query(
    `UPDATE auth_invites
        SET used_count = COALESCE(used_count, 0) + 1,
            used = (COALESCE(used_count, 0) + 1) >= COALESCE(max_uses, 1),
            used_by = COALESCE(used_by, $2),
            used_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND expires_at > CURRENT_TIMESTAMP
        AND COALESCE(used_count, 0) < COALESCE(max_uses, 1)
      RETURNING *`,
    [invite.id, userId]
  );
  return result.rows[0] || null;
}

module.exports = router;
module.exports.validateInvite = validateInvite;
module.exports.consumeInvite = consumeInvite;
module.exports.inviteStatus = inviteStatus;
