'use strict';

const Logger = require('../logger');

/** 吞图：启用后不把客户端图片转发给上游，并在 message 中注入提示 */
const SWALLOW_IMAGE_NOTICE = '**⚠️ 您已启用吞图，您本次提交的图片不会转发给上游供应商。**';
const SWALLOW_IMAGE_PART_TYPES = new Set(['image', 'image_url', 'input_image']);
const CONTENT_TYPES = new Set(['text', 'image', 'audio', 'video', 'document']);

function isImageMime(mime) {
  return /^image\//i.test(String(mime || ''));
}

function isSwallowImagePart(part) {
  if (!part || typeof part !== 'object') return false;
  if (SWALLOW_IMAGE_PART_TYPES.has(part.type)) return true;
  if (part.type === 'media' && isImageMime(part.mimeType)) return true;
  if (part.type === 'file') {
    return isImageMime(part.file?.mime_type || part.file?.mimeType);
  }
  if (part.type === 'input_file') return isImageMime(part.mime_type);
  if (part.inlineData) return isImageMime(part.inlineData.mimeType);
  if (part.fileData) return isImageMime(part.fileData.mimeType);
  return false;
}

function makeSwallowTextPart(style = 'openai') {
  if (style === 'responses') return { type: 'input_text', text: SWALLOW_IMAGE_NOTICE };
  // openai / anthropic / gemini / interactions 均使用 type:text 或 text 字段
  return { type: 'text', text: SWALLOW_IMAGE_NOTICE };
}

/**
 * 从 content 中移除图片块。
 * @param {string|Array|*} content
 * @param {'openai'|'anthropic'|'responses'|'gemini'|'interactions'} style
 * @returns {{ content: any, stripped: boolean }}
 */
function stripImagesFromContent(content, style = 'openai') {
  if (content == null) return { content, stripped: false };
  if (typeof content === 'string') return { content, stripped: false };
  if (!Array.isArray(content)) return { content, stripped: false };

  let stripped = false;
  const kept = [];
  for (const part of content) {
    if (isSwallowImagePart(part)) {
      stripped = true;
      continue;
    }
    // tool_result / function_call_output 内嵌 content 也可能含图
    if (part && typeof part === 'object') {
      if (part.type === 'tool_result' && Array.isArray(part.content)) {
        const nested = stripImagesFromContent(part.content, style);
        if (nested.stripped) {
          stripped = true;
          kept.push({ ...part, content: nested.content });
          continue;
        }
      }
      if ((part.type === 'function_call_output' || part.type === 'custom_tool_call_output')
        && Array.isArray(part.output)) {
        const nested = stripImagesFromContent(part.output, style);
        if (nested.stripped) {
          stripped = true;
          kept.push({ ...part, output: nested.content });
          continue;
        }
      }
    }
    kept.push(part);
  }

  if (!stripped) return { content, stripped: false };

  // 若清空后无任何块，保留空数组由上层注入提示
  if (kept.length === 0) return { content: [], stripped: true };
  if (kept.length === 1 && kept[0].type === 'text' && style !== 'responses') {
    return { content: kept[0].text || '', stripped: true };
  }
  if (kept.length === 1 && (kept[0].type === 'input_text' || kept[0].type === 'text') && style === 'responses') {
    // Responses 用户消息通常保持数组结构
    return { content: kept, stripped: true };
  }
  return { content: kept, stripped: true };
}

function injectSwallowNoticeIntoMessage(msg, style = 'openai') {
  if (!msg || typeof msg !== 'object') return msg;
  const content = msg.content;
  if (content == null || content === '' || (Array.isArray(content) && content.length === 0)) {
    return { ...msg, content: style === 'responses' ? [makeSwallowTextPart('responses')] : SWALLOW_IMAGE_NOTICE };
  }
  if (typeof content === 'string') {
    if (content.includes(SWALLOW_IMAGE_NOTICE)) return msg;
    return { ...msg, content: `${content}\n\n${SWALLOW_IMAGE_NOTICE}` };
  }
  if (Array.isArray(content)) {
    const already = content.some(p => p && p.text === SWALLOW_IMAGE_NOTICE);
    if (already) return msg;
    return { ...msg, content: [...content, makeSwallowTextPart(style)] };
  }
  return { ...msg, content: SWALLOW_IMAGE_NOTICE };
}

/**
 * 从 Chat / Anthropic messages 中剥离图片并注入提示。
 * @returns {{ messages: Array, strippedCount: number }}
 */
function applySwallowImagesToMessages(messages, style = 'openai') {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, strippedCount: 0 };
  }

  let strippedCount = 0;
  let injectIdx = -1;
  const result = messages.map((msg, idx) => {
    if (!msg || typeof msg !== 'object') return msg;
    const { content, stripped } = stripImagesFromContent(msg.content, style);
    if (!stripped) return msg;
    strippedCount += 1;
    // 优先注入到最近一条 user 消息；否则注入到最后一条被剥离的消息
    if (msg.role === 'user' || injectIdx < 0) injectIdx = idx;
    return { ...msg, content };
  });

  if (strippedCount > 0 && injectIdx >= 0) {
    result[injectIdx] = injectSwallowNoticeIntoMessage(result[injectIdx], style);
  }

  return { messages: result, strippedCount };
}

/**
 * 从 Responses API input 中剥离图片并注入提示。
 * 同时覆盖 function_call_output / custom_tool_call_output 内的图片。
 * @returns {{ input: any, strippedCount: number }}
 */
function applySwallowImagesToResponsesInput(input) {
  if (input == null) return { input, strippedCount: 0 };
  if (typeof input === 'string') return { input, strippedCount: 0 };
  if (!Array.isArray(input)) return { input, strippedCount: 0 };

  let strippedCount = 0;
  let injectIdx = -1;
  const result = [];

  for (let idx = 0; idx < input.length; idx++) {
    const item = input[idx];
    if (!item || typeof item !== 'object') {
      result.push(item);
      continue;
    }

    if (isSwallowImagePart(item)) {
      strippedCount += 1;
      injectIdx = result.length;
      continue;
    }

    if ((item.type === 'function_call_output' || item.type === 'custom_tool_call_output')
      && Array.isArray(item.output)) {
      const { content, stripped } = stripImagesFromContent(item.output, 'responses');
      if (stripped) {
        strippedCount += 1;
        result.push({ ...item, output: content });
        continue;
      }
    }

    if (Array.isArray(item.content)) {
      const { content, stripped } = stripImagesFromContent(item.content, 'responses');
      if (stripped) {
        strippedCount += 1;
        const role = item.role || (item.type === 'message' ? 'user' : undefined);
        result.push({ ...item, content });
        if (role === 'user' || injectIdx < 0) injectIdx = result.length - 1;
        continue;
      }
    }

    result.push(item);
  }

  if (strippedCount > 0) {
    let target = injectIdx;
    if (target < 0) {
      for (let i = result.length - 1; i >= 0; i -= 1) {
        const candidate = result[i];
        if (candidate && (candidate.role === 'user' || (candidate.type === 'message' && candidate.role === 'user'))) {
          target = i;
          break;
        }
      }
    }
    if (target >= 0 && target < result.length) {
      result[target] = injectSwallowNoticeIntoMessage(result[target], 'responses');
    } else {
      result.push({
        type: 'message',
        role: 'user',
        content: [makeSwallowTextPart('responses')]
      });
    }
  }

  return { input: result, strippedCount };
}

/** 从 Gemini contents[].parts[] 中剥离图片，并向受影响的内容注入提示。 */
function applySwallowImagesToGeminiBody(body) {
  if (!Array.isArray(body?.contents)) return 0;
  let strippedCount = 0;
  let injectTarget = null;

  for (const content of body.contents) {
    if (!content || !Array.isArray(content.parts)) continue;
    const kept = [];
    for (const part of content.parts) {
      if (isSwallowImagePart(part)) {
        strippedCount += 1;
        continue;
      }
      kept.push(part);
    }
    if (kept.length !== content.parts.length) {
      content.parts = kept;
      if (!injectTarget) injectTarget = content;
    }
  }

  if (strippedCount > 0 && injectTarget) {
    const already = injectTarget.parts.some(part => part && part.text === SWALLOW_IMAGE_NOTICE);
    if (!already) injectTarget.parts.push({ text: SWALLOW_IMAGE_NOTICE });
  }
  return strippedCount;
}

/** 递归剥离 Interactions input 中的图片。 */
function stripImagesDeep(value) {
  if (Array.isArray(value)) {
    let stripped = false;
    const kept = [];
    for (const item of value) {
      if (isSwallowImagePart(item)) {
        stripped = true;
        continue;
      }
      const nested = stripImagesDeep(item);
      if (nested.stripped) stripped = true;
      if (nested.value !== null) kept.push(nested.value);
    }
    return { value: kept, stripped };
  }
  if (!value || typeof value !== 'object') return { value, stripped: false };

  let stripped = false;
  const result = { ...value };
  for (const key of ['content', 'result', 'output', 'parts']) {
    if (Array.isArray(result[key])) {
      const nested = stripImagesDeep(result[key]);
      if (nested.stripped) {
        result[key] = nested.value;
        stripped = true;
      }
    }
  }
  return { value: result, stripped };
}

/** 从 Interactions input 中剥离图片，并追加一条提示内容。 */
function applySwallowImagesToInteractionsBody(body) {
  if (!body || body.input === undefined || body.input === null) return 0;
  const stripped = stripImagesDeep(body.input);
  if (!stripped.stripped) return 0;
  body.input = stripped.value;

  if (typeof body.input === 'string') {
    body.input = `${body.input}\n\n${SWALLOW_IMAGE_NOTICE}`;
  } else if (Array.isArray(body.input)) {
    const allContent = body.input.length > 0
      && body.input.every(item => item && typeof item === 'object' && CONTENT_TYPES.has(item.type));
    if (allContent) {
      body.input.push({ type: 'text', text: SWALLOW_IMAGE_NOTICE });
    } else {
      body.input.push({
        type: 'user_input',
        content: [{ type: 'text', text: SWALLOW_IMAGE_NOTICE }]
      });
    }
  } else if (typeof body.input === 'object') {
    body.input = [body.input, { type: 'text', text: SWALLOW_IMAGE_NOTICE }];
  }
  return 1;
}

function isAnthropicApiPath(req) {
  const p = (req.path || req.url || '').split('?')[0];
  return p === '/messages' || p.endsWith('/messages');
}

/**
 * 若 API Key 启用吞图，则改写请求体中的图片相关字段。
 * 返回是否实际剥离了图片。
 */
function applySwallowImagesIfEnabled(req) {
  if (!req?.apiUser?.swallowImages) return false;

  let totalStripped = 0;

  if (Array.isArray(req.body?.messages)) {
    const style = isAnthropicApiPath(req) ? 'anthropic' : 'openai';
    const { messages, strippedCount } = applySwallowImagesToMessages(req.body.messages, style);
    if (strippedCount > 0) {
      req.body.messages = messages;
      totalStripped += strippedCount;
    }
  }

  if (req.body?.input != null) {
    const { input, strippedCount } = applySwallowImagesToResponsesInput(req.body.input);
    if (strippedCount > 0) {
      req.body.input = input;
      totalStripped += strippedCount;
    }
  }

  // Anthropic system 也可能是含图的 content 数组（极少见）
  if (Array.isArray(req.body?.system)) {
    const { content, stripped } = stripImagesFromContent(req.body.system, 'anthropic');
    if (stripped) {
      req.body.system = Array.isArray(content) && content.length === 0 ? '' : content;
      totalStripped += 1;
    }
  }

  if (Array.isArray(req.body?.contents)) {
    totalStripped += applySwallowImagesToGeminiBody(req.body);
  }

  if (totalStripped > 0) {
    Logger.info(`[吞图] 已剥离图片: key=${req.apiUser.keyName || req.apiUser.keyId}, messages/parts=${totalStripped}, path=${req.path}`);
  }
  return totalStripped > 0;
}

module.exports = {
  SWALLOW_IMAGE_NOTICE,
  isSwallowImagePart,
  stripImagesFromContent,
  applySwallowImagesToMessages,
  applySwallowImagesToResponsesInput,
  applySwallowImagesToGeminiBody,
  applySwallowImagesToInteractionsBody,
  applySwallowImagesIfEnabled
};
