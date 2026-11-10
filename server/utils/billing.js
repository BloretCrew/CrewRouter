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
const DEFAULT_IMAGE_TOKEN_ESTIMATE = (() => {
  const configured = Number(process.env.CREWROUTER_IMAGE_TOKEN_ESTIMATE);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 1024;
})();
const { moneyToApiNumber, moneyToString } = require('./money');

/** 统计请求体中的图片块数量（仅用于上游未返回 image_tokens 时的计费兜底）。 */
function countImageBlocks(body) {
  if (!body || typeof body !== 'object') return 0;
  let count = 0;
  const seen = new Set();

  function visit(value, depth) {
    if (depth > 24 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);

    if (value.type === 'image' || value.type === 'image_url' || value.type === 'input_image') {
      count += 1;
      return;
    }
    if (value.type === 'media' && /^image\//i.test(String(value.mimeType || ''))) {
      count += 1;
      return;
    }
    if (value.inlineData && /^image\//i.test(String(value.inlineData.mimeType || ''))) {
      count += 1;
      return;
    }
    if (value.fileData && /^image\//i.test(String(value.fileData.mimeType || ''))) {
      count += 1;
      return;
    }
    for (const item of Object.values(value)) visit(item, depth + 1);
  }

  visit(body, 0);
  return count;
}

function estimateImageTokens(body, perImage = DEFAULT_IMAGE_TOKEN_ESTIMATE) {
  const count = countImageBlocks(body);
  if (!count) return 0;
  const unit = Number.isFinite(Number(perImage)) && Number(perImage) > 0
    ? Math.floor(Number(perImage))
    : DEFAULT_IMAGE_TOKEN_ESTIMATE;
  return count * unit;
}

/**
 * Calculate weighted tokens and points cost for a single API request.
 *
 * @param {object} modelConfig - Model configuration from DB
 * @param {object} tokenUsage - Normalized token usage from normalizeUsageTokens
 * @param {object} [requestBody] - Original request body, used to estimate image tokens
 * @returns {object} { cost, weightedTokens, pointsCost, breakdown }
 */
function calculateCost(modelConfig, tokenUsage, requestBody) {
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

  // image_ratio <= 0 视为未配置（保持旧的 1.0 行为）
  const configuredImageRatio = parseFloat(modelConfig.image_ratio);
  const imageRatio = Number.isFinite(configuredImageRatio) && configuredImageRatio > 0
    ? configuredImageRatio
    : 1.0;

  const reportedImageTokens = Math.max(0, Math.floor(Number(tokenUsage.imageTokens) || 0));
  const estimatedImageTokens = reportedImageTokens > 0
    ? reportedImageTokens
    : estimateImageTokens(requestBody, modelConfig.image_token_estimate);
  // 图片 token 包含在 promptTokens 内，拆分后单独乘 image_ratio，避免重复计费。
  const imageTokens = Math.min(estimatedImageTokens, uncachedInputTokens);
  const nonImageInputTokens = uncachedInputTokens - imageTokens;

  // 加权 token = (非图片输入 + 图片输入 × image_ratio + 缓存输入 × 0.1 + 输出) × 倍率
  const weightedTokens = Math.round(
    (nonImageInputTokens + imageTokens * imageRatio + cachedInputTokens * CACHE_HIT_DISCOUNT + completionTokens) * multiplier
  );

  // 1 积分 = 1,000,000 加权 token
  const pointsCost = moneyToApiNumber(moneyToString(Math.max(weightedTokens / PER_MILLION, 0)));

  return {
    cost: pointsCost,
    weightedTokens,
    pointsCost,
    imageTokens,
    breakdown: {
      promptTokens,
      completionTokens,
      cachedTokens: cachedInputTokens,
      uncachedInputTokens,
      nonImageInputTokens,
      imageTokens,
      imageRatio,
      weightedTokens,
      pointsCost,
      multiplier,
      cacheHitRate: promptTokens > 0 ? (cachedInputTokens / promptTokens * 100).toFixed(1) : 0
    }
  };
}

module.exports = {
  calculateCost,
  countImageBlocks,
  estimateImageTokens,
  CACHE_HIT_DISCOUNT,
  DEFAULT_IMAGE_TOKEN_ESTIMATE
};
