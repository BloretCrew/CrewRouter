'use strict';

const { pool } = require('../../models/database');
const Logger = require('../../logger');
const { sendGatewayError } = require('../gateway-errors');
const concurrency = require('./concurrency');
const suspension = require('./suspension');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestIdOf(req) {
  return req._upstreamAttemptContext?.requestId || null;
}

async function createApproval(req, decision) {
  const policy = decision.policy || {};
  const userId = req.apiUser?.userId || null;
  const ttlSeconds = Number(decision.options?.approval_ttl_seconds) || 3600;
  const result = await pool.query(
    `INSERT INTO policy_approvals (kind, policy_id, requested_by, payload, preview, expires_at)
     VALUES ('request', $1, $2, $3::jsonb, $4::jsonb, NOW() + ($5::int * INTERVAL '1 second'))
     RETURNING id`,
    [
      policy.id || null,
      userId,
      JSON.stringify({
        request_id: requestIdOf(req),
        user_id: userId,
        team_id: req.apiUser?.teamId || null,
        api_key_id: req.apiUser?.keyId || null,
        request_source: decision.requestSource || null,
        model: req.body?.model || null,
        path: req.path || null,
      }),
      JSON.stringify({ message: decision.message, action: decision.action }),
      ttlSeconds,
    ]
  );
  return result.rows[0]?.id || null;
}

async function executeDecision(req, res, decision) {
  const policy = decision.policy || {};
  const options = decision.options || {};
  const extra = {
    code: decision.code,
    policy_id: policy.id || null,
    policy_name: policy.name || null,
    request_id: requestIdOf(req),
  };

  switch (decision.action) {
    case 'block':
      sendGatewayError(req, res, decision.statusCode || 403, 'permission_error', decision.message, extra);
      return { handled: true };
    case 'custom':
      if (!res.headersSent) {
        res.status(options.custom_status || decision.statusCode || 403).json({
          error: {
            message: options.custom_message || decision.message,
            type: 'permission_error',
            code: decision.code || 'policy_blocked',
            policy_id: policy.id || null,
            policy_name: policy.name || null,
            request_id: requestIdOf(req),
          },
        });
      }
      return { handled: true };
    case 'suspend': {
      const seconds = Number(options.suspend_seconds) || 3600;
      const until = new Date(Date.now() + seconds * 1000);
      try {
        await suspension.suspendUser(pool, {
          userId: req.apiUser?.userId,
          until,
          reason: options.suspend_reason || `自动触发策略「${policy.name || '未命名'}」`,
          scope: options.suspend_scope === 'api' ? 'api' : 'all',
          by: null,
        });
      } catch (error) {
        Logger.warn(`[策略] 自动暂停成员失败: ${error.message}`);
      }
      sendGatewayError(req, res, 403, 'permission_error', '账号已被团队策略暂停', {
        ...extra,
        code: 'member_suspended',
        suspended_until: until.toISOString(),
      });
      return { handled: true };
    }
    case 'revoke_key': {
      try {
        if (req.apiUser?.keyId) {
          await pool.query('UPDATE api_keys SET enabled = FALSE WHERE id = $1', [req.apiUser.keyId]);
          // 惰性解引用，避免 routes/api.js ↔ policy 模块循环依赖。
          const { invalidateApiKeyCacheByKeyId } = require('../../routes/api');
          invalidateApiKeyCacheByKeyId(req.apiUser.keyId);
        }
      } catch (error) {
        Logger.warn(`[策略] 自动吊销 Key 失败: ${error.message}`);
      }
      sendGatewayError(req, res, 403, 'permission_error', 'API Key 已被团队策略停用', {
        ...extra,
        code: 'key_revoked_by_policy',
      });
      return { handled: true };
    }
    case 'approval': {
      const approvalId = await createApproval(req, decision).catch(error => {
        Logger.warn(`[策略] 创建审批失败: ${error.message}`);
        return null;
      });
      sendGatewayError(req, res, 428, 'permission_error', decision.message || '该请求需要管理员审批', {
        ...extra,
        code: 'policy_approval_required',
        approval_id: approvalId,
        retry_after: Number(options.approval_retry_after_seconds) || 60,
      });
      return { handled: true };
    }
    case 'step_up':
      sendGatewayError(req, res, 428, 'permission_error', decision.message || '该请求需要二次认证', {
        ...extra,
        code: 'policy_step_up_required',
      });
      return { handled: true };
    case 'queue': {
      const max = Number(options.queue_max) || 1;
      const aggregate = options.queue_aggregate || 'member';
      const waitMs = Number(options.queue_wait_ms) || 30000;
      try {
        const release = await concurrency.acquire(req._policySignals, {
          max, aggregate, waitMs, maxQueue: Number(options.queue_max_length) || 100,
        });
        res.once('finish', release);
        res.once('close', release);
        return { handled: false };
      } catch (error) {
        const code = error.code === 'policy_queue_full' ? 'policy_queue_full' : 'policy_queue_timeout';
        sendGatewayError(req, res, 429, 'rate_limit_error', '当前并发已满，请稍后重试', {
          ...extra,
          code,
          retry_after: 5,
        });
        return { handled: true };
      }
    }
    case 'throttle': {
      const ms = Math.min(5000, Math.max(0, Number(options.throttle_ms) || 1000));
      await sleep(ms);
      return { handled: false };
    }
    case 'downgrade':
      // modelQueueOverride 已由 engine 写入 decision，handler 会读取。
      return { handled: false };
    case 'warn':
      res.setHeader('X-CrewRouter-Policy-Warning', encodeURIComponent(decision.message || ''));
      res.setHeader('X-CrewRouter-Policy-Id', String(policy.id || ''));
      return { handled: false };
    case 'notify':
    case 'shadow':
    default:
      return { handled: false };
  }
}

module.exports = { executeDecision };
