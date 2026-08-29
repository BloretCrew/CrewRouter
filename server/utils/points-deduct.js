/**
 * 统一配额检查与实扣积分计算（API / Playground 共用）
 */

const { pool } = require('../models/database');
const { getUserQuotaBuffer } = require('./quota-data');

/**
 * 检查用户组额度规则
 * @param {number} userId
 * @param {number|null} groupId
 * @returns {Promise<Array|null>}
 */
async function checkQuotaRules(userId, groupId, client = null) {
  if (!groupId) return null;
  const db = client || pool;

  const rulesResult = await db.query(
    'SELECT rule_type, rule_value, duration_hours FROM user_group_rules WHERE group_id = $1',
    [groupId]
  );

  const results = [];

  for (const rule of rulesResult.rows) {
    const { rule_type, rule_value, duration_hours } = rule;
    const since = new Date(Date.now() - duration_hours * 3600 * 1000);

    let used = 0;
    if (rule_type === 'requests') {
      const r = await db.query(
        'SELECT COALESCE(SUM(count), 0) AS total FROM quota_data WHERE user_id = $1 AND created_at >= $2',
        [userId, since]
      );
      used = parseInt(r.rows[0].total, 10) || 0;
    } else if (rule_type === 'tokens') {
      const r = await db.query(
        'SELECT COALESCE(SUM(weighted_tokens), 0) AS total FROM quota_data WHERE user_id = $1 AND created_at >= $2',
        [userId, since]
      );
      used = parseInt(r.rows[0].total, 10) || 0;
    }

    const userBuffer = getUserQuotaBuffer(userId);
    for (const entry of userBuffer) {
      if (entry.created_at >= since) {
        used += rule_type === 'requests' ? entry.count : (entry.weighted_tokens || entry.token_used);
      }
    }

    results.push({
      rule_type,
      limit: rule_value,
      used,
      remaining: Math.max(0, rule_value - used),
      exceeded: used >= rule_value,
      duration_hours
    });
  }

  return results.length > 0 ? results : null;
}

/**
 * 根据配额情况决定实际扣除积分。
 * 任一配额仍有余量 → 实扣 0（消耗配额）；全部耗尽 → 按加权 token 扣积分。
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {number|null} params.groupId
 * @param {number} params.weightedTokens
 * @param {number} params.pointsCost 理论积分
 * @param {object} [deps] 可注入 checkQuotaRules 便于单测
 * @returns {Promise<number>}
 */
async function calculatePointsToDeduct(
  { userId, groupId, weightedTokens, pointsCost },
  deps = {}
) {
  if (!groupId) return pointsCost;
  const check = deps.checkQuotaRules || checkQuotaRules;
  const rules = await check(userId, groupId, deps.client);
  if (!rules) return pointsCost;
  if (rules.some(r => !r.exceeded)) return 0;
  return Math.max(0, (weightedTokens || 0) / 1000000);
}

module.exports = {
  checkQuotaRules,
  calculatePointsToDeduct
};
