'use strict';

// Execute the real middleware with pure substitutes: no deployment config,
// database module, upstream, timers, or network are loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
const cache = source.slice(source.indexOf('const apiKeyCache = new Map();'), source.indexOf('async function getProvider(providerId)'));
const middleware = source.slice(source.indexOf('async function validateApiKey(req, res, next)'), source.indexOf('/**\n * 根据供应商配置构建上游请求头'));

function worker(state) {
  const key = { id: 1, user_id: 10, username: 'owner', enabled: true };
  const context = vm.createContext({
    Map, Date, setInterval() {}, sha256Hex: value => value,
    Logger: { debug() {}, warn() {}, error() {} },
    pluginHooks: { hasSubscribers: () => false },
    isAnthropicApiPath: () => false,
    buildApiErrorBody: (_req, type, message, extra) => ({ type, message, ...extra }),
    ApiKeyLifecycleError: class extends Error {},
    refreshApiUserModelAuthorization: async () => { if (state.pause) await state.pause; },
    loadModelQueueForKey: async () => [], loadHarnessModelsForKey: async () => ({}),
    buildInjectedPrompt: async (user, id) => {
      assert.equal(user, 10);
      return state.fail ? Promise.reject(new Error('fake query failure')) : state.prompt(id);
    },
    pool: { query: async sql => ({ rows: sql.includes('SELECT ak.*') ? [key]
      : sql.includes('SELECT signature_enabled') ? [{ signature_enabled: null }]
        : sql.includes('SELECT team_id') ? [{ team_id: null }] : [] }) },
  });
  vm.runInContext(`${cache}\n${middleware}\nthis.api = { validateApiKey, getCachedApiKey, invalidateUserApiKeyCache };`, context);
  return {
    ...context.api,
    async request() {
      const req = { headers: { 'x-api-key': 'test-key' }, path: '/chat/completions' };
      let calls = 0;
      await context.api.validateApiKey(req, { status() { throw new Error('Unexpected auth rejection'); } }, () => calls++);
      assert.equal(calls, 1);
      assert.equal(req.apiUser.userId, 10);
      assert.equal(req.apiUser.keyId, 1);
      assert.equal(Object.hasOwn(context.api.getCachedApiKey('test-key'), 'injectPrompt'), false);
      return req.apiUser;
    },
  };
}

(async () => {
  const state = { prompt: () => 'global' };
  const first = worker(state), second = worker(state);
  assert.equal((await first.request()).injectPrompt, 'global');
  assert.equal((await second.request()).injectPrompt, 'global');
  // Other keys are outside a newly introduced binding, even with warm caches.
  state.prompt = id => id === 2 ? 'bound' : null;
  assert.equal((await first.request()).injectPrompt, null, 'global -> bound');
  assert.equal((await second.request()).injectPrompt, null, 'other worker sees binding change');
  state.prompt = () => 'global-again';
  assert.equal((await first.request()).injectPrompt, 'global-again', 'bound -> global');
  state.prompt = () => null;
  assert.equal((await first.request()).injectPrompt, null, 'disabled');
  state.prompt = () => 'replacement';
  await first.request();
  state.prompt = () => null;
  assert.equal((await first.request()).injectPrompt, null, 'deleted');
  // An in-flight request keeps its earlier snapshot, but cannot refill the
  // shared credential cache with it after revocation.
  let release;
  state.pause = new Promise(resolve => { release = resolve; });
  const third = worker(state);
  state.prompt = () => 'before-revocation';
  const inFlight = third.request();
  await new Promise(resolve => setImmediate(resolve));
  third.invalidateUserApiKeyCache(10);
  state.prompt = () => null;
  release();
  assert.equal((await inFlight).injectPrompt, 'before-revocation', 'in-flight prompt snapshot');
  assert.equal((await third.request()).injectPrompt, null, 'no stale refill');
  state.pause = null;
  state.fail = true;
  assert.equal((await first.request()).injectPrompt, null, 'warm query failure remains nonfatal');
  assert.equal((await worker(state).request()).injectPrompt, null, 'cold query failure remains nonfatal');
  console.log('PASS inject prompt cache lifecycle: binding transitions, disable/delete, worker isolation, in-flight refill, query failures');
})().catch(error => { console.error(error); process.exitCode = 1; });
