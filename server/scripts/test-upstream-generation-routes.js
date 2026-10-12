'use strict';

// Run directly with Node; no production database, credentials, or upstreams are used.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const express = require('express');
const axios = require('axios');

const noop = () => {};
const asyncNoop = async () => {};
const state = { queue: ['route-primary'], provider: null, upstreamPort: null };
const intervals = new Set();
const mocks = new Map();
const mock = (relative, exports) => mocks.set(path.resolve(__dirname, '..', relative), exports);
const logger = { info: noop, warn: noop, error: noop, debug: noop, stream: noop };
const pool = {
  async query(sql, values = []) {
    if (/SELECT DISTINCT m\.id/.test(sql)) return { rows: state.queue.map(id => ({ id })) };
    if (/SELECT DISTINCT p\.format/.test(sql)) return { rows: [{ format: state.provider.format }] };
    if (/FROM api_key_harness_models/.test(sql)) return { rows: [] };
    if (/FROM api_key_models/.test(sql)) return { rows: state.queue.map(model_id => ({ model_id })) };
    if (/SELECT current_model_id/.test(sql)) return { rows: [{ current_model_id: state.queue[0] }] };
    if (/SELECT \* FROM models WHERE id/.test(sql)) {
      return { rows: state.queue.includes(values[0]) ? [{ id: values[0], upstream_model_id: `upstream-${values[0]}`, provider: 'local-provider', enabled: true }] : [] };
    }
    if (/SELECT \* FROM providers WHERE id/.test(sql)) return { rows: [{ ...state.provider }] };
    if (/FROM settings/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected database query in isolated route test: ${sql}`);
  },
};
mock('models/database.js', { pool });
mock('logger.js', logger);
mock('config-loader.js', { gateway: { fourth_cache_breakpoint: false } });
mock('provider-lookup.js', { getCacheStatus: () => ({}), resetCacheStats: noop });
mock('middleware/auth.js', { requireAuth: (_req, _res, next) => next(), requireAdmin: (_req, _res, next) => next() });
mock('middleware/oauth-bearer.js', {
  oauthBearer(req, _res, next) {
    req.apiUser = { userId: 1, keyId: 1, username: 'isolated-test', balance: 100, signatureEnabled: false, injectPrompt: '', fusionEnabled: false };
    next();
  },
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
mock('utils/api-signature.js', { buildSignatureForRequest: async () => null });
mock('key-refresher.js', { ensureFreshKey: async () => 'local-key-primary' });
mock('plugins/hooks.js', { hasSubscribers: () => false, applyStatsRecord: async () => ({}), applyFinalResponseHeaders: asyncNoop });
mock('fusion.js', { processFusion: async () => { throw new Error('Fusion is outside this test'); } });
mock('utils/secret-crypto.js', { decryptSecret: value => value });
mock('utils/crewrouter-command.js', { tryHandleCrewRouterCommand: async () => false });

const originalLoad = Module._load;
const originalSetInterval = global.setInterval;
Module._load = function load(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (mocks.has(resolved)) return mocks.get(resolved);
  return originalLoad.call(this, request, parent, isMain);
};
global.setInterval = (...args) => {
  const timer = originalSetInterval(...args);
  intervals.add(timer);
  return timer;
};

// The interceptor only constrains destinations; Axios and proxyFetch remain real.
const interceptor = axios.interceptors.request.use(options => {
  const url = new URL(options.url);
  assert.equal(url.hostname, '127.0.0.1', 'Only the isolated HTTP upstream may be contacted');
  assert.equal(url.protocol, 'http:');
  assert.equal(Number(url.port), state.upstreamPort, 'Only the active fixture upstream port may be contacted');
  options.proxy = false;
  return options;
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, message, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  assert.ok(predicate(), message);
}
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}
async function closeServer(server) {
  if (!server.listening) return;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections();
  await closed;
}

function frame(data, event) {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}
function streamFrames(format) {
  if (format === 'responses') return {
    start: frame({ type: 'response.created', response: { id: 'resp_local', object: 'response', status: 'in_progress', output: [] } }, 'response.created'),
    delta: frame({ type: 'response.output_text.delta', item_id: 'msg_local', output_index: 0, content_index: 0, delta: 'local-text' }, 'response.output_text.delta'),
    end: frame({ type: 'response.completed', response: { id: 'resp_local', object: 'response', status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0 } } }, 'response.completed'),
  };
  if (format === 'anthropic') return {
    start: frame({ type: 'message_start', message: { id: 'msg_local', type: 'message', role: 'assistant', model: 'local', content: [], usage: { input_tokens: 0, output_tokens: 0 } } }, 'message_start') + frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start'),
    delta: frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'local-text' } }, 'content_block_delta'),
    end: frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop') + frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }, 'message_delta') + frame({ type: 'message_stop' }, 'message_stop'),
  };
  return {
    start: frame({ id: 'chatcmpl-local', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta: { role: 'assistant' } }] }),
    delta: frame({ id: 'chatcmpl-local', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta: { content: 'local-text' } }] }),
    end: frame({ id: 'chatcmpl-local', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0 } }) + 'data: [DONE]\n\n',
  };
}

async function fixture(router, { format = 'openai', mode = 'success', fallback = false } = {}) {
  const received = [];
  const timers = new Set();
  const sockets = new Set();
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const entry = { path: req.url, body: JSON.parse(body), auth: req.headers.authorization || req.headers['x-api-key'], closed: false, completed: false };
      received.push(entry);
      res.on('close', () => { entry.closed = true; });
      const httpFailure = /^(rate-limit|server-error)-(text|empty|json|json-null|json-string)-(seconds|date|invalid)$/.exec(mode);
      if (httpFailure) {
        const [, failure, kind, retryKind] = httpFailure;
        const retryAfter = retryKind === 'date' ? 'Wed, 21 Oct 2037 07:28:00 GMT' : retryKind === 'seconds' ? '7' : 'not-a-delay';
        res.writeHead(failure === 'rate-limit' ? 429 : 503, { 'Content-Type': kind === 'text' ? 'text/plain' : 'application/json', 'Retry-After': retryAfter });
        res.end(kind === 'empty' ? '' : kind === 'text' ? 'fixture upstream failure' : kind === 'json-null' ? 'null' : kind === 'json-string' ? '"fixture upstream failure"' : JSON.stringify({ error: { message: 'fixture upstream failure', type: 'rate_limit_error', code: 'fixture_error' } }));
        return;
      }
      if (mode === 'rate-limit') { res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' }); res.end(JSON.stringify({ error: { message: 'limited' } })); return; }
      if (mode === 'server-error') { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'unavailable' } })); return; }
      if (mode === 'reset') return req.socket.destroy();
      if (mode === 'truncated') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1024' });
        res.write('{"id":"partial"');
        const timer = setTimeout(() => { timers.delete(timer); res.destroy(); }, 30);
        timers.add(timer);
        return;
      }
      if (entry.body.stream) {
        const frames = streamFrames(format);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(frames.start);
        const interval = setInterval(() => res.write(frames.delta), 25);
        timers.add(interval);
        res.on('close', () => { clearInterval(interval); timers.delete(interval); });
        if (mode !== 'endless') {
          const timer = setTimeout(() => {
            timers.delete(timer);
            clearInterval(interval);
            timers.delete(interval);
            entry.completed = true;
            res.end(frames.end);
          }, 130);
          timers.add(timer);
        }
        return;
      }
      entry.completed = true;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(format === 'anthropic'
        ? { id: 'msg_local', type: 'message', role: 'assistant', model: 'local', content: [{ type: 'text', text: 'local-text' }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }
        : { id: 'chatcmpl-local', object: 'chat.completion', model: 'local', choices: [{ index: 0, message: { role: 'assistant', content: 'local-text' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
    });
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const upstreamPort = await listen(upstream);
  state.upstreamPort = upstreamPort;
  state.queue = fallback ? ['route-primary', 'route-backup'] : ['route-primary'];
  state.provider = { id: 'local-provider', name: 'isolated', enabled: true, format, base_url: `http://127.0.0.1:${upstreamPort}/v1`, api_key: 'local-key-primary', api_keys: fallback ? ['local-key-primary', 'local-key-backup'] : ['local-key-primary'], api_key_select_mode: 'order', proxy_enabled: false };
  const requestCloses = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.once('close', () => requestCloses.push({ complete: req.complete, responseFinished: res.writableEnded }));
    next();
  });
  app.use('/v1', router);
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return res.destroy(err);
    res.status(500).json({ error: { message: err.message } });
  });
  const gateway = http.createServer(app);
  const port = await listen(gateway);
  return {
    port, received, requestCloses,
    async close() {
      for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
      for (const socket of sockets) socket.destroy();
      await Promise.all([closeServer(gateway), closeServer(upstream)]);
    },
  };
}

function post(f, route, body, cancelOnText = false) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({ hostname: '127.0.0.1', port: f.port, path: `/v1${route}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: 'Bearer isolated-client' } });
    const timeout = setTimeout(() => { request.destroy(); reject(new Error(`Client timed out: ${route}`)); }, 3000);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(value);
    };
    request.on('error', error => finish(error));
    request.on('response', response => {
      let text = '';
      response.on('data', chunk => {
        text += chunk;
        if (cancelOnText && text.includes('local-text')) {
          response.destroy();
          request.destroy();
          finish(null, { status: response.statusCode, text, canceled: true });
        }
      });
      response.on('end', () => finish(null, { status: response.statusCode, headers: response.headers, text }));
      response.on('error', error => finish(error));
    });
    request.end(payload);
  });
}

const chatBody = { model: 'client-requested', messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 };
const responsesBody = { model: 'client-requested', input: 'hello', max_output_tokens: 8, stream: true };

async function main() {
  let router;
  try { router = require('../routes/api'); }
  finally { global.setInterval = originalSetInterval; }
  const tests = [];
  const test = (name, options, run) => tests.push({ name, options, run });
  for (const stream of [false, true]) {
    for (const cacheKey of ['stable-cache-key', '', undefined]) {
      test(`Chat prompt_cache_key ${cacheKey === undefined ? 'absent' : JSON.stringify(cacheKey)} stream=${stream}`, {}, async f => {
        const body = { ...chatBody, stream };
        if (cacheKey !== undefined) body.prompt_cache_key = cacheKey;
        const result = await post(f, '/chat/completions', body);
        assert.equal(result.status, 200, result.text);
        assert.equal(f.received.length, 1);
        assert.equal(f.received[0].path, '/v1/chat/completions');
        assert.equal(f.received[0].body.prompt_cache_key, cacheKey);
        assert.equal(Object.hasOwn(f.received[0].body, 'prompt_cache_key'), cacheKey !== undefined);
      });
    }
  }
  for (const mode of ['truncated', 'reset']) {
    for (const route of ['/chat/completions', '/responses']) {
      test(`${route} ${mode}: no backup Key/model generation`, { mode, fallback: true }, async f => {
        const body = route === '/responses' ? { ...responsesBody, stream: false } : chatBody;
        const result = await post(f, route, body);
        await sleep(80);
        assert.equal(f.received.length, 1, `Unsafe resend after ${mode}: ${JSON.stringify(f.received.map(e => ({ model: e.body.model, key: e.auth })))}`);
        assert.ok(result.status >= 400, `Expected visible upstream failure, got ${result.status}: ${result.text}`);
        assert.equal(f.received[0].body.model, 'upstream-route-primary');
      });
    }
  }
  for (const format of ['responses', 'openai', 'anthropic']) {
    test(`Responses ${format}: client disconnect closes upstream`, { format, mode: 'endless', fallback: true }, async f => {
      const result = await post(f, '/responses', responsesBody, true);
      assert.equal(result.status, 200, result.text);
      assert.equal(result.canceled, true, result.text);
      assert.equal(f.received[0].path, format === 'responses' ? '/v1/responses' : format === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
      await eventually(() => f.received[0]?.closed, `${format} upstream remains connected after client disconnect`);
      await sleep(80);
      assert.equal(f.received.length, 1, 'Client cancellation must not generate on another Key/model');
      assert.equal(f.received[0].completed, false);
    });
    test(`Responses ${format}: normal req.close does not cancel stream`, { format }, async f => {
      const result = await post(f, '/responses', responsesBody);
      assert.equal(result.status, 200, result.text);
      assert.ok(result.text.includes('local-text'), result.text);
      assert.ok(result.text.includes('response.completed'), result.text);
      assert.equal(f.received.length, 1);
      assert.equal(f.received[0].completed, true);
      assert.ok(f.requestCloses.some(event => event.complete && !event.responseFinished), 'Must observe normal request close before streamed response finishes');
    });
  }
  for (const stream of [false, true]) {
    test(`Responses to OpenAI preserves cache key stream=${stream}`, {}, async f => {
      const result = await post(f, '/responses', { ...responsesBody, stream, prompt_cache_key: 'stable-responses-key' });
      assert.equal(result.status, 200, result.text);
      assert.equal(f.received[0].body.prompt_cache_key, 'stable-responses-key');
    });
  }
  for (const mode of ['rate-limit', 'server-error']) {
    test(`Chat ${mode}: no proxy/Key/model regeneration`, { mode, fallback: true }, async f => {
      const result = await post(f, '/chat/completions', chatBody);
      assert.equal(result.status, mode === 'rate-limit' ? 429 : 503, result.text);
      assert.equal(f.received.length, 1);
      if (mode === 'rate-limit') assert.equal(result.headers['retry-after'], '7');
    });
  }
  test('Chat to Anthropic preserves tool-result cache blocks', { format: 'anthropic' }, async f => {
    const content = [{ type: 'text', text: 'result', cache_control: { type: 'ephemeral', ttl: '1h' } }];
    const result = await post(f, '/chat/completions', { ...chatBody, messages: [{ role: 'tool', tool_call_id: 'tool-1', content }] });
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(f.received[0].body.messages[0].content[0].content, content);
  });
  test('Native Anthropic redacted_thinking.data and thinking.signature are preserved', { format: 'anthropic' }, async f => {
    const content = [
      { type: 'thinking', thinking: 'opaque thought', signature: 'sig+/=opaque' },
      { type: 'redacted_thinking', data: 'opaque+/=\n特殊字符' },
      { type: 'redacted_thinking', data: '' },
      { type: 'text', text: 'prior answer' },
    ];
    const result = await post(f, '/messages', { model: 'client-requested', max_tokens: 8, messages: [{ role: 'assistant', content }, { role: 'user', content: 'continue' }] });
    assert.equal(result.status, 200, result.text);
    assert.equal(f.received.length, 1);
    assert.equal(f.received[0].path, '/v1/messages');
    assert.deepEqual(f.received[0].body.messages[0].content, content);
  });
  for (const route of ['/chat/completions', '/messages', '/responses']) {
    for (const format of route === '/messages' ? ['openai', 'anthropic'] : ['openai', 'anthropic', 'responses']) {
      for (const stream of route === '/responses' ? [false, true] : [false]) {
        for (const kind of ['text', 'empty', 'json', 'json-null', 'json-string']) {
          for (const retryKind of ['seconds', 'date']) {
            test(`${route} ${format} stream=${stream}: 429 ${kind} Retry-After ${retryKind}`, { format, mode: `rate-limit-${kind}-${retryKind}`, fallback: true }, async f => {
              const requestBody = route === '/responses' ? { ...responsesBody, stream } : { ...chatBody, stream };
              const result = await post(f, route, requestBody);
              assert.equal(result.status, 429, result.text);
              assert.equal(result.headers['retry-after'], retryKind === 'date' ? 'Wed, 21 Oct 2037 07:28:00 GMT' : '7');
              assert.ok(result.headers['content-type'].includes('application/json'), result.text);
              const error = JSON.parse(result.text).error;
              assert.ok(error && typeof error.message === 'string' && error.message.length > 0, result.text);
              if (kind === 'text' || kind === 'json') assert.equal(error.message, 'fixture upstream failure');
              if (kind === 'json' && route === '/responses' && format === 'responses') assert.equal(error.code, 'fixture_error');
              await sleep(20);
              assert.equal(f.received.length, 1, 'HTTP failures must not regenerate via proxy/Key/model fallback');
              assert.equal(f.received[0].body.model, 'upstream-route-primary');
            });
          }
        }
        for (const kind of ['text', 'empty', 'json']) {
          test(`${route} ${format} stream=${stream}: 503 ${kind} no regeneration`, { format, mode: `server-error-${kind}-date`, fallback: true }, async f => {
            const result = await post(f, route, route === '/responses' ? { ...responsesBody, stream } : { ...chatBody, stream });
            assert.equal(result.status, 503, result.text);
            assert.equal(result.headers['retry-after'], 'Wed, 21 Oct 2037 07:28:00 GMT');
            assert.ok(JSON.parse(result.text).error.message, result.text);
            await sleep(20);
            assert.equal(f.received.length, 1, '5xx must not regenerate via proxy/Key/model fallback');
          });
        }
        test(`${route} ${format} stream=${stream}: invalid Retry-After omitted`, { format, mode: 'rate-limit-text-invalid' }, async f => {
          const result = await post(f, route, route === '/responses' ? { ...responsesBody, stream } : { ...chatBody, stream });
          assert.equal(result.status, 429, result.text);
          assert.equal(result.headers['retry-after'], undefined);
          assert.equal(f.received.length, 1);
        });
      }
    }
  }
  let failed = 0;
  for (const { name, options, run } of tests) {
    let f;
    try {
      f = await fixture(router, options);
      await run(f);
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}\n${error.stack}`);
    } finally {
      if (f) await f.close();
    }
  }
  console.log(`Upstream generation routes: ${tests.length - failed}/${tests.length} passed. Real api.js router + proxyFetch/Axios + loopback HTTP; DB/auth/billing/hooks mocked.`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  Module._load = originalLoad;
  global.setInterval = originalSetInterval;
  axios.interceptors.request.eject(interceptor);
  for (const timer of intervals) clearInterval(timer);
});
