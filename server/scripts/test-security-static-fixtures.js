'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const authSource = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
const postgresSource = fs.readFileSync(path.join(__dirname, 'test-support/isolated-postgres.js'), 'utf8');
const quotaTestSource = fs.readFileSync(path.join(__dirname, 'test-provider-quota-stats-db.js'), 'utf8');

function authFixture(initialHash, { afterHash, source = authSource } = {}) {
  const routes = new Map();
  const state = { user: { id: 7, username: 'offline-user', password_hash: initialHash }, audit: [], writes: 0 };
  const dependencies = {
    express: { Router: () => ({
      get(route, handler) { routes.set(`GET ${route}`, handler); },
      post(route, handler) { routes.set(`POST ${route}`, handler); },
    }) },
    bcryptjs: {
      genSalt: async () => 'memory-only-salt',
      compare: async (password, hashed) => hashed === `hash:${password}`,
      async hash(password) {
        if (afterHash) await afterHash(state);
        return `hash:${password}`;
      },
    },
    '../models/database': { pool: { async query(sql, params) {
      if (/^SELECT .*FROM users WHERE id = \$1/.test(sql)) {
        return { rows: state.user && state.user.id === params[0] ? [{ ...state.user }] : [] };
      }
      assert.match(sql, /^UPDATE users SET password_hash/);
      const matches = state.user && state.user.id === params[1]
        && (!sql.includes('password_hash IS NOT DISTINCT FROM $3') || state.user.password_hash === params[2]);
      if (!matches) return { rowCount: 0, rows: [] };
      state.writes++;
      state.user.password_hash = params[0];
      return { rowCount: 1, rows: [] };
    } } },
    '../logger': { info() {}, warn() {}, error() {} },
    '../utils/audit-log': {
      ACTIONS: { AUTH_SET_PASSWORD: 'auth.set_password', AUTH_CHANGE_PASSWORD: 'auth.change_password' },
      logAction: event => state.audit.push(event),
    },
    '../utils/login-reporter': { reportLoginEvent() {}, reportLogoutEvent() {} },
    '../utils/instance-edition': { loadPersistedEdition: async () => 'team' },
  };
  const fixtureModule = { exports: {} };
  vm.runInNewContext(source, {
    module: fixtureModule, exports: fixtureModule.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected offline auth dependency: ${name}`);
      return dependencies[name];
    },
    process: { env: { CR_RUNTIME: 'server' } },
    setInterval: () => ({ unref() {} }),
  }, { filename: 'offline-auth-source.js' });
  return {
    state,
    async request(route, oldPassword = 'original') {
      const session = {
        user: { id: 7, username: 'offline-user', needsPasswordSetup: initialHash == null || initialHash === '' },
        save(callback) { this.saved = true; callback(); },
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      await routes.get(`POST ${route}`)({ session, headers: {}, body: {
        password: 'replacement', confirmPassword: 'replacement', newPassword: 'replacement', oldPassword,
      } }, res);
      return { ...res, session };
    },
  };
}

for (const [route, initialHash] of [
  ['/set-password', null], ['/change-password', null], ['/change-password', 'hash:original'],
]) {
  const label = `${route} (${initialHash === null ? 'initial' : 'existing'})`;
  test(`offline auth rejects a stale credential snapshot for ${label}`, async () => {
    const fixture = authFixture(initialHash, { afterHash(state) { state.user.password_hash = 'hash:winner'; } });
    const response = await fixture.request(route);
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'credential_changed');
    assert.equal(response.session.user.needsPasswordSetup, initialHash === null);
    assert.equal(response.session.saved, undefined);
    assert.equal(fixture.state.user.password_hash, 'hash:winner');
    assert.equal(fixture.state.writes, 0);
    assert.equal(fixture.state.audit.length, 0);
  });
  test(`offline auth does not report success for a deleted user in ${label}`, async () => {
    const fixture = authFixture(initialHash, { afterHash(state) { state.user = null; } });
    const response = await fixture.request(route);
    assert.equal(response.statusCode, 409);
    assert.equal(fixture.state.writes, 0);
    assert.equal(fixture.state.audit.length, 0);
  });
  test(`offline auth preserves normal credential writes for ${label}`, async () => {
    const fixture = authFixture(initialHash);
    assert.equal((await fixture.request(route)).statusCode, 200);
    assert.equal(fixture.state.user.password_hash, 'hash:replacement');
    assert.equal(fixture.state.writes, 1);
  });
  test(`offline control reproduces the unconditional-write defect for ${label}`, async () => {
    const fixture = authFixture(initialHash, {
      source: authSource.replaceAll(' AND password_hash IS NOT DISTINCT FROM $3', ''),
      afterHash(state) { state.user.password_hash = 'hash:winner'; },
    });
    assert.equal((await fixture.request(route)).statusCode, 200);
    assert.equal(fixture.state.user.password_hash, 'hash:replacement');
    assert.equal(fixture.state.writes, 1);
  });
}

test('offline auth rejects an incorrect old password before any write', async () => {
  const fixture = authFixture('hash:original');
  assert.equal((await fixture.request('/change-password', 'incorrect')).statusCode, 401);
  assert.equal(fixture.state.writes, 0);
});

function lifecycleFixture({ registrationError, stopError } = {}) {
  const begin = postgresSource.indexOf('function createIsolatedPostgresFixture(');
  const end = postgresSource.indexOf('\nmodule.exports', begin);
  assert.ok(begin >= 0 && end > begin);
  const state = { stops: 0, cleanup: null };
  const context = {
    after(callback) {
      if (registrationError) throw registrationError;
      state.cleanup = callback;
    },
  };
  const factory = vm.runInNewContext(`(${postgresSource.slice(begin, end)})`, {
    createIsolatedPostgres: () => ({ stop() { state.stops++; if (stopError) throw stopError; } }),
    AggregateError,
  });
  return { state, create: () => factory(context, 'memory-only') };
}

test('offline lifecycle closes all connections once and then stops its fake cluster', async () => {
  const fixture = lifecycleFixture();
  const cluster = fixture.create();
  const closed = [];
  const connection = { end() { closed.push('first'); } };
  cluster.track(connection);
  cluster.track(connection);
  cluster.track({ end() { closed.push('second'); } });
  await fixture.state.cleanup();
  assert.deepEqual(closed, ['first', 'second']);
  assert.equal(fixture.state.stops, 1);
});

for (const synchronous of [true, false]) {
  test(`offline lifecycle stops its fake cluster after ${synchronous ? 'synchronous' : 'asynchronous'} connection cleanup failure`, async () => {
    const fixture = lifecycleFixture();
    const cluster = fixture.create();
    const failure = new Error('synthetic cleanup failure');
    let secondClosed = false;
    cluster.track({ end() { if (synchronous) throw failure; return Promise.reject(failure); } });
    cluster.track({ end() { secondClosed = true; } });
    await assert.rejects(fixture.state.cleanup(), error => error instanceof AggregateError && error.errors[0] === failure);
    assert.equal(secondClosed, true);
    assert.equal(fixture.state.stops, 1);
  });
}

test('offline lifecycle cleans up if registering the after hook throws', () => {
  const failure = new Error('synthetic hook registration failure');
  const fixture = lifecycleFixture({ registrationError: failure });
  assert.throws(fixture.create, error => error === failure);
  assert.equal(fixture.state.stops, 1);
});

test('offline lifecycle propagates a fake cluster stop failure', async () => {
  const failure = new Error('synthetic stop failure');
  const fixture = lifecycleFixture({ stopError: failure });
  fixture.create();
  await assert.rejects(fixture.state.cleanup(), error => error === failure);
});

test('offline lifecycle stops a fake cluster even with no connections', async () => {
  const fixture = lifecycleFixture();
  fixture.create();
  await fixture.state.cleanup();
  assert.equal(fixture.state.stops, 1);
});

test('offline cluster startup contract uses a fresh socket directory, empty TCP listen addresses and clean child environment', async () => {
  const root = '/synthetic-only/cluster';
  const calls = [];
  let present = true;
  let running = false;
  const fakeFs = {
    constants: { X_OK: 1 },
    accessSync(candidate) { assert.match(candidate, /^\/offline-toolchain\/(initdb|pg_ctl)$/); },
    mkdtempSync(prefix) { assert.equal(prefix, '/tmp/cr-data-contract-'); return root; },
    mkdirSync(directory) { assert.equal(directory, `${root}/socket`); },
    existsSync(filename) {
      assert.ok([root, `${root}/data/postmaster.pid`].includes(filename));
      return filename === root ? present : running;
    },
    rmSync(directory) { assert.equal(directory, root); present = false; },
  };
  const fixtureModule = { exports: {} };
  const dependencies = {
    'node:assert/strict': assert, 'node:fs': fakeFs, 'node:path': path,
    'node:child_process': { execFileSync(command, args, options) {
      calls.push({ command, args, options });
      if (args.includes('start')) running = true;
      if (args.includes('stop')) running = false;
      return '';
    } },
  };
  vm.runInNewContext(postgresSource, {
    module: fixtureModule,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected offline cluster dependency: ${name}`);
      return dependencies[name];
    },
    process: { env: { PATH: '/offline-toolchain', DATABASE_URL: 'unused-synthetic-value', PGHOST: 'unused-synthetic-value' }, getuid: () => 1000 },
  }, { filename: 'offline-cluster-source.js' });
  const cluster = fixtureModule.exports.createIsolatedPostgres('contract');
  const startup = calls.find(call => call.args.includes('start'));
  assert.ok(startup);
  assert.match(startup.args.at(-1), /-h ''/);
  assert.match(startup.args.at(-1), /-k '\/synthetic-only\/cluster\/socket'/);
  assert.ok(calls[0].args.includes('--auth-host=reject'));
  assert.deepEqual(Object.keys(startup.options.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
  assert.equal(cluster.connection.host, `${root}/socket`);
  const values = { 'SHOW data_directory': `${root}/data`, 'SHOW listen_addresses': '', 'SHOW unix_socket_directories': `${root}/socket` };
  await cluster.assertIsolation({ async query(sql) {
    assert.ok(Object.hasOwn(values, sql));
    return { rows: [{ [sql.slice(5)]: values[sql] }] };
  } });
  cluster.stop();
  assert.equal(present, false);
  assert.equal(running, false);
});

test('offline quota fixture supplies callable middleware for the admin model library subrouter', () => {
  const begin = quotaTestSource.indexOf('    const next = (req, res, done) => done();');
  const end = quotaTestSource.indexOf('\n    const module =', begin);
  assert.ok(begin >= 0 && end > begin);
  const fakeRequire = vm.runInNewContext(`(() => { ${quotaTestSource.slice(begin, end)}; return fakeRequire; })()`, {
    express: { Router: () => function offlineRouter() {} },
    db: { query() { assert.fail('Database operations are forbidden in this offline test'); } },
    realRequire() { assert.fail('Real dependency loading is forbidden in this offline test'); },
    require() { assert.fail('Real dependency loading is forbidden in this offline test'); },
  });
  assert.equal(typeof fakeRequire('./admin-model-library'), 'function');
});
