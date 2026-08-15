/**
 * 模型调用可用率（uptime）
 * - 热路径：日聚合 + 15 分钟槽聚合（fire-and-forget）
 * - 展示默认：近 24 小时 / 每 15 分钟（96 槽）
 * - days>1 时仍支持按日聚合（兼容）
 * - 15 分钟槽数据保留 24 小时
 */
const { pool } = require('../models/database');
const Logger = require('../logger');

const DEFAULT_DAYS = 1;
const HOURS_WINDOW = 24;
/** 聚合槽宽度（毫秒） */
const SLOT_MS = 15 * 60 * 1000;
/** 近 24 小时对应槽数 */
const SLOT_COUNT = (HOURS_WINDOW * 60 * 60 * 1000) / SLOT_MS; // 96
/** 细粒度数据保留时长（毫秒） */
const RETENTION_MS = HOURS_WINDOW * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时清一次过期槽

let cleanupTimer = null;

function utcDayString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * 当前 UTC 15 分钟槽起点 ISO（对齐到 00/15/30/45 分，秒毫秒为 0）
 */
function utcSlotString(date = new Date()) {
  const ms = date.getTime();
  const aligned = Math.floor(ms / SLOT_MS) * SLOT_MS;
  return new Date(aligned).toISOString();
}

/** @deprecated 兼容旧导出名，现为 15 分钟槽 */
function utcHourString(date = new Date()) {
  return utcSlotString(date);
}

function daysAgoDateString(days, from = new Date()) {
  const d = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate()
  ));
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

function eachDayRange(days, from = new Date()) {
  const end = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate()
  ));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const out = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * 近 slotCount 个 15 分钟槽（含当前槽），UTC
 * @param {number} [slotCount=96]
 */
function eachSlotRange(slotCount = SLOT_COUNT, from = new Date()) {
  const count = Math.min(Math.max(parseInt(slotCount, 10) || SLOT_COUNT, 1), 24 * 4 * 7); // 最多 7 天
  const endMs = Math.floor(from.getTime() / SLOT_MS) * SLOT_MS;
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(new Date(endMs - i * SLOT_MS).toISOString());
  }
  return out;
}

/** @deprecated 兼容旧导出名 */
function eachHourRange(hours = HOURS_WINDOW, from = new Date()) {
  const h = Math.min(Math.max(parseInt(hours, 10) || HOURS_WINDOW, 1), 168);
  return eachSlotRange(h * 4, from);
}

/**
 * @param {number} success
 * @param {number} fail
 * @returns {'none'|'ok'|'degraded'|'outage'}
 */
function computeDayStatus(success, fail) {
  const s = Math.max(0, parseInt(success, 10) || 0);
  const f = Math.max(0, parseInt(fail, 10) || 0);
  const total = s + f;
  if (total === 0) return 'none';
  if (s === 0 && f > 0) return 'outage';
  const rate = f / total;
  if (rate >= 0.05) return 'outage';
  if (rate >= 0.01) return 'degraded';
  return 'ok';
}

/**
 * @param {{ success: number, fail: number }[]} dayStats
 */
function computeUptime(dayStats) {
  let totalSuccess = 0;
  let totalFail = 0;
  for (const d of dayStats || []) {
    totalSuccess += Math.max(0, parseInt(d.success, 10) || 0);
    totalFail += Math.max(0, parseInt(d.fail, 10) || 0);
  }
  const total = totalSuccess + totalFail;
  if (total === 0) {
    return {
      uptime_pct: null,
      label: 'No data',
      total_success: 0,
      total_fail: 0
    };
  }
  const pct = (totalSuccess / total) * 100;
  let label = 'Normal';
  if (pct < 95) label = 'Outage';
  else if (pct < 99) label = 'Degraded';
  return {
    uptime_pct: Math.round(pct * 100) / 100,
    label,
    total_success: totalSuccess,
    total_fail: totalFail
  };
}

/**
 * Fire-and-forget 记录一次模型调用结果（平台全局，不按用户）
 * 同时写入日聚合与 15 分钟槽聚合（表 model_uptime_hourly 的 hour 列存槽起点）
 * @param {string} modelId - models 表主键 id
 * @param {boolean} ok
 */
function recordModelCall(modelId, ok) {
  if (!modelId || typeof modelId !== 'string') return;
  const day = utcDayString();
  const slot = utcSlotString();
  const s = ok ? 1 : 0;
  const f = ok ? 0 : 1;

  pool.query(
    `INSERT INTO model_uptime_daily (model_id, day, success, fail)
     VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (model_id, day) DO UPDATE SET
       success = model_uptime_daily.success + EXCLUDED.success,
       fail = model_uptime_daily.fail + EXCLUDED.fail`,
    [modelId, day, s, f]
  ).catch(err => {
    Logger.warn(`[ModelUptime] 日记录失败 model=${modelId} ok=${ok}: ${err.message}`);
  });

  pool.query(
    `INSERT INTO model_uptime_hourly (model_id, hour, success, fail)
     VALUES ($1, $2::timestamptz, $3, $4)
     ON CONFLICT (model_id, hour) DO UPDATE SET
       success = model_uptime_hourly.success + EXCLUDED.success,
       fail = model_uptime_hourly.fail + EXCLUDED.fail`,
    [modelId, slot, s, f]
  ).catch(err => {
    Logger.warn(`[ModelUptime] 15 分钟槽记录失败 model=${modelId} ok=${ok}: ${err.message}`);
  });
}

function useSlotGranularity(days) {
  const n = parseInt(days, 10);
  return !Number.isFinite(n) || n <= 1;
}

/**
 * 删除超过保留期的 15 分钟槽数据
 */
async function cleanupOldSlotRecords() {
  try {
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    const result = await pool.query(
      `DELETE FROM model_uptime_hourly WHERE hour < $1::timestamptz`,
      [cutoff]
    );
    const n = result.rowCount || 0;
    if (n > 0) {
      Logger.info(`[ModelUptime] 清理过期 15 分钟槽 ${n} 条（保留 ${HOURS_WINDOW}h）`);
    }
  } catch (err) {
    Logger.warn(`[ModelUptime] 清理失败: ${err.message}`);
  }
}

function startUptimeCleanup() {
  if (cleanupTimer) return;
  // 启动后稍晚跑一次，再按小时间隔
  setTimeout(() => {
    cleanupOldSlotRecords();
  }, 30 * 1000);
  cleanupTimer = setInterval(() => {
    cleanupOldSlotRecords();
  }, CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

/**
 * 近 24 小时按 15 分钟槽批量查询
 */
async function getModelUptimeSlots(modelIds, slotCount = SLOT_COUNT) {
  const count = Math.min(Math.max(parseInt(slotCount, 10) || SLOT_COUNT, 1), 24 * 4 * 7);
  const ids = [...new Set((modelIds || []).filter(Boolean).map(String))];
  const slotList = eachSlotRange(count);
  const emptyItem = () => ({
    uptime_pct: null,
    label: 'No data',
    total_success: 0,
    total_fail: 0,
    spark: slotList.map(() => 'none')
  });

  if (ids.length === 0) {
    return {
      days: 1,
      hours: HOURS_WINDOW,
      slots: count,
      granularity: '15m',
      items: {}
    };
  }

  const startSlot = slotList[0];
  let rows = [];
  try {
    const result = await pool.query(
      `SELECT model_id, hour, success, fail
       FROM model_uptime_hourly
       WHERE model_id = ANY($1) AND hour >= $2::timestamptz
       ORDER BY hour ASC`,
      [ids, startSlot]
    );
    rows = result.rows;
  } catch (err) {
    Logger.warn(`[ModelUptime] 15 分钟槽查询失败: ${err.message}`);
    const items = {};
    for (const id of ids) items[id] = emptyItem();
    return {
      days: 1,
      hours: HOURS_WINDOW,
      slots: count,
      granularity: '15m',
      items
    };
  }

  /** @type {Map<string, Map<string, {success:number,fail:number}>>} */
  const byModel = new Map();
  for (const id of ids) byModel.set(id, new Map());
  for (const row of rows) {
    const map = byModel.get(row.model_id);
    if (!map) continue;
    const key = new Date(row.hour).toISOString();
    map.set(key, {
      success: parseInt(row.success, 10) || 0,
      fail: parseInt(row.fail, 10) || 0
    });
  }

  const items = {};
  for (const id of ids) {
    const map = byModel.get(id) || new Map();
    const stats = slotList.map(h => map.get(h) || { success: 0, fail: 0 });
    const spark = stats.map(s => computeDayStatus(s.success, s.fail));
    const summary = computeUptime(stats);
    items[id] = { ...summary, spark };
  }

  return {
    days: 1,
    hours: HOURS_WINDOW,
    slots: count,
    granularity: '15m',
    items
  };
}

/** @deprecated 名称兼容，实际为 15 分钟槽 */
async function getModelUptimeHourly(modelIds, hours = HOURS_WINDOW) {
  const h = Math.min(Math.max(parseInt(hours, 10) || HOURS_WINDOW, 1), 168);
  return getModelUptimeSlots(modelIds, h * 4);
}

/**
 * 批量查询摘要
 * @param {string[]} modelIds
 * @param {number} [days=1] days<=1 时按 15 分钟；>1 时按日
 */
async function getModelUptime(modelIds, days = DEFAULT_DAYS) {
  if (useSlotGranularity(days)) {
    return getModelUptimeSlots(modelIds, SLOT_COUNT);
  }

  const dayCount = Math.min(Math.max(parseInt(days, 10) || DEFAULT_DAYS, 1), 365);
  const ids = [...new Set((modelIds || []).filter(Boolean).map(String))];
  const dateList = eachDayRange(dayCount);
  const emptyItem = () => ({
    uptime_pct: null,
    label: 'No data',
    total_success: 0,
    total_fail: 0,
    spark: dateList.map(() => 'none')
  });

  if (ids.length === 0) {
    return { days: dayCount, granularity: 'day', items: {} };
  }

  const startDay = dateList[0];
  let rows = [];
  try {
    const result = await pool.query(
      `SELECT model_id, day::text AS day, success, fail
       FROM model_uptime_daily
       WHERE model_id = ANY($1) AND day >= $2::date
       ORDER BY day ASC`,
      [ids, startDay]
    );
    rows = result.rows;
  } catch (err) {
    Logger.warn(`[ModelUptime] 查询失败: ${err.message}`);
    const items = {};
    for (const id of ids) items[id] = emptyItem();
    return { days: dayCount, granularity: 'day', items };
  }

  /** @type {Map<string, Map<string, {success:number,fail:number}>>} */
  const byModel = new Map();
  for (const id of ids) byModel.set(id, new Map());
  for (const row of rows) {
    const map = byModel.get(row.model_id);
    if (!map) continue;
    const dayKey = String(row.day).slice(0, 10);
    map.set(dayKey, {
      success: parseInt(row.success, 10) || 0,
      fail: parseInt(row.fail, 10) || 0
    });
  }

  const items = {};
  for (const id of ids) {
    const map = byModel.get(id) || new Map();
    const dayStats = dateList.map(d => map.get(d) || { success: 0, fail: 0 });
    const spark = dayStats.map(s => computeDayStatus(s.success, s.fail));
    const summary = computeUptime(dayStats);
    items[id] = { ...summary, spark };
  }

  return { days: dayCount, granularity: 'day', items };
}

/**
 * 单模型详情
 * @param {string} modelId
 * @param {number} [days=1]
 */
async function getModelUptimeDetail(modelId, days = DEFAULT_DAYS) {
  if (useSlotGranularity(days)) {
    const slotList = eachSlotRange(SLOT_COUNT);
    if (!modelId) {
      return {
        model_id: modelId,
        uptime_pct: null,
        label: 'No data',
        total_success: 0,
        total_fail: 0,
        granularity: '15m',
        hours: HOURS_WINDOW,
        slots: SLOT_COUNT,
        days: slotList.map(date => ({ date, status: 'none', success: 0, fail: 0 }))
      };
    }

    const bulk = await getModelUptimeSlots([modelId], SLOT_COUNT);
    const summary = bulk.items[modelId] || {
      uptime_pct: null,
      label: 'No data',
      total_success: 0,
      total_fail: 0,
      spark: []
    };

    const countMap = new Map();
    try {
      const result = await pool.query(
        `SELECT hour, success, fail
         FROM model_uptime_hourly
         WHERE model_id = $1 AND hour >= $2::timestamptz`,
        [modelId, slotList[0]]
      );
      for (const row of result.rows) {
        countMap.set(new Date(row.hour).toISOString(), {
          success: parseInt(row.success, 10) || 0,
          fail: parseInt(row.fail, 10) || 0
        });
      }
    } catch (err) {
      Logger.warn(`[ModelUptime] 15 分钟槽详情查询失败: ${err.message}`);
    }

    const daysOut = slotList.map((date, i) => {
      const c = countMap.get(date) || { success: 0, fail: 0 };
      return {
        date,
        status: summary.spark[i] || computeDayStatus(c.success, c.fail),
        success: c.success,
        fail: c.fail
      };
    });

    return {
      model_id: modelId,
      uptime_pct: summary.uptime_pct,
      label: summary.label,
      total_success: summary.total_success,
      total_fail: summary.total_fail,
      granularity: '15m',
      hours: HOURS_WINDOW,
      slots: SLOT_COUNT,
      days: daysOut
    };
  }

  const dayCount = Math.min(Math.max(parseInt(days, 10) || DEFAULT_DAYS, 1), 365);
  if (!modelId) {
    return {
      model_id: modelId,
      uptime_pct: null,
      label: 'No data',
      total_success: 0,
      total_fail: 0,
      granularity: 'day',
      days: eachDayRange(dayCount).map(date => ({
        date, status: 'none', success: 0, fail: 0
      }))
    };
  }

  const bulk = await getModelUptime([modelId], dayCount);
  const summary = bulk.items[modelId] || {
    uptime_pct: null,
    label: 'No data',
    total_success: 0,
    total_fail: 0,
    spark: []
  };

  const dateList = eachDayRange(dayCount);
  const startDay = dateList[0];
  const countMap = new Map();
  try {
    const result = await pool.query(
      `SELECT day::text AS day, success, fail
       FROM model_uptime_daily
       WHERE model_id = $1 AND day >= $2::date`,
      [modelId, startDay]
    );
    for (const row of result.rows) {
      countMap.set(String(row.day).slice(0, 10), {
        success: parseInt(row.success, 10) || 0,
        fail: parseInt(row.fail, 10) || 0
      });
    }
  } catch (err) {
    Logger.warn(`[ModelUptime] 详情查询失败: ${err.message}`);
  }

  const daysOut = dateList.map((date, i) => {
    const c = countMap.get(date) || { success: 0, fail: 0 };
    return {
      date,
      status: summary.spark[i] || computeDayStatus(c.success, c.fail),
      success: c.success,
      fail: c.fail
    };
  });

  return {
    model_id: modelId,
    uptime_pct: summary.uptime_pct,
    label: summary.label,
    total_success: summary.total_success,
    total_fail: summary.total_fail,
    granularity: 'day',
    days: daysOut
  };
}

module.exports = {
  DEFAULT_DAYS,
  HOURS_WINDOW,
  SLOT_MS,
  SLOT_COUNT,
  RETENTION_MS,
  computeDayStatus,
  computeUptime,
  recordModelCall,
  getModelUptime,
  getModelUptimeDetail,
  getModelUptimeSlots,
  getModelUptimeHourly,
  cleanupOldSlotRecords,
  startUptimeCleanup,
  utcDayString,
  utcSlotString,
  utcHourString,
  daysAgoDateString,
  eachDayRange,
  eachSlotRange,
  eachHourRange
};
