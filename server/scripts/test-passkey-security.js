'use strict';

// VM substitutes all database/config/WebAuthn dependencies. HTTP checks use an
// in-memory session store only; no deployment configuration is loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { test } = require('node:test');
const express = require('express');
const session = require('express-session');
const crypto = require('node:crypto');
const speakeasy = require('speakeasy');
const bcrypt = require('bcryptjs');
const { metadata } = require('../utils/instance-edition');
const read = name => fs.readFileSync(path.resolve(__dirname, name), 'utf8');

function managerFixture() {
  let sequence = 0;
  let now = Date.now();
  const state = { calls: 0, fail: false, sweeper: null };
  const webauthn = {
    async generateRegistrationOptions(options) {
      assert.equal(options.authenticatorSelection.userVerification, 'required');
      return { challenge: `register-${++sequence}` };
    },
    async generateAuthenticationOptions(options) {
      assert.equal(options.userVerification, 'required');
      return { challenge: `auth-${++sequence}` };
    },
    async verifyRegistrationResponse(options) {
      assert.equal(options.requireUserVerification, true);
      state.calls++;
      if (state.fail) throw new Error('invalid proof');
      return { verified: true, registrationInfo: { credential: { id: 'credential', publicKey: Buffer.from('key') } } };
    },
    async verifyAuthenticationResponse(options) {
      assert.equal(options.requireUserVerification, true);
      state.calls++;
      if (state.fail) throw new Error('invalid proof');
      return { verified: true, authenticationInfo: { newCounter: 1 } };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(read('../utils/PassKey.js'), { module, exports: module.exports,
    require(name) { assert.equal(name, '@simplewebauthn/server'); return webauthn; },
    process: { env: {} }, Buffer, TextEncoder, Uint8Array,
    Date: class extends Date { static now() { return now; } }, console: { error() {} },
    setInterval(fn) { state.sweeper = fn; return { unref() {} }; },
  });
  return { manager: module.exports, state, advance(ms) { now += ms; } };
}
const credential = { credentialID: 'credential', credentialPublicKey: 'a2V5', counter: 0 };

test('authentication challenge belongs to its browser and is consumed once before async verification', async () => {
  const { manager, state } = managerFixture();
  const options = await manager.getAuthenticationOptions([], { owner: 'browser-a' });
  const authenticate = owner => manager.verifyAuthentication(credential, {}, options.challenge, { owner });
  await assert.rejects(authenticate('browser-b'));
  const results = await Promise.allSettled([authenticate('browser-a'), authenticate('browser-a')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(state.calls, 1);
});

test('invalid assertions consume challenges and expired challenges cannot verify', async () => {
  const { manager, state, advance } = managerFixture();
  const options = await manager.getAuthenticationOptions([], { owner: 'browser' });
  state.fail = true;
  await assert.rejects(manager.verifyAuthentication(credential, {}, options.challenge, { owner: 'browser' }));
  state.fail = false;
  await assert.rejects(manager.verifyAuthentication(credential, {}, options.challenge, { owner: 'browser' }));
  const expired = await manager.getAuthenticationOptions([], { owner: 'browser' });
  advance(5 * 60 * 1000);
  await assert.rejects(manager.verifyAuthentication(credential, {}, expired.challenge, { owner: 'browser' }));
  assert.equal(state.calls, 1);
});

test('registration challenges bind both browser and user and reject replay', async () => {
  const { manager, state } = managerFixture();
  await manager.getRegistrationOptions({ id: 1 }, { owner: 'browser' });
  await assert.rejects(manager.verifyRegistration(1, {}, { owner: 'other' }));
  await assert.rejects(manager.verifyRegistration(2, {}, { owner: 'browser' }));
  assert.equal((await manager.verifyRegistration(1, {}, { owner: 'browser' })).credentialID, 'credential');
  await assert.rejects(manager.verifyRegistration(1, {}, { owner: 'browser' }));
  assert.equal(state.calls, 1);
});

test('challenge storage rejects overload and reclaims expired slots', async () => {
  const { manager, advance, state } = managerFixture();
  for (let i = 0; i < 10000; i++) await manager.getAuthenticationOptions([], { owner: `browser-${i}` });
  await assert.rejects(manager.getAuthenticationOptions([], { owner: 'overflow' }), { status: 429 });
  advance(5 * 60 * 1000);
  state.sweeper();
  assert((await manager.getAuthenticationOptions([], { owner: 'overflow' })).challenge);
});

class FaultStore extends session.MemoryStore {
  constructor(failure, persist, style) { super(); this.failure = failure; this.persist = persist; this.style = style; this.failedSid = null; this.sets = []; }
  set(sid, value, callback) {
    const kind = value.user ? 'user' : value.pendingTwoFactor ? 'pending' : 'anonymous';
    this.sets.push({ sid, kind });
    if (kind === this.failure && !this.failedSid) {
      this.failedSid = sid;
      if (this.persist) super.set(sid, value);
      if (this.style === 'throw') throw new Error('offline session store failure');
      return queueMicrotask(() => callback(new Error('offline session store failure')));
    }
    super.set(sid, value, callback);
  }
  async snapshot() { return new Promise((resolve, reject) => this.all((error, values) => error ? reject(error) : resolve(values))); }
}

async function routeFixture(t, { twoFactor = false, mode = 'feishu', edition = 'team', runtime = 'server', failure, persist = false, style } = {}) {
  const state = { verified: 0, audit: [], reports: 0, ambiguous: false, revoked: false };
  const user = { id: 7, username: 'offline-user', is_admin: true, balance: '1', two_factor_enabled: twoFactor,
    passkeys: [credential], totp_secret: { base32: 'JBSWY3DPEHPK3PXP' } };
  const pool = { async query(sql) {
    if (sql.includes('LIMIT 2')) return { rows: state.ambiguous ? [{ id: 7 }, { id: 8 }] : [{ id: 7 }] };
    if (sql.startsWith('SELECT')) return { rows: [user] };
    throw new Error('unexpected offline query');
  } };
  const mocks = {
    express, speakeasy, bcryptjs: bcrypt, 'node:crypto': crypto, '../models/database': { pool },
    '../middleware/auth': { requireAuth(req, res, next) { if (!req.session?.user) return res.sendStatus(401); next(); } },
    '../utils/instance-edition': { metadata, loadPersistedEdition: async () => edition },
    '../utils/auth-mode': { getAuthMode: async () => mode },
    '../utils/audit-log': { ACTIONS: { AUTH_LOGIN: 'auth.login', AUTH_LOGIN_2FA: 'auth.login_2fa', USER_PASSKEY_REGISTER: 'user.passkey_register', USER_PASSKEY_DELETE: 'user.passkey_delete' },
      logAction(event) { state.audit.push(event); } },
    '../utils/login-reporter': { reportLoginEvent() { state.reports++; }, reportLogoutEvent() {} },
    '../logger': { error() {}, warn() {}, info() {} },
    '../utils/passkey-store': { async withLockedPasskeys(_pool, id, mutate) {
      assert.equal(id, 7);
      return mutate(user, state.revoked ? [] : [...user.passkeys]);
    } },
    '../utils/PassKey': {
      getWebAuthnConfig: () => ({ rpID: 'localhost', origin: 'http://localhost' }),
      normalizePasskeys: value => Array.isArray(value) ? value : [],
      async getAuthenticationOptions(_passkeys, options) { assert(options.owner); return { challenge: 'offline-challenge' }; },
      async verifyAuthentication() { state.verified++; return { newCounter: 1 }; },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(read('../routes/passkey.js'), { module, exports: module.exports,
    require(name) { assert(Object.hasOwn(mocks, name), name); return mocks[name]; },
    process: { env: { CR_RUNTIME: runtime } }, Date,
    setInterval: () => ({ unref() {} }),
  });
  const store = new FaultStore(failure, persist, style);
  const app = express();
  app.use(express.json());
  app.use(session({ store, secret: 'offline-only-passkey-cookie-secret', resave: false, saveUninitialized: false }));
  app.get('/me', (req, res) => res.status(req.session.user ? 200 : 401).json({ user: req.session.user }));
  app.use('/passkey', module.exports);
  const authModule = { exports: {} };
  vm.runInNewContext(read('../routes/auth.js'), { module: authModule, exports: authModule.exports,
    require(name) { assert(Object.hasOwn(mocks, name), name); return mocks[name]; },
    process: { env: { CR_RUNTIME: runtime } }, Date,
    setInterval: () => ({ unref() {} }),
  });
  app.use('/auth', authModule.exports);
  const server = await new Promise(resolve => { const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  function request(route, body, cookie) {
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method: payload === null ? 'GET' : 'POST',
        headers: { ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...(cookie ? { Cookie: cookie } : {}) } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()),
          cookie: res.headers['set-cookie']?.map(item => item.split(';')[0]).join('; ') }));
      });
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('offline HTTP timeout'))); req.end(payload);
    });
  }
  async function login(cookie) { return request('/passkey/login/verify', { body: { id: credential.credentialID }, challenge: 'offline-challenge' }, cookie); }
  return { state, store, request, login };
}

test('PassPort-only and desktop-local policies reject options and assertions before verification', async t => {
  for (const options of [{ edition: 'personal', mode: 'passport' }, { runtime: 'desktop-local' }]) {
    const f = await routeFixture(t, options);
    assert.equal((await f.request('/passkey/login/options', {})).status, 403);
    assert.equal((await f.login()).status, 403);
    assert.equal(f.state.verified, 0);
  }
});

test('successful login rotates the anonymous session ID and reports the correct administrator identity', async t => {
  const f = await routeFixture(t);
  const options = await f.request('/passkey/login/options', {});
  const logged = await f.login(options.cookie);
  assert.equal(logged.status, 200);
  assert(logged.cookie && logged.cookie !== options.cookie);
  assert.equal((await f.request('/me', undefined, options.cookie)).status, 401);
  assert.equal((await f.request('/me', undefined, logged.cookie)).status, 200);
  assert.equal(f.state.audit[0].isAdmin, true);
  assert.equal(f.state.audit[0].details.method, 'passkey');
  assert.equal(f.state.audit[0].details.credentialIdSha256, crypto.createHash('sha256').update(credential.credentialID).digest('hex'));
  assert.equal(f.state.audit[0].resourceId, f.state.audit[0].details.credentialIdSha256);
  assert.equal(f.state.reports, 1);
});

test('2FA accounts get only a pending challenge and cannot access authenticated routes', async t => {
  const f = await routeFixture(t, { twoFactor: true });
  const options = await f.request('/passkey/login/options', {});
  const logged = await f.login(options.cookie);
  assert.equal(logged.status, 200);
  assert.equal(logged.body.require2FA, true);
  assert.equal((await f.request('/me', undefined, logged.cookie)).status, 401);
  const stored = Object.values(await f.store.snapshot());
  assert.equal(stored.filter(item => item.pendingTwoFactor?.method === 'passkey').length, 1);
  assert.equal(f.state.audit.length, 0);
  assert.equal(f.state.reports, 0);
  const denied = await f.request('/auth/login/2fa', { userId: 7, code: 'abcdef' }, logged.cookie);
  assert.equal(denied.status, 400);
  assert.equal((await f.request('/me', undefined, logged.cookie)).status, 401);
  const finished = await f.request('/auth/login/2fa', { userId: 7,
    code: speakeasy.totp({ secret: 'JBSWY3DPEHPK3PXP', encoding: 'base32' }) }, logged.cookie);
  assert.equal(finished.status, 200);
  assert.equal((await f.request('/me', undefined, finished.cookie)).status, 200);
  assert.equal((await f.request('/me', undefined, logged.cookie)).status, 401);
  assert.equal(f.state.audit[0].details.method, 'passkey+2fa');
  assert.equal(f.state.audit[0].details.credentialIdSha256, crypto.createHash('sha256').update(credential.credentialID).digest('hex'));
  assert.equal(f.state.reports, 1);
});

for (const twoFactor of [false, true]) for (const persist of [false, true]) for (const style of ['callback', 'throw']) {
  test(`failed login save leaves no authenticated or pending state (2FA=${twoFactor}, persisted=${persist}, style=${style})`, async t => {
    const f = await routeFixture(t, { twoFactor, failure: twoFactor ? 'pending' : 'user', persist, style });
    const options = await f.request('/passkey/login/options', {});
    const logged = await f.login(options.cookie);
    assert.equal(logged.status, 500);
    assert.equal(logged.cookie, undefined);
    assert.equal((await f.request('/me', undefined, options.cookie)).status, 401);
    const stored = Object.values(await f.store.snapshot());
    assert.equal(stored.filter(item => item.user || item.pendingTwoFactor).length, 0);
    assert.equal(f.store.sets.filter(item => item.sid === f.store.failedSid).length, 1);
    assert.equal(f.state.reports, 0);
    assert.equal(f.state.audit.length, 0);
  });
}

test('ambiguous credentials and a credential revoked before row-lock acquisition cannot log in', async t => {
  for (const field of ['ambiguous', 'revoked']) {
    const f = await routeFixture(t);
    const options = await f.request('/passkey/login/options', {});
    f.state[field] = true;
    assert.equal((await f.login(options.cookie)).status, 401);
    assert.equal(f.state.verified, 0);
  }
});

test('public options endpoint has a bounded attempt rate', async t => {
  const f = await routeFixture(t);
  for (let i = 0; i < 60; i++) assert.equal((await f.request('/passkey/login/options', {})).status, 200);
  assert.equal((await f.request('/passkey/login/options', {})).status, 429);
});
