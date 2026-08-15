const { pool } = require('../models/database');
const Logger = require('../logger');

// In-memory buffer for quota data, flushed periodically
const quotaBuffer = new Map();
const userIndex = new Map(); // userId -> Set of buffer keys (performance optimization)
const FLUSH_INTERVAL = 60000; // 1 minute

/**
 * Record usage to the quota_data aggregation table.
 * Buffers writes and flushes periodically for performance.
 *
 * @param {number} userId
 * @param {string} modelName
 * @param {number} tokensUsed - 原始 token 数
 * @param {number} weightedTokens - 加权 token 数（倍率模式，用于配额检查）
 * @param {number} cost - 积分成本 (points)
 */
function recordQuotaData(userId, modelName, tokensUsed, weightedTokens, cost) {
  // Truncate to hour boundary
  const now = new Date();
  const hourKey = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
  const key = `${userId}:${modelName}:${hourKey.getTime()}`;

  const existing = quotaBuffer.get(key);
  if (existing) {
    existing.token_used += tokensUsed;
    existing.count += 1;
    existing.quota += cost;
    existing.weighted_tokens = (existing.weighted_tokens || 0) + (weightedTokens || tokensUsed);
  } else {
    quotaBuffer.set(key, {
      user_id: userId,
      model_name: modelName,
      created_at: hourKey,
      token_used: tokensUsed,
      count: 1,
      quota: cost,
      weighted_tokens: weightedTokens || tokensUsed
    });

    // 维护用户索引（性能优化：避免遍历整个缓冲区）
    if (!userIndex.has(userId)) {
      userIndex.set(userId, new Set());
    }
    userIndex.get(userId).add(key);
  }
}

/**
 * Flush buffered quota data to database.
 */
async function flushQuotaData() {
  if (quotaBuffer.size === 0) return;

  const entries = Array.from(quotaBuffer.values());
  quotaBuffer.clear();
  userIndex.clear(); // 清空用户索引

  try {
    for (const entry of entries) {
      await pool.query(`
        INSERT INTO quota_data (user_id, model_name, created_at, token_used, weighted_tokens, count, quota)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, model_name, created_at) DO UPDATE SET
          token_used = quota_data.token_used + EXCLUDED.token_used,
          weighted_tokens = quota_data.weighted_tokens + EXCLUDED.weighted_tokens,
          count = quota_data.count + EXCLUDED.count,
          quota = quota_data.quota + EXCLUDED.quota
      `, [entry.user_id, entry.model_name, entry.created_at, entry.token_used,
          entry.weighted_tokens || entry.token_used, entry.count, entry.quota]);
    }
    Logger.info(`[QuotaData] 已刷新 ${entries.length} 条聚合记录`);
  } catch (err) {
    Logger.error(`[QuotaData] 刷新失败: ${err.message}`);
  }
}

// Periodic flush
setInterval(flushQuotaData, FLUSH_INTERVAL);

// Graceful shutdown
process.on('SIGTERM', () => flushQuotaData());
process.on('SIGINT', () => flushQuotaData());

/**
 * Get buffered quota data for a specific user (performance optimization).
 * Uses user index to avoid scanning the entire buffer.
 *
 * @param {number} userId
 * @returns {Array} Array of quota entries for the user
 */
function getUserQuotaBuffer(userId) {
  const keys = userIndex.get(userId);
  if (!keys || keys.size === 0) return [];

  const entries = [];
  for (const key of keys) {
    const entry = quotaBuffer.get(key);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

module.exports = { recordQuotaData, flushQuotaData, quotaBuffer, getUserQuotaBuffer };
