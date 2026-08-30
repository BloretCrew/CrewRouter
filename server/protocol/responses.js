'use strict';

const { omitKnown, withPassthrough, safeParseJson } = require('./helpers');

const REQUEST_KEYS = new Set(['model', 'input', 'instructions', 'max_output_tokens', 'temperature', 'top_p', 'stream', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'metadata', 'store']);
const RESPONSE_KEYS = new Set(['id', 'object', 'created_at', 'status', 'model', 'output', 'usage', 'error', 'incomplete_details', 'metadata']);
const EVENT_KEYS = new Set(['type', 'sequence_number', 'response', 'item_id', 'output_index', 'content_index', 'delta', 'item', 'part', 'arguments', 'arguments_delta']);

function decodeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: 'raw', value: content }];
  return content.map(part => {
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') return { type: 'text', text: part.text || '', passthrough: { responses: omitKnown(part, new Set(['type', 'text'])) } };
    if (part.type === 'input_image' || part.type === 'image') return { type: 'image', source: part.image_url || part.image || part, passthrough: { responses: omitKnown(part, new Set(['type', 'image_url', 'image'])) } };
    if (part.type === 'refusal') return { type: 'raw', value: part };
    return { type: 'raw', value: part };
  });
}

function encodeContent(blocks, mode = 'input') {
  return (blocks || []).map(block => {
    if (block.type === 'text') return withPassthrough({ type: mode === 'output' ? 'output_text' : 'input_text', text: block.text || '' }, block.passthrough?.responses);
    if (block.type === 'image') return withPassthrough({ type: 'input_image', image_url: block.source?.url || block.source }, block.passthrough?.responses);
    if (block.type === 'raw') return block.value;
    return null;
  }).filter(Boolean);
}

function decodeItem(item) {
  if (!item) return null;
  if (item.type === 'message' || item.role || item.content !== undefined) return { role: item.role || 'assistant', blocks: decodeContent(item.content), passthrough: { responses: omitKnown(item, new Set(['type', 'role', 'content', 'id', 'status'])) } };
  if (item.type === 'function_call') return { role: 'assistant', blocks: [{ type: 'tool_call', id: item.call_id || item.id, name: item.name || '', input: safeParseJson(item.arguments, {}), argumentsText: item.arguments || '', passthrough: { responses: omitKnown(item, new Set(['type', 'call_id', 'id', 'name', 'arguments', 'status'])) } }] };
  if (item.type === 'function_call_output') return { role: 'tool', blocks: [{ type: 'tool_result', toolCallId: item.call_id, content: decodeContent(item.output) }], passthrough: { responses: omitKnown(item, new Set(['type', 'call_id', 'output'])) } };
  return { role: item.role || 'assistant', blocks: [{ type: 'raw', value: item }], passthrough: { responses: {} } };
}

function encodeMessage(message) {
  if (message.role === 'tool' || message.blocks?.some(b => b.type === 'tool_result')) {
    const result = message.blocks.find(b => b.type === 'tool_result');
    return withPassthrough({ type: 'function_call_output', call_id: result?.toolCallId, output: encodeContent(result?.content || [], 'input') }, message.passthrough?.responses);
  }
  const calls = (message.blocks || []).filter(b => b.type === 'tool_call');
  if (calls.length) return calls.map(block => withPassthrough({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.argumentsText || JSON.stringify(block.input || {}) }, block.passthrough?.responses));
  return withPassthrough({ type: 'message', role: message.role === 'developer' ? 'developer' : message.role, content: encodeContent(message.blocks, 'input') }, message.passthrough?.responses);
}

function decodeTool(tool) {
  const fn = tool.type === 'function' ? tool.function || tool : tool;
  return { name: fn.name, description: fn.description, inputSchema: fn.parameters || fn.input_schema || {}, passthrough: { responses: omitKnown(tool, new Set(['type', 'function', 'name', 'description', 'parameters', 'input_schema'])) } };
}
function encodeTool(tool) { return withPassthrough({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema || {} }, tool.passthrough?.responses); }
function decodeRequest(body) {
  const input = Array.isArray(body.input) ? body.input : [{ role: 'user', content: body.input || '' }];
  return { kind: 'request', sourceDialect: 'responses', model: body.model, messages: input.flatMap(item => { const m = decodeItem(item); return m ? [m] : []; }), tools: (body.tools || []).map(decodeTool), toolChoice: body.tool_choice, parameters: { maxTokens: body.max_output_tokens, maxTokensField: 'max_output_tokens', temperature: body.temperature, topP: body.top_p, stream: body.stream, reasoning: body.reasoning }, passthrough: { responses: omitKnown(body, REQUEST_KEYS) } };
}
function encodeRequest(ir) {
  const body = { model: ir.model, input: (ir.messages || []).flatMap(encodeMessage) };
  const p = ir.parameters || {};
  if (p.maxTokens !== undefined) body.max_output_tokens = p.maxTokens;
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.topP !== undefined) body.top_p = p.topP;
  if (p.stream !== undefined) body.stream = p.stream;
  if (p.reasoning !== undefined) body.reasoning = p.reasoning;
  if (ir.tools?.length) body.tools = ir.tools.map(encodeTool);
  if (ir.toolChoice !== undefined) body.tool_choice = ir.toolChoice;
  return withPassthrough(body, ir.passthrough?.responses);
}
function decodeUsage(u) { return u ? { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, totalTokens: (u.input_tokens || 0) + (u.output_tokens || 0), passthrough: { responses: omitKnown(u, new Set(['input_tokens', 'output_tokens', 'total_tokens'])) } } : undefined; }
function encodeUsage(u) { return u ? withPassthrough({ input_tokens: u.inputTokens || 0, output_tokens: u.outputTokens || 0, total_tokens: u.totalTokens ?? ((u.inputTokens || 0) + (u.outputTokens || 0)) }, u.passthrough?.responses) : undefined; }
function decodeResponse(body) {
  const messages = (body.output || []).map(decodeItem).filter(Boolean);
  return { kind: 'response', sourceDialect: 'responses', id: body.id, model: body.model, message: messages.find(m => m.role !== 'tool') || messages[0] || null, finishReason: body.status === 'incomplete' ? body.incomplete_details?.reason : (body.status === 'failed' ? 'error' : 'stop'), usage: decodeUsage(body.usage), passthrough: { responses: omitKnown(body, RESPONSE_KEYS) } };
}
function encodeResponse(ir) {
  const message = ir.message || { role: 'assistant', blocks: [] };
  const body = { id: ir.id || `resp_${Date.now()}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: ir.finishReason === 'error' ? 'failed' : 'completed', model: ir.model, output: [{ type: 'message', id: `${ir.id || 'msg'}_1`, role: 'assistant', status: 'completed', content: encodeContent(message.blocks, 'output') }], usage: encodeUsage(ir.usage) };
  return withPassthrough(body, ir.passthrough?.responses);
}
function decodeStreamEvent(event) {
  let delta = null;
  if (event.type === 'response.output_text.delta') delta = { role: 'assistant', blocks: [{ type: 'text', text: event.delta || '' }] };
  else if (event.type === 'response.function_call_arguments.delta') delta = { role: 'assistant', blocks: [{ type: 'tool_call_delta', id: event.item_id, argumentsText: event.delta || '' }] };
  else if (event.type === 'response.output_item.added') delta = decodeItem(event.item);
  const response = event.response || {};
  return { kind: 'stream_event', sourceDialect: 'responses', id: response.id || event.item_id, model: response.model, eventType: event.type, delta, finishReason: event.type === 'response.completed' ? 'stop' : undefined, usage: decodeUsage(response.usage), passthrough: { responses: omitKnown(event, EVENT_KEYS) } };
}
function encodeStreamEvent(ir) {
  let event;
  const block = ir.delta?.blocks?.[0];
  if (block?.type === 'text') event = { type: 'response.output_text.delta', delta: block.text || '', item_id: ir.id, output_index: ir.index || 0, content_index: 0 };
  else if (block?.type === 'tool_call_delta') event = { type: 'response.function_call_arguments.delta', delta: block.argumentsText || '', item_id: block.id || ir.id, output_index: ir.index || 0 };
  else if (ir.eventType === 'response.completed' || ir.finishReason) event = { type: 'response.completed', response: encodeResponse(ir) };
  else event = { type: ir.eventType || 'response.created', response: encodeResponse(ir) };
  return withPassthrough(event, ir.passthrough?.responses);
}
module.exports = { decodeRequest, encodeRequest, decodeResponse, encodeResponse, decodeStreamEvent, encodeStreamEvent };
