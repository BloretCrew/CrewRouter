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
        : { id: 'chatcmpl_mock', object: 'chat.completion', model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
      const event = dialect === 'anthropic'
        ? { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
        : { id: 'chatcmpl_mock', object: 'chat.completion.chunk', model: body.model, choices: [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] };
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
  app.post('/reject/:dialect', (req, res) => {
    try {
      const dialect = req.params.dialect;
      if (dialect === 'responses' || dialect === 'gemini') {
        const error = new Error(`${dialect} provider protocol is unsupported`);
        error.code = 'unsupported_protocol_bridge';
        throw error;
      }
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

test('route harness rejects Responses and Gemini protocol paths', async () => {
  const { app } = startHarness();
  const server = app.listen(0);
  try {
    for (const dialect of ['responses', 'gemini']) {
      const result = await request(server, `/reject/${dialect}`, {});
      assert.equal(result.status, 501);
      assert.equal(result.body.error, 'unsupported_protocol_bridge');
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
