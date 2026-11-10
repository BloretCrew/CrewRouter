'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const bridge = require('../bridge');

function makeMockUpstream() {
  const calls = [];
  return {
    calls,
    async fetch(dialect, body, stream) {
      calls.push({ dialect, body, stream });
      const response = dialect === 'anthropic'
        ? { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } }
        : (dialect === 'gemini'
          ? { responseId: 'g_mock', modelVersion: body.model, candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } }
          : { id: 'chatcmpl_mock', object: 'chat.completion', model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
      const event = dialect === 'anthropic'
        ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
        : (dialect === 'gemini'
          ? { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }
          : { id: 'chatcmpl_mock', object: 'chat.completion.chunk', model: body.model, choices: [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] });
      return { status: 200, body: response, event };
    },
  };
}

function startHarness() {
  const app = express();
  app.use(express.json());
  const upstream = makeMockUpstream();
  app.post('/chat-to-anthropic', async (req, res) => {
    const ir = bridge.decodeRequest('openai', req.body);
    const body = bridge.encodeRequest('anthropic', ir);
    const result = await upstream.fetch('anthropic', body, !!req.body.stream);
    if (req.body.stream) {
      const event = bridge.encodeStreamEvent('openai', bridge.decodeStreamEvent('anthropic', result.event));
      return res.json(event);
    }
    res.json(bridge.encodeResponse('openai', bridge.decodeResponse('anthropic', result.body)));
  });
  app.post('/anthropic-to-openai', async (req, res) => {
    const ir = bridge.decodeRequest('anthropic', req.body);
    const body = bridge.encodeRequest('openai', ir);
    const result = await upstream.fetch('openai', body, !!req.body.stream);
    if (req.body.stream) {
      const event = bridge.encodeStreamEvent('anthropic', bridge.decodeStreamEvent('openai', result.event));
      return res.json(event);
    }
    res.json(bridge.encodeResponse('anthropic', bridge.decodeResponse('openai', result.body)));
  });
  app.post('/gemini-to-openai', async (req, res) => {
    const ir = bridge.decodeRequest('gemini', req.body);
    const body = bridge.encodeRequest('openai', ir);
    const result = await upstream.fetch('openai', body, !!req.body.stream);
    if (req.body.stream) {
      const event = bridge.encodeStreamEvent('gemini', bridge.decodeStreamEvent('openai', result.event));
      return res.json(event);
    }
    res.json(bridge.encodeResponse('gemini', bridge.decodeResponse('openai', result.body)));
  });
  app.post('/openai-to-gemini', async (req, res) => {
    const ir = bridge.decodeRequest('openai', req.body);
    const body = bridge.encodeRequest('gemini', ir);
    const result = await upstream.fetch('gemini', body, !!req.body.stream);
    if (req.body.stream) {
      const event = bridge.encodeStreamEvent('openai', bridge.decodeStreamEvent('gemini', result.event));
      return res.json(event);
    }
    res.json(bridge.encodeResponse('openai', bridge.decodeResponse('gemini', result.body)));
  });
  app.post('/reject/:dialect', (req, res) => {
    try {
      const dialect = req.params.dialect;
      bridge.encodeRequest(dialect, bridge.decodeRequest(dialect, req.body));
      res.status(500).json({ error: 'unexpectedly supported' });
    } catch (error) {
      res.status(error.code === 'unsupported_protocol_bridge' ? 501 : 500).json({ error: error.code });
    }
  });
  return { app, upstream };
}

function request(server, path, body) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({ hostname: '127.0.0.1', port: address.port, method: 'POST', path, headers: { 'content-type': 'application/json' } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('route harness sends bridged OpenAI and Anthropic bodies to mock upstream', async () => {
  const { app, upstream } = startHarness();
  const server = app.listen(0);
  try {
    const address = server.address();
    const openai = { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 12 };
    const anthropic = { model: 'm', system: 'be strict', messages: [{ role: 'user', content: 'hi' }], max_tokens: 12 };
    for (const stream of [false, true]) {
      const chatResult = await request(server, '/chat-to-anthropic', { ...openai, stream });
      assert.equal(chatResult.status, 200);
      const anthropicCall = upstream.calls.at(-1);
      assert.equal(anthropicCall.dialect, 'anthropic');
      assert.equal(anthropicCall.body.max_tokens, 12);
      assert.equal(anthropicCall.body.messages[0].role, 'user');
      assert.equal(anthropicCall.stream, stream);

      const messageResult = await request(server, '/anthropic-to-openai', { ...anthropic, stream });
      assert.equal(messageResult.status, 200);
      const openaiCall = upstream.calls.at(-1);
      assert.equal(openaiCall.dialect, 'openai');
      assert.equal(openaiCall.body.max_tokens, 12);
      assert.equal(openaiCall.body.messages[0].role, 'system');
      assert.equal(openaiCall.stream, stream);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('route harness bridges Gemini requests and responses', async () => {
  const { app, upstream } = startHarness();
  const server = app.listen(0);
  try {
    const gemini = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 12 }
    };
    for (const stream of [false, true]) {
      const toOpenAI = await request(server, '/gemini-to-openai', { ...gemini, stream });
      assert.equal(toOpenAI.status, 200);
      const openAICall = upstream.calls.at(-1);
      assert.equal(openAICall.dialect, 'openai');
      assert.equal(openAICall.body.messages[0].content, 'hi');
      assert.equal(openAICall.body.max_tokens, 12);
      const openAIResponse = await request(server, '/openai-to-gemini', {
        model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 12, stream
      });
      assert.equal(openAIResponse.status, 200);
      const geminiCall = upstream.calls.at(-1);
      assert.equal(geminiCall.dialect, 'gemini');
      assert.equal(geminiCall.body.contents[0].parts[0].text, 'hi');
    }
    const response = await request(server, '/openai-to-gemini', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.body.choices[0].message.content, 'ok');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('route harness sends Anthropic base64 images as OpenAI data URIs', async () => {
  const { app, upstream } = startHarness();
  const server = app.listen(0);
  try {
    const body = {
      model: 'm',
      max_tokens: 8,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }
        ]
      }]
    };
    const result = await request(server, '/anthropic-to-openai', body);
    assert.equal(result.status, 200);
    const call = upstream.calls.at(-1);
    assert.deepEqual(call.body.messages[0].content[1], {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AA==' }
    });
    assert.equal(JSON.stringify(call.body).includes('"media_type"'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
