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

function severityRank(value) {
  return { info: 1, warning: 2, critical: 3 }[String(value || 'warning')] || 2;
}

const channelSilence = new Map();
let alertConfigCache = { at: 0, rules: [], channels: [] };
const ALERT_CONFIG_TTL_MS = 10_000;

function shouldDispatch(ruleId, channelId, windowSeconds) {
  const key = `${ruleId}:${channelId}`;
  const now = Date.now();
  const until = channelSilence.get(key);
  if (until && until > now) return false;
  channelSilence.set(key, now + Math.max(30, Number(windowSeconds) || 300) * 1000);
  if (channelSilence.size > 2000) {
    for (const [k, value] of channelSilence) if (value <= now) channelSilence.delete(k);
  }
  return true;
}

async function loadAlertConfig(pool) {
  if (Date.now() - alertConfigCache.at < ALERT_CONFIG_TTL_MS) return alertConfigCache;
  const [rules, channels] = await Promise.all([
    pool.query('SELECT * FROM policy_alert_rules WHERE enabled = TRUE'),
    pool.query('SELECT * FROM policy_channels WHERE enabled = TRUE'),
  ]);
  alertConfigCache = { at: Date.now(), rules: rules.rows, channels: channels.rows };
  return alertConfigCache;
}

function renderAlertTemplate(template, event) {
  if (!template) return event.text;
  return String(template)
    .split('{policy}').join(String(event.policy?.name || event.policy?.id || ''))
    .split('{user}').join(String(event.user?.username || event.user?.id || ''))
    .split('{client}').join(String(event.client || ''))
    .split('{action}').join(String(event.action || event.event || ''))
    .split('{message}').join(String(event.text || ''))
    .split('{time}').join(new Date().toISOString());
}

async function dispatchAlertEvent(event) {
  const { pool } = require('../../models/database');
  const { dispatchChannel } = require('./channels');
  try {
    const config = await loadAlertConfig(pool);
    const rules = config.rules.filter(rule => rule.event_type === event.event || rule.event_type === '*');
    if (!rules.length) return;
    for (const rule of rules) {
      const payload = { ...event, text: renderAlertTemplate(rule.template, event) };
      for (const channel of config.channels) {
        if (!(rule.channel_ids || []).includes(channel.id)) continue;
        if (severityRank(event.severity) < severityRank(channel.min_severity)) continue;
        if (!shouldDispatch(rule.id, channel.id, rule.silence_window_seconds)) continue;
        dispatchChannel(channel, payload).catch(error => Logger.warn(`[策略] 渠道 ${channel.id} 发送失败: ${error.message}`));
      }
    }
  } catch (error) {
    Logger.warn(`[策略] 告警分发失败: ${error.message}`);
  }
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
  dispatchAlertEvent({
    event: decision.action === 'block' ? 'block' : 'hit',
    severity: decision.action === 'block' ? 'critical' : 'warning',
    title: `策略命中：${policyName}`,
    text: body,
    policy: { id: decision.policy?.id || null, name: policyName },
    user: { id: signals.actor?.userId || null, username: user },
  }).catch(() => {});
}

function invalidateAlertConfigCache() {
  alertConfigCache = { at: 0, rules: [], channels: [] };
}

module.exports = { notifyPolicyHit, getAdminIds, invalidateAdminCache, dispatchAlertEvent, invalidateAlertConfigCache };
