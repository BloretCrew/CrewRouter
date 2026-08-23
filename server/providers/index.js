/**
 * Provider Registry
 *
 * 供应商适配器注册中心，管理所有供应商适配器
 */

// 导入适配器
const OpenAIAdapter = require('./openai');
const AnthropicAdapter = require('./anthropic');
const BaseProviderAdapter = require('./base');

// 适配器注册表
const adapters = {
  'openai': OpenAIAdapter,
  'anthropic': AnthropicAdapter
};

/**
 * 创建供应商适配器
 * @param {object} provider - 供应商配置对象
 * @returns {BaseProviderAdapter} 适配器实例
 */
function createAdapter(provider) {
  const format = provider.format || 'openai';
  const AdapterClass = adapters[format] || OpenAIAdapter;
  return new AdapterClass(provider);
}

/**
 * 注册新的适配器
 * @param {string} format - 格式名称
 * @param {class} adapterClass - 适配器类
 */
function registerAdapter(format, adapterClass) {
  adapters[format] = adapterClass;
}

/**
 * 注册新的格式转换
 * @param {string} sourceFormat - 源格式
 * @param {string} targetFormat - 目标格式
 * @param {object} transform - 转换函数对象 { request, response, stream? }
 */
function registerTransform(sourceFormat, targetFormat, transform) {
  transforms.registerTransform(sourceFormat, targetFormat, transform);
}

/**
 * 获取所有已注册的适配器格式
 * @returns {string[]} 格式列表
 */
function getRegisteredFormats() {
  return Object.keys(adapters);
}

/**
 * 检查是否有可用的适配器
 * @param {string} format - 格式名称
 * @returns {boolean}
 */
function hasAdapter(format) {
  return !!adapters[format];
}

/**
 * 获取客户端请求格式
 * 从请求路径和头部推断客户端期望的格式
 * @param {object} req - Express 请求对象
 * @returns {string} 格式类型
 */
function getClientFormat(req) {
  const path = req.path;

  // Anthropic Messages API
  if (path.includes('/messages')) {
    return 'anthropic';
  }

  // OpenAI Responses API
  if (path.includes('/responses')) {
    return 'responses';
  }

  // 默认 OpenAI Chat Completions
  return 'openai';
}

// 导出转换模块
const transforms = require('./transforms');

module.exports = {
  createAdapter,
  registerAdapter,
  registerTransform,
  getRegisteredFormats,
  hasAdapter,
  hasTransform: (a, b) => transforms.hasTransform(a, b),
  getClientFormat,
  // 适配器类
  OpenAIAdapter,
  AnthropicAdapter,
  BaseProviderAdapter,
  // 转换模块
  transforms
};
