'use strict';

const { omitKnown, withPassthrough, safeParseJson } = require('./helpers');

const REQUEST_KEYS = new Set(['model', 'messages', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'stream', 'stream_options', 'tools', 'tool_choice', 'reasoning_effort']);
const MESSAGE_KEYS = new Set(['role', 'content', 'name', 'tool_call_id', 'tool_calls', 'reasoning_content']);
const RESPONSE_KEYS = new Set(['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']);
const CHUNK_KEYS = new Set(['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']);

function decodeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: 'raw', value: content }];
  return content.map(part => {
    if (part?.type === 'text') return { type: 'text', text: part.text || '', passthrough: { openai: omitKnown(part, new Set(['type', 'text'])) } };
    if (part?.type === 'image_url') return { type: 'image', source: part.image_url, passthrough: { openai: omitKnown(part, new Set(['type', 'image_url'])) } };
    return { type: 'raw', value: part };
  });
}

function encodeContent(blocks, dialect) {
  const content = [];
  for (const block of blocks || []) {
    if (block.type === 'text') content.push(withPassthrough({ type: 'text', text: block.text || '' }, block.passthrough?.[dialect]));
    else if (block.type === 'image') content.push(withPassthrough({ type: 'image_url', image_url: block.source }, block.passthrough?.[dialect]));
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
      name: call.function?.name || '',
      input: safeParseJson(call.function?.arguments, {}),
      argumentsText: call.function?.arguments || '',
      passthrough: { openai: omitKnown(call, new Set(['id', 'type', 'function'])) }
    });
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      blocks: [{ type: 'tool_result', toolCallId: message.tool_call_id, content: blocks }],
      passthrough: { openai: omitKnown(message, MESSAGE_KEYS) }
    };
  }
  return { role: message.role, blocks, passthrough: { openai: omitKnown(message, MESSAGE_KEYS) } };
}

function encodeMessage(message) {
  const extra = message.passthrough?.openai;
  if (message.role === 'tool' || message.blocks?.some(block => block.type === 'tool_result')) {
    const result = message.blocks.find(block => block.type === 'tool_result');
    return withPassthrough({ role: 'tool', tool_call_id: result?.toolCallId, content: encodeContent(result?.content || [], 'openai') || '' }, extra);
  }
  const toolCalls = [];
  const contentBlocks = [];
  let reasoning;
  for (const block of message.blocks || []) {
    if (block.type === 'tool_call') {
      toolCalls.push(withPassthrough({ id: block.id, type: 'function', function: { name: block.name, arguments: block.argumentsText || JSON.stringify(block.input || {}) } }, block.passthrough?.openai));
    } else if (block.type === 'thinking') reasoning = (reasoning || '') + (block.thinking || '');
    else contentBlocks.push(block);
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
    passthrough: { openai: omitKnown(tool, new Set(['type', 'function', 'name', 'description', 'parameters'])) }
  };
}

function encodeTool(tool) {
  return withPassthrough({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema || {} } }, tool.passthrough?.openai);
}

function decodeRequest(body) {
  return {
    kind: 'request', sourceDialect: 'openai', model: body.model,
    messages: (body.messages || []).map(decodeMessage),
    tools: (body.tools || []).map(decodeTool), toolChoice: body.tool_choice,
    parameters: {
      maxTokens: body.max_completion_tokens ?? body.max_tokens,
      maxTokensField: body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens',
      temperature: body.temperature, topP: body.top_p, stop: body.stop, stream: body.stream,
      streamUsage: body.stream_options?.include_usage, reasoningEffort: body.reasoning_effort
    },
    passthrough: { openai: omitKnown(body, REQUEST_KEYS) }
  };
}

function encodeRequest(ir) {
  const body = { model: ir.model, messages: (ir.messages || []).map(encodeMessage) };
  const p = ir.parameters || {};
  if (p.maxTokens !== undefined) body[p.maxTokensField === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens'] = p.maxTokens;
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.topP !== undefined) body.top_p = p.topP;
  if (p.stop !== undefined) body.stop = p.stop;
  if (p.stream !== undefined) body.stream = p.stream;
  if (p.streamUsage !== undefined) body.stream_options = { include_usage: p.streamUsage };
  if (p.reasoningEffort !== undefined) body.reasoning_effort = p.reasoningEffort;
  if (ir.tools?.length) body.tools = ir.tools.map(encodeTool);
  if (ir.toolChoice !== undefined) body.tool_choice = ir.toolChoice;
  return withPassthrough(body, ir.passthrough?.openai);
}

function decodeUsage(usage) {
  if (!usage) return undefined;
  return { inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0, totalTokens: usage.total_tokens, cachedInputTokens: usage.prompt_tokens_details?.cached_tokens || usage.cached_tokens || 0, passthrough: { openai: omitKnown(usage, new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'cached_tokens'])) } };
}

function encodeUsage(usage) {
  if (!usage) return undefined;
  const result = { prompt_tokens: usage.inputTokens || 0, completion_tokens: usage.outputTokens || 0, total_tokens: usage.totalTokens ?? ((usage.inputTokens || 0) + (usage.outputTokens || 0)) };
  if (usage.cachedInputTokens) result.prompt_tokens_details = { cached_tokens: usage.cachedInputTokens };
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
  return { kind: 'stream_event', sourceDialect: 'openai', id: chunk.id, model: chunk.model, eventType: chunk.usage && !chunk.choices?.length ? 'usage' : (choice.finish_reason ? 'message_delta' : 'content_delta'), delta: choice.delta ? decodeMessage({ role: choice.delta.role || 'assistant', ...choice.delta }) : null, finishReason: choice.finish_reason, usage: decodeUsage(chunk.usage), passthrough: { openai: omitKnown(chunk, CHUNK_KEYS) } };
}

function encodeStreamEvent(ir) {
  const body = { id: ir.id || `chatcmpl-${Date.now().toString(36)}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: ir.model || 'unknown', choices: [] };
  if (ir.eventType !== 'usage') body.choices = [{ index: 0, delta: ir.delta ? encodeMessage(ir.delta) : {}, finish_reason: ir.finishReason || null }];
  if (ir.usage) body.usage = encodeUsage(ir.usage);
  return withPassthrough(body, ir.passthrough?.openai);
}

module.exports = { decodeRequest, encodeRequest, decodeResponse, encodeResponse, decodeStreamEvent, encodeStreamEvent };
