'use strict';

const { createSSEParser, formatSSE } = require('../protocol/sse');
const { finalizeStreamSignature } = require('./api-signature');
const { createStreamScrubber } = require('./inject-prompt-stream');
const { normalizeUsageTokens } = require('./token-normalize');
const { scrubInjectedEcho, scrubResponsesApiResult } = require('./inject-prompt-scrub');
const Logger = require('../logger');

// rewriteEvent(data) may asynchronously return a replacement event or null to drop it.
// onEvent observes the original validated event synchronously for metrics.
async function relaySignatureStream({ response, req, res, format, model, provider, onEvent = () => {}, rewriteEvent, write }) {
  const parser = createSSEParser();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const injectPrompt = req.apiUser?.injectPrompt;
  const parts = new Map();
  const responseItems = new Set();
  const responseParts = new Set();
  const responseDoneItems = new Set();
  let content = '';
  let usage = {};
  let terminal = null;
  let candidate = null;
  let activeBlock = null;
  let sawMessageDelta = false;
  let messageStopReason = null;
  let sawDone = false;
  let hasToolCalls = false;
  let disconnected = false;
  let finished = false;
  let sequence = -1;
  let sequenced = false;
  let buffering = false;
  const tail = [];
  const onClose = () => { disconnected = true; };
  const onRequestClose = () => { if (!req.complete) disconnected = true; };
  req.on?.('close', onRequestClose);
  res.on?.('close', onClose);
  const cleanup = () => {
    req.removeListener?.('close', onRequestClose);
    res.removeListener?.('close', onClose);
  };
  const assertConnected = () => {
    if (disconnected || req.aborted || res.destroyed || res.writableEnded || req._requestLifecycle?.signal?.aborted) {
      throw new Error('Client disconnected');
    }
  };
  const send = async data => {
    assertConnected();
    if (sequenced) {
      sequence = Math.max(sequence + 1, Number.isInteger(data.sequence_number) ? data.sequence_number : 0);
      data.sequence_number = sequence;
    }
    await write(formatSSE({ event: data.type, data }));
  };
  const flushTail = async () => {
    for (const data of tail) await send(data);
    tail.length = 0;
    buffering = false;
  };
  const route = async data => {
    if (buffering) tail.push(data);
    else await send(data);
  };
  const keyFor = data => JSON.stringify([data.item_id || '', data.output_index ?? 0, data.content_index ?? 0]);
  const makePart = meta => ({ ...meta, text: '', scrubber: createStreamScrubber(injectPrompt), fed: false, observedText: false, closed: false });
  const responsePart = data => {
    const key = keyFor(data);
    if (!parts.has(key)) parts.set(key, makePart({
      item_id: data.item_id, output_index: data.output_index ?? 0, content_index: data.content_index ?? 0
    }));
    return parts.get(key);
  };
  const deltaFor = (part, text) => format === 'anthropic'
    ? { type: 'content_block_delta', index: part.index, delta: { type: 'text_delta', text } }
    : { type: 'response.output_text.delta', item_id: part.item_id, output_index: part.output_index, content_index: part.content_index, delta: text };
  const recordText = async (part, text) => {
    if (!text) return;
    if (candidate !== part) {
      // 新的非空正文成为签名目标；前一块的 stop 和后续帧一起按原顺序释放。
      await flushTail();
      candidate = part;
    }
    part.text += text;
    content += text;
  };
  const feedText = async (part, text) => {
    if (part.closed) throw new Error('Text delta after text completion');
    part.fed = true;
    if (text) part.observedText = true;
    const clean = part.scrubber.feed(text || '');
    await recordText(part, clean);
    return clean;
  };
  const closePart = async part => {
    if (part.closed) return;
    const residual = part.scrubber.flush();
    await recordText(part, residual);
    if (residual) await route(deltaFor(part, residual));
    part.closed = true;
    if (candidate === part) buffering = true;
  };
  const cleanSnapshot = text => injectPrompt ? scrubInjectedEcho(text, { exactText: injectPrompt }) : text;
  const findPart = (item, outputIndex, contentIndex) => [...parts.values()].find(part =>
    part.content_index === contentIndex && (item?.id ? part.item_id === item.id : part.output_index === outputIndex));
  // 某些兼容上游只在 item.done / terminal 中给出正文快照。
  // 补全既有 message/part 的生命周期，再把快照送入同一净化/历史正文路径。
  const restoreItem = async (item, outputIndex, close = false) => {
    if (item?.type !== 'message' || !Array.isArray(item.content)) return;
    const missing = item.content.map((part, contentIndex) => ({ part, contentIndex }))
      .filter(({ part, contentIndex }) => part?.type === 'output_text'
        && typeof part.text === 'string' && part.text.length > 0
        && !findPart(item, outputIndex, contentIndex)?.observedText
        && !findPart(item, outputIndex, contentIndex)?.closed);
    if (missing.length) {
      const itemKey = item.id || outputIndex;
      if (!responseItems.has(itemKey)) {
        await route({ type: 'response.output_item.added', output_index: outputIndex,
          item: { ...item, status: 'in_progress', content: [] } });
        responseItems.add(itemKey);
      }
      for (const { part, contentIndex } of missing) {
        const meta = { item_id: item.id, output_index: outputIndex, content_index: contentIndex };
        const partKey = keyFor(meta);
        if (!responseParts.has(partKey)) {
          await route({ type: 'response.content_part.added', ...meta, part: { ...part, text: '' } });
          responseParts.add(partKey);
        }
        const state = responsePart(meta);
        const text = await feedText(state, part.text);
        if (text) await route(deltaFor(state, text));
        if (close) {
          await closePart(state);
          await route({ type: 'response.output_text.done', ...meta, text: state.text });
          await route({ type: 'response.content_part.done', ...meta, part: { ...part, text: state.text } });
        }
      }
    }
  };
  const patchItem = (item, outputIndex, suffix = '') => {
    if (item?.type !== 'message' || !Array.isArray(item.content)) return;
    item.content.forEach((part, contentIndex) => {
      if (part?.type !== 'output_text') return;
      const state = findPart(item, outputIndex, contentIndex);
      part.text = state ? state.text + (state === candidate ? suffix : '') : cleanSnapshot(part.text || '');
    });
  };
  const patchResponseEvent = (data, suffix = '') => {
    if (data.type === 'response.output_text.done' || data.type === 'response.content_part.done') {
      const state = parts.get(keyFor(data));
      const text = state ? state.text + (state === candidate ? suffix : '') : null;
      if (data.type === 'response.output_text.done') data.text = text ?? cleanSnapshot(data.text || '');
      else if (data.part?.type === 'output_text') data.part.text = text ?? cleanSnapshot(data.part.text || '');
    }
    if (data.item) patchItem(data.item, data.output_index, suffix);
  };
  const consume = async frame => {
    assertConnected();
    if (frame.event === 'error') throw new Error('Upstream stream reported an error');
    if (frame.done) {
      if (!terminal || sawDone) throw new Error('Unexpected upstream DONE');
      sawDone = true;
      return;
    }
    if (!frame.data) return;
    if (terminal || sawDone) throw new Error('Upstream data after completion');
    let data;
    try { data = JSON.parse(frame.data); } catch { throw new Error('Invalid upstream stream JSON'); }
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') throw new Error('Invalid upstream stream event');
    if (frame.event !== 'message' && frame.event !== data.type) throw new Error('Mismatched upstream stream event');
    if (data.error || ['error', 'response.failed'].includes(data.type)) throw new Error('Upstream stream reported an error');
    onEvent(data);
    if (rewriteEvent) {
      data = await rewriteEvent(data);
      assertConnected();
      if (data === null) return;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') throw new Error('Invalid rewritten stream event');
      if (data.error || ['error', 'response.failed'].includes(data.type)) throw new Error('Rewritten stream reported an error');
    }
    if (Number.isInteger(data.sequence_number)) sequenced = true;

    if (format === 'anthropic') {
      if (sawMessageDelta && !['message_delta', 'message_stop', 'ping'].includes(data.type)) throw new Error('Anthropic data after message delta');
      if (data.type === 'message_start') {
        if (sawMessageDelta || activeBlock || parts.size) throw new Error('Unexpected message_start');
        usage = { ...usage, ...data.message?.usage };
      } else if (data.type === 'content_block_start') {
        if (activeBlock || sawMessageDelta || parts.has(data.index)) throw new Error('Unexpected content block start');
        activeBlock = { index: data.index, type: data.content_block?.type };
        if (!activeBlock.type) throw new Error('Missing content block type');
        if (activeBlock.type === 'tool_use') hasToolCalls = true;
        if (activeBlock.type === 'text') {
          const part = makePart({ index: data.index });
          parts.set(data.index, part);
          data.content_block.text = await feedText(part, data.content_block.text || '');
        }
      } else if (data.type === 'content_block_delta') {
        if (!activeBlock || activeBlock.index !== data.index || sawMessageDelta) throw new Error('Delta without active block');
        if (data.delta?.type === 'text_delta') {
          if (activeBlock.type !== 'text') throw new Error('Text delta in non-text block');
          data.delta.text = await feedText(parts.get(data.index), data.delta.text || '');
        }
      } else if (data.type === 'content_block_stop') {
        if (!activeBlock || activeBlock.index !== data.index) throw new Error('Stop without active block');
        if (activeBlock.type === 'text') await closePart(parts.get(data.index));
        activeBlock = null;
      } else if (data.type === 'message_delta') {
        if (activeBlock) throw new Error('Message delta before block stop');
        sawMessageDelta = true;
        if (data.delta?.stop_reason) messageStopReason = data.delta.stop_reason;
        usage = { ...usage, ...data.usage };
        buffering = true;
      } else if (data.type === 'message_stop') {
        if (activeBlock || !sawMessageDelta || !messageStopReason) throw new Error('Unexpected message stop');
        terminal = data;
        return;
      }
    } else {
      if (['response.completed', 'response.incomplete'].includes(data.type)) {
        for (const [outputIndex, item] of (data.response?.output || []).entries()) {
          await restoreItem(item, outputIndex, true);
          const itemKey = item?.id || outputIndex;
          if (item?.type === 'message' && !responseDoneItems.has(itemKey) && responseItems.has(itemKey)) {
            const done = { type: 'response.output_item.done', output_index: outputIndex, item };
            patchResponseEvent(done);
            await route(done);
            responseDoneItems.add(itemKey);
          }
        }
        // 部分兼容上游省略 text.done；终态本身封闭已观测到的正文。
        for (const part of parts.values()) await closePart(part);
        usage = { ...usage, ...data.response?.usage };
        terminal = data;
        return;
      }
      if (data.type === 'response.output_item.added') responseItems.add(data.item?.id || data.output_index);
      if (data.type === 'response.content_part.added') responseParts.add(keyFor(data));
      if (data.usage) usage = { ...usage, ...data.usage };
      if (data.type === 'response.function_call_arguments.delta' || data.item?.type === 'function_call') hasToolCalls = true;
      if (data.type === 'response.content_part.added' && data.part?.type === 'output_text') {
        data.part.text = await feedText(responsePart(data), data.part.text || '');
      } else if (data.type === 'response.output_text.delta') {
        data.delta = await feedText(responsePart(data), data.delta || '');
      } else if (data.type === 'response.output_text.done' || (data.type === 'response.content_part.done' && data.part?.type === 'output_text')) {
        const part = responsePart(data);
        if (!part.fed) {
          const text = await feedText(part, data.type === 'response.output_text.done' ? data.text : data.part.text);
          if (text) await route(deltaFor(part, text));
        }
        await closePart(part);
        patchResponseEvent(data);
      } else if (data.item?.type === 'message') {
        if (data.type === 'response.output_item.done') {
          await restoreItem(data.item, data.output_index, true);
          responseDoneItems.add(data.item.id || data.output_index);
          for (const part of parts.values()) {
            if (part.item_id === data.item.id || (!part.item_id && part.output_index === data.output_index)) await closePart(part);
          }
        }
        patchResponseEvent(data);
      }
    }
    await route(data);
  };

  let returned = false;
  try {
    while (true) {
      assertConnected();
      const { done, value } = await reader.read();
      assertConnected();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) await consume(frame);
    }
    for (const frame of parser.push(decoder.decode())) await consume(frame);
    for (const frame of parser.end()) await consume(frame);
    if (!terminal) throw Object.assign(new Error('Upstream stream ended without a completion event'), { code: 'upstream_stream_incomplete' });
    returned = true;
    return {
      content,
      usage,
      async finish() {
        if (finished) throw new Error('Stream already finished');
        finished = true;
        try {
          assertConnected();
          let suffix = '';
          const normalized = normalizeUsageTokens(usage, format === 'anthropic' ? 'anthropic' : 'openai');
          try {
            await finalizeStreamSignature(req, { model, provider, providerName: provider?.name, normalized }, {
              format, requestBody: req.body, hasTextContent: !!candidate?.text, hasToolCalls,
              stopReason: messageStopReason,
              emitText: async text => { assertConnected(); suffix = text; }
            });
          } catch (error) {
            assertConnected();
            Logger.warn(`[Signature] 流式签名生成失败: ${error.message}`);
          }
          assertConnected();
          if (suffix && candidate) await send(deltaFor(candidate, suffix));
          for (const data of tail) {
            if (format === 'responses') patchResponseEvent(data, suffix);
            await send(data);
          }
          if (format === 'responses' && terminal.response) {
            if (injectPrompt) scrubResponsesApiResult(terminal.response, injectPrompt);
            (terminal.response.output || []).forEach((item, index) => patchItem(item, index, suffix));
            if (typeof terminal.response.output_text === 'string' && candidate) terminal.response.output_text = content + suffix;
          }
          await send(terminal);
          if (sawDone) { assertConnected(); await write('data: [DONE]\n\n'); }
        } finally {
          cleanup();
        }
      }
    };
  } finally {
    try { await reader.cancel?.(); } catch { /* 已中断的 reader */ }
    reader.releaseLock?.();
    if (!returned) cleanup();
  }
}

module.exports = { relaySignatureStream };
