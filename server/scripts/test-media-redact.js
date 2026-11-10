'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactMediaForStorage, stringifyMediaForStorage } = require('../utils/media-redact');

function isMarker(value) {
  return typeof value === 'string' && /^\[media redacted: image\/png, \d+ bytes, sha256:[0-9a-f]{16}\]$/.test(value);
}

test('Anthropic base64 image sources are replaced with metadata markers', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'keep me' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }
    ]
  }];
  const redacted = redactMediaForStorage(messages);
  assert.equal(redacted[0].content[0].text, 'keep me');
  assert.equal(redacted[0].content[1].source.media_type, 'image/png');
  assert.ok(isMarker(redacted[0].content[1].source.data));
  assert.equal(JSON.stringify(redacted).includes('iVBORw0KGgo='), false);
});

test('OpenAI string and object image URLs are redacted, remote URLs kept', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: 'data:image/png;base64,AAAA' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB', detail: 'high' } },
      { type: 'image_url', image_url: 'https://example.test/a.png' }
    ]
  }];
  const redacted = redactMediaForStorage(messages);
  assert.ok(isMarker(redacted[0].content[0].image_url));
  assert.ok(redacted[0].content[1].image_url.url.startsWith('[media redacted: image/jpeg'));
  assert.equal(redacted[0].content[1].image_url.detail, 'high');
  assert.equal(redacted[0].content[2].image_url, 'https://example.test/a.png');
});

test('Gemini inlineData and Responses input_file data are redacted', () => {
  const gemini = {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }]
  };
  const redactedGemini = redactMediaForStorage(gemini);
  assert.ok(redactedGemini.contents[0].parts[0].inlineData.data.startsWith('[media redacted: image/png'));

  const responses = {
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_file', file_data: 'data:application/pdf;base64,JVBERi0=', filename: 'a.pdf' }]
    }]
  };
  const redactedResponses = redactMediaForStorage(responses);
  assert.ok(redactedResponses.input[0].content[0].file_data.startsWith('[media redacted: application/pdf'));
  assert.equal(redactedResponses.input[0].content[0].filename, 'a.pdf');
});

test('redaction is idempotent and does not rewrite existing markers', () => {
  const input = { source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const once = redactMediaForStorage(input);
  const twice = redactMediaForStorage(once);
  assert.deepEqual(twice, once);
});

test('stringifyMediaForStorage removes base64 payloads from persisted JSON', () => {
  const payload = new Array(100).fill({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2048) } });
  const sortedJson = stringifyMediaForStorage(payload);
  assert.equal(sortedJson.includes('A'.repeat(100)), false);
  assert.ok(sortedJson.length < 200 * 100, 'redacted JSON should not scale with base64 size');
});
