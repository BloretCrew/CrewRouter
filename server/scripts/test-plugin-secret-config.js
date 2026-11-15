'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const registryPath = path.resolve(__dirname, '../plugins/registry.js');
const source = fs.readFileSync(registryPath, 'utf8');
const secret = 'must-never-return-this';
const rows = [{ id: 'secret-fixture', config: { token: secret, retries: 1 } }];
const writes = [];
const pool = {
  async query(sql, params = []) {
    if (/SELECT \* FROM plugins ORDER BY id/.test(sql)) return { rows: rows.map(row => ({ ...row, name: row.id, permissions: [] })) };
    if (/SELECT config FROM plugins WHERE id/.test(sql)) return { rows: [{ config: rows[0].config }] };
    if (/UPDATE plugins SET config/.test(sql)) {
      writes.push(params[1]);
      rows[0].config = JSON.parse(params[1]);
      return { rows: [{ id: params[0] }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  },
};
const queue = { createTaskQueue: () => ({ cancelPlugin: async () => {}, enqueue: async () => ({}), ensureSchema: async () => {}, stop: async () => {} }) };
const manifest = { configSchema: {
  token: { type: 'secret', label: 'Token', required: true },
  retries: { type: 'integer', default: 2, min: 0, max: 5 },
} };
const loaded = new Map();
const known = new Map([['secret-fixture', manifest]]);
const harness = {
  module: { exports: {} }, exports: {},
  require(name) {
    if (name === '../models/database') return { pool };
    if (name === '../logger') return { info() {}, warn() {}, error() {} };
    if (name === './hooks') return { setErrorReporter() {}, unsubscribePlugin() {}, unsubscribePluginEvents() {}, hasSubscribers: () => false };
    if (name === './host') return { validateManifest: () => null };
    if (name === '../utils/plugin-task-queue') return queue;
    if (name === './isolated-hook-contract') return { sanitizeIsolatedHookInput() {}, sanitizeIsolatedHookResult() {} };
    if (name === './config-schema') return require('../plugins/config-schema');
    if (name === './task-sandbox') return { assertModeSupported() {}, ISOLATED_HOOK_PERMISSIONS: {} };
    if (name === './events') return { publish() {}, unsubscribePluginEvents() {} };
    throw new Error(`Unexpected require: ${name}`);
  },
  setTimeout, clearTimeout, Date, Map, Set, Promise, Object, Array, String, Number, JSON, Error, RegExp,
};
vm.createContext(harness);
const start = source.indexOf('async function setConfig(');
const end = source.indexOf('\n/**', start);
assert(start >= 0 && end > start, 'registry setConfig declaration exists');
vm.runInContext(`${source.slice(start, end)}\nthis.setConfig = setConfig;`, harness);

(async () => {
  const originalKnown = known.get('secret-fixture');
  const registry = { setConfig: harness.setConfig };
  await registry.setConfig('secret-fixture', { retries: 3, token: '' });
  assert.deepEqual(rows[0].config, { token: secret, retries: 3 });
  const safe = require('../plugins/config-schema').redactConfig(rows[0].config, manifest.configSchema);
  assert.deepEqual(safe, { config: { retries: 3 }, configSecrets: { token: true } });
  assert.equal(JSON.stringify(safe).includes(secret), false);

  await registry.setConfig('secret-fixture', { retries: 4, token: 'replacement' });
  assert.equal(rows[0].config.token, 'replacement');
  const before = writes.length;
  await assert.rejects(registry.setConfig('secret-fixture', { token: 'x', retries: 99 }), error => error.statusCode === 400);
  await assert.rejects(registry.setConfig('secret-fixture', { token: 'x', retries: 1, injected: true }), error => error.statusCode === 400);
  assert.equal(writes.length, before, 'invalid updates never write configuration');
  assert.equal(rows[0].config.token, 'replacement');
  assert.equal(known.get('secret-fixture'), originalKnown);
  console.log('PASS plugin secret config: blank preserves, update replaces, list redacts, invalid updates do not write');
})().catch(error => { console.error(error); process.exitCode = 1; });
