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
    if (rule_type === 'requests') {
      const result = await db.query(
        'SELECT COUNT(*) AS total FROM usage_records WHERE user_id = $1 AND created_at >= $2',
        [userId, since]
      );
      used = parseInt(result.rows[0].total, 10) || 0;
    } else if (rule_type === 'tokens') {
      const result = await db.query(
        'SELECT COALESCE(SUM(weighted_tokens), 0) AS total FROM usage_records WHERE user_id = $1 AND created_at >= $2',
        [userId, since]
      );
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
