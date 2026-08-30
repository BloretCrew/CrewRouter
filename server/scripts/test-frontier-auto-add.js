'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  SETTING_KEY,
  parseSettingBoolean,
  isAutoAddEnabled,
  addModelsToFrontierTeams,
} = require('../utils/frontier-auto-add');

function createDb({ settingRows = [], frontierIds = [], insertCounts = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT value FROM settings')) return { rows: settingRows };
      if (sql.startsWith('SELECT id FROM teams')) return { rows: frontierIds.map(id => ({ id })) };
      if (sql.startsWith('INSERT INTO team_models')) return { rowCount: insertCounts.shift() || 0 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

(async () => {
  assert.strictEqual(SETTING_KEY, 'autoAddNewModelsToFrontier');
  assert.strictEqual(parseSettingBoolean(true), true);
  assert.strictEqual(parseSettingBoolean('true'), true);
  assert.strictEqual(parseSettingBoolean(false), false);
  assert.strictEqual(parseSettingBoolean('false'), false);
  assert.strictEqual(parseSettingBoolean(undefined), false);

  const missingSettingDb = createDb();
  assert.strictEqual(await isAutoAddEnabled(missingSettingDb), false, '旧库缺少配置时必须默认关闭');

  const disabledDb = createDb({ settingRows: [{ value: false }], frontierIds: [1] });
  assert.strictEqual(await addModelsToFrontierTeams(disabledDb, ['m1']), 0);
  assert.strictEqual(disabledDb.calls.length, 1, '关闭时不得查询 Team 或写入映射');

  const enabledDb = createDb({
    settingRows: [{ value: 'true' }],
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
  assert.strictEqual((adminSource.match(/await addModelsToFrontierTeams\(/g) || []).length, 5, '所有自动入口应统一调用开关包装器');

  const initSource = fs.readFileSync(path.join(__dirname, 'init-db.js'), 'utf8');
  assert.match(initSource, /VALUES \('autoAddNewModelsToFrontier', 'false'::jsonb\)[\s\S]*?ON CONFLICT \(key\) DO NOTHING/, '新库和旧库必须幂等初始化为 FALSE');

  console.log('frontier auto-add setting and idempotent mapping contracts passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
