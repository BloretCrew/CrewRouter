'use strict';

const {
  omitKnown, withPassthrough, safeParseJson,
  DEFAULT_IMAGE_MIME, toDataUri, imageSourceToOpenAI
} = require('./helpers');

const REQUEST_KEYS = new Set(['model', 'messages', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k', 'stop', 'stream', 'stream_options', 'tools', 'tool_choice', 'reasoning_effort', 'n', 'seed', 'frequency_penalty', 'presence_penalty', 'response_format']);
const MESSAGE_KEYS = new Set(['role', 'content', 'name', 'tool_call_id', 'tool_calls', 'reasoning_content']);
const RESPONSE_KEYS = new Set(['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']);
const CHUNK_KEYS = new Set(['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']);

function decodeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: 'raw', value: content }];
  return content.map(part => {
    if (part?.type === 'text') return { type: 'text', text: part.text || '', cacheControl: part.cache_control, passthrough: { openai: omitKnown(part, new Set(['type', 'text', 'cache_control'])) } };
    if (part?.type === 'image_url') return { type: 'image', source: part.image_url, cacheControl: part.cache_control, passthrough: { openai: omitKnown(part, new Set(['type', 'image_url', 'cache_control'])) } };
    if (part?.type === 'input_audio') {
      const format = part.input_audio?.format || 'wav';
      return {
        type: 'media', mediaType: 'audio',
        mimeType: `audio/${format === 'mp3' ? 'mpeg' : format}`,
        data: part.input_audio?.data || '',
        passthrough: { openai: omitKnown(part, new Set(['type', 'input_audio'])) }
      };
    }
    if (part?.type === 'file') {
      return {
        type: 'media', mediaType: 'document',
        mimeType: part.file?.mime_type || part.file?.mimeType || 'application/octet-stream',
        fileId: part.file?.file_id || part.file?.fileId,
        fileData: part.file?.file_data || part.file?.fileData,
        filename: part.file?.filename,
        passthrough: { openai: omitKnown(part, new Set(['type', 'file'])) }
      };
    }
    return { type: 'raw', value: part };
  });
}

function encodeContent(blocks, dialect) {
  const content = [];
  for (const block of blocks || []) {
    if (block.type === 'text') content.push(withPassthrough({ type: 'text', text: block.text || '', ...(block.cacheControl !== undefined ? { cache_control: block.cacheControl } : {}) }, block.passthrough?.[dialect]));
    else if (block.type === 'image') {
      const imageUrl = imageSourceToOpenAI(block.source);
      if (imageUrl != null) {
        content.push(withPassthrough({
          type: 'image_url',
          image_url: imageUrl,
          ...(block.cacheControl !== undefined ? { cache_control: block.cacheControl } : {})
        }, block.passthrough?.[dialect]));
      }
    }
    else if (block.type === 'media') {
      if (block.mediaType === 'image') {
        const url = block.fileUri || block.url || block.uri
          || (block.data ? toDataUri(block.mimeType || DEFAULT_IMAGE_MIME, block.data) : '');
        if (url) content.push(withPassthrough({ type: 'image_url', image_url: { url } }, block.passthrough?.openai));
      } else if (block.mediaType === 'audio' && block.data) {
        const format = /mpeg|mp3/i.test(block.mimeType || '') ? 'mp3' : String(block.mimeType || 'audio/wav').split('/').pop();
        content.push({ type: 'input_audio', input_audio: { data: block.data, format }, ...(block.passthrough?.openai || {}) });
      } else if (block.mediaType === 'document' && (block.fileId || block.fileData)) {
        content.push({
          type: 'file',
          file: {
            ...(block.fileId ? { file_id: block.fileId } : {}),
            ...(block.fileData ? { file_data: block.fileData } : {}),
            ...(block.filename ? { filename: block.filename } : {}),
            ...(block.mimeType ? { mime_type: block.mimeType } : {})
          },
          ...(block.passthrough?.openai || {})
        });
      }
    }
    else if (block.type === 'raw' && block.value !== undefined) content.push(block.value);
  }
  if (content.length === 0) return null;
  if (content.length === 1 && content[0].type === 'text' && Object.keys(content[0]).length === 2) return content[0].text;
  return content;
}

function decodeMessage(message) {
  const blocks = decodeContent(message.content);
  if (message.reasoning_content != null) blocks.unshift({ type: 'thinking', thinking: message.reasoning_content });
  for (const call of message.tool_calls || []) {
    blocks.push({
      type: 'tool_call',
      id: call.id,
      index: call.index,
      name: call.function?.name || '',
      input: safeParseJson(call.function?.arguments, {}),
      argumentsText: call.function?.arguments || '',
      passthrough: { openai: omitKnown(call, new Set(['id', 'type', 'function', 'index'])) }
    });
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      blocks: [{ type: 'tool_result', toolCallId: message.tool_call_id, name: message.name, content: blocks }],
      passthrough: { openai: omitKnown(message, MESSAGE_KEYS) }
    };
  }
  return { role: message.role, blocks, passthrough: { openai: omitKnown(message, MESSAGE_KEYS) } };
}

function encodeMessage(message) {
  const extra = message.passthrough?.openai;
  if (message.role === 'tool' || message.blocks?.some(block => block.type === 'tool_result')) {
    const result = message.blocks.find(block => block.type === 'tool_result');
    return withPassthrough({ role: 'tool', tool_call_id: result?.toolCallId, ...(result?.name ? { name: result.name } : {}), content: encodeContent(result?.content || [], 'openai') || '' }, extra);
  }
  const toolCalls = [];
  const contentBlocks = [];
  let reasoning;
  for (const block of message.blocks || []) {
    if (block.type === 'tool_call') {
      toolCalls.push(withPassthrough({ id: block.id, type: 'function', function: { name: block.name, arguments: block.argumentsText || JSON.stringify(block.input || {}) } }, block.passthrough?.openai));
    } else if (block.type === 'thinking') {
      // thinking 一律映射为 reasoning_content：DeepSeek/Kimi 等 OpenAI 兼容上游在带工具的
      // 思考会话里要求回传推理内容，缺失即 400（content[].thinking must be passed back）。
      // 签名只对 Anthropic 上游有意义，不能作为是否回传推理文本的判据；redacted_thinking
      // 无明文可回传，且 Anthropic 形状的块不能出现在 OpenAI 的 content 数组里，只能丢弃。
      if (!block.redacted) reasoning = (reasoning || '') + (block.thinking || '');
    } else contentBlocks.push(block);
  }
  const result = { role: message.role, content: encodeContent(contentBlocks, 'openai') };
  if (toolCalls.length) result.tool_calls = toolCalls;
  if (reasoning) result.reasoning_content = reasoning;
  return withPassthrough(result, extra);
}

function decodeTool(tool) {
  return {
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description,
    inputSchema: tool.function?.parameters || tool.parameters || {},
    cacheControl: tool.cache_control ?? tool.function?.cache_control,
    passthrough: { openai: omitKnown(tool, new Set(['type', 'function', 'name', 'description', 'parameters', 'cache_control'])) }
  };
}

function encodeTool(tool) {
  return withPassthrough({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema || {} }, ...(tool.cacheControl !== undefined ? { cache_control: tool.cacheControl } : {}) }, tool.passthrough?.openai);
}

function decodeRequest(body) {
  return {
    kind: 'request', sourceDialect: 'openai', model: body.model,
    messages: (body.messages || []).map(decodeMessage),
    tools: (body.tools || []).map(decodeTool), toolChoice: body.tool_choice,
    parameters: {
      maxTokens: body.max_completion_tokens ?? body.max_tokens,
      maxTokensField: body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens',
      temperature: body.temperature, topP: body.top_p, topK: body.top_k, stop: body.stop, stream: body.stream,
      streamUsage: body.stream_options?.include_usage, reasoningEffort: body.reasoning_effort,
      n: body.n, seed: body.seed, frequencyPenalty: body.frequency_penalty, presencePenalty: body.presence_penalty,
      responseFormat: body.response_format, responseMimeType: body.response_format ? 'application/json' : undefined
    },
    passthrough: { openai: omitKnown(body, REQUEST_KEYS) }
  };
}

/**
 * 把一条 IR 消息展开为 0..n 条 OpenAI 消息。
 * Anthropic 的一个 user 轮次可以并列多个 tool_result（并行工具调用），
 * 而 OpenAI 要求每个 tool_call 对应独立的 tool 消息；只取第一个会让上游
 * 收到缺失工具结果的历史。按原顺序逐个展开，其余内容作为后续 user 消息。
 */
function encodeMessages(message) {
  const results = (message.blocks || []).filter(block => block.type === 'tool_result');
  if (!results.length) return [encodeMessage(message)];
  const extra = message.passthrough?.openai;
  const encoded = results.map(result => withPassthrough({
    role: 'tool',
    tool_call_id: result.toolCallId,
    content: encodeContent(result.content || [], 'openai') || ''
  }, extra));
  const rest = message.blocks.filter(block => block.type !== 'tool_result');
  if (rest.length) encoded.push(encodeMessage({ ...message, blocks: rest }));
  return encoded;
}

function encodeRequest(ir) {
  const body = { model: ir.model, messages: (ir.messages || []).flatMap(encodeMessages) };
  const p = ir.parameters || {};
  if (p.maxTokens !== undefined) body[p.maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens'] = p.maxTokens;
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.topP !== undefined) body.top_p = p.topP;
  if (p.stop !== undefined) body.stop = p.stop;
  if (p.stream !== undefined) body.stream = p.stream;
  if (p.streamUsage !== undefined) body.stream_options = { include_usage: p.streamUsage };
  if (p.reasoningEffort !== undefined) body.reasoning_effort = p.reasoningEffort;
  if (p.n !== undefined) body.n = p.n;
  if (p.seed !== undefined) body.seed = p.seed;
  if (p.frequencyPenalty !== undefined) body.frequency_penalty = p.frequencyPenalty;
  if (p.presencePenalty !== undefined) body.presence_penalty = p.presencePenalty;
  if (p.responseFormat !== undefined) {
    body.response_format = p.responseFormat;
  } else if (p.responseSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'response', schema: p.responseSchema }
    };
  } else if (p.responseMimeType === 'application/json') {
    body.response_format = { type: 'json_object' };
  }
  if (ir.tools?.length) body.tools = ir.tools.map(encodeTool);
  if (ir.toolChoice !== undefined) body.tool_choice = ir.toolChoice;
  return withPassthrough(body, ir.passthrough?.openai);
}

function decodeUsage(usage) {
  if (!usage) return undefined;
  return { inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0, totalTokens: usage.total_tokens, cachedInputTokens: usage.prompt_tokens_details?.cached_tokens || usage.cached_tokens || 0, reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0, passthrough: { openai: omitKnown(usage, new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details', 'cached_tokens'])) } };
}

function encodeUsage(usage) {
  if (!usage) return undefined;
  const result = { prompt_tokens: usage.inputTokens || 0, completion_tokens: usage.outputTokens || 0, total_tokens: usage.totalTokens ?? ((usage.inputTokens || 0) + (usage.outputTokens || 0)) };
  if (usage.cachedInputTokens) result.prompt_tokens_details = { cached_tokens: usage.cachedInputTokens };
  if (usage.reasoningTokens) result.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  return withPassthrough(result, usage.passthrough?.openai);
}

function decodeResponse(body) {
  const choice = body.choices?.[0] || {};
  return { kind: 'response', sourceDialect: 'openai', id: body.id, model: body.model, message: choice.message ? decodeMessage(choice.message) : null, finishReason: ({ stop: 'stop', length: 'length', tool_calls: 'tool_calls' }[choice.finish_reason] || choice.finish_reason), usage: decodeUsage(body.usage), passthrough: { openai: omitKnown(body, RESPONSE_KEYS) } };
}

function encodeResponse(ir) {
  const body = { id: ir.id || `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: ir.model, choices: [{ index: 0, message: ir.message ? encodeMessage(ir.message) : { role: 'assistant', content: null }, finish_reason: ({ end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop' }[ir.finishReason] || ir.finishReason || 'stop') }] };
  if (ir.usage) body.usage = encodeUsage(ir.usage);
  return withPassthrough(body, ir.passthrough?.openai);
}

function decodeStreamEvent(chunk) {
  const choice = chunk.choices?.[0] || {};
  const delta = choice.delta || choice.message;
  let decodedBlocks = null;
  if (delta) {
    const decodedDelta = decodeMessage({ role: delta.role || 'assistant', ...delta });
    for (const block of decodedDelta.blocks || []) {
      if (block.type === 'tool_call') block.streamDelta = true;
    }
    decodedBlocks = decodedDelta;
  }
  const finishReason = choice.finish_reason
    ? ({ stop: 'stop', length: 'length', tool_calls: 'tool_calls', content_filter: 'content_filter', function_call: 'tool_calls' }[choice.finish_reason] || choice.finish_reason)
    : undefined;
  return {
    kind: 'stream_event',
    sourceDialect: 'openai',
    id: chunk.id,
    model: chunk.model,
    eventType: chunk.usage && !chunk.choices?.length ? 'usage' : (finishReason ? 'finish' : 'delta'),
    index: 0,
    delta: decodedBlocks || null,
    finishReason,
    usage: decodeUsage(chunk.usage),
    passthrough: { openai: omitKnown(chunk, CHUNK_KEYS) }
  };
}

function encodeStreamEvent(ir) {
  const body = { id: ir.id || `chatcmpl-${Date.now().toString(36)}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: ir.model || 'unknown', choices: [] };
  if (ir.eventType !== 'usage') {
    const delta = ir.delta || {};
    const blocks = delta.blocks || [];
    const toolBlocks = blocks.filter(block => block.type === 'tool_call' || block.type === 'tool_call_delta');
    const contentBlocks = blocks.filter(block => block.type !== 'tool_call' && block.type !== 'tool_call_delta');
    const encoded = encodeMessage({ ...delta, blocks: contentBlocks });
    delete encoded.tool_calls;
    if (toolBlocks.length) {
      encoded.tool_calls = toolBlocks.map((block, offset) => {
        if (block.type === 'tool_call_delta') {
          return {
            index: block.index ?? offset,
            ...(block.id ? { id: block.id } : {}),
            type: 'function',
            function: { arguments: block.argumentsText || '' }
          };
        }
        return {
          index: block.index ?? offset,
          id: block.id,
          type: 'function',
          function: {
            name: block.name || '',
            arguments: block.argumentsText || JSON.stringify(block.input || {})
          }
        };
      });
    }
    body.choices = [{ index: ir.index || 0, delta: encoded, finish_reason: ir.finishReason || null }];
  }
  if (ir.usage) body.usage = encodeUsage(ir.usage);
  return withPassthrough(body, ir.passthrough?.openai);
}

module.exports = { decodeRequest, encodeRequest, decodeResponse, encodeResponse, decodeStreamEvent, encodeStreamEvent };
