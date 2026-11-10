'use strict';

/** Google API error envelope used by Gemini generateContent and Interactions. */

const HTTP_TO_STATUS = Object.freeze({
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'ABORTED',
  412: 'FAILED_PRECONDITION',
  413: 'INVALID_ARGUMENT',
  415: 'INVALID_ARGUMENT',
  422: 'INVALID_ARGUMENT',
  429: 'RESOURCE_EXHAUSTED',
  499: 'CANCELLED',
  500: 'INTERNAL',
  501: 'UNIMPLEMENTED',
  502: 'UNAVAILABLE',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED'
});

const OPENAI_TYPE_TO_STATUS = Object.freeze({
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  invalid_request_error: 400,
  rate_limit_error: 429,
  insufficient_quota: 429,
  server_error: 500,
  api_error: 502,
  timeout_error: 504,
  overloaded_error: 529
});

const ANTHROPIC_TYPE_TO_STATUS = Object.freeze({
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  invalid_request_error: 400,
  rate_limit_error: 429,
  api_error: 502,
  overloaded_error: 529,
  timeout_error: 504
});

function httpStatusForType(type) {
  return OPENAI_TYPE_TO_STATUS[type] || ANTHROPIC_TYPE_TO_STATUS[type] || 500;
}

function statusForHttp(httpStatus, fallback = 'UNKNOWN') {
  const code = Number(httpStatus);
  return HTTP_TO_STATUS[code] || fallback;
}

function googleErrorBody(httpStatus, message, options = {}) {
  const code = Number.isInteger(httpStatus) ? httpStatus : 500;
  const status = options.status || statusForHttp(code, 'UNKNOWN');
  const error = { code, message: String(message || status), status };
  if (options.reason || options.details) {
    error.details = options.details || [{
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: options.reason,
      domain: options.domain || 'generativelanguage.googleapis.com',
      metadata: options.metadata || {}
    }];
  }
  return { error };
}

function sendGoogleError(res, httpStatus, message, options = {}) {
  if (res.headersSent) {
    try { res.destroy(); } catch { /* ignore */ }
    return;
  }
  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(httpStatus).json(googleErrorBody(httpStatus, message, options));
}

function normalizeUpstreamErrorBody(format, status, body) {
  if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
    const error = body.error;
    if (error.code !== undefined && error.status) return body; // Already Google-shaped.
    const message = error.message || error.type || 'Upstream request failed';
    const mapped = format === 'openai'
      ? (OPENAI_TYPE_TO_STATUS[error.type] || status)
      : (format === 'anthropic'
        ? (ANTHROPIC_TYPE_TO_STATUS[error.type] || status)
        : status);
    return googleErrorBody(Number(status) || mapped, message, {
      reason: error.code || error.type
    });
  }
  const text = typeof body === 'string' ? body.slice(0, 2000) : (body ? JSON.stringify(body).slice(0, 2000) : 'Upstream request failed');
  return googleErrorBody(Number(status) || 502, text, { reason: 'UPSTREAM_ERROR' });
}

module.exports = {
  HTTP_TO_STATUS,
  statusForHttp,
  googleErrorBody,
  sendGoogleError,
  normalizeUpstreamErrorBody
};
