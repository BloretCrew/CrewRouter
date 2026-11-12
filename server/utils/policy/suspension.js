'use strict';

const { pool } = require('../../models/database');
const Logger = require('../../logger');

function suspensionState(row, now = new Date()) {
  if (!row || !row.suspended_at) return { suspended: false };
  const until = row.suspended_until ? new Date(row.suspended_until) : null;
  if (until && until.getTime() <= now.getTime()) {
    return { suspended: false, expired: true, until, reason: row.suspended_reason || '' };
  }
  return {
    suspended: true,
    until,
    reason: row.suspended_reason || '',
    scope: row.suspended_scope || 'all',
    suspendedAt: row.suspended_at,
  };
}

async function loadSuspension(db, userId) {
  const result = await db.query(
    `SELECT suspended_at, suspended_until, suspended_reason, suspended_scope
       FROM users WHERE id = $1`,
    [userId]
  );
  return suspensionState(result.rows[0]);
}

async function clearExpired(db, userId) {
  await db.query(
    `UPDATE users
        SET suspended_at = NULL, suspended_until = NULL, suspended_reason = NULL,
            suspended_scope = 'all', suspended_by = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND suspended_at IS NOT NULL AND suspended_until IS NOT NULL AND suspended_until <= NOW()`,
    [userId]
  ).catch(error => Logger.warn(`[策略] 清理过期暂停失败: ${error.message}`));
}

async function suspendUser(db, { userId, until, reason, scope = 'all', by = null }) {
  await db.query(
    `UPDATE users
        SET suspended_at = NOW(), suspended_until = $2, suspended_reason = $3,
            suspended_scope = $4, suspended_by = $5, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [userId, until || null, reason || '', scope === 'api' ? 'api' : 'all', by]
  );
}

async function resumeUser(db, userId) {
  await db.query(
    `UPDATE users
        SET suspended_at = NULL, suspended_until = NULL, suspended_reason = NULL,
            suspended_scope = 'all', suspended_by = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [userId]
  );
}

module.exports = { suspensionState, loadSuspension, clearExpired, suspendUser, resumeUser };
