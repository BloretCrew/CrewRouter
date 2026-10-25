'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Keep configuration and database access outside this synthetic contract test.
function loadHelper(file, dependencies) {
  const module = { exports: {} };
  const isolatedRequire = name => {
    assert(Object.hasOwn(dependencies, name), `Unexpected fixture dependency: ${name}`);
    return dependencies[name];
  };
  new Function('require', 'module', fs.readFileSync(path.join(__dirname, '../utils', file), 'utf8'))(isolatedRequire, module);
  return module.exports;
}
const personalAccess = loadHelper('personal-model-access.js', {
  '../config-loader': { edition: 'team' },
  './instance-edition': require('../utils/instance-edition'),
});
const { addModelsToFrontierTeams } = loadHelper('frontier-auto-add.js', {
  './personal-model-access': personalAccess,
});

function createDb({ frontierIds = [], insertCounts = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT edition FROM instance_settings')) return { rows: [{ edition: 'team' }] };
      if (sql.startsWith('SELECT id FROM teams')) return { rows: frontierIds.map(id => ({ id })) };
      if (sql.startsWith('INSERT INTO team_models')) return { rowCount: insertCounts.shift() || 0 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

(async () => {
  const noFrontierDb = createDb();
  assert.strictEqual(await addModelsToFrontierTeams(noFrontierDb, ['m1']), 0);
  assert.strictEqual(noFrontierDb.calls.length, 2, 'Team edition 没有前沿 Team 时只读取 edition 和 Team，不写入映射');

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
  assert.strictEqual((adminSource.match(/await addModelsToFrontierTeams\(/g) || []).length, 4, '独立模型入口应调用前沿 Team 映射');
  const syncStart = adminSource.indexOf("router.post('/providers/:id/sync-models'");
  const syncRoute = adminSource.slice(syncStart, adminSource.indexOf('\n});', syncStart));
  assert.match(syncRoute, /await addModelsToFrontierTeamsIfEnabled\(client, frontierCandidateIds\)/, '供应商同步必须复用事务连接自动挂载 Team');
  assert(!syncRoute.includes('await addModelsToFrontierTeams('), '供应商同步不能退回独立提交的全局连接池写入');

  assert.strictEqual(await addModelsToFrontierTeams(enabledDb, []), 0);
  assert.ok(!enabledDb.calls.some(call => call.sql.includes('FROM settings')), '历史关闭设置不得阻断前沿 Team 自动启用');

  console.log('frontier team auto-add and idempotent mapping contracts passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
