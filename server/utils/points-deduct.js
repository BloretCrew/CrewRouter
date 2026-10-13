'use strict';

/**
 * Team 限额规则检查与实扣积分计算（API / Playground 共用）
 */

const { pool } = require('../models/database');
const { getUserQuotaBuffer } = require('./quota-data');
const { moneyToApiNumber, moneyToString } = require('./money');

/**
 * 检查用户所属 Team 的额度规则。
 */
async function checkQuotaRules(userId, teamId, client = null) {
  if (!teamId) return null;
  const db = client || pool;
  let rules = [];
  try {
    const result = await db.query('SELECT quota_rules FROM teams WHERE id = $1', [teamId]);
    const raw = result.rows[0]?.quota_rules;
    if (Array.isArray(raw)) rules = raw;
    else if (typeof raw === 'string') rules = JSON.parse(raw || '[]');
  } catch (_) { return null; }
  if (!rules.length) return null;

  const results = [];
  for (const rule of rules) {
    const { rule_type, rule_value, duration_hours } = rule;
    const hours = Number(duration_hours) || 0;
    const since = new Date(Date.now() - hours * 3600 * 1000);
    let used = 0;
    if (rule_type === 'requests' || rule_type === 'tokens') {
      const usageAggregate = rule_type === 'requests' ? 'COUNT(*)' : 'COALESCE(SUM(weighted_tokens), 0)';
      const heldAggregate = rule_type === 'requests' ? 'COUNT(*)' : 'COALESCE(SUM(p.reserved_weight), 0)';
      const usageSql = `SELECT ${usageAggregate} AS total FROM usage_records WHERE user_id = $1 AND created_at >= $2`;
      let result;
      // 同一语句快照避免结算将预留转为 usage 时重复计数或漏计。
      if (client) await db.query('SAVEPOINT model_trace_quota');
      try {
        result = await db.query(`SELECT COALESCE(SUM(total), 0) AS total FROM (
          ${usageSql}
          UNION ALL
          SELECT ${heldAggregate} AS total
          FROM model_trace_probes p JOIN model_trace_jobs j ON j.id = p.job_id
          WHERE j.user_id = $1 AND p.created_at >= $2
            AND p.status = 'reserved' AND p.quota_covered = TRUE
        ) quota_usage`, [userId, since]);
      } catch (error) {
        // 迁移前缺表会中止 PostgreSQL 事务，回退前需恢复外部事务。
        if (client) await db.query('ROLLBACK TO SAVEPOINT model_trace_quota');
        if (error.code !== '42P01') throw error;
        result = await db.query(usageSql, [userId, since]);
      } finally {
        if (client) await db.query('RELEASE SAVEPOINT model_trace_quota');
      }
      used = parseInt(result.rows[0].total, 10) || 0;
    }
    for (const entry of getUserQuotaBuffer(userId)) {
      if (entry.created_at >= since) {
        used += rule_type === 'requests' ? entry.count : (entry.weighted_tokens || entry.token_used);
      }
    }
    const limit = Number(rule_value) || 0;
    results.push({
      rule_type,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      exceeded: used >= limit,
      duration_hours: hours,
    });
  }
  return results.length ? results : null;
}

/**
 * 任一规则仍有余量时按额度消费；全部耗尽后按加权 Token 扣积分。
 */
async function calculatePointsToDeduct(
  { userId, teamId, weightedTokens, pointsCost },
  deps = {}
) {
  if (!teamId) return moneyToApiNumber(moneyToString(pointsCost));
  const check = deps.checkQuotaRules || checkQuotaRules;
  const rules = await check(userId, teamId, deps.client);
  if (!rules) return moneyToApiNumber(moneyToString(pointsCost));
  if (rules.some(rule => !rule.exceeded)) return 0;
  return moneyToApiNumber(moneyToString(Math.max(0, (weightedTokens || 0) / 1000000)));
}

module.exports = { checkQuotaRules, calculatePointsToDeduct };
