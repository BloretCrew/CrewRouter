'use strict';

const { isKnownTool, isWriteTool, asObject } = require('./agent-tools');

const MAX_ROUNDS = 6;

function callSignature(call) {
  return `${call.name}:${JSON.stringify(asObject(call.arguments))}`;
}

function noteRepeat(state, call) {
  const sig = callSignature(call);
  if (state.sig === sig) state.count += 1;
  else {
    state.sig = sig;
    state.count = 1;
  }
  return state.count >= 3;
}

function parseArgs(value) {
  return asObject(value);
}

function parseModelResponse(format, body) {
  if (format === 'anthropic') {
    const blocks = Array.isArray(body?.content) ? body.content : [];
    const text = blocks.filter(block => block?.type === 'text').map(block => block.text || '').join('');
    const toolCalls = blocks.filter(block => block?.type === 'tool_use').map(block => ({
      id: String(block.id || ''),
      name: String(block.name || ''),
      arguments: parseArgs(block.input)
    }));
    return { content: text, toolCalls };
  }
  const message = body?.choices?.[0]?.message || {};
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(call => ({
    id: String(call.id || ''),
    name: String(call.function?.name || call.name || ''),
    arguments: parseArgs(call.function?.arguments ?? call.arguments)
  }));
  return { content: message.content || '', toolCalls };
}

function extractUsage(body) {
  const usage = body?.usage || {};
  return {
    prompt_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    completion_tokens: Number(usage.completion_tokens || usage.output_tokens || 0)
  };
}

/**
 * test-model 不访问上游：先列出模型，再提议把其中一个标成 image。
 */
function replyAsTestModel(messages) {
  const list = messages.filter(message => message.tool_name === 'list_models').pop();
  const tagged = messages.some(message => message.tool_name === 'set_model_output_kind');
  if (!list) {
    return {
      content: '我先查看模型。',
      toolCalls: [{ id: 'call_test_list', name: 'list_models', arguments: {} }]
    };
  }
  if (!tagged) {
    let modelId = 'test-image';
    try {
      const parsed = JSON.parse(list.content || '{}');
      if (parsed.models?.[0]?.id) modelId = parsed.models[0].id;
    } catch (_) { /* 列表不是 JSON 时使用默认 id */ }
    return {
      content: '我建议把一个模型标成图像，等待批准。',
      toolCalls: [{ id: 'call_test_kind', name: 'set_model_output_kind', arguments: { id: modelId, output_kind: 'image' } }]
    };
  }
  return { content: '已处理。写入是否生效取决于你是否点了允许。', toolCalls: [] };
}

function unansweredCalls(messages) {
  let assistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant' && Array.isArray(messages[i].tool_calls) && messages[i].tool_calls.length) {
      assistantIndex = i;
      break;
    }
  }
  if (assistantIndex < 0) return [];
  const answered = new Set(
    messages.slice(assistantIndex + 1)
      .filter(message => message.role === 'tool' && message.tool_call_id)
      .map(message => message.tool_call_id)
  );
  return messages[assistantIndex].tool_calls.filter(call => call.id && !answered.has(call.id));
}

function chunkText(text, size = 24) {
  const chunks = [];
  const value = String(text || '');
  for (let i = 0; i < value.length; i += size) chunks.push(value.slice(i, i + size));
  return chunks;
}

/**
 * 只读工具立即执行。遇到写入就停下，调用方负责审批和之后的续跑。
 */
async function runManageLoop({ messages, modelCaller, onEvent, executeRead }) {
  const repeats = { sig: '', count: 0 };
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const pending = unansweredCalls(messages);
    if (!pending.length) {
      const response = await modelCaller(messages);
      const content = response.content || '';
      const toolCalls = (Array.isArray(response.toolCalls) ? response.toolCalls : []).map((call, index) => ({
        id: call.id || `call_${round}_${index}`,
        name: call.name,
        arguments: asObject(call.arguments)
      }));
      for (const chunk of chunkText(content)) {
        await onEvent({ type: 'assistant.delta', payload: { text: chunk } });
      }
      messages.push({
        role: 'assistant',
        content,
        tool_calls: toolCalls.length ? toolCalls : null
      });
      if (!toolCalls.length) {
        return { status: 'completed', messages, content, usage: response.usage || null };
      }
    }
    const calls = unansweredCalls(messages);
    for (const call of calls) {
      if (noteRepeat(repeats, call)) {
        return { status: 'failed', messages, error: '同一工具调用已重复 3 次' };
      }
      await onEvent({ type: 'tool.requested', payload: { id: call.id, name: call.name, arguments: asObject(call.arguments) } });
      if (!isKnownTool(call.name)) {
        const output = { error: '未知工具' };
        messages.push({ role: 'tool', content: JSON.stringify(output), tool_call_id: call.id, tool_name: call.name });
        await onEvent({ type: 'tool.completed', payload: { id: call.id, name: call.name, output } });
        continue;
      }
      if (isWriteTool(call.name)) {
        return {
          status: 'waiting_approval',
          messages,
          approval: { tool_call_id: call.id, tool_name: call.name, arguments: asObject(call.arguments) }
        };
      }
      const output = await executeRead(call.name, asObject(call.arguments));
      messages.push({ role: 'tool', content: JSON.stringify(output), tool_call_id: call.id, tool_name: call.name });
      await onEvent({ type: 'tool.completed', payload: { id: call.id, name: call.name, output } });
    }
  }
  return { status: 'failed', messages, error: '已达到 6 轮上限' };
}

function toOpenAiMessages(messages, system) {
  const out = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content || '' });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      out.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.tool_calls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(asObject(call.arguments)) }
        }))
      });
      continue;
    }
    out.push({ role: message.role, content: message.content || '' });
  }
  return out;
}

function toAnthropicMessages(messages) {
  const out = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: message.content || ''
      };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (message.role === 'assistant') {
      const content = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls || []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: asObject(call.arguments) });
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
      continue;
    }
    out.push({ role: 'user', content: message.content || '' });
  }
  return out;
}

module.exports = {
  MAX_ROUNDS,
  noteRepeat,
  parseModelResponse,
  extractUsage,
  replyAsTestModel,
  unansweredCalls,
  runManageLoop,
  toOpenAiMessages,
  toAnthropicMessages
};
