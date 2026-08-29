'use strict';

const { omitKnown, withPassthrough, contentToText } = require('./helpers');

const REQUEST_KEYS = new Set(['model', 'messages', 'system', 'max_tokens', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'stream', 'tools', 'tool_choice', 'thinking']);
const RESPONSE_KEYS = new Set(['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_sequence', 'usage']);
const EVENT_KEYS = new Set(['type', 'index', 'content_block', 'delta', 'message', 'usage']);

function decodeBlock(block) {
  if (typeof block === 'string') return { type: 'text', text: block };
  const passthrough = { anthropic: omitKnown(block, new Set(['type', 'text', 'thinking', 'signature', 'source', 'id', 'name', 'input', 'tool_use_id', 'content', 'is_error', 'cache_control'])) };
  if (block.type === 'text') return { type: 'text', text: block.text || '', cacheControl: block.cache_control, passthrough };
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return { type: 'thinking', thinking: block.thinking || '', signature: block.signature, redacted: block.type === 'redacted_thinking', passthrough };
  if (block.type === 'image') return { type: 'image', source: block.source, cacheControl: block.cache_control, passthrough };
  if (block.type === 'tool_use') return { type: 'tool_call', id: block.id, name: block.name, input: block.input || {}, cacheControl: block.cache_control, passthrough };
  if (block.type === 'tool_result') return { type: 'tool_result', toolCallId: block.tool_use_id, content: decodeContent(block.content), isError: block.is_error, cacheControl: block.cache_control, passthrough };
  return { type: 'raw', value: block };
}

function decodeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.map(decodeBlock) : [];
}

function encodeBlock(block) {
  let value;
  if (block.type === 'text') value = { type: 'text', text: block.text || '' };
  else if (block.type === 'thinking') value = block.redacted ? { type: 'redacted_thinking', data: block.thinking || '' } : { type: 'thinking', thinking: block.thinking || '', ...(block.signature ? { signature: block.signature } : {}) };
  else if (block.type === 'image') value = { type: 'image', source: block.source };
  else if (block.type === 'tool_call') value = { type: 'tool_use', id: block.id, name: block.name, input: block.input || {} };
  else if (block.type === 'tool_result') value = { type: 'tool_result', tool_use_id: block.toolCallId, content: encodeContent(block.content || []), ...(block.isError !== undefined ? { is_error: block.isError } : {}) };
  else if (block.type === 'raw') return block.value;
  else return null;
  if (block.cacheControl !== undefined) value.cache_control = block.cacheControl;
  return withPassthrough(value, block.passthrough?.anthropic);
}

function encodeContent(blocks) {
  return (blocks || []).map(encodeBlock).filter(Boolean);
}

function decodeMessage(message) {
  return { role: message.role, blocks: decodeContent(message.content), passthrough: { anthropic: omitKnown(message, new Set(['role', 'content'])) } };
}

function encodeMessage(message) {
  return withPassthrough({ role: message.role === 'tool' ? 'user' : message.role, content: encodeContent(message.blocks) }, message.passthrough?.anthropic);
}

function decodeSystem(system) {
  if (!system) return [];
  const blocks = typeof system === 'string' ? [{ type: 'text', text: system }] : decodeContent(system);
  return [{ role: 'system', blocks }];
}

function decodeRequest(body) {
  return {
    kind: 'request', sourceDialect: 'anthropic', model: body.model,
    messages: [...decodeSystem(body.system), ...(body.messages || []).map(decodeMessage)],
    tools: (body.tools || []).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema || {}, cacheControl: tool.cache_control, passthrough: { anthropic: omitKnown(tool, new Set(['name', 'description', 'input_schema', 'cache_control'])) } })),
    toolChoice: body.tool_choice,
    parameters: { maxTokens: body.max_tokens, maxTokensField: 'max_tokens', temperature: body.temperature, topP: body.top_p, topK: body.top_k, stop: body.stop_sequences, stream: body.stream, streamUsage: body.stream ? true : undefined, thinking: body.thinking },
    passthrough: { anthropic: omitKnown(body, REQUEST_KEYS) }
  };
}

function encodeRequest(ir) {
  const systemMessages = (ir.messages || []).filter(message => message.role === 'system' || message.role === 'developer');
  const regularMessages = (ir.messages || []).filter(message => message.role !== 'system' && message.role !== 'developer');
  const body = { model: ir.model, messages: regularMessages.map(encodeMessage), max_tokens: ir.parameters?.maxTokens ?? 4096 };
  if (systemMessages.length) {
    const blocks = systemMessages.flatMap(message => message.blocks || []).map(encodeBlock).filter(Boolean);
    body.system = blocks.length === 1 && blocks[0].type === 'text' && Object.keys(blocks[0]).length === 2 ? blocks[0].text : blocks;
  }
  const p = ir.parameters || {};
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.topP !== undefined) body.top_p = p.topP;
  if (p.topK !== undefined) body.top_k = p.topK;
  if (p.stop !== undefined) body.stop_sequences = Array.isArray(p.stop) ? p.stop : [p.stop];
  if (p.stream !== undefined) body.stream = p.stream;
  if (p.thinking !== undefined) body.thinking = p.thinking;
  else if (p.reasoningEffort !== undefined) body.thinking = { type: 'enabled', budget_tokens: { low: 1024, medium: 4096, high: 8192 }[p.reasoningEffort] || 4096 };
  if (ir.tools?.length) body.tools = ir.tools.map(tool => withPassthrough({ name: tool.name, description: tool.description, input_schema: tool.inputSchema || {}, ...(tool.cacheControl !== undefined ? { cache_control: tool.cacheControl } : {}) }, tool.passthrough?.anthropic));
  if (ir.toolChoice !== undefined) {
    if (ir.toolChoice === 'auto') body.tool_choice = { type: 'auto' };
    else if (ir.toolChoice === 'required') body.tool_choice = { type: 'any' };
    else if (ir.toolChoice === 'none') body.tool_choice = { type: 'none' };
    else if (ir.toolChoice?.type === 'function') body.tool_choice = { type: 'tool', name: ir.toolChoice.function?.name };
    else body.tool_choice = ir.toolChoice;
  }
  return withPassthrough(body, ir.passthrough?.anthropic);
}

function decodeUsage(usage) {
  if (!usage) return undefined;
  return { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0, cachedInputTokens: usage.cache_read_input_tokens || 0, cacheCreationInputTokens: usage.cache_creation_input_tokens || 0, passthrough: { anthropic: omitKnown(usage, new Set(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])) } };
}

function encodeUsage(usage) {
  if (!usage) return undefined;
  return withPassthrough({ input_tokens: usage.inputTokens || 0, output_tokens: usage.outputTokens || 0, cache_read_input_tokens: usage.cachedInputTokens || 0, cache_creation_input_tokens: usage.cacheCreationInputTokens || 0 }, usage.passthrough?.anthropic);
}

function decodeResponse(body) {
  return { kind: 'response', sourceDialect: 'anthropic', id: body.id, model: body.model, message: { role: body.role || 'assistant', blocks: decodeContent(body.content) }, finishReason: body.stop_reason, stopSequence: body.stop_sequence, usage: decodeUsage(body.usage), passthrough: { anthropic: omitKnown(body, RESPONSE_KEYS) } };
}

function encodeResponse(ir) {
  const body = { id: ir.id || `msg_${Date.now()}`, type: 'message', role: 'assistant', content: encodeContent(ir.message?.blocks || []), model: ir.model, stop_reason: ({ stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' }[ir.finishReason] || ir.finishReason || 'end_turn'), stop_sequence: ir.stopSequence || null, usage: encodeUsage(ir.usage) || { input_tokens: 0, output_tokens: 0 } };
  return withPassthrough(body, ir.passthrough?.anthropic);
}

function decodeStreamEvent(event) {
  let delta = null;
  if (event.type === 'content_block_start') delta = { role: 'assistant', blocks: [decodeBlock(event.content_block)] };
  else if (event.type === 'content_block_delta') {
    if (event.delta?.type === 'text_delta') delta = { role: 'assistant', blocks: [{ type: 'text', text: event.delta.text || '' }] };
    else if (event.delta?.type === 'thinking_delta') delta = { role: 'assistant', blocks: [{ type: 'thinking', thinking: event.delta.thinking || '' }] };
    else if (event.delta?.type === 'input_json_delta') delta = { role: 'assistant', blocks: [{ type: 'tool_call_delta', argumentsText: event.delta.partial_json || '', index: event.index || 0 }] };
  }
  return { kind: 'stream_event', sourceDialect: 'anthropic', id: event.message?.id, model: event.message?.model, eventType: event.type, index: event.index, delta, finishReason: ({ end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop' }[event.delta?.stop_reason] || event.delta?.stop_reason), usage: decodeUsage(event.usage || event.message?.usage), passthrough: { anthropic: omitKnown(event, EVENT_KEYS) } };
}

function encodeStreamEvent(ir) {
  let event;
  const block = ir.delta?.blocks?.[0];
  if (ir.eventType === 'message_start') event = { type: 'message_start', message: encodeResponse({ ...ir, message: ir.delta || { blocks: [] } }) };
  else if (ir.eventType === 'content_block_start' || block?.type === 'tool_call') event = { type: 'content_block_start', index: ir.index || 0, content_block: encodeBlock(block) };
  else if (block?.type === 'text') event = { type: 'content_block_delta', index: ir.index || 0, delta: { type: 'text_delta', text: block.text || '' } };
  else if (block?.type === 'thinking') event = { type: 'content_block_delta', index: ir.index || 0, delta: { type: 'thinking_delta', thinking: block.thinking || '' } };
  else if (block?.type === 'tool_call_delta') event = { type: 'content_block_delta', index: block.index || ir.index || 0, delta: { type: 'input_json_delta', partial_json: block.argumentsText || '' } };
  else if (ir.eventType === 'usage' || ir.eventType === 'message_delta' || ir.finishReason) event = { type: 'message_delta', delta: { stop_reason: ir.finishReason || null, stop_sequence: null }, ...(ir.usage ? { usage: encodeUsage(ir.usage) } : {}) };
  else event = { type: ir.eventType || 'message_stop' };
  return withPassthrough(event, ir.passthrough?.anthropic);
}

module.exports = { decodeRequest, encodeRequest, decodeResponse, encodeResponse, decodeStreamEvent, encodeStreamEvent, contentToText };
