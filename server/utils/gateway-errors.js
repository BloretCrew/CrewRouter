'use strict';

const googleError = require('./google-error');

function isAnthropicApiPath(req) {
  const path = String(req?.path || req?.url || '').split('?')[0];
  return path === '/messages' || path.endsWith('/messages');
}

function isGeminiApiPath(req) {
  const base = String(req?.baseUrl || '');
  const path = String(req?.path || req?.url || '').split('?')[0];
  if (base === '/v1beta' || base.endsWith('/v1beta')) return true;
  if (path === '/interactions' || path.startsWith('/interactions/')) return true;
  if (path.startsWith('/models/')) return true;
  return false;
}

function anthropicType(type) {
  const map = {
    upstream_error: 'api_error',
    server_error: 'api_error',
    quota_exceeded: 'rate_limit_error',
    insufficient_quota: 'rate_limit_error',
    key_disabled: 'authentication_error',
  };
  return map[type] || type;
}

function openaiType(type) {
  const map = {
    upstream_error: 'server_error',
    quota_exceeded: 'insufficient_quota',
  };
  return map[type] || type;
}

/**
 * 构建与目标协议匹配的错误体。策略错误需要保留 code/extra，
 * 因此这里不复用 api.js 中会丢弃 Anthropic code 的 omitOpenAIOnly。
 */
function buildPolicyErrorBody(req, type, message, extra = {}) {
  if (isGeminiApiPath(req)) {
    const status = type === 'rate_limit_error' || type === 'insufficient_quota' ? 429
      : (type === 'permission_error' ? 403 : 500);
    return {
      status,
      body: googleError.googleErrorBody(status, message, {
        reason: String(extra.code || 'POLICY_BLOCKED').toUpperCase(),
        metadata: extra.request_id ? { request_id: String(extra.request_id) } : {},
      }),
    };
  }
  if (isAnthropicApiPath(req)) {
    return {
      status: null,
      body: {
        type: 'error',
        error: { type: anthropicType(type), message, ...extra },
      },
    };
  }
  return {
    status: null,
    body: { error: { type: openaiType(type), message, ...extra } },
  };
}

function sendGatewayError(req, res, status, type, message, extra = {}) {
  const built = buildPolicyErrorBody(req, type, message, extra);
  const finalStatus = built.status || status || 403;
  if (extra.retry_after) res.setHeader('Retry-After', String(extra.retry_after));
  if (!res.headersSent) {
    return res.status(finalStatus).json(built.body);
  }
  return null;
}

module.exports = {
  isAnthropicApiPath,
  isGeminiApiPath,
  buildPolicyErrorBody,
  sendGatewayError,
};
