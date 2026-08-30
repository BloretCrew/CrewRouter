'use strict';

const { getBridgeCapability, Capability } = require('../protocol/capabilities');

const ERROR_CATEGORIES = Object.freeze({
  AUTHENTICATION: 'authentication',
  CAPABILITY: 'capability',
  CLIENT: 'client',
  RATE_LIMIT: 'rate_limit',
  TIMEOUT: 'timeout',
  UPSTREAM: 'upstream'
});

function normalizeFormat(format) {
  return String(format || 'openai').trim().toLowerCase() || 'openai';
}

/** Return only headers required for provider authentication. */
function buildAuthHeaders(format, apiKey) {
  const key = apiKey == null ? '' : String(apiKey);
  switch (normalizeFormat(format)) {
    case 'anthropic':
      return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    case 'gemini':
      return { 'x-goog-api-key': key };
    case 'openai':
    case 'responses':
    default:
      return { Authorization: `Bearer ${key}` };
  }
}

function getCapabilityPolicy(sourceFormat, targetFormat) {
  const source = normalizeFormat(sourceFormat);
  const target = normalizeFormat(targetFormat);
  const capability = getBridgeCapability(source, target);
  return Object.freeze({
    source,
    target,
    status: capability.status,
    supported: capability.status !== Capability.REJECT,
    degraded: capability.status === Capability.DEGRADE,
    reason: capability.reason || null
  });
}

function classifyRequestError({ status, code, format = 'openai', timeout = false } = {}) {
  const httpStatus = Number.isInteger(status) ? status : 502;
  const normalizedCode = String(code || '').toLowerCase();
  const isTimeout = timeout || normalizedCode === 'upstream_timeout' || normalizedCode === 'etimedout';
  let category = ERROR_CATEGORIES.UPSTREAM;
  if (httpStatus === 401 || httpStatus === 403 || /auth|credential|api.?key/.test(normalizedCode)) {
    category = ERROR_CATEGORIES.AUTHENTICATION;
  } else if (normalizedCode === 'unsupported_provider_format' || normalizedCode === 'unsupported_transform' || normalizedCode === 'gemini_not_supported') {
    category = ERROR_CATEGORIES.CAPABILITY;
  } else if (httpStatus === 400 || httpStatus === 404 || httpStatus === 422) {
    category = ERROR_CATEGORIES.CLIENT;
  } else if (httpStatus === 429 || /rate.?limit|quota/.test(normalizedCode)) {
    category = ERROR_CATEGORIES.RATE_LIMIT;
  } else if (isTimeout || httpStatus === 504) {
    category = ERROR_CATEGORIES.TIMEOUT;
  }

  const typeByFormat = normalizeFormat(format) === 'anthropic'
    ? { authentication: 'authentication_error', capability: 'api_error', client: 'invalid_request_error', rate_limit: 'rate_limit_error', timeout: 'timeout_error', upstream: 'api_error' }
    : { authentication: 'authentication_error', capability: 'server_error', client: 'invalid_request_error', rate_limit: 'rate_limit_error', timeout: 'timeout_error', upstream: 'server_error' };
  return Object.freeze({ category, status: httpStatus, retryable: category === ERROR_CATEGORIES.RATE_LIMIT || category === ERROR_CATEGORIES.TIMEOUT || (category === ERROR_CATEGORIES.UPSTREAM && httpStatus >= 500), type: typeByFormat[category] });
}

module.exports = { ERROR_CATEGORIES, normalizeFormat, buildAuthHeaders, getCapabilityPolicy, classifyRequestError };
