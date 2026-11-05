'use strict';

// 多端点回退的路由级测试：真实 api.js router + proxyFetch/Axios + 本机 HTTP 上游，
// DB / auth / billing / hooks 全部 mock；不接触生产库或真实上游。
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const express = require('express');
const axios = require('axios');
const realUrlValidator = require('../utils/url-validator');

const noop = () => {};
const asyncNoop = async () => {};
const state = { queue: ['route-primary'], provider: null, upstreamPort: null };
const mocks = new Map();
const mock = (relative, exports) => mocks.set(path.resolve(__dirname, '..', relative), exports);
const logger = { info: noop, warn: noop, error: noop, debug: noop, stream: noop };
const pool = {
  async query(sql, values = []) {
    if (/SELECT DISTINCT m\.id/.test(sql)) return { rows: state.queue.filter(id => values[0].includes(id)).map(id => ({ id })) };
    if (/SELECT m\.id FROM models m/.test(sql)) return { rows: state.queue.includes(values[0]) ? [{ id: values[0] }] : [] };
    if (/SELECT DISTINCT p\.format/.test(sql)) return { rows: [{ format: state.provider.format }] };
    if (/FROM api_key_harness_models/.test(sql)) return { rows: [] };
    if (/FROM api_key_models/.test(sql)) return { rows: state.queue.map(model_id => ({ model_id })) };
    if (/SELECT ak\.current_model_id/.test(sql)) return { rows: [{ current_model_id: state.queue[0], enabled: true, expires_at: null }] };
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
mock('utils/url-validator.js', {
  ...realUrlValidator,
  async validateUrl(input, options) {
    const target = new URL(input);
    assert.equal(target.origin, `http://127.0.0.1:${state.upstreamPort}`);
    assert.equal(options.allowPrivate, false);
    return realUrlValidator.validateUrl(input, { ...options, allowedPrivateOrigins: [target.origin] });
  },
});

const originalLoad = Module._load;
const originalSetInterval = global.setInterval;
const intervals = new Set();
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

const interceptor = axios.interceptors.request.use(options => {
  const url = new URL(options.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.protocol, 'http:');
  assert.equal(Number(url.port), state.upstreamPort);
  options.proxy = false;
  return options;
});

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

const chatBody = { model: 'requested-model', messages: [{ role: 'user', content: 'hello' }], max_tokens: 16, stream: false };
const messagesBody = { model: 'requested-model', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] };
const responsesBody = { model: 'requested-model', input: 'hello', max_output_tokens: 16 };

function successBody(format, stream) {
  if (stream) {
    if (format === 'responses') {
      return ['text/event-stream',
        `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_x', object: 'response', status: 'in_progress', output: [] } })}\n\n`
        + `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: 'ok' })}\n\n`
        + `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_x', object: 'response', status: 'completed', output: [], usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`];
    }
    if (format === 'anthropic') {
      return ['text/event-stream',
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'local', content: [], usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`
        + `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`
        + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`
        + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`
        + `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })}\n\n`
        + `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`];
    }
    return ['text/event-stream',
      `data: ${JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] })}\n\n`
      + `data: ${JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0 } })}\n\n`
      + 'data: [DONE]\n\n'];
  }
  if (format === 'responses') {
    return ['application/json', JSON.stringify({ id: 'resp_x', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], output_text: 'ok', usage: { input_tokens: 0, output_tokens: 0 } })];
  }
  if (format === 'anthropic') {
    return ['application/json', JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: 'local', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } })];
  }
  return ['application/json', JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion', model: 'local', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })];
}

/**
 * primary: { prefix, format, status }  附加端点：extra: [{ prefix, format, status }]
 * 上游按路径前缀决定用哪个端点配置。
 */
async function fixture(router, { primary, extra = [] } = {}) {
  const received = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      received.push({ path: req.url, body: parsed, auth: req.headers.authorization || req.headers['x-api-key'] });
      const matched = [primary, ...extra].find(e => req.url.startsWith(e.prefix)) || primary;
      if (matched.status && matched.status !== 200) {
        res.writeHead(matched.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `endpoint ${matched.format} failed`, type: 'server_error' } }));
        return;
      }
      const [contentType, out] = successBody(matched.format, !!parsed.stream);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(out);
    });
  });
  const upstreamPort = await listen(upstream);
  state.upstreamPort = upstreamPort;
  state.queue = ['route-primary'];
  const origin = `http://127.0.0.1:${upstreamPort}`;
  state.provider = {
    id: 'local-provider',
    name: 'isolated',
    enabled: true,
    format: primary.format,
    base_url: `${origin}${primary.prefix}`,
    api_key: 'local-key-primary',
    api_keys: ['local-key-primary'],
    api_key_select_mode: 'order',
    proxy_enabled: false,
    endpoints: extra.map((e, i) => ({ url: `${origin}${e.prefix}`, format: e.format, enabled: true, label: `Extra ${i + 1}` })),
  };
  const app = express();
  app.use(express.json());
  app.use('/v1', router);
  app.use((err, _req, res, _next) => {
    if (res.headersSent) return res.destroy(err);
    res.status(500).json({ error: { message: err.message } });
  });
  const gateway = http.createServer(app);
  const port = await listen(gateway);
  return {
    port,
    received,
    async close() {
      await Promise.all([closeServer(gateway), closeServer(upstream)]);
    },
  };
}

function post(f, route, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: f.port, path: route, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...extraHeaders },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const tests = [];
const test = (name, options, run) => tests.push({ name, options, run });

// 1) chat：主端点 503 → 回退到附加 Anthropic 端点（转换）并成功
test('chat: 主端点 503 回退到附加 Anthropic 端点', {
  primary: { prefix: '/v1', format: 'openai', status: 503 },
  extra: [{ prefix: '/alt/v1', format: 'anthropic' }],
}, async f => {
  const result = await post(f, '/v1/chat/completions', chatBody);
  assert.equal(result.status, 200, result.text);
  assert.equal(f.received.length, 2, `received=${f.received.map(r => r.path).join(',')}`);
  assert.equal(f.received[0].path, '/v1/chat/completions');
  assert.equal(f.received[1].path, '/alt/v1/messages');
  assert.equal(f.received[1].headers ? undefined : undefined, undefined);
  assert.equal(f.received[1].auth, 'local-key-primary');
  assert.equal(JSON.parse(result.text).choices[0].message.content, 'ok');
});

// 2) chat：主端点 400 → 不回退（只有 408/429/5xx 才换端点）
test('chat: 主端点 400 不触发端点回退', {
  primary: { prefix: '/v1', format: 'openai', status: 400 },
  extra: [{ prefix: '/alt/v1', format: 'anthropic' }],
}, async f => {
  const result = await post(f, '/v1/chat/completions', chatBody);
  assert.equal(result.status, 400, result.text);
  assert.equal(f.received.length, 1);
});

// 3) chat：原生格式优先——主端点 anthropic + 附加 openai，chat 请求应优先 openai
test('chat: 原生 OpenAI 端点优先于主 Anthropic 端点', {
  primary: { prefix: '/v1', format: 'anthropic' },
  extra: [{ prefix: '/alt/v1', format: 'openai' }],
}, async f => {
  const result = await post(f, '/v1/chat/completions', chatBody);
  assert.equal(result.status, 200, result.text);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].path, '/alt/v1/chat/completions');
});

// 4) messages：原生 Anthropic 优先级 + 回退
test('messages: 主 Anthropic 端点 500 回退到附加 OpenAI 端点', {
  primary: { prefix: '/v1', format: 'anthropic', status: 500 },
  extra: [{ prefix: '/alt/v1', format: 'openai' }],
}, async f => {
  const result = await post(f, '/v1/messages', messagesBody);
  assert.equal(result.status, 200, result.text);
  assert.equal(f.received.length, 2);
  assert.equal(f.received[0].path, '/v1/messages');
  assert.equal(f.received[1].path, '/alt/v1/chat/completions');
  assert.equal(f.received[1].auth, 'Bearer local-key-primary');
});

// 5) messages：原生 Anthropic 优先（主 openai + 附加 anthropic）
test('messages: 附加 Anthropic 端点原生优先', {
  primary: { prefix: '/v1', format: 'openai' },
  extra: [{ prefix: '/alt/v1', format: 'anthropic' }],
}, async f => {
  const result = await post(f, '/v1/messages', messagesBody);
  assert.equal(result.status, 200, result.text);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].path, '/alt/v1/messages');
});

// 6) safeguards：只允许 Anthropic 端点（主 openai + 附加 anthropic）
test('messages: 带 safeguards 只使用 Anthropic 端点', {
  primary: { prefix: '/v1', format: 'openai' },
  extra: [{ prefix: '/alt/v1', format: 'anthropic' }],
}, async f => {
  const body = { ...messagesBody, safeguards: [{ type: 'dangerous_tool_use', classifier_context: { opaque: ['x'] } }] };
  const result = await post(f, '/v1/messages', body, { 'anthropic-beta': 'dangerous-tool-use-2026-09-03' });
  assert.equal(result.status, 200, result.text);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].path, '/alt/v1/messages');
});

// 7) safeguards：没有 Anthropic 端点时不发任何上游请求
test('messages: 无 Anthropic 端点时 safeguards 直接 400', {
  primary: { prefix: '/v1', format: 'openai' },
  extra: [{ prefix: '/alt/v1', format: 'openai' }],
}, async f => {
  const body = { ...messagesBody, safeguards: [{ type: 'dangerous_tool_use', classifier_context: { opaque: ['x'] } }] };
  const result = await post(f, '/v1/messages', body, { 'anthropic-beta': 'dangerous-tool-use-2026-09-03' });
  assert.equal(result.status, 400, result.text);
  assert.equal(f.received.length, 0);
});

// 8) responses 非流式：主 responses 503 → 附加 openai 转换成功
test('responses 非流式: 主端点 503 回退到附加 OpenAI 端点', {
  primary: { prefix: '/v1', format: 'responses', status: 503 },
  extra: [{ prefix: '/alt/v1', format: 'openai' }],
}, async f => {
  const result = await post(f, '/v1/responses', responsesBody);
  assert.equal(result.status, 200, result.text);
  assert.equal(f.received.length, 2);
  assert.equal(f.received[0].path, '/v1/responses');
  assert.equal(f.received[1].path, '/alt/v1/chat/completions');
  assert.ok(JSON.parse(result.text).output_text);
});

// 9) responses 非流式：原生 responses 优先
test('responses 非流式: 原生 responses 端点优先于主 OpenAI 端点', {
  primary: { prefix: '/v1', format: 'openai' },
  extra: [{ prefix: '/alt/v1', format: 'responses' }],
}, async f => {
  const result = await post(f, '/v1/responses', responsesBody);
  assert.equal(result.status, 200, result.text);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].path, '/alt/v1/responses');
});

// 10) responses 流式原生：主端点 503（未 flush）→ 附加 responses 端点成功，只有一段流
test('responses 流式: 主 responses 503 回退到附加 responses 端点', {
  primary: { prefix: '/v1', format: 'responses', status: 503 },
  extra: [{ prefix: '/alt/v1', format: 'responses' }],
}, async f => {
  const result = await post(f, '/v1/responses', { ...responsesBody, stream: true });
  assert.equal(result.status, 200, result.text);
  assert.equal(f.received.length, 2);
  assert.equal(f.received[0].path, '/v1/responses');
  assert.equal(f.received[1].path, '/alt/v1/responses');
  assert.match(result.text, /response\.completed/);
  assert.doesNotMatch(result.text, /response\.failed/);
});

// 11) responses 流式转换：主 anthropic 500 → 附加 openai 成功
test('responses 流式转换: 主 Anthropic 500 回退到附加 OpenAI', {
  primary: { prefix: '/v1', format: 'anthropic', status: 500 },
  extra: [{ prefix: '/alt/v1', format: 'openai' }],
}, async f => {
  const result = await post(f, '/v1/responses', { ...responsesBody, stream: true });
  assert.equal(result.status, 200, result.text);
  assert.equal(f.received.length, 2);
  assert.equal(f.received[0].path, '/v1/messages');
  assert.equal(f.received[1].path, '/alt/v1/chat/completions');
});

// 12) 单端点（endpoints=[]）仍保持旧语义：503 不重发
test('单端点: 503 不重发，行为与旧版一致', {
  primary: { prefix: '/v1', format: 'openai', status: 503 },
  extra: [],
}, async f => {
  const result = await post(f, '/v1/chat/completions', chatBody);
  assert.equal(result.status, 503, result.text);
  assert.equal(f.received.length, 1);
});

async function main() {
  const router = require('../routes/api');
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
  console.log(`Provider endpoints routes: ${tests.length - failed}/${tests.length} passed.`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  axios.interceptors.request.eject(interceptor);
  Module._load = originalLoad;
  global.setInterval = originalSetInterval;
  for (const timer of intervals) clearInterval(timer);
});
