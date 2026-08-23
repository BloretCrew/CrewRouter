/**
 * 登录状态上报接收端（仅 demo: true 时挂载）
 *
 * 其他自建 CrewRouter 实例在其用户登录/退出登录时调用本接口上报事件。
 * 仅记录：事件类型、实例域名、实例设备码、账户类型（是否管理员）、
 * 终端登录 IP、上报实例出口 IP、User-Agent 与时间。
 * 不包含用户身份信息（无用户名/邮箱）。
 *
 * 说明：demo 模式下主连接池为 mock 且启动时不执行迁移（index.js startServer），
 * 因此本模块自建 pg 连接池并自行确保表结构存在。
 */

const express = require('express');
const Logger = require('../logger');
const config = require('../config-loader');

const router = express.Router();

// ---------- 数据库（复用中央站点真实连接池） ----------
const { getPool } = require('../store/db');
let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS login_reports (
      id BIGSERIAL PRIMARY KEY,
      event TEXT NOT NULL,
      domain TEXT,
      device_id TEXT,
      is_admin BOOLEAN,
      client_ip TEXT,
      reporter_ip TEXT,
      user_agent TEXT,
      version TEXT,
      event_time TIMESTAMPTZ,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await getPool().query(
    'CREATE INDEX IF NOT EXISTS idx_login_reports_created_at ON login_reports (created_at)'
  );
  // 供「按 IP 查询用户登录过的实例」的索引
  await getPool().query(
    'CREATE INDEX IF NOT EXISTS idx_login_reports_client_ip ON login_reports (client_ip, event_time DESC)'
  );
  tableReady = true;
}

// ---------- 校验与限流 ----------
const ALLOWED_EVENTS = new Set(['login', 'logout']);
const MAX_LEN = {
  domain: 255,
  deviceId: 64,
  ip: 64,
  userAgent: 512,
  version: 32,
};

function cleanStr(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s.slice(0, max) : null;
}

// 轻量内存限流：每个上报来源 IP 每分钟最多 30 次
const RATE_LIMIT_PER_MINUTE = 30;
const rateBuckets = new Map();

function isRateLimited(key) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= 60000) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  // 防止桶无限增长：超阈值时清理过期桶
  if (rateBuckets.size > 10000) {
    for (const [k, b] of rateBuckets) {
      if (now - b.start >= 60000) rateBuckets.delete(k);
    }
  }
  return bucket.count > RATE_LIMIT_PER_MINUTE;
}

router.post('/', async (req, res) => {
  const body = req.body || {};
  const reporterIp = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';

  try {
    // 可选共享 token：接收端配置了才校验
    const expectedToken =
      process.env.CR_LOGIN_REPORT_TOKEN || (config.loginReport && config.loginReport.token) || '';
    if (expectedToken && req.headers['x-report-token'] !== expectedToken) {
      return res.status(401).json({ error: 'invalid token' });
    }

    if (isRateLimited(reporterIp)) {
      Logger.warn(`[登录上报] 触发限流: ${reporterIp}`);
      return res.status(429).json({ error: 'too many requests' });
    }

    const event = cleanStr(body.event, 16);
    if (!event || !ALLOWED_EVENTS.has(event)) {
      return res.status(400).json({ error: 'invalid event' });
    }

    let eventTime = body.time ? new Date(body.time) : new Date();
    if (Number.isNaN(eventTime.getTime())) eventTime = new Date();

    await ensureTable();
    await getPool().query(
      `INSERT INTO login_reports
         (event, domain, device_id, is_admin, client_ip, reporter_ip, user_agent, version, event_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        event,
        cleanStr(body.domain, MAX_LEN.domain),
        cleanStr(body.deviceId, MAX_LEN.deviceId),
        body.isAdmin === true,
        cleanStr(body.ip, MAX_LEN.ip),
        reporterIp,
        cleanStr(body.userAgent, MAX_LEN.userAgent),
        cleanStr(body.version, MAX_LEN.version),
        eventTime,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    // 存储不可用时返回 503，由调用方按需重试/静默放弃
    Logger.error('[登录上报] 写入失败:', err.message);
    res.status(503).json({ error: 'storage unavailable' });
  }
});

module.exports = router;
