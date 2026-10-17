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
  assert.equal(completed.length, 1);
  assert.equal(completed[0].data.response.status, 'incomplete');
  assert.equal(completed[0].data.response.incomplete_details.reason, 'max_output_tokens');
  assert.equal(completed[0].data.response.usage.input_tokens, 10);
  assert.equal(completed[0].data.response.usage.input_tokens_details.cached_tokens, 3);
  assert.equal(completed[0].data.response.usage.output_tokens_details.reasoning_tokens, 2);
  assert.equal(openAIFrames.some(frame => frame.data.type === 'response.incomplete'), false);

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
  assert.equal(added.data.item.name, 'lookup');
  assert.equal(added.data.item.arguments, '');
  assert.equal(done.data.item.arguments, '{"q":1}');
  assert.ok(openaiToolFrames.indexOf(added) < openaiToolFrames.indexOf(done));
  assert.equal(openaiToolFrames.some(frame => frame.data.item?.type === 'function_call' && !frame.data.item.name), false);
  assert.equal(openaiToolFrames.filter(frame => frame.data.type === 'response.completed')[0].data.response.status, 'completed');

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
  assert.equal(anthropicCompleted.length, 1);
  assert.equal(anthropicCompleted[0].data.response.status, 'incomplete');
  assert.equal(anthropicCompleted[0].data.response.usage.input_tokens_details.cached_tokens, 0);
  assert.ok(anthropicCompleted[0].data.response.usage.output_tokens_details);

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
  const truncatedDone = truncatedFrames.find(frame => frame.data.type === 'response.output_item.done');
  assert.equal(truncatedDone.data.item.arguments, '{"q":');
  assert.equal(truncatedFrames.filter(frame => frame.data.type === 'response.completed')[0].data.response.status, 'incomplete');

  console.log('response wire shape tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
