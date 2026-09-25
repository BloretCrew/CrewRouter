'use strict';
const assert = require('node:assert/strict');
const { parseSelection, queryMultiDimensionStats } = require('../utils/multi-dimension-stats');

async function run() {
  assert.deepEqual(parseSelection({ dimensions: 'team,model', metric: 'tokens', days: '7' }, 'admin'), {
    dimensions: ['team', 'model'], metric: 'tokens', days: 7
  });
  for (const query of [
    { dimensions: 'user', metric: 'requests' },
    { dimensions: 'team' },
    { dimensions: 'model,model' },
    { dimensions: 'model,provider,source,team,project,user,extra' },
    { dimensions: 'model);DROP TABLE usage_records;--' },
    { dimensions: '__proto__' },
    { dimensions: 'model', metric: '__proto__' },
    { dimensions: 'model', metric: 'invalid' },
    { dimensions: 'model', days: '-1' }
  ]) {
    assert.throws(() => parseSelection(query, 'user'));
  }
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ name_0: 'Alpha', value_0: 1, name_1: 'GPT', value_1: 2, requests: 4, tokens: '123', cost: '2.5' }] };
  } };
  const user = await queryMultiDimensionStats(pool, { dimensions: 'key,model', metric: 'requests', days: '30' }, 'user', 42);
  assert.deepEqual(calls[0].params, [30, 42]);
  assert.match(calls[0].sql, /u\.user_id = \$2/);
  assert.match(calls[0].sql, /ak\.id = u\.api_key_id AND ak\.user_id = u\.user_id/);
  assert.match(calls[0].sql, /GROUP BY u\.api_key_id, COALESCE\(NULLIF\(ak\.name/);
  assert.match(calls[0].sql, /LIMIT 30/);
  assert.deepEqual(user.rows[0], { labels: ['Alpha', 'GPT'], values: [1, 2], requests: 4, tokens: 123, cost: 2.5 });
  assert.deepEqual(parseSelection({ dimensions: 'key,model', start: '2026-09-01', end: '2026-09-24' }, 'user'), {
    dimensions: ['key', 'model'], metric: 'requests', start: '2026-09-01', end: '2026-09-24'
  });
  for (const dates of [{ start: '2026-09-31', end: '2026-10-01' }, { start: '2026-09-01' }, { start: '2026-10-01', end: '2026-09-01' }]) {
    assert.throws(() => parseSelection({ dimensions: 'key', ...dates }, 'user'));
  }
  await queryMultiDimensionStats(pool, { dimensions: 'key', start: '2026-09-01', end: '2026-09-24' }, 'user', 42);
  assert.deepEqual(calls[1].params, ['2026-09-01', '2026-09-24', 42]);
  assert.match(calls[1].sql, /u\.user_id = \$3/);
  await queryMultiDimensionStats(pool, { dimensions: 'user,source' }, 'admin');
  assert.deepEqual(calls[2].params, [30]);
  assert.doesNotMatch(calls[2].sql, /u\.user_id = \$2/);
  console.log('multi-dimension stats: passed');
}
run().catch(err => { console.error(err); process.exitCode = 1; });
