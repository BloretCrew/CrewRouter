/**
 * 使用统计上报模块（仅 demo: false 的自建实例生效）
 *
 * 每个自建 CrewRouter 实例按固定间隔向官方服务器上报一次匿名聚合的使用统计，
 * 用于统计各网关的使用规模与趋势。默认关闭，必须在管理后台开启（或首次进入时
 * 在授权弹窗中允许）后才开始上报。
 *
 * 隐私说明：不含用户名/邮箱/IP/User-Agent/密钥内容等身份信息，也不含任何请求
 * 或回复正文，仅记录：匿名实例设备码、实例域名、应用版本、统计窗口与聚合计数
 * （请求量、Token、成本、活跃用户/密钥数、请求类型分布、以及可选的模型/供应商分布）。
 *
 * 可靠性：fire-and-forget，5 秒超时，任何失败仅记录 warn，绝不阻塞主流程。
 */

const axios = require('axios');
const Logger = require('../logger');
const config = require('../config-loader');

const { resolveInstanceId } = require('./login-reporter');

// ---------- 配置 ----------
const REPORT_URL =
  process.env.CR_STATS_REPORT_URL ||
  (config.statsReport && config.statsReport.url) ||
  'https://crewrouter.bloret.net/api/stats-report';
const REPORT_TOKEN =
  process.env.CR_STATS_REPORT_TOKEN ||
  (config.statsReport && config.statsReport.token) ||
  '';

// 配置级总开关：config statsReport.enabled 显式为 false 时强制关闭（管理后台开关不再生效）
const CONFIG_ENABLED = !((config.statsReport && config.statsReport.enabled) === false);

const REQUEST_TIMEOUT_MS = 5000;
const SETTINGS_CACHE_TTL_MS = 60000;
// 上次上报游标落库后，重启不重复上报；窗口上限 30 天，避免长时间宕机后一次上报过多
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BREAKDOWN_ENTRIES = 100;

let VERSION = '';
try {
  VERSION = require('../../package.json').version || '';
} catch {
  /* 版本号可选 */
}

// ---------- db 辅助 ----------
function getPool() {
  return require('../models/database').pool;
}

// settings.value 列是 json 类型：读取需 JSON.parse，写入需 JSON.stringify。
async function readSetting(key) {
  try {
    const { rows } = await getPool().query('SELECT value FROM settings WHERE key = $1', [key]);
    if (rows.length === 0) return null;
    const raw = rows[0].value;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  } catch (err) {
    Logger.warn(`[统计上报] 读取设置 ${key} 失败:`, err.message);
    return null;
  }
}

async function writeSetting(key, value) {
  try {
    await getPool().query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, JSON.stringify(value)]
    );
  } catch (err) {
    Logger.warn(`[统计上报] 写入设置 ${key} 失败:`, err.message);
  }
}

function parseSettingBoolean(raw) {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw === 'true';
    }
  }
  return false;
}

// ---------- 匿名设备码 ----------
// 复用 login-reporter 的 data/instance-id，保证同一实例的登录上报与统计上报共用同一匿名 UUID。
const instanceId = resolveInstanceId();

// ---------- 开关（settings 表 + 内存缓存） ----------
let enabledCache = { value: false, loadedAt: 0 };

async function isEnabled() {
  if (!CONFIG_ENABLED) return false;
  if (config.demo) return false;
  const now = Date.now();
  if (now - enabledCache.loadedAt < SETTINGS_CACHE_TTL_MS) return enabledCache.value;
  const raw = await readSetting('stats_report_enabled');
  if (raw == null) {
    // 尚未在授权弹窗/管理后台做过决定 → 隐私优先，不上报
    enabledCache = { value: false, loadedAt: now };
  } else {
    enabledCache = { value: parseSettingBoolean(raw), loadedAt: now };
  }
  return enabledCache.value;
}

/** 管理后台修改开关后可调用以立即生效（有 TTL 缓存兜底，可不调） */
function invalidateEnabledCache() {
  enabledCache.loadedAt = 0;
}

async function resolveGranularity() {
  const g = await readSetting('stats_report_granularity');
  if (g === 'counts' || g === 'detailed') return g;
  const cfg = config.statsReport && config.statsReport.granularity;
  return cfg === 'counts' ? 'counts' : 'detailed';
}

// ---------- 域名 ----------
function resolveDomain() {
  const cfgDomain = config.statsReport && config.statsReport.domain;
  if (cfgDomain && String(cfgDomain).trim()) return String(cfgDomain).trim();
  // 后台定时上报没有请求上下文，无法从 req 推断，需靠配置 statsReport.domain 显式指定
  return '';
}

// ---------- 聚合统计 ----------
async function query(windowStart, windowEnd) {
  const pool = getPool();
  // 成功/正常请求用量
  const usage = (await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COALESCE(SUM(prompt_tokens),0)::bigint AS tokens_prompt,
       COALESCE(SUM(completion_tokens),0)::bigint AS tokens_completion,
       COALESCE(SUM(cached_tokens),0)::bigint AS tokens_cached,
       COALESCE(SUM(tokens_used),0)::bigint AS tokens_total,
       COALESCE(SUM(cost),0)::numeric AS cost,
       COALESCE(AVG(latency_ms),0)::numeric AS avg_latency_ms,
       COUNT(DISTINCT user_id)::int AS active_users,
       COUNT(DISTINCT api_key_id)::int AS active_keys,
       COUNT(DISTINCT model_id)::int AS active_models,
       COUNT(DISTINCT provider_id)::int AS active_providers
     FROM usage_records
     WHERE created_at >= $1 AND created_at < $2`,
    [windowStart, windowEnd]
  )).rows[0] || {};

  // 失败请求
  const errors = (await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM api_error_records
     WHERE created_at >= $1 AND created_at < $2`,
    [windowStart, windowEnd]
  )).rows[0] || {};

  // 请求类型分布
  const reqTypes = (await pool.query(
    `SELECT request_type AS name, COUNT(*)::int AS requests, COALESCE(SUM(tokens_used),0)::bigint AS tokens
     FROM usage_records
     WHERE created_at >= $1 AND created_at < $2
     GROUP BY request_type ORDER BY requests DESC LIMIT $3`,
    [windowStart, windowEnd, MAX_BREAKDOWN_ENTRIES]
  )).rows || [];

  return {
    usage,
    errors: Number(errors.total || 0),
    requestTypes: reqTypes,
  };
}

async function queryBreakdown(windowStart, windowEnd) {
  const pool = getPool();
  const [models, providers] = await Promise.all([
    pool.query(
      `SELECT model_id AS name, COUNT(*)::int AS requests, COALESCE(SUM(tokens_used),0)::bigint AS tokens
       FROM usage_records
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY model_id ORDER BY requests DESC LIMIT $3`,
      [windowStart, windowEnd, MAX_BREAKDOWN_ENTRIES]
    ),
    pool.query(
      `SELECT provider_id AS name, COUNT(*)::int AS requests, COALESCE(SUM(tokens_used),0)::bigint AS tokens
       FROM usage_records
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY provider_id ORDER BY requests DESC LIMIT $3`,
      [windowStart, windowEnd, MAX_BREAKDOWN_ENTRIES]
    ),
  ]);
  return {
    models: models.rows || [],
    providers: providers.rows || [],
  };
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

async function collectStats(windowStart, windowEnd, granularity) {
  const { usage, errors, requestTypes } = await query(windowStart, windowEnd);
  const stats = {
    requests: {
      total: Number(usage.total || 0),
      success: Number(usage.total || 0),
      error: errors,
    },
    tokens: {
      prompt: Number(usage.tokens_prompt || 0),
      completion: Number(usage.tokens_completion || 0),
      cached: Number(usage.tokens_cached || 0),
      total: Number(usage.tokens_total || 0),
    },
    cost: round(usage.cost || 0),
    avgLatencyMs: round(usage.avg_latency_ms || 0, 0),
    activeUsers: Number(usage.active_users || 0),
    activeKeys: Number(usage.active_keys || 0),
    activeModels: Number(usage.active_models || 0),
    activeProviders: Number(usage.active_providers || 0),
    requestTypes: requestTypes.map((r) => ({ name: r.name || 'unknown', requests: Number(r.requests || 0) })),
  };

  if (granularity === 'detailed') {
    const { models, providers } = await queryBreakdown(windowStart, windowEnd);
    stats.models = models.map((r) => ({ name: r.name || 'unknown', requests: Number(r.requests || 0), tokens: Number(r.tokens || 0) }));
    stats.providers = providers.map((r) => ({ name: r.name || 'unknown', requests: Number(r.requests || 0), tokens: Number(r.tokens || 0) }));
  }

  return stats;
}

// ---------- 上报 ----------
async function resolveWindow() {
  const now = new Date();
  const intervalMs = ((config.statsReport && config.statsReport.interval) || 3600) * 1000;
  let startMs = now.getTime() - intervalMs;
  const cursorRaw = await readSetting('stats_report_last_at');
  if (cursorRaw != null) {
    const cursor = new Date(cursorRaw);
    if (!Number.isNaN(cursor.getTime())) {
      startMs = Math.max(startMs, Math.min(cursor.getTime(), now.getTime()));
    }
  }
  // 窗口上限，避免长时间宕机后首次上报覆盖过长时间范围
  startMs = Math.max(startMs, now.getTime() - MAX_WINDOW_MS);
  return { windowStart: new Date(startMs), windowEnd: now, intervalMs };
}

async function reportNow() {
  try {
    if (config.demo || !(await isEnabled())) return;
    const { windowStart, windowEnd } = await resolveWindow();
    const granularity = await resolveGranularity();
    const stats = await collectStats(windowStart, windowEnd, granularity);

    const report = {
      deviceId: instanceId,
      domain: resolveDomain(),
      version: VERSION,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      generatedAt: new Date().toISOString(),
      payload: {
        granularity,
        stats,
      },
    };

    await axios.post(REPORT_URL, report, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        ...(REPORT_TOKEN ? { 'X-Report-Token': REPORT_TOKEN } : {}),
      },
    });

    // 上报成功后推进游标
    await writeSetting('stats_report_last_at', windowEnd.toISOString());
    Logger.info(`[统计上报] 已上报 ${stats.requests.total} 请求 / ${stats.tokens.total} tokens (${stats.requests.error} 错误)`);
  } catch (err) {
    Logger.warn(`[统计上报] 上报失败（不影响主流程）: ${err.message}`);
  }
}

/** 启动定时上报（非 demo 模式下调用；demo 模式内部自动跳过） */
function startStatsReporter({ intervalMs } = {}) {
  if (config.demo) return;
  const ms = Number.isFinite(intervalMs) && intervalMs > 0
    ? intervalMs
    : ((config.statsReport && config.statsReport.interval) || 3600) * 1000;
  // 首次补报：延迟 5s 让服务完成初始化
  setTimeout(() => reportNow().catch(() => {}), 5000);
  setInterval(() => reportNow().catch(() => {}), ms);
  Logger.info(`[统计上报] 定时上报已启动，间隔 ${Math.round(ms / 1000)}s`);
}

module.exports = {
  reportNow,
  invalidateEnabledCache,
  startStatsReporter,
};
