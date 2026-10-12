'use strict';

const PRE_SEND_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);
const TERMINAL_ERROR_CODES = new Set([
  'ERR_CANCELED', 'ABORT_ERR', 'upstream_attempt_limit',
  'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'
]);

function canRetryUpstreamError(error, context) {
  if (!error || context?.signal?.aborted || (context?.upstreamAttempts || 0) >= 12) return false;
  if (TERMINAL_ERROR_CODES.has(error.code)
    || ['AbortError', 'CanceledError', 'TimeoutError'].includes(error.name)) return false;
  const attempt = error.upstreamAttempt || context?.lastAttempt;
  if (attempt?.responseStarted || attempt?.status != null) return false;
  if (error.response) return false;
  // Only DNS resolution and refused connections prove no upstream send occurred.
  return PRE_SEND_ERROR_CODES.has(error.code);
}

function isTerminalUpstreamError(error, context) {
  return !canRetryUpstreamError(error, context);
}

module.exports = { canRetryUpstreamError, isTerminalUpstreamError };
