/**
 * OpenAI Chat Completions 响应归一化
 *
 * 严格客户端（如 Grok Build / Rust serde）要求 chat.completion 与
 * chat.completion.chunk 顶层必须包含 id、object、created、model。
 * 上游透传或 Fusion 本地发射时可能缺少这些字段，在此统一补全。
 */

const Logger = require('../logger');

/**
 * 生成 chat completion id
 * @param {string} [prefix='chatcmpl']
 * @returns {string}
 */
function genChatCompletionId(prefix = 'chatcmpl') {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 是否为 OpenAI 风格错误体（不应改写成 completion envelope）
 * @param {object} data
 * @returns {boolean}
 */
function isErrorBody(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.error && typeof data.error === 'object') return true;
  if (data.type === 'error' && data.error) return true;
  return false;
}

/**
 * 是否看起来像 chat.completion / chat.completion.chunk 响应
 * @param {object} data
 * @returns {boolean}
 */
function looksLikeChatCompletion(data) {
  if (!data || typeof data !== 'object' || isErrorBody(data)) return false;
  // 有 choices 数组，或 object 字段已标明为 chat.completion*
  if (Array.isArray(data.choices)) return true;
  if (typeof data.object === 'string' && data.object.startsWith('chat.completion')) return true;
  return false;
}

/**
 * 非流式：确保 data 含 id / object / created / model
 * @param {object} data - 上游响应
 * @param {{ model?: string, fallbackId?: string, logPrefix?: string }} [opts]
 * @returns {object}
 */
function ensureChatCompletionResponse(data, opts = {}) {
  if (!looksLikeChatCompletion(data)) return data;

  const model = opts.model || data.model || 'unknown';
  const fallbackId = opts.fallbackId || genChatCompletionId();
  const logPrefix = opts.logPrefix || 'OpenAINormalize';
  let patched = false;

  if (data.id == null || data.id === '') {
    data.id = fallbackId;
    patched = true;
  }
  if (!data.object) {
    data.object = 'chat.completion';
    patched = true;
  }
  if (data.created == null) {
    data.created = Math.floor(Date.now() / 1000);
    patched = true;
  }
  if (!data.model) {
    data.model = model;
    patched = true;
  }

  if (patched) {
    Logger.info(`[${logPrefix}] 非流式响应已补全标准字段: id=${data.id}, object=${data.object}, model=${data.model}`);
  }

  return data;
}

/**
 * 流式 chunk：确保 id / object / created / model；choices 项补 finish_reason 默认 null
 * @param {object} parsed - 已解析的 SSE data JSON
 * @param {{ id?: string, created?: number, model?: string, logPrefix?: string, logOnceRef?: { logged?: boolean } }} [opts]
 * @returns {object}
 */
function ensureChatCompletionChunk(parsed, opts = {}) {
  if (!looksLikeChatCompletion(parsed)) return parsed;

  const id = opts.id || genChatCompletionId();
  const created = opts.created != null ? opts.created : Math.floor(Date.now() / 1000);
  const model = opts.model || parsed.model || 'unknown';
  const logPrefix = opts.logPrefix || 'OpenAINormalize';
  let patched = false;
  const missingBefore = [];

  if (parsed.id == null || parsed.id === '') {
    missingBefore.push('id');
    parsed.id = id;
    patched = true;
  }
  if (!parsed.object) {
    missingBefore.push('object');
    parsed.object = 'chat.completion.chunk';
    patched = true;
  }
  if (parsed.created == null) {
    missingBefore.push('created');
    parsed.created = created;
    patched = true;
  }
  if (!parsed.model) {
    missingBefore.push('model');
    parsed.model = model;
    patched = true;
  }

  if (Array.isArray(parsed.choices)) {
    for (const choice of parsed.choices) {
      if (choice && typeof choice === 'object' && !('finish_reason' in choice)) {
        choice.finish_reason = null;
        patched = true;
      }
      if (choice && typeof choice === 'object' && choice.index == null) {
        choice.index = 0;
        patched = true;
      }
    }
  }

  // 仅首次补全时打日志，避免流式刷屏
  if (patched && missingBefore.length > 0) {
    const ref = opts.logOnceRef;
    if (!ref || !ref.logged) {
      if (ref) ref.logged = true;
      Logger.info(`[${logPrefix}] 流式 chunk 已补全字段: missing=[${missingBefore.join(',')}], id=${parsed.id}, model=${parsed.model}`);
    }
  }

  return parsed;
}

/**
 * 构造完整 chat.completion.chunk（Fusion / 签名等本地发射）
 * @param {{ id: string, created?: number, model?: string, delta?: object, index?: number, finish_reason?: string|null, usage?: object, choices?: array }} opts
 * @returns {object}
 */
function buildChatCompletionChunk(opts = {}) {
  const {
    id,
    created = Math.floor(Date.now() / 1000),
    model = 'unknown',
    delta,
    index = 0,
    finish_reason = null,
    usage,
    choices
  } = opts;

  const chunk = {
    id: id || genChatCompletionId(),
    object: 'chat.completion.chunk',
    created,
    model,
    choices: choices != null
      ? choices
      : [{
          index,
          delta: delta != null ? delta : {},
          finish_reason
        }]
  };

  if (usage) {
    chunk.usage = usage;
  }

  return chunk;
}

/**
 * 在 res 上挂载/复用流式 envelope（Fusion 状态消息与合成共用同一 id）
 * @param {object} res - Express response
 * @param {{ model?: string, prefix?: string }} [opts]
 * @returns {{ id: string, created: number, model: string }}
 */
function getOrCreateStreamMeta(res, opts = {}) {
  if (res && res._crewRouterStreamMeta) {
    return res._crewRouterStreamMeta;
  }
  const meta = {
    id: genChatCompletionId(opts.prefix || 'chatcmpl'),
    created: Math.floor(Date.now() / 1000),
    model: opts.model || 'unknown'
  };
  if (res) {
    res._crewRouterStreamMeta = meta;
  }
  return meta;
}

module.exports = {
  genChatCompletionId,
  isErrorBody,
  looksLikeChatCompletion,
  ensureChatCompletionResponse,
  ensureChatCompletionChunk,
  buildChatCompletionChunk,
  getOrCreateStreamMeta
};
