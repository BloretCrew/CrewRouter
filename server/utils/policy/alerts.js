'use strict';

const { pool } = require('../../models/database');
const Logger = require('../../logger');

let adminCache = { ids: [], at: 0 };
const ADMIN_CACHE_TTL_MS = 60_000;
const recentNotifications = new Map();
const NOTIFY_WINDOW_MS = 5 * 60 * 1000;

function shouldNotify(key) {
  const now = Date.now();
  const until = recentNotifications.get(key);
  if (until && until > now) return false;
  recentNotifications.set(key, now + NOTIFY_WINDOW_MS);
  if (recentNotifications.size > 5000) {
    for (const [k, value] of recentNotifications) if (value <= now) recentNotifications.delete(k);
  }
  return true;
}

async function getAdminIds() {
  if (adminCache.ids.length && Date.now() - adminCache.at < ADMIN_CACHE_TTL_MS) return adminCache.ids;
  const result = await pool.query('SELECT id FROM users WHERE is_admin = TRUE');
  adminCache = { ids: result.rows.map(row => Number(row.id)), at: Date.now() };
  return adminCache.ids;
}

function invalidateAdminCache() {
  adminCache = { ids: [], at: 0 };
}

/**
 * 命中告警：站内通知 + Bark（由 notifyUser 统一处理）。
 * 同一用户同类型 5 分钟内自动去重。
 */
async function notifyPolicyHit(signals, decision) {
  if (!decision || decision.action === 'shadow') return;
  const settings = decision.settings || {};
  const policyName = decision.policy?.name || '策略';
  const client = signals.identity?.harness || 'unknown';
  const user = signals.actor?.username || `#${signals.actor?.userId || '?'}`;
  const body = `策略「${policyName}」命中：成员 ${user}，客户端 ${client}，动作 ${decision.action}` +
    (decision.message ? `。${decision.message}` : '');
  const { notifyUser } = require('../notifications');

  if (settings.notify_member !== false && signals.actor?.userId) {
    const key = `member:${signals.actor.userId}:${decision.policy?.id || 0}:${decision.action}`;
    if (shouldNotify(key)) {
      notifyUser(signals.actor.userId, 'policy_notice', body, {
        policy_id: decision.policy?.id || null,
        action: decision.action,
      }).catch(error => Logger.warn(`[策略] 成员告警失败: ${error.message}`));
    }
  }
  if (settings.notify_admins !== false) {
    const admins = await getAdminIds().catch(() => []);
    for (const adminId of admins) {
      if (Number(adminId) === Number(signals.actor?.userId)) continue;
      const key = `admin:${adminId}:${decision.policy?.id || 0}:${decision.action}`;
      if (!shouldNotify(key)) continue;
      notifyUser(adminId, 'policy_admin_notice', body, {
        policy_id: decision.policy?.id || null,
        user_id: signals.actor?.userId || null,
        action: decision.action,
      }).catch(error => Logger.warn(`[策略] 管理员告警失败: ${error.message}`));
    }
  }
}

module.exports = { notifyPolicyHit, getAdminIds, invalidateAdminCache };
