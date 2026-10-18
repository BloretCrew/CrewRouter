'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const wireShapes = require('../protocol/wire-shapes');
const { normalizeUsageTokens } = require('../utils/token-normalize');
const { responsesToChatCompletion, streamResponsesAsChatCompletion } = require('../utils/responses-upstream');

function parseFrames(text) {
  const frames = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = '';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    const raw = dataLines.join('\n');
    if (!raw) continue;
    if (raw === '[DONE]') {
      frames.push({ event: 'done', data: '[DONE]' });
      continue;
    }
    const data = JSON.parse(raw);
    frames.push({ event: event || data.type || '', data });
  }
  return frames;
}

function readerFrom(chunks) {
  const pending = chunks.map(chunk => typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
  return {
    read: async () => pending.length ? { value: pending.shift(), done: false } : { done: true },
    cancel: async () => {},
    releaseLock() {}
  };
}

function chatResponse() {
  return {
    writableEnded: false,
    chunks: [],
    write(chunk) { this.chunks.push(String(chunk)); return true; },
    end() { this.writableEnded = true; }
  };
}

function responsesResponse() {
  const response = new EventEmitter();
  response.headersSent = true;
  response.writableEnded = false;
  response.chunks = [];
  response.write = chunk => { response.chunks.push(String(chunk)); return true; };
  response.end = () => { response.writableEnded = true; };
  return response;
}

const source = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
function sliceFunction(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  const rest = source.slice(match.index + match[0].length);
  const next = /^(?:async )?function |^router\./m.exec(rest);
  const end = next ? match.index + match[0].length + next.index : source.length;
  return source.slice(match.index, end);
}

const context = vm.createContext({
  Logger: { warn() {}, info() {}, error() {}, stream() {} },
  pluginHooks: { hasSubscribers: () => false },
  normalizeUsageTokens,
  wireShapes
});
for (const name of [
  'safeParseJson',
  'convertResponsesInputToMessages',
  'convertOpenAIToAnthropicResponse',
  'convertChatCompletionToResponse',
  'streamOpenAIAsResponses',
  'streamAnthropicAsResponses'
]) {
  vm.runInContext(sliceFunction(name), context);
}

const forbidden = ['incomplete', 'failed', 'in_progress', 'cancelled', 'canceled'];
for (const status of ['incomplete', 'failed', 'in_progress', 'queued']) {
  const reason = wireShapes.chatFinishReason(status, status, false, status === 'incomplete' ? 'max_output_tokens' : null);
  assert.equal(forbidden.includes(reason), false, reason);
}
assert.equal(wireShapes.chatFinishReason('incomplete', null, false, 'max_output_tokens'), 'length');
assert.equal(wireShapes.chatFinishReason('incomplete', null, false, 'content_filter'), 'content_filter');
assert.equal(wireShapes.chatFinishReason('completed', 'refusal', false, null), 'content_filter');
assert.equal(wireShapes.chatFinishReason('completed', 'tool_use', false, null), 'tool_calls');
assert.equal(wireShapes.chatFinishReason('incomplete', 'length', true, 'max_output_tokens'), 'tool_calls');
assert.equal(wireShapes.anthropicStopReason('length'), 'max_tokens');
assert.equal(wireShapes.anthropicStopReason('content_filter'), 'refusal');
assert.equal(wireShapes.anthropicStopReason('tool_calls'), 'tool_use');
assert.equal(wireShapes.anthropicStopReason('custom_stop'), 'custom_stop');
assert.deepEqual(wireShapes.responsesStatus('max_tokens'), { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
assert.deepEqual(wireShapes.responsesStatus('stop'), { status: 'completed', incomplete_details: null });

const anthropicUsage = wireShapes.anthropicUsage({
  prompt_tokens: 10,
  completion_tokens: 4,
  prompt_tokens_details: { cached_tokens: 3 },
  completion_tokens_details: { reasoning_tokens: 2 }
});
assert.deepEqual(anthropicUsage, {
  input_tokens: 7,
  output_tokens: 4,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 0
});
const responsesUsage = wireShapes.responsesUsage({
  input_tokens: 10,
  output_tokens: 4,
  input_tokens_details: { cached_tokens: 3 },
  output_tokens_details: { reasoning_tokens: 2 }
});
assert.equal(responsesUsage.input_tokens, 10);
assert.equal(responsesUsage.input_tokens_details.cached_tokens, 3);
assert.equal(responsesUsage.output_tokens_details.reasoning_tokens, 2);
assert.equal(responsesUsage.input_tokens_details.cache_write_tokens, 0);
const floatedUsage = wireShapes.responsesUsage({
  input_tokens: 10.9,
  output_tokens: 4.2,
  total_tokens: 15.8,
  input_tokens_details: { cached_tokens: 3.7 },
  output_tokens_details: { reasoning_tokens: 2.9 },
  cache_creation_input_tokens: 1.2
});
assert.equal(floatedUsage.input_tokens, 10);
assert.equal(floatedUsage.output_tokens, 4);
assert.equal(floatedUsage.total_tokens, 15);
assert.equal(floatedUsage.input_tokens_details.cached_tokens, 3);
assert.equal(floatedUsage.output_tokens_details.reasoning_tokens, 2);
assert.equal(floatedUsage.input_tokens_details.cache_write_tokens, 1);
for (const value of [
  floatedUsage.input_tokens,
  floatedUsage.output_tokens,
  floatedUsage.total_tokens,
  floatedUsage.input_tokens_details.cached_tokens,
  floatedUsage.input_tokens_details.cache_write_tokens,
  floatedUsage.output_tokens_details.reasoning_tokens
]) assert.equal(Number.isInteger(value), true);
const cachedFallback = wireShapes.responsesUsage({
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 4, cache_write_tokens: 6 },
  output_tokens_details: { reasoning_tokens: 2 }
}, { promptTokens: 10.4, completionTokens: 1, totalTokens: 11, cachedTokens: 0, cacheCreationTokens: 0 });
assert.equal(cachedFallback.input_tokens, 10);
assert.equal(cachedFallback.input_tokens_details.cached_tokens, 4);
assert.equal(cachedFallback.input_tokens_details.cache_write_tokens, 6);
assert.equal(cachedFallback.output_tokens_details.reasoning_tokens, 2);
assert.deepEqual(wireShapes.responsesTerminal('length', false), { event: 'response.incomplete', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
assert.deepEqual(wireShapes.responsesTerminal('max_tokens', false), { event: 'response.incomplete', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
assert.deepEqual(wireShapes.responsesTerminal('model_context_window_exceeded', false), { event: 'response.incomplete', status: 'incomplete', incomplete_details: { reason: 'max_prompt_tokens' } });
assert.deepEqual(wireShapes.responsesTerminal('content_filter', false), { event: 'response.incomplete', status: 'incomplete', incomplete_details: { reason: 'content_filter' } });
assert.deepEqual(wireShapes.responsesTerminal('refusal', false), { event: 'response.incomplete', status: 'incomplete', incomplete_details: { reason: 'content_filter' } });
assert.equal(wireShapes.responsesTerminal('length', true).event, 'response.completed');
assert.equal(wireShapes.responsesTerminal('length', true).status, 'incomplete');
assert.equal(wireShapes.responsesTerminal('stop', false).event, 'response.completed');
assert.equal(wireShapes.responsesTerminal('stop', false).end_turn, undefined);
assert.equal(wireShapes.terminalToolArguments({ q: 1 }, false), '{"q":1}');
assert.equal(wireShapes.terminalToolArguments({ q: 1 }, false).includes('[object Object]'), false);
assert.equal(wireShapes.terminalToolArguments('{"q":', true), '{"q":');
assert.equal(wireShapes.terminalToolArguments('', false), '{}');
assert.equal(wireShapes.terminalToolArguments('', true), '');
const toolCatalog = wireShapes.createResponsesToolCatalog([
  { type: 'function', name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: {} }, strict: true },
  { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] },
  { type: 'namespace', name: 'editor', tools: [
    { type: 'function', name: 'edit', description: 'Edit a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { type: 'custom', name: 'apply_patch', description: 'Apply a patch' }
  ] },
  { type: 'namespace', name: 'other', tools: [{ type: 'function', name: 'shared', parameters: {} }] },
  { type: 'namespace', name: 'mcp', tools: [{ type: 'function', name: 'shared', parameters: {} }] }
]);
const namespaced = wireShapes.responsesToolWire({ name: 'edit', arguments: { path: 'a' }, callId: 'call_edit', respId: 'resp_ns', index: 0, catalog: toolCatalog, outputIndex: 2 });
assert.equal(namespaced.item.type, 'function_call');
assert.equal(namespaced.item.namespace, 'editor');
assert.equal(namespaced.item.call_id, 'call_edit');
assert.equal(namespaced.item.name, 'edit');
assert.equal(namespaced.item.arguments, '{"path":"a"}');
assert.equal(namespaced.events[0].item.arguments, '');
assert.equal(namespaced.events[1].type, 'response.function_call_arguments.delta');
assert.equal(namespaced.events[1].output_index, 2);
assert.equal(namespaced.events[1].delta, '{"path":"a"}');
assert.equal(namespaced.events[3].type, 'response.output_item.done');
assert.equal(namespaced.events[3].item.arguments, '{"path":"a"}');
const defaultNamespace = wireShapes.responsesToolWire({ name: 'lookup', arguments: '{}', callId: '', respId: 'resp_x', index: 3, catalog: toolCatalog });
assert.equal(defaultNamespace.item.type, 'function_call');
assert.equal(defaultNamespace.item.namespace, undefined);
assert.equal(defaultNamespace.item.call_id, 'fc_resp_x_3');
const customCall = wireShapes.responsesToolWire({ name: 'apply_patch', arguments: '{"input":"*** Begin"}', callId: 'call_p', respId: 'resp', index: 0, catalog: toolCatalog, outputIndex: 1 });
assert.equal(customCall.item.type, 'custom_tool_call');
assert.equal(customCall.item.namespace, 'editor');
assert.equal(customCall.item.input, '*** Begin');
assert.equal(customCall.events[0].item.input, '');
assert.equal(customCall.events[1].type, 'response.custom_tool_call_input.delta');
assert.equal(customCall.events[1].item_id, 'call_p');
assert.equal(customCall.events[1].call_id, 'call_p');
assert.equal(customCall.events[1].delta, '*** Begin');
assert.equal(customCall.events[2].item.input, '*** Begin');
assert.equal(wireShapes.responsesToolWire({ name: 'apply_patch', arguments: 'not-json', callId: 'c', respId: 'resp', index: 0, catalog: toolCatalog }).item.input, 'not-json');
assert.equal(wireShapes.responsesToolWire({ name: 'shared', arguments: '{"a":1}', callId: 's', respId: 'resp', index: 0, catalog: toolCatalog }).item.namespace, undefined);
const liteTools = {
  input: [{
    type: 'additional_tools',
    role: 'developer',
    tools: [
      { type: 'namespace', name: 'functions', description: '', tools: [
        { type: 'custom', name: 'exec', description: 'Run code', format: { type: 'grammar', syntax: 'lark', definition: 'start: SOURCE' } },
        { type: 'function', name: 'wait', description: 'Wait', parameters: { type: 'object', properties: {} } }
      ] },
      { type: 'namespace', name: 'collaboration', description: 'Agents', tools: [
        { type: 'function', name: 'spawn_agent', description: 'Spawn', parameters: { type: 'object', properties: {} } }
      ] }
    ]
  }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '改仓库' }] }]
};
assert.equal(wireShapes.collectResponsesTools(liteTools).length, 2);
assert.equal(wireShapes.collectResponsesTools({ tools: [{ type: 'web_search' }], ...liteTools }).length, 3);
const liteMessages = context.convertResponsesInputToMessages(liteTools);
assert.equal(liteMessages.some(message => message.role === 'system' && message.content === ''), false);
assert.equal(liteMessages[0].role, 'user');
assert.equal(liteMessages[0].content, '改仓库');
const liteHistory = context.convertResponsesInputToMessages({
  input: [
    { type: 'custom_tool_call', call_id: 'call_exec', name: 'exec', input: 'await tools.exec_command({cmd:"ls"})' },
    { type: 'custom_tool_call_output', call_id: 'call_exec', output: 'ok' },
    { type: 'message', role: 'user', content: '继续' }
  ]
});
assert.equal(liteHistory[0].role, 'assistant');
assert.equal(liteHistory[0].tool_calls[0].function.name, 'exec');
assert.equal(liteHistory[0].tool_calls[0].function.arguments, '{"input":"await tools.exec_command({cmd:\\"ls\\"})"}');
assert.equal(liteHistory[1].role, 'tool');
assert.equal(liteHistory[1].tool_call_id, 'call_exec');
assert.equal(liteHistory[1].content, 'ok');
assert.deepEqual(wireShapes.responsesChatTools([
  { type: 'function', name: 'flat', description: 'flat tool', parameters: { type: 'object', properties: {} }, strict: true },
  { type: 'namespace', name: 'editor', tools: [{ type: 'function', name: 'edit', description: 'Edit', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] },
  { type: 'custom', name: 'apply_patch', description: 'Apply a patch' },
  { type: 'web_search' }
]), [
  { type: 'function', function: { name: 'flat', description: 'flat tool', parameters: { type: 'object', properties: {} }, strict: true } },
  { type: 'function', function: { name: 'edit', description: 'Edit', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'apply_patch', description: 'Apply a patch', parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false } } }
]);
assert.deepEqual(wireShapes.thinkingBlock('hmm'), { type: 'thinking', thinking: 'hmm', signature: '' });
assert.equal(typeof wireShapes.thinkingBlock('').signature, 'string');

const assembler = wireShapes.createAnthropicToolAssembler(() => 2);
const splitEvents = [
  ...assembler.push({ index: 0, id: 'call_split', function: { name: 'look' } }),
  ...assembler.push({ index: 0, function: { name: 'up' } }),
  ...assembler.push({ index: 0, function: { arguments: '{"q":1}' } })
];
assert.equal(splitEvents[0].type, 'content_block_start');
assert.equal(splitEvents[0].content_block.name, 'lookup');
assert.deepEqual(splitEvents[0].content_block.input, {});
assert.equal(splitEvents[0].content_block.signature, undefined);
assert.equal(splitEvents[1].delta.type, 'input_json_delta');
assert.equal(splitEvents[1].delta.partial_json, '{"q":1}');
assert.ok(splitEvents.findIndex(event => event.type === 'content_block_start') < splitEvents.findIndex(event => event.delta?.type === 'input_json_delta'));

const plaintext = responsesToChatCompletion({
  status: 'incomplete',
  incomplete_details: { reason: 'max_output_tokens' },
  output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think plainly' }], encrypted_content: 'A'.repeat(80) },
    { type: 'message', content: [{ type: 'output_text', text: 'hi' }] }
  ],
  usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } }
});
assert.equal(plaintext.choices[0].finish_reason, 'length');
assert.equal(plaintext.choices[0].message.reasoning_content, 'think plainly');
assert.equal(plaintext.usage.prompt_tokens, 10);
assert.equal(plaintext.usage.prompt_tokens_details.cached_tokens, 3);
assert.equal(plaintext.usage.completion_tokens_details.reasoning_tokens, 2);
assert.equal(plaintext.usage.cached_tokens, undefined);

const cipher = responsesToChatCompletion({
  status: 'completed',
  output: [{ type: 'reasoning', summary: [], encrypted_content: 'A'.repeat(80) }, { type: 'message', content: [{ type: 'output_text', text: 'hi' }] }]
});
assert.equal(cipher.choices[0].message.reasoning_content, undefined);
assert.equal(wireShapes.chatFinishReason('failed', null, false, null), 'stop');

const filtered = responsesToChatCompletion({
  status: 'incomplete',
  incomplete_details: { reason: 'content_filter' },
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'no' }] }]
});
assert.equal(filtered.choices[0].finish_reason, 'content_filter');

const tooled = responsesToChatCompletion({
  status: 'incomplete',
  incomplete_details: { reason: 'max_output_tokens' },
  output: [{ type: 'function_call', name: 'lookup', call_id: 'call_1', arguments: '{"q":' }]
});
assert.equal(tooled.choices[0].finish_reason, 'tool_calls');

(async () => {
  const chatRes = chatResponse();
  const sse = [
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_done","name":"look"}}',
    '',
    'event: response.output_item.done',
    'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_done","name":"lookup","arguments":"{\\"q\\":1}"}}',
    '',
    'event: response.incomplete',
    'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}}}}',
    ''
  ].join('\n');
  await streamResponsesAsChatCompletion({ getReader: () => readerFrom([sse]) }, chatRes, { model: 'wire' });
  const chatFrames = parseFrames(chatRes.chunks.join(''));
  const toolFrames = chatFrames.filter(frame => frame.data.choices?.[0]?.delta?.tool_calls);
  assert.ok(toolFrames.length >= 1);
  assert.equal(toolFrames[0].data.choices[0].delta.tool_calls[0].function.name, 'lookup');
  assert.equal(toolFrames.some(frame => frame.data.choices[0].delta.tool_calls.some(call => call.function?.name === '')), false);
  const finish = chatFrames.find(frame => frame.data.choices?.[0]?.finish_reason);
  assert.equal(finish.data.choices[0].finish_reason, 'tool_calls');
  assert.equal(finish.data.usage.prompt_tokens_details.cached_tokens, 3);
  assert.equal(finish.data.usage.prompt_tokens, 10);
  assert.ok(chatFrames.some(frame => frame.data === '[DONE]'));

  const cipherRes = chatResponse();
  const cipherSse = 'data: {"type":"response.output_item.added","item":{"type":"reasoning","summary":[],"encrypted_content":"' + 'A'.repeat(80) + '"}}\n\n'
    + 'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
  await streamResponsesAsChatCompletion({ getReader: () => readerFrom([cipherSse]) }, cipherRes, { model: 'wire' });
  assert.equal(cipherRes.chunks.join('').includes('A'.repeat(80)), false);

  const anthropic = context.convertOpenAIToAnthropicResponse({
    id: 'chatcmpl_wire',
    choices: [{
      finish_reason: 'content_filter',
      message: {
        content: 'no',
        reasoning_content: 'hmm',
        tool_calls: [
          { id: 'empty', function: { name: '', arguments: '{}' } },
          { id: 'call_do', function: { name: 'do', arguments: '{"x":1}' } }
        ]
      }
    }],
    usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } }
  }, 'wire-model');
  assert.equal(anthropic.stop_reason, 'refusal');
  assert.equal(anthropic.content[0].signature, '');
  assert.equal(anthropic.content[0].thinking, 'hmm');
  assert.equal(JSON.stringify(anthropic.content.filter(block => block.type === 'tool_use').map(block => block.name)), JSON.stringify(['do']));
  assert.equal(anthropic.usage.input_tokens, 6);
  assert.equal(anthropic.usage.cache_read_input_tokens, 4);

  const responsesJson = context.convertChatCompletionToResponse({
    model: 'wire-model',
    choices: [{
      finish_reason: 'length',
      message: { content: 'cut', reasoning_content: 'think plainly', tool_calls: [{ id: 'call_cut', function: { name: 'lookup', arguments: '{"q":' } }] }
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } }
  }, 'resp_wire', {});
  assert.equal(responsesJson.status, 'incomplete');
  assert.equal(responsesJson.incomplete_details.reason, 'max_output_tokens');
  assert.equal(responsesJson.usage.input_tokens_details.cached_tokens, 3);
  assert.equal(responsesJson.usage.output_tokens_details.reasoning_tokens, 2);
  assert.equal(responsesJson.output.find(item => item.type === 'reasoning').summary[0].text, 'think plainly');
  assert.equal(responsesJson.output.find(item => item.type === 'reasoning').encrypted_content, null);
  assert.equal(responsesJson.output.find(item => item.type === 'function_call').arguments, '{"q":');

  const openAIResponse = responsesResponse();
  const openAIWire = [
    'data: {"choices":[{"delta":{"reasoning_content":"step"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
    'data: [DONE]\n\n'
  ].join('');
  const openAIResult = await context.streamOpenAIAsResponses(
    readerFrom([openAIWire]), new TextDecoder(), openAIResponse, new EventEmitter(), 'resp_len', 'wire-model', {},
    async chunk => openAIResponse.write(chunk), async () => {}
  );
  assert.equal(openAIResult.content, '你好');
  const openAIFrames = parseFrames(openAIResponse.chunks.join(''));
  const reasoningDelta = openAIFrames.find(frame => frame.data.type === 'response.reasoning_summary_text.delta');
  assert.equal(reasoningDelta.data.summary_index, 0);
  assert.equal(reasoningDelta.data.delta, 'step');
  assert.equal(reasoningDelta.data.output_index, 0);
  const textDelta = openAIFrames.find(frame => frame.data.type === 'response.output_text.delta');
  assert.equal(textDelta.data.output_index, 1);
  const completed = openAIFrames.filter(frame => frame.data.type === 'response.completed');
  const incomplete = openAIFrames.filter(frame => frame.data.type === 'response.incomplete');
  assert.equal(completed.length, 0);
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].data.response.status, 'incomplete');
  assert.equal(incomplete[0].data.response.incomplete_details.reason, 'max_output_tokens');
  assert.equal(incomplete[0].data.response.end_turn, undefined);
  assert.equal(incomplete[0].data.response.usage.input_tokens, 10);
  assert.equal(incomplete[0].data.response.usage.input_tokens_details.cached_tokens, 3);
  assert.equal(incomplete[0].data.response.usage.output_tokens_details.reasoning_tokens, 2);
  assert.equal(Number.isInteger(incomplete[0].data.response.usage.input_tokens_details.cache_write_tokens), true);

  const toolResponse = responsesResponse();
  const toolWire = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_test","function":{"name":"look"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"up"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n'
  ].join('');
  await context.streamOpenAIAsResponses(
    readerFrom([toolWire]), new TextDecoder(), toolResponse, new EventEmitter(), 'resp_tool', 'wire-model', {},
    async chunk => toolResponse.write(chunk), async () => {}
  );
  const openaiToolFrames = parseFrames(toolResponse.chunks.join(''));
  const added = openaiToolFrames.find(frame => frame.data.type === 'response.output_item.added' && frame.data.item?.type === 'function_call');
  const done = openaiToolFrames.find(frame => frame.data.type === 'response.output_item.done' && frame.data.item?.type === 'function_call');
  const argDelta = openaiToolFrames.find(frame => frame.data.type === 'response.function_call_arguments.delta');
  assert.equal(added.data.item.name, 'lookup');
  assert.equal(added.data.item.call_id, 'call_test');
  assert.equal(added.data.item.arguments, '');
  assert.equal(done.data.item.call_id, 'call_test');
  assert.equal(done.data.item.name, 'lookup');
  assert.equal(done.data.item.arguments, '{"q":1}');
  assert.equal(argDelta.data.output_index, added.data.output_index);
  assert.equal(argDelta.data.output_index, done.data.output_index);
  assert.equal(argDelta.data.delta, '{"q":1}');
  assert.ok(openaiToolFrames.indexOf(added) < openaiToolFrames.indexOf(argDelta));
  assert.ok(openaiToolFrames.indexOf(argDelta) < openaiToolFrames.indexOf(done));
  assert.equal(openaiToolFrames.some(frame => frame.data.item?.type === 'function_call' && !frame.data.item.name), false);
  assert.equal(openaiToolFrames.filter(frame => frame.data.type === 'response.completed')[0].data.response.status, 'completed');
  assert.equal(openaiToolFrames.some(frame => frame.data.type === 'response.incomplete'), false);

  const anthropicResponse = responsesResponse();
  const anthropicWire = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"why"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好"}}\n\n',
    'data: {"type":"content_block_stop","index":1}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4}}\n\n',
    'data: {"type":"message_stop"}\n\n'
  ].join('');
  await context.streamAnthropicAsResponses(
    readerFrom([anthropicWire]), new TextDecoder(), anthropicResponse, new EventEmitter(), 'resp_ant', 'wire-model', {},
    async chunk => anthropicResponse.write(chunk), async () => {}
  );
  const anthropicFrames = parseFrames(anthropicResponse.chunks.join(''));
  const anthropicReasoning = anthropicFrames.find(frame => frame.data.type === 'response.reasoning_summary_text.delta');
  assert.equal(anthropicReasoning.data.summary_index, 0);
  assert.equal(anthropicReasoning.data.output_index, 0);
  assert.equal(anthropicFrames.find(frame => frame.data.type === 'response.output_text.delta').data.output_index, 1);
  const anthropicCompleted = anthropicFrames.filter(frame => frame.data.type === 'response.completed');
  const anthropicIncomplete = anthropicFrames.filter(frame => frame.data.type === 'response.incomplete');
  assert.equal(anthropicCompleted.length, 0);
  assert.equal(anthropicIncomplete.length, 1);
  assert.equal(anthropicIncomplete[0].data.response.status, 'incomplete');
  assert.equal(anthropicIncomplete[0].data.response.incomplete_details.reason, 'max_output_tokens');
  assert.equal(anthropicIncomplete[0].data.response.usage.input_tokens_details.cached_tokens, 0);
  assert.equal(Number.isInteger(anthropicIncomplete[0].data.response.usage.output_tokens_details.reasoning_tokens), true);
  assert.equal(Number.isInteger(anthropicIncomplete[0].data.response.usage.input_tokens_details.cache_write_tokens), true);

  const signed = responsesResponse();
  const signedWire = 'data: {"type":"content_block_start","content_block":{"type":"thinking","thinking":"","signature":"signed"}}\n\ndata: {"type":"message_stop"}\n\n';
  await assert.rejects(context.streamAnthropicAsResponses(
    readerFrom([signedWire]), new TextDecoder(), signed, new EventEmitter(), 'resp_signed', 'wire-model', {},
    async chunk => signed.write(chunk), async () => {}
  ), error => error.code === 'unsupported_stream_thinking');
  assert.equal(signed.chunks.join('').includes('response.completed'), false);

  const truncatedTool = responsesResponse();
  const truncatedWire = [
    'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"call_cut","name":"lookup"}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n',
    'data: {"type":"content_block_stop"}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":1}}\n\n',
    'data: {"type":"message_stop"}\n\n'
  ].join('');
  await context.streamAnthropicAsResponses(
    readerFrom([truncatedWire]), new TextDecoder(), truncatedTool, new EventEmitter(), 'resp_trunc', 'wire-model', {},
    async chunk => truncatedTool.write(chunk), async () => {}
  );
  const truncatedFrames = parseFrames(truncatedTool.chunks.join(''));
  const truncatedDone = truncatedFrames.find(frame => frame.data.type === 'response.output_item.done' && frame.data.item?.type === 'function_call');
  const truncatedAdded = truncatedFrames.find(frame => frame.data.type === 'response.output_item.added' && frame.data.item?.type === 'function_call');
  const truncatedDelta = truncatedFrames.find(frame => frame.data.type === 'response.function_call_arguments.delta');
  assert.equal(truncatedDone.data.item.call_id, 'call_cut');
  assert.equal(truncatedDone.data.item.name, 'lookup');
  assert.equal(truncatedDone.data.item.arguments, '{"q":');
  assert.equal(truncatedAdded.data.output_index, truncatedDone.data.output_index);
  assert.equal(truncatedDelta.data.output_index, truncatedDone.data.output_index);
  assert.ok(truncatedFrames.indexOf(truncatedAdded) < truncatedFrames.indexOf(truncatedDelta));
  assert.ok(truncatedFrames.indexOf(truncatedDelta) < truncatedFrames.indexOf(truncatedDone));
  assert.equal(truncatedFrames.filter(frame => frame.data.type === 'response.completed').length, 1);
  assert.equal(truncatedFrames.filter(frame => frame.data.type === 'response.completed')[0].data.response.status, 'incomplete');
  assert.equal(truncatedFrames.some(frame => frame.data.type === 'response.incomplete'), false);

  const missingId = responsesResponse();
  const missingWire = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
  await context.streamOpenAIAsResponses(
    readerFrom([missingWire]), new TextDecoder(), missingId, new EventEmitter(), 'resp_missing', 'wire-model', {},
    async chunk => missingId.write(chunk), async () => {}
  );
  const missingDone = parseFrames(missingId.chunks.join('')).find(frame => frame.data.type === 'response.output_item.done');
  assert.equal(missingDone.data.item.call_id, 'fc_resp_missing_0');
  assert.equal(typeof missingDone.data.item.call_id, 'string');
  assert.equal(missingDone.data.item.arguments, '{}');

  const objectArgs = context.convertChatCompletionToResponse({
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'lookup', arguments: { q: 1 } } }] } }]
  }, 'resp_obj', {});
  const objectCall = objectArgs.output.find(item => item.type === 'function_call');
  assert.equal(objectCall.arguments, '{"q":1}');
  assert.equal(objectCall.arguments.includes('[object Object]'), false);
  assert.equal(objectCall.call_id, 'fc_resp_obj_0');

  const namespaceResponse = responsesResponse();
  const namespaceWire = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_edit","function":{"name":"edit","arguments":"{\\"path\\":\\"a\\"}"}},{"index":1,"id":"call_other","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n'
  ].join('');
  await context.streamOpenAIAsResponses(
    readerFrom([namespaceWire]), new TextDecoder(), namespaceResponse, new EventEmitter(), 'resp_ns', 'wire-model', {
      tools: [
        { type: 'namespace', name: 'editor', tools: [{ type: 'function', name: 'edit', parameters: { type: 'object' } }] },
        { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] }
      ]
    },
    async chunk => namespaceResponse.write(chunk), async () => {}
  );
  const namespaceFrames = parseFrames(namespaceResponse.chunks.join(''));
  const textItem = namespaceFrames.find(frame => frame.data.type === 'response.output_item.added' && frame.data.item?.type === 'message');
  const editDone = namespaceFrames.find(frame => frame.data.type === 'response.output_item.done' && frame.data.item?.name === 'edit');
  const lookupDone = namespaceFrames.find(frame => frame.data.type === 'response.output_item.done' && frame.data.item?.name === 'lookup');
  assert.equal(editDone.data.item.type, 'function_call');
  assert.equal(editDone.data.item.namespace, 'editor');
  assert.equal(editDone.data.item.call_id, 'call_edit');
  assert.equal(editDone.data.item.arguments, '{"path":"a"}');
  assert.equal(lookupDone.data.item.namespace, undefined);
  assert.notEqual(textItem.data.output_index, editDone.data.output_index);
  assert.notEqual(editDone.data.output_index, lookupDone.data.output_index);

  const liteResponse = responsesResponse();
  const liteWire = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_exec","function":{"name":"exec","arguments":"{\\"input\\":\\"await tools.exec_command({})\\"}"}},{"index":1,"id":"call_spawn","function":{"name":"spawn_agent","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
  await context.streamOpenAIAsResponses(
    readerFrom([liteWire]), new TextDecoder(), liteResponse, new EventEmitter(), 'resp_lite', 'wire-model', liteTools,
    async chunk => liteResponse.write(chunk), async () => {}
  );
  const liteFrames = parseFrames(liteResponse.chunks.join(''));
  const execDone = liteFrames.find(frame => frame.data.type === 'response.output_item.done' && frame.data.item?.name === 'exec');
  const spawnDone = liteFrames.find(frame => frame.data.type === 'response.output_item.done' && frame.data.item?.name === 'spawn_agent');
  assert.equal(execDone.data.item.type, 'custom_tool_call');
  assert.equal(execDone.data.item.namespace, undefined);
  assert.equal(execDone.data.item.input, 'await tools.exec_command({})');
  assert.equal(spawnDone.data.item.type, 'function_call');
  assert.equal(spawnDone.data.item.namespace, 'collaboration');
  assert.equal(spawnDone.data.item.arguments, '{}');

  const customResponse = responsesResponse();
  const customWire = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_patch","function":{"name":"apply_patch","arguments":"{\\"input\\":\\"*** Begin\\"}"}}]},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
  await context.streamOpenAIAsResponses(
    readerFrom([customWire]), new TextDecoder(), customResponse, new EventEmitter(), 'resp_custom', 'wire-model', {
      tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }]
    },
    async chunk => customResponse.write(chunk), async () => {}
  );
  const customFrames = parseFrames(customResponse.chunks.join(''));
  const customDelta = customFrames.find(frame => frame.data.type === 'response.custom_tool_call_input.delta');
  const customDone = customFrames.find(frame => frame.data.type === 'response.output_item.done');
  assert.equal(customDone.data.item.type, 'custom_tool_call');
  assert.equal(customDone.data.item.call_id, 'call_patch');
  assert.equal(customDone.data.item.name, 'apply_patch');
  assert.equal(customDone.data.item.input, '*** Begin');
  assert.equal(customDone.data.item.namespace, undefined);
  assert.equal(customDelta.data.item_id, 'call_patch');
  assert.equal(customDelta.data.call_id, 'call_patch');
  assert.equal(customDelta.data.delta, '*** Begin');
  assert.equal(customFrames.filter(frame => frame.data.type === 'response.completed').length, 1);
  assert.equal(customFrames.some(frame => frame.data.type === 'response.incomplete'), false);
  assert.equal(customFrames.filter(frame => frame.data.type === 'response.completed')[0].data.response.output[0].input, '*** Begin');

  const { sendGenerationFailure } = require('../utils/generation-failure');
  const failed = responsesResponse();
  sendGenerationFailure(failed, 'resp_fail', 502, { error: { message: 'boom', type: 'server_error' } });
  const failedFrames = parseFrames(failed.chunks.join(''));
  assert.equal(failedFrames.length, 1);
  assert.equal(failedFrames[0].data.type, 'response.failed');
  assert.equal(failedFrames.some(frame => frame.data.type === 'response.completed' || frame.data.type === 'response.incomplete'), false);

  console.log('response wire shape tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
