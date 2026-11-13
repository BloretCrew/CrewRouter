'use strict';

const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const {
  getPolicySnapshot,
  resolveSettings,
  applicablePolicies,
  activeExemptions,
} = require('../utils/policy/cache');
const { suspensionState } = require('../utils/policy/suspension');

router.use(requireAuth);

function userIdOf(req) {
  return Number(req.authUser?.id || req.session?.user?.id);
}

router.get('/policy-role', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const user = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
    if (user.rows[0]?.is_admin === true) {
      return res.json({ canManagePolicies: true, all: true, teamIds: [] });
    }
    const rows = await pool.query(
      `SELECT team_id, role FROM user_teams WHERE user_id = $1 AND role IN ('owner','admin','viewer')`,
      [userId]
    );
    const managers = rows.rows.filter(row => row.role === 'owner' || row.role === 'admin');
    res.json({
      canManagePolicies: rows.rows.length > 0,
      readOnly: rows.rows.length > 0 && managers.length === 0,
      all: false,
      teamIds: rows.rows.map(row => Number(row.team_id)),
      roles: rows.rows,
    });
  } catch (error) {
    res.status(500).json({ error: '服务器错误' });
  }
});

router.get('/policies/mine', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const user = await pool.query('SELECT id, team_id, suspended_at, suspended_until, suspended_reason, suspended_scope, policy_bypass, policy_bypass_until FROM users WHERE id = $1', [userId]);
    if (!user.rows.length) return res.status(404).json({ error: '用户不存在' });
    const row = user.rows[0];
    const snapshot = await getPolicySnapshot();
    const settings = resolveSettings(snapshot, row.team_id);
    const policies = applicablePolicies(snapshot, { userId, teamId: row.team_id })
      .map(({ _compiled, ...policy }) => policy)
      .map(policy => ({
        id: policy.id, name: policy.name, description: policy.description,
        scope_type: policy.scope_type, effect: policy.effect, action: policy.action,
        category: policy.category, priority: policy.priority, conditions: policy.conditions,
        starts_at: policy.starts_at, ends_at: policy.ends_at,
      }));
    const exemptions = activeExemptions(snapshot, { userId, teamId: row.team_id })
      .map(exemption => ({
        id: exemption.id, policy_id: exemption.policy_id, reason: exemption.reason,
        ends_at: exemption.ends_at, max_uses: exemption.max_uses, used_count: exemption.used_count,
      }));
    res.json({
      suspension: suspensionState(row),
      bypass: row.policy_bypass === true,
      bypass_until: row.policy_bypass_until,
      settings: {
        enforcement_mode: settings.enforcement_mode,
        allowlist_dimensions: settings.allowlist_dimensions,
      },
      policies,
      exemptions,
    });
  } catch (error) {
    res.status(500).json({ error: '服务器错误' });
  }
});

router.get('/policies/blocks', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const result = await pool.query(
      `SELECT h.id, h.policy_id, h.policy_name, h.action, h.decision, h.request_source,
              h.requested_model, h.status_code, h.reason, h.created_at
         FROM policy_hits h
        WHERE h.user_id = $1 AND h.decision = 'block'
        ORDER BY h.created_at DESC LIMIT $2`,
      [userId, limit]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: '服务器错误' });
  }
});

router.get('/policy-appeals', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const result = await pool.query(
      `SELECT a.*, p.name AS policy_name
         FROM policy_appeals a LEFT JOIN access_policies p ON p.id = a.policy_id
        WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: '服务器错误' });
  }
});

router.post('/policy-appeals', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: '请填写申诉原因' });
    let policyId = req.body?.policy_id ? Number(req.body.policy_id) : null;
    const hitId = req.body?.hit_id ? Number(req.body.hit_id) : null;
    if (hitId) {
      const hit = await pool.query('SELECT policy_id, user_id FROM policy_hits WHERE id = $1', [hitId]);
      if (!hit.rows.length || Number(hit.rows[0].user_id) !== userId) {
        return res.status(404).json({ error: '命中记录不存在' });
      }
      policyId = hit.rows[0].policy_id || policyId;
    }
    const recent = await pool.query(
      `SELECT id FROM policy_appeals
        WHERE user_id = $1 AND status = 'pending' AND created_at >= NOW() - INTERVAL '24 hours'
          AND (policy_id = $2 OR ($2::int IS NULL AND policy_id IS NULL))
        LIMIT 1`,
      [userId, policyId]
    );
    if (recent.rows.length) return res.status(429).json({ error: '该策略已有待处理申诉，请等待处理' });
    const result = await pool.query(
      `INSERT INTO policy_appeals (policy_id, hit_id, user_id, reason, status, sla_due_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW() + INTERVAL '24 hours') RETURNING *`,
      [policyId, hitId, userId, reason.slice(0, 4000)]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: '服务器错误' });
  }
});

router.get('/policy-approvals/:id', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const result = await pool.query('SELECT * FROM policy_approvals WHERE id = $1', [Number(req.params.id)]);
    if (!result.rows.length) return res.status(404).json({ error: '审批不存在' });
    const approval = result.rows[0];
    if (Number(approval.requested_by) !== userId && Number(approval.payload?.user_id) !== userId) {
      return res.status(403).json({ error: '无权查看该审批' });
    }
    res.json(approval);
  } catch (error) {
    res.status(500).json({ error: '服务器错误' });
  }
});

router.get('/suspension', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const result = await pool.query(
      'SELECT suspended_at, suspended_until, suspended_reason, suspended_scope, policy_bypass, policy_bypass_until FROM users WHERE id = $1',
      [userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: '用户不存在' });
    const state = suspensionState(result.rows[0]);
    res.json({
      suspended: state.suspended,
      suspended_until: state.until ? state.until.toISOString() : null,
      suspended_reason: state.reason || '',
      suspended_scope: state.scope || 'all',
      policy_bypass: result.rows[0].policy_bypass === true,
      policy_bypass_until: result.rows[0].policy_bypass_until || null,
    });
  } catch (error) {
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
