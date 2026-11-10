'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const swallow = require('../utils/swallow-images');

test('Anthropic messages lose images but keep text and nested tool results', () => {
  const body = {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: 'result' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BB==' } }
          ]
        }
      ]
    }]
  };
  const { messages, strippedCount } = swallow.applySwallowImagesToMessages(body.messages, 'anthropic');
  assert.equal(strippedCount, 1);
  assert.equal(messages[0].content[0].text, 'look');
  assert.equal(messages[0].content[1].type, 'tool_result');
  assert.equal(messages[0].content[1].content, 'result');
  assert.equal(messages[0].content[2].text, swallow.SWALLOW_IMAGE_NOTICE);
});

test('OpenAI image_url parts are stripped without touching text', () => {
  const body = {
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'https://x/a.png' } }] }
    ]
  };
  const { messages, strippedCount } = swallow.applySwallowImagesToMessages(body.messages, 'openai');
  assert.equal(strippedCount, 1);
  assert.equal(messages[0].content, 'rules');
  assert.equal(messages[1].content, `hi\n\n${swallow.SWALLOW_IMAGE_NOTICE}`);
});

test('Responses function_call_output images are stripped', () => {
  const body = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run' }] },
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: [
          { type: 'input_text', text: 'done' },
          { type: 'input_image', image_url: 'data:image/png;base64,AA==' }
        ]
      }
    ]
  };
  const { input, strippedCount } = swallow.applySwallowImagesToResponsesInput(body.input);
  assert.equal(strippedCount, 1);
  assert.deepEqual(input[1].output, [{ type: 'input_text', text: 'done' }]);
  assert.ok(input[0].content.some(part => part.text === swallow.SWALLOW_IMAGE_NOTICE));
});

test('Responses input_file with an image MIME is stripped', () => {
  const body = {
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'file' },
        { type: 'input_file', file_data: 'AA==', mime_type: 'image/png' }
      ]
    }]
  };
  const { input, strippedCount } = swallow.applySwallowImagesToResponsesInput(body.input);
  assert.equal(strippedCount, 1);
  assert.deepEqual(input[0].content.map(part => part.type), ['input_text', 'input_text']);
});

test('Gemini contents lose image parts and gain exactly one notice', () => {
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'describe' },
          { inlineData: { mimeType: 'image/png', data: 'AA==' } },
          { fileData: { mimeType: 'image/jpeg', fileUri: 'https://x/a.jpg' } },
          { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } }
        ]
      }
    ]
  };
  const stripped = swallow.applySwallowImagesToGeminiBody(body);
  assert.equal(stripped, 2);
  assert.deepEqual(body.contents[0].parts.map(part => part.text || Object.keys(part)[0]),
    ['describe', 'inlineData', swallow.SWALLOW_IMAGE_NOTICE]);
});

test('Interactions input strips images in steps and result arrays', () => {
  const body = {
    input: [
      { type: 'user_input', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'AA==', mime_type: 'image/png' }] },
      { type: 'function_result', call_id: 'c1', result: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'BB==', mime_type: 'image/png' }] }
    ]
  };
  const stripped = swallow.applySwallowImagesToInteractionsBody(body);
  assert.equal(stripped, 1);
  assert.deepEqual(body.input[0].content, [{ type: 'text', text: 'look' }]);
  assert.deepEqual(body.input[1].result, [{ type: 'text', text: 'ok' }]);
  assert.deepEqual(body.input[2], {
    type: 'user_input',
    content: [{ type: 'text', text: swallow.SWALLOW_IMAGE_NOTICE }]
  });
});

test('disabling swallow leaves the body untouched and notice is idempotent', () => {
  const req = {
    path: '/v1/messages',
    apiUser: { swallowImages: false },
    body: { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AA==' } }] }] }
  };
  const before = JSON.stringify(req.body);
  assert.equal(swallow.applySwallowImagesIfEnabled(req), false);
  assert.equal(JSON.stringify(req.body), before);

  req.apiUser.swallowImages = true;
  assert.equal(swallow.applySwallowImagesIfEnabled(req), true);
  assert.equal(swallow.applySwallowImagesIfEnabled(req), false);
  const content = req.body.messages[0].content;
  const texts = typeof content === 'string'
    ? [content]
    : content.filter(part => part.text === swallow.SWALLOW_IMAGE_NOTICE).map(part => part.text);
  assert.equal(texts.length, 1);
  assert.equal(texts[0], swallow.SWALLOW_IMAGE_NOTICE);
});
