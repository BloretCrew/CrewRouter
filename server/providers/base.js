/**
 * Base Provider Adapter
 *
 * 所有供应商适配器的基类，定义统一接口
 */
class BaseProviderAdapter {
  constructor(provider) {
    this.provider = provider;
  }

  /**
   * 获取供应商名称
   */
  get name() {
    return this.provider.id;
  }

  /**
   * 获取 API 格式
   * @returns {'openai' | 'anthropic' | 'gemini' | 'responses'}
   */
  getApiFormat() {
    return this.provider.format || 'openai';
  }

  /**
   * 是否需要格式转换
   * 当客户端请求格式与上游供应商格式不同时需要转换
   */
  needsTransform(clientFormat) {
    return clientFormat !== this.getApiFormat();
  }

  /**
   * 转换请求体
   * @param {object} body - 原始请求体
   * @param {string} clientFormat - 客户端请求格式
   * @returns {object} 转换后的请求体
   */
  transformRequest(body, clientFormat) {
    const targetFormat = this.getApiFormat();
    if (clientFormat === targetFormat) return body;

    const { getTransform } = require('./transforms');
    const transform = getTransform(clientFormat, targetFormat);
    if (!transform) {
      throw new Error(`No transform available: ${clientFormat} → ${targetFormat}`);
    }
    return transform.request(body);
  }

  /**
   * 转换响应体
   * @param {object} body - 上游响应体
   * @param {string} clientFormat - 客户端期望的响应格式
   * @returns {object} 转换后的响应体
   */
  transformResponse(body, clientFormat) {
    const sourceFormat = this.getApiFormat();
    if (sourceFormat === clientFormat) return body;

    const { getTransform } = require('./transforms');
    const transform = getTransform(sourceFormat, clientFormat);
    if (!transform) {
      throw new Error(`No transform available: ${sourceFormat} → ${clientFormat}`);
    }
    return transform.response(body);
  }

  /**
   * 构建上游请求 URL
   * @param {string} model - 模型 ID
   * @returns {string} 完整的请求 URL
   * @throws {Error} 如果 URL 无效或指向内网地址
   */
  async buildUrl(model) {
    const baseUrl = this.provider.base_url.replace(/\/$/, '');
    const format = this.getApiFormat();
    const { upstreamUrl } = require('../utils/url-validator');

    let fullUrl;
    switch (format) {
      case 'anthropic':
        fullUrl = upstreamUrl(baseUrl, '/messages');
        break;
      case 'gemini':
        fullUrl = `${baseUrl}/v1beta/models/${model}:generateContent`;
        break;
      case 'responses':
        fullUrl = upstreamUrl(baseUrl, '/responses');
        break;
      case 'openai':
      default:
        fullUrl = upstreamUrl(baseUrl, '/chat/completions');
        break;
    }

    // SSRF 防护：校验 URL 合法性
    const { validateUrl } = require('../utils/url-validator');
    const result = await validateUrl(fullUrl, { allowPrivate: false });
    if (!result.ok) {
      throw new Error(`[SSRF] URL 校验失败: ${result.error} (base_url: ${baseUrl})`);
    }

    return fullUrl;
  }

  /**
   * 构建流式请求 URL
   * @param {string} model - 模型 ID
   * @returns {string} 完整的请求 URL
   */
  async buildStreamUrl(model) {
    return this.buildUrl(model);
  }

  /**
   * 获取认证头
   * @returns {object} 认证头对象
   */
  getAuthHeaders() {
    const format = this.getApiFormat();
    const apiKey = this.provider.api_key;

    switch (format) {
      case 'anthropic':
        return {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        };
      case 'gemini':
        return {
          'x-goog-api-key': apiKey
        };
      case 'openai':
      case 'responses':
      default:
        return {
          'Authorization': `Bearer ${apiKey}`
        };
    }
  }

  /**
   * 构建请求头
   * @param {object} extraHeaders - 额外的请求头
   * @returns {object} 完整的请求头
   */
  buildHeaders(extraHeaders = {}) {
    return {
      'Content-Type': 'application/json',
      ...this.getAuthHeaders(),
      ...extraHeaders
    };
  }
}

module.exports = BaseProviderAdapter;
