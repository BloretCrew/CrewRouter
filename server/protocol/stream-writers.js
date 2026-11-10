'use strict';

const wireShapes = require('./wire-shapes');
const geminiCodec = require('./gemini');
const responsesCodec = require('./responses');
const interactionsCodec = require('./interactions');
const { formatSSE, formatDone } = require('./sse');

/**
 * Stateful stream writers: canonical IR stream events -> client wire format.
 *
 * A writer never parses upstream bytes; `server/gateway/bridge-proxy.js`
 * decodes every upstream event to IR first. Writers therefore only need to
 * handle the IR vocabulary (text / thinking / tool_call / tool_call_delta /
 * media / finish / usage) and their own protocol envelopes.
 */

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function textOf(blocks) {
  return (blocks || []).filter(block => block.type === 'text').map(block => block.text || '').join('');
}

function snapshotUsage(usage) {
  return usage && typeof usage === 'object' ? { ...usage } : undefined;
}

function wireUsageFromIr(usage) {
  if (!usage) return undefined;
  const cached = Number(usage.cachedInputTokens || 0);
  const created = Number(usage.cacheCreationInputTokens || 0);
  const input = Number(usage.inputTokens || 0);
  const output = Number(usage.outputTokens || 0);
  return {
    input_tokens: Math.max(0, input - cached - created),
    output_tokens: output,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: created,
    cached_tokens: cached,
    total_tokens: usage.totalTokens !== undefined ? Number(usage.totalTokens) : input + output,
    output_tokens_details: { reasoning_tokens: Number(usage.reasoningTokens || 0) }
  };
}

function chunkText(event) {
  return (event.delta?.blocks || []).map(block => block.type === 'text' ? block.text || '' : '').join('');
}

function createOpenAIWriter(options = {}) {
  const id = options.id || genId('chatcmpl');
  const created = options.created || nowSeconds();
  const model = options.model || 'unknown';
  const write = options.write;
  let usage;
  let finishReason;
  let emittedRole = false;
  const toolStates = new Map();
  let nextFallbackToolIndex = 0;

  function chunk(delta, finish = null, extra = {}) {
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra
    };
  }

  async function emit(payload) {
    await write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function toolState(block) {
    const index = block.index ?? (block.id && [...toolStates.values()].find(state => state.id === block.id)?.index) ?? nextFallbackToolIndex++;
    let state = toolStates.get(index);
    if (!state) {
      state = { index, id: undefined, name: '', argumentsText: '', started: false, complete: false };
      toolStates.set(index, state);
    }
    if (block.id && !state.id) state.id = block.id;
    if (block.name && !state.name) state.name = block.name;
    if (block.type === 'tool_call') {
      if (block.streamDelta) state.argumentsText += block.argumentsText || '';
      else state.argumentsText = block.argumentsText || JSON.stringify(block.input || {});
      state.complete = !block.streamDelta;
    } else {
      state.argumentsText += block.argumentsText || '';
    }
    return state;
  }

  async function emitTool(state) {
    if (!state.started) {
      if (!state.id && !state.name && !state.complete) return;
      state.started = true;
      await emit(chunk({
        tool_calls: [{
          index: state.index,
          ...(state.id ? { id: state.id } : {}),
          type: 'function',
          function: { name: state.name || '', arguments: '' }
        }]
      }));
    }
    if (state.argumentsText) {
      await emit(chunk({
        tool_calls: [{ index: state.index, function: { arguments: state.argumentsText } }]
      }));
      state.argumentsText = '';
    }
  }

  return {
    async push(event) {
      if (!event) return;
      if (event.usage) usage = snapshotUsage(event.usage);
      if (event.finishReason) finishReason = event.finishReason;
      for (const block of event.delta?.blocks || []) {
        if (!emittedRole) {
          emittedRole = true;
          await emit(chunk({ role: 'assistant' }));
        }
        if (block.type === 'text') {
          await emit(chunk({ content: block.text || '' }));
        } else if (block.type === 'thinking') {
          if (block.thinking) await emit(chunk({ reasoning_content: block.thinking }));
        } else if (block.type === 'tool_call' || block.type === 'tool_call_delta') {
          const state = toolState(block);
          await emitTool(state);
        } else if (block.type === 'media' || block.type === 'image') {
          // Chat Completions has no standard model-output media part. Text
          // clients already receive a placeholder from the upstream; don't
          // fabricate an unsupported shape.
        }
      }
    },
    async end(finalEvent = {}) {
      if (!emittedRole) {
        emittedRole = true;
        await emit(chunk({ role: 'assistant' }));
      }
      for (const state of toolStates.values()) {
        if (!state.started || state.argumentsText) await emitTool(state);
      }
      const hasTools = toolStates.size > 0;
      const finalFinish = finalEvent.finishReason || finishReason || 'stop';
      const finalUsage = finalEvent.usage || usage;
      const mapped = wireShapes.chatFinishReason(undefined, finalFinish, hasTools);
      await emit({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: mapped }],
        ...(finalUsage ? { usage: wireShapes.chatUsage(wireUsageFromIr(finalUsage)) } : {})
      });
      await write(formatDone());
    },
    async error(error) {
      await emit({ error: { message: error?.message || String(error), type: 'server_error' } });
      await write(formatDone());
    },
    getUsage() {
      return usage;
    }
  };
}

function createAnthropicWriter(options = {}) {
  const id = options.id || genId('msg');
  const model = options.model || 'unknown';
  const write = options.write;
  let usage;
  let finishReason;
  let blockIndex = -1;
  let current = null;
  const toolStates = new Map();
  let nextToolIndex = 0;

  async function emit(type, payload) {
    const data = { type, ...payload };
    await write(formatSSE({ event: type, data }));
  }

  async function closeBlock() {
    if (!current) return;
    await emit('content_block_stop', { index: current.index });
    current = null;
  }

  async function openBlock(type, contentBlock, kind) {
    await closeBlock();
    blockIndex += 1;
    current = { index: blockIndex, kind };
    await emit('content_block_start', { index: blockIndex, content_block: contentBlock });
  }

  async function ensureTextBlock() {
    if (current?.kind === 'text') return;
    await openBlock('text', { type: 'text', text: '' }, 'text');
  }

  async function ensureThinkingBlock() {
    if (current?.kind === 'thinking') return;
    await openBlock('thinking', { type: 'thinking', thinking: '' }, 'thinking');
  }

  function toolState(block) {
    let index = block.index;
    if (index === undefined && block.id) {
      for (const [key, state] of toolStates) {
        if (state.id === block.id) { index = key; break; }
      }
    }
    if (index === undefined) index = nextToolIndex++;
    let state = toolStates.get(index);
    if (!state) {
      state = { index, id: undefined, name: '', argumentsText: '', opened: false };
      toolStates.set(index, state);
    }
    if (block.id && !state.id) state.id = block.id;
    if (block.name && !state.name) state.name = block.name;
    if (block.type === 'tool_call') {
      if (block.streamDelta) state.argumentsText += block.argumentsText || '';
      else state.argumentsText = block.argumentsText || JSON.stringify(block.input || {});
    } else {
      state.argumentsText += block.argumentsText || '';
    }
    return state;
  }

  async function openTool(state) {
    if (state.opened) return;
    if (!state.id && !state.name) return;
    state.opened = true;
    state.id = state.id || genId('toolu');
    state.name = state.name || 'tool';
    await openBlock('tool_use', { type: 'tool_use', id: state.id, name: state.name, input: {} }, 'tool');
    if (state.argumentsText) {
      await emit('content_block_delta', {
        index: current.index,
        delta: { type: 'input_json_delta', partial_json: state.argumentsText }
      });
      state.argumentsText = '';
    }
  }

  return {
    async push(event) {
      if (!event) return;
      if (event.usage) usage = snapshotUsage(event.usage);
      if (event.finishReason) finishReason = event.finishReason;
      for (const block of event.delta?.blocks || []) {
        if (block.type === 'text') {
          await ensureTextBlock();
          await emit('content_block_delta', { index: current.index, delta: { type: 'text_delta', text: block.text || '' } });
        } else if (block.type === 'thinking') {
          if (block.signature && !block.thinking) {
            if (current?.kind === 'thinking') {
              await emit('content_block_delta', { index: current.index, delta: { type: 'signature_delta', signature: block.signature } });
            }
            continue;
          }
          await ensureThinkingBlock();
          if (block.thinking) {
            await emit('content_block_delta', { index: current.index, delta: { type: 'thinking_delta', thinking: block.thinking } });
          }
          if (block.signature) {
            await emit('content_block_delta', { index: current.index, delta: { type: 'signature_delta', signature: block.signature } });
          }
        } else if (block.type === 'tool_call' || block.type === 'tool_call_delta') {
          const state = toolState(block);
          await openTool(state);
        } else if (block.type === 'media' || block.type === 'image') {
          const source = block.type === 'image'
            ? block.source
            : (block.fileUri
              ? { type: 'url', url: block.fileUri }
              : { type: 'base64', media_type: block.mimeType || 'image/png', data: block.data || '' });
          if (block.type === 'image' || block.mediaType === 'image') {
            await openBlock('image', { type: 'image', source }, 'image');
            await closeBlock();
          }
        }
      }
    },
    async end(finalEvent = {}) {
      for (const state of toolStates.values()) {
        if (!state.opened) await openTool(state);
        if (state.opened && state.argumentsText) {
          await emit('content_block_delta', { index: current?.index ?? 0, delta: { type: 'input_json_delta', partial_json: state.argumentsText } });
          state.argumentsText = '';
        }
      }
      await closeBlock();
      const finalUsage = finalEvent.usage || usage;
      const mapped = wireShapes.anthropicStopReason(finalEvent.finishReason || finishReason || (toolStates.size ? 'tool_calls' : 'stop'));
      await emit('message_delta', {
        delta: { stop_reason: mapped, stop_sequence: finalEvent.stopSequence ?? null },
        ...(finalUsage ? { usage: wireShapes.anthropicUsage(wireUsageFromIr(finalUsage)) } : {})
      });
      await emit('message_stop', {});
    },
    async start() {
      await emit('message_start', {
        message: {
          id,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });
    },
    async error(error) {
      await emit('error', { error: { type: 'api_error', message: error?.message || String(error) } });
    },
    getUsage() {
      return usage;
    }
  };
}

function createResponsesWriter(options = {}) {
  const id = options.id || genId('resp');
  const model = options.model || 'unknown';
  const write = options.write;
  let sequence = 0;
  let nextOutputIndex = 0;
  let usage;
  let finishReason;
  const blocks = [];
  let currentItem = null;
  const toolItems = new Map();

  async function emit(type, payload = {}) {
    const data = { type, sequence_number: sequence++, ...payload };
    await write(formatSSE({ event: type, data }));
  }

  function baseResponse(status, output = []) {
    return {
      id,
      object: 'response',
      created_at: nowSeconds(),
      status,
      model,
      output,
      ...(usage ? { usage: wireShapes.responsesUsage(wireUsageFromIr(usage), {
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cachedTokens: usage.cachedInputTokens,
        cacheCreationTokens: usage.cacheCreationInputTokens,
        reasoningTokens: usage.reasoningTokens
      }) } : {})
    };
  }

  async function closeCurrent() {
    if (!currentItem) return;
    if (currentItem.kind === 'text') {
      currentItem.item.content = [{ type: 'output_text', text: currentItem.text }];
      currentItem.item.status = 'completed';
      await emit('response.output_text.done', { item_id: currentItem.id, output_index: currentItem.outputIndex, content_index: 0, text: currentItem.text });
      await emit('response.content_part.done', { item_id: currentItem.id, output_index: currentItem.outputIndex, content_index: 0, part: { type: 'output_text', text: currentItem.text } });
    } else if (currentItem.kind === 'reasoning') {
      currentItem.item.summary = [{ type: 'summary_text', text: currentItem.text }];
      await emit('response.reasoning_summary_text.done', { item_id: currentItem.id, output_index: currentItem.outputIndex, summary_index: 0, text: currentItem.text });
    }
    await emit('response.output_item.done', {
      output_index: currentItem.outputIndex,
      item: currentItem.item
    });
    currentItem = null;
  }

  async function ensureTextItem() {
    if (currentItem?.kind === 'text') return;
    await closeCurrent();
    const outputIndex = nextOutputIndex++;
    const item = { type: 'message', id: `${id}_msg_${outputIndex}`, role: 'assistant', status: 'in_progress', content: [] };
    currentItem = { kind: 'text', id: item.id, outputIndex, text: '', item };
    await emit('response.output_item.added', { output_index: outputIndex, item });
    await emit('response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '' } });
  }

  async function ensureReasoningItem() {
    if (currentItem?.kind === 'reasoning') return;
    await closeCurrent();
    const outputIndex = nextOutputIndex++;
    const item = { type: 'reasoning', id: `${id}_rs_${outputIndex}`, summary: [] };
    currentItem = { kind: 'reasoning', id: item.id, outputIndex, text: '', item };
    await emit('response.output_item.added', { output_index: outputIndex, item });
  }

  async function emitTool(block) {
    await closeCurrent();
    const key = block.id || `${block.index ?? 0}`;
    let state = toolItems.get(key);
    if (!state) {
      state = { outputIndex: nextOutputIndex++, id: block.id || genId('call'), name: block.name || '', argumentsText: '', added: false, done: false };
      toolItems.set(key, state);
    }
    if (block.id) state.id = block.id;
    if (block.name && !state.name) state.name = block.name;
    if (!state.added) {
      if (block.streamDelta && !state.id && !state.name) return;
      state.added = true;
      await emit('response.output_item.added', {
        output_index: state.outputIndex,
        item: { type: 'function_call', id: state.id, call_id: state.id, name: state.name, arguments: '' }
      });
    }
    if (block.type === 'tool_call' && block.streamDelta) {
      state.argumentsText += block.argumentsText || '';
    } else if (block.type === 'tool_call') {
      state.argumentsText = block.argumentsText || JSON.stringify(block.input || {});
    } else {
      state.argumentsText += block.argumentsText || '';
    }
    const delta = block.type === 'tool_call_delta'
      ? (block.argumentsText || '')
      : (block.argumentsText || '');
    if (delta) {
      await emit('response.function_call_arguments.delta', { item_id: state.id, output_index: state.outputIndex, delta });
    }
  }

  return {
    async start() {
      await emit('response.created', { response: baseResponse('in_progress') });
      await emit('response.in_progress', { response: baseResponse('in_progress') });
    },
    async push(event) {
      if (!event) return;
      if (event.usage) usage = snapshotUsage(event.usage);
      if (event.finishReason) finishReason = event.finishReason;
      for (const block of event.delta?.blocks || []) {
        if (block.type === 'text') {
          await ensureTextItem();
          currentItem.text += block.text || '';
          await emit('response.output_text.delta', { item_id: currentItem.id, output_index: currentItem.outputIndex, content_index: 0, delta: block.text || '' });
        } else if (block.type === 'thinking') {
          if (!block.thinking) continue;
          await ensureReasoningItem();
          currentItem.text += block.thinking;
          currentItem.item.summary = [{ type: 'summary_text', text: currentItem.text }];
          await emit('response.reasoning_summary_text.delta', { item_id: currentItem.id, output_index: currentItem.outputIndex, summary_index: 0, delta: block.thinking });
        } else if (block.type === 'tool_call' || block.type === 'tool_call_delta') {
          await emitTool(block);
        }
        if (block.type !== 'tool_call' && block.type !== 'tool_call_delta') blocks.push(block);
      }
    },
    async end(finalEvent = {}) {
      await closeCurrent();
      for (const state of toolItems.values()) {
        if (state.added && !state.done) {
          state.done = true;
          await emit('response.function_call_arguments.done', { item_id: state.id, output_index: state.outputIndex, arguments: state.argumentsText });
          await emit('response.output_item.done', {
            output_index: state.outputIndex,
            item: { type: 'function_call', id: state.id, call_id: state.id, name: state.name, arguments: state.argumentsText, status: 'completed' }
          });
        }
      }
      const finalFinish = finalEvent.finishReason || finishReason || 'stop';
      const finalUsage = finalEvent.usage || usage;
      const finalBlocks = blocks.slice();
      for (const state of toolItems.values()) {
        let input = {};
        try { input = JSON.parse(state.argumentsText || '{}'); } catch { input = {}; }
        finalBlocks.push({
          type: 'tool_call',
          id: state.id,
          name: state.name,
          input,
          argumentsText: state.argumentsText
        });
      }
      const irResponse = {
        id,
        model,
        finishReason: finalFinish,
        usage: finalUsage,
        message: { role: 'assistant', blocks: finalBlocks },
        passthrough: {}
      };
      const response = responsesCodec.encodeResponse(irResponse);
      if (response.status === 'completed') await emit('response.completed', { response });
      else if (response.status === 'incomplete') await emit('response.incomplete', { response });
      else await emit('response.failed', { response });
    },
    async error(error) {
      await emit('response.failed', {
        response: { ...baseResponse('failed'), error: { message: error?.message || String(error), type: 'server_error' } }
      });
    },
    getUsage() {
      return usage;
    }
  };
}

function createGeminiWriter(options = {}) {
  const write = options.write;
  const alt = options.alt === 'sse' ? 'sse' : 'json';
  const model = options.model;
  const id = options.id || genId('resp');
  let usage;
  let finishReason;
  let wroteAny = false;
  let firstJson = true;
  const toolStates = new Map();

  async function emitChunk(chunk) {
    wroteAny = true;
    if (alt === 'sse') {
      await write(`data: ${JSON.stringify(chunk)}\n\n`);
      return;
    }
    const prefix = firstJson ? '[' : ',';
    firstJson = false;
    await write(prefix + JSON.stringify(chunk));
  }

  function accumulateTool(block) {
    const index = block.index ?? 0;
    let state = toolStates.get(index);
    if (!state) {
      state = { index, id: block.id, name: block.name, argumentsText: '' };
      toolStates.set(index, state);
    }
    if (block.id) state.id = block.id;
    if (block.name) state.name = block.name;
    state.argumentsText += block.argumentsText || '';
    return state;
  }

  function convert(event) {
    return geminiCodec.encodeStreamEvent({
      ...event,
      id,
      model,
      index: 0
    });
  }

  return {
    async start() {},
    async push(event) {
      if (!event) return;
      if (event.usage) usage = snapshotUsage(event.usage);
      if (event.finishReason) finishReason = event.finishReason;
      const blocks = event.delta?.blocks || [];
      const immediate = [];
      for (const block of blocks) {
        if (block.type === 'tool_call' && block.streamDelta) accumulateTool(block);
        else if (block.type === 'tool_call_delta') accumulateTool(block);
        else if (block.type === 'tool_call') immediate.push(block);
        else immediate.push(block);
      }
      if (!immediate.length) return;
      const chunk = convert({ delta: { role: 'assistant', blocks: immediate } });
      if (chunk && Object.keys(chunk).length) await emitChunk(chunk);
    },
    async end(finalEvent = {}) {
      for (const state of toolStates.values()) {
        let input = {};
        try { input = JSON.parse(state.argumentsText || '{}'); } catch { input = {}; }
        const chunk = convert({
          delta: {
            blocks: [{
              type: 'tool_call',
              id: state.id,
              name: state.name,
              input,
              argumentsText: state.argumentsText
            }]
          }
        });
        await emitChunk(chunk);
      }
      const finalUsage = finalEvent.usage || usage;
      const finalFinish = finalEvent.finishReason || finishReason || 'stop';
      const chunk = convert({ finishReason: finalFinish, usage: finalUsage });
      await emitChunk(chunk);
      if (alt === 'json') {
        if (firstJson) await write('[');
        await write(']');
      }
    },
    async error(error) {
      const payload = { error: { code: 502, message: error?.message || String(error), status: 'UNAVAILABLE' } };
      if (alt === 'sse') await write(`data: ${JSON.stringify(payload)}\n\n`);
      else await write(JSON.stringify(payload));
    },
    getUsage() {
      return usage;
    }
  };
}

function createInteractionsWriter(options = {}) {
  const write = options.write;
  const id = options.id || genId('v1');
  const model = options.model;
  const created = new Date().toISOString();
  let sequence = 0;
  let stepIndex = -1;
  let current = null;
  const steps = [];
  let usage;
  let finishReason;
  let toolCalls = 0;

  async function emit(eventType, payload = {}) {
    const data = { ...payload, event_type: eventType };
    await write(formatSSE({ event: eventType, data }));
  }

  function interactionBase(status) {
    return {
      id,
      object: 'interaction',
      status,
      model,
      created,
      updated: new Date().toISOString(),
      ...(usage ? { usage: interactionsCodec.encodeUsage(usage) } : {})
    };
  }

  async function startStep(type, extra = {}) {
    if (current && current.type === type) return current;
    await stopStep();
    stepIndex += 1;
    current = { index: stepIndex, type, content: [], argumentsText: '', ...extra };
    steps.push(current);
    if (type === 'function_call') {
      toolCalls += 1;
      await emit('step.start', {
        index: current.index,
        step: { type: 'function_call', id: current.id, name: current.name, arguments: {} }
      });
    } else {
      await emit('step.start', { index: current.index, step: { type } });
    }
    return current;
  }

  async function stopStep() {
    if (!current) return;
    const finished = current;
    current = null;
    if (finished.type === 'function_call') {
      let args = {};
      try { args = JSON.parse(finished.argumentsText || '{}'); } catch { args = {}; }
      const step = { type: 'function_call', id: finished.id, name: finished.name, arguments: args };
      if (finished.signature) step.signature = finished.signature;
      finished.final = step;
    } else if (finished.type === 'thought') {
      const text = finished.text || '';
      const step = { type: 'thought', ...(finished.signature ? { signature: finished.signature } : {}), ...(text ? { summary: [{ type: 'text', text }] } : {}) };
      finished.final = step;
    } else {
      finished.final = { type: 'model_output', content: finished.content };
    }
    await emit('step.stop', { index: finished.index });
  }

  return {
    async start() {
      await emit('interaction.created', {
        interaction: { id, status: 'in_progress', object: 'interaction', model }
      });
      await emit('interaction.status_update', { interaction_id: id, status: 'in_progress' });
    },
    async push(event) {
      if (!event) return;
      if (event.usage) usage = snapshotUsage(event.usage);
      if (event.finishReason) finishReason = event.finishReason;
      for (const block of event.delta?.blocks || []) {
        if (block.type === 'text' || block.type === 'media' || block.type === 'image') {
          const step = await startStep('model_output');
          const content = interactionsCodec.blockToContent(block);
          if (content) {
            step.content.push(content);
            if (content.type === 'text') {
              await emit('step.delta', { index: step.index, delta: { type: 'text', text: content.text } });
            } else {
              await emit('step.delta', { index: step.index, delta: content });
            }
          }
        } else if (block.type === 'thinking') {
          const step = await startStep('thought');
          if (block.thinking) {
            step.text = (step.text || '') + block.thinking;
            await emit('step.delta', {
              index: step.index,
              delta: { type: 'thought_summary', content: { type: 'text', text: block.thinking } }
            });
          }
          if (block.signature) {
            step.signature = block.signature;
            await emit('step.delta', { index: step.index, delta: { type: 'thought_signature', signature: block.signature } });
          }
        } else if (block.type === 'tool_call' || block.type === 'tool_call_delta') {
          if (block.id && current?.type === 'function_call' && current.id && current.id !== block.id) {
            await stopStep();
          }
          if (block.type === 'tool_call' && !block.streamDelta) {
            const step = await startStep('function_call', { id: block.id, name: block.name });
            step.argumentsText = block.argumentsText || JSON.stringify(block.input || {});
            await emit('step.delta', { index: step.index, delta: { type: 'arguments_delta', arguments: step.argumentsText } });
          } else {
            const step = await startStep('function_call', { id: block.id, name: block.name });
            if (block.id && !step.id) step.id = block.id;
            if (block.name && !step.name) step.name = block.name;
            step.argumentsText += block.argumentsText || '';
            if (block.argumentsText) {
              await emit('step.delta', { index: step.index, delta: { type: 'arguments_delta', arguments: block.argumentsText } });
            }
          }
        }
      }
    },
    async end(finalEvent = {}) {
      await stopStep();
      const finalFinish = finalEvent.finishReason || finishReason || 'stop';
      if (finalEvent.usage) usage = finalEvent.usage;
      let status = 'completed';
      if (toolCalls > 0) status = 'requires_action';
      else if (finalFinish === 'length' || finalFinish === 'max_tokens' || finalFinish === 'content_filter') status = 'incomplete';
      else if (finalFinish === 'error') status = 'failed';
      await emit('interaction.completed', { interaction: interactionBase(status) });
      await write(formatSSE({ event: 'done', data: '[DONE]' }));
    },
    async error(error) {
      await emit('error', { error: { code: 'server_error', message: error?.message || String(error) } });
      await write(formatSSE({ event: 'done', data: '[DONE]' }));
    },
    getUsage() {
      return usage;
    },
    getSteps() {
      return steps.map(step => step.final).filter(Boolean);
    }
  };
}

function createStreamWriter(dialect, options = {}) {
  switch (dialect) {
    case 'openai':
      return createOpenAIWriter(options);
    case 'anthropic':
      return createAnthropicWriter(options);
    case 'responses':
      return createResponsesWriter(options);
    case 'gemini':
      return createGeminiWriter(options);
    case 'interactions':
      return createInteractionsWriter(options);
    default:
      throw new Error(`Unsupported stream writer dialect: ${dialect}`);
  }
}

module.exports = {
  createStreamWriter,
  createOpenAIWriter,
  createAnthropicWriter,
  createResponsesWriter,
  createGeminiWriter,
  createInteractionsWriter
};
