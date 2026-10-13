'use strict';

// Dependency mocks keep this test independent of databases and upstreams.
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const state = {};
const calls = [];
const pool = { query };
const mocks = new Map([
  [path.resolve(__dirname, '../models/database.js'), { pool }],
  [path.resolve(__dirname, '../utils/quota-data.js'), { getUserQuotaBuffer: () => state.buffer }],
]);
const originalLoad = Module._load;
let checkQuotaRules;
let calculatePointsToDeduct;
try {
  Module._load = function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    return mocks.has(resolved) ? mocks.get(resolved) : originalLoad.call(this, request, parent, isMain);
  };
  ({ checkQuotaRules, calculatePointsToDeduct } = require('../utils/points-deduct'));
} finally {
  Module._load = originalLoad;
}

function reset(overrides = {}) {
  Object.assign(state, {
    rules: [{ rule_type: 'requests', rule_value: 3, duration_hours: 24 }],
    records: [], probes: [], buffer: [], error: null, teamError: null, aborted: false,
    onSnapshot: null,
  }, overrides);
  calls.length = 0;
}

async function query(sql, values = []) {
  calls.push({ sql, values });
  if (sql.startsWith('ROLLBACK TO SAVEPOINT')) { state.aborted = false; return { rows: [] }; }
  if (state.aborted) throw Object.assign(new Error('transaction aborted'), { code: '25P02' });
  if (/^(SAVEPOINT|RELEASE SAVEPOINT)/.test(sql)) return { rows: [] };
  if (sql.includes('SELECT quota_rules')) {
    if (state.teamError) throw state.teamError;
    return { rows: [{ quota_rules: state.rules }] };
  }
  assert.match(sql, /FROM usage_records WHERE user_id = \$1 AND created_at >= \$2/);
  const [userId, since] = values;
  const tokens = sql.includes('SUM(weighted_tokens)');
  const records = state.records.filter(item => item.user_id === userId && item.created_at >= since);
  let total = records.reduce((sum, item) => sum + (tokens ? item.weighted_tokens : 1), 0);
  if (sql.includes('FROM model_trace_probes')) {
    assert.match(sql, /UNION ALL/);
    assert.match(sql, /JOIN model_trace_jobs j ON j.id = p.job_id/);
    assert.match(sql, /p.status = 'reserved' AND p.quota_covered = TRUE/);
    assert.ok(!/j.status/.test(sql), 'terminal jobs can still have recoverable reservations');
    if (state.error) {
      if (calls.some(call => call.sql.startsWith('SAVEPOINT'))) state.aborted = true;
      throw state.error;
    }
    total += state.probes.filter(item => item.user_id === userId && item.created_at >= since &&
      item.status === 'reserved' && item.quota_covered).reduce((sum, item) => sum + (tokens ? item.reserved_weight : 1), 0);
    state.onSnapshot?.();
  }
  return { rows: [{ total: String(total) }] };
}

const now = new Date();
const record = (weight = 10) => ({ user_id: 1, created_at: now, weighted_tokens: weight });
const probe = (overrides = {}) => ({ user_id: 1, created_at: now, status: 'reserved', quota_covered: true, reserved_weight: 20, ...overrides });
const points = () => calculatePointsToDeduct({ userId: 1, teamId: 2, weightedTokens: 2000000, pointsCost: 99 });

async function main() {
  reset();
  assert.equal(await checkQuotaRules(1, null), null);
  assert.equal(calls.length, 0);

  reset({ records: [record()], probes: [probe(), probe({ quota_covered: false }), probe({ status: 'completed' }),
    probe({ user_id: 2 }), probe({ created_at: new Date(0) })],
  buffer: [{ created_at: now, count: 1, weighted_tokens: 7 }, { created_at: new Date(0), count: 100 }] });
  let rules = await checkQuotaRules(1, 2);
  assert.equal(rules[0].used, 3);
  assert.equal(rules[0].remaining, 0);
  assert.equal(rules[0].exceeded, true);
  assert.equal(await points(), 2);
  assert.equal(calls.filter(call => call.sql.includes('FROM model_trace_probes')).length, 2);

  reset({ rules: [{ rule_type: 'tokens', rule_value: 38, duration_hours: 24 }], records: [record()],
    probes: [probe(), probe({ quota_covered: false })], buffer: [{ created_at: now, token_used: 7 }] });
  rules = await checkQuotaRules(1, 2);
  assert.equal(rules[0].used, 37);
  assert.equal(rules[0].remaining, 1);
  assert.equal(await points(), 0, 'one remaining token covers a request larger than the remainder');
  state.rules[0].rule_value = 37;
  assert.equal(await points(), 2, 'exact boundary is exhausted');
  state.rules[0].rule_value = 36;
  assert.equal(await points(), 2);
  state.rules.push({ rule_type: 'requests', rule_value: 4, duration_hours: 24 });
  assert.equal(await points(), 0, 'any rule with remaining quota makes the request free');

  for (const client of [null, { query }]) {
    reset({ records: [record()], error: Object.assign(new Error('missing table'), { code: '42P01' }) });
    rules = await checkQuotaRules(1, 2, client);
    assert.equal(rules[0].used, 1);
    assert.equal(state.aborted, false);
    assert.equal(calls.filter(call => call.sql.includes('FROM usage_records')).length, 2);
    if (client) {
      assert.deepEqual(calls.filter(call => /SAVEPOINT/.test(call.sql)).map(call => call.sql),
        ['SAVEPOINT model_trace_quota', 'ROLLBACK TO SAVEPOINT model_trace_quota', 'RELEASE SAVEPOINT model_trace_quota']);
    }
    for (const code of ['42501', '08006', '57014']) {
      const error = Object.assign(new Error('quota statistics unavailable'), { code });
      reset({ error });
      await assert.rejects(checkQuotaRules(1, 2, client), actual => actual === error);
      assert.equal(calls.filter(call => call.sql.includes('FROM usage_records')).length, 1, 'non-migration errors must not fall back');
      assert.equal(state.aborted, false);
    }
  }

  reset({ teamError: new Error('existing team lookup failure') });
  assert.equal(await checkQuotaRules(1, 2), null, 'retain existing team lookup fallback');
  reset({ rules: [] });
  assert.equal(await points(), 99);

  for (const ruleType of ['requests', 'tokens']) {
    for (const settled of [false, true]) {
      reset({ rules: [{ rule_type: ruleType, rule_value: 100, duration_hours: 24 }],
        records: settled ? [record(20)] : [], probes: settled ? [probe({ status: 'completed' })] : [probe()],
        onSnapshot: () => { state.records = [record(20)]; state.probes = [probe({ status: 'completed' })]; } });
      rules = await checkQuotaRules(1, 2, { query });
      assert.equal(rules[0].used, ruleType === 'requests' ? 1 : 20, 'settlement is counted exactly once in the statement snapshot');
      assert.equal(calls.filter(call => call.sql.includes('FROM usage_records')).length, 1);
    }
  }
  reset();
  const client = { query };
  assert.equal(await calculatePointsToDeduct({ userId: 1, teamId: 2, weightedTokens: 2000000, pointsCost: 99 }, { client }), 0);
  assert.equal(calls.filter(call => call.sql.startsWith('SAVEPOINT')).length, 1, 'billing forwards its transaction client');
  console.log('PASS ModelTrace shared quota: free/paid reservations, requests/tokens, boundaries, migration fallback, errors, settlement snapshots');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
