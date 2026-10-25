const { pool } = require('../models/database');
const Logger = require('../logger');
const {
  addMoney,
  compareMoney,
  moneyToApiNumber,
  moneyToString,
  subtractMoney,
} = require('./money');

// 延迟加载避免循环依赖
let invalidateUserApiKeyCache = null;
function getInvalidateUserApiKeyCache() {
  if (!invalidateUserApiKeyCache) {
    try {
      invalidateUserApiKeyCache = require('../routes/api').invalidateUserApiKeyCache;
    } catch (e) {
      Logger.warn('[余额] 无法加载缓存失效函数:', e.message);
    }
  }
  return invalidateUserApiKeyCache;
}

// 延迟加载避免循环依赖
let checkBalanceAlert = null;
function getCheckBalanceAlert() {
  if (!checkBalanceAlert) {
    try {
      checkBalanceAlert = require('./balance-alert').checkBalanceAlert;
    } catch (e) {
      Logger.warn('[余额] 无法加载预警模块:', e.message);
    }
  }
  return checkBalanceAlert;
}

// 初始化预扣记录表（自动迁移）
(async function initBalanceTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS balance_preconsumes (
        id VARCHAR(100) PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount DECIMAL(12, 4) NOT NULL DEFAULT 0,
        actual_amount DECIMAL(12, 4),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        settled_at TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_balance_preconsumes_user ON balance_preconsumes(user_id, status)`);
    Logger.info('[余额] 表 balance_preconsumes 已就绪');
  } catch (err) {
    Logger.warn(`[余额] 初始化预扣记录表失败: ${err.message}`);
  }
})();

/**
 * 获取数据库连接（优先使用外部传入的 client，否则新获取连接）
 */
async function getClient(client) {
  if (client) return client;
  return pool.connect();
}

/**
 * 释放数据库连接（仅释放自己获取的连接）
 */
async function releaseClient(client, isExternal) {
  if (!isExternal && client) {
    try { client.release(); } catch (e) { /* ignore */ }
  }
}

async function getRefundBalanceDetails(q, userId) {
  const result = await q.query(
    `SELECT COALESCE(SUM(amount), 0)::text AS total,
            COUNT(*) FILTER (WHERE amount < 0 OR fee_rate < 0)::int AS invalid_count
     FROM user_code_balances WHERE user_id = $1`,
    [userId]
  );
  return {
    total: moneyToString(result.rows[0]?.total || 0),
    invalidCount: Number(result.rows[0]?.invalid_count || 0),
  };
}

function refundDetailsMatch(userRefundBalance, details) {
  return details.invalidCount === 0 && compareMoney(userRefundBalance || 0, details.total) === 0;
}

/**
 * 核心扣款逻辑（需在事务中运行，且用户行已被 FOR UPDATE 锁定）
 *
 * @param {object} q - pg query 函数
 * @param {number} userId
 * @param {number} cost - 要扣除的金额
 * @returns {Promise<{ok: boolean, remaining?: number, error?: string}>}
 */
async function executeDeduct(q, userId, cost) {
  const requested = moneyToString(cost);
  if (compareMoney(requested, 0) < 0) return { ok: false, error: '扣款金额不能为负数' };

  const result = await q.query(
    'SELECT balance, refund_balance FROM users WHERE id = $1 FOR UPDATE',
    [userId]
  );
  if (result.rows.length === 0) return { ok: false, error: '用户不存在' };

  let remaining = requested;
  const regularBalance = moneyToString(result.rows[0].balance || 0);
  const userRefundBalance = moneyToString(result.rows[0].refund_balance || 0);
  if (compareMoney(regularBalance, 0) < 0 || compareMoney(userRefundBalance, 0) < 0) {
    return { ok: false, error: '账户余额包含负数，已暂停扣款' };
  }

  // 先扣非退款余额
  const regularDeduct = compareMoney(regularBalance, remaining) < 0 ? regularBalance : remaining;
  remaining = subtractMoney(remaining, regularDeduct);

  let codeBalances = null;
  if (compareMoney(remaining, 0) > 0) {
    const details = await getRefundBalanceDetails(q, userId);
    if (!refundDetailsMatch(userRefundBalance, details)) {
      return { ok: false, error: '可退款余额汇总与明细不一致，已暂停扣款，请先完成余额对账' };
    }
    if (compareMoney(remaining, details.total) > 0) {
      return { ok: false, remaining: moneyToApiNumber(subtractMoney(remaining, details.total)), error: '余额不足' };
    }
    codeBalances = await q.query(
      `SELECT id, amount FROM user_code_balances
       WHERE user_id = $1 AND amount > 0
       ORDER BY fee_rate DESC, id ASC
       FOR UPDATE`,
      [userId]
    );
  }

  if (compareMoney(regularDeduct, 0) > 0) {
    await q.query(
      'UPDATE users SET balance = balance - $1 WHERE id = $2',
      [regularDeduct, userId]
    );
  }

  // 再扣兑换码余额（退款余额），按 fee_rate 降序
  if (compareMoney(remaining, 0) > 0) {
    for (const row of codeBalances.rows) {
      if (compareMoney(remaining, 0) <= 0) break;
      const available = moneyToString(row.amount);
      const deduct = compareMoney(available, remaining) < 0 ? available : remaining;
      await q.query(
        'UPDATE user_code_balances SET amount = amount - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [deduct, row.id]
      );
      remaining = subtractMoney(remaining, deduct);
    }

    // 同步 users.refund_balance
    const newRefund = await q.query(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM user_code_balances WHERE user_id = $1',
      [userId]
    );
    await q.query(
      'UPDATE users SET refund_balance = $1 WHERE id = $2',
      [moneyToString(newRefund.rows[0].total), userId]
    );
  }

  if (compareMoney(remaining, 0) > 0) {
    return { ok: false, remaining: moneyToApiNumber(remaining), error: '余额不足' };
  }

  await q.query(
    'UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
    [userId]
  );

  return { ok: true };
}

/**
 * 从用户余额中扣除指定金额
 *
 * 优先级：非退款余额（balance）> 退款余额（user_code_balances，按 fee_rate 降序）
 * 使用事务 + FOR UPDATE 行锁保证并发安全
 *
 * @param {number} userId
 * @param {number} cost - 扣除金额
 * @param {object} [client] - 外部事务客户端；调用方负责 BEGIN/COMMIT/ROLLBACK、释放连接，
 *   并在提交后触发余额预警和缓存失效。失败结果也必须由调用方回滚事务。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function deductBalance(userId, cost, client) {
  let q = client;
  let ownClient = null;

  try {
    // 如果未提供外部 client，自行获取连接并开启事务
    if (!client) {
      ownClient = await pool.connect();
      await ownClient.query('BEGIN');
      q = ownClient;
    }

    const result = await executeDeduct(q, userId, cost);

    if (!result.ok) {
      if (ownClient) await ownClient.query('ROLLBACK').catch(() => {});
      return { ok: false, error: result.error };
    }

    // 提交事务（仅在自己开启事务的情况下）
    if (ownClient) {
      await ownClient.query('COMMIT');
    }

    // 仅自有事务确认提交后通知。外部事务尚未提交，由调用方负责通知。
    if (!ownClient) return { ok: true };
    try {
      // 余额预警检查
      const alertChecker = getCheckBalanceAlert();
      if (alertChecker) {
        const balanceResult = await q.query(
          'SELECT balance, refund_balance FROM users WHERE id = $1',
          [userId]
        );
        if (balanceResult.rows.length > 0) {
          const newBalance = parseFloat(balanceResult.rows[0].balance || 0);
          const newRefundBalance = parseFloat(balanceResult.rows[0].refund_balance || 0);
          const totalBalance = newBalance + newRefundBalance;
          alertChecker(userId, totalBalance).catch(err => {
            Logger.warn(`[余额预警] 检查失败: ${err.message}`);
          });
        }
      }

      // API Key 缓存失效
      const cacheInvalidator = getInvalidateUserApiKeyCache();
      if (cacheInvalidator) {
        try {
          cacheInvalidator(userId);
        } catch (err) {
          Logger.warn(`[余额] 缓存失效失败: ${err.message}`);
        }
      }
    } catch (asyncErr) {
      Logger.warn(`[余额] 异步操作失败: ${asyncErr.message}`);
    }

    return { ok: true };
  } catch (err) {
    if (ownClient) {
      try { await ownClient.query('ROLLBACK'); } catch (e) { /* ignore */ }
    }
    Logger.error(`[deductBalance] 错误: userId=${userId}, cost=${cost}, error=${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    if (ownClient) {
      try { ownClient.release(); } catch (e) { /* ignore */ }
    }
  }
}

/**
 * 检查用户是否有可用余额
 */
async function checkBalance(userId) {
  try {
    const result = await pool.query(
      'SELECT balance, refund_balance FROM users WHERE id = $1',
      [userId]
    );
    if (result.rows.length === 0) return false;
    const row = result.rows[0];
    return parseFloat(row.balance || 0) + parseFloat(row.refund_balance || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 预扣余额：在请求前预扣预估费用
 *
 * 使用事务 + FOR UPDATE 行锁保证并发安全
 *
 * @param {number} userId
 * @param {number} estimatedCost - 预估费用
 * @returns {Promise<{ok: boolean, preConsumeId?: string, error?: string}>}
 */
async function preConsumeBalance(userId, estimatedCost) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT balance, refund_balance FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: '用户不存在' };
    }

    const row = result.rows[0];
    const estimated = moneyToString(estimatedCost);
    const regularBalance = moneyToString(row.balance || 0);
    const userRefundBalance = moneyToString(row.refund_balance || 0);
    if (compareMoney(estimated, 0) < 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: '预扣金额不能为负数' };
    }
    if (compareMoney(regularBalance, 0) < 0 || compareMoney(userRefundBalance, 0) < 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: '账户余额包含负数，已暂停预扣' };
    }
    const totalBalance = addMoney(row.balance || 0, row.refund_balance || 0);
    if (compareMoney(totalBalance, estimated) < 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: '余额不足' };
    }

    let remaining = estimated;
    const regularDeduct = compareMoney(regularBalance, remaining) < 0 ? regularBalance : remaining;
    remaining = subtractMoney(remaining, regularDeduct);

    let codeBalances = null;
    if (compareMoney(remaining, 0) > 0) {
      const details = await getRefundBalanceDetails(client, userId);
      if (!refundDetailsMatch(userRefundBalance, details)) {
        await client.query('ROLLBACK');
        return { ok: false, error: '可退款余额汇总与明细不一致，已暂停预扣，请先完成余额对账' };
      }
      codeBalances = await client.query(
        `SELECT id, amount FROM user_code_balances
         WHERE user_id = $1 AND amount > 0
         ORDER BY fee_rate DESC, id ASC
         FOR UPDATE`,
        [userId]
      );
    }

    if (compareMoney(regularDeduct, 0) > 0) {
      await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [regularDeduct, userId]);
    }

    if (compareMoney(remaining, 0) > 0) {
      for (const codeRow of codeBalances.rows) {
        if (compareMoney(remaining, 0) <= 0) break;
        const available = moneyToString(codeRow.amount);
        const deduct = compareMoney(available, remaining) < 0 ? available : remaining;
        await client.query(
          'UPDATE user_code_balances SET amount = amount - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [deduct, codeRow.id]
        );
        remaining = subtractMoney(remaining, deduct);
      }
      const newRefund = await client.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM user_code_balances WHERE user_id = $1',
        [userId]
      );
      await client.query(
        'UPDATE users SET refund_balance = $1 WHERE id = $2',
        [moneyToString(newRefund.rows[0].total), userId]
      );
    }

    // 持久化预扣记录，便于崩溃后恢复/对账
    const preConsumeId = `pre_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await client.query(
      `INSERT INTO balance_preconsumes (id, user_id, amount, status, created_at)
       VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP)`,
      [preConsumeId, userId, estimated]
    );

    await client.query('COMMIT');
    return { ok: true, preConsumeId };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    Logger.error(`[preConsumeBalance] 错误: userId=${userId}, estimatedCost=${estimatedCost}, error=${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

/**
 * 结算预扣：根据实际费用与预估费用的差值，补扣或退还
 *
 * @param {number} userId
 * @param {string} preConsumeId - 预扣 ID
 * @param {number} actualCost - 实际费用
 * @param {number} estimatedCost - 预估费用
 * @returns {Promise<{ok: boolean, delta?: number, error?: string}>}
 */
async function settleBalance(userId, preConsumeId, actualCost, estimatedCost) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const actual = moneyToString(actualCost);
    let estimated = moneyToString(estimatedCost);
    if (compareMoney(actual, 0) < 0 || compareMoney(estimated, 0) < 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: '结算金额不能为负数' };
    }

    // 更新预扣记录状态
    if (preConsumeId) {
      const pending = await client.query(
        `SELECT amount::text AS amount FROM balance_preconsumes
         WHERE id = $1 AND user_id = $2 AND status = 'pending' FOR UPDATE`,
        [preConsumeId, userId]
      );
      if (pending.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { ok: true, delta: 0, alreadySettled: true };
      }
      estimated = moneyToString(pending.rows[0].amount);
      if (compareMoney(estimated, 0) < 0) {
        await client.query('ROLLBACK');
        return { ok: false, error: '预扣记录金额为负数，已暂停结算' };
      }
      const result = await client.query(
        `UPDATE balance_preconsumes SET status = 'settled', actual_amount = $1, settled_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND user_id = $3 AND status = 'pending'`,
        [actual, preConsumeId, userId]
      );
      if (result.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { ok: true, delta: 0, alreadySettled: true };
      }
    }

    const delta = subtractMoney(actual, estimated);

    if (compareMoney(delta, 0) > 0) {
      // 实际费用更高：补扣差额
      const deductResult = await executeDeduct(client, userId, delta);
      if (!deductResult.ok) {
        await client.query('ROLLBACK');
        return { ok: false, error: deductResult.error };
      }
    } else if (compareMoney(delta, 0) < 0) {
      // 实际费用更低：退还差额
      const refundAmount = subtractMoney('0', delta);
      await client.query(
        'UPDATE users SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [refundAmount, userId]
      );
    }

    await client.query('COMMIT');
    return { ok: true, delta: moneyToApiNumber(delta) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    Logger.error(`[settleBalance] 错误: userId=${userId}, error=${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

/**
 * 退还余额（退款到非退款余额）
 *
 * @param {number} userId
 * @param {number} amount - 退款金额
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function refundBalance(userId, amount) {
  const normalizedAmount = (() => {
    try { return moneyToString(amount); } catch (_) { return null; }
  })();
  if (normalizedAmount === null || compareMoney(normalizedAmount, 0) <= 0) {
    return { ok: false, error: '退款金额必须是大于 0 的有限数字' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: '用户不存在' };
    }

    await client.query(
      'UPDATE users SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [normalizedAmount, userId]
    );

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    Logger.error(`[refundBalance] 错误: userId=${userId}, error=${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

/**
 * 扣除用户积分（倍率模式）
 *
 * @param {number} userId
 * @param {number} points - 需扣除的积分
 * @returns {Promise<{ok: boolean, remaining?: number, error?: string}>}
 */
async function deductPoints(userId, points, existingClient = null, quota = {}) {
  const requestedPoints = moneyToString(points);
  const hasQuotaDecision = quota.teamId != null || quota.weightedTokens != null || quota.pointsCost != null;
  if (compareMoney(requestedPoints, 0) <= 0 && !hasQuotaDecision) return { ok: true, pointsToDeduct: 0 };
  const client = existingClient || await pool.connect();
  try {
    if (!existingClient) await client.query('BEGIN');
    const result = await client.query(
      'SELECT balance, team_id FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (result.rows.length === 0) {
      if (!existingClient) await client.query('ROLLBACK');
      return { ok: false, error: '用户不存在' };
    }
    let currentPoints = moneyToString(result.rows[0].balance || 0);
    if (hasQuotaDecision) {
      const { calculatePointsToDeduct } = require('./points-deduct');
      // 用户行已 FOR UPDATE；在锁内查询 quota，避免并发请求依据旧额度重复消费。
      points = await calculatePointsToDeduct({
        userId,
        teamId: quota.teamId == null ? result.rows[0].team_id : quota.teamId,
        weightedTokens: quota.weightedTokens || 0,
        pointsCost: quota.pointsCost == null ? requestedPoints : quota.pointsCost
      }, { client });
      const refreshed = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
      currentPoints = moneyToString(refreshed.rows[0]?.balance || 0);

      if (compareMoney(points, 0) <= 0) {
        if (!existingClient) await client.query('COMMIT');
        return { ok: true, pointsToDeduct: 0 };
      }
    }
    const normalizedPoints = moneyToString(points);
    points = moneyToApiNumber(normalizedPoints);
    if (compareMoney(currentPoints, normalizedPoints) < 0) {
      if (!existingClient) await client.query('ROLLBACK');
      return { ok: false, remaining: moneyToApiNumber(subtractMoney(normalizedPoints, currentPoints)), error: '积分不足' };
    }
    await client.query(
      'UPDATE users SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [normalizedPoints, userId]
    );
    if (!existingClient) await client.query('COMMIT');
    // 返回锁内最终实扣值，供调用方回填 usage_records.cost
    return { ok: true, pointsToDeduct: points };
  } catch (err) {
    if (!existingClient) {
      try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    }
    Logger.error(`[deductPoints] 错误: userId=${userId}, points=${points}, error=${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    if (!existingClient) client.release();
  }
}

/**
 * 查询用户当前剩余积分
 */
async function getUserPoints(userId) {
  try {
    const result = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);
    return parseFloat(result.rows[0]?.balance || 0);
  } catch {
    return 0;
  }
}

async function recordUsageAndDeduct({ pool: dbPool = pool, usageQuery, usageValues, userId, pointsToDeduct = 0, teamId = null, weightedTokens = 0, pointsCost = null }) {
  const client = await dbPool.connect();
  let billingResult;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(usageQuery, usageValues);
    // deductPoints 已在事务内持有用户行锁，并会基于锁内最新 quota 决策实际扣款。
    const result = await deductPoints(userId, pointsToDeduct, client, {
      teamId,
      weightedTokens,
      pointsCost: pointsCost == null ? pointsToDeduct : pointsCost
    });
    if (!result.ok) throw new Error(result.error || '积分扣除失败');
    const actualDeduct = result.pointsToDeduct ?? pointsToDeduct;
    // cost 统一记实扣值：配额未超限时理论计费为正但实扣为 0，避免统计展示虚高
    if (inserted.rows[0]?.id != null && Number(pointsToDeduct) !== Number(actualDeduct)) {
      await client.query('UPDATE usage_records SET cost = $1 WHERE id = $2', [actualDeduct, inserted.rows[0].id]);
    }
    await client.query('COMMIT');
    billingResult = { ok: true, id: inserted.rows[0]?.id || null, pointsToDeduct: actualDeduct };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    Logger.error(`[recordUsageAndDeduct] 错误: userId=${userId}, error=${error.message}`);
    error.billingFailure = true;
    throw error;
  } finally {
    client.release();
  }
  // Capture may acquire another pool connection; billing has already committed.
  try {
    const { linkUsage, storage } = require('./quota-request-context');
    const state = storage.getStore();
    const fusion = usageValues.includes('fusion');
    let timer;
    try {
      await Promise.race([Promise.resolve().then(() => linkUsage({ id: billingResult.id, points: billingResult.pointsToDeduct, weightedTokens,
        attempts: fusion ? state?.attempts.filter(attempt => attempt.ended && attempt.metadata.status === 'success') : undefined })), new Promise(resolve => {
        timer = setTimeout(() => {
          Logger.warn('[QuotaRequestDegraded] operation=link_usage reason=deadline_exceeded');
          resolve();
        }, 1000);
      })]);
    } finally { clearTimeout(timer); }
  } catch (_) {
    Logger.warn('[QuotaRequestDegraded] operation=link_usage reason=capture_unavailable');
  }
  return billingResult;
}

module.exports = { deductBalance, checkBalance, preConsumeBalance, settleBalance, refundBalance, deductPoints, getUserPoints, recordUsageAndDeduct };
