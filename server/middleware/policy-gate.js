'use strict';

const Logger = require('../logger');
const { isTeamEditionCached } = require('../utils/instance-edition');
const { buildPolicySignals } = require('../utils/policy/signals');
const { evaluatePolicies } = require('../utils/policy/engine');
const { executeDecision } = require('../utils/policy/actions');
const { recordDecisionHits } = require('../utils/policy/hit-recorder');
const { notifyPolicyHit } = require('../utils/policy/alerts');

/**
 * 网关策略闸门：oauthBearer 之后、业务 handler 之前执行。
 * 失败默认放行（fail-open），可通过策略设置切换为 fail-closed。
 */
async function policyGate(req, res, next) {
  if (!req.apiUser?.userId && !req.apiUser?.teamId) return next();
  try {
    if (!(await isTeamEditionCached())) return next();
  } catch (_) {
    return next();
  }

  let signals;
  let decision;
  try {
    signals = buildPolicySignals(req);
    decision = await evaluatePolicies(signals);
  } catch (error) {
    Logger.error('[策略] 评估失败:', error);
    return next();
  }

  req.policyDecision = decision;
  if (decision.effectiveRateLimits) req.policyRateLimits = decision.effectiveRateLimits;
  if (decision.modelQueueOverride?.length) {
    const target = decision.modelQueueOverride[0];
    const configured = new Set([
      ...(signals.actor?.modelQueue || []),
      ...Object.values(signals.actor?.harnessModels || {}),
      ...(signals.actor?.requestModelBindings || []).map(binding => binding.modelId),
      signals.actor?.currentModelId,
    ].filter(Boolean).map(String));
    if (!configured.has(String(target))) {
      Logger.warn(`[策略] 忽略未配置的降级模型: ${target}`);
      decision.modelQueueOverride = null;
    }
  }
  if (decision.outcome !== 'deny') return next();

  const context = {
    requestId: req._upstreamAttemptContext?.requestId || null,
    statusCode: decision.statusCode,
  };
  try {
    recordDecisionHits(signals, decision, context);
  } catch (error) {
    Logger.warn(`[策略] 记录命中失败: ${error.message}`);
  }
  notifyPolicyHit(signals, decision).catch(() => {});

  try {
    const result = await executeDecision(req, res, decision);
    if (result?.handled) return;
    return next();
  } catch (error) {
    Logger.error('[策略] 执行动作失败:', error);
    return next();
  }
}

module.exports = { policyGate };
