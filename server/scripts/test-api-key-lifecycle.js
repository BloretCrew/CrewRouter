'use strict';

// Evaluate only credential/request functions with synthetic data. Never import
// deployment config, database modules, authentication startup or transports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../routes/api.js'), 'utf8');
const RAW_KEY = 'sk-offline-lifecycle-fixture';
const NOW = 1800000000000;

function declaration(name, prefix = 'function') {
  const start = source.indexOf(`${prefix} ${name}`);
  assert(start >= 0, name);
  const end = source.indexOf('\n}', start);
  assert(end > start, name);
  return source.slice(start, end + 2);
}

function isolatedPoints(state) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../utils/points-deduct.js'), 'utf8'), {
    module, require(name) {
      if (name === '../models/database') return { pool: { query() { throw new Error('Unexpected quota database access'); } } };
      if (name === './quota-data') return { getUserQuotaBuffer: () => [] };
      if (name === './money') return require('../utils/money');
      throw new Error(`Unexpected isolated dependency: ${name}`);
    },
  });
  return args => module.exports.canConsumePoints(args, { checkQuotaRules: async () => state.rules });
}

function fixture() {
  const state = { enabled: true, expires_at: null, exists: true, ownerExists: true,
    cache: null, writes: 0, refreshes: 0, cacheSets: 0, invalidations: 0, downstream: 0,
    transportError: false, disableDuringColdLoad: false, optIn: undefined, balance: 10, refund: 0, teamId: null, rules: null };
  const user = () => ({ keyId: 17, userId: 29, username: 'synthetic-owner', enabled: true, teamId: null, balance: 10 });
  const sandbox = {
    Date: class extends Date { static now() { return NOW; } },
    Number, Map, Set,
    pool: { async query(sql) {
      if (sql.includes('JOIN users u ON u.id = ak.user_id')) {
        state.refreshes++;
        if (state.transportError) throw new Error('synthetic database failure');
        assert(sql.includes('ak.enabled') && sql.includes('ak.expires_at'));
        return { rows: state.exists && state.ownerExists ? [{ current_model_id: 'fixture-model',
          fusion_panel_models: [], enabled: state.enabled, expires_at: state.expires_at,
          api_signature_enabled: state.optIn }] : [] };
      }
      if (sql.includes('SELECT ak.*, u.id as user_id')) {
        return { rows: state.exists && state.ownerExists ? [{ id: 17, user_id: 29, enabled: state.enabled,
          expires_at: state.expires_at, crewrouter_commands: state.optIn, quota_warning_enabled: state.optIn, api_signature_enabled: state.optIn, balance: state.balance, refund_balance: state.refund, team_id: state.teamId, current_model_id: 'fixture-model' }] : [] };
      }
      if (sql.includes('SELECT signature_enabled')) return { rows: [{ signature_enabled: null }] };
      if (sql.includes('FROM api_key_models')) return { rows: [{ model_id: 'fixture-model' }] };
      if (sql.includes('FROM api_key_harness_models')) return { rows: [] };
      if (sql.startsWith('SELECT team_id, balance FROM users')) return { rows: [{ team_id: state.teamId, balance: state.balance }] };
      if (sql.startsWith('UPDATE api_keys SET last_used_at')) { state.writes++; return { rows: [] }; }
      throw new Error(`Unexpected isolated query: ${sql}`);
    } },
    getAuthorizedModelIds: async () => new Set(['fixture-model']),
    getCachedApiKey: key => { assert.equal(key, RAW_KEY); return state.cache; },
    setCachedApiKey: (key, value) => { assert.equal(key, RAW_KEY); state.cache = value; state.cacheSets++; },
    invalidateApiKeyCacheByKeyId: key => { assert.equal(key, 17); state.cache = null; state.invalidations++; },
    pluginHooks: { hasSubscribers: () => false },
    Logger: { debug() {}, warn() {}, error() {} },
    sha256Hex: () => 'synthetic-hash',
    loadModelQueueForKey: async () => ['fixture-model'],
    loadHarnessModelsForKey: async () => ({}),
    buildInjectedPrompt: async () => { if (state.disableDuringColdLoad) state.enabled = false; return null; },
    canConsumePoints: isolatedPoints(state),
    notifyUser: async () => {}, NOTIFICATION_TYPES: { QUOTA_INSUFFICIENT: 'quota' },
    googleError: { googleErrorBody: (code, message, options = {}) => ({ error: { code, message, status: options.status || 'UNKNOWN' } }) },
    require: () => { state.downstream++; throw new Error('Unexpected downstream dependency'); },
  };
  const functions = [
    declaration('ApiKeyLifecycleError', 'class'),
    ...['refreshApiUserModelAuthorization', 'refreshApiUserForRequest', 'validateApiKey',
      'handleChatCompletion', 'handleAnthropicMessage', 'handleResponses'].map(name => declaration(name, 'async function')),
    ...['isAnthropicApiPath', 'isGeminiApiPath', 'buildApiErrorBody', 'omitOpenAIOnly'].map(name => declaration(name)),
  ].join('\n');
  vm.createContext(sandbox);
  vm.runInContext(`${functions}\nthis.fixtureFunctions = { validateApiKey, refreshApiUserForRequest, handleChatCompletion, handleAnthropicMessage, handleResponses };`, sandbox);
  async function request(route = '/chat/completions', handler = 'validateApiKey', binding = null) {
    const req = { path: route, headers: { 'x-api-key': RAW_KEY }, apiUser: user(), body: { model: 'fusion' } };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    let next = false;
    await sandbox.fixtureFunctions[handler](req, res, () => { next = true; }, binding);
    return { req, res, next };
  }
  return { state, user, request };
}

async function main() {
  for (const route of ['/chat/completions', '/messages', '/responses']) {
    for (const [change, status] of [
      [{ enabled: false }, 403], [{ exists: false }, 401], [{ ownerExists: false }, 401],
      [{ expires_at: new Date(NOW - 1) }, 401], [{ expires_at: new Date(NOW) }, 401],
    ]) {
      const f = fixture();
      assert.equal((await f.request(route)).next, true, 'valid cold key must authenticate');
      assert.equal(f.state.cacheSets, 1);
      Object.assign(f.state, change);
      const beforeWrites = f.state.writes;
      const denied = await f.request(route);
      assert.equal(denied.next, false);
      assert.equal(denied.res.statusCode, status);
      assert.equal(denied.res.body.error.type, 'authentication_error');
      assert.equal(denied.res.body.type, route === '/messages' ? 'error' : undefined);
      assert.equal(denied.res.body.error.code, route !== '/messages' && status === 403 ? 'key_disabled' : undefined);
      assert.equal(f.state.writes, beforeWrites, 'rejected cached credentials must not update last_used_at');
      assert.equal(f.state.cache, null);
      assert.equal(f.state.cacheSets, 1, 'a rejected key must not repopulate cache');
    }
  }
  for (const [handler, route] of [['handleChatCompletion', '/chat/completions'],
    ['handleAnthropicMessage', '/messages'], ['handleResponses', '/responses']]) {
    for (const [change, status] of [[{ enabled: false }, 403], [{ exists: false }, 401], [{ expires_at: new Date(NOW) }, 401]]) {
      const f = fixture();
      Object.assign(f.state, change);
      const result = await f.request(route, handler);
      assert.equal(result.res.statusCode, status);
      assert.equal(result.res.body.error.type, 'authentication_error');
      assert.equal(result.res.body.type, route === '/messages' ? 'error' : undefined);
      assert.equal(f.state.downstream, 0, 'reject before commands, plugins, Fusion or transports');
    }
  }
  const valid = fixture();
  assert.equal((await valid.request()).next, true);
  valid.state.expires_at = new Date(NOW + 1);
  assert.equal((await valid.request()).next, true, 'not-yet-expired cached key remains valid');
  assert.equal(valid.state.refreshes, 2, 'each request reads authoritative lifecycle state');
  const coldRace = fixture();
  coldRace.state.disableDuringColdLoad = true;
  assert.equal((await coldRace.request()).res.statusCode, 403);
  assert.equal(coldRace.state.cacheSets, 0, 'disable during cold loading must not fill cache');
  assert.equal(coldRace.state.writes, 0, 'disable during cold loading must not update last_used_at');
  for (const change of [{ enabled: false }, { exists: false }, { ownerExists: false }, { expires_at: new Date(NOW - 100000000000) }]) {
    const cold = fixture();
    Object.assign(cold.state, change);
    assert.equal((await cold.request()).next, false);
    assert.equal(cold.state.cacheSets, 0);
  }
  const unavailable = fixture();
  unavailable.state.cache = unavailable.user();
  unavailable.state.transportError = true;
  assert.equal((await unavailable.request()).res.statusCode, 500, 'database errors retain the existing server-error contract');
  for (const value of [undefined, null, false, true]) {
    const f = fixture();
    f.state.optIn = value;
    for (let i = 0; i < 2; i++) {
      const { req, next } = await f.request();
      assert.equal(next, true);
      assert.equal(req.apiUser.crewrouterCommands, value === true);
      assert.equal(req.apiUser.quotaWarningEnabled, value === true);
      assert.equal(req.apiUser.signatureEnabled, value === true);
    }
  }
  const exhausted = { exceeded: true, duration_hours: 1 };
  const available = { exceeded: false, duration_hours: 24 };
  for (const mode of ['cold', 'cached', 'oauth']) {
    for (const [teamId, rules, balance, refund, allowed] of [
      [2, [exhausted, available], 0, 0, true], [2, [available, exhausted], -1, 0, true],
      [2, [exhausted], 0, 9, false], [2, [exhausted], -1, 9, false],
      [2, [exhausted], '0.000001', 0, true], [2, [], 0, 0, false],
      [2, null, 0, 0, false], [null, null, 0, 9, false],
      [null, null, 1, -1, true], [2, [], 1, 0, true],
    ]) {
      const f = fixture();
      Object.assign(f.state, { teamId, rules, balance, refund });
      if (mode === 'cached') f.state.cache = { ...f.user(), balance: allowed ? -100 : 100 };
      const result = await f.request('/chat/completions', 'validateApiKey', mode === 'oauth' ? { keyId: 17, userId: 29 } : null);
      assert.equal(result.next, allowed, JSON.stringify({ mode, teamId, rules, balance, refund }));
      if (allowed) assert.equal(String(result.req.apiUser.balance), String(balance));
      else assert.equal(result.res.statusCode, 429);
      if (mode === 'oauth') assert.equal(f.state.cacheSets, 0);
    }
  }
  for (const [before, after, allowed] of [[10, 0, false], [0, 10, true]]) {
    const f = fixture();
    f.state.cache = { ...f.user(), balance: before };
    f.state.balance = after;
    assert.equal((await f.request()).next, allowed, 'cached balance never overrides current balance');
  }
  console.log('API Key lifecycle: synthetic cold/cache revocation, expiry boundary, owner deletion, gateway rejection and error contracts passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
