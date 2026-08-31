'use strict';
const assert = require('assert');
const { initializeEdition, loadPersistedEdition, resolveEdition } = require('../utils/instance-edition');

function fakeDb() {
  let edition = null;
  return {
    async query(sql, params) {
      if (/SELECT edition FROM instance_settings/.test(sql)) return { rows: edition ? [{ edition }] : [] };
      if (/INSERT INTO instance_settings/.test(sql)) { if (!edition) edition = params[0]; return { rows: [] }; }
      return { rows: [] };
    },
    async connect() { return this; }, release() {},
  };
}

(async () => {
  const db = fakeDb();
  assert.strictEqual(await loadPersistedEdition(db), null);
  assert.strictEqual(await initializeEdition(db, 'personal'), 'personal');
  assert.strictEqual(await initializeEdition(db, 'personal'), 'personal');
  await assert.rejects(() => initializeEdition(db, 'team'), /不能改为/);
  assert.strictEqual(await resolveEdition(db, 'personal'), 'personal');
  await assert.rejects(() => resolveEdition(db, 'team'), /冲突/);
  console.log('instance edition persistence tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
