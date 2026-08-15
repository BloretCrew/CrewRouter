/**
 * OpenAI → Anthropic 格式转换
 *
 * 将 OpenAI Chat Completions 格式转换为 Anthropic Messages API 格式
 * 支持: system/developer、tool、tool_calls、image_url（base64/url）、thinking
 */

function safeParseJson(str, fallback = {}) {
  if (str == null || str === '') return fallback;
  if (typeof str !== 'string') return str;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function convertImageUrlPart(part) {
  const url = typeof part.image_url === 'string'
    ? part.image_url
    : (part.image_url?.url || '');
  if (!url) return null;
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/s);
    if (match) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: match[1] || 'image/jpeg',
          data: match[2]
        }
      };
    }
    return null;
  }
  return {
    type: 'image',
    source: { type: 'url', url }
  };
}

/**
 * 转换请求体
 * @param {object} body - OpenAI 格式的请求体
 * @returns {object} Anthropic 格式的请求体
 */
function transformRequest(body) {
  const messages = [];
  const systemParts = [];

  for (const msg of body.messages || []) {
    const role = msg.role === 'developer' ? 'system' : msg.role;

    if (role === 'system') {
      if (typeof msg.content === 'string') systemParts.push(msg.content);
      else if (Array.isArray(msg.content)) {
        systemParts.push(msg.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n'));
      }
      continue;
    }

    if (role === 'tool') {
      const toolContent = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(c => (typeof c === 'string' ? c : (c.text || ''))).join('\n')
          : String(msg.content || '');
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: toolContent
        }]
      });
      continue;
    }

    if (role === 'assistant' && msg.tool_calls) {
      const content = [];
      if (msg.reasoning_content) {
        content.push({ type: 'thinking', thinking: msg.reasoning_content });
      }
      if (msg.content) {
        if (typeof msg.content === 'string') {
          content.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') content.push({ type: 'text', text: part.text || '' });
          }
        }
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || '',
          input: typeof tc.function?.arguments === 'string'
            ? safeParseJson(tc.function.arguments, {})
            : (tc.function?.arguments || {})
        });
      }
      messages.push({ role: 'assistant', content });
      continue;
    }

    if (typeof msg.content === 'string') {
      messages.push({ role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const content = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text || '' });
        } else if (part.type === 'image_url') {
          const img = convertImageUrlPart(part);
          if (img) content.push(img);
        } else if (part.type === 'image' || part.type === 'tool_use' || part.type === 'tool_result') {
          content.push(part);
        }
      }
      messages.push({
        role,
        content: content.length === 1 && content[0].type === 'text' ? content[0].text : content
      });
    } else {
      messages.push({ role, content: msg.content ?? '' });
    }
  }

  const result = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096
  };

  if (systemParts.length > 0) {
    result.system = systemParts.join('\n');
  }

  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.stream !== undefined) result.stream = body.stream;

  if (body.tools) {
    result.tools = body.tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      input_schema: t.function?.parameters || t.parameters || t.input_schema || { type: 'object', properties: {} }
    }));
  }

  if (body.tool_choice) {
    if (body.tool_choice === 'auto') result.tool_choice = { type: 'auto' };
    else if (body.tool_choice === 'required') result.tool_choice = { type: 'any' };
    else if (body.tool_choice === 'none') result.tool_choice = { type: 'none' };
    else if (body.tool_choice?.type === 'function') {
      result.tool_choice = {
        type: 'tool',
        name: body.tool_choice.function?.name
      };
    }
  }

  return result;
}

/**
 * 转换响应体
 * @param {object} body - Anthropic 格式的响应体
 * @returns {object} OpenAI 格式的响应体
 */
function transformResponse(body) {
  const content = body.content || [];
  let textContent = '';
  let reasoningContent = '';
  let toolCalls = null;

  for (const block of content) {
    if (block.type === 'text') {
      textContent += block.text || '';
    } else if (block.type === 'thinking') {
      reasoningContent += block.thinking || '';
    } else if (block.type === 'tool_use') {
      if (!toolCalls) toolCalls = [];
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {})
        }
      });
    }
  }

  let finishReason = 'stop';
  if (body.stop_reason === 'end_turn') finishReason = 'stop';
  else if (body.stop_reason === 'max_tokens') finishReason = 'length';
  else if (body.stop_reason === 'tool_use') finishReason = 'tool_calls';
  else if (body.stop_reason === 'stop_sequence') finishReason = 'stop';

  const message = {
    role: 'assistant',
    content: toolCalls && !textContent ? null : (textContent || null)
  };

  if (toolCalls) {
    message.tool_calls = toolCalls;
  }
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  const cachedTokens = body.usage?.cache_read_input_tokens || 0;
  const promptTokens = (body.usage?.input_tokens || 0)
    + cachedTokens
    + (body.usage?.cache_creation_input_tokens || 0);

  return {
    id: body.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason
    }],
    usage: {
      prompt_tokens: promptTokens || (body.usage?.input_tokens || 0),
      completion_tokens: body.usage?.output_tokens || 0,
      total_tokens: (promptTokens || body.usage?.input_tokens || 0) + (body.usage?.output_tokens || 0),
      ...(cachedTokens ? {
        prompt_tokens_details: { cached_tokens: cachedTokens }
      } : {})
    }
  };
}

/**
 * 为 transform 流式 chunk 补全 OpenAI 标准顶层字段
 * 调用方可传入 streamMeta 以保持同一流内 id/created 一致
 * @param {object|null} chunk
 * @param {{ id?: string, created?: number, model?: string }} [streamMeta]
 * @returns {object|null}
 */
function withChunkEnvelope(chunk, streamMeta = {}) {
  if (!chunk) return null;
  const id = streamMeta.id || `chatcmpl-${Date.now().toString(36)}`;
  const created = streamMeta.created != null ? streamMeta.created : Math.floor(Date.now() / 1000);
  const model = streamMeta.model || chunk.model || 'unknown';
  return {
    ...chunk,
    id: chunk.id || id,
    object: 'chat.completion.chunk',
    created: chunk.created != null ? chunk.created : created,
    model: chunk.model || model
  };
}

/**
 * 转换流式响应块
 * @param {object} event - Anthropic 格式的流式事件
 * @param {{ id?: string, created?: number, model?: string }} [streamMeta] - 可选，补全 chunk envelope
 * @returns {object|null} OpenAI 格式的流式响应块（含 id/object/created/model）
 */
function transformStreamChunk(event, streamMeta) {
  let chunk = null;
  switch (event.type) {
    case 'message_start':
      chunk = {
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null
        }]
      };
      break;

    case 'content_block_start': {
      if (event.content_block?.type === 'tool_use') {
        chunk = {
          choices: [{
            delta: {
              tool_calls: [{
                index: event.index || 0,
                id: event.content_block.id,
                type: 'function',
                function: {
                  name: event.content_block.name,
                  arguments: ''
                }
              }]
            },
            index: 0,
            finish_reason: null
          }]
        };
      }
      break;
    }

    case 'content_block_delta': {
      const delta = {};
      if (event.delta?.type === 'text_delta') {
        delta.content = event.delta.text;
      } else if (event.delta?.type === 'thinking_delta') {
        delta.reasoning_content = event.delta.thinking;
      } else if (event.delta?.type === 'input_json_delta') {
        delta.tool_calls = [{
          index: event.index || 0,
          function: {
            arguments: event.delta.partial_json || ''
          }
        }];
      }
      if (Object.keys(delta).length === 0) break;
      chunk = {
        choices: [{ delta, index: 0, finish_reason: null }]
      };
      break;
    }

    case 'message_delta': {
      let finishReason = 'stop';
      if (event.delta?.stop_reason === 'end_turn') finishReason = 'stop';
      else if (event.delta?.stop_reason === 'max_tokens') finishReason = 'length';
      else if (event.delta?.stop_reason === 'tool_use') finishReason = 'tool_calls';
      else if (event.delta?.stop_reason === 'stop_sequence') finishReason = 'stop';

      chunk = {
        choices: [{
          delta: {},
          finish_reason: finishReason,
          index: 0
        }],
        usage: event.usage ? {
          completion_tokens: event.usage.output_tokens || 0
        } : (event.delta?.usage ? {
          completion_tokens: event.delta.usage.output_tokens || 0
        } : undefined)
      };
      break;
    }

    case 'message_stop':
    default:
      break;
  }
  return withChunkEnvelope(chunk, streamMeta);
}

module.exports = {
  request: transformRequest,
  response: transformResponse,
  stream: transformStreamChunk
};
