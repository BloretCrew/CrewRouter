'use strict';

const { pool } = require('../../models/database');
const Logger = require('../../logger');
const { expireApprovals } = require('./approvals');
const { aggregateRecentDays } = require('./metrics');
const { invalidatePolicyCache } = require('./cache');
const { scanOutputPolicies } = require('./output-scan');

let timer = null;
let running = false;
let lastMetricsAt = 0;
let lastCleanupAt = 0;

async function publishScheduled(db = pool) {
  const result = await db.query(
    `UPDATE access_policies
        SET status = 'published', updated_at = NOW()
      WHERE status = 'draft' AND auto_publish_at IS NOT NULL AND auto_publish_at <= NOW()
      RETURNING id`
  );
  if (result.rowCount) {
    invalidatePolicyCache();
    Logger.info(`[策略] 定时发布 ${result.rowCount} 条策略`);
  }
  return result.rowCount;
}

async function archiveExpired(db = pool) {
  const result = await db.query(
    `UPDATE access_policies
        SET status = 'archived', archived_at = NOW(), updated_at = NOW()
      WHERE status = 'published' AND ends_at IS NOT NULL AND ends_at <= NOW()
      RETURNING id`
  );
  if (result.rowCount) {
    invalidatePolicyCache();
    Logger.info(`[策略] 自动归档 ${result.rowCount} 条过期策略`);
  }
  return result.rowCount;
}

async function expireExemptions(db = pool) {
  const result = await db.query(
    `UPDATE policy_exemptions SET status = 'expired'
      WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= NOW()
      RETURNING id`
  );
  return result.rowCount;
}

async function expireStaleApprovals(db = pool) {
  return expireApprovals(db).catch(() => 0);
}

async function cleanupHits(db = pool) {
  const settings = await db.query(`SELECT hit_retention_days FROM policy_settings WHERE team_id IS NULL LIMIT 1`);
  const days = Number(settings.rows[0]?.hit_retention_days || 90);
  const result = await db.query(
    `DELETE FROM policy_hits WHERE id IN (
       SELECT id FROM policy_hits
        WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
        LIMIT 5000
     )`,
    [days]
  );
  if (result.rowCount) Logger.info(`[策略] 清理命中记录 ${result.rowCount} 条（保留 ${days} 天）`);
  return result.rowCount;
}

async function runSchedulerTick({ now = Date.now() } = {}) {
  if (running) return;
  running = true;
  try {
    await publishScheduled();
    await archiveExpired();
    await expireExemptions();
    await expireStaleApprovals();
    await scanOutputPolicies({ limit: 200, sinceMinutes: 10 })
      .catch(error => Logger.warn(`[策略] 输出策略扫描失败: ${error.message}`));
    if (now - lastMetricsAt > 5 * 60 * 1000) {
      lastMetricsAt = now;
      await aggregateRecentDays(2).catch(error => Logger.warn(`[策略] 指标聚合失败: ${error.message}`));
    }
    if (now - lastCleanupAt > 6 * 60 * 60 * 1000) {
      lastCleanupAt = now;
      await cleanupHits().catch(error => Logger.warn(`[策略] 命中清理失败: ${error.message}`));
    }
  } catch (error) {
    Logger.warn(`[策略] 调度任务失败: ${error.message}`);
  } finally {
    running = false;
  }
}

function startPolicyScheduler() {
  if (timer) return timer;
  timer = setInterval(() => { void runSchedulerTick(); }, 60_000);
  timer.unref?.();
  void runSchedulerTick();
  Logger.info('[策略] 调度器已启动');
  return timer;
}

function stopPolicyScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  startPolicyScheduler,
  stopPolicyScheduler,
  runSchedulerTick,
  publishScheduled,
  archiveExpired,
  expireExemptions,
  expireStaleApprovals,
  cleanupHits,
};
