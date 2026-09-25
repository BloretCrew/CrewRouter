'use strict';
const assert = require('node:assert/strict');
const { parseSelection, queryMultiDimensionStats } = require('../utils/multi-dimension-stats');

async function run() {
  assert.deepEqual(parseSelection({ dimensions: 'team,model', metric: 'tokens', days: '7' }, 'admin'), {
    dimensions: ['team', 'model'], metric: 'tokens', days: 7
  });
  for (const query of [
    { dimensions: 'user', metric: 'requests' },
    { dimensions: 'model,model' },
    { dimensions: 'model,provider,source,team,project,user,extra' },
    { dimensions: 'model);DROP TABLE usage_records;--' },
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
  const user = await queryMultiDimensionStats(pool, { dimensions: 'team,model', metric: 'requests', days: '30' }, 'user', 42);
  assert.deepEqual(calls[0].params, [30, 42]);
  assert.match(calls[0].sql, /u\.user_id = \$2/);
  assert.match(calls[0].sql, /LIMIT 30/);
  assert.deepEqual(user.rows[0], { labels: ['Alpha', 'GPT'], values: [1, 2], requests: 4, tokens: 123, cost: 2.5 });
  await queryMultiDimensionStats(pool, { dimensions: 'user,source' }, 'admin');
  assert.deepEqual(calls[1].params, [30]);
  assert.doesNotMatch(calls[1].sql, /u\.user_id = \$2/);
  console.log('multi-dimension stats: passed');
}
run().catch(err => { console.error(err); process.exitCode = 1; });
