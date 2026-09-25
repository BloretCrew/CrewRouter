'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { addModelsToFrontierTeams } = require('../utils/frontier-auto-add');

function createDb({ frontierIds = [], insertCounts = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT id FROM teams')) return { rows: frontierIds.map(id => ({ id })) };
      if (sql.startsWith('INSERT INTO team_models')) return { rowCount: insertCounts.shift() || 0 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

(async () => {
  const noFrontierDb = createDb();
  assert.strictEqual(await addModelsToFrontierTeams(noFrontierDb, ['m1']), 0);
  assert.strictEqual(noFrontierDb.calls.length, 1, '没有前沿 Team 时不得写入映射');

  const enabledDb = createDb({
    frontierIds: [10, 20],
    insertCounts: [2, 1],
  });
  assert.strictEqual(await addModelsToFrontierTeams(enabledDb, ['m1', 'm1', 'm2']), 3);
  const inserts = enabledDb.calls.filter(call => call.sql.startsWith('INSERT INTO team_models'));
  assert.strictEqual(inserts.length, 2);
  assert.deepStrictEqual(inserts[0].params, [10, ['m1', 'm2']]);
  assert.ok(inserts.every(call => /ON CONFLICT \(team_id, model_id\) DO NOTHING/.test(call.sql)), '必须幂等且不覆盖已有映射');

  const adminSource = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
  assert.match(adminSource, /router\.post\('\/models\/batch-update'[\s\S]*?if \(enabled === true\)[\s\S]*?addModelsToFrontierTeams\(ids\)/, '批量启用入口必须走统一开关');
  assert.strictEqual((adminSource.match(/await addModelsToFrontierTeams\(/g) || []).length, 5, '所有系统模型自动入口应调用前沿 Team 映射');

  assert.strictEqual(await addModelsToFrontierTeams(enabledDb, []), 0);
  assert.ok(!enabledDb.calls.some(call => call.sql.includes('FROM settings')), '历史关闭设置不得阻断前沿 Team 自动启用');

  console.log('frontier team auto-add and idempotent mapping contracts passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
