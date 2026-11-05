/**
 * 供应商多端点工具：
 * - 主端点：providers.base_url + format（所有遗留子系统仍然只读这一组）
 * - 附加端点：providers.endpoints JSONB，[{ url, format, enabled, label }]
 * - 请求转发时按「原生格式优先」排序并在失败时依次回退
 * - 额度 / 密钥刷新脚本 / quota 身份等辅助路径保持只用主端点
 */

const SUPPORTED_FORMATS = new Set(['openai', 'anthropic', 'responses']);
const CLIENT_NATIVE_FORMAT = Object.freeze({
  chat: 'openai',
  anthropic: 'anthropic',
  responses: 'responses'
});
// /v1/messages 只能转换到 OpenAI Chat 或直连 Anthropic，responses 上游没有对应转换器
const PROTOCOL_DENY_FORMATS = Object.freeze({
  anthropic: new Set(['responses'])
});

const MAX_ENDPOINTS = 16;
const MAX_URL_LENGTH = 500;
const MAX_LABEL_LENGTH = 50;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const RETRYABLE_STATUS = new Set([408, 429]);

function normalizeFormat(format) {
  const value = String(format || '').trim().toLowerCase();
  return SUPPORTED_FORMATS.has(value) ? value : '';
}

/** 端点 URL：去首尾空白与尾部斜杠，保留 /v1、/api/v1 版本前缀 */
function normalizeEndpointUrl(url) {
  const text = typeof url === 'string' ? url.trim() : '';
  if (!text) return '';
  return text.replace(/\/+$/, '');
}

function normalizeLabel(label, index) {
  const text = typeof label === 'string' ? label.trim() : '';
  if (!text) return `Endpoint ${index + 1}`;
  return text.slice(0, MAX_LABEL_LENGTH);
}

/** JSONB 可能已被 pg 解析为数组，也可能仍是字符串 */
function parseEndpointsRaw(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function endpointKey(url, format) {
  return `${url}\u0000${format}`;
}

/**
 * 归一化附加端点：过滤非法项、去重（首现者胜）。
 * 不在此处过滤 enabled=false，展示与连通性测试需要看到被停用的端点。
 * @param {*} raw
 * @returns {{ url: string, format: string, enabled: boolean, label: string, index: number }[]}
 */
function normalizeExtras(raw) {
  const entries = parseEndpointsRaw(raw);
  const seen = new Set();
  const result = [];
  for (let index = 0; index < entries.length; index++) {
    const item = entries[index];
    if (!item || typeof item !== 'object') continue;
    const url = normalizeEndpointUrl(item.url || item.base_url);
    const format = normalizeFormat(item.format);
    if (!url || !format) continue;
    if (url.length > MAX_URL_LENGTH || CONTROL_CHARS.test(url)) continue;
    const key = endpointKey(url, format);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      url,
      format,
      enabled: item.enabled !== false,
      label: normalizeLabel(item.label, index),
      index
    });
    if (result.length >= MAX_ENDPOINTS) break;
  }
  return result;
}

/**
 * 主端点 + 附加端点（主端点永远第一，且优先占用去重键）
 * @param {object} provider
 */
function normalizeProviderEndpoints(provider) {
  if (!provider) return [];
  const primaryUrl = normalizeEndpointUrl(provider.base_url);
  const primaryFormat = normalizeFormat(provider.format) || 'openai';
  const list = [];
  const seen = new Set();
  if (primaryUrl) {
    seen.add(endpointKey(primaryUrl.toLowerCase(), primaryFormat));
    list.push({
      url: primaryUrl,
      format: primaryFormat,
      enabled: true,
      label: 'Primary',
      primary: true,
      index: -1
    });
  }
  for (const entry of normalizeExtras(provider.endpoints)) {
    const key = endpointKey(entry.url.toLowerCase(), entry.format);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ ...entry, primary: false });
  }
  return list;
}

/** 附加端点数量（不含主端点） */
function countProviderEndpoints(provider) {
  return normalizeProviderEndpoints(provider).filter(e => !e.primary && e.enabled !== false).length;
}

/**
 * 按客户端协议挑选可尝试的端点：过滤停用/不支持，去重，原生格式稳定置前。
 * @param {object} provider
 * @param {'chat'|'anthropic'|'responses'} clientProtocol
 */
function endpointCandidatesFor(provider, clientProtocol) {
  const denied = PROTOCOL_DENY_FORMATS[clientProtocol] || null;
  const candidates = normalizeProviderEndpoints(provider)
    .filter(e => e.enabled !== false)
    .filter(e => SUPPORTED_FORMATS.has(e.format))
    .filter(e => !denied || !denied.has(e.format));
  const native = CLIENT_NATIVE_FORMAT[clientProtocol];
  if (!native) return candidates;
  // Array.prototype.sort 稳定：同格式内部保持配置顺序
  return candidates.slice().sort((a, b) => {
    const aNative = a.format === native ? 0 : 1;
    const bNative = b.format === native ? 0 : 1;
    return aNative - bNative;
  });
}

/**
 * 生成"以某个端点为主 URL/格式"的供应商克隆，proxy helper 无需改签名。
 * @param {object} provider
 * @param {{ url: string, format: string }} endpoint
 */
function makeEndpointProvider(provider, endpoint) {
  if (!endpoint) return { ...provider };
  return { ...provider, base_url: endpoint.url, format: endpoint.format, _endpoint: endpoint };
}

/** 端点级回退状态：请求超时、限流、上游错误 */
function isEndpointRetryableStatus(status) {
  const code = Number(status);
  return Number.isFinite(code) && (RETRYABLE_STATUS.has(code) || code >= 500);
}

function isValidHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 校验前端提交的附加端点列表（admin / user 共用）。
 * @param {*} raw 请求体里的 endpoints；未提供时调用方不应调用本函数
 * @param {{ baseUrl?: string, format?: string }} [primary] 用于检测与主端点重复
 * @returns {{ ok: boolean, endpoints: object[], errors: {index:number,field:string,message:string}[] }}
 */
function normalizeEndpointsInput(raw, primary = {}) {
  const errors = [];
  if (!Array.isArray(raw)) {
    return { ok: false, endpoints: [], errors: [{ index: -1, field: 'endpoints', message: '端点必须是数组' }] };
  }
  if (raw.length > MAX_ENDPOINTS) {
    return { ok: false, endpoints: [], errors: [{ index: -1, field: 'endpoints', message: `最多配置 ${MAX_ENDPOINTS} 个附加端点` }] };
  }

  const primaryUrl = normalizeEndpointUrl(primary.baseUrl);
  const primaryFormat = normalizeFormat(primary.format) || 'openai';
  const seen = new Set();
  if (primaryUrl) seen.add(endpointKey(primaryUrl.toLowerCase(), primaryFormat));

  const endpoints = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ index, field: 'endpoints', message: '端点格式无效' });
      return;
    }
    const url = normalizeEndpointUrl(item.url || item.base_url);
    const format = normalizeFormat(item.format);
    if (!url) {
      errors.push({ index, field: 'url', message: '请填写端点 URL' });
      return;
    }
    if (url.length > MAX_URL_LENGTH) {
      errors.push({ index, field: 'url', message: `端点 URL 不能超过 ${MAX_URL_LENGTH} 个字符` });
      return;
    }
    if (CONTROL_CHARS.test(url) || !isValidHttpUrl(url)) {
      errors.push({ index, field: 'url', message: '端点 URL 需以 http:// 或 https:// 开头' });
      return;
    }
    if (!format) {
      errors.push({ index, field: 'format', message: '端点格式仅支持 openai / anthropic / responses' });
      return;
    }
    const key = endpointKey(url.toLowerCase(), format);
    if (seen.has(key)) {
      errors.push({ index, field: 'url', message: '端点与主端点或其他端点重复' });
      return;
    }
    seen.add(key);
    endpoints.push({
      url,
      format,
      enabled: item.enabled !== false,
      label: normalizeLabel(item.label, index)
    });
  });

  return { ok: errors.length === 0, endpoints: errors.length ? [] : endpoints, errors };
}

module.exports = {
  SUPPORTED_FORMATS,
  MAX_ENDPOINTS,
  MAX_URL_LENGTH,
  parseEndpointsRaw,
  normalizeEndpointUrl,
  normalizeProviderEndpoints,
  countProviderEndpoints,
  endpointCandidatesFor,
  makeEndpointProvider,
  isEndpointRetryableStatus,
  normalizeEndpointsInput,
  endpointKey
};
