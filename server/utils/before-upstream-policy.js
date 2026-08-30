'use strict';

const { validateUrl } = require('./url-validator');

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const CROSS_ORIGIN_CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'proxy-authorization',
  'cookie',
  'x-goog-api-key',
  'x-azure-api-key',
]);
const FORBIDDEN_TRANSPORT_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
]);

function policyError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw policyError('beforeUpstream headers must be an object', 'plugin_headers_invalid');
  }

  const normalized = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = String(name).toLowerCase().trim();
    if (!lower) continue;
    if (FORBIDDEN_TRANSPORT_HEADERS.has(lower)) {
      throw policyError(`beforeUpstream header is not allowed: ${lower}`, 'plugin_header_forbidden');
    }
    if (value !== null && value !== undefined) {
      if (Array.isArray(value) || (typeof value !== 'string' && typeof value !== 'number')) {
        throw policyError(`beforeUpstream header value is invalid: ${lower}`, 'plugin_header_invalid');
      }
      normalized[lower] = String(value);
    }
  }
  return normalized;
}

function headersEqual(left, right) {
  const leftEntries = Object.entries(normalizeHeaders(left)).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(normalizeHeaders(right)).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/**
 * 校验插件对一次上游请求的改写。此处只做安全重查，不触发配额、限流或计费副作用。
 */
async function validateBeforeUpstreamRewrite(original, rewritten, options = {}) {
  const result = rewritten && typeof rewritten === 'object' ? rewritten : {};
  const effective = {
    url: Object.prototype.hasOwnProperty.call(result, 'url') ? result.url : original.url,
    headers: Object.prototype.hasOwnProperty.call(result, 'headers') ? result.headers : original.headers,
    bodyText: Object.prototype.hasOwnProperty.call(result, 'bodyText') ? result.bodyText : original.bodyText,
    model: Object.prototype.hasOwnProperty.call(result, 'model') ? result.model : original.model,
    provider: Object.prototype.hasOwnProperty.call(result, 'provider') ? result.provider : original.provider,
    providerId: Object.prototype.hasOwnProperty.call(result, 'providerId') ? result.providerId : original.providerId,
  };
  const override = {};
  const changed = {
    url: effective.url !== original.url,
    headers: !headersEqual(effective.headers, original.headers),
    bodyText: effective.bodyText !== original.bodyText,
    model: effective.model !== original.model,
    provider: effective.provider !== original.provider || effective.providerId !== original.providerId,
  };

  if (changed.model || (options.authorizedModel !== undefined && effective.model !== options.authorizedModel)) {
    throw policyError('beforeUpstream model is not authorized', 'plugin_model_unauthorized');
  }
  if (changed.provider || (options.authorizedProviderId !== undefined && effective.providerId !== options.authorizedProviderId)) {
    throw policyError('beforeUpstream provider is not authorized', 'plugin_provider_unauthorized');
  }

  if (changed.url) {
    if (typeof effective.url !== 'string' || !effective.url) {
      throw policyError('beforeUpstream URL must be a non-empty string', 'plugin_url_invalid');
    }
    const checkUrl = options.validateUrl || validateUrl;
    const checked = await checkUrl(effective.url, { allowPrivate: false, resolveDNS: true });
    if (!checked.ok) {
      throw policyError(`beforeUpstream URL rejected: ${checked.error}`, 'plugin_url_rejected');
    }
    override.url = checked.url ? checked.url.toString() : effective.url;
  }

  if (changed.bodyText) {
    if (typeof effective.bodyText !== 'string') {
      throw policyError('beforeUpstream bodyText must be a JSON string', 'plugin_body_invalid');
    }
    const maxBodyBytes = options.maxBodyBytes === undefined
      ? DEFAULT_MAX_BODY_BYTES
      : options.maxBodyBytes;
    if (Buffer.byteLength(effective.bodyText, 'utf8') > maxBodyBytes) {
      throw policyError(`beforeUpstream body exceeds the ${maxBodyBytes}-byte limit`, 'plugin_body_too_large');
    }

    let body;
    try {
      body = JSON.parse(effective.bodyText);
    } catch {
      throw policyError('beforeUpstream bodyText must contain valid JSON', 'plugin_body_invalid_json');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw policyError('beforeUpstream bodyText must contain a JSON object', 'plugin_body_invalid');
    }
    if (typeof body.model !== 'string' || !body.model.trim()) {
      throw policyError('beforeUpstream bodyText must contain model', 'plugin_model_required');
    }

    let originalBody;
    try {
      originalBody = JSON.parse(original.bodyText);
    } catch {
      throw policyError('Original upstream body is invalid JSON', 'upstream_body_invalid');
    }
    if (body.model !== originalBody.model) {
      throw policyError('beforeUpstream body model is not authorized', 'plugin_model_unauthorized');
    }
    if (options.authorizedModel !== undefined && body.model !== options.authorizedModel) {
      throw policyError('beforeUpstream body model is not authorized', 'plugin_model_unauthorized');
    }
    override.bodyText = effective.bodyText;
  }

  if (changed.headers || (changed.url && !sameOrigin(original.url, override.url))) {
    const headers = normalizeHeaders(changed.headers ? effective.headers : original.headers);
    if (changed.url && !sameOrigin(original.url, override.url)) {
      for (const name of CROSS_ORIGIN_CREDENTIAL_HEADERS) delete headers[name];
    }
    override.headers = headers;
  }

  return { override, changed };
}

module.exports = {
  DEFAULT_MAX_BODY_BYTES,
  CROSS_ORIGIN_CREDENTIAL_HEADERS,
  normalizeHeaders,
  validateBeforeUpstreamRewrite,
};
