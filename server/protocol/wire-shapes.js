'use strict';

// 三种客户端出口的线字段。形状对齐仓库内 harness 解析器：
// Grok Chat FinishReason、Grok Messages ContentBlock::Thinking、
// Codex ResponseCompletedUsage / reasoning summary_index、
// Claude Code message usage、OpenCode tool id+name。

const CHAT_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);

function num(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function chatFinishReason(status, finishReason, hasTools, incompleteReason) {
  if (hasTools || finishReason === 'tool_calls' || finishReason === 'function_call' || finishReason === 'tool_use') {
    return finishReason === 'function_call' ? 'function_call' : 'tool_calls';
  }
  if (finishReason === 'length' || finishReason === 'max_tokens') return 'length';
  if (finishReason === 'content_filter' || finishReason === 'refusal' || incompleteReason === 'content_filter') {
    return 'content_filter';
  }
  if (status === 'incomplete' || finishReason === 'incomplete') {
    if (incompleteReason === 'max_output_tokens' || incompleteReason === 'max_tokens') return 'length';
    return 'stop';
  }
  if (CHAT_FINISH_REASONS.has(finishReason)) return finishReason;
  return 'stop';
}

function anthropicStopReason(finishReason) {
  if (!finishReason || finishReason === 'stop' || finishReason === 'end_turn') return 'end_turn';
  if (finishReason === 'length' || finishReason === 'max_tokens') return 'max_tokens';
  if (finishReason === 'tool_calls' || finishReason === 'function_call' || finishReason === 'tool_use') return 'tool_use';
  if (finishReason === 'content_filter' || finishReason === 'refusal') return 'refusal';
  if (finishReason === 'stop_sequence') return 'stop_sequence';
  return finishReason;
}

function responsesStatus(stopReason) {
  if (stopReason === 'length' || stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
    return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  }
  return { status: 'completed', incomplete_details: null };
}

function isAnthropicUsage(usage) {
  if (!usage || usage.prompt_tokens != null || usage.completion_tokens != null) return false;
  // Responses 的 input_tokens 已含缓存，明细在 input_tokens_details，不能按 Anthropic 未缓存输入再加一遍。
  if (usage.input_tokens_details != null || usage.output_tokens_details != null) return false;
  return usage.input_tokens != null || usage.output_tokens != null
    || usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null;
}

function anthropicUsage(usage) {
  const empty = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (!usage) return empty;
  if (isAnthropicUsage(usage)) {
    return {
      input_tokens: num(usage.input_tokens),
      output_tokens: num(usage.output_tokens),
      cache_read_input_tokens: num(usage.cache_read_input_tokens),
      cache_creation_input_tokens: num(usage.cache_creation_input_tokens)
    };
  }
  const prompt = num(usage.prompt_tokens ?? usage.input_tokens);
  const cached = num(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens);
  const created = num(usage.prompt_tokens_details?.cache_creation_tokens ?? usage.cache_creation_input_tokens);
  return {
    input_tokens: Math.max(0, prompt - cached - created),
    output_tokens: num(usage.completion_tokens ?? usage.output_tokens),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: created
  };
}

function chatUsage(usage) {
  if (!usage) {
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 }
    };
  }
  if (isAnthropicUsage(usage)) {
    const cached = num(usage.cache_read_input_tokens);
    const created = num(usage.cache_creation_input_tokens);
    const prompt = num(usage.input_tokens) + cached + created;
    const completion = num(usage.output_tokens);
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: num(usage.total_tokens) || prompt + completion,
      prompt_tokens_details: { cached_tokens: cached },
      completion_tokens_details: { reasoning_tokens: num(usage.output_tokens_details?.reasoning_tokens) }
    };
  }
  const prompt = num(usage.prompt_tokens ?? usage.input_tokens);
  const completion = num(usage.completion_tokens ?? usage.output_tokens);
  const cached = num(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens);
  const reasoning = num(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: num(usage.total_tokens) || prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: reasoning }
  };
}

function responsesUsage(usage, normalized) {
  if (normalized) {
    const input = num(normalized.promptTokens);
    const output = num(normalized.completionTokens);
    return {
      input_tokens: input,
      output_tokens: output,
      total_tokens: num(normalized.totalTokens) || input + output,
      input_tokens_details: { cached_tokens: num(normalized.cachedTokens) },
      output_tokens_details: {
        reasoning_tokens: num(usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens)
      }
    };
  }
  const chat = chatUsage(usage);
  return {
    input_tokens: chat.prompt_tokens,
    output_tokens: chat.completion_tokens,
    total_tokens: chat.total_tokens,
    input_tokens_details: { cached_tokens: chat.prompt_tokens_details.cached_tokens },
    output_tokens_details: { reasoning_tokens: chat.completion_tokens_details.reasoning_tokens }
  };
}

function thinkingBlock(text) {
  return { type: 'thinking', thinking: text || '', signature: '' };
}

function mergeToolName(current, part) {
  if (!part) return current || '';
  if (!current) return part;
  if (part === current || current.endsWith(part)) return current;
  if (part.startsWith(current)) return part;
  return current + part;
}

function terminalToolArguments(text, truncated) {
  const value = text == null ? '' : String(text);
  if (!truncated && value.trim() === '') return '{}';
  return value;
}

function isOpaqueReasoningCiphertext(value) {
  const s = String(value || '').trim();
  if (s.length <= 64 || /\s/.test(s)) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(s);
}

function reasoningItem(id, text) {
  return {
    id,
    type: 'reasoning',
    summary: text ? [{ type: 'summary_text', text: String(text) }] : [],
    encrypted_content: null
  };
}

function reasoningInputItem(id, text) {
  if (isOpaqueReasoningCiphertext(text)) {
    return { type: 'reasoning', id, encrypted_content: String(text).trim(), summary: [] };
  }
  return reasoningItem(id, text);
}

function reasoningAddedEvent(id, outputIndex) {
  return { type: 'response.output_item.added', output_index: outputIndex, item: reasoningItem(id, '') };
}

function reasoningDeltaEvent(id, outputIndex, delta) {
  return {
    type: 'response.reasoning_summary_text.delta',
    item_id: id,
    output_index: outputIndex,
    summary_index: 0,
    delta: delta == null ? '' : String(delta)
  };
}

function reasoningDoneEvents(id, outputIndex, text) {
  const item = reasoningItem(id, text);
  return [
    {
      type: 'response.reasoning_summary_text.done',
      item_id: id,
      output_index: outputIndex,
      summary_index: 0,
      text: text ? String(text) : ''
    },
    { type: 'response.output_item.done', output_index: outputIndex, item }
  ];
}

function responsesReasoningText(output) {
  if (!Array.isArray(output)) return '';
  for (const item of output) {
    if (item?.type !== 'reasoning') continue;
    if (Array.isArray(item.summary) && item.summary.length) {
      const text = item.summary.map(part => part?.text || part?.summary_text || '').join('\n').trim();
      if (text) return text;
    }
    if (Array.isArray(item.content) && item.content.length) {
      const text = item.content.map(part => part?.text || part?.thinking || '').join('').trim();
      if (text) return text;
    }
  }
  return '';
}

function createAnthropicToolAssembler(allocateIndex) {
  const entries = new Map();

  function entryFor(index) {
    if (!entries.has(index)) {
      entries.set(index, {
        index,
        id: '',
        name: '',
        pendingArgs: [],
        opened: false,
        holdName: false,
        blockIndex: null
      });
    }
    return entries.get(index);
  }

  function openEntry(entry) {
    if (entry.opened || !entry.id || !entry.name) return [];
    entry.opened = true;
    entry.holdName = false;
    entry.blockIndex = allocateIndex();
    const events = [{
      type: 'content_block_start',
      index: entry.blockIndex,
      content_block: { type: 'tool_use', id: entry.id, name: entry.name, input: {} }
    }];
    for (const part of entry.pendingArgs) {
      events.push({
        type: 'content_block_delta',
        index: entry.blockIndex,
        delta: { type: 'input_json_delta', partial_json: part }
      });
    }
    entry.pendingArgs = [];
    return events;
  }

  function push(tc) {
    const index = tc?.index ?? 0;
    const entry = entryFor(index);
    if (tc?.id && !entry.id) entry.id = tc.id;
    const fn = tc?.function && typeof tc.function === 'object' ? tc.function : {};
    const namePart = typeof fn.name === 'string' ? fn.name : '';
    const argsPresent = Object.prototype.hasOwnProperty.call(fn, 'arguments');
    const argText = argsPresent && fn.arguments ? String(fn.arguments) : '';
    if (namePart) entry.name = mergeToolName(entry.name, namePart);
    if (namePart && !argsPresent) entry.holdName = true;
    if (argsPresent) entry.holdName = false;
    if (entry.opened) {
      return argText ? [{
        type: 'content_block_delta',
        index: entry.blockIndex,
        delta: { type: 'input_json_delta', partial_json: argText }
      }] : [];
    }
    if (argText) entry.pendingArgs.push(argText);
    if (entry.id && entry.name && !entry.holdName) return openEntry(entry);
    return [];
  }

  function finish() {
    const events = [];
    for (const entry of entries.values()) {
      if (!entry.opened && entry.id && entry.name) {
        entry.holdName = false;
        events.push(...openEntry(entry));
      }
    }
    return events;
  }

  return { push, finish, entries };
}

function createIndexedToolBuffer() {
  const byIndex = new Map();

  function entry(index) {
    if (!byIndex.has(index)) {
      byIndex.set(index, { index, id: '', name: '', pending: [], opened: false, holdName: false });
    }
    return byIndex.get(index);
  }

  function push(index, patch) {
    const item = entry(index);
    if (patch.id && !item.id) item.id = patch.id;
    if (patch.name) item.name = mergeToolName(item.name, patch.name);
    const argsPresent = patch.argumentsPresent === true;
    const argText = patch.arguments ? String(patch.arguments) : '';
    if (patch.name && !argsPresent) item.holdName = true;
    if (argsPresent) item.holdName = false;
    if (item.opened) {
      return { item, opened: false, args: argText ? [argText] : [] };
    }
    if (argText) item.pending.push(argText);
    if (!item.id || !item.name || item.holdName) return { item, opened: false, args: [] };
    item.opened = true;
    item.holdName = false;
    const args = item.pending;
    item.pending = [];
    return { item, opened: true, args };
  }

  function forceRemaining() {
    const rows = [];
    for (const item of byIndex.values()) {
      if (item.opened || !item.id || !item.name) continue;
      item.holdName = false;
      item.opened = true;
      const args = item.pending;
      item.pending = [];
      rows.push({ item, opened: true, args });
    }
    return rows;
  }

  return { push, forceRemaining, byIndex };
}

module.exports = {
  chatFinishReason,
  anthropicStopReason,
  responsesStatus,
  anthropicUsage,
  chatUsage,
  responsesUsage,
  thinkingBlock,
  mergeToolName,
  terminalToolArguments,
  isOpaqueReasoningCiphertext,
  reasoningItem,
  reasoningInputItem,
  reasoningAddedEvent,
  reasoningDeltaEvent,
  reasoningDoneEvents,
  responsesReasoningText,
  createAnthropicToolAssembler,
  createIndexedToolBuffer
};
