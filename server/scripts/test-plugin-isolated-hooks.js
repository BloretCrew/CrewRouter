'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sandbox = require('../plugins/task-sandbox');

function loadRegistry(pool, hooksBus, warnings) {
  const filename = path.resolve(__dirname, '../plugins/registry.js');
  const fixtureModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: fixtureModule,
    exports: fixtureModule.exports,
    __dirname: path.dirname(filename),
    process: { cwd: () => path.resolve(__dirname, '../..') },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, Map, Set, Promise, URL, Buffer,
    require(id) {
      if (id === 'fs') return fs;
      if (id === 'path') return path;
      if (id === 'node:crypto') return require('node:crypto');
      if (id === '../models/database') return { pool };
      if (id === '../logger') return { info() {}, warn(message) { warnings.push(message); }, error(message) { warnings.push(message); } };
      if (id === './hooks') return hooksBus;
      if (id === './events') return { publish() {}, unsubscribePluginEvents() {} };
      if (id === './task-sandbox') return sandbox;
      if (id === './host') return { HOOK_TIMEOUT_MS: 2000, validateManifest: () => null, loadPluginMain() { throw new Error('isolated-hooks must not run main.js'); } };
      if (id === './isolated-hook-contract') return require('../plugins/isolated-hook-contract');
      if (id === '../utils/plugin-task-queue') return { createTaskQueue: () => ({ ensureSchema: async () => {}, cancelPlugin: async () => {}, start() {}, stop() {}, enqueue() {}, get() {}, cancel() {}, getTaskQueueStats() {} }) };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return fixtureModule.exports;
}

(async () => {
  if (process.platform !== 'linux' || !sandbox.selectBwrap()) {
    console.log('SKIP isolated-hooks runtime integration: Linux bubblewrap is unavailable');
    return;
  }
  const prevEnabled = process.env.CR_ENABLE_PLUGIN_BWRAP;
  const prevNode = process.env.CR_PLUGIN_NODE_PATH;
  process.env.CR_ENABLE_PLUGIN_BWRAP = '1';
  if (!process.env.CR_PLUGIN_NODE_PATH && fs.existsSync('/usr/bin/node-22')) process.env.CR_PLUGIN_NODE_PATH = '/usr/bin/node-22';
  const calls = [];
  const warnings = [];
  const pool = {
    async query(sql, params = []) {
      if (/INSERT INTO plugins/.test(sql)) return { rows: [] };
      if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [] };
      if (/SELECT id, config FROM plugins/.test(sql)) return { rows: [
        { id: 'example-isolated-hooks', config: {} },
        { id: 'example-isolated-routes', config: {} },
      ] };
      if (/UPDATE plugins SET last_error|UPDATE plugins SET enabled/.test(sql)) return { rows: [] };
      if (/SELECT \* FROM plugins ORDER BY id/.test(sql)) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql} ${JSON.stringify(params)}`);
    },
  };
  const hooksBus = {
    setErrorReporter() {},
    subscribe(...args) { calls.push(args); },
    unsubscribePlugin(pluginId) { for (let i = calls.length - 1; i >= 0; i--) if (calls[i][0] === pluginId) calls.splice(i, 1); },
    hasSubscribers() { return false; },
    async apply() {},
  };
  try {
    const registry = loadRegistry(pool, hooksBus, warnings);
    assert.equal(registry.PLUGINS_DIR, path.resolve(__dirname, '../../plugins'));
    assert.ok(fs.existsSync(path.join(registry.PLUGINS_DIR, 'example-isolated-hooks', 'plugin.json')));
    await registry.init();
    assert.deepEqual(JSON.parse(JSON.stringify(registry.listLoadedIds())).sort(), ['example-isolated-hooks', 'example-isolated-routes'], warnings.join('; '));
    const subscription = calls.find(row => row[1] === 'billing:calculate');
    assert.ok(subscription, 'isolated billing hook registered through the host bus');
    const result = await subscription[2]({ cost: 3, ratio: 1, weightedTokens: 100, password: 'must-not-cross-ipc' }, { requestType: 'openai', userId: 42, provider: { api_key: 'secret' } });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { cost: 3, ratio: 0.9, weightedTokens: 100, password: 'must-not-cross-ipc' });
    const finalResponse = calls.find(row => row[1] === 'gateway:finalResponse');
    assert.ok(finalResponse, 'isolated finalResponse hook registered');
    const headerResult = await finalResponse[2]({ statusCode: 200, headers: { Authorization: 'must-not-cross-ipc' } }, { requestType: 'openai', model: 'secret-model' });
    assert.deepEqual(JSON.parse(JSON.stringify(headerResult)), { statusCode: 200, headers: { 'X-Plugin-example-isolated-hooks-Trace': 'sandboxed' } });
    const modelList = calls.find(row => row[1] === 'models:list');
    assert.ok(modelList);
    const filteredModels = await modelList[2]({ models: [{ id: 'public-model', api_key: 'secret' }, { id: 'internal-hidden', api_key: 'secret' }] }, { requestType: 'gemini', userId: 42 });
    assert.deepEqual(JSON.parse(JSON.stringify(filteredModels)), { models: [{ id: 'public-model', api_key: 'secret' }] });
    const selectProvider = calls.find(row => row[1] === 'provider:select');
    assert.ok(selectProvider);
    const candidates = [{ id: 'provider-a', name: 'A', api_key: 'secret-a' }, { id: 'provider-b', name: 'B', api_key: 'secret-b' }];
    const chosen = await selectProvider[2]({ candidates }, { providerId: 'provider-a', group: 'test', api_key: 'meta-secret' });
    assert.deepEqual(JSON.parse(JSON.stringify(chosen.candidates)), [candidates[1], candidates[0]]);
    const route = registry.findHandler('example-isolated-routes', 'POST', '/echo');
    assert.ok(route, 'isolated JSON route registered without in-process handler function');
    const routeResponse = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return body; } };
    await route({ method: 'POST', body: { text: 'hello' }, query: { q: '1' }, authUser: { id: 42, isAdmin: false, email: 'private' }, headers: { cookie: 'secret' } }, routeResponse);
    assert.deepEqual(JSON.parse(JSON.stringify(routeResponse.body)), { ok: true, method: 'POST', authRole: 'user', body: { text: 'hello' } });
    await registry.disable('example-isolated-hooks');
    assert.equal(calls.length, 0, 'disable removes isolated hook subscriber');
    await registry.disable('example-isolated-routes');
    assert.equal(registry.findHandler('example-isolated-routes', 'POST', '/echo'), null, 'disable removes isolated route handler');
    console.log('PASS isolated billing hook runs under bwrap; host secrets are projected out and disable unloads it');
  } finally {
    if (prevEnabled === undefined) delete process.env.CR_ENABLE_PLUGIN_BWRAP; else process.env.CR_ENABLE_PLUGIN_BWRAP = prevEnabled;
    if (prevNode === undefined) delete process.env.CR_PLUGIN_NODE_PATH; else process.env.CR_PLUGIN_NODE_PATH = prevNode;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
