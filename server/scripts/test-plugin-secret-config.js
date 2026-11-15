'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const registrySource = fs.readFileSync(path.resolve(__dirname, '../plugins/registry.js'), 'utf8');
const schemaSource = fs.readFileSync(path.resolve(__dirname, '../plugins/config-schema.js'), 'utf8');
const secret = 'must-never-return-this';
let persisted = { token: secret, retries: 1 };
let writes = 0;
let rollbacks = 0;
const schemaModule = { exports: {} };
const context = vm.createContext({
  module: schemaModule,
  exports: schemaModule.exports,
  console,
  Promise,
  Map,
  Set,
  Object,
  Array,
  String,
  Number,
  Error,
  JSON,
  knownManifests: new Map(),
  loaded: new Map(),
  PLUGINS_DIR: '/unused/plugin-dir',
  fs: { existsSync: () => false },
  path: require('node:path'),
  pool: {
    async connect() {
      let pending = persisted;
      let failed = false;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN') return { rows: [] };
          if (sql === 'COMMIT') { if (failed) throw new Error('cannot commit failed tx'); persisted = pending; return { rows: [] }; }
          if (sql === 'ROLLBACK') { rollbacks++; return { rows: [] }; }
          if (/SELECT config FROM plugins/.test(sql)) return { rows: [{ config: pending }] };
          if (/UPDATE plugins SET config/.test(sql)) {
            writes++;
            pending = JSON.parse(params[1]);
            return { rows: [{ id: params[0] }] };
          }
          throw new Error(`Unexpected transaction query: ${sql}`);
        },
        release() {},
      };
    },
    async query(sql) {
      if (/SELECT \* FROM plugins ORDER BY id/.test(sql)) return { rows: [{ id: 'secret-fixture', name: 'fixture', config: persisted, permissions: [] }] };
      throw new Error(`Unexpected pool query: ${sql}`);
    },
  },
  require(name) {
    if (name === './config-schema') return schemaModule.exports;
    throw new Error(`Unexpected require: ${name}`);
  },
});

vm.runInContext(schemaSource, context, { filename: 'config-schema.js' });
context.knownManifests.set('secret-fixture', {
  configSchema: {
    token: { type: 'secret', label: 'Token', required: true },
    retries: { type: 'integer', default: 2, min: 0, max: 5 },
  },
});
function extractDeclaration(name, prefix) {
  const start = registrySource.indexOf(`${prefix} ${name}`);
  const end = registrySource.indexOf('\n/**', start);
  assert(start >= 0 && end > start, `${name} declaration exists`);
  return registrySource.slice(start, end);
}
vm.runInContext(`${extractDeclaration('setConfig', 'async function')}\n${extractDeclaration('listAll', 'async function')}\nthis.registryApi = { setConfig, listAll };`, context, { filename: 'registry-config-functions.js' });

(async () => {
  context.pendingCall = vm.runInContext("setConfig('secret-fixture', { retries: 3, token: '' })", context);
  await context.pendingCall;
  assert.deepEqual(persisted, { token: secret, retries: 3 }, 'blank secret keeps the previous value');
  const listed = JSON.parse(JSON.stringify(await context.registryApi.listAll()));
  assert.deepEqual(listed[0].config, { retries: 3 });
  assert.deepEqual(listed[0].configSecrets, { token: true });
  assert.equal(JSON.stringify(listed).includes(secret), false, 'management response must not disclose the secret');

  context.pendingCall = vm.runInContext("setConfig('secret-fixture', { retries: 4, token: 'replacement' })", context);
  await context.pendingCall;
  assert.equal(persisted.token, 'replacement');
  const before = writes;
  for (const body of [
    "setConfig('secret-fixture', { token: 'x', retries: 99 })",
    "setConfig('secret-fixture', { token: 'x', retries: 1, injected: true })",
  ]) {
    context.pendingCall = vm.runInContext(body, context);
    await assert.rejects(context.pendingCall, error => error.statusCode === 400);
  }
  assert.equal(writes, before, 'invalid config is rejected before the database write');
  assert.equal(rollbacks, 2, 'each invalid config transaction rolls back');
  assert.equal(persisted.token, 'replacement');
  console.log('PASS plugin secret config: blank preservation, replacement, list redaction and validation rollback');
})().catch(error => { console.error(error); process.exitCode = 1; });
