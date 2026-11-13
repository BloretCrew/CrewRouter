'use strict';

const { pool } = require('../../models/database');
const { saveVersion } = require('./versions');
const { invalidatePolicyCache } = require('./cache');

async function createApproval(db, { kind, policyId = null, requestedBy = null, payload = {}, preview = {}, expiresSeconds = 86400 }) {
  const result = await db.query(
    `INSERT INTO policy_approvals (kind, policy_id, requested_by, payload, preview, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, NOW() + ($6::int * INTERVAL '1 second'))
     RETURNING *`,
    [kind, policyId, requestedBy, JSON.stringify(payload), JSON.stringify(preview), expiresSeconds]
  );
  return result.rows[0];
}

async function listApprovals(db, { status = null, kind = null, limit = 100, offset = 0 } = {}) {
  const params = [];
  const where = [];
  if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
  if (kind) { params.push(kind); where.push(`a.kind = $${params.length}`); }
  params.push(limit, offset);
  const result = await db.query(
    `SELECT a.*, p.name AS policy_name, ru.username AS requested_by_name, au.username AS approver_name
       FROM policy_approvals a
       LEFT JOIN access_policies p ON p.id = a.policy_id
       LEFT JOIN users ru ON ru.id = a.requested_by
       LEFT JOIN users au ON au.id = a.approver_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const count = await db.query(
    `SELECT COUNT(*)::int AS total FROM policy_approvals a ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params.slice(0, params.length - 2)
  );
  return { items: result.rows, total: count.rows[0]?.total || 0 };
}

async function applyChange(client, payload, approverId) {
  const policyId = Number(payload.policy_id);
  if (!policyId) throw new Error('审批缺少策略 ID');
  const action = payload.action || 'publish';
  if (action === 'delete') {
    await client.query('DELETE FROM access_policies WHERE id = $1', [policyId]);
    return { action, policy_id: policyId };
  }
  if (action === 'publish' || action === 'archive') {
    const status = action === 'publish' ? 'published' : 'archived';
    const result = await client.query(
      `UPDATE access_policies SET status = $2::varchar, updated_by = $3, updated_at = NOW(),
         archived_at = CASE WHEN $2::text = 'archived' THEN NOW() ELSE NULL END
       WHERE id = $1 RETURNING *`,
      [policyId, status, approverId]
    );
    if (!result.rows.length) throw new Error('策略不存在');
    await saveVersion(client, result.rows[0], `审批${action}`, approverId);
    return { action, policy_id: policyId, status };
  }
  if (action === 'update' && payload.snapshot) {
    const snapshot = payload.snapshot;
    const current = await client.query('SELECT version FROM access_policies WHERE id = $1 FOR UPDATE', [policyId]);
    if (!current.rows.length) throw new Error('策略不存在');
    const nextVersion = Number(current.rows[0].version) + 1;
    const result = await client.query(
      `UPDATE access_policies SET
         name=$1, description=$2, scope_type=$3, scope_id=$4, effect=$5, action=$6,
         action_options=$7::jsonb, ladder=$8::jsonb, priority=$9, category=$10,
         conditions=$11::jsonb, status=$12, version=$13, group_id=$14, tags=$15,
         rollout_percent=$16, status_code=$17, message_template=$18, notify_channels=$19::jsonb,
         starts_at=$20, ends_at=$21, auto_publish_at=$22, bypass_until=$23, enabled=$24,
         updated_by=$25, updated_at=NOW()
       WHERE id=$26 RETURNING *`,
      [
        snapshot.name, snapshot.description, snapshot.scope_type, snapshot.scope_id,
        snapshot.effect, snapshot.action, JSON.stringify(snapshot.action_options || {}),
        JSON.stringify(snapshot.ladder || []), snapshot.priority, snapshot.category,
        JSON.stringify(snapshot.conditions || {}), snapshot.status || 'published', nextVersion,
        snapshot.group_id || null, snapshot.tags || [], snapshot.rollout_percent ?? 100,
        snapshot.status_code ?? 403, snapshot.message_template || '',
        JSON.stringify(snapshot.notify_channels || {}), snapshot.starts_at || null,
        snapshot.ends_at || null, snapshot.auto_publish_at || null, snapshot.bypass_until || null,
        snapshot.enabled !== false, approverId, policyId,
      ]
    );
    const policy = result.rows[0];
    await saveVersion(client, policy, '审批更新', approverId);
    return { action: 'update', policy_id: policyId, version: policy.version };
  }
  throw new Error(`不支持的审批变更: ${action}`);
}

async function applyRequest(client, payload) {
  const userId = Number(payload.user_id);
  const policyId = payload.policy_id ? Number(payload.policy_id) : null;
  if (!userId) throw new Error('审批缺少成员 ID');
  const result = await client.query(
    `INSERT INTO policy_exemptions (policy_id, subject_type, subject_id, reason, status, ends_at, max_uses, granted_by)
     VALUES ($1, 'user', $2, $3, 'active', NOW() + INTERVAL '1 hour', 1, $4)
     RETURNING *`,
    [policyId, userId, `运行时审批通过（request ${payload.request_id || '-'}）`, payload.approver_id || null]
  );
  return { exemption: result.rows[0] };
}

async function decideApproval({ id, approverId, decision, note = '' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM policy_approvals WHERE id = $1 FOR UPDATE', [id]);
    if (!current.rows.length) throw Object.assign(new Error('审批不存在'), { status: 404 });
    const approval = current.rows[0];
    if (approval.status !== 'pending') throw Object.assign(new Error(`审批已处理：${approval.status}`), { status: 409 });
    if (approval.expires_at && new Date(approval.expires_at).getTime() <= Date.now()) {
      await client.query(`UPDATE policy_approvals SET status = 'expired', resolved_at = NOW() WHERE id = $1`, [id]);
      await client.query('COMMIT');
      throw Object.assign(new Error('审批已过期'), { status: 409 });
    }
    const approved = decision === 'approve' || decision === true;
    let applied = null;
    if (approved) {
      const payload = { ...(approval.payload || {}) };
      if (approval.kind === 'request') {
        payload.approver_id = approverId;
        applied = await applyRequest(client, payload);
      } else {
        applied = await applyChange(client, payload, approverId);
      }
    }
    const updated = await client.query(
      `UPDATE policy_approvals SET status = $2, approver_id = $3, note = $4, resolved_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, approved ? 'approved' : 'rejected', approverId || null, String(note || '').slice(0, 2000)]
    );
    await client.query('COMMIT');
    invalidatePolicyCache();
    return { approval: updated.rows[0], applied };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

async function expireApprovals(db = pool) {
  const result = await db.query(
    `UPDATE policy_approvals SET status = 'expired', resolved_at = NOW()
      WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= NOW()
      RETURNING id`
  );
  return result.rowCount;
}

module.exports = {
  createApproval,
  listApprovals,
  decideApproval,
  expireApprovals,
  applyChange,
  applyRequest,
};
