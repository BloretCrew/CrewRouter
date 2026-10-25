'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { test } = require('node:test');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const { metadata } = require('../utils/instance-edition');

const source = fs.readFileSync(path.join(__dirname, '../routes/auth.js'), 'utf8');
const password = 'offline-correct-password';
const passwordHash = bcrypt.hashSync(password, 4);
const totpSecret = 'JBSWY3DPEHPK3PXP';

class FaultStore extends session.MemoryStore {
  constructor({ failureTarget, persistBeforeError = false, failureStyle = 'callback' }) {
    super();
    this.failureTarget = failureTarget;
    this.persistBeforeError = persistBeforeError;
    this.failureStyle = failureStyle;
    this.failedSid = null;
    this.setCalls = [];
    this.destroyed = [];
  }

  set(sid, value, callback) {
    const kind = value.user ? 'authenticated' : value.pendingTwoFactor ? 'pending' : 'anonymous';
    this.setCalls.push({ sid, kind });
    if (kind === this.failureTarget && this.failedSid === null) {
      this.failedSid = sid;
      if (this.failureStyle === 'throw') {
        if (this.persistBeforeError) super.set(sid, value);
        throw new Error('offline injected synchronous session write failure');
      }
      const fail = () => callback(new Error('offline injected session write failure'));
      if (this.persistBeforeError) super.set(sid, value, fail);
      else queueMicrotask(fail);
      return;
    }
    super.set(sid, value, callback);
  }

  destroy(sid, callback) {
    this.destroyed.push(sid);
    super.destroy(sid, callback);
  }

  async snapshot() {
    return new Promise((resolve, reject) => this.all((error, values) => error ? reject(error) : resolve(values)));
  }
}

async function fixture(t, { twoFactor = false, failureTarget, persistBeforeError = false, failureStyle = 'callback' } = {}) {
  const user = { id: 7, username: 'offline-user', email: 'offline@example.test', password_hash: passwordHash,
    two_factor_enabled: twoFactor, totp_secret: { base32: totpSecret }, is_admin: true, balance: '1.0000' };
  const events = { logins: 0, auditActions: [] };
  const pool = { async query(sql, params) {
    if (sql.startsWith('SELECT * FROM users WHERE LOWER(email)')) {
      return { rows: ['offline-user', 'offline@example.test'].includes(params[0]) ? [{ ...user }] : [] };
    }
    if (sql === 'SELECT * FROM users WHERE id = $1 AND two_factor_enabled = TRUE') {
      return { rows: String(params[0]) === String(user.id) && twoFactor ? [{ ...user }] : [] };
    }
    if (sql === 'SELECT password_hash FROM users WHERE id = $1') {
      return { rows: String(params[0]) === String(user.id) ? [{ password_hash: passwordHash }] : [] };
    }
    throw new Error('Unexpected offline authentication query');
  } };
  const module = { exports: {} };
  function dependency(name) {
    if (name === 'express') return express;
    if (name === 'bcryptjs') return bcrypt;
    if (name === 'speakeasy') return speakeasy;
    if (name === '../models/database') return { pool };
    if (name === '../logger') return { info() {}, warn() {}, error() {} };
    if (name === '../utils/instance-edition') return { metadata, loadPersistedEdition: async () => 'team' };
    if (name === '../config-loader') return { edition: 'team' };
    if (name === '../utils/auth-mode') return { getAuthMode: async () => 'feishu' };
    if (name === '../utils/balance-alert') return { checkAbnormalLogin: async () => {} };
    if (name === '../utils/login-reporter') return { reportLoginEvent() { events.logins += 1; }, reportLogoutEvent() {} };
    if (name === '../utils/audit-log') return { ACTIONS: { AUTH_LOGIN: 'auth.login', AUTH_LOGIN_2FA: 'auth.login_2fa' },
      logAction(event) { events.auditActions.push(event.action); } };
    throw new Error(`Unexpected offline authentication dependency: ${name}`);
  }
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', {
    process: { env: { CR_RUNTIME: 'server' } },
    setInterval: () => ({ unref() {} }),
  }, { filename: 'auth-session-failure-fixture.js' })(dependency, module, module.exports);

  const store = new FaultStore({ failureTarget, persistBeforeError, failureStyle });
  const app = express();
  app.use(express.json());
  app.use(session({ store, secret: 'offline-session-signing-secret', resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure: false, sameSite: 'lax' } }));
  app.use('/auth', module.exports);
  const server = await new Promise(resolve => { const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); });
  t.after(() => new Promise(resolve => server.close(resolve)));

  async function request(route, { body, cookie, html = false } = {}) {
    const data = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route,
        method: data === null ? 'GET' : 'POST', headers: {
          ...(data === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
          ...(cookie ? { Cookie: cookie } : {}), ...(html ? { Accept: 'text/html' } : {}),
        } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body;
          try { body = JSON.parse(text); } catch { body = text; }
          resolve({ status: res.statusCode, headers: res.headers, body,
            cookie: res.headers['set-cookie']?.map(item => item.split(';')[0]).join('; ') });
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('offline fixture timeout')));
      req.end(data);
    });
  }
  return { store, request, events, credentials: { login: user.username, password },
    secondFactor: () => ({ userId: user.id, code: speakeasy.totp({ secret: totpSecret, encoding: 'base32' }) }) };
}

async function assertFailedSessionCannotAuthenticate(f, response, previousCookie) {
  const next = await f.request('/auth/me', { cookie: response.cookie || previousCookie });
  assert.equal(next.status, 401, 'the failed response must not leave a reusable authenticated session');
  assert.equal(Boolean(response.cookie), false, 'the failed response must not issue a session cookie');
  const stored = Object.values(await f.store.snapshot());
  assert.equal(stored.filter(value => value.user || value.pendingTwoFactor).length, 0, 'failed authentication and challenges must be removed from the store');
  assert(f.store.destroyed.includes(f.store.failedSid), 'cleanup must destroy the session whose explicit write failed');
  assert.equal(f.store.setCalls.filter(call => call.sid === f.store.failedSid).length, 1, 'response completion must not implicitly re-save a failed login');
  assert.equal(f.events.logins, 0);
  assert.equal(f.events.auditActions.length, 0);
}

for (const [failureStyle, persistBeforeError] of [['callback', false], ['callback', true], ['throw', false], ['throw', true]]) {
  test(`password login fails closed (${failureStyle}, persisted before error: ${persistBeforeError})`, async t => {
    const f = await fixture(t, { failureTarget: 'authenticated', persistBeforeError, failureStyle });
    const response = await f.request('/auth/login', { body: f.credentials });
    assert.equal(response.status, 500);
    await assertFailedSessionCannotAuthenticate(f, response);
  });

  test(`2FA completion fails closed (${failureStyle}, persisted before error: ${persistBeforeError})`, async t => {
    const f = await fixture(t, { twoFactor: true, failureTarget: 'authenticated', persistBeforeError, failureStyle });
    const pending = await f.request('/auth/login', { body: f.credentials });
    assert.equal(pending.status, 200);
    assert.equal(pending.body.require2FA, true);
    const response = await f.request('/auth/login/2fa', { body: f.secondFactor(), cookie: pending.cookie });
    assert.equal(response.status, 500);
    await assertFailedSessionCannotAuthenticate(f, response, pending.cookie);
  });

  test(`failed pending-2FA writes cannot authorize a retry (${failureStyle}, persisted before error: ${persistBeforeError})`, async t => {
    const f = await fixture(t, { twoFactor: true, failureTarget: 'pending', persistBeforeError, failureStyle });
    const response = await f.request('/auth/login', { body: f.credentials });
    assert.equal(response.status, failureStyle === 'callback' ? 503 : 500);
    const completion = await f.request('/auth/login/2fa', { body: f.secondFactor(), cookie: response.cookie });
    assert.equal(completion.status, 401, 'a failed challenge write must not be silently persisted by response completion');
    await assertFailedSessionCannotAuthenticate(f, response);
  });
}

test('HTML login failure redirects without issuing an authenticated cookie', async t => {
  const f = await fixture(t, { failureTarget: 'authenticated' });
  const response = await f.request('/auth/login?format=html', { body: f.credentials, html: true });
  assert.equal(response.status, 302);
  assert.match(response.headers.location, /^\/\?error=login_failed&/);
  await assertFailedSessionCannotAuthenticate(f, response);
});

test('successful password login still persists and reports authentication', async t => {
  const f = await fixture(t);
  const response = await f.request('/auth/login', { body: f.credentials });
  assert.equal(response.status, 200);
  assert.equal(response.body.id, 7);
  assert.equal((await f.request('/auth/me', { cookie: response.cookie })).status, 200);
  assert.equal(f.events.logins, 1);
  assert.deepEqual(f.events.auditActions, ['auth.login']);
});

test('successful 2FA rotates the pending cookie and only authenticates after the valid code', async t => {
  const f = await fixture(t, { twoFactor: true });
  const pending = await f.request('/auth/login', { body: f.credentials });
  assert.equal(pending.status, 200);
  assert.equal((await f.request('/auth/me', { cookie: pending.cookie })).status, 401);
  const response = await f.request('/auth/login/2fa', { body: f.secondFactor(), cookie: pending.cookie });
  assert.equal(response.status, 200);
  assert.equal(response.cookie === pending.cookie, false);
  assert.equal((await f.request('/auth/me', { cookie: response.cookie })).status, 200);
  assert.equal((await f.request('/auth/me', { cookie: pending.cookie })).status, 401);
  assert.equal(f.events.logins, 1);
  assert.deepEqual(f.events.auditActions, ['auth.login_2fa']);
});
