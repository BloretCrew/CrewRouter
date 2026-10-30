'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');

const source = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
const originalPassword = 'offline-original-password';
const firstPassword = 'offline-delayed-password';
const secondPassword = 'offline-winning-password';

function barrier() {
  let reached;
  let release;
  return {
    entered: new Promise(resolve => { reached = resolve; }),
    released: new Promise(resolve => { release = resolve; }),
    reached: () => reached(),
    release: () => release(),
  };
}

function fixture(pool, { afterHash, failUpdate = false } = {}) {
  const routes = new Map();
  const audit = [];
  const writes = [];
  const fixtureModule = { exports: {} };
  const dependencies = {
    express: { Router: () => ({
      get(route, handler) { routes.set(`GET ${route}`, handler); },
      post(route, handler) { routes.set(`POST ${route}`, handler); },
    }) },
    bcryptjs: {
      genSalt: () => bcrypt.genSalt(4),
      compare: bcrypt.compare,
      async hash(password, salt) {
        const hashed = await bcrypt.hash(password, salt);
        if (afterHash) await afterHash();
        return hashed;
      },
    },
    '../models/database': { pool: { async query(sql, params) {
      if (/^UPDATE users SET password_hash/.test(sql)) {
        writes.push(sql);
        if (failUpdate) throw new Error('offline password update failure');
      }
      return pool.query(sql, params);
    } } },
    '../logger': { info() {}, warn() {}, error() {} },
    '../utils/audit-log': {
      ACTIONS: { AUTH_SET_PASSWORD: 'auth.set_password', AUTH_CHANGE_PASSWORD: 'auth.change_password' },
      logAction: event => audit.push(event),
    },
    '../utils/login-reporter': { reportLoginEvent() {}, reportLogoutEvent() {} },
    '../utils/instance-edition': { loadPersistedEdition: async () => 'team' },
  };
  vm.runInNewContext(source, {
    module: fixtureModule, exports: fixtureModule.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected password fixture dependency: ${name}`);
      return dependencies[name];
    },
    process: { env: { CR_RUNTIME: 'server' } },
    setInterval: () => ({ unref() {} }),
  }, { filename: 'auth-password-concurrency-fixture.js' });
  return {
    audit, writes,
    async request(route, password, { oldPassword = originalPassword, userId = 1, authenticated = true } = {}) {
      const session = {
        user: authenticated ? { id: userId, username: 'offline-user', needsPasswordSetup: true } : null,
        save(callback) { this.saved = true; callback(); },
      };
      const req = {
        session, ip: '192.0.2.1', headers: {},
        body: route === '/set-password' ? { password, confirmPassword: password } : { oldPassword, newPassword: password },
      };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      await routes.get(`POST ${route}`)(req, res);
      return { ...res, session };
    },
  };
}

test('password writes bind the exact credential snapshot in an isolated PostgreSQL cluster', async context => {
  const cluster = createIsolatedPostgres('auth-password');
  const pool = new Pool({ ...cluster.connection, max: 3, options: '-c statement_timeout=7000' });
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT, email TEXT,
      password_hash TEXT, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`);
    async function reset(passwordHash = null) {
      await pool.query('DELETE FROM users');
      await pool.query('INSERT INTO users(id, username, email, password_hash) VALUES(1, $1, $2, $3), (2, $1, $2, $3)',
        ['offline-user', 'offline@example.test', passwordHash]);
    }
    const storedPassword = async () => (await pool.query('SELECT password_hash FROM users WHERE id = 1')).rows[0]?.password_hash;

    for (const [firstRoute, secondRoute, initialHash] of [
      ['/set-password', '/set-password', null],
      ['/set-password', '/change-password', null],
      ['/change-password', '/set-password', null],
      ['/change-password', '/change-password', null],
      ['/set-password', '/set-password', ''],
      ['/change-password', '/change-password', ''],
      ['/change-password', '/change-password', bcrypt.hashSync(originalPassword, 4)],
    ]) {
      await context.test(`${firstRoute} cannot overwrite a competing ${secondRoute} (${initialHash === null ? 'null' : initialHash === '' ? 'empty' : 'existing'} credential)`, async () => {
        await reset(initialHash);
        const gate = barrier();
        const delayed = fixture(pool, { afterHash: async () => { gate.reached(); await gate.released; } });
        const winner = fixture(pool);
        const pending = delayed.request(firstRoute, firstPassword);
        await gate.entered;
        let winningResponse;
        try { winningResponse = await winner.request(secondRoute, secondPassword); }
        finally { gate.release(); }
        const staleResponse = await pending;
        assert.equal(winningResponse.statusCode, 200);
        assert.equal(staleResponse.statusCode, 409, 'a stale credential must not authorize an overwrite');
        assert.equal(staleResponse.body.code, 'credential_changed');
        assert.equal(staleResponse.session.user.needsPasswordSetup, true);
        assert.equal(staleResponse.session.saved, undefined);
        assert.equal(delayed.audit.length, 0);
        assert.ok(await bcrypt.compare(secondPassword, await storedPassword()));
        assert.equal(await bcrypt.compare(firstPassword, await storedPassword()), false);
      });
    }

    for (const route of ['/set-password', '/change-password']) {
      await context.test(`${route} fails closed when the user disappears during hashing`, async () => {
        await reset(route === '/set-password' ? null : bcrypt.hashSync(originalPassword, 4));
        const gate = barrier();
        const delayed = fixture(pool, { afterHash: async () => { gate.reached(); await gate.released; } });
        const pending = delayed.request(route, firstPassword);
        await gate.entered;
        try { await pool.query('DELETE FROM users WHERE id = 1'); }
        finally { gate.release(); }
        const result = await pending;
        assert.equal(result.statusCode, 409);
        assert.equal(result.body.code, 'credential_changed');
        assert.equal(delayed.audit.length, 0);
        assert.equal(result.session.user.needsPasswordSetup, true);
      });
    }

    await context.test('normal initial setup and authenticated password changes remain usable', async () => {
      await reset();
      const setup = fixture(pool);
      const result = await setup.request('/set-password', firstPassword);
      assert.equal(result.statusCode, 200);
      assert.equal(result.session.user.needsPasswordSetup, false);
      assert.equal(result.session.saved, true);
      assert.equal(setup.audit.length, 1);
      const change = fixture(pool);
      assert.equal((await change.request('/change-password', secondPassword, { oldPassword: firstPassword })).statusCode, 200);
      assert.ok(await bcrypt.compare(secondPassword, await storedPassword()));
      assert.equal(change.audit.length, 1);
    });

    await context.test('unrelated user writes do not invalidate the selected credential', async () => {
      await reset();
      const current = fixture(pool, { afterHash: () => pool.query('UPDATE users SET username = $1 WHERE id = 1', ['changed-name']) });
      assert.equal((await current.request('/set-password', firstPassword)).statusCode, 200);
      assert.ok(await bcrypt.compare(firstPassword, await storedPassword()));
    });

    await context.test('wrong passwords, missing users and unauthenticated sessions never write credentials', async () => {
      const originalHash = bcrypt.hashSync(originalPassword, 4);
      await reset(originalHash);
      const current = fixture(pool);
      assert.equal((await current.request('/change-password', firstPassword, { oldPassword: 'incorrect' })).statusCode, 401);
      assert.equal((await current.request('/change-password', firstPassword, { userId: 99 })).statusCode, 404);
      assert.equal((await current.request('/change-password', firstPassword, { authenticated: false })).statusCode, 401);
      assert.equal((await current.request('/set-password', firstPassword)).statusCode, 400);
      assert.equal(current.writes.length, 0);
      assert.equal(current.audit.length, 0);
      assert.equal(await storedPassword(), originalHash);
    });

    await context.test('database write failures preserve the credential and setup session state', async () => {
      await reset();
      const current = fixture(pool, { failUpdate: true });
      const result = await current.request('/set-password', firstPassword);
      assert.equal(result.statusCode, 500);
      assert.equal(result.session.user.needsPasswordSetup, true);
      assert.equal(current.audit.length, 0);
      assert.equal(await storedPassword(), null);
    });
  } finally {
    await pool.end();
    cluster.stop();
    assert.equal(fs.existsSync(cluster.dataDir), false);
  }
});
