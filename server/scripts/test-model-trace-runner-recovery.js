'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRunner } = require('../utils/model-trace-runner');
const { createStore } = require('../utils/model-trace-store');

async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

function fixture(t, { failures = 0, valid = true, hang = false, markerHang = false, finishFailures = 0 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = { status: 'pending', error: null, reserved: false, calls: 0, settlements: 0,
    charged: 0, canceled: false, finishes: 0, markers: 0, diagnostics: [] };
  const store = {
    claim: async () => { state.status = 'running'; return { target: { timeout_ms: 60000 }, version: {} }; },
    reserve: async () => { state.reserved = true; return {}; },
    markSent: async () => true,
    settle: async (_id, _ordinal, diagnostic) => {
      state.settlements++;
      state.diagnostics.push(diagnostic);
      if (hang) return new Promise(() => {});
      if (state.settlements <= failures) throw new Error('database unavailable');
      if (state.reserved) { state.charged++; state.reserved = false; }
    },
    markSettlementPending: async () => {
      state.markers++;
      if (markerHang) return new Promise(() => {});
      state.error = '结算暂不可用';
    },
    finish: async (_id, status, _result, error) => {
      state.finishes++;
      if (state.finishes <= finishFailures) throw new Error('database unavailable');
      assert.equal(state.reserved, false);
      state.status = state.canceled ? 'canceled' : status;
      state.error = error;
    }
  };
  const runner = createRunner({ store,
    loadCore: async () => ({ generateChallenges: () => Array.from({ length: 3 }, () => ({ prompt: 'challenge', expected_count: 100 })),
      parseNumbers: () => valid ? Array(100).fill(2) : [] }),
    transport: async options => {
      assert.ok(await options.beforeSend());
      state.calls++;
      return { text: valid ? 'numbers' : '', usage: { promptTokens: 100, completionTokens: 200 }, response_model: 'fixed-model' };
    },
    score: async () => ({ results: [] })
  });
  t.after(async () => { await runner.stop(); t.mock.timers.reset(); });
  return { runner, state };
}

for (const valid of [true, false]) {
  test(`settlement recovers after more than three failures without another probe (${valid ? 'partial' : 'failed'})`, async t => {
    const { runner, state } = fixture(t, { failures: 4, valid });
    runner.enqueue('job');
    await flush();
    assert.equal(state.status, 'running');
    assert.match(state.error, /结算暂不可用/);
    assert.equal(runner.idle(), false);
    runner.enqueue('job');
    for (const delay of [500, 1000, 2000, 4000]) { t.mock.timers.tick(delay); await flush(); }
    assert.equal(state.settlements, 5);
    assert.equal(state.charged, 1);
    assert.equal(state.calls, 1);
    assert.equal(state.status, valid ? 'partial' : 'failed');
    assert.equal(runner.idle(), true);
    assert.equal(state.error, valid ? null : '没有可用回答');
    assert.ok(state.diagnostics.every(diagnostic => diagnostic === state.diagnostics[0]));
    assert.equal(state.diagnostics[0].response_model, 'fixed-model');
  });
}

test('healthy settlement retains the three-probe budget', async t => {
  const { runner, state } = fixture(t);
  runner.enqueue('job'); await flush();
  assert.equal(state.calls, 3);
  assert.equal(state.settlements, 3);
  assert.equal(state.charged, 3);
  assert.equal(state.status, 'completed');
  assert.equal(runner.idle(), true);
});

test('cancel aborts generation but does not abort settlement recovery', async t => {
  const { runner, state } = fixture(t, { failures: 4 });
  runner.enqueue('job');
  await flush();
  state.canceled = true;
  runner.cancel('job');
  for (const delay of [500, 1000, 2000, 4000]) { t.mock.timers.tick(delay); await flush(); }
  assert.equal(state.status, 'canceled');
  assert.equal(state.charged, 1);
  assert.equal(state.calls, 1);
  assert.equal(runner.idle(), true);
});

test('unlimited failure caps backoff at 30s and shutdown leaves reservation for recover', async t => {
  const { runner, state } = fixture(t, { failures: Infinity });
  runner.enqueue('job');
  await flush();
  for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000]) { t.mock.timers.tick(delay); await flush(); }
  assert.equal(state.settlements, 8);
  t.mock.timers.tick(29999); await flush();
  assert.equal(state.settlements, 8);
  t.mock.timers.tick(1); await flush();
  assert.equal(state.settlements, 9);
  await runner.stop();
  const attempts = state.settlements;
  t.mock.timers.tick(300000); await flush();
  assert.equal(state.settlements, attempts);
  assert.equal(state.calls, 1);
  assert.equal(state.reserved, true);
  assert.equal(state.status, 'running');
  assert.equal(state.finishes, 0);
  assert.equal(runner.idle(), true);
});

for (const options of [{ hang: true }, { failures: Infinity, markerHang: true }]) {
  test(`shutdown does not wait for a hung database ${options.hang ? 'settlement' : 'error update'}`, async t => {
    const { runner, state } = fixture(t, options);
    runner.enqueue('job');
    await flush();
    await runner.stop();
    assert.equal(runner.idle(), true);
    assert.equal(state.calls, 1);
    assert.equal(state.reserved, true);
    assert.equal(state.finishes, 0);
  });
}

test('terminal persistence also retries without new generation', async t => {
  const { runner, state } = fixture(t, { failures: 1, finishFailures: 1 });
  runner.enqueue('job'); await flush();
  t.mock.timers.tick(500); await flush();
  assert.equal(state.finishes, 1);
  assert.equal(state.error, '结算暂不可用');
  t.mock.timers.tick(500); await flush();
  assert.equal(state.finishes, 2);
  assert.equal(state.status, 'partial');
  assert.equal(state.charged, 1);
  assert.equal(state.calls, 1);
  assert.equal(runner.idle(), true);
});

test('store settlement pending update exposes a safe error only on running jobs', async () => {
  const calls = [];
  const store = createStore({ pool: { query: async (...args) => { calls.push(args); } }, getKeys: () => [] });
  await store.markSettlementPending('job');
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /status='running'/);
  assert.deepEqual(calls[0][1], ['job', '结算暂不可用，已停止后续挑战，正在自动重试；取消检测不会停止结算']);
});
