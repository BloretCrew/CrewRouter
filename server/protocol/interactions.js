'use strict';

const { omitKnown, withPassthrough, safeParseJson } = require('./helpers');
const { mediaTypeFromMime, fromGeminiSchema } = require('./gemini-schema');

/**
 * Gemini Interactions API wire format <-> canonical IR.
 *
 * Requests use a step/content timeline (`input`), responses return an
 * `Interaction` with a `steps` array, and streaming uses named SSE events
 * `interaction.created` / `step.start` / `step.delta` / `step.stop` /
 * `interaction.completed` / `error` / `done`.
 */

const CONTENT_TYPES = new Set(['text', 'image', 'audio', 'video', 'document']);
const STEP_TYPES = new Set([
  'user_input', 'model_output', 'thought', 'function_call', 'function_result',
  'code_execution_call', 'code_execution_result', 'google_search_call', 'google_search_result',
  'google_maps_call', 'google_maps_result', 'url_context_call', 'url_context_result',
  'file_search_call', 'file_search_result', 'mcp_server_tool_call', 'mcp_server_tool_result',
  'processing_call', 'processing_result'
]);
const REQUEST_KEYS = new Set([
  'model', 'input', 'system_instruction', 'tools', 'generation_config', 'stream',
  'store', 'background', 'previous_interaction_id', 'response_format', 'agent',
  'agent_config', 'environment', 'continuation_token', 'service_tier'
]);
const RESPONSE_KEYS = new Set([
  'id', 'object', 'status', 'created', 'updated', 'model', 'steps', 'usage',
  'previous_interaction_id', 'continuation_token', 'service_tier'
]);
const EVENT_KEYS = new Set([
  'event_type', 'event_id', 'interaction', 'interaction_id', 'status',
  'step', 'index', 'delta', 'usage', 'step_usage', 'error', 'continuation_token'
]);

const STATUS_TO_FINISH = Object.freeze({
  completed: 'stop',
  requires_action: 'tool_calls',
  incomplete: 'length',
  failed: 'error',
  cancelled: 'error',
  requires_continuation: 'length',
  in_progress: undefined
});

function contentToBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return content == null ? [] : [contentToBlock(content)];
  return content.map(contentToBlock).filter(Boolean);
}

function contentToBlock(content) {
  if (!content || typeof content !== 'object') {
    return typeof content === 'string' ? { type: 'text', text: content } : null;
  }
  const passthrough = { interactions: omitKnown(content, new Set([
    'type', 'text', 'data', 'uri', 'mime_type', 'annotations', 'name',
    'resolution', 'processing'
  ])) };
  if (content.type === 'text') return { type: 'text', text: content.text || '', passthrough };
  if (content.type === 'image' || content.type === 'audio' || content.type === 'video' || content.type === 'document') {
    const mediaType = content.type;
    const mimeType = content.mime_type || (mediaType === 'image' ? 'image/png' : 'application/octet-stream');
    return {
      type: 'media',
      mediaType: /^image\//i.test(mimeType) ? 'image' : mediaType,
      mimeType,
      data: content.data,
      fileUri: content.uri,
      name: content.name,
      passthrough
    };
  }
  return { type: 'raw', value: content };
}

function blockToContent(block) {
  if (block.type === 'text') {
    return withPassthrough({ type: 'text', text: block.text || '' }, block.passthrough?.interactions);
  }
  if (block.type === 'image' || block.type === 'media') {
    const mediaType = block.type === 'image' ? 'image' : block.mediaType;
    if (mediaType === 'image') {
      const mimeType = block.type === 'image'
        ? (block.source?.media_type || block.source?.mimeType || 'image/png')
        : (block.mimeType || 'image/png');
      const data = block.type === 'image' ? block.source?.data : block.data;
      const uri = block.type === 'image' ? block.source?.url : block.fileUri;
      return withPassthrough({
        type: 'image',
        mime_type: mimeType,
        ...(data ? { data } : {}),
        ...(uri ? { uri } : {})
      }, block.passthrough?.interactions);
    }
    if (['audio', 'video', 'document'].includes(mediaType)) {
      return withPassthrough({
        type: mediaType,
        mime_type: block.mimeType || 'application/octet-stream',
        ...(block.data ? { data: block.data } : {}),
        ...(block.fileUri ? { uri: block.fileUri } : {})
      }, block.passthrough?.interactions);
    }
  }
  if (block.type === 'raw') return block.value;
  return null;
}

function decodeStep(step) {
  if (!step || typeof step !== 'object') return null;
  const passthrough = { interactions: omitKnown(step, new Set([
    'type', 'id', 'name', 'arguments', 'call_id', 'content', 'summary',
    'signature', 'result', 'is_error', 'server_name'
  ])) };
  switch (step.type) {
    case 'user_input':
      return { message: { role: 'user', blocks: contentToBlocks(step.content), passthrough } };
    case 'model_output':
      return { message: { role: 'assistant', blocks: contentToBlocks(step.content), passthrough } };
    case 'thought': {
      const text = Array.isArray(step.summary)
        ? step.summary.map(part => part?.text || '').join('')
        : (typeof step.summary === 'string' ? step.summary : '');
      return {
        message: {
          role: 'assistant',
          blocks: [{ type: 'thinking', thinking: text, signature: step.signature, passthrough }],
          passthrough
        }
      };
    }
    case 'function_call': {
      const args = typeof step.arguments === 'string'
        ? safeParseJson(step.arguments, {})
        : (step.arguments && typeof step.arguments === 'object' ? step.arguments : {});
      return {
        message: {
          role: 'assistant',
          blocks: [{
            type: 'tool_call',
            id: step.id || step.call_id,
            name: step.name || '',
            input: args,
            argumentsText: typeof step.arguments === 'string' ? step.arguments : JSON.stringify(args),
            passthrough
          }],
          passthrough
        }
      };
    }
    case 'function_result': {
      const result = step.result;
      const content = typeof result === 'string'
        ? [{ type: 'text', text: result }]
        : (Array.isArray(result) ? contentToBlocks(result) : [{ type: 'text', text: JSON.stringify(result ?? {}) }]);
      return {
        message: {
          role: 'tool',
          blocks: [{
            type: 'tool_result',
            toolCallId: step.call_id,
            name: step.name,
            result,
            content,
            isError: step.is_error === true,
            passthrough
          }],
          passthrough
        }
      };
    }
    default:
      return { message: { role: 'assistant', blocks: [{ type: 'raw', value: step }], passthrough } };
  }
}

function normalizeInput(input) {
  if (input === undefined || input === null) return [];
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (Array.isArray(input)) {
    const allContent = input.length > 0 && input.every(item => item && typeof item === 'object' && CONTENT_TYPES.has(item.type));
    if (allContent) return [{ type: 'user_input', content: input }];
    return input;
  }
  if (typeof input === 'object') {
    if (CONTENT_TYPES.has(input.type)) return [{ type: 'user_input', content: [input] }];
    return [input];
  }
  return [];
}

function decodeRequest(body) {
  const request = body && typeof body === 'object' ? body : {};
  const messages = [];
  if (request.system_instruction !== undefined) {
    messages.push({
      role: 'system',
      blocks: typeof request.system_instruction === 'string'
        ? [{ type: 'text', text: request.system_instruction }]
        : contentToBlocks(request.system_instruction),
      passthrough: { interactions: {} }
    });
  }
  for (const item of normalizeInput(request.input)) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', blocks: [{ type: 'text', text: item }] });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (CONTENT_TYPES.has(item.type)) {
      messages.push({ role: 'user', blocks: [contentToBlock(item)] });
      continue;
    }
    if (item.type === 'message' && item.content !== undefined) {
      messages.push({ role: item.role || 'user', blocks: contentToBlocks(item.content) });
      continue;
    }
    if (STEP_TYPES.has(item.type)) {
      const decoded = decodeStep(item);
      if (decoded) messages.push(decoded.message);
      continue;
    }
    messages.push({ role: item.role || 'user', blocks: contentToBlocks(item.content), passthrough: { interactions: omitKnown(item, new Set(['role', 'content'])) } });
  }

  const tools = [];
  const serverTools = [];
  for (const tool of Array.isArray(request.tools) ? request.tools : []) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type === 'function' || (!tool.type && tool.name)) {
      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters || {},
        passthrough: { interactions: omitKnown(tool, new Set(['type', 'name', 'description', 'parameters'])) }
      });
    } else {
      serverTools.push({ raw: tool, passthrough: { interactions: omitKnown(tool, []) } });
    }
  }

  const generation = request.generation_config || {};
  const responseFormat = request.response_format;
  const schema = responseFormat?.schema
    || (Array.isArray(responseFormat) ? responseFormat.find(item => item?.schema)?.schema : undefined);
  const thinkingLevel = generation.thinking_level;
  const parameters = {
    maxTokens: generation.max_output_tokens,
    maxTokensField: 'max_output_tokens',
    stop: generation.stop_sequences,
    seed: generation.seed,
    stream: request.stream,
    reasoningEffort: thinkingLevel
      ? (String(thinkingLevel).toLowerCase() === 'none' ? 'minimal' : String(thinkingLevel).toLowerCase())
      : undefined,
    thinking: thinkingLevel
      ? {
        type: String(thinkingLevel).toLowerCase() === 'none' ? 'disabled' : 'enabled',
        budget_tokens: { minimal: 0, low: 1024, medium: 4096, high: 8192 }[String(thinkingLevel).toLowerCase()] ?? 4096,
        level: String(thinkingLevel).toUpperCase(),
        includeThoughts: generation.thinking_summaries !== 'none'
      }
      : undefined,
    responseFormat,
    responseSchema: schema,
    responseMimeType: schema ? 'application/json' : (responseFormat?.mime_type === 'application/json' ? 'application/json' : undefined)
  };

  const passthrough = omitKnown(request, REQUEST_KEYS);
  if (serverTools.length) passthrough.serverTools = serverTools;
  if (generation && Object.keys(omitKnown(generation, new Set([
    'max_output_tokens', 'stop_sequences', 'seed', 'thinking_level',
    'thinking_summaries', 'tool_choice'
  ]))).length) {
    passthrough.generationConfigExtras = omitKnown(generation, new Set([
      'max_output_tokens', 'stop_sequences', 'seed', 'thinking_level',
      'thinking_summaries', 'tool_choice'
    ]));
  }

  return {
    kind: 'request',
    sourceDialect: 'interactions',
    model: request.model,
    messages,
    tools,
    toolChoice: decodeToolChoice(generation.tool_choice),
    parameters,
    passthrough: { interactions: passthrough }
  };
}

function decodeToolChoice(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'none') return 'none';
    if (choice === 'any' || choice === 'validated') return 'required';
    return 'auto';
  }
  const mode = choice.mode || 'auto';
  const names = choice.allowed_tools?.tools || choice.tools || [];
  if (names.length === 1) return { type: 'function', function: { name: names[0] } };
  if (mode === 'none') return 'none';
  if (mode === 'any' || mode === 'validated') return 'required';
  return 'auto';
}

function encodeToolChoice(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (choice === 'auto') return 'auto';
  if (choice === 'none') return 'none';
  if (choice === 'required') return 'any';
  if (choice?.type === 'function') {
    const name = choice.function?.name || choice.name;
    return { mode: 'any', allowed_tools: { tools: name ? [name] : [] } };
  }
  return choice;
}

function encodeStep(block, index) {
  if (block.type === 'thinking') {
    return {
      type: 'thought',
      ...(block.signature ? { signature: block.signature } : {}),
      ...(block.thinking ? { summary: [{ type: 'text', text: block.thinking }] } : {})
    };
  }
  if (block.type === 'tool_call') {
    return {
      type: 'function_call',
      id: block.id,
      name: block.name,
      arguments: block.input && typeof block.input === 'object' ? block.input : {}
    };
  }
  if (block.type === 'tool_result') {
    return {
      type: 'function_result',
      call_id: block.toolCallId,
      ...(block.name ? { name: block.name } : {}),
      result: block.result !== undefined ? block.result : (block.content || ''),
      ...(block.isError ? { is_error: true } : {})
    };
  }
  if (block.type === 'raw') return block.value;
  return null;
}

function blocksToSteps(blocks) {
  const steps = [];
  let outputContent = [];
  const flushOutput = () => {
    if (outputContent.length) {
      steps.push({ type: 'model_output', content: outputContent });
      outputContent = [];
    }
  };
  for (const block of blocks || []) {
    if (block.type === 'text' || block.type === 'image' || block.type === 'media') {
      const content = blockToContent(block);
      if (content) outputContent.push(content);
    } else {
      flushOutput();
      const step = encodeStep(block);
      if (step) steps.push(step);
    }
  }
  flushOutput();
  return steps;
}

function decodeUsage(usage) {
  if (!usage) return undefined;
  const input = Number(usage.total_input_tokens || 0);
  const output = Number(usage.total_output_tokens || 0);
  const thoughts = Number(usage.total_thought_tokens || 0);
  const toolUse = Number(usage.total_tool_use_tokens || 0);
  return {
    inputTokens: input,
    outputTokens: output + thoughts,
    candidatesTokens: output,
    totalTokens: usage.total_tokens !== undefined ? Number(usage.total_tokens) : input + output + thoughts + toolUse,
    cachedInputTokens: Number(usage.total_cached_tokens || 0),
    reasoningTokens: thoughts,
    toolUseInputTokens: toolUse,
    passthrough: { interactions: omitKnown(usage, new Set([
      'total_input_tokens', 'initial_input_tokens', 'total_output_tokens',
      'total_cached_tokens', 'total_thought_tokens', 'total_tool_use_tokens',
      'total_tokens'
    ])) }
  };
}

function encodeUsage(usage) {
  if (!usage) return undefined;
  const output = usage.candidatesTokens !== undefined
    ? Number(usage.candidatesTokens)
    : Math.max(0, Number(usage.outputTokens) - Number(usage.reasoningTokens || 0));
  const result = {
    total_input_tokens: Number(usage.inputTokens || 0),
    total_output_tokens: output,
    total_cached_tokens: Number(usage.cachedInputTokens || 0),
    total_thought_tokens: Number(usage.reasoningTokens || 0),
    total_tool_use_tokens: Number(usage.toolUseInputTokens || 0),
    total_tokens: usage.totalTokens !== undefined
      ? Number(usage.totalTokens)
      : Number(usage.inputTokens || 0) + output + Number(usage.reasoningTokens || 0)
  };
  return withPassthrough(result, usage.passthrough?.interactions);
}

function statusFor(ir) {
  const hasTools = (ir.message?.blocks || []).some(block => block.type === 'tool_call');
  if (hasTools) return 'requires_action';
  if (ir.finishReason === 'length' || ir.finishReason === 'max_tokens') return 'incomplete';
  if (ir.finishReason === 'content_filter' || ir.finishReason === 'refusal') return 'incomplete';
  if (ir.finishReason === 'error') return 'failed';
  return 'completed';
}

function finishReasonFor(status, hasTools) {
  if (hasTools || status === 'requires_action') return 'tool_calls';
  if (status === 'incomplete') return 'length';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'stop';
}

function decodeResponse(body) {
  const response = body && typeof body === 'object' ? body : {};
  const blocks = [];
  const steps = Array.isArray(response.steps) ? response.steps : [];
  for (const step of steps) {
    if (!step || step.type === 'user_input') continue;
    const decoded = decodeStep(step);
    if (!decoded) continue;
    if (decoded.message.role === 'tool') blocks.push(...decoded.message.blocks);
    else blocks.push(...decoded.message.blocks);
  }
  const hasTools = blocks.some(block => block.type === 'tool_call');
  return {
    kind: 'response',
    sourceDialect: 'interactions',
    id: response.id,
    model: response.model,
    message: blocks.length ? { role: 'assistant', blocks } : null,
    finishReason: finishReasonFor(response.status, hasTools),
    usage: decodeUsage(response.usage),
    passthrough: { interactions: omitKnown(response, RESPONSE_KEYS) }
  };
}

function encodeResponse(ir) {
  const steps = blocksToSteps(ir.message?.blocks || []);
  const status = statusFor(ir);
  const now = new Date().toISOString();
  const body = {
    id: ir.id || `v1_${Date.now().toString(36)}`,
    object: 'interaction',
    status,
    created: ir.created || now,
    updated: now,
    model: ir.model,
    steps,
    ...(ir.usage ? { usage: encodeUsage(ir.usage) } : {})
  };
  return withPassthrough(body, ir.passthrough?.interactions);
}

function decodeStreamEvent(event) {
  const type = String(event.event_type || event.type || '');
  const eventData = event.data || event;
  let delta = null;
  let id;
  let model;
  let finishReason;
  let usage;
  if (type === 'interaction.created') {
    id = eventData.interaction?.id;
    model = eventData.interaction?.model;
  } else if (type === 'interaction.completed') {
    id = eventData.interaction?.id;
    model = eventData.interaction?.model;
    const hasTools = false;
    finishReason = finishReasonFor(eventData.interaction?.status, hasTools);
    usage = decodeUsage(eventData.interaction?.usage);
  } else if (type === 'step.start') {
    const step = eventData.step || {};
    if (step.type === 'function_call') {
      delta = { role: 'assistant', blocks: [{ type: 'tool_call', id: step.id, name: step.name, input: step.arguments || {}, argumentsText: '' }] };
    } else if (step.type === 'thought') {
      delta = { role: 'assistant', blocks: [{ type: 'thinking', thinking: '' }] };
    }
  } else if (type === 'step.delta') {
    const d = eventData.delta || {};
    if (d.type === 'text') delta = { role: 'assistant', blocks: [{ type: 'text', text: d.text || '' }] };
    else if (d.type === 'thought_summary') delta = { role: 'assistant', blocks: [{ type: 'thinking', thinking: d.content?.text || '' }] };
    else if (d.type === 'thought_signature') delta = { role: 'assistant', blocks: [{ type: 'thinking', thinking: '', signature: d.signature || '' }] };
    else if (d.type === 'arguments_delta') delta = { role: 'assistant', blocks: [{ type: 'tool_call_delta', index: eventData.index || 0, argumentsText: d.arguments || '' }] };
    else if (d.type === 'image' || d.type === 'audio' || d.type === 'video' || d.type === 'document') {
      delta = { role: 'assistant', blocks: [contentToBlock(d)] };
    }
  } else if (type === 'error') {
    finishReason = 'error';
  }
  return {
    kind: 'stream_event',
    sourceDialect: 'interactions',
    id,
    model,
    eventType: type,
    index: eventData.index,
    delta,
    finishReason,
    usage,
    passthrough: { interactions: omitKnown(eventData, EVENT_KEYS) }
  };
}

/**
 * Stateful Interactions SSE writer helpers. Kept here (not in the generic
 * stream-writers module) because step indices and lifetimes are protocol
 * specific; the writer in stream-writers.js delegates step bookkeeping here.
 */
function createInteractionsStreamState({ id, model, now } = {}) {
  const timestamp = now || new Date().toISOString();
  return {
    id: id || `v1_${Date.now().toString(36)}`,
    model,
    created: timestamp,
    stepIndex: -1,
    open: null,
    steps: [],
    status: 'in_progress',
    usage: undefined
  };
}

function encodeStreamEvent(ir) {
  const block = ir.delta?.blocks?.[0];
  if (block?.type === 'text') return { event_type: 'step.delta', index: ir.index || 0, delta: { type: 'text', text: block.text || '' } };
  if (block?.type === 'thinking') {
    if (block.signature && !block.thinking) return { event_type: 'step.delta', index: ir.index || 0, delta: { type: 'thought_signature', signature: block.signature } };
    return { event_type: 'step.delta', index: ir.index || 0, delta: { type: 'thought_summary', content: { type: 'text', text: block.thinking || '' } } };
  }
  if (block?.type === 'tool_call_delta') return { event_type: 'step.delta', index: block.index ?? ir.index ?? 0, delta: { type: 'arguments_delta', arguments: block.argumentsText || '' } };
  if (block?.type === 'tool_call') return { event_type: 'step.start', index: ir.index || 0, step: { type: 'function_call', id: block.id, name: block.name, arguments: block.input || {} } };
  if (ir.eventType === 'interaction.completed' || ir.finishReason) return { event_type: 'interaction.completed', interaction: { id: ir.id, status: statusFor(ir), model: ir.model, usage: encodeUsage(ir.usage) } };
  return { event_type: ir.eventType || 'interaction.status_update', interaction_id: ir.id, status: 'in_progress' };
}

module.exports = {
  decodeRequest,
  encodeRequest: encodeRequest,
  decodeResponse,
  encodeResponse,
  decodeStreamEvent,
  encodeStreamEvent,
  decodeStep,
  contentToBlock,
  blockToContent,
  blocksToSteps,
  decodeUsage,
  encodeUsage,
  statusFor,
  finishReasonFor,
  createInteractionsStreamState,
  CONTENT_TYPES,
  STEP_TYPES
};

function encodeRequest(ir) {
  const body = {};
  if (ir.model) body.model = ir.model;
  const system = (ir.messages || []).filter(message => message.role === 'system' || message.role === 'developer');
  const regular = (ir.messages || []).filter(message => message.role !== 'system' && message.role !== 'developer');
  if (system.length) {
    body.system_instruction = system.flatMap(message => (message.blocks || []).filter(block => block.type === 'text').map(block => block.text)).join('\n');
  }
  body.input = [];
  for (const message of regular) {
    if (message.role === 'assistant') {
      body.input.push({ type: 'model_output', content: (message.blocks || []).map(blockToContent).filter(Boolean) });
    } else {
      body.input.push({ type: 'user_input', content: (message.blocks || []).map(blockToContent).filter(Boolean) });
    }
  }
  if (ir.tools?.length) {
    body.tools = ir.tools.map(tool => withPassthrough({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema || {}
    }, tool.passthrough?.interactions));
  }
  const p = ir.parameters || {};
  const generation = {};
  if (p.maxTokens !== undefined) generation.max_output_tokens = p.maxTokens;
  if (p.stop !== undefined) generation.stop_sequences = Array.isArray(p.stop) ? p.stop : [p.stop];
  if (p.seed !== undefined) generation.seed = p.seed;
  if (p.reasoningEffort !== undefined) generation.thinking_level = String(p.reasoningEffort).toLowerCase();
  if (ir.toolChoice !== undefined) generation.tool_choice = encodeToolChoice(ir.toolChoice);
  if (Object.keys(generation).length) body.generation_config = generation;
  if (p.responseFormat !== undefined) body.response_format = p.responseFormat;
  else if (p.responseSchema) body.response_format = { type: 'text', mime_type: 'application/json', schema: p.responseSchema };
  if (ir.passthrough?.interactions?.serverTools?.length) {
    body.tools = [...(body.tools || []), ...ir.passthrough.interactions.serverTools.map(tool => tool.raw || tool)];
  }
  return withPassthrough(body, ir.passthrough?.interactions);
}
