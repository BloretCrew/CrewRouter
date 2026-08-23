/**
 * 统计信息上报接收端（仅 demo: true 时挂载）
 *
 * 其他自建 CrewRouter 实例在其定时统计上报时调用本接口上报匿名聚合使用统计。
 * 仅记录：匿名实例设备码、实例域名、应用版本、统计窗口与聚合计数（请求量、Token、
 * 成本、活跃用户/密钥数、模型/供应商分布等）。不包含任何身份信息（无用户名/邮箱/IP/
 * User-Agent）、密钥内容或请求/回复正文。
 *
 * 说明：demo 模式下主连接池为 mock 且启动时不执行迁移（index.js startServer），
 * 因此本模块自建 pg 连接池并自行确保表结构存在。
 */

const express = require('express');
const { Pool } = require('pg');
const Logger = require('../logger');
const config = require('../config-loader');

const router = express.Router();

// ---------- 数据库（自建连接池） ----------
let pool = null;
let tableReady = false;

function getPool() {
  if (pool) return pool;
  pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    user: config.database.user,
    password: config.database.password,
  });
  pool.on('error', (err) => {
    Logger.error('[统计上报] 数据库连接错误:', err.message);
  });
  return pool;
}

async function ensureTable() {
  if (tableReady) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS stats_reports (
      id BIGSERIAL PRIMARY KEY,
      device_id TEXT,
      domain TEXT,
      version TEXT,
      window_start TIMESTAMPTZ,
      window_end TIMESTAMPTZ,
      generated_at TIMESTAMPTZ,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await getPool().query('CREATE INDEX IF NOT EXISTS idx_stats_reports_created_at ON stats_reports (created_at)');
  await getPool().query('CREATE INDEX IF NOT EXISTS idx_stats_reports_device ON stats_reports (device_id, window_start)');
  tableReady = true;
}

// ---------- 校验与限流 ----------
const MAX_LEN = {
  deviceId: 64,
  domain: 255,
  version: 32,
};
const MAX_PAYLOAD_BYTES = 64 * 1024; // 64KB

function cleanStr(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s.slice(0, max) : null;
}

function parseTime(value) {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
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
      process.env.CR_STATS_REPORT_TOKEN || (config.statsReport && config.statsReport.token) || '';
    if (expectedToken && req.headers['x-report-token'] !== expectedToken) {
      return res.status(401).json({ error: 'invalid token' });
    }

    if (isRateLimited(reporterIp)) {
      Logger.warn(`[统计上报] 触发限流: ${reporterIp}`);
      return res.status(429).json({ error: 'too many requests' });
    }

    const deviceId = cleanStr(body.deviceId, MAX_LEN.deviceId);
    if (!deviceId) {
      return res.status(400).json({ error: 'invalid deviceId' });
    }

    // payload 必须是对象，且序列化后不超限
    const payload = body.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ error: 'invalid payload' });
    }
    let payloadJson;
    try {
      payloadJson = JSON.stringify(payload);
    } catch {
      return res.status(400).json({ error: 'invalid payload' });
    }
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
      return res.status(400).json({ error: 'payload too large' });
    }

    await ensureTable();
    await getPool().query(
      `INSERT INTO stats_reports
         (device_id, domain, version, window_start, window_end, generated_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        deviceId,
        cleanStr(body.domain, MAX_LEN.domain),
        cleanStr(body.version, MAX_LEN.version),
        parseTime(body.windowStart),
        parseTime(body.windowEnd),
        parseTime(body.generatedAt || body.time || body.generated_at),
        payloadJson,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    Logger.error('[统计上报] 写入失败:', err.message);
    res.status(503).json({ error: 'storage unavailable' });
  }
});

// ---------- 数据页 overview（公开只读） ----------
const MAX_INSTANCES = 500;
const MAX_RECENT = 100;

router.get('/overview', async (req, res) => {
  try {
    await ensureTable();

    // 汇总
    const summary = (await getPool().query(
      `SELECT
         COUNT(*)::int AS total_reports,
         COUNT(DISTINCT device_id)::int AS total_instances,
         COALESCE(SUM((payload->'stats'->'requests'->>'total')::bigint),0)::bigint AS total_requests,
         COALESCE(SUM((payload->'stats'->'tokens'->>'total')::bigint),0)::bigint AS total_tokens,
         COALESCE(SUM((payload->'stats'->>'cost')::numeric),0)::numeric AS total_cost
       FROM stats_reports`
    )).rows[0] || {};

    // 各实例聚合（按请求量排序）
    const instances = (await getPool().query(
      `SELECT device_id,
         MAX(domain) AS domain,
         MAX(version) AS version,
         COUNT(*)::int AS reports_count,
         COALESCE(SUM((payload->'stats'->'requests'->>'total')::bigint),0)::bigint AS requests,
         COALESCE(SUM((payload->'stats'->'tokens'->>'total')::bigint),0)::bigint AS tokens,
         COALESCE(SUM((payload->'stats'->>'cost')::numeric),0)::numeric AS cost,
         MAX(window_end) AS last_window_end,
         MAX(generated_at) AS last_report_at
       FROM stats_reports
       GROUP BY device_id
       ORDER BY requests DESC
       LIMIT $1`,
      [MAX_INSTANCES]
    )).rows || [];

    // 最近上报
    const recent = (await getPool().query(
      `SELECT device_id, domain, version, window_start, window_end, generated_at, payload
       FROM stats_reports
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [MAX_RECENT]
    )).rows || [];

    res.json({
      summary: {
        totalReports: Number(summary.total_reports || 0),
        totalInstances: Number(summary.total_instances || 0),
        totalRequests: Number(summary.total_requests || 0),
        totalTokens: Number(summary.total_tokens || 0),
        totalCost: Number(summary.total_cost || 0),
        updatedAt: new Date().toISOString(),
      },
      instances: instances.map((i) => ({
        deviceId: i.device_id || 'unknown',
        domain: i.domain || '',
        version: i.version || '',
        reportsCount: Number(i.reports_count || 0),
        requests: Number(i.requests || 0),
        tokens: Number(i.tokens || 0),
        cost: Number(i.cost || 0),
        lastWindowEnd: i.last_window_end,
        lastReportAt: i.last_report_at,
      })),
      recent: recent.map((r) => ({
        deviceId: r.device_id || 'unknown',
        domain: r.domain || '',
        version: r.version || '',
        windowStart: r.window_start,
        windowEnd: r.window_end,
        generatedAt: r.generated_at,
        stats: (r.payload && r.payload.stats) || {},
      })),
    });
  } catch (err) {
    Logger.error('[统计上报] 读取 overview 失败:', err.message);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
