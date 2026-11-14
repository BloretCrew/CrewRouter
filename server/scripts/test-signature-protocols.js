'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ReadableStream } = require('node:stream/web');
const ResponsesUpstream = require('../utils/responses-upstream');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function declarationFrom(code, name, prefix = 'async function') {
  const start = code.indexOf(`${prefix} ${name}`);
  assert(start >= 0, `${prefix} ${name}`);
  const end = code.indexOf('\n}', start);
  assert(end > start, `${prefix} ${name}`);
  return code.slice(start, end + 2);
}

test('Responses→Chat stream emits the signature before the terminal chunk and keeps stored content clean', async () => {
  const sse = [
    'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"hello"}',
    'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"hello"}]}],"output_text":"hello","usage":{"input_tokens":3,"output_tokens":2,"input_tokens_details":{"cached_tokens":1}}}}',
    'data: [DONE]',
    ''
  ].join('\n\n') + '\n';
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    }
  });
  const writes = [];
  const res = {
    writableEnded: false,
    write(chunk) { writes.push(chunk); return true; },
    end() { this.writableEnded = true; }
  };

  let hookArgs = null;
  const result = await ResponsesUpstream.streamResponsesAsChatCompletion(stream, res, {
    model: 'test-model',
    onBeforeFinish: async args => {
      hookArgs = args;
      return '\n\nsignature';
    }
  });

  assert.deepEqual({ hasTextContent: hookArgs.hasTextContent, hasToolCalls: hookArgs.hasToolCalls, finishReason: hookArgs.finishReason }, {
    hasTextContent: true,
    hasToolCalls: false,
    finishReason: 'stop'
  });
  assert.equal(result.content, 'hello', 'signature must not leak into the recorded content');
  assert.equal(hookArgs.usage.input_tokens, 3);

  const body = writes.join('');
  const sigIndex = body.indexOf('\\n\\nsignature');
  const finishIndex = body.indexOf('"finish_reason":"stop"');
  const doneIndex = body.indexOf('[DONE]');
  assert(sigIndex >= 0, 'signature chunk written');
  assert(finishIndex > sigIndex, 'signature chunk precedes the finish chunk');
  assert(doneIndex > finishIndex, 'finish chunk precedes [DONE]');
});

test('api.js routes every proxy through the shared finalize helpers', () => {
  const api = read('routes/api.js');
  assert.equal(api.includes('buildSignatureForRequest('), false, 'no direct signature builds in routes');
  assert.equal(api.includes('injectSignatureInto'), false, 'no protocol-specific inject calls in routes');
  assert.equal(api.includes('planStreamSignatureInjection('), false, 'no hand-rolled stream planning in routes');
  assert.equal(api.includes('resolveSignatureMode('), false, 'mode parsing belongs to the helper');

  assert.equal((api.match(/preloadSignatureData\(/g) || []).length, 1, 'preload started once per request');

  const expected = [
    ['proxyOpenAI', 'async function'],
    ['proxyChatToResponses', 'async function'],
    ['proxyViaBridge', 'async function'],
    ['proxyAnthropic', 'async function'],
    ['proxyAnthropicToAnthropic', 'async function'],
    ['proxyOpenAIStreamToAnthropic', 'async function'],
    ['proxyOpenAINonStreamToAnthropic', 'async function'],
    ['streamOpenAIAsResponses', 'async function'],
    ['streamAnthropicAsResponses', 'async function'],
    ['proxyOpenAIForResponses', 'async function'],
    ['proxyAnthropicForResponses', 'async function'],
    ['handleFusionRequest', 'async function'],
    ['streamBridgeAsClient', 'async function'],
  ];
  for (const [name, prefix] of expected) {
    const body = declarationFrom(api, name, prefix);
    assert(
      body.includes('finalizeJsonSignature(') || body.includes('finalizeStreamSignature(') || body.includes('relaySignatureStream('),
      `${name} must use a finalize helper`
    );
  }

  assert(api.includes('onBeforeFinish'), 'Responses→Chat signature hook is wired');
  assert(api.includes('relaySignatureStream'), 'native stream terminal events use the shared relay');
});

test('Fusion synthesizer injects the signature in all four streaming paths', () => {
  const source = read('fusion/synthesizer.js');
  assert(source.includes("require('../utils/api-signature')"));
  assert.equal((source.match(/await injectFusionSignature\(res/g) || []).length, 4);
});

test('responses-upstream exposes onBeforeFinish after tool flushing', () => {
  const source = read('utils/responses-upstream.js');
  const hook = source.indexOf('opts.onBeforeFinish');
  const tools = source.indexOf('toolBuffer.forceRemaining()');
  const finish = source.indexOf('const finishChunk');
  assert(hook > tools && hook < finish, 'hook runs after tools, before the finish chunk');
});
