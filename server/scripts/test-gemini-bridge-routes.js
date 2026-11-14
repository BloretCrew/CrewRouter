'use strict';

// Isolated route test for Gemini generateContent / Interactions compatibility.
// No production database, credentials, or network upstreams are used.

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const express = require('express');
const axios = require('axios');
const realUrlValidator = require('../utils/url-validator');

const noop = () => {};
const asyncNoop = async () => {};
const state = { queue: ['route-primary'], provider: null, upstreamPort: null, received: [] };
const mocks = new Map();
const mock = (relative, exports) => mocks.set(path.resolve(__dirname, '..', relative), exports);
const logger = { info: noop, warn: noop, error: noop, debug: noop, stream: noop };
const pool = {
  async query(sql, values = []) {
    if (/SELECT DISTINCT m\.id/.test(sql)) {
      return { rows: state.queue.filter(id => values[0].includes(id)).map(id => ({ id })) };
    }
    if (/SELECT m\.id FROM models m/.test(sql)) {
      return { rows: state.queue.includes(values[0]) ? [{ id: values[0] }] : [] };
    }
    if (/FROM api_key_harness_models/.test(sql)) return { rows: [] };
    if (/FROM api_key_models/.test(sql)) return { rows: state.queue.map(model_id => ({ model_id })) };
    if (/SELECT ak\.current_model_id/.test(sql)) {
      return { rows: [{ current_model_id: state.queue[0], enabled: true, expires_at: null }] };
    }
    if (/SELECT \* FROM models WHERE id/.test(sql)) {
      return { rows: state.queue.includes(values[0]) ? [{ id: values[0], upstream_model_id: `upstream-${values[0]}`, provider: 'local-provider', enabled: true }] : [] };
    }
    if (/SELECT \* FROM providers WHERE id/.test(sql)) return { rows: [{ ...state.provider }] };
    if (/FROM settings/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected database query in isolated route test: ${sql}`);
  }
};
mock('models/database.js', { pool });
mock('logger.js', logger);
mock('config-loader.js', { gateway: { fourth_cache_breakpoint: false } });
mock('provider-lookup.js', { getCacheStatus: () => ({}), resetCacheStats: noop });
mock('middleware/auth.js', { requireAuth: (_req, _res, next) => next(), requireAdmin: (_req, _res, next) => next() });
mock('middleware/oauth-bearer.js', {
  oauthBearer(req, _res, next) {
    req.apiUser = { userId: 1, keyId: 1, username: 'isolated-test', balance: 100, signature: { enabled: false, template: '' }, injectPrompt: '', fusionEnabled: false };
    next();
  }
});
mock('utils/trace-session.js', { recordEvent: asyncNoop });
mock('utils/billing.js', { calculateCost: () => ({ weightedTokens: 0, pointsCost: 0 }) });
mock('utils/quota-data.js', { recordQuotaData: noop });
mock('utils/model-uptime.js', { recordModelCall: noop });
mock('utils/model-test.js', { recordLiveCallTest: noop });
mock('utils/error-records.js', { captureCallError: noop, clientIp: () => '127.0.0.1' });
mock('utils/notifications.js', { notifyUser: asyncNoop, NOTIFICATION_TYPES: {} });
mock('utils/points-deduct.js', { checkQuotaRules: async () => [], calculatePointsToDeduct: async () => 0 });
mock('utils/balance.js', { recordUsageAndDeduct: async () => ({ ok: true, id: 1 }) });
mock('utils/api-signature.js', { buildSignatureForRequest: async () => null, resolveSignatureConfig: () => ({ enabled: false, template: '', source: 'user', keyEnabled: null, keyTemplate: null, userEnabled: false, userTemplate: '' }), preloadSignatureData: async () => ({}), finalizeJsonSignature: async () => ({ header: false, appendContent: false, reason: 'empty' }), finalizeStreamSignature: async () => ({ appended: false, reason: 'empty' }) });
mock('key-refresher.js', { ensureFreshKey: async () => 'local-key-primary' });
mock('plugins/hooks.js', {
  hasSubscribers: () => false,
  apply: async () => ({}),
  applyStatsRecord: async () => ({}),
  applyFinalResponseHeaders: asyncNoop
});
mock('fusion.js', { processFusion: async () => { throw new Error('Fusion is outside this test'); } });
mock('utils/secret-crypto.js', { decryptSecret: value => value });
mock('utils/crewrouter-command.js', { tryHandleCrewRouterCommand: async () => false });

const interactions = new Map();
mock('store/gemini-interactions.js', {
  RETENTION_DAYS: 55,
  newInteractionId: () => `v1_test_${Math.random().toString(36).slice(2, 8)}`,
  ensureInteractionTables: asyncNoop,
  async createInteraction(record) {
    interactions.set(record.id, {
      id: record.id,
      user_id: record.userId,
      api_key_id: record.apiKeyId,
      model_id: record.modelId,
      status: record.status,
      store: record.store !== false,
      request_steps: record.requestSteps || [],
      response_steps: record.responseSteps || [],
      usage: record.usage || null,
      previous_interaction_id: record.previousInteractionId || null,
      created_at: new Date(),
      updated_at: new Date()
    });
    return record.id;
  },
  async getInteraction(id, userId) {
    const row = interactions.get(id);
    return row && row.user_id === userId ? row : null;
  },
  async deleteInteraction(id, userId) {
    const row = interactions.get(id);
    if (!row || row.user_id !== userId) return false;
    interactions.delete(id);
    return true;
  },
  async updateInteraction() { return null; },
  async cleanupExpired() { return 0; },
  abortActive: () => false,
  isActive: () => false,
  registerActive: () => () => {}
});

mock('utils/url-validator.js', {
  ...realUrlValidator,
  async validateUrl(input, options) {
    const target = new URL(input);
    assert.equal(target.origin, `http://127.0.0.1:${state.upstreamPort}`);
    return realUrlValidator.validateUrl(input, { ...options, allowedPrivateOrigins: [target.origin] });
  }
});

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (mocks.has(resolved)) return mocks.get(resolved);
  return originalLoad.call(this, request, parent, isMain);
};

const interceptor = axios.interceptors.request.use(options => {
  const url = new URL(options.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(Number(url.port), state.upstreamPort);
  options.proxy = false;
  return options;
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

function startUpstream() {
  return http.createServer(async (req, res) => {
    const bodyText = await readBody(req);
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { /* keep raw */ }
    state.received.push({ url: req.url, headers: req.headers, body, raw: bodyText });
    const url = req.url;

    if (url.endsWith('/chat/completions')) {
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', model: body.model,
        choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3 }
      }));
    }

    if (url.includes(':streamGenerateContent')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ responseId: 'g1', modelVersion: body.model, candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, index: 0 }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ responseId: 'g1', modelVersion: body.model, candidates: [{ content: { role: 'model', parts: [] }, index: 0, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } })}\n\n`);
      return res.end();
    }

    if (url.includes(':generateContent')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        responseId: 'g2', modelVersion: body.model,
        candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, index: 0, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 }
      }));
    }

    if (url.includes(':countTokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ totalTokens: 42 }));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `unexpected upstream path ${url}` } }));
  });
}

async function startGateway(format, baseSuffix = '') {
  state.provider = {
    id: 'local-provider', name: 'isolated', enabled: true, format,
    base_url: `http://127.0.0.1:${state.upstreamPort}${baseSuffix}`,
    api_key: 'local-key-primary', api_keys: ['local-key-primary'],
    api_key_select_mode: 'order', proxy_enabled: false
  };
  const apiRouter = require('../routes/api');
  const geminiRouter = require('../routes/gemini');
  const app = express();
  app.use(express.json());
  app.use('/v1', apiRouter);
  app.use('/v1', geminiRouter);
  app.use('/v1beta', geminiRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: { message: err.message } }));
  const server = http.createServer(app);
  await listen(server);
  return server;
}

function request(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, method, path: urlPath,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* SSE */ }
        resolve({ status: res.statusCode, text, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function withGateway(callback, format = 'openai', baseSuffix = '') {
  const server = await startGateway(format, baseSuffix);
  try {
    return await callback(server);
  } finally {
    await closeServer(server);
  }
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('Gemini generateContent to OpenAI upstream', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1beta/models/route-primary:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { maxOutputTokens: 16 }
    }, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(out.status, 200);
    assert.equal(out.body.candidates[0].content.parts[0].text, 'hello');
    assert.equal(out.body.candidates[0].finishReason, 'STOP');
    assert.equal(out.body.usageMetadata.promptTokenCount, 2);
    const upstream = state.received.at(-1);
    assert.match(upstream.url, /\/v1\/chat\/completions$/);
    assert.equal(upstream.body.messages[0].content, 'hello');
    assert.equal(upstream.body.max_tokens, 16);
  });
});

test('Gemini streamGenerateContent emits data-only SSE', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1beta/models/route-primary:streamGenerateContent?alt=sse', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }]
    }, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(out.status, 200);
    assert.match(out.text, /^data: /);
    assert.match(out.text, /"text":"hello"/);
    assert.match(out.text, /"finishReason":"STOP"/);
    assert.match(out.text, /"promptTokenCount":2/);
    assert.doesNotMatch(out.text, /\[DONE\]/);
    const upstream = state.received.at(-1);
    assert.match(upstream.url, /\/v1\/chat\/completions$/);
    assert.equal(upstream.body.stream, true);
  });
});

test('Gemini streamGenerateContent defaults to a JSON array', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1beta/models/route-primary:streamGenerateContent', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }]
    }, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(out.status, 200);
    assert.match(out.text, /^\[/);
    const chunks = JSON.parse(out.text);
    assert.ok(chunks.length >= 2);
    assert.equal(chunks.at(-1).candidates[0].finishReason, 'STOP');
  });
});

test('countTokens falls back to an estimate for non-Gemini upstreams', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1beta/models/route-primary:countTokens', {
      contents: [{ role: 'user', parts: [{ text: 'hello world' }] }]
    }, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(out.status, 200);
    assert.ok(out.body.totalTokens > 0);
    assert.equal(out.body.promptTokensDetails[0].modality, 'TEXT');
  });
});

test('Gemini provider serves OpenAI Chat clients', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1/chat/completions', {
      model: 'x', messages: [{ role: 'user', content: 'hello' }]
    }, { Authorization: 'Bearer local-key-primary' });
    assert.equal(out.status, 200);
    assert.equal(out.body.choices[0].message.content, 'hi');
    const upstream = state.received.at(-1);
    assert.match(upstream.url, /\/v1beta\/models\/upstream-route-primary:generateContent$/);
    assert.equal(upstream.headers['x-goog-api-key'], 'local-key-primary');
    assert.equal(upstream.body.contents[0].parts[0].text, 'hello');
  }, 'gemini');
});

test('Gemini provider streams to OpenAI Chat clients', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1/chat/completions', {
      model: 'x', messages: [{ role: 'user', content: 'hello' }], stream: true
    }, { Authorization: 'Bearer local-key-primary' });
    assert.equal(out.status, 200);
    assert.match(out.text, /"content":"hi"/);
    assert.match(out.text, /"finish_reason":"stop"/);
    assert.match(out.text, /data: \[DONE\]/);
    const upstream = state.received.at(-1);
    assert.match(upstream.url, /:streamGenerateContent\?alt=sse$/);
  }, 'gemini');
});

test('Gemini provider serves Anthropic Messages clients', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1/messages', {
      model: 'x', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }]
    }, { 'x-api-key': 'local-key-primary' });
    assert.equal(out.status, 200);
    assert.equal(out.body.content[0].text, 'hi');
    assert.equal(out.body.stop_reason, 'end_turn');
    const upstream = state.received.at(-1);
    assert.match(upstream.url, /:generateContent$/);
    assert.equal(upstream.body.contents[0].parts[0].text, 'hello');
  }, 'gemini');
});

test('Gemini provider streams to Anthropic Messages clients', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1/messages', {
      model: 'x', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hello' }]
    }, { 'x-api-key': 'local-key-primary' });
    assert.equal(out.status, 200);
    const events = [...out.text.matchAll(/^event: (.+)$/gm)].map(match => match[1]);
    assert.equal(events[0], 'message_start');
    assert.ok(events.includes('content_block_delta'));
    assert.ok(events.includes('message_delta'));
    assert.equal(events.at(-1), 'message_stop');
    assert.match(out.text, /"text":"hi"/);
  }, 'gemini');
});

test('Gemini provider serves Responses clients', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1/responses', {
      model: 'x', input: 'hello'
    }, { Authorization: 'Bearer local-key-primary' });
    assert.equal(out.status, 200);
    assert.equal(out.body.status, 'completed');
    assert.equal(out.body.output[0].content[0].text, 'hi');
    const upstream = state.received.at(-1);
    assert.match(upstream.url, /:generateContent$/);
  }, 'gemini');
});

test('Gemini provider streams to Responses clients', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1/responses', {
      model: 'x', input: 'hello', stream: true
    }, { Authorization: 'Bearer local-key-primary' });
    assert.equal(out.status, 200);
    const events = [...out.text.matchAll(/^event: (.+)$/gm)].map(match => match[1]);
    assert.equal(events[0], 'response.created');
    assert.ok(events.includes('response.output_text.delta'));
    assert.equal(events.at(-1), 'response.completed');
  }, 'gemini');
});

test('Interactions non-stream creates and retrieves a stored interaction', async () => {
  await withGateway(async server => {
    const created = await request(server, 'POST', '/v1beta/interactions', {
      model: 'route-primary', input: 'hello'
    }, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(created.status, 200);
    assert.equal(created.body.object, 'interaction');
    assert.equal(created.body.status, 'completed');
    assert.equal(created.body.steps[0].type, 'model_output');
    assert.equal(created.body.steps[0].content[0].text, 'hello');
    const id = created.body.id;
    assert.ok(interactions.has(id));

    const fetched = await request(server, 'GET', `/v1beta/interactions/${id}`, undefined, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.id, id);
    assert.equal(fetched.body.steps.some(step => step.type === 'user_input'), true);
  });
});

test('Interactions previous_interaction_id replays stored turns upstream', async () => {
  await withGateway(async server => {
    const first = await request(server, 'POST', '/v1beta/interactions', {
      model: 'route-primary', input: 'my name is Phil'
    }, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(first.status, 200);
    const second = await request(server, 'POST', '/v1beta/interactions', {
      model: 'route-primary', input: 'what is my name?', previous_interaction_id: first.body.id
    }, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(second.status, 200);
    const upstream = state.received.at(-1);
    assert.equal(upstream.body.messages.length, 3);
    assert.equal(upstream.body.messages[0].content, 'my name is Phil');
    assert.equal(upstream.body.messages[1].role, 'assistant');
    assert.equal(upstream.body.messages[1].content, 'hello');
    assert.equal(upstream.body.messages[2].content, 'what is my name?');
  });
});

test('Interactions store=false keeps the id transient and DELETE removes stored turns', async () => {
  await withGateway(async server => {
    const transient = await request(server, 'POST', '/v1beta/interactions', {
      model: 'route-primary', input: 'hello', store: false
    }, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(transient.status, 200);
    const missing = await request(server, 'GET', `/v1beta/interactions/${transient.body.id}`, undefined, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(missing.status, 404);

    const stored = await request(server, 'POST', '/v1beta/interactions', {
      model: 'route-primary', input: 'hello'
    }, { 'x-goog-api-key': 'local-key-primary' });
    const deleted = await request(server, 'DELETE', `/v1beta/interactions/${stored.body.id}`, undefined, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(deleted.status, 200);
    const gone = await request(server, 'GET', `/v1beta/interactions/${stored.body.id}`, undefined, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(gone.status, 404);
  });
});

test('Interactions inbound works with a Gemini upstream', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1beta/interactions', {
      model: 'route-primary', input: 'hello'
    }, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(out.status, 200);
    assert.equal(out.body.status, 'completed');
    assert.equal(out.body.steps[0].content[0].text, 'hi');
    const upstream = state.received.at(-1);
    assert.match(upstream.url, /:generateContent$/);
    assert.equal(upstream.body.contents[0].parts[0].text, 'hello');
  }, 'gemini');
});

test('Interactions streaming works with a Gemini upstream', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1beta/interactions', {
      model: 'route-primary', input: 'hello', stream: true
    }, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(out.status, 200);
    const events = [...out.text.matchAll(/^event: (.+)$/gm)].map(match => match[1]);
    assert.equal(events[0], 'interaction.created');
    assert.ok(events.includes('step.delta'));
    assert.equal(events.at(-2), 'interaction.completed');
    const upstream = state.received.at(-1);
    assert.match(upstream.url, /:streamGenerateContent\?alt=sse$/);
  }, 'gemini');
});

test('Interactions streaming emits the documented event sequence', async () => {
  await withGateway(async server => {
    const out = await request(server, 'POST', '/v1beta/interactions', {
      model: 'route-primary', input: 'hello', stream: true
    }, { 'x-goog-api-key': 'local-key-primary' });
    assert.equal(out.status, 200);
    const events = [...out.text.matchAll(/^event: (.+)$/gm)].map(match => match[1]);
    assert.equal(events[0], 'interaction.created');
    assert.ok(events.includes('step.start'));
    assert.ok(events.includes('step.delta'));
    assert.ok(events.includes('step.stop'));
    assert.equal(events.at(-2), 'interaction.completed');
    assert.equal(events.at(-1), 'done');
  });
});

(async () => {
  const upstream = startUpstream();
  state.upstreamPort = await listen(upstream);
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}: ${error.message}`);
      console.error(error.stack);
    }
  }
  axios.interceptors.request.eject(interceptor);
  await closeServer(upstream);
  console.log(`Gemini bridge routes: ${tests.length - failed}/${tests.length} passed.`);
  if (failed) process.exitCode = 1;
})();
