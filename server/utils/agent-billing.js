'use strict';

const { pool } = require('../models/database');
const { calculateCost } = require('./billing');
const { calculatePointsToDeduct } = require('./points-deduct');
const { clientMetaFromReq } = require('./request-source');
const Logger = require('../logger');

async function recordAgentUsage({
  userId,
  modelConfig,
  requestType,
  promptTokens = 0,
  completionTokens = 0,
  req
}) {
  const billing = calculateCost(modelConfig || {}, {
    promptTokens,
    completionTokens,
    cachedTokens: 0
  });
  let teamId = null;
  try {
    const membership = await pool.query('SELECT team_id FROM users WHERE id = $1', [userId]);
    teamId = membership.rows[0]?.team_id || null;
  } catch (_) { /* 没有 team 时按积分扣 */ }
  const pointsToDeduct = await calculatePointsToDeduct({
    userId,
    teamId,
    weightedTokens: billing.weightedTokens,
    pointsCost: billing.pointsCost
  });
  const clientMeta = clientMetaFromReq(req || {});
  await pool.query(
    `INSERT INTO usage_records (user_id, model_id, tokens_used, weighted_tokens, prompt_tokens, completion_tokens, cost, request_type, provider_id, request_source, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      userId,
      modelConfig.id,
      promptTokens + completionTokens,
      billing.weightedTokens,
      promptTokens,
      completionTokens,
      pointsToDeduct,
      requestType,
      modelConfig.provider || null,
      clientMeta.requestSource,
      clientMeta.userAgent
    ]
  );
  if (pointsToDeduct > 0) {
    const { deductPoints } = require('./balance');
    await deductPoints(userId, pointsToDeduct);
  }
  return pointsToDeduct;
}

async function assertHasBalance(userId) {
  const userResult = await pool.query('SELECT balance + refund_balance as total FROM users WHERE id = $1', [userId]);
  const totalBalance = parseFloat(userResult.rows[0]?.total || 0);
  if (totalBalance <= 0) {
    return { ok: false, status: 402, error: '余额不足，请先充值' };
  }
  return { ok: true };
}

function logAgentError(scope, err) {
  Logger.error(`[Blora Agent] ${scope}: ${err.message}`);
}

module.exports = { recordAgentUsage, assertHasBalance, logAgentError };
