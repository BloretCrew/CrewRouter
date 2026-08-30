/**
 * Billing calculation utilities (倍率模式).
 *
 * 模型基础价格统一为 1.0（由 migration 设定），不再暴露给管理员。
 * 管理员仅需设置 倍率 (model_multiplier)。
 *
 * 计算公式:
 *   weighted_tokens = (未缓存输入 + 缓存输入 × 0.1 + 输出 token) × 倍率
 *   points_cost     = weighted_tokens / 1,000,000
 *   1 积分 = 1,000,000 加权 Token
 *
 * 缓存命中折扣:
 *   - 缓存命中的输入 token 按 10% 计算 (90% 折扣)
 */

const CACHE_HIT_DISCOUNT = 0.1;
const PER_MILLION = 1000000;
const { moneyToApiNumber, moneyToString } = require('./money');

/**
 * Calculate weighted tokens and points cost for a single API request.
 *
 * @param {object} modelConfig - Model configuration from DB
 * @param {object} tokenUsage - Normalized token usage from normalizeUsageTokens
 * @returns {object} { cost, weightedTokens, pointsCost, breakdown }
 */
function calculateCost(modelConfig, tokenUsage) {
  const {
    promptTokens = 0,
    completionTokens = 0,
    cachedTokens = 0
  } = tokenUsage;

  // 唯一倍率系数
  const multiplier = parseFloat(modelConfig.model_multiplier) || 1.0;

  // 计算输入 token（区分缓存命中和未命中）
  const cachedInputTokens = Math.min(cachedTokens, promptTokens);
  const uncachedInputTokens = promptTokens - cachedInputTokens;

  // 加权 token = (未缓存输入 × 1 + 缓存输入 × 0.1 + 输出) × 倍率
  const weightedTokens = Math.round(
    (uncachedInputTokens + cachedInputTokens * CACHE_HIT_DISCOUNT + completionTokens) * multiplier
  );

  // 1 积分 = 1,000,000 加权 token
  const pointsCost = moneyToApiNumber(moneyToString(Math.max(weightedTokens / PER_MILLION, 0)));

  return {
    cost: pointsCost,
    weightedTokens,
    pointsCost,
    breakdown: {
      promptTokens,
      completionTokens,
      cachedTokens: cachedInputTokens,
      uncachedInputTokens,
      weightedTokens,
      pointsCost,
      multiplier,
      cacheHitRate: promptTokens > 0 ? (cachedInputTokens / promptTokens * 100).toFixed(1) : 0
    }
  };
}

module.exports = { calculateCost, CACHE_HIT_DISCOUNT };
