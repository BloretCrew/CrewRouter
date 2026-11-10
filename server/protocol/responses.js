'use strict';

const {
  omitKnown, withPassthrough, safeParseJson,
  DEFAULT_IMAGE_MIME, toDataUri, imageSourceToResponses,
  parseDataUri, mediaPlaceholder
} = require('./helpers');

const REQUEST_KEYS = new Set(['model', 'input', 'instructions', 'max_output_tokens', 'temperature', 'top_p', 'stream', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'metadata', 'store', 'text']);
const RESPONSE_KEYS = new Set(['id', 'object', 'created_at', 'status', 'model', 'output', 'usage', 'error', 'incomplete_details', 'metadata']);
const EVENT_KEYS = new Set(['type', 'sequence_number', 'response', 'item_id', 'output_index', 'content_index', 'summary_index', 'delta', 'item', 'part', 'arguments', 'arguments_delta', 'refusal', 'text']);

function decodeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return content == null ? [] : [{ type: 'raw', value: content }];
  return content.map(part => {
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') return { type: 'text', text: part.text || '', passthrough: { responses: omitKnown(part, new Set(['type', 'text'])) } };
    if (part.type === 'input_image' || part.type === 'image') return { type: 'image', source: part.image_url || part.image || part, passthrough: { responses: omitKnown(part, new Set(['type', 'image_url', 'image'])) } };
    if (part.type === 'input_file' || part.type === 'file') {
      const fileData = part.file_data;
      const parsedFileData = parseDataUri(fileData);
      return {
        type: 'media', mediaType: 'document',
        mimeType: part.mime_type || parsedFileData?.mimeType || 'application/octet-stream',
        fileId: part.file_id,
        fileUri: part.file_url,
        fileData,
        filename: part.filename,
        passthrough: { responses: omitKnown(part, new Set(['type', 'file_id', 'file_url', 'file_data', 'filename', 'mime_type'])) }
      };
    }
    if (part.type === 'refusal') return { type: 'raw', value: part };
    return { type: 'raw', value: part };
  });
}

function encodeContent(blocks, mode = 'input') {
  return (blocks || []).map(block => {
    if (block.type === 'text') return withPassthrough({ type: mode === 'output' ? 'output_text' : 'input_text', text: block.text || '' }, block.passthrough?.responses);
    if (block.type === 'image') {
      const part = imageSourceToResponses(block.source);
      return part ? withPassthrough(part, block.passthrough?.responses) : null;
    }
    if (block.type === 'media') {
      if (block.mediaType === 'image') {
        const uri = block.fileUri || block.url || block.uri
          || (block.data ? toDataUri(block.mimeType || DEFAULT_IMAGE_MIME, block.data) : '');
        if (!uri) {
          return { type: mode === 'output' ? 'output_text' : 'input_text', text: mediaPlaceholder(block) };
        }
        return withPassthrough({ type: 'input_image', image_url: uri }, block.passthrough?.responses);
      }
      if (block.mediaType === 'document') {
        const uri = block.fileUri || block.url || block.uri;
        const parsedFileData = parseDataUri(block.fileData);
        const data = block.data || parsedFileData?.data
          || (typeof block.fileData === 'string' && !/^data:/i.test(block.fileData) ? block.fileData : undefined);
        if (block.fileId) {
          return { type: 'input_file', file_id: block.fileId, ...(block.filename ? { filename: block.filename } : {}) };
        }
        if (uri) {
          return { type: 'input_file', file_url: uri, ...(block.filename ? { filename: block.filename } : {}) };
        }
        if (data) {
          return { type: 'input_file', file_data: data, ...(block.filename ? { filename: block.filename } : {}) };
        }
        return { type: mode === 'output' ? 'output_text' : 'input_text', text: mediaPlaceholder(block) };
      }
      return { type: mode === 'output' ? 'output_text' : 'input_text', text: mediaPlaceholder(block) };
    }
    if (block.type === 'raw') return block.value;
    return null;
  }).filter(Boolean);
}

function decodeItem(item) {
  if (!item) return null;
  if (item.type === 'additional_tools') return { role: item.role || 'user', blocks: [{ type: 'raw', value: item }] };
  if (item.type === 'message' || item.role || item.content !== undefined) return { role: item.role || 'assistant', blocks: decodeContent(item.content), passthrough: { responses: omitKnown(item, new Set(['type', 'role', 'content', 'id', 'status'])) } };
  if (item.type === 'function_call') return { role: 'assistant', blocks: [{ type: 'tool_call', id: item.call_id || item.id, name: item.name || '', input: safeParseJson(item.arguments, {}), argumentsText: item.arguments || '', passthrough: { responses: omitKnown(item, new Set(['type', 'call_id', 'id', 'name', 'arguments', 'status'])) } }] };
  if (item.type === 'function_call_output') return { role: 'tool', blocks: [{ type: 'tool_result', toolCallId: item.call_id, content: decodeContent(item.output) }], passthrough: { responses: omitKnown(item, new Set(['type', 'call_id', 'output'])) } };
  return { role: item.role || 'assistant', blocks: [{ type: 'raw', value: item }], passthrough: { responses: {} } };
}

function encodeMessage(message) {
  const only = message.blocks?.length === 1 ? message.blocks[0] : null;
  if (only?.type === 'raw' && only.value?.type === 'additional_tools') return only.value;
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
  return { kind: 'request', sourceDialect: 'responses', model: body.model, messages: input.flatMap(item => { const m = decodeItem(item); return m ? [m] : []; }), tools: (body.tools || []).map(decodeTool), toolChoice: body.tool_choice, parameters: { maxTokens: body.max_output_tokens, maxTokensField: 'max_output_tokens', temperature: body.temperature, topP: body.top_p, stream: body.stream, reasoning: body.reasoning, responseFormat: body.text?.format, responseSchema: body.text?.format?.schema, responseMimeType: body.text?.format?.type === 'json_schema' ? 'application/json' : undefined }, passthrough: { responses: omitKnown(body, REQUEST_KEYS) } };
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
  if (p.responseFormat !== undefined) body.text = { format: p.responseFormat };
  else if (p.responseSchema) body.text = { format: { type: 'json_schema', name: 'response', schema: p.responseSchema } };
  else if (p.responseMimeType === 'application/json') body.text = { format: { type: 'json_object' } };
  return withPassthrough(body, ir.passthrough?.responses);
}
function decodeUsage(u) { return u ? (() => { const reasoning = u.output_tokens_details?.reasoning_tokens || 0; const output = u.output_tokens || 0; return { inputTokens: u.input_tokens || 0, outputTokens: output, candidatesTokens: Math.max(0, output - reasoning), totalTokens: u.total_tokens ?? ((u.input_tokens || 0) + output), cachedInputTokens: u.cached_tokens || u.input_tokens_details?.cached_tokens || 0, reasoningTokens: reasoning, passthrough: { responses: omitKnown(u, new Set(['input_tokens', 'output_tokens', 'total_tokens', 'cached_tokens', 'input_tokens_details', 'output_tokens_details'])) } }; })() : undefined; }
function encodeUsage(u) { return u ? withPassthrough({ input_tokens: u.inputTokens || 0, output_tokens: u.outputTokens || 0, total_tokens: u.totalTokens ?? ((u.inputTokens || 0) + (u.outputTokens || 0)), ...(u.cachedInputTokens ? { cached_tokens: u.cachedInputTokens } : {}), ...(u.reasoningTokens ? { output_tokens_details: { reasoning_tokens: u.reasoningTokens } } : {}) }, u.passthrough?.responses) : undefined; }

function decodeReasoningItem(item) {
  const text = (item.summary || []).map(part => part?.text || '').join('');
  return text ? { type: 'thinking', thinking: text, id: item.id } : null;
}

function decodeOutputBlocks(output) {
  const blocks = [];
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' || item.role === 'assistant' || item.content !== undefined) {
      blocks.push(...decodeContent(item.content));
    } else if (item.type === 'reasoning') {
      const thinking = decodeReasoningItem(item);
      if (thinking) blocks.push(thinking);
    } else if (item.type === 'function_call') {
      blocks.push({
        type: 'tool_call',
        id: item.call_id || item.id,
        name: item.name || '',
        input: safeParseJson(item.arguments, {}),
        argumentsText: item.arguments || '',
        passthrough: { responses: omitKnown(item, new Set(['type', 'call_id', 'id', 'name', 'arguments', 'status'])) }
      });
    } else if (item.type === 'function_call_output') {
      blocks.push({
        type: 'tool_result',
        toolCallId: item.call_id,
        content: decodeContent(item.output),
        result: typeof item.output === 'string' ? item.output : item.output,
        passthrough: { responses: omitKnown(item, new Set(['type', 'call_id', 'output'])) }
      });
    }
  }
  return blocks;
}

function decodeResponse(body) {
  const blocks = decodeOutputBlocks(body.output);
  const hasTools = blocks.some(block => block.type === 'tool_call');
  const incomplete = body.status === 'incomplete' ? body.incomplete_details?.reason : undefined;
  const finishReason = body.status === 'failed'
    ? 'error'
    : (incomplete === 'max_output_tokens' ? 'length' : (incomplete ? 'content_filter' : (hasTools ? 'tool_calls' : 'stop')));
  return {
    kind: 'response',
    sourceDialect: 'responses',
    id: body.id,
    model: body.model,
    message: blocks.length ? { role: 'assistant', blocks } : null,
    finishReason,
    usage: decodeUsage(body.usage),
    passthrough: { responses: omitKnown(body, RESPONSE_KEYS) }
  };
}

function encodeResponse(ir) {
  const message = ir.message || { role: 'assistant', blocks: [] };
  const output = [];
  const textBlocks = [];
  let messageIndex = 0;
  for (const block of message.blocks || []) {
    if (block.type === 'thinking') {
      if (block.thinking) {
        output.push({
          type: 'reasoning',
          id: block.id || `${ir.id || 'rs'}_reasoning_${output.length}`,
          summary: [{ type: 'summary_text', text: block.thinking }]
        });
      }
    } else if (block.type === 'tool_call') {
      output.push(withPassthrough({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: block.argumentsText || JSON.stringify(block.input || {})
      }, block.passthrough?.responses));
    } else if (block.type === 'tool_result') {
      output.push({ type: 'function_call_output', call_id: block.toolCallId, output: block.result !== undefined ? block.result : (encodeContent(block.content || [], 'input') || '') });
    } else if (block.type === 'text' || block.type === 'image' || block.type === 'media' || block.type === 'raw') {
      textBlocks.push(block);
    }
  }
  if (textBlocks.length) {
    output.push({
      type: 'message',
      id: `${ir.id || 'msg'}_${messageIndex}`,
      role: 'assistant',
      status: 'completed',
      content: encodeContent(textBlocks, 'output')
    });
  }
  const hasTools = (message.blocks || []).some(block => block.type === 'tool_call');
  const incomplete = ir.finishReason === 'length' || ir.finishReason === 'max_tokens' || ir.finishReason === 'content_filter';
  const status = ir.finishReason === 'error'
    ? 'failed'
    : (incomplete ? 'incomplete' : 'completed');
  const body = {
    id: ir.id || `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: ir.model,
    output,
    ...(incomplete ? { incomplete_details: { reason: ir.finishReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' } } : {}),
    usage: encodeUsage(ir.usage)
  };
  if (hasTools && status === 'completed') body.status = 'completed';
  const text = textBlocks.filter(block => block.type === 'text').map(block => block.text).join('');
  if (text) body.output_text = text;
  return withPassthrough(body, ir.passthrough?.responses);
}
function decodeStreamEvent(event) {
  let delta = null;
  const type = String(event.type || '');
  if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
    delta = { role: 'assistant', blocks: [{ type: 'text', text: event.delta || '' }] };
  } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    delta = { role: 'assistant', blocks: [{ type: 'thinking', thinking: event.delta || '' }] };
  } else if (type === 'response.function_call_arguments.delta') {
    delta = { role: 'assistant', blocks: [{ type: 'tool_call_delta', id: event.item_id, index: event.output_index || 0, argumentsText: event.delta || '' }] };
  } else if (type === 'response.output_item.added') {
    delta = decodeItem(event.item);
    for (const block of delta?.blocks || []) {
      if (block.type === 'tool_call') block.streamDelta = true;
    }
  }
  const response = event.response || {};
  const finishReason = type === 'response.completed'
    ? 'stop'
    : (type === 'response.incomplete'
      ? (response.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'content_filter')
      : (type === 'response.failed' ? 'error' : undefined));
  return {
    kind: 'stream_event',
    sourceDialect: 'responses',
    id: response.id || event.item_id,
    model: response.model,
    eventType: type,
    index: event.output_index,
    delta,
    finishReason,
    usage: decodeUsage(response.usage),
    passthrough: { responses: omitKnown(event, EVENT_KEYS) }
  };
}
function encodeStreamEvent(ir) {
  let event;
  const block = ir.delta?.blocks?.[0];
  if (block?.type === 'text') event = { type: 'response.output_text.delta', delta: block.text || '', item_id: ir.id, output_index: ir.index || 0, content_index: 0 };
  else if (block?.type === 'thinking') event = { type: 'response.reasoning_summary_text.delta', delta: block.thinking || '', item_id: ir.id, output_index: ir.index || 0, summary_index: 0 };
  else if (block?.type === 'tool_call_delta') event = { type: 'response.function_call_arguments.delta', delta: block.argumentsText || '', item_id: block.id || ir.id, output_index: block.index ?? ir.index ?? 0 };
  else if (block?.type === 'tool_call') {
    event = {
      type: 'response.output_item.added',
      output_index: block.index ?? ir.index ?? 0,
      item: { type: 'function_call', call_id: block.id, name: block.name, arguments: block.argumentsText || JSON.stringify(block.input || {}) }
    };
  }
  else if (ir.eventType === 'response.completed' || ir.finishReason) event = { type: 'response.completed', response: encodeResponse(ir) };
  else event = { type: ir.eventType || 'response.created', response: encodeResponse(ir) };
  return withPassthrough(event, ir.passthrough?.responses);
}
module.exports = { decodeRequest, encodeRequest, decodeResponse, encodeResponse, decodeStreamEvent, encodeStreamEvent };
