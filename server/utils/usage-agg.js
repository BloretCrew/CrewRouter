/**
 * 统计聚合表（任务书 Phase 1）：usage_daily_agg
 *
 * 作用：把 usage_records 按（天、用户、模型、密钥、客户端）聚合并永久保留，
 * 作为 /stats、/leaderboard 与后续限流长窗口计数的「窗口外真相源」，保证明细
 * 被清除（Phase 3）后统计/排行/长窗口计数仍连续。
 *
 * 设计约定：
 * - 键列写入归一化值：NULL → user_id=0 / model_id='' / api_key_id=0 /
 *   request_source='unknown'，使普通 UNIQUE 约束与 ON CONFLICT 可直接使用。
 * - upsert 是「整日重算替换」语义：聚合 SELECT 每次覆盖完整一天，重复执行幂等，
 *   不会把两次运行的数字累加翻倍。
 * - 聚合数据永不删除（任务书追加约束）。
 * - 任务书列清单之外额外加了 prompt_tokens / completion_tokens 两列：
 *   统计页「输入/输出」卡片、/leaderboard 缓存命中率、daily 压缩边界标记
 *   都需要窗口外这部分数据，否则双轨合并后这些指标会断档。
 */

const http = require('http');
const { pool } = require('../models/database');
const config = require('../config-loader');
const Logger = require('../logger');
const { logRetention } = require('./retention-log');
const { shanghaiDateString, shanghaiDateRange } = require('./timezone');

// 明细保留窗口默认值 = Phase 4 retention.purge_days 的默认值（90 天）
const DEFAULT_DETAIL_WINDOW_DAYS = 90;
const AGG_TABLE = 'usage_daily_agg';
const HEALTH_PORT = (config.app && config.app.port) || 20003;

// settings 读取走短 TTL 缓存，避免每个统计请求都查库
let configCache = { value: null, loadedAt: 0 };
const CONFIG_TTL_MS = 30000;

let aggTableReady = false;
let aggTableChecked = false;

// ---------- 配置 ----------

async function readSetting(key) {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
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
    Logger.warn(`[每日聚合] 读取设置 ${key} 失败: ${err.message}`);
    return null;
  }
}

async function readSettingInt(key, fallback) {
  const raw = await readSetting(key);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function readSettingBool(key, fallback) {
  const raw = await readSetting(key);
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === 'false') return raw === 'true';
  return fallback;
}

/**
 * 读取保留配置（Phase 4 的 key 先行生效，缺省用任务书默认值）。
 * @returns {Promise<{aggEnabled: boolean, purgeDays: number}>}
 *   purgeDays=0 表示永不按时长删除 → 明细窗口视为无限，双轨恒走明细。
 */
async function getRetentionConfig({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && configCache.value && now - configCache.loadedAt < CONFIG_TTL_MS) {
    return configCache.value;
  }
  const aggEnabled = await readSettingBool('retention.agg_enabled', true);
  const purgeDays = await readSettingInt('retention.purge_days', DEFAULT_DETAIL_WINDOW_DAYS);
  const value = { aggEnabled, purgeDays: purgeDays > 0 ? purgeDays : 0 };
  configCache = { value, loadedAt: now };
  return value;
}

/** 管理后台修改 retention.* 设置后调用使配置立即生效 */
function invalidateRetentionConfigCache() {
  configCache = { value: null, loadedAt: 0 };
}

// ---------- 表 ----------

/**
 * 建表（IF NOT EXISTS）。新表加普通索引即可（无并发写者，仅每日 03:05 单写者）；
 * 任务书「索引一律 CONCURRENTLY」针对的是 usage_records 等热表，这里不涉及。
 */
async function ensureUsageDailyAggTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${AGG_TABLE} (
      id BIGSERIAL PRIMARY KEY,
      agg_date DATE NOT NULL,
      user_id INTEGER NOT NULL DEFAULT 0,
      model_id VARCHAR(100) NOT NULL DEFAULT '',
      api_key_id INTEGER NOT NULL DEFAULT 0,
      request_source VARCHAR(32) NOT NULL DEFAULT 'unknown',
      request_count BIGINT NOT NULL DEFAULT 0,
      tokens_used BIGINT NOT NULL DEFAULT 0,
      cached_tokens BIGINT NOT NULL DEFAULT 0,
      weighted_tokens BIGINT NOT NULL DEFAULT 0,
      cost NUMERIC NOT NULL DEFAULT 0,
      latency_sum BIGINT NOT NULL DEFAULT 0,
      latency_count INTEGER NOT NULL DEFAULT 0,
      prompt_tokens BIGINT NOT NULL DEFAULT 0,
      completion_tokens BIGINT NOT NULL DEFAULT 0,
      UNIQUE (agg_date, user_id, model_id, api_key_id, request_source)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_daily_agg_date ON ${AGG_TABLE} (agg_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_daily_agg_user_date ON ${AGG_TABLE} (user_id, agg_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_daily_agg_date_source ON ${AGG_TABLE} (agg_date, request_source)`);
  Logger.info('[每日聚合] 表 usage_daily_agg 已就绪');
}

/** 延迟探测表是否存在（防止路由在迁移前被调用时报错），结果进程内缓存 */
async function isAggTableReady() {
  if (aggTableChecked) return aggTableReady;
  try {
    const r = await pool.query(`SELECT to_regclass('public.${AGG_TABLE}') AS t`);
    aggTableReady = !!r.rows[0] && !!r.rows[0].t;
  } catch {
    aggTableReady = false;
  }
  aggTableChecked = true;
  return aggTableReady;
}

// ---------- 日期工具 ----------

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 从 startDate 到 endDate（含）按自然月切块 */
function monthChunks(startDate, endDate) {
  const chunks = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    const first = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const last = next > end ? end : new Date(next.getTime() - 86400000);
    chunks.push({ start: first.toISOString().slice(0, 10), end: last.toISOString().slice(0, 10) });
    cursor = next;
  }
  return chunks;
}

/**
 * 把一个 [startDate, endDate]（含）查询区间按明细保留窗口切成两段：
 * - detail：窗口内（最近 detailWindowDays 个整日历日）→ 走 usage_records 明细
 * - agg：窗口外 → 走 usage_daily_agg 聚合表
 * 返回 { detail: {start,end}|null, agg: {start,end}|null }。
 */
function computeSplit(startDate, endDate, detailWindowDays) {
  if (!detailWindowDays || detailWindowDays <= 0 || detailWindowDays >= 99999) {
    return { detail: { start: startDate, end: endDate }, agg: null };
  }
  const cutoff = addDays(shanghaiDateString(), -(detailWindowDays - 1)); // 明细窗口首日
  if (startDate >= cutoff) {
    return { detail: { start: startDate, end: endDate }, agg: null };
  }
  const aggEnd = addDays(cutoff, -1);
  if (endDate < cutoff) {
    return { detail: null, agg: { start: startDate, end: endDate } };
  }
  return { detail: { start: cutoff, end: endDate }, agg: { start: startDate, end: aggEnd } };
}

// ---------- 健康检查（批间守护） ----------

function isHealthy() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: HEALTH_PORT, path: '/api/version', timeout: 3000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 聚合 upsert ----------

/**
 * 聚合 [startDate, endDate]（含，整日历日）并 upsert 入表。
 * 替换语义保证幂等。返回 { rows, startDate, endDate }（rows 为受影响行数）。
 */
async function aggregateDateRange(startDate, endDate) {
  const result = await pool.query(
    `INSERT INTO ${AGG_TABLE}
       (agg_date, user_id, model_id, api_key_id, request_source,
        request_count, tokens_used, cached_tokens, weighted_tokens, cost,
        latency_sum, latency_count, prompt_tokens, completion_tokens)
     SELECT
        to_char(created_at, 'YYYY-MM-DD')::date,
        COALESCE(user_id, 0),
        COALESCE(model_id, ''),
        COALESCE(api_key_id, 0),
        COALESCE(NULLIF(request_source, ''), 'unknown'),
        COUNT(*)::bigint,
        COALESCE(SUM(tokens_used), 0)::bigint,
        COALESCE(SUM(cached_tokens), 0)::bigint,
        COALESCE(SUM(weighted_tokens), 0)::bigint,
        COALESCE(SUM(cost), 0)::numeric,
        COALESCE(SUM(latency_ms), 0)::bigint,
        COUNT(latency_ms)::int,
        COALESCE(SUM(prompt_tokens), 0)::bigint,
        COALESCE(SUM(completion_tokens), 0)::bigint
     FROM usage_records
     WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
     GROUP BY 1, 2, 3, 4, 5
     ON CONFLICT (agg_date, user_id, model_id, api_key_id, request_source) DO UPDATE SET
       request_count = EXCLUDED.request_count,
       tokens_used = EXCLUDED.tokens_used,
       cached_tokens = EXCLUDED.cached_tokens,
       weighted_tokens = EXCLUDED.weighted_tokens,
       cost = EXCLUDED.cost,
       latency_sum = EXCLUDED.latency_sum,
       latency_count = EXCLUDED.latency_count,
       prompt_tokens = EXCLUDED.prompt_tokens,
       completion_tokens = EXCLUDED.completion_tokens`,
    [startDate, endDate]
  );
  return { rows: result.rowCount || 0, startDate, endDate };
}

// ---------- 全量回填 ----------

/**
 * 一次性把现存全部历史按天聚合入表。
 * 按月切片、单批单事务、批间 sleep + 健康检查（连续两次非 200 中止）。
 * @param {object} opts { dryRun, startDate, endDate, batchIntervalMs }
 */
async function backfillDailyAgg({ dryRun = false, startDate = null, endDate = null, batchIntervalMs = 1500 } = {}) {
  const bounds = await pool.query('SELECT MIN(created_at)::date AS min_d, MAX(created_at)::date AS max_d FROM usage_records');
  const minDateRaw = startDate || (bounds.rows[0] && bounds.rows[0].min_d);
  const maxDateRaw = endDate || (bounds.rows[0] && bounds.rows[0].max_d);
  // node-pg 把 ::date 解析成 Date 对象（含时区偏移），统一归一化为 YYYY-MM-DD
  const norm = (v) => {
    if (!v) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
  };
  const minDate = norm(minDateRaw);
  const maxDate = norm(maxDateRaw);
  if (!minDate || !maxDate) {
    logRetention('[回填] usage_records 无数据，跳过');
    return { aggregated: 0, months: 0, dryRun };
  }
  const chunks = monthChunks(String(minDate), String(maxDate));
  let totalRows = 0;
  let consecutiveFailures = 0;
  let aborted = false;
  logRetention(`[回填] 开始${dryRun ? '（dry-run）' : ''}：${minDate} ~ ${maxDate}，共 ${chunks.length} 个月切片`);
  for (let i = 0; i < chunks.length; i++) {
    const { start, end } = chunks[i];
    if (!(await isHealthy())) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        aborted = true;
        logRetention(`[回填] 中止：连续两次健康检查失败（${start} 切片前）`);
        break;
      }
    } else {
      consecutiveFailures = 0;
    }
    if (dryRun) {
      const probe = await pool.query(
        `SELECT COUNT(*)::int AS groups,
                COALESCE(SUM(cnt), 0)::bigint AS rows
         FROM (
           SELECT COUNT(*) AS cnt
           FROM usage_records
           WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
           GROUP BY to_char(created_at, 'YYYY-MM-DD'), COALESCE(user_id, 0),
                    COALESCE(model_id, ''), COALESCE(api_key_id, 0),
                    COALESCE(NULLIF(request_source, ''), 'unknown')
         ) s`,
        [start, end]
      );
      const p = probe.rows[0] || {};
      totalRows += Number(p.rows || 0);
      logRetention(`[回填][dry-run] ${start} ~ ${end}: 明细 ${Number(p.rows || 0)} 行 → 聚合 ${p.groups} 组`);
    } else {
      const r = await aggregateDateRange(start, end);
      totalRows += r.rows;
      logRetention(`[回填] ${start} ~ ${end}: upsert ${r.rows} 行`);
    }
    if (i < chunks.length - 1) await sleep(batchIntervalMs);
  }
  logRetention(`[回填] ${aborted ? '中止' : '完成'}：${dryRun ? '预计聚合' : '写入'} ${totalRows} 行${aborted ? '（未全部处理）' : ''}`);
  return { aggregated: totalRows, months: chunks.length, dryRun, aborted };
}

// ---------- 每日调度（03:05 聚合前一天；停机错过则启动补跑） ----------

/**
 * 补跑缺失的天：从 MAX(agg_date)+1 到昨天，逐日小事务 + 批间 sleep + 健康检查。
 * 表为空时不补历史（历史由回填脚本负责），只等 03:05 日常执行。
 */
async function runDailyAggCatchup() {
  const cfg = await getRetentionConfig({ fresh: true });
  if (!cfg.aggEnabled) {
    logRetention('[每日聚合] 跳过：retention.agg_enabled=false');
    return { skipped: true };
  }
  const maxRow = await pool.query(`SELECT MAX(agg_date)::text AS max_d FROM ${AGG_TABLE}`);
  const from = maxRow.rows[0] && maxRow.rows[0].max_d ? addDays(String(maxRow.rows[0].max_d), 1) : null;
  const yesterday = addDays(shanghaiDateString(), -1);
  if (!from) {
    logRetention('[每日聚合] usage_daily_agg 为空：历史由回填脚本负责，本次跳过');
    return { noop: true };
  }
  if (from > yesterday) {
    logRetention(`[每日聚合] 无需补跑（max=${from}，昨天=${yesterday}）`);
    return { noop: true };
  }
  let total = 0;
  let fails = 0;
  let aborted = false;
  let d = from;
  while (d <= yesterday) {
    if (!(await isHealthy())) {
      fails++;
      if (fails >= 2) {
        aborted = true;
        logRetention(`[每日聚合] 中止：连续两次健康检查失败（${d} 前）`);
        break;
      }
    } else {
      fails = 0;
    }
    const r = await aggregateDateRange(d, d);
    total += r.rows;
    logRetention(`[每日聚合] ${d}: upsert ${r.rows} 行`);
    await sleep(800);
    d = addDays(d, 1);
  }
  logRetention(`[每日聚合] ${aborted ? '中止' : '完成'}：补跑 ${total} 行`);
  return { aggregated: total, aborted };
}

function scheduleNextDailyAgg() {
  const now = new Date();
  const next = new Date(now);
  // 进程时区已固定为 Asia/Shanghai（utils/timezone），本地 03:05 即上海 03:05
  next.setHours(3, 5, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next.getTime() - now.getTime();
  setTimeout(async () => {
    try {
      await runDailyAggCatchup();
    } catch (err) {
      Logger.warn(`[每日聚合] 执行异常: ${err.message}`);
      logRetention(`[每日聚合] 执行异常: ${err.message}`);
    }
    scheduleNextDailyAgg();
  }, delay);
  Logger.info(`[每日聚合] 下次执行: ${next.toLocaleString()}`);
}

/** 非 demo 模式：启动即补跑一次（停机错过 03:05 的兜底），随后按日调度 */
function startDailyAggScheduler() {
  if (config.demo) return;
  runDailyAggCatchup().catch((err) => {
    Logger.warn(`[每日聚合] 启动补跑失败: ${err.message}`);
    logRetention(`[每日聚合] 启动补跑失败: ${err.message}`);
  });
  scheduleNextDailyAgg();
}

// ---------- 双轨查询辅助（/stats、/leaderboard 共用） ----------

/**
 * 拉取窗口外聚合明细行（含名称联表）。
 * @param {object} opts { start, end, userId, modelId, requestSource, teamId, providerId }
 * @returns {Promise<Array>} 每行一个（天,用户,模型,密钥,客户端）聚合组
 */
async function fetchAggRows({ start, end, userId = null, modelId = null, requestSource = null, teamId = null, providerId = null } = {}) {
  const params = [start, end];
  let sql = `
    SELECT
      to_char(a.agg_date, 'YYYY-MM-DD') AS date,
      a.user_id, a.model_id, a.api_key_id, a.request_source,
      a.request_count, a.tokens_used, a.cached_tokens, a.weighted_tokens, a.cost,
      a.latency_sum, a.latency_count, a.prompt_tokens, a.completion_tokens,
      COALESCE(NULLIF(m.name, ''), '未知模型') AS model_name,
      COALESCE(usr.username, '未知成员') AS user_name,
      usr.team_id,
      usr.team_id,
      COALESCE(t.name, '未分配 Team') AS team_name,
      ug.id AS group_id,
      COALESCE(ug.name, '未分配用户组') AS group_name,
      COALESCE(ak.name, '') AS key_name,
      ak.key_prefix
    FROM ${AGG_TABLE} a
    LEFT JOIN models m ON m.id = a.model_id
    LEFT JOIN users usr ON usr.id = a.user_id
    LEFT JOIN teams t ON t.id = usr.team_id
    LEFT JOIN user_groups ug ON ug.id = usr.group_id
    LEFT JOIN api_keys ak ON ak.id = a.api_key_id
    WHERE a.agg_date >= $1 AND a.agg_date <= $2`;
  if (userId) {
    params.push(userId);
    sql += ` AND a.user_id = $${params.length}`;
  }
  if (modelId) {
    params.push(modelId);
    sql += ` AND a.model_id = $${params.length}`;
  }
  if (requestSource) {
    params.push(requestSource);
    sql += ` AND a.request_source = $${params.length}`;
  }
  if (teamId) {
    params.push(teamId);
    sql += ` AND a.model_id IN (SELECT model_id FROM team_models WHERE team_id = $${params.length})`;
  }
  if (providerId) {
    // 聚合表无历史 provider 维度，用「模型当前所属供应商」近似（models.provider 与 usage_records.provider_id 同域）
    params.push(providerId);
    sql += ` AND m.provider = $${params.length}`;
  }
  const r = await pool.query(sql, params);
  return r.rows;
}

/** 通用折叠：按 key 对数值列求和（含 latency），合并 keys 字段 */
function foldAggRows(rows, keyField, nameField = null) {
  const map = new Map();
  const FIELDS = [
    'request_count', 'tokens_used', 'cached_tokens', 'weighted_tokens', 'cost',
    'latency_sum', 'latency_count', 'prompt_tokens', 'completion_tokens',
  ];
  for (const r of rows) {
    const k = String(r[keyField] == null ? '' : r[keyField]);
    let cur = map.get(k);
    if (!cur) {
      cur = { key: k };
      for (const f of FIELDS) cur[f] = 0;
      if (nameField) cur[nameField] = r[nameField] || null;
      map.set(k, cur);
    }
    for (const f of FIELDS) cur[f] += Number(r[f]) || 0;
  }
  return [...map.values()];
}

/**
 * 把两条「按同一 key 分组」的结果合并：数值列相加，latency 用 sum/count 重算。
 * @param {Array} detailRows 明细查询行（latency_sum/latency_count/avg_latency 可选）
 * @param {Array} aggRows 聚合折叠行（foldAggRows 输出）
 * @param {Function} keyFn 取合并 key
 * @param {string|null} nameField 需要保留的展示名字段（合并后按 detail 优先）
 */
function mergeGrouped(detailRows, aggRows, keyFn, nameField = null) {
  const map = new Map();
  const FIELDS = [
    'requests', 'tokens', 'cached_tokens', 'cost', 'prompt_tokens', 'completion_tokens',
    'latency_sum', 'latency_count',
  ];
  const init = (k, src) => {
    const base = { key: k, requests: 0, tokens: 0, cached_tokens: 0, cost: 0, prompt_tokens: 0, completion_tokens: 0, latency_sum: 0, latency_count: 0, avg_latency: null };
    if (nameField) base[nameField] = src[nameField] || null;
    return base;
  };
  const addRow = (k, src, isDetail) => {
    let cur = map.get(k);
    if (!cur) {
      cur = init(k, src);
      map.set(k, cur);
    }
    for (const f of FIELDS) cur[f] += Number(src[f]) || 0;
    if (isDetail && nameField && src[nameField]) cur[nameField] = src[nameField];
  };
  for (const r of aggRows) addRow(keyFn(r), r, false);
  for (const r of detailRows) addRow(keyFn(r), r, true);
  for (const v of map.values()) {
    v.avg_latency = v.latency_count > 0 ? v.latency_sum / v.latency_count : null;
    delete v.latency_sum;
    delete v.latency_count;
  }
  return [...map.values()];
}

/** 按日期合并 daily：优先明细行（日期粒度不重叠，仅为兜底） */
function mergeDaily(detailRows, aggRows) {
  const map = new Map();
  for (const r of aggRows) map.set(r.date, { ...r });
  for (const r of detailRows) map.set(r.date, { ...r });
  return [...map.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

module.exports = {
  AGG_TABLE,
  DEFAULT_DETAIL_WINDOW_DAYS,
  getRetentionConfig,
  invalidateRetentionConfigCache,
  ensureUsageDailyAggTable,
  isAggTableReady,
  computeSplit,
  addDays,
  monthChunks,
  isHealthy,
  aggregateDateRange,
  backfillDailyAgg,
  runDailyAggCatchup,
  startDailyAggScheduler,
  fetchAggRows,
  foldAggRows,
  mergeGrouped,
  mergeDaily,
};