'use strict';

// Actual api.js functions and loopback proxyFetch; persistence and side effects are isolated.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const axios = require('axios');

const noop = () => {};
const asyncNoop = async () => {};
const mocks = new Map();
const mock = (relative, exports) => mocks.set(path.resolve(__dirname, '..', relative), exports);
const logger = { info: noop, warn: noop, error: noop, debug: noop, stream: noop };
const pool = {
  async query(sql) {
    if (/FROM settings/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected database query in isolated stream test: ${sql}`);
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
mock('utils/quota-request-context.js', {
  requestMiddleware: (_req, _res, next) => next(),
  quotaFetch(url, options, transport) {
    assertFixtureUrl(url);
    assert.equal(typeof transport, 'function');
    return transport(url, options);
  },
});
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
const intervals = new Set();
Module._load = function load(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  return mocks.has(resolved) ? mocks.get(resolved) : originalLoad.call(this, request, parent, isMain);
};

const apiPath = path.resolve(__dirname, '../routes/api.js');
const exported = ['proxyOpenAI', 'proxyAnthropic', 'proxyAnthropicToAnthropic', 'proxyOpenAIStreamToAnthropic', 'streamOpenAIAsResponses', 'streamAnthropicAsResponses'];
const sandbox = {
  require: Module.createRequire(apiPath), module: { exports: {} }, exports: {},
  __filename: apiPath, __dirname: path.dirname(apiPath), console, Buffer, process,
  TextDecoder, TextEncoder, AbortController, AbortSignal, URL, setTimeout, clearTimeout,
  setInterval(...args) { const timer = setInterval(...args); intervals.add(timer); return timer; },
  clearInterval,
};
vm.runInNewContext(`${fs.readFileSync(apiPath, 'utf8')}\nmodule.exports = { ${exported.join(', ')} };`, sandbox, { filename: apiPath });
const api = sandbox.module.exports;
const proxyPool = require('../proxy-pool');
const { createRequestLifecycle, waitForResponseDrain } = require('../utils/request-lifecycle');

const readers = [];
const originalGetReader = ReadableStream.prototype.getReader;
ReadableStream.prototype.getReader = function getReader(...args) {
  const reader = originalGetReader.apply(this, args);
  const stats = { canceled: 0, released: 0 };
  readers.push(stats);
  const cancel = reader.cancel.bind(reader);
  const release = reader.releaseLock.bind(reader);
  reader.cancel = (...values) => { stats.canceled++; return cancel(...values); };
  reader.releaseLock = () => { stats.released++; return release(); };
  return reader;
};
let activePort;
function assertFixtureUrl(value) {
  const url = new URL(value);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.protocol, 'http:');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.ok(Number.isInteger(activePort), 'A local fixture must be listening');
  assert.equal(Number(url.port), activePort, 'External upstream access is forbidden');
}
const interceptor = axios.interceptors.request.use(options => {
  assertFixtureUrl(options.url);
  options.proxy = false;
  return options;
});

const frame = data => `data: ${JSON.stringify(data)}\n\n`;
const chat = {
  start: frame({ id: 'chatcmpl-local', choices: [{ index: 0, delta: { role: 'assistant', content: 'local-text' } }] }),
  stop: frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  terminal: 'data: [DONE]\n\n',
  error: frame({ error: { type: 'server_error', message: 'fixture failure' } }),
};
const anthropic = {
  start: frame({ type: 'message_start', message: { id: 'msg-local', usage: { input_tokens: 1 } } }) + frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'local-text' } }),
  stop: frame({ type: 'content_block_stop', index: 0 }) + frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
  terminal: frame({ type: 'message_stop' }),
  error: frame({ type: 'error', error: { type: 'overloaded_error', message: 'fixture failure' } }),
};

class Response extends EventEmitter {
  constructor(cancelDrain = false) {
    super();
    this.text = '';
    this.destroyed = false;
    this.writableEnded = false;
    this.writableFinished = false;
    this.writableNeedDrain = false;
    this.cancelDrain = cancelDrain;
    this.drainWaits = 0;
  }
  setHeader() {}
  flushHeaders() {}
  write(text) {
    assert.equal(this.writableEnded, false, 'Cannot write after end');
    this.text += text;
    if (this.cancelDrain && this.text.includes('local-text')) {
      this.cancelDrain = false;
      this.writableNeedDrain = true;
      setImmediate(() => {
        this.destroyed = true;
        this.emit('close');
      });
      return false;
    }
    return true;
  }
  end() { this.writableEnded = true; this.writableFinished = true; this.emit('finish'); }
}

async function fixture(frames, endless = false) {
  const received = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', value => { body += value; });
    req.on('end', () => {
      const entry = { body: JSON.parse(body), closed: false };
      received.push(entry);
      res.on('close', () => { entry.closed = true; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (endless) res.write(frames); else res.end(frames);
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  activePort = server.address().port;
  return {
    received,
    provider: { id: 'stream-safety-local', name: 'local', api_key: 'fixture-only', base_url: `http://127.0.0.1:${activePort}/v1`, proxy_enabled: false },
    async close() {
      const closing = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closing;
    },
  };
}

const body = { model: 'local', messages: [{ role: 'user', content: 'hello' }], max_tokens: 8, stream: true };
async function invoke(name, f, res) {
  const req = new EventEmitter();
  Object.assign(req, { body, headers: {}, complete: true, apiUser: { signatureEnabled: false, injectPrompt: '' } });
  const lifecycle = createRequestLifecycle(req, res);
  req._requestLifecycle = lifecycle;
  req._upstreamAttemptContext = { upstreamAttempts: 0, signal: lifecycle.signal, requestedModel: 'local' };
  try {
    if (name.startsWith('stream')) {
      const response = await proxyPool.proxyFetch(`${f.provider.base_url}/stream`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: lifecycle.signal });
      assert.equal(response.status, 200);
      const write = async text => {
        if (!res.write(text)) { res.drainWaits++; await waitForResponseDrain(res, lifecycle.signal); }
      };
      return await api[name](response.body.getReader(), new TextDecoder(), res, req, 'resp-local', 'local', body, write, () => waitForResponseDrain(res, lifecycle.signal));
    }
    if (name === 'proxyOpenAIStreamToAnthropic') return await api[name](f.provider, 'local', body, res, req);
    return await api[name](f.provider, 'local', body, true, res, req);
  } finally {
    lifecycle.dispose();
  }
}

async function bounded(work) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Stream test timed out')), 2500); })]);
  } finally { clearTimeout(timer); }
}
async function eventually(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'Reader cancellation must close the real local upstream');
}
function noSuccess(res) {
  assert.ok(!res.text.includes('response.completed'), 'Must not emit response.completed after upstream failure');
  assert.ok(!res.text.includes('data: [DONE]'), 'Must not synthesize [DONE] after failure');
  assert.ok(!res.text.includes('"type":"message_stop"'), 'Must not synthesize message_stop after failure');
}

async function main() {
  let failed = 0;
  let total = 0;
  const cases = [
    ['proxyOpenAI', chat], ['proxyAnthropic', anthropic], ['proxyAnthropicToAnthropic', anthropic],
    ['proxyOpenAIStreamToAnthropic', chat], ['streamOpenAIAsResponses', chat], ['streamAnthropicAsResponses', anthropic],
  ];
  for (const [name, protocol] of cases) {
    for (const mode of ['success', 'error', 'error-residual', 'error-then-terminal', 'missing-terminal', 'drain-cancel', 'read-cancel']) {
      total++;
      let f;
      const readerStart = readers.length;
      const res = new Response(mode === 'drain-cancel');
      try {
        const frames = protocol.start + (mode === 'success' ? protocol.stop + protocol.terminal
          : mode === 'error' ? protocol.error
          : mode === 'error-residual' ? protocol.error.trimEnd()
          : mode === 'error-then-terminal' ? protocol.error + protocol.terminal
          : mode === 'missing-terminal' ? protocol.stop : '');
        f = await fixture(frames, mode.endsWith('-cancel'));
        let error;
        let cancelTimer;
        if (mode === 'read-cancel') cancelTimer = setTimeout(() => { res.destroyed = true; res.emit('close'); }, 50);
        try { await bounded(invoke(name, f, res)); } catch (caught) { error = caught; }
        finally { clearTimeout(cancelTimer); }
        if (mode === 'success') {
          assert.equal(error, undefined, error?.stack);
          assert.ok(res.text.includes(name.startsWith('stream') ? 'response.completed' : name.includes('ToAnthropic') ? '"type":"message_stop"' : 'data: [DONE]'), 'Normal terminal must produce success');
        } else {
          assert.ok(error, `${mode} must reject, not silently return success`);
          if (mode.startsWith('error')) assert.ok(error.code === 'upstream_stream_error' || error.message === 'Upstream stream reported an error', error.stack);
          if (mode === 'missing-terminal') assert.equal(error.code, 'upstream_stream_incomplete');
          if (mode.endsWith('-cancel')) assert.ok(error.name === 'AbortError' || error.code === 'ERR_STREAM_PREMATURE_CLOSE' || error.code === 'ERR_CANCELED', error.stack);
          noSuccess(res);
        }
        const stats = readers.slice(readerStart);
        assert.equal(stats.length, 1, 'Exactly one real upstream reader must be acquired');
        assert.ok(stats[0].canceled > 0, 'Reader.cancel must run on success/failure/cancellation');
        assert.ok(stats[0].released > 0, 'Reader lock must be released');
        assert.equal(f.received.length, 1, 'Stream failure/cancellation must not resend generation');
        await eventually(() => f.received[0].closed);
        console.log(`PASS ${name}: ${mode}`);
      } catch (error) {
        failed++;
        console.error(`FAIL ${name}: ${mode}\n${error.stack}`);
      } finally { if (f) await f.close(); }
    }
  }
  console.log(`Upstream stream safety: ${total - failed}/${total} passed; VM api.js + real proxyPool/local HTTP, no production DB/upstream.`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  Module._load = originalLoad;
  ReadableStream.prototype.getReader = originalGetReader;
  axios.interceptors.request.eject(interceptor);
  for (const timer of intervals) clearInterval(timer);
});
