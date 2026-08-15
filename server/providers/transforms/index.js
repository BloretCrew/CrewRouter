/**
 * Transform Registry
 *
 * 格式转换注册中心，管理所有格式转换函数
 */

// 导入转换模块
const anthropicToOpenai = require('./anthropic-to-openai');
const openaiToAnthropic = require('./openai-to-anthropic');

// 转换注册表
const transforms = {
  'anthropic->openai': anthropicToOpenai,
  'openai->anthropic': openaiToAnthropic
};

/**
 * 获取转换函数
 * @param {string} sourceFormat - 源格式
 * @param {string} targetFormat - 目标格式
 * @returns {object|null} 转换函数对象或 null
 */
function getTransform(sourceFormat, targetFormat) {
  const key = `${sourceFormat}->${targetFormat}`;
  return transforms[key] || null;
}

/**
 * 注册新的转换函数
 * @param {string} sourceFormat - 源格式
 * @param {string} targetFormat - 目标格式
 * @param {object} transform - 转换函数对象 { request, response, stream? }
 */
function registerTransform(sourceFormat, targetFormat, transform) {
  const key = `${sourceFormat}->${targetFormat}`;
  transforms[key] = transform;
}

/**
 * 检查是否有可用的转换
 * @param {string} sourceFormat - 源格式
 * @param {string} targetFormat - 目标格式
 * @returns {boolean}
 */
function hasTransform(sourceFormat, targetFormat) {
  const key = `${sourceFormat}->${targetFormat}`;
  return !!transforms[key];
}

/**
 * 获取所有已注册的转换
 * @returns {string[]} 转换键列表
 */
function getRegisteredTransforms() {
  return Object.keys(transforms);
}

/**
 * 检测响应格式
 * @param {object} body - 响应体
 * @returns {string} 格式类型
 */
function detectResponseFormat(body) {
  if (!body) return 'unknown';

  // Gemini 格式
  if (body.candidates || body.promptFeedback || body.usageMetadata) {
    return 'gemini';
  }

  // OpenAI Responses API 格式
  if (body.output && Array.isArray(body.output)) {
    return 'responses';
  }

  // OpenAI Chat Completions 格式
  if (body.choices && Array.isArray(body.choices)) {
    return 'openai';
  }

  // Anthropic 格式
  if (body.type === 'message' || body.content || body.stop_reason) {
    return 'anthropic';
  }

  return 'unknown';
}

module.exports = {
  getTransform,
  registerTransform,
  hasTransform,
  getRegisteredTransforms,
  detectResponseFormat
};
