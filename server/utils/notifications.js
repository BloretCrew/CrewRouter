const axios = require('axios');
const { pool } = require('../models/database');
const Logger = require('../logger');

const NOTIFICATION_TYPES = {
  QUOTA_INSUFFICIENT: 'quota_insufficient',
  REQUEST_ERROR: 'request_error',
};

const NOTIFICATION_TITLES = {
  [NOTIFICATION_TYPES.QUOTA_INSUFFICIENT]: '额度不足',
  [NOTIFICATION_TYPES.REQUEST_ERROR]: '请求异常',
};

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || 'https://api.day.app').trim().replace(/\/+$/, '');
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function truncate(value, max = 4000) {
  const text = String(value == null ? '' : value);
  return text.length > max ? text.slice(0, max) : text;
}

async function getNotificationSettings(userId) {
  const result = await pool.query(
    `SELECT bark_enabled, bark_server_key, bark_endpoint,
            notify_quota_enabled, notify_error_enabled
     FROM users WHERE id = $1`,
    [userId]
  );
  const row = result.rows[0] || {};
  return {
    barkEnabled: row.bark_enabled === true,
    barkServerKey: row.bark_server_key || '',
    barkEndpoint: row.bark_endpoint || 'https://api.day.app',
    notifyQuota: row.notify_quota_enabled !== false,
    notifyErrors: row.notify_error_enabled !== false,
  };
}

async function updateNotificationSettings(userId, settings) {
  const endpoint = normalizeEndpoint(settings.barkEndpoint || 'https://api.day.app');
  if (!endpoint) throw new Error('Bark 服务地址必须是 http 或 https 地址');
  const serverKey = String(settings.barkServerKey || '').trim();
  if (settings.barkEnabled && !serverKey) throw new Error('启用 Bark 通知前请输入 Server Key');

  await pool.query(
    `UPDATE users SET bark_enabled = $2, bark_server_key = $3, bark_endpoint = $4,
      notify_quota_enabled = $5, notify_error_enabled = $6,
      updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [userId, !!settings.barkEnabled, serverKey || null, endpoint,
      settings.notifyQuota !== false, settings.notifyErrors !== false]
  );
}

async function createNotification(userId, type, title, body, metadata = {}) {
  const result = await pool.query(
    `INSERT INTO user_notifications (user_id, type, title, body, metadata)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [userId, type, truncate(title, 200), truncate(body), JSON.stringify(metadata || {})]
  );
  return result.rows[0];
}

async function sendBark(userId, title, body) {
  const settings = await getNotificationSettings(userId);
  if (!settings.barkEnabled || !settings.barkServerKey) return { skipped: true };
  const endpoint = normalizeEndpoint(settings.barkEndpoint);
  if (!endpoint) return { success: false, error: 'Bark 服务地址无效' };
  try {
    await axios.post(`${endpoint}/${encodeURIComponent(settings.barkServerKey)}`, {
      title: truncate(title, 200),
      body: truncate(body),
      group: 'CrewRouter',
    }, { timeout: 10000, validateStatus: status => status >= 200 && status < 300 });
    return { success: true };
  } catch (error) {
    Logger.warn(`[通知] Bark 发送失败 userId=${userId}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function notifyUser(userId, type, body, metadata = {}) {
  if (!userId) return;
  try {
    const settings = await getNotificationSettings(userId);
    if (type === NOTIFICATION_TYPES.QUOTA_INSUFFICIENT && !settings.notifyQuota) return;
    if (type === NOTIFICATION_TYPES.REQUEST_ERROR && !settings.notifyErrors) return;

    const title = NOTIFICATION_TITLES[type] || '系统通知';
    // 同一用户同一类型 5 分钟内只发送一次，避免重试/并发造成通知轰炸。
    const recent = await pool.query(
      `SELECT id FROM user_notifications
       WHERE user_id = $1 AND type = $2 AND created_at > NOW() - INTERVAL '5 minutes' LIMIT 1`,
      [userId, type]
    );
    if (recent.rows.length) return;

    await createNotification(userId, type, title, body, metadata);
    await sendBark(userId, title, body);
  } catch (error) {
    Logger.warn(`[通知] 创建通知失败 userId=${userId}: ${error.message}`);
  }
}

async function listNotifications(userId, limit = 50) {
  const result = await pool.query(
    `SELECT id, type, title, body, metadata, read_at, created_at
     FROM user_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100)]
  );
  return result.rows;
}

async function markNotificationRead(userId, id) {
  const result = await pool.query(
    `UPDATE user_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
     WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]
  );
  return result.rowCount > 0;
}

async function deleteNotification(userId, id) {
  const result = await pool.query(
    'DELETE FROM user_notifications WHERE id = $1 AND user_id = $2', [id, userId]
  );
  return result.rowCount > 0;
}

async function clearNotifications(userId) {
  await pool.query('DELETE FROM user_notifications WHERE user_id = $1', [userId]);
}

module.exports = {
  NOTIFICATION_TYPES,
  getNotificationSettings,
  updateNotificationSettings,
  createNotification,
  notifyUser,
  sendBark,
  listNotifications,
  markNotificationRead,
  deleteNotification,
  clearNotifications,
};
