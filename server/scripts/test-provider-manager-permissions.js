'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const editionUtils = require('../utils/instance-edition');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const logger = { info() {}, warn() {}, error() {} };

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
}

function authContext(options = {}) {
  const calls = [];
  const config = { runtime: options.runtime || 'server', edition: options.configuredEdition };
  const pool = { async query(sql, params) {
    calls.push({ sql, params });
    if (options.fail) throw new Error('database unavailable');
    if (sql.includes('instance_settings')) return { rows: options.edition == null ? [] : [{ edition: options.edition }] };
    return { rows: options.deleted ? [] : [{ id: 7, is_admin: options.admin === true }] };
  } };
  const context = { module: { exports: {} }, require(name) {
    if (name === '../models/database') return { pool };
    if (name === '../config-loader') return config;
    if (name === '../utils/instance-edition') return editionUtils;
    throw new Error(name);
  } };
  vm.runInNewContext(read('middleware/auth.js'), context);
  return { ...context.module.exports, calls };
}

async function testGuards() {
  const cases = [
    { edition: 'personal', expected: 200 },
    { edition: 'personal', admin: true, expected: 200 },
    { edition: 'personal', deleted: true, expected: 401 },
    { edition: 'personal', anonymous: true, expected: 401 },
    { edition: 'personal', fail: true, expected: 503 },
    { edition: 'team', expected: 403 },
    { edition: 'team', admin: true, expected: 200 },
    { edition: 'team', admin: true, deleted: true, expected: 401 },
    { expected: 403 },
    { configuredEdition: 'personal', expected: 403 },
    { edition: 'invalid', expected: 503 },
    { runtime: 'desktop-local', expected: 200 },
    { runtime: 'desktop-local', configuredEdition: 'personal', expected: 200 },
    { runtime: 'desktop-local', configuredEdition: 'team', expected: 403 },
    { runtime: 'desktop-local', configuredEdition: 'invalid', expected: 403 },
    { runtime: 'desktop-local', edition: 'team', expected: 403 },
    { runtime: 'desktop-local', edition: 'team', admin: true, expected: 200 },
    { runtime: 'desktop-local', deleted: true, expected: 401 },
    { runtime: 'desktop-local', fail: true, expected: 503 },
    { runtime: 'invalid', expected: 403 },
  ];
  for (const options of cases) {
    const auth = authContext(options);
    const req = { session: { user: options.anonymous ? null : { id: 7, isAdmin: true, local: true } } };
    const res = response();
    let passed = false;
    await auth.requireProviderManager(req, res, () => { passed = true; });
    assert.strictEqual(passed ? 200 : res.statusCode, options.expected, JSON.stringify(options));
    if (options.expected === 200 && !options.admin) assert(!auth.calls.some(call => call.sql.includes('SELECT is_admin')));
    if (options.edition === 'team' && !options.deleted) assert(auth.calls.some(call => call.sql.includes('SELECT is_admin')));
  }
  // Provider permission must not elevate the session to administrator.
  const req = { session: { user: { id: 7, isAdmin: false } } };
  const auth = authContext({ edition: 'personal' });
  await auth.requireProviderManager(req, response(), () => {});
  assert.strictEqual(req.session.user.isAdmin, false);
  const denied = response();
  await auth.requireAdmin(req, denied, () => assert.fail('settings/users must remain admin-only'));
  assert.strictEqual(denied.statusCode, 403);
}

function testRouteScope() {
  const source = read('routes/admin.js');
  let scoped = 0;
  for (const match of source.matchAll(/router\.(get|post|put|delete)\('([^']+)',([^\n]*)/g)) {
    const [, , route, registration] = match;
    const providerRoute = /^\/(providers|models|provider-tags)(\/|$)/.test(route)
      || /^\/(series-icons|fetch-proxies-url)(\/|$)/.test(route);
    if (providerRoute) {
      assert(registration.includes('requireProviderManager'), route);
      assert(!registration.includes('requireAdmin'), route);
      scoped++;
    } else {
      assert(!registration.includes('requireProviderManager'), route);
      assert(registration.includes('requireAdmin'), route);
    }
  }
  assert(scoped > 50);
  assert(read('routes/teams.js').includes('requireAuth, requireAdmin'));
  assert(source.includes('SELECT p.*, u.username FROM providers p LEFT JOIN users u ON p.created_by = u.id'));
  const createSql = source.match(/INSERT INTO providers \(id, name, base_url,[\s\S]*?ON CONFLICT \(id\) DO UPDATE SET[\s\S]*?`, \[providerId/)[0];
  assert(!createSql.includes('created_by'), 'system creation defaults to NULL and updates preserve legacy ownership');
  assert(read('routes/user.js').includes("router.use(['/providers', '/my-providers', '/models'], requireProviderAccessContext)"));
}

function handler(file, method, route, pool, extra = {}) {
  const source = read(file);
  const start = source.indexOf(`router.${method}('${route}',`);
  assert(start >= 0, route);
  const end = source.indexOf('\n});', start) + 4;
  let result;
  const context = {
    router: { [method](_path, ...handlers) { result = handlers.at(-1); } },
    requireAuth() {}, requireAdmin() {}, requireProviderManager() {},
    auditMiddleware: () => () => {}, ACTIONS: {},
    pool, Logger: logger, ...extra,
  };
  vm.runInNewContext(source.slice(start, end), context);
  return result;
}

async function testUserReadsAndMutations() {
  const rows = [{ id: 'system', created_by: null }, { id: 'own', created_by: 7 }, { id: 'legacy', created_by: 99 }];
  for (const personal of [false, true]) {
    for (const route of ['/providers', '/my-providers']) {
      const pool = { async query(sql, params) {
        if (sql.includes('information_schema')) return { rows: [{ column_name: 'created_by' }] };
        if (route === '/providers') {
          assert.strictEqual(params[1], personal);
          assert(sql.includes('$2::boolean OR created_by IS NULL OR created_by = $1'));
          return { rows: personal ? rows : rows.slice(0, 2) };
        }
        assert.strictEqual(sql.includes('WHERE created_by = $1'), !personal);
        return { rows: personal ? rows : [rows[1]] };
      } };
      const res = response();
      await handler('routes/user.js', 'get', route, pool)({ session: { user: { id: 7 } }, personalProviderManager: personal }, res);
      assert.strictEqual(res.data.length, personal ? 3 : route === '/providers' ? 2 : 1);
    }
    for (const target of rows) {
      let updated = false;
      const pool = { async query(sql, params) {
        if (sql.includes('information_schema')) return { rows: [{ column_name: 'created_by' }] };
        if (sql.startsWith('SELECT id FROM providers')) {
          assert.strictEqual(sql.includes('created_by = $2'), !personal);
          return { rows: personal || target.created_by === 7 ? [target] : [] };
        }
        if (sql.startsWith('UPDATE providers')) updated = true;
        return { rows: [] };
      } };
      const res = response();
      await handler('routes/user.js', 'put', '/providers/:id', pool)({ session: { user: { id: 7 } }, params: { id: target.id }, body: { name: 'edited' }, personalProviderManager: personal }, res);
      assert.strictEqual(updated, personal || target.created_by === 7);
      assert.strictEqual(res.statusCode, updated ? 200 : 403);
    }
  }
}

async function testModelOwnership() {
  const source = read('routes/user.js');
  const start = source.indexOf('async function checkModelOwnership(');
  const end = source.indexOf('\n}\n', start) + 2;
  for (const createdBy of [null, 7, 99]) {
    const context = {
      pool: { async query(sql) {
        return { rows: sql.includes('FROM models') ? [{ id: 'model', created_by: createdBy }] : [{ id: 1 }] };
      } },
      getUserPersonalTeam: async () => ({ id: 1 }),
    };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);
    assert(!((await context.checkModelOwnership(7, 'model', true)).error));
    assert.strictEqual(Boolean((await context.checkModelOwnership(7, 'model', false)).error), createdBy !== 7);
  }
  const publish = source.slice(source.indexOf("router.post('/models/:id/publish',"));
  assert(publish.includes('checkModelOwnership(req.session.user.id, modelId)'));
}

async function testAdminList() {
  const rows = [
    { id: 'system', created_by: null, api_key: 'secret', cpa_management_key: 'cpa-secret' },
    { id: 'legacy', created_by: 99, api_keys: ['secret'] },
  ];
  const pool = { async query(sql) {
    if (sql.includes('information_schema')) return { rows: [{ column_name: 'created_by' }] };
    if (sql.includes('provider_tag_assignments')) return { rows: [] };
    if (sql.includes('SELECT p.*')) {
      assert(!sql.includes('WHERE'), 'default personal admin list includes all creators');
      return { rows };
    }
    throw new Error(sql);
  } };
  const res = response();
  await handler('routes/admin.js', 'get', '/providers', pool, {
    ensureKeyModeColumn: async () => {}, countProviderApiKeys: () => 1, getApiKeySelectMode: () => 'order',
  })({ query: {}, personalProviderManager: true }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.data.length, 2);
  for (const row of res.data) {
    assert(!('api_key' in row));
    assert(!('api_keys' in row));
    assert(!('cpa_management_key' in row));
  }
}

(async () => {
  await testGuards();
  testRouteScope();
  await testUserReadsAndMutations();
  await testAdminList();
  await testModelOwnership();
  console.log('PASS provider manager edition/runtime, database identity, scoped routes, legacy access and secret masking');
})().catch(error => { console.error(error); process.exitCode = 1; });
