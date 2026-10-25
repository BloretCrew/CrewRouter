'use strict';

// Evaluate the real middleware and key credential pipeline against synthetic
// data. Do not import API startup, deployment config or database modules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { test } = require('node:test');
const source = fs.readFileSync(path.resolve(__dirname, '../routes/api.js'), 'utf8');
function declaration(name, prefix = 'function') {
  const start = source.indexOf(`${prefix} ${name}`);
  assert(start >= 0, name);
  const end = source.indexOf('\n}', start);
  assert(end > start, name);
  return source.slice(start, end + 2);
}
function fixture() {
  const state = { quotaExceeded: false, denyModel: false, cacheCalls: 0, updates: 0, keyLoads: 0, refreshes: 0,
    token: { id: 1, kind: 'access', revoked: false, expires_at: new Date(Date.now() + 60000), user_id: 7, api_key_id: 11, client_id: 'offline-client', scope: 'gateway:invoke events:report' },
    key: { id: 11, user_id: 7, username: 'offline-owner', balance: 0, team_id: 4, enabled: true, expires_at: null,
      user_rate_limit_rpm: 3, user_rate_limit_tpm: 50, swallow_images: true, crewrouter_commands: false,
      fusion_enabled: false, fusion_synthesis_prompt_enabled: false, current_model_id: 'model', fusion_panel_models: ['denied'],
      signature_enabled: true, signature_template: 'offline-signature' } };
  const pool = { async query(sql, params) {
    if (sql.startsWith('SELECT * FROM oauth_tokens')) return { rows: state.token ? [state.token] : [] };
    if (sql.includes('SELECT ak.*, u.id as user_id')) {
      state.keyLoads++;
      assert(sql.includes('ak.id = $1 AND ak.user_id = $2'));
      assert.deepEqual(Array.from(params), [11, state.token.user_id]);
      return { rows: state.key && state.key.user_id === params[1] ? [state.key] : [] };
    }
    if (sql.includes('SELECT signature_enabled')) return { rows: state.key ? [state.key] : [] };
    if (sql.includes('JOIN users u ON u.id = ak.user_id')) {
      state.refreshes++;
      return { rows: state.key ? [state.key] : [] };
    }
    if (sql.includes('FROM api_key_models')) return { rows: [{ model_id: 'model' }] };
    if (sql.includes('FROM api_key_harness_models')) return { rows: [{ harness: 'codex', model_id: 'model' }] };
    if (sql.startsWith('UPDATE ')) { state.updates++; return { rows: [] }; }
    throw new Error(`Unexpected synthetic OAuth query: ${sql}`);
  } };
  const Logger = { debug() {}, warn() {}, error() {} };
  const apiContext = {
    pool, Logger, Date, Number, Set,
    pluginHooks: { hasSubscribers: () => false },
    sha256Hex: value => crypto.createHash('sha256').update(value).digest('hex'),
    getCachedApiKey() { state.cacheCalls++; throw new Error('OAuth must not use raw-key cache'); },
    setCachedApiKey() { state.cacheCalls++; throw new Error('OAuth must not enter raw-key cache'); },
    invalidateApiKeyCacheByKeyId() {},
    checkQuotaRules: async () => [{ exceeded: state.quotaExceeded }],
    notifyUser: async () => {}, NOTIFICATION_TYPES: { QUOTA_INSUFFICIENT: 'quota' },
    loadModelQueueForKey: async () => ['model'], loadHarnessModelsForKey: async () => ({ codex: 'model' }),
    getAuthorizedModelIds: async () => new Set(state.denyModel ? [] : ['model', 'denied']),
    buildInjectedPrompt: async () => 'offline-prompt',
  };
  vm.createContext(apiContext);
  vm.runInContext([
    declaration('ApiKeyLifecycleError', 'class'),
    declaration('validateApiKey', 'async function'), declaration('refreshApiUserModelAuthorization', 'async function'),
    ...['isAnthropicApiPath', 'buildApiErrorBody', 'omitOpenAIOnly'].map(name => declaration(name)),
    'this.validateBoundApiKey = (req,res,next,binding) => validateApiKey(req,res,next,binding);',
  ].join('\n'), apiContext);
  const mocks = { crypto, '../models/database': { pool }, '../logger': Logger,
    '../routes/oauth': { ensureOAuthTables: async () => {} },
    '../routes/api': { validateBoundApiKey: apiContext.validateBoundApiKey, validateApiKey() { throw new Error('unexpected raw-key fallback'); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../middleware/oauth-bearer.js'), 'utf8'), {
    module, exports: module.exports, Date,
    require(name) { assert(Object.hasOwn(mocks, name), name); return mocks[name]; },
  });
  async function request(url = '/v1/chat/completions') {
    const req = { headers: { authorization: 'Bearer crh_offline-only' }, originalUrl: url, path: url, body: {} };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, set() {} };
    let called = false;
    await module.exports.oauthBearer(req, res, () => { called = true; });
    return { req, res, called };
  }
  return { state, request };
}

test('OAuth hydrates ordinary key policy including model access, limits, Fusion, image handling and signatures', async () => {
  const f = fixture();
  f.state.denyModel = true;
  const { req, called } = await f.request();
  assert(called);
  assert.equal(req.apiUser.userRateLimitRpm, 3);
  assert.equal(req.apiUser.userRateLimitTpm, 50);
  assert.equal(req.apiUser.swallowImages, true);
  assert.equal(req.apiUser.crewrouterCommands, false);
  assert.equal(req.apiUser.fusionEnabled, false);
  assert.equal(req.apiUser.fusionSynthesisPromptEnabled, false);
  assert.equal(req.apiUser.signatureEnabled, true);
  assert.equal(req.apiUser.signatureTemplate, 'offline-signature');
  assert.equal(req.apiUser.injectPrompt, 'offline-prompt');
  assert(req.apiUser.modelAuthorization.deniedModelIds.includes('model'));
  assert.equal(req.apiUser.viaOAuth, true);
  assert.equal(f.state.refreshes, 1);
  assert.equal(f.state.cacheCalls, 0);
});

test('OAuth obeys Team quota denial and permits paid balance under ordinary key rules', async () => {
  const f = fixture();
  f.state.quotaExceeded = true;
  const denied = await f.request();
  assert.equal(denied.res.statusCode, 429);
  assert.equal(denied.called, false);
  assert.equal(f.state.updates, 0);
  f.state.key.balance = 2;
  assert.equal((await f.request()).called, true);
});

for (const [label, change, status] of [
  ['deleted key', state => { state.key = null; }, 401],
  ['different owner', state => { state.token.user_id = 8; }, 401],
  ['disabled key', state => { state.key.enabled = false; }, 403],
  ['expired key', state => { state.key.expires_at = new Date(0); }, 401],
  ['invalid key expiry', state => { state.key.expires_at = 'bad-date'; }, 401],
  ['revoked token', state => { state.token.revoked = true; }, 401],
  ['refresh token', state => { state.token.kind = 'refresh'; }, 401],
  ['expired token', state => { state.token.expires_at = new Date(0); }, 401],
  ['invalid token expiry', state => { state.token.expires_at = 'bad-date'; }, 401],
  ['wrong scope', state => { state.token.scope = 'events:report'; }, 403],
]) {
  test(`OAuth rejects ${label} without downstream execution or last-used writes`, async () => {
    const f = fixture(); change(f.state);
    const result = await f.request();
    assert.equal(result.res.statusCode, status);
    assert.equal(result.called, false);
    assert.equal(f.state.updates, 0);
  });
}

test('events-only tokens remain valid for client-events while gateway-only tokens cannot report events', async () => {
  const f = fixture();
  f.state.token.scope = 'events:report';
  assert.equal((await f.request('/api/client-events')).called, true);
  f.state.token.scope = 'gateway:invoke';
  const result = await f.request('/api/client-events');
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.called, false);
});
