'use strict';
const assert = require('assert');
const { initializeEdition, loadPersistedEdition, resolveEdition, inspectLegacyData } = require('../utils/instance-edition');

function fakeDb(legacy = false) {
  let edition = null;
  return {
    async query(sql, params) {
      if (/SELECT edition FROM instance_settings/.test(sql)) return { rows: edition ? [{ edition }] : [] };
      if (/SELECT\s*\n/.test(sql) && /FROM users/.test(sql)) return { rows: [{ users: legacy ? 1 : 0, teams: legacy ? 1 : 0, memberships: legacy ? 1 : 0, shared_key_members: 0, invites: 0 }] };
      if (/INSERT INTO instance_settings/.test(sql)) { if (!edition) edition = params[0]; return { rows: [] }; }
      return { rows: [] };
    },
    async connect() { return this; }, release() {},
  };
}

(async () => {
  const db = fakeDb();
  assert.strictEqual(await loadPersistedEdition(db), null);
  assert.strictEqual((await inspectLegacyData(db)).hasLegacyData, false);
  assert.strictEqual(await initializeEdition(db, 'personal'), 'personal');
  assert.strictEqual(await initializeEdition(db, 'personal'), 'personal');
  await assert.rejects(() => initializeEdition(db, 'team'), /不能改为/);
  assert.strictEqual(await resolveEdition(db, 'personal'), 'personal');
  await assert.rejects(() => resolveEdition(db, 'team'), /冲突/);

  const legacyDb = fakeDb(true);
  assert.strictEqual((await inspectLegacyData(legacyDb)).hasLegacyData, true);
  await assert.rejects(() => initializeEdition(legacyDb, 'personal'), /历史安装数据/);
  assert.strictEqual(await initializeEdition(legacyDb, 'team', { confirmLegacy: true }), 'team');
  console.log('instance edition persistence tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
