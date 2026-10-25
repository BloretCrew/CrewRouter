'use strict';

// Offline security regressions: real Express/session middleware, fake database
// and identity provider. The only socket opened is a loopback test listener.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const session = require('express-session');
const passportState = require('../utils/passport-login-state');
const edition = require('../utils/instance-edition');
const routeFile = path.resolve(__dirname, '../routes/passport-auth.js');

function independentStateHelper() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../utils/passport-login-state.js'), 'utf8'),
    { require: name => { assert.equal(name, 'node:crypto'); return crypto; }, module },
    { filename: 'passport-login-state-independent.js' });
  return module.exports;
}

function stateChecks() {
  const make = () => ({ sessionID: crypto.randomUUID(), session: {}, query: {} });
  const req = make();
  const state = passportState.issueState(req, 'https://router.test', 'provider-1', 'invite', 1000);
  assert.equal(state.length, 64);
  const pending = structuredClone(req.session);
  req.query = { code: 'example-code', state };
  const invalids = [
    { ...req, query: { code: 'example-code' } },
    { ...req, query: { code: 'example-code', state: ['bad', state] } },
    { ...req, query: { code: ['example-code'], state } },
    { ...req, sessionID: 'other-session' },
    { ...req, session: { passportState: state } },
  ];
  for (const invalid of invalids) assert.throws(() => passportState.consumeState(invalid, 'https://router.test', 'provider-1', 1001), /状态/);
  assert.throws(() => passportState.consumeState(req, 'https://other.test', 'provider-1', 1001), /状态/);
  assert.throws(() => passportState.consumeState(req, 'https://router.test', 'other-provider', 1001), /状态/);
  assert.throws(() => passportState.consumeState(req, 'https://router.test', 'provider-1', 1000 + passportState.STATE_TTL_MS), /状态/);
  assert.deepEqual(passportState.consumeState(req, 'https://router.test', 'provider-1', 1001), { code: 'example-code', invite: 'invite' });
  assert.equal(req.session.passportLogin, undefined);
  assert.throws(() => passportState.consumeState({ ...req, session: pending }, 'https://router.test', 'provider-1', 1002), /状态/);

  // A different process can consume a valid flow from the shared session store
  // without holding an in-memory issuance record.
  const shared = make();
  const sharedState = passportState.issueState(shared, 'https://router.test', 'provider-1', '', 1000);
  shared.query = { state: sharedState, code: 'shared-code' };
  assert.equal(independentStateHelper().consumeState(shared, 'https://router.test', 'provider-1', 1001).code, 'shared-code');
}

function gate() {
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await waiting; } };
}

async function fixture(options = {}) {
  const data = {
    edition: 'team', mode: 'passport', setup: true,
    users: [{ id: 1, username: 'alice', passport_username: 'alice', is_admin: true }],
    identity: { username: 'alice', apptoken: 'test-token', email: 'alice@example.test' },
    verifyCalls: 0, invite: null, consumedInvites: 0, locks: [],
    ...options,
  };
  const config = { edition: 'team', app: { sessionSecret: 'offline-session-secret' }, passport: { appId: 'test-app', appSecret: 'offline-app-secret', baseUrl: 'https://passport.example.test' } };
  let transaction;
  async function query(sql, args = []) {
    if (sql === 'BEGIN') { transaction = { users: structuredClone(data.users), setup: data.setup }; return { rows: [] }; }
    if (sql === 'COMMIT') { transaction = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') { if (transaction) Object.assign(data, transaction); transaction = null; return { rows: [] }; }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) { data.locks.push(args[0]); return { rows: [] }; }
    if (sql.startsWith('SELECT * FROM users WHERE passport_username')) return { rows: data.users.filter(user => user.passport_username === args[0]) };
    if (sql.startsWith('SELECT 1 FROM settings')) return { rows: data.setup ? [{ '?column?': 1 }] : [] };
    if (sql === 'SELECT COUNT(*)::int AS count FROM users') return { rows: [{ count: data.users.length }] };
    if (sql.startsWith('SELECT 1 FROM users WHERE username')) return { rows: data.users.filter(user => user.username === args[0]) };
    if (sql.startsWith('INSERT INTO users')) {
      const user = { id: data.users.length + 1, username: args[0], passport_username: args[1], email: args[2], avatar: args[3], is_admin: args[4] };
      data.users.push(user);
      return { rows: [user] };
    }
    if (sql.includes("INSERT INTO settings (key, value) VALUES ('setup_complete'")) { data.setup = true; return { rows: [] }; }
    if (sql.startsWith('SELECT id FROM teams')) return { rows: [{ id: 5 }] };
    if (/^(INSERT INTO api_keys|DELETE FROM user_teams|INSERT INTO user_teams|UPDATE users SET team_id)/.test(sql.trim())) return { rows: [] };
    throw new Error(`Unexpected offline SQL: ${sql}`);
  }
  const client = { query, release() { data.clientHeld = false; } };
  const pool = { query, connect: async () => { data.clientHeld = true; return client; } };
  const mocks = {
    '../models/database': { pool },
    '../config-loader': config,
    '../logger': { info() {}, warn() {}, error() {} },
    '../utils/auth-mode': { AUTH_MODE_LOCK: 731946, getAuthMode: async () => data.mode },
    '../utils/instance-edition': { ...edition, loadPersistedEdition: async () => data.edition },
    '../utils/url-validator': { validateUrl: async value => ({ ok: true, url: new URL(value) }) },
    '../proxy-pool': { pinnedFetchValidated: async (check, opts) => {
      data.verifyCalls++;
      assert.equal(check.url.origin, 'https://passport.example.test');
      assert.equal(opts.redirect, 'manual');
      assert.equal(typeof JSON.parse(opts.body).code, 'string');
      if (data.verifyGate) { const pause = data.verifyGate; data.verifyGate = null; await pause.wait(); }
      if (data.verifyError) throw new Error('Offline IdP rejection');
      return { ok: true, text: async () => JSON.stringify(data.identity) };
    } },
    '../utils/inject-prompt': { seedDefaultPrompt: async () => {} },
    '../utils/login-reporter': { reportLoginEvent() {} },
    './auth-invites': {
      validateInvite: async invite => data.invite && invite === data.invite.token ? data.invite : null,
      consumeInvite: async () => { data.consumedInvites++; return true; },
    },
  };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    process: { env: { CR_RUNTIME: 'server' } },
    require: name => mocks[name] || (name.startsWith('.') ? require(path.resolve(path.dirname(routeFile), name)) : require(name)),
  };
  vm.runInNewContext(fs.readFileSync(routeFile, 'utf8'), sandbox, { filename: routeFile });
  const app = express();
  const store = new session.MemoryStore();
  const originalSet = store.set.bind(store);
  store.set = (sid, value, callback) => {
    if (data.failAuthenticatedSave && value.user) {
      data.failAuthenticatedSave = false;
      return callback(new Error('Offline session persistence failure'));
    }
    originalSet(sid, value, callback);
  };
  const originalDestroy = store.destroy.bind(store);
  store.destroy = (sid, callback) => {
    assert.equal(data.clientHeld, false, 'release the business connection before regenerating a database-backed session');
    originalDestroy(sid, callback);
  };
  app.use(express.json());
  app.use(session({ store, secret: config.app.sessionSecret, resave: false, saveUninitialized: false }));
  app.use('/auth', module.exports);
  app.get('/test/session', (req, res) => res.json({ authenticated: !!req.session.user, id: req.session.user?.id, isAdmin: req.session.user?.isAdmin }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const root = `http://127.0.0.1:${server.address().port}`;
  async function call(url, jar = {}, headers = {}) {
    const response = await fetch(root + url, { redirect: 'manual', headers: { ...headers, ...(jar.cookie ? { cookie: jar.cookie } : {}) } });
    const cookie = response.headers.get('set-cookie');
    if (cookie) jar.cookie = cookie.split(';')[0];
    const body = await response.text();
    return { status: response.status, headers: response.headers, body };
  }
  async function start(jar = {}, extra = '') {
    const response = await call(`/auth/passport${extra}`, jar);
    assert.equal(response.status, 302, response.body);
    const authorization = new URL(response.headers.get('location'));
    const callback = new URL(authorization.searchParams.get('redirect_uri'));
    assert.equal(callback.origin, config.app.publicOrigin || root);
    assert.equal(callback.pathname, '/auth/passport/callback');
    assert.equal(callback.searchParams.get('state'), authorization.searchParams.get('state'));
    callback.searchParams.set('code', 'test-code');
    return { callback: callback.pathname + callback.search, state: callback.searchParams.get('state'), jar };
  }
  return { data, config, store, root, call, start, async close() { await new Promise(resolve => server.close(resolve)); } };
}

async function withFixture(options, check) {
  const f = await fixture(options);
  try { await check(f); } finally { await f.close(); }
}

async function main() {
  stateChecks();
  await withFixture({}, async f => {
    assert.equal((await f.call('/auth/passport/callback?code=valid-code')).status, 400);
    assert.equal(f.data.verifyCalls, 0, 'unsolicited callback must not contact the IdP');
    const begin = await f.start();
    const other = {};
    assert.equal((await f.call(begin.callback, other)).status, 400, 'state must belong to this browser session');
    assert.equal(f.data.verifyCalls, 0);
    assert.equal((await f.call('/auth/passport/callback?code=valid-code', begin.jar)).status, 400);
    const priorCookie = begin.jar.cookie;
    assert.equal((await f.call(begin.callback, begin.jar)).status, 302);
    assert.notEqual(begin.jar.cookie, priorCookie, 'successful login must rotate the session');
    assert.equal(JSON.parse((await f.call('/test/session', begin.jar)).body).authenticated, true);
    assert.equal(JSON.parse((await f.call('/test/session', { cookie: priorCookie })).body).authenticated, false);
    assert.equal((await f.call(begin.callback, begin.jar)).status, 400);
    assert.equal(f.data.verifyCalls, 1);
  });
  await withFixture({}, async f => {
    const begin = await f.start();
    const staleJar = { ...begin.jar };
    const pause = gate(); f.data.verifyGate = pause;
    const first = f.call(begin.callback, begin.jar);
    await pause.entered;
    try {
      assert.equal((await f.call(begin.callback, staleJar)).status, 400);
      assert.equal(f.data.verifyCalls, 1, 'concurrent callback must be rejected before the second exchange');
    } finally { pause.release(); }
    assert.equal((await first).status, 302);
  });
  await withFixture({}, async f => {
    const begin = await f.start();
    f.data.mode = 'feishu';
    assert.equal((await f.call(begin.callback, begin.jar)).status, 403);
    assert.equal(f.data.verifyCalls, 0, 'mode disabled after initiation');
    f.data.mode = 'passport';
    const second = await f.start();
    f.config.passport.appSecret = '';
    assert.equal((await f.call(second.callback, second.jar)).status, 503);
    assert.equal(f.data.verifyCalls, 0, 'credentials removed after initiation');
  });
  await withFixture({ setup: false, users: [] }, async f => {
    const begin = await f.start();
    const pause = gate(); f.data.verifyGate = pause;
    const callback = f.call(begin.callback, begin.jar);
    await pause.entered;
    f.data.mode = 'feishu'; pause.release();
    assert.equal((await callback).status, 403, 'mode must be checked again in the account transaction');
    assert.equal(f.data.users.length, 0);
  });
  await withFixture({}, async f => {
    const begin = await f.start();
    f.data.verifyError = true;
    assert.equal((await f.call(begin.callback, begin.jar)).status, 502);
    f.data.verifyError = false;
    assert.equal((await f.call(begin.callback, begin.jar)).status, 400, 'failed exchange consumes its state');
    assert.equal(f.data.verifyCalls, 1);
  });
  await withFixture({}, async f => {
    const begin = await f.start();
    f.data.failAuthenticatedSave = true;
    assert.equal((await f.call(begin.callback, begin.jar)).status, 502);
    assert.equal(JSON.parse((await f.call('/test/session', begin.jar)).body).authenticated, false);
    const all = await new Promise((resolve, reject) => f.store.all((error, sessions) => error ? reject(error) : resolve(sessions)));
    assert(Object.values(all).every(value => !value.user), 'an error response must not implicitly persist the rejected login');
  });
  await withFixture({}, async f => {
    const begin = await f.start();
    const all = await new Promise((resolve, reject) => f.store.all((error, sessions) => error ? reject(error) : resolve(sessions)));
    const sid = Object.keys(all)[0]; all[sid].passportLogin.expiresAt = Date.now() - 1;
    await new Promise((resolve, reject) => f.store.set(sid, all[sid], error => error ? reject(error) : resolve()));
    assert.equal((await f.call(begin.callback, begin.jar)).status, 400);
    assert.equal(f.data.verifyCalls, 0);
  });
  await withFixture({}, async f => {
    const bad = await f.call('/auth/passport?redirect_origin=https://attacker.example');
    assert.notEqual(bad.status, 302, 'cross-origin code recipients must be rejected');
    await f.start({}, `?redirect_origin=${encodeURIComponent(f.root)}`);
    const forwarded = await f.call('/auth/passport', {}, { 'x-forwarded-host': 'attacker.example' });
    const target = new URL(new URL(forwarded.headers.get('location')).searchParams.get('redirect_uri'));
    assert.equal(target.origin, f.root, 'untrusted forwarded host must not select the callback');
    f.config.app.publicOrigin = 'https://configured.example';
    const configured = await f.start({}, '?redirect_origin=https%3A%2F%2Fconfigured.example');
    assert.equal((await f.call(configured.callback, configured.jar)).status, 302);
  });
  for (const options of [
    { setup: true, users: [] },
    { setup: false, users: [{ id: 7, username: 'legacy-user', is_admin: false }] },
  ]) await withFixture(options, async f => {
    const begin = await f.start();
    const count = f.data.users.length;
    assert.equal((await f.call(begin.callback, begin.jar)).status, 403, 'lost administrators must not reopen first-admin creation');
    assert.equal(f.data.users.length, count);
    assert.equal(f.data.users.some(user => user.is_admin), false);
  });
  await withFixture({ setup: false, users: [] }, async f => {
    const begin = await f.start();
    assert.equal((await f.call(begin.callback, begin.jar)).status, 302);
    assert.equal(f.data.users.length, 1);
    assert.equal(f.data.users[0].is_admin, true);
    assert.equal(f.data.setup, true);
    assert.deepEqual(f.data.locks, [731946, 731947]);
  });
  await withFixture({ users: [], invite: { token: 'invitation-token-12345678', team_id: 5 } }, async f => {
    const begin = await f.start({}, `?invite=${f.data.invite.token}`);
    assert.equal((await f.call(begin.callback, begin.jar)).status, 302);
    assert.equal(f.data.users[0].is_admin, false, 'valid invitation cannot recreate an administrator after setup');
    assert.equal(f.data.consumedInvites, 1);
  });
  for (const identity of [
    { username: { name: 'alice' }, apptoken: 'token' },
    { username: 'a'.repeat(256), apptoken: 'token' },
    { username: 'alice', apptoken: [] },
  ]) await withFixture({ identity }, async f => {
    const begin = await f.start();
    assert.equal((await f.call(begin.callback, begin.jar)).status, 502);
    assert.equal(JSON.parse((await f.call('/test/session', begin.jar)).body).authenticated, false);
  });
  assert(!require.cache[require.resolve('../models/database')], 'must not load the real database');
  assert(!require.cache[require.resolve('../proxy-pool')], 'must not load real external transport');
  console.log('PassPort server login state, origin, session, policy and first-admin security checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
