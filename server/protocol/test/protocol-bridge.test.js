'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../bridge');
const transforms = require('../../providers/transforms');

test('bridge exposes canonical request/response/stream entry points', () => {
  const ir = bridge.decodeRequest('anthropic', {
    model: 'm', system: 'be strict', messages: [{ role: 'user', content: 'hi' }], max_tokens: 12, stream: true
  });
  const request = bridge.encodeRequest('openai', ir);
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.max_tokens, 12);

  const response = bridge.encodeResponse('anthropic', bridge.decodeResponse('openai', {
    id: 'c1', model: 'm', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
  }));
  assert.equal(response.content[0].text, 'ok');

  const chunk = bridge.encodeStreamEvent('anthropic', bridge.decodeStreamEvent('openai', {
    id: 'c1', model: 'm', choices: [{ delta: { content: 'x' }, finish_reason: null }]
  }));
  assert.equal(chunk.type, 'content_block_delta');
  assert.equal(chunk.delta.text, 'x');
});

test('legacy transforms remain available', () => {
  assert.equal(typeof transforms.getTransform('openai', 'anthropic').request, 'function');
  assert.equal(typeof transforms.registerTransform, 'function');
});

test('unsupported dialects reject explicitly', () => {
  assert.throws(() => bridge.decodeRequest('unknown', {}), error => error.code === 'unsupported_protocol_bridge');
});
