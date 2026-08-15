/**
 * 上游错误码标准化映射工具
 *
 * 将 Anthropic / OpenAI 等不同 API 提供商的错误响应映射为统一的目标格式，
 * 确保客户端不论连接何种上游都能收到语义一致的错误。
 */

// Anthropic → OpenAI 错误类型映射
const ANTHROPIC_TO_OPENAI = {
  'invalid_request_error': 'invalid_request_error',
  'authentication_error': 'authentication_error',
  'permission_error': 'permission_error',
  'not_found_error': 'not_found_error',
  'rate_limit_error': 'rate_limit_error',
  'api_error': 'server_error',
  'overloaded_error': 'server_error',
  'timeout_error': 'server_error',
  'server_error': 'server_error',
  'service_unavailable': 'server_error',
};

// OpenAI → Anthropic 错误类型映射
const OPENAI_TO_ANTHROPIC = {
  'invalid_request_error': 'invalid_request_error',
  'authentication_error': 'authentication_error',
  'permission_error': 'permission_error',
  'not_found_error': 'not_found_error',
  'rate_limit_error': 'rate_limit_error',
  'insufficient_quota': 'rate_limit_error',
  'server_error': 'api_error',
  'upstream_error': 'api_error',
  'proxy_error': 'api_error',
  'api_error': 'api_error',
  'quota_exceeded': 'rate_limit_error',
};

// HTTP 状态码 → Anthropic 错误类型（兜底）
const STATUS_TO_ANTHROPIC = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  422: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'api_error',
  502: 'api_error',
  503: 'service_unavailable',
  504: 'timeout_error',
};

// HTTP 状态码 → OpenAI 错误类型（兜底）
const STATUS_TO_OPENAI = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  422: 'invalid_request_error',
  429: 'rate_limit_error',
  500: 'server_error',
  502: 'server_error',
  503: 'server_error',
  504: 'server_error',
};

/**
 * 检测响应体格式
 */
function detectFormat(body) {
  if (!body) return 'unknown';
  // Anthropic 格式：{ type: "error", error: { type: "...", message: "..." } }
  if (body.type === 'error' && body.error && typeof body.error === 'object') {
    return 'anthropic';
  }
  // OpenAI 格式：{ error: { type: "...", message: "..." } }
  if (body.error && (body.error.type || body.error.message)) {
    return 'openai';
  }
  return 'unknown';
}

/**
 * 从各种格式的错误体中提取标准化错误信息
 */
function extractError(body, statusCode) {
  const format = detectFormat(body);

  if (format === 'anthropic') {
    const err = body.error || {};
    return {
      upstreamType: err.type || STATUS_TO_OPENAI[statusCode] || 'api_error',
      message: err.message || err.error || 'Unknown error',
      upstreamFormat: 'anthropic',
    };
  }

  if (format === 'openai') {
    const err = body.error || body;
    return {
      upstreamType: err.type || STATUS_TO_OPENAI[statusCode] || 'api_error',
      message: err.message || err.error || err.code || 'Unknown error',
      upstreamFormat: 'openai',
    };
  }

  // 未知格式：从状态码推断
  return {
    upstreamType: STATUS_TO_OPENAI[statusCode] || 'api_error',
    message: typeof body === 'string' ? body : (body.message || body.error || JSON.stringify(body).slice(0, 500)),
    upstreamFormat: 'unknown',
  };
}

/**
 * 将错误转换为 OpenAI 格式
 */
function toOpenAIError(body, statusCode) {
  const { upstreamType, message } = extractError(body, statusCode);
  const mappedType = (detectFormat(body) === 'anthropic')
    ? ANTHROPIC_TO_OPENAI[upstreamType] || STATUS_TO_OPENAI[statusCode] || 'server_error'
    : upstreamType;

  // 再兜底一次非标准类型
  const finalType = (mappedType === 'upstream_error' || mappedType === 'proxy_error')
    ? 'server_error'
    : (mappedType === 'quota_exceeded' ? 'insufficient_quota' : mappedType);

  return {
    error: {
      type: finalType || STATUS_TO_OPENAI[statusCode] || 'server_error',
      message: typeof message === 'string' ? message : String(message),
    }
  };
}

/**
 * 将错误转换为 Anthropic 格式
 */
function toAnthropicError(body, statusCode) {
  const { upstreamType, message } = extractError(body, statusCode);
  let mappedType = (detectFormat(body) === 'openai')
    ? OPENAI_TO_ANTHROPIC[upstreamType] || STATUS_TO_ANTHROPIC[statusCode] || 'api_error'
    : (OPENAI_TO_ANTHROPIC[upstreamType] || upstreamType);

  // 非标准类型兜底
  if (mappedType === 'upstream_error' || mappedType === 'server_error' || mappedType === 'proxy_error') {
    mappedType = 'api_error';
  }
  if (mappedType === 'quota_exceeded' || mappedType === 'insufficient_quota') {
    mappedType = 'rate_limit_error';
  }
  // service_unavailable 非官方常用类型，归一为 api_error / overloaded 语义
  if (mappedType === 'service_unavailable') {
    mappedType = 'api_error';
  }

  return {
    type: 'error',
    error: {
      type: mappedType || STATUS_TO_ANTHROPIC[statusCode] || 'api_error',
      message: typeof message === 'string' ? message : String(message),
    }
  };
}

/**
 * 根据目标格式映射上游错误
 */
function mapError(body, statusCode, targetFormat) {
  if (targetFormat === 'anthropic') return toAnthropicError(body, statusCode);
  return toOpenAIError(body, statusCode);
}

module.exports = {
  detectFormat,
  extractError,
  toOpenAIError,
  toAnthropicError,
  mapError,
};
