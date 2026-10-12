'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter, getEventListeners } = require('node:events');
const { combineAbortSignals, releaseCombinedAbortSignal, waitForResponseDrain } = require('../utils/request-lifecycle');
const { canRetryUpstreamError, isTerminalUpstreamError } = require('../utils/upstream-retry-policy');

const filename = path.resolve(__dirname, '../proxy-pool.js');
const localRequire = createRequire(filename);
const logs = [];
const sandbox = {
  module: { exports: {} },
  require(name) {
    if (name === './models/database') return { pool: { query() { assert.fail('Database access is forbidden'); } } };
    if (name === './logger') return { info: line => logs.push(line), warn: line => logs.push(line) };
    return localRequire(name);
  },
  process, Buffer, URL, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout
};
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
const { proxyFetch } = sandbox.module.exports;

async function withServer(run) {
  let count = 0;
  const received = new EventEmitter();
  const timers = new Set();
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    count++;
    received.emit('request', req.url);
    if (req.url.startsWith('/redirect')) { res.writeHead(307, { Location: '/target' }); res.end(); return; }
    if (req.url.startsWith('/pending')) return;
    if (req.url.startsWith('/truncate')) {
      res.writeHead(200, { 'Content-Length': '1000' });
      res.write('partial');
      const timer = setTimeout(() => { timers.delete(timer); res.destroy(); }, 25);
      timers.add(timer);
      return;
    }
    if (req.url.startsWith('/stream')) {
      res.writeHead(200);
      res.write('first');
      return;
    }
    if (req.url.startsWith('/reset')) { req.socket.destroy(); return; }
    res.end('ok');
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent();
  try {
    await run({ base: `http://127.0.0.1:${server.address().port}`, agent, received, count: () => count });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    agent.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

function assertTerminal(error, context) {
  assert.equal(canRetryUpstreamError(error, context), false);
  assert.equal(isTerminalUpstreamError(error, context), true);
  return true;
}

test('pre-aborted options/context signals never send or consume budget', async () => {
  await withServer(async ({ base, agent, count }) => {
    for (const source of ['options', 'context']) {
      const controller = new AbortController();
      controller.abort();
      const context = { upstreamAttempts: 4, signal: source === 'context' ? controller.signal : undefined };
      const live = new AbortController();
      await assert.rejects(proxyFetch(base, {
        agent, requestContext: context, signal: source === 'options' ? controller.signal : live.signal
      }), error => error.code === 'ERR_CANCELED' && assertTerminal(error, context));
      assert.equal(context.upstreamAttempts, 4);
      assert.equal(context.lastAttempt, undefined);
    }
    assert.equal(count(), 0);
  });
});

test('either merged signal cancels real Axios while awaiting headers', async () => {
  await withServer(async ({ base, agent, received, count }) => {
    for (const source of ['options', 'context']) {
      const optionsController = new AbortController();
      const contextController = new AbortController();
      const context = { signal: contextController.signal };
      const arrived = new Promise(resolve => received.once('request', resolve));
      const request = proxyFetch(base + '/pending', { agent, signal: optionsController.signal, requestContext: context });
      const rejected = assert.rejects(request, error => error.name === 'AbortError' && assertTerminal(error, context));
      await arrived;
      (source === 'options' ? optionsController : contextController).abort();
      await rejected;
      assert.equal(context.upstreamAttempts, 1);
      assert.equal(context.lastAttempt.responseStarted, false);
      assert.equal(context.lastAttempt.phase, 'failed');
    }
    assert.equal(count(), 2);
  });
});

test('2xx truncated body is terminal for buffered and reader consumption', async () => {
  await withServer(async ({ base, agent }) => {
    for (const readerMode of [false, true]) {
      const context = {};
      const response = await proxyFetch(base + '/truncate', { agent, requestContext: context });
      assert.equal(response.status, 200);
      assert.equal(context.lastAttempt.responseStarted, true);
      assert.equal(context.lastAttempt.status, 200);
      await assert.rejects(async () => {
        if (!readerMode) return response.text();
        const reader = response.body.getReader();
        try { while (!(await reader.read()).done) {} } finally { reader.releaseLock(); }
      }, error => assertTerminal(error, context));
      assert.equal(context.lastAttempt.phase, 'failed');
      assert.equal(context.upstreamAttempts, 1);
    }
  });
});

test('context cancellation remains active after 2xx headers', async () => {
  await withServer(async ({ base, agent }) => {
    const controller = new AbortController();
    const context = { signal: controller.signal };
    const response = await proxyFetch(base + '/stream', {
      agent, signal: new AbortController().signal, requestContext: context
    });
    const rejected = assert.rejects(response.text(), error => assertTerminal(error, context));
    controller.abort();
    await rejected;
    assert.equal(context.lastAttempt.status, 200);
    assert.equal(context.lastAttempt.responseStarted, true);
  });
});

test('timeout and connection reset are terminal on real HTTP', async () => {
  await withServer(async ({ base, agent }) => {
    const context = {};
    await assert.rejects(proxyFetch(base + '/pending', {
      agent, signal: AbortSignal.timeout(40), requestContext: context
    }), error => error.name === 'TimeoutError' && assertTerminal(error, context));
    const resetContext = {};
    await assert.rejects(proxyFetch(base + '/reset', { agent, requestContext: resetContext }),
      error => error.code === 'ECONNRESET' && assertTerminal(error, resetContext));
  });
});

test('shared concurrent budget sends exactly 12 requests, never counts rejection', async () => {
  await withServer(async ({ base, agent, count }) => {
    const context = {};
    const results = await Promise.allSettled(Array.from({ length: 20 }, async () => {
      const response = await proxyFetch(base, { agent, requestContext: context });
      return response.text();
    }));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 12);
    const rejected = results.filter(result => result.status === 'rejected');
    assert.equal(rejected.length, 8);
    for (const result of rejected) {
      assert.equal(result.reason.code, 'upstream_attempt_limit');
      assertTerminal(result.reason, context);
    }
    assert.equal(count(), 12);
    assert.equal(context.upstreamAttempts, 12);
    assert.equal(context.lastAttempt.number, 12);
    await assert.rejects(proxyFetch(base, { agent, requestContext: context }),
      error => error.code === 'upstream_attempt_limit');
    assert.equal(context.upstreamAttempts, 12);
    assert.equal(count(), 12);
  });
});

test('concurrent contexts isolate attempt state and cancellation', async () => {
  await withServer(async ({ base, agent, received }) => {
    const controller = new AbortController();
    const canceled = { signal: controller.signal };
    const successful = {};
    const arrived = new Promise(resolve => received.once('request', resolve));
    const pending = proxyFetch(base + '/pending', { agent, requestContext: canceled });
    const rejected = assert.rejects(pending, error => assertTerminal(error, canceled));
    await arrived;
    const response = await proxyFetch(base, { agent, requestContext: successful });
    assert.equal(await response.text(), 'ok');
    controller.abort();
    await rejected;
    assert.equal(canceled.lastAttempt.responseStarted, false);
    assert.equal(successful.lastAttempt.responseStarted, true);
    assert.equal(successful.lastAttempt.phase, 'completed');
    assert.notEqual(canceled.lastAttempt, successful.lastAttempt);
  });
});

test('refused connection can retry until budget exhausted', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const agent = new http.Agent();
  const context = {};
  try {
    for (let number = 1; number <= 12; number++) {
      await assert.rejects(proxyFetch(`http://127.0.0.1:${port}`, { agent, requestContext: context }), error => {
        assert.equal(error.code, 'ECONNREFUSED');
        assert.equal(canRetryUpstreamError(error, context), number < 12);
        return true;
      });
      assert.equal(context.upstreamAttempts, number);
    }
    await assert.rejects(proxyFetch(`http://127.0.0.1:${port}`, { agent, requestContext: context }),
      error => error.code === 'upstream_attempt_limit' && assertTerminal(error, context));
  } finally { agent.destroy(); }
});

test('retry policy is a conservative allowlist', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']) {
    assert.equal(canRetryUpstreamError({ code }, {}), true);
    assertTerminal({ code }, { lastAttempt: { responseStarted: true, status: 200 } });
    assertTerminal({ code }, { lastAttempt: { responseStarted: false, status: 503 } });
    assertTerminal({ code, response: { status: 500 } }, {});
  }
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ERR_CANCELED', 'ABORT_ERR', 'upstream_attempt_limit', 'EPIPE', 'UNKNOWN']) {
    assertTerminal({ code }, {});
  }
  for (const name of ['AbortError', 'CanceledError', 'TimeoutError']) assertTerminal({ name, code: 'ENOTFOUND' }, {});
  assertTerminal(new Error('unknown failure'), {});
});

test('attempt logs expose only anonymous state, never request secrets', async () => {
  await withServer(async ({ base, agent }) => {
    const start = logs.length;
    const response = await proxyFetch(base + '/secret-path?token=secret-query', {
      agent, method: 'POST', headers: { authorization: 'Bearer secret-header' }, body: 'secret-body', requestContext: {}
    });
    await response.text();
    const lines = logs.slice(start);
    assert(lines.length >= 3);
    for (const line of lines) {
      assert.match(line, /^\[UpstreamAttempt\] request=untracked purpose=unspecified number=\d+ phase=(sending|headers|completed|failed) status=(none|\d+) responseStarted=(true|false)$/);
      assert(!line.includes('secret'));
      assert(!line.includes(base));
    }
  });
});

test('drain wait resolves or rejects and cleans all listeners', async () => {
  for (const event of ['drain', 'close', 'error', 'abort', 'preabort', 'closed', 'ready']) {
    const res = new EventEmitter();
    res.writableNeedDrain = event !== 'ready';
    res.destroyed = event === 'closed';
    const controller = new AbortController();
    if (event === 'preabort') controller.abort();
    const promise = waitForResponseDrain(res, controller.signal);
    const completion = ['drain', 'ready'].includes(event)
      ? promise : assert.rejects(promise);
    if (event === 'abort') controller.abort();
    else if (event === 'error') res.emit('error', new Error('fixture error'));
    else if (['drain', 'close'].includes(event)) res.emit(event);
    await completion;
    for (const name of ['drain', 'close', 'error']) assert.equal(res.listenerCount(name), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('fallback combined signals retain abort reason and release listeners', () => {
  const lifecycleFilename = path.resolve(__dirname, '../utils/request-lifecycle.js');
  const fallback = { module: { exports: {} }, AbortSignal: {}, AbortController };
  vm.runInNewContext(fs.readFileSync(lifecycleFilename, 'utf8'), fallback, { filename: lifecycleFilename });
  const { combineAbortSignals: combine, releaseCombinedAbortSignal: release } = fallback.module.exports;
  for (const abort of [true, false]) {
    const first = new AbortController();
    const second = new AbortController();
    const signal = combine(first.signal, second.signal);
    assert.equal(getEventListeners(first.signal, 'abort').length, 1);
    if (abort) {
      const reason = new Error('fixture reason');
      second.abort(reason);
      assert.equal(signal.reason, reason);
    } else release(signal);
    assert.equal(getEventListeners(first.signal, 'abort').length, 0);
    assert.equal(getEventListeners(second.signal, 'abort').length, 0);
  }
  const preaborted = new AbortController();
  preaborted.abort(new Error('already aborted'));
  const live = new AbortController();
  const signal = combine(live.signal, preaborted.signal);
  assert.equal(signal.reason, preaborted.signal.reason);
  assert.equal(getEventListeners(live.signal, 'abort').length, 0);
  assert.equal(combineAbortSignals(live.signal, live.signal), live.signal);
  releaseCombinedAbortSignal(live.signal);
});


test('generation POST does not follow redirects outside the attempt budget', async () => {
  await withServer(async ({ base, agent, count }) => {
    const context = {};
    const response = await proxyFetch(base + '/redirect', { method: 'POST', body: '{}', agent, requestContext: context });
    assert.equal(response.status, 307);
    await response.text();
    assert.equal(count(), 1);
    assert.equal(context.upstreamAttempts, 1);
  });
});

test('duplicate provider credentials are attempted once in either selection mode', () => {
  const { buildKeyAttemptOrder } = require('../utils/provider-keys');
  for (const api_key_select_mode of ['order', 'weight']) {
    const keys = buildKeyAttemptOrder({ api_key_select_mode, api_keys: ['first', 'first', 'second'] });
    assert.equal(keys.length, 2);
    assert.deepEqual(new Set(keys), new Set(['first', 'second']));
  }
});


test('retry classification uses the failed attempt during shared concurrent calls', () => {
  const context = { lastAttempt: { responseStarted: true, status: 200 } };
  assert.equal(canRetryUpstreamError({ code: 'ECONNREFUSED', upstreamAttempt: { responseStarted: false, status: null } }, context), true);
  assert.equal(canRetryUpstreamError({ code: 'ECONNREFUSED', upstreamAttempt: { responseStarted: true, status: 200 } }, { lastAttempt: { responseStarted: false } }), false);
});
