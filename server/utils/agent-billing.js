'use strict';

const { pool } = require('../models/database');
const { calculateCost } = require('./billing');
const { clientMetaFromReq } = require('./request-source');
const Logger = require('../logger');

// transactionClient, when supplied, is an exclusively held idle claim client.
// This function owns its short BEGIN/COMMIT/ROLLBACK, but never releases it.
async function recordAgentUsage({
  userId,
  modelConfig,
  requestType,
  promptTokens = 0,
  completionTokens = 0,
  req,
  identity = {},
  attempts,
  persist,
  transactionClient
}) {
  const billing = calculateCost(modelConfig || {}, {
    promptTokens,
    completionTokens,
    cachedTokens: 0
  });
  const clientMeta = clientMetaFromReq(req || {});
  const client = transactionClient || await pool.connect();
  let inserted;
  let pointsToDeduct;
  try {
    await client.query('BEGIN');
    const user = await client.query('SELECT team_id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user.rows[0]) throw new Error('用户不存在');
    const { deductPoints } = require('./balance');
    const deducted = await deductPoints(userId, billing.pointsCost, client, {
      teamId: user.rows[0].team_id,
      weightedTokens: billing.weightedTokens,
      pointsCost: billing.pointsCost
    });
    if (!deducted.ok) throw Object.assign(new Error('积分扣除失败，请检查余额后重试'), { status: 402, billingFailure: true });
    pointsToDeduct = deducted.pointsToDeduct ?? 0;
    inserted = await client.query(
      `INSERT INTO usage_records (user_id, model_id, tokens_used, weighted_tokens, prompt_tokens, completion_tokens, cost, request_type, provider_id, request_source, user_agent, requested_model, resolved_model, response_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [userId, modelConfig.id, promptTokens + completionTokens, billing.weightedTokens,
        promptTokens, completionTokens, pointsToDeduct, requestType, modelConfig.provider || null,
        clientMeta.requestSource, clientMeta.userAgent, identity.requested_model ?? null,
        identity.resolved_model ?? null, identity.response_model ?? null]
    );
    // Image/thread persistence shares the debit transaction. Callbacks must
    // perform only database writes with this client, never network requests.
    if (persist) await persist(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { if (!transactionClient) client.release(); }
  try {
    const { linkUsage } = require('./quota-request-context');
    await linkUsage({ req, attempts, modelConfig, id: inserted.rows[0]?.id, points: pointsToDeduct, weightedTokens: billing.weightedTokens });
  } catch (error) { logAgentError('usage capture after commit', error); }
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
