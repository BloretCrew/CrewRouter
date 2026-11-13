'use strict';

const { pool } = require('../../models/database');
const net = require('net');
const Logger = require('../../logger');

function safeIp(value) {
  const text = String(value || '').replace(/^::ffff:/, '');
  return net.isIP(text) ? text : null;
}

function recordLoginEvent({ userId = null, method = 'password', success = true, ip = null, userAgent = null, mfa = false, reason = null }) {
  pool.query(
    `INSERT INTO login_events (user_id, method, success, ip, user_agent, mfa, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId || null, String(method || 'password').slice(0, 24), !!success, safeIp(ip), String(userAgent || '').slice(0, 500), !!mfa, reason ? String(reason).slice(0, 500) : null]
  ).catch(error => Logger.warn(`[登录事件] 写入失败: ${error.message}`));
}

async function countRecentFailures({ userId = null, ip = null, minutes = 30 }) {
  const params = [minutes];
  const where = [];
  if (userId) { params.push(userId); where.push(`user_id = $${params.length}`); }
  if (ip) { params.push(safeIp(ip)); where.push(`ip = $${params.length}`); }
  if (!where.length) return 0;
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total FROM login_events
      WHERE success = FALSE AND created_at >= NOW() - ($1::int * INTERVAL '1 minute')
        AND ${where.join(' AND ')}`,
    params
  );
  return Number(result.rows[0]?.total || 0);
}

async function recentMethods({ userId, limit = 20 }) {
  const result = await pool.query(
    `SELECT method, success, ip, mfa, created_at FROM login_events
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

module.exports = { recordLoginEvent, countRecentFailures, recentMethods, safeIp };
