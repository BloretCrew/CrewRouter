'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function loadModule(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module,
    exports: module.exports,
    Buffer,
    URL,
    Date,
    process: { env: {} },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith('.')) return require(path.resolve(path.dirname(file), name));
      return require(name);
    },
  }, { filename: file });
  return module.exports;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function keyRow(overrides = {}) {
  return {
    id: 10,
    user_id: 7,
    name: 'key',
    enabled: true,
    expires_at: null,
    permissions: ['gateway.chat'],
    owner_id: 7,
    username: 'alice',
    email: 'alice@example.test',
    is_admin: false,
    team_id: 3,
    ...overrides,
  };
}

function loadRequestAuth({ row = keyRow() } = {}) {
  const pool = {
    async query(sql) {
      if (sql.includes('FROM api_keys ak')) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
  };
  return loadModule(path.resolve(__dirname, '../middleware/request-auth.js'), {
    '../models/database': { pool },
    '../logger': { error() {}, warn() {}, info() {} },
  });
}

test('valid API key becomes the request actor and session is ignored', async () => {
  const { resolveRequestAuth } = loadRequestAuth();
  const req = { path: '/api/user/api-keys', headers: { 'x-api-key': 'sk-test' }, session: { user: { id: 99, username: 'session' } } };
  const res = response();
  let called = false;
  await resolveRequestAuth(req, res, () => { called = true; });
  assert(called);
  assert.equal(req.authActor.type, 'api_key');
  assert.equal(req.authActor.user.id, 7);
  assert.equal(req.authUser.username, 'alice');
  assert.deepEqual(req.authActor.key.permissions, ['gateway.chat']);
});

test('invalid, disabled and expired keys never fall back to session', async () => {
  for (const [row, status, code] of [
    [null, 401, 'invalid_api_key'],
    [keyRow({ enabled: false }), 403, 'key_disabled'],
    [keyRow({ expires_at: new Date(Date.now() - 1000).toISOString() }), 401, 'key_expired'],
  ]) {
    const { resolveRequestAuth } = loadRequestAuth({ row });
    const req = { path: '/api/user/api-keys', headers: { authorization: 'Bearer sk-test' }, session: { user: { id: 7 } } };
    const res = response();
    await resolveRequestAuth(req, res, () => assert.fail('must not continue'));
    assert.equal(res.statusCode, status);
    assert.equal(res.body.code, code);
  }
});

test('session-only paths reject API keys and OAuth tokens', async () => {
  const { resolveRequestAuth } = loadRequestAuth();
  for (const [pathname, headers] of [
    ['/api/passkey/list', { 'x-api-key': 'sk-test' }],
    ['/auth/login', { 'x-api-key': 'sk-test' }],
    ['/oauth/authorize', { authorization: 'Bearer crh_token' }],
    ['/oauth/github-actions', { authorization: 'Bearer crh_token' }],
    ['/api/user/model-trace/jobs', { authorization: 'Bearer crh_token' }],
  ]) {
    const req = { path: pathname, headers };
    const res = response();
    await resolveRequestAuth(req, res, () => assert.fail('must not continue'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'session_required');
  }
});

test('OAuth token cannot borrow a console session', async () => {
  const { resolveRequestAuth } = loadRequestAuth();
  const req = { path: '/api/user/api-keys', headers: { authorization: 'Bearer crh_token' }, session: { user: { id: 7 } } };
  const res = response();
  await resolveRequestAuth(req, res, () => assert.fail('must not continue'));
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'oauth_token_not_allowed');
});

test('permission middleware allows session and denies missing or admin-only permissions', () => {
  const { requireApiKeyPermission } = loadModule(path.resolve(__dirname, '../middleware/api-key-permissions.js'), {
    '../utils/api-key-permissions': require('../utils/api-key-permissions'),
    './request-auth': loadRequestAuth(),
  });
  const sessionReq = { authActor: { type: 'session', user: { id: 1 } }, method: 'GET', originalUrl: '/api/admin/users' };
  let sessionCalled = false;
  requireApiKeyPermission(sessionReq, response(), () => { sessionCalled = true; });
  assert(sessionCalled);

  const grantedReq = {
    authActor: { type: 'api_key', user: { id: 7, isAdmin: false }, key: { permissions: ['keys.read'] } },
    method: 'GET', originalUrl: '/api/user/api-keys', path: '/api/user/api-keys',
  };
  let grantedCalled = false;
  requireApiKeyPermission(grantedReq, response(), () => { grantedCalled = true; });
  assert(grantedCalled);
  assert.equal(grantedReq.apiKeyPermission, 'keys.read');

  const deniedReq = {
    authActor: { type: 'api_key', user: { id: 7, isAdmin: false }, key: { permissions: [] } },
    method: 'GET', originalUrl: '/api/user/api-keys', path: '/api/user/api-keys',
  };
  const deniedRes = response();
  requireApiKeyPermission(deniedReq, deniedRes, () => assert.fail('must not continue'));
  assert.equal(deniedRes.statusCode, 403);
  assert.equal(deniedRes.body.code, 'permission_denied');

  const adminReq = {
    authActor: { type: 'api_key', user: { id: 7, isAdmin: false }, key: { permissions: ['admin.users.read'] } },
    method: 'GET', originalUrl: '/api/admin/users', path: '/api/admin/users',
  };
  const adminRes = response();
  requireApiKeyPermission(adminReq, adminRes, () => assert.fail('must not continue'));
  assert.equal(adminRes.statusCode, 403);
  assert.equal(adminRes.body.code, 'admin_required');

  const unmappedReq = {
    authActor: { type: 'api_key', user: { id: 7, isAdmin: false }, key: { permissions: ['gateway.chat'] } },
    method: 'GET', originalUrl: '/api/user/not-a-route', path: '/api/user/not-a-route',
  };
  const unmappedRes = response();
  requireApiKeyPermission(unmappedReq, unmappedRes, () => assert.fail('must not continue'));
  assert.equal(unmappedRes.statusCode, 403);
  assert.equal(unmappedRes.body.code, 'permission_not_configured');
});

test('raw key gateway requests require the matching gateway permission', async () => {
  const loadOAuthBearer = (permissions) => loadModule(path.resolve(__dirname, '../middleware/oauth-bearer.js'), {
    '../models/database': { pool: { async query() { return { rows: [] }; } } },
    '../logger': { error() {}, warn() {}, info() {} },
    '../routes/oauth': { ensureOAuthTables: async () => {} },
    '../utils/api-key-permissions': require('../utils/api-key-permissions'),
    '../routes/api': {
      validateApiKey(req, _res, next) {
        req.apiUser = { permissions, userId: 7, keyId: 1 };
        next();
      },
      validateBoundApiKey() {},
    },
  });

  for (const [permissions, expectedStatus, expectedCode] of [
    [['gateway.chat'], null, null],
    [[], 403, 'permission_denied'],
  ]) {
    const { oauthBearer } = loadOAuthBearer(permissions);
    const req = { headers: { authorization: 'Bearer sk-test' }, originalUrl: '/v1/chat/completions', path: '/v1/chat/completions', method: 'POST' };
    const res = response();
    let called = false;
    await oauthBearer(req, res, () => { called = true; });
    if (expectedStatus) {
      assert.equal(called, false);
      assert.equal(res.statusCode, expectedStatus);
      assert.equal(res.body.error.code, expectedCode);
    } else {
      assert(called);
    }
  }
});

test('guard branches use the key owner identity without session writes', async () => {
  const { requireAuth, requireAdmin } = loadModule(path.resolve(__dirname, '../middleware/auth.js'), {
    '../models/database': { pool: { async query() { throw new Error('key branch must not query'); } } },
    '../config-loader': {},
    '../utils/instance-edition': { loadPersistedEdition: async () => null, normalizeRuntime: () => 'server', normalizeEdition: () => 'personal' },
  });
  const actor = {
    type: 'api_key',
    user: { id: 7, username: 'alice', isAdmin: true },
    key: { id: 10, permissions: ['keys.read'], ownerUserId: 7 },
  };
  const req = { authActor: actor, session: {} };
  let called = false;
  await requireAuth(req, response(), () => { called = true; });
  assert(called);
  assert.equal(req.authUser.id, 7);
  assert.equal(req.session.user, undefined);

  called = false;
  await requireAdmin(req, response(), () => { called = true; });
  assert(called);
  assert.equal(req.session.user, undefined);
});
