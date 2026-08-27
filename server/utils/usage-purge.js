'use strict';

const { pool } = require('../models/database');
const { logRetention } = require('./retention-log');
const { getRetentionConfig, isHealthy } = require('./usage-agg');

const DEFAULTS = {
  batchSize: 500,
  batchIntervalMs: 2000,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function archivedOrUnownedSql(alias = 'u') {
  return `(
    COALESCE(${alias}.plugin_meta->'attribution'->>'sessionId', '') = ''
    OR ${alias}.plugin_meta->'attribution'->>'archived' = 'true'
  )`;
}

async function getPurgeCandidateStats(cutoff) {
  const result = await pool.query(
    `SELECT
       COUNT(*)::int AS records,
       COUNT(DISTINCT NULLIF(plugin_meta->'attribution'->>'sessionId', ''))::int AS sessions
     FROM usage_records u
     WHERE u.created_at < $1::timestamptz
       AND ${archivedOrUnownedSql('u')}`,
    [cutoff]
  );
  const row = result.rows[0] || {};
  return {
    records: Number(row.records) || 0,
    sessions: Number(row.sessions) || 0,
  };
}

async function deleteBatch(cutoff, batchSize) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidates = await client.query(
      `SELECT id
       FROM usage_records u
       WHERE u.created_at < $1::timestamptz
         AND ${archivedOrUnownedSql('u')}
       ORDER BY u.created_at ASC, u.id ASC
       LIMIT $2`,
      [cutoff, batchSize]
    );
    const ids = candidates.rows.map((row) => row.id);
    if (ids.length === 0) {
      await client.query('COMMIT');
      return { deleted: 0, analysisDeleted: 0 };
    }

    const analysis = await client.query(
      `DELETE FROM usage_message_analysis
       WHERE usage_id = ANY($1::int[])`,
      [ids]
    );
    const deleted = await client.query(
      `DELETE FROM usage_records
       WHERE id = ANY($1::int[])`,
      [ids]
    );
    await client.query('COMMIT');
    return {
      deleted: deleted.rowCount || 0,
      analysisDeleted: analysis.rowCount || 0,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // 保留原始删除错误，避免掩盖根因。
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 执行一次明细清除。
 * 只清除窗口外的已压缩记录，以及窗口外没有 sessionId 的无主记录；
 * 未压缩且带 sessionId 的记录留给后续压缩任务。
 *
 * opts: { purgeDays, dryRun, batchSize, batchIntervalMs }
 */
async function runPurgeOnce(opts = {}) {
  const cfg = await getRetentionConfig({ fresh: true });
  const purgeDays = opts.purgeDays === undefined ? cfg.purgeDays : Number(opts.purgeDays);
  const dryRun = Boolean(opts.dryRun);
  const batchSize = normalizePositiveInt(opts.batchSize, DEFAULTS.batchSize);
  const batchIntervalMs = opts.batchIntervalMs === undefined
    ? DEFAULTS.batchIntervalMs
    : Math.max(0, Number(opts.batchIntervalMs) || 0);

  if (!Number.isFinite(purgeDays) || purgeDays < 0) {
    throw new Error(`无效的 purgeDays: ${opts.purgeDays}`);
  }
  if (purgeDays === 0) {
    logRetention('[清除] 跳过：purgeDays=0（按时长清除已关闭）');
    return { deleted: 0, analysisDeleted: 0, sessions: 0, aborted: false, dryRun, skipped: 'disabled' };
  }

  const cutoff = new Date(Date.now() - purgeDays * 86400000).toISOString();
  logRetention(`[清除] 开始${dryRun ? '（dry-run）' : ''}：窗口=${purgeDays}天，边界=${cutoff}`);

  if (dryRun) {
    const stats = await getPurgeCandidateStats(cutoff);
    logRetention(`[清除][dry-run] 边界 ${cutoff}，预计删除 ${stats.records} 行，受影响 session ${stats.sessions} 个`);
    return {
      deleted: stats.records,
      analysisDeleted: 0,
      sessions: stats.sessions,
      aborted: false,
      dryRun: true,
      cutoff,
    };
  }

  let deleted = 0;
  let analysisDeleted = 0;
  let batches = 0;
  let consecutiveFailures = 0;
  let aborted = false;

  const maxTotal = normalizePositiveInt(opts.maxTotalRecords, Number.MAX_SAFE_INTEGER);
  while (deleted < maxTotal) {
    if (!(await isHealthy())) {
      consecutiveFailures += 1;
      logRetention(`[清除] 健康检查失败（${consecutiveFailures}/2）`);
      if (consecutiveFailures >= 2) {
        aborted = true;
        logRetention('[清除] 中止：连续两次健康检查失败');
        break;
      }
      continue;
    }
    consecutiveFailures = 0;

    const result = await deleteBatch(cutoff, batchSize);
    if (result.deleted === 0) break;
    deleted += result.deleted;
    analysisDeleted += result.analysisDeleted;
    batches += 1;
    logRetention(`[清除] 批次 ${batches}：删除 usage_records ${result.deleted} 行，analysis ${result.analysisDeleted} 行，累计 ${deleted} 行`);

    if (result.deleted < batchSize) break;
    await sleep(batchIntervalMs);
  }

  if (!aborted) {
    try {
      await pool.query('VACUUM ANALYZE usage_records');
      logRetention('[清除] VACUUM ANALYZE 完成（未执行 VACUUM FULL）');
    } catch (err) {
      logRetention(`[清除] VACUUM ANALYZE 失败：${err.message}`);
    }
  }

  logRetention(`[清除] ${aborted ? '中止' : '完成'}：删除 ${deleted} 行，analysis ${analysisDeleted} 行，批次 ${batches}`);
  return { deleted, analysisDeleted, sessions: 0, aborted, dryRun: false, cutoff, batches };
}

// 兼容早期草稿调用方；新的触发入口统一使用 runPurgeOnce。
const purgeOnce = runPurgeOnce;

module.exports = { runPurgeOnce, purgeOnce, deleteBatch };
