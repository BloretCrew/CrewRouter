/**
 * Anthropic → OpenAI 格式转换
 *
 * 将 Anthropic Messages API 格式转换为 OpenAI Chat Completions 格式
 * 支持: system、text、image、tool_use、tool_result、thinking
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

/**
 * 转换请求体
 * @param {object} body - Anthropic 格式的请求体
 * @returns {object} OpenAI 格式的请求体
 */
function transformRequest(body) {
  const messages = [];

  // 转换系统消息
  if (body.system) {
    const sysContent = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(b => b.text || '').join('\n')
        : '';
    if (sysContent) {
      messages.push({ role: 'system', content: sysContent });
    }
  }

  // 转换消息（支持 tool_use / tool_result / image / thinking）
  for (const msg of body.messages || []) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      messages.push({ role: msg.role, content: msg.content ?? '' });
      continue;
    }

    const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text || '');
    const toolUseParts = msg.content.filter(b => b.type === 'tool_use');
    const toolResultParts = msg.content.filter(b => b.type === 'tool_result');
    const imageParts = msg.content.filter(b => b.type === 'image');
    const thinkingParts = msg.content.filter(b => b.type === 'thinking');

    if (toolUseParts.length > 0 && msg.role === 'assistant') {
      const text = textParts.join('\n');
      const toolCalls = toolUseParts.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input || {})
        }
      }));
      const openaiMsg = {
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls
      };
      if (thinkingParts.length > 0) {
        openaiMsg.reasoning_content = thinkingParts.map(t => t.thinking || '').join('');
      }
      messages.push(openaiMsg);
    } else if (toolResultParts.length > 0) {
      for (const tr of toolResultParts) {
        const trContent = typeof tr.content === 'string'
          ? tr.content
          : Array.isArray(tr.content)
            ? tr.content.map(c => (typeof c === 'string' ? c : (c.text || ''))).join('\n')
            : String(tr.content || '');
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: trContent
        });
      }
    } else if (imageParts.length > 0) {
      const content = [];
      for (const part of msg.content) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text || '' });
        } else if (part.type === 'image') {
          if (part.source?.type === 'base64') {
            content.push({
              type: 'image_url',
              image_url: {
                url: `data:${part.source.media_type || 'image/jpeg'};base64,${part.source.data}`
              }
            });
          } else if (part.source?.type === 'url') {
            content.push({ type: 'image_url', image_url: { url: part.source.url } });
          }
        }
      }
      messages.push({ role: msg.role, content });
    } else {
      const openaiMsg = { role: msg.role, content: textParts.join('\n') };
      if (thinkingParts.length > 0 && msg.role === 'assistant') {
        openaiMsg.reasoning_content = thinkingParts.map(t => t.thinking || '').join('');
      }
      messages.push(openaiMsg);
    }
  }

  const result = {
    model: body.model,
    messages
  };

  // 可选参数
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop_sequences) result.stop = body.stop_sequences;
  if (body.stream !== undefined) result.stream = body.stream;

  // 转换工具
  if (body.tools) {
    result.tools = body.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema || { type: 'object', properties: {} }
      }
    }));
  }

  // 转换工具选择
  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') result.tool_choice = 'auto';
    else if (body.tool_choice.type === 'any') result.tool_choice = 'required';
    else if (body.tool_choice.type === 'tool') {
      result.tool_choice = {
        type: 'function',
        function: { name: body.tool_choice.name }
      };
    } else if (body.tool_choice.type === 'none') result.tool_choice = 'none';
  }

  return result;
}

/**
 * 转换响应体
 * @param {object} body - OpenAI 格式的响应体
 * @returns {object} Anthropic 格式的响应体
 */
function transformResponse(body) {
  const choice = body.choices?.[0];
  const message = choice?.message;

  const content = [];
  if (message?.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content });
  }
  if (message?.content) {
    content.push({ type: 'text', text: message.content });
  }
  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
        input: safeParseJson(tc.function?.arguments, {})
      });
    }
  }

  let stopReason = 'end_turn';
  if (choice?.finish_reason === 'stop') stopReason = 'end_turn';
  else if (choice?.finish_reason === 'length') stopReason = 'max_tokens';
  else if (choice?.finish_reason === 'tool_calls') stopReason = 'tool_use';

  return {
    id: body.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: body.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens || 0,
      output_tokens: body.usage?.completion_tokens || 0,
      cache_read_input_tokens: body.usage?.prompt_tokens_details?.cached_tokens
        || body.usage?.cached_tokens || 0,
      cache_creation_input_tokens: 0
    }
  };
}

/**
 * 转换流式响应块
 * @param {object} chunk - OpenAI 格式的流式响应块
 * @returns {object} Anthropic 格式的流式事件
 */
function transformStreamChunk(chunk) {
  // 处理 usage 信息
  if (chunk.usage && !chunk.choices?.length) {
    return {
      type: 'message_delta',
      delta: {
        stop_reason: null,
        stop_sequence: null
      },
      usage: {
        output_tokens: chunk.usage.completion_tokens || 0
      }
    };
  }

  const delta = chunk.choices?.[0]?.delta;
  const finishReason = chunk.choices?.[0]?.finish_reason;

  if (delta?.content) {
    return {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: delta.content
      }
    };
  }

  if (delta?.reasoning_content) {
    return {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'thinking_delta',
        thinking: delta.reasoning_content
      }
    };
  }

  if (delta?.tool_calls) {
    const tc = delta.tool_calls[0];
    // 首包带 name/id 时返回 content_block_start 语义由调用方处理；这里返回 input_json_delta
    if (tc?.function?.name || tc?.id) {
      return {
        type: 'content_block_start',
        index: tc.index || 0,
        content_block: {
          type: 'tool_use',
          id: tc.id || '',
          name: tc.function?.name || '',
          input: {}
        }
      };
    }
    return {
      type: 'content_block_delta',
      index: tc?.index || 0,
      delta: {
        type: 'input_json_delta',
        partial_json: tc?.function?.arguments || ''
      }
    };
  }

  // 仅 finish_reason
  if (finishReason) {
    let stopReason = 'end_turn';
    if (finishReason === 'length') stopReason = 'max_tokens';
    else if (finishReason === 'tool_calls') stopReason = 'tool_use';
    return {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null
      },
      usage: chunk.usage ? {
        output_tokens: chunk.usage.completion_tokens || 0
      } : undefined
    };
  }

  return null;
}

module.exports = {
  request: transformRequest,
  response: transformResponse,
  stream: transformStreamChunk
};
