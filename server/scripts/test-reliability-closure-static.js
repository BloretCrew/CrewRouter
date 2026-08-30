'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createQuotaBufferStore, saveQuotaBufferWithRetry } = require('../utils/quota-buffer-contract');
const { buildTeamReadPredicate } = require('../utils/team-read-access');

(async () => {
  const entries = [{ user_id: 1, model_name: 'm', token_used: 2 }];
  let saved = null;
  let failures = 2;
  const store = createQuotaBufferStore({
    load: async () => entries,
    save: async value => {
      if (failures--) throw new Error('temporary store failure');
      saved = value;
    },
  });
  assert.deepStrictEqual(await store.load(), entries, '恢复契约必须返回持久化 entries');
  assert.deepStrictEqual(await saveQuotaBufferWithRetry(store, entries, { maxAttempts: 3 }), { attempts: 3 });
  assert.strictEqual(saved, entries);
  await assert.rejects(() => saveQuotaBufferWithRetry(createQuotaBufferStore({ load: () => [], save: () => { throw new Error('permanent'); } }), entries, { maxAttempts: 2 }), /permanent/);

  const predicate = buildTeamReadPredicate(7);
  assert.match(predicate.sql, /EXISTS/);
  assert.match(predicate.sql, /user_teams/);
  assert.deepStrictEqual(predicate.params, [7]);

  const script = fs.readFileSync(path.join(__dirname, 'audit-team-consistency.js'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, '../utils/team-read-access.js'), 'utf8');
  const pluginHost = fs.readFileSync(path.join(__dirname, '../plugins/host.js'), 'utf8');
  assert.match(script, /--dry-run/);
  assert.match(script, /process\.exitCode = report\.ok \? 0 : 1/);
  assert.match(helper, /function buildTeamReadPredicate/);
  assert.match(pluginHost, /FROM operation_logs/);
  assert.doesNotMatch(pluginHost, /FROM audit_logs/);
  console.log('reliability closure static tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
