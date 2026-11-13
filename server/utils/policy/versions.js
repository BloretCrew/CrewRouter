'use strict';

const { pool } = require('../../models/database');

async function saveVersion(client, policy, changeSummary, userId) {
  await client.query(
    `INSERT INTO policy_versions (policy_id, version, snapshot, change_summary, changed_by)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (policy_id, version) DO NOTHING`,
    [policy.id, policy.version, JSON.stringify(policy), changeSummary || '', userId || null]
  );
}

async function listVersions(db, policyId, limit = 100) {
  const result = await db.query(
    `SELECT id, version, change_summary, changed_by, created_at
       FROM policy_versions WHERE policy_id = $1 ORDER BY version DESC LIMIT $2`,
    [policyId, Math.min(200, Math.max(1, limit))]
  );
  return result.rows;
}

async function getVersion(db, policyId, version) {
  const result = await db.query(
    `SELECT * FROM policy_versions WHERE policy_id = $1 AND version = $2`,
    [policyId, version]
  );
  return result.rows[0] || null;
}

function diffSnapshots(from, to) {
  if (!from || !to) return {};
  const fields = [
    'name', 'description', 'scope_type', 'scope_id', 'effect', 'action',
    'action_options', 'ladder', 'priority', 'category', 'conditions', 'status',
    'group_id', 'tags', 'rollout_percent', 'status_code', 'message_template',
    'notify_channels', 'starts_at', 'ends_at', 'auto_publish_at', 'bypass_until', 'enabled',
  ];
  const diff = {};
  for (const field of fields) {
    const a = JSON.stringify(from[field] ?? null);
    const b = JSON.stringify(to[field] ?? null);
    if (a !== b) diff[field] = { from: from[field] ?? null, to: to[field] ?? null };
  }
  return diff;
}

/**
 * 回滚到指定版本：复制快照为新的当前版本（version + 1）。
 */
async function rollbackToVersion({ policyId, version, userId, changeSummary }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM access_policies WHERE id = $1 FOR UPDATE', [policyId]);
    if (!current.rows.length) throw Object.assign(new Error('策略不存在'), { status: 404 });
    const snapshotRow = await getVersion(client, policyId, version);
    if (!snapshotRow) throw Object.assign(new Error('版本不存在'), { status: 404 });
    const snapshot = snapshotRow.snapshot;
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
        JSON.stringify(snapshot.conditions || {}), snapshot.status, nextVersion,
        snapshot.group_id || null, snapshot.tags || [], snapshot.rollout_percent ?? 100,
        snapshot.status_code ?? 403, snapshot.message_template || '',
        JSON.stringify(snapshot.notify_channels || {}), snapshot.starts_at || null,
        snapshot.ends_at || null, snapshot.auto_publish_at || null, snapshot.bypass_until || null,
        snapshot.enabled !== false, userId || null, policyId,
      ]
    );
    const policy = result.rows[0];
    await saveVersion(client, policy, changeSummary || `回滚到版本 ${version}`, userId);
    await client.query('COMMIT');
    return policy;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { saveVersion, listVersions, getVersion, diffSnapshots, rollbackToVersion };
