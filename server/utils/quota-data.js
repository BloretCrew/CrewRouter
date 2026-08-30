const { pool } = require('../models/database');
const Logger = require('../logger');

// In-memory buffer for quota data, flushed periodically
const quotaBuffer = new Map();
const userIndex = new Map(); // userId -> Set of buffer keys (performance optimization)
const FLUSH_INTERVAL = 60000; // 1 minute
let flushPromise = null;

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
  if (flushPromise) return flushPromise;
  if (quotaBuffer.size === 0) return { flushed: 0 };
  const entries = Array.from(quotaBuffer.values());
  quotaBuffer.clear();
  userIndex.clear();
  flushPromise = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const entry of entries) {
        await client.query(`
          INSERT INTO quota_data (user_id, model_name, created_at, token_used, weighted_tokens, count, quota)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (user_id, model_name, created_at) DO UPDATE SET
            token_used = quota_data.token_used + EXCLUDED.token_used,
            weighted_tokens = quota_data.weighted_tokens + EXCLUDED.weighted_tokens,
            count = quota_data.count + EXCLUDED.count,
            quota = quota_data.quota + EXCLUDED.quota
        `, [entry.user_id, entry.model_name, entry.created_at, entry.token_used, entry.weighted_tokens || entry.token_used, entry.count, entry.quota]);
      }
      await client.query('COMMIT');
      Logger.info(`[QuotaData] 已刷新 ${entries.length} 条聚合记录`);
      return { flushed: entries.length };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      for (const entry of entries) recordQuotaData(entry.user_id, entry.model_name, entry.token_used, entry.weighted_tokens, entry.quota);
      Logger.error(`[QuotaData] 刷新失败，已将 ${entries.length} 条记录放回缓冲区: ${err.message}`);
      throw err;
    } finally { client.release(); }
  })();
  try { return await flushPromise; } finally { flushPromise = null; }
}

// Periodic flush
setInterval(flushQuotaData, FLUSH_INTERVAL);

// Graceful shutdown：flush 后必须退出，否则 SIGINT/SIGTERM 处理器会吞掉默认终止行为，
// 进程带着监听端口继续存活（MCSM 优雅重启卡 busy 的根因）
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => process.exit(0), 5000);
  if (forceExit.unref) forceExit.unref();
  try {
    await flushQuotaData();
  } catch (err) { /* flushQuotaData 内部已捕获 */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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
