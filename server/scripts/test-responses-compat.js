'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { filterResponsesLiteHeader, normalizeResponsesError, sendResponsesFailure } = require('../utils/responses-compat');

const liteHeader = 'X-OpenAI-Internal-Codex-Responses-Lite';
const upstreamError = {
  message: 'Lite requires reasoning.context to be all_turns',
  type: 'invalid_request_error',
  code: 'unsupported_value',
  param: 'reasoning.context',
};

function mockResponse(headersSent = false) {
  return {
    headersSent,
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    removedHeaders: [],
    chunks: [],
    removeHeader(name) { this.removedHeaders.push(name); },
    status(status) { this.statusCode = status; return this; },
    json(body) { this.body = body; this.writableEnded = true; },
    write(chunk) { this.chunks.push(chunk); return true; },
    end() { this.writableEnded = true; },
  };
}

const source = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
const context = vm.createContext({
  filterResponsesLiteHeader,
  Logger: { error() {}, info() {} },
  pluginHooks: { hasSubscribers: () => false },
  normalizeUsageTokens: () => ({ promptTokens: 0, completionTokens: 0, cachedTokens: 0 }),
  wireShapes: require('../protocol/wire-shapes'),
});
const headersStart = source.indexOf('function buildUpstreamHeaders(');
const headersEnd = source.indexOf('\n// 清理 base_url', headersStart);
vm.runInContext(source.slice(headersStart, headersEnd), context);

for (const protocol of ['openai', 'anthropic']) {
  const headers = context.buildUpstreamHeaders({ format: protocol }, {
    headers: { [liteHeader]: 'true', 'x-trace-id': 'trace', authorization: 'client-secret' },
  }, { Authorization: 'Bearer provider-secret' });
  assert.equal(headers[liteHeader.toLowerCase()], undefined);
  assert.equal(headers['x-trace-id'], 'trace');
  assert.equal(headers.Authorization, 'Bearer provider-secret');
  assert.equal(headers.authorization, undefined);
}

for (const body of [{}, { reasoning: { effort: 'low' } }]) {
  const headers = context.buildUpstreamHeaders({ format: 'responses' }, { headers: { [liteHeader]: 'true' } }, {});
  filterResponsesLiteHeader(headers, 'responses', body);
  assert.equal(headers[liteHeader.toLowerCase()], undefined);
}
const compatibleHeaders = filterResponsesLiteHeader({ [liteHeader]: 'true' }, 'responses', { reasoning: { context: 'all_turns' } });
assert.equal(compatibleHeaders[liteHeader], 'true');
assert.deepEqual(normalizeResponsesError(JSON.stringify({ error: upstreamError })), upstreamError);
assert.equal(normalizeResponsesError('Bad Gateway').message, 'Bad Gateway');
assert.equal(normalizeResponsesError(null).code, 'upstream_error');

const httpFailure = mockResponse();
sendResponsesFailure(httpFailure, 'resp_test', 400, JSON.stringify({ error: upstreamError }));
assert.equal(httpFailure.statusCode, 400);
assert.deepEqual(httpFailure.body, { error: upstreamError });
assert.deepEqual(httpFailure.removedHeaders, ['Content-Type']);
assert.equal(httpFailure.chunks.length, 0);

const streamFailure = mockResponse(true);
sendResponsesFailure(streamFailure, 'resp_test', 502, { error: upstreamError });
const failureFrame = streamFailure.chunks.join('');
assert.ok(failureFrame.startsWith('event: response.failed\n'));
assert.ok(!failureFrame.includes('response.completed'));
const failureEvent = JSON.parse(failureFrame.split('\ndata: ')[1]);
assert.equal(failureEvent.type, 'response.failed');
assert.equal(failureEvent.response.status, 'failed');
assert.deepEqual(failureEvent.response.error, upstreamError);
assert.equal(streamFailure.writableEnded, true);
sendResponsesFailure(streamFailure, 'resp_test', 502, 'duplicate');
assert.equal(streamFailure.chunks.length, 1);

const toolsStart = source.indexOf('function convertToolsToChatCompletions(');
const toolsEnd = source.indexOf('\n// 将 Responses API text.format', toolsStart);
assert.ok(toolsStart >= 0 && toolsEnd > toolsStart);
vm.runInContext(source.slice(toolsStart, toolsEnd), context);
const convertedTools = JSON.parse(JSON.stringify(context.convertToolsToChatCompletions([
  { type: 'function', name: 'flat', description: 'flat tool', parameters: { type: 'object', properties: {} }, strict: true },
  { type: 'function', function: { name: 'nested', description: 'nested tool', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false } },
  { type: 'function', function: { name: 'input-schema', input_schema: { type: 'object' } } },
  { type: 'function', name: '   ', parameters: {} },
  { type: 'web_search' },
])));
assert.deepEqual(convertedTools, [
  { type: 'function', function: { name: 'flat', description: 'flat tool', parameters: { type: 'object', properties: {} }, strict: true } },
  { type: 'function', function: { name: 'nested', description: 'nested tool', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false } },
  { type: 'function', function: { name: 'input-schema', parameters: { type: 'object' } } },
]);
assert.equal(context.convertToolsToChatCompletions({ type: 'function', name: 'invalid' }), undefined);

const streamsStart = source.indexOf('async function streamOpenAIAsResponses(');
const streamsEnd = source.indexOf('\nasync function proxyOpenAIForResponses', streamsStart);
assert.ok(streamsEnd > streamsStart);
vm.runInContext(source.slice(streamsStart, streamsEnd), context);

(async () => {
  for (const streamFunction of [context.streamOpenAIAsResponses, context.streamAnthropicAsResponses]) {
    const response = mockResponse(true);
    const readError = new Error('upstream connection reset');
    await assert.rejects(streamFunction(
      { read: async () => { throw readError; } }, new TextDecoder(), response,
      new EventEmitter(), 'resp_test', 'test-model', {},
      async chunk => response.write(chunk), async () => {},
    ), error => error === readError);
    sendResponsesFailure(response, 'resp_test', 502, { error: { message: readError.message } });
    assert.ok(response.chunks.join('').includes('response.failed'));
    assert.ok(!response.chunks.join('').includes('response.completed'));
  }

  const response = mockResponse(true);
  const chunks = [new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n')];
  const result = await context.streamOpenAIAsResponses(
    { read: async () => chunks.length ? { value: chunks.shift(), done: false } : { done: true } },
    new TextDecoder(), response, new EventEmitter(), 'resp_test', 'test-model', {},
    async chunk => response.write(chunk), async () => {},
  );
  assert.equal(result.content, '你好');
  assert.ok(response.chunks.join('').includes('response.output_text.delta'));
  assert.ok(response.chunks.join('').includes('response.completed'));
  assert.ok(!response.chunks.join('').includes('response.failed'));

  const toolResponse = mockResponse(true);
  const toolChunks = [new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_test","function":{"name":"lookup","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n')];
  await context.streamOpenAIAsResponses(
    { read: async () => toolChunks.length ? { value: toolChunks.shift(), done: false } : { done: true } },
    new TextDecoder(), toolResponse, new EventEmitter(), 'resp_tool', 'test-model', {},
    async chunk => toolResponse.write(chunk), async () => {},
  );
  assert.ok(toolResponse.chunks.join('').includes('"type":"function_call"'));
  assert.ok(toolResponse.chunks.join('').includes('response.completed'));

  const anthropicResponse = mockResponse(true);
  const anthropicChunks = [new TextEncoder().encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\ndata: {"type":"content_block_stop","index":0}\n\ndata: {"type":"message_stop"}\n\n')];
  const anthropicResult = await context.streamAnthropicAsResponses(
    { read: async () => anthropicChunks.length ? { value: anthropicChunks.shift(), done: false } : { done: true } },
    new TextDecoder(), anthropicResponse, new EventEmitter(), 'resp_anthropic', 'test-model', {},
    async chunk => anthropicResponse.write(chunk), async () => {},
  );
  assert.equal(anthropicResult.content, '你好');
  assert.ok(anthropicResponse.chunks.join('').includes('response.completed'));
  assert.ok(!/event: response\.completed[^\n]*\ndata: [^\n]*"status":"failed"/.test(source));
  console.log('responses compatibility tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
