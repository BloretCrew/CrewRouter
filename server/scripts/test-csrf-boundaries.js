'use strict';

// Offline boundary checks: actual Express request getters, no HTTP/DB/upstream calls.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const { csrfProtection, csrfTokenRoute, ensureCsrfToken } = require('../middleware/csrf');

const TOKEN = 'unpredictable-browser-session-token';

function evaluate({
  method = 'POST',
  path = '/api/user/settings',
  headers = {},
  body = {},
  session = { user: { id: 7 }, csrfToken: TOKEN },
  trustProxy = false,
  remoteAddress = '203.0.113.9',
  encrypted = false,
  allowedOrigins = [],
} = {}) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.locals.csrfAllowedOrigins = allowedOrigins;
  const req = Object.create(app.request);
  req.app = app;
  req.method = method;
  req.url = path;
  req.headers = { host: 'router.example', ...headers };
  req.body = body;
  req.session = session;
  req.socket = { remoteAddress, encrypted };
  const result = { allowed: false, status: null, payload: null, protocol: req.protocol };
  const res = {
    status(value) { result.status = value; return this; },
    json(value) { result.payload = value; return this; },
  };
  csrfProtection(req, res, () => { result.allowed = true; });
  return result;
}

function blocked(options) {
  const result = evaluate(options);
  assert.equal(result.allowed, false);
  assert.equal(result.status, 403);
  assert.equal(result.payload.type, 'csrf_failed');
}

test('password login, password changes and identity binding reject cross-origin browser posts', () => {
  for (const path of ['/auth/login', '/auth/set-password', '/auth/change-password', '/auth/feishu/bind']) {
    blocked({ path, headers: { origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' } });
  }
  blocked({ path: '/auth/login', session: {}, headers: { origin: 'https://attacker.example' } });
});

test('normal same-origin browser and explicit CSRF token flows still pass', () => {
  for (const options of [
    { headers: { origin: 'http://router.example' } },
    { headers: { referer: 'http://router.example/console?tab=settings' } },
    { headers: { 'x-csrf-token': TOKEN } },
    { body: { _csrf: TOKEN } },
    { path: '/auth/login', session: {}, headers: { origin: 'http://router.example' } },
    { path: '/oauth/authorize/approve', headers: { origin: 'http://router.example' } },
  ]) {
    assert.equal(evaluate(options).allowed, true);
  }
  blocked({ headers: { 'x-csrf-token': 'wrong-token' } });
  blocked({ session: {}, headers: { 'x-csrf-token': TOKEN } });
  blocked({ headers: { origin: 'null', referer: 'http://router.example/console' } });
});

test('a pending 2FA session cannot bypass CSRF using an API-key-shaped header', () => {
  const session = { pendingTwoFactor: { userId: 7, expiresAt: Date.now() + 60000, attempts: 0 }, csrfToken: TOKEN };
  for (const headers of [{ authorization: 'Bearer fake' }, { 'x-api-key': 'fake' }, {}]) {
    blocked({ path: '/auth/login/2fa', session, headers: { origin: 'https://attacker.example', ...headers } });
  }
  assert.equal(evaluate({ path: '/auth/login/2fa', session, headers: { 'x-csrf-token': TOKEN } }).allowed, true);
  assert.equal(evaluate({ path: '/auth/login/2fa', session, headers: { origin: 'http://router.example' } }).allowed, true);
});

test('sessionless API clients keep their path while browser cookies cannot be bypassed by bogus API headers', () => {
  for (const headers of [{ authorization: 'Bearer key' }, { 'x-api-key': 'key' }]) {
    assert.equal(evaluate({ path: '/v1/chat/completions', session: {}, headers }).allowed, true);
    blocked({ headers: { origin: 'https://attacker.example', ...headers } });
  }
});

test('independent store cookies cannot bypass CSRF using a bogus Bearer or API-key header', () => {
  for (const [method, path] of [
    ['POST', '/store/api/plugins'],
    ['PATCH', '/store/api/plugins/example'],
    ['DELETE', '/store/api/plugins/example/ratings'],
    ['POST', '/store/auth/logout'],
  ]) {
    for (const fakeHeader of [{ authorization: 'Bearer fake' }, { 'x-api-key': 'fake' }]) {
      blocked({
        method, path, session: {},
        headers: { cookie: 'bl_store_session=signed-store-session', origin: 'https://attacker.example', ...fakeHeader },
      });
    }
    assert.equal(evaluate({
      method, path, session: {},
      headers: { cookie: 'bl_store_session=signed-store-session', origin: 'http://router.example' },
    }).allowed, true);
    assert.equal(evaluate({
      method, path, session: { csrfToken: TOKEN },
      headers: { cookie: 'bl_store_session=signed-store-session', 'x-csrf-token': TOKEN },
    }).allowed, true);
  }
});

test('browser authorization approval and console revocation require same origin or CSRF token', () => {
  for (const path of ['/oauth/authorize/approve', '/oauth/authorizations/revoke']) {
    blocked({ path, headers: { origin: 'https://attacker.example' } });
    blocked({ path, headers: { origin: 'https://attacker.example', authorization: 'Bearer fake', 'x-api-key': 'fake' } });
    assert.equal(evaluate({ path, headers: { origin: 'http://router.example' } }).allowed, true);
    assert.equal(evaluate({ path, body: { _csrf: TOKEN } }).allowed, true);
  }
});

test('CLI form-encoded token and token-based revocation exchanges remain available without a session token', () => {
  for (const path of ['/oauth/token', '/oauth/revoke']) {
    assert.equal(evaluate({
      path,
      session: {},
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: { grant_type: 'authorization_code', code: 'one-time-code', code_verifier: 'verifier', token: 'credential' },
    }).allowed, true);
    // These endpoints authenticate the supplied credential and do not log in a browser session.
    assert.equal(evaluate({ path, headers: { origin: 'https://attacker.example' } }).allowed, true);
  }
  blocked({ path: '/oauth/token', method: 'PUT' });
  blocked({ path: '/oauth/revoke', method: 'DELETE' });
});

test('token exemption cannot be inherited by auth paths, suffixes or API-key-shaped headers', () => {
  for (const path of ['/auth/token', '/oauth/token/extra', '/oauth/tokenize', '/oauth/revoke/extra', '/oauth/authorize/approve']) {
    blocked({
      path,
      session: { pendingTwoFactor: { userId: 7 } },
      headers: { authorization: 'Bearer fake', 'x-api-key': 'fake', origin: 'https://attacker.example' },
    });
  }
});

test('native Desktop JSON code exchange passes without browser headers', () => {
  for (const contentType of ['application/json', 'application/json; charset=utf-8']) {
    assert.equal(evaluate({
      path: '/oauth/desktop-session',
      session: {},
      headers: { 'content-type': contentType },
      body: { code: 'one-time-code', client_id: 'crewrouter-desktop', code_verifier: 'verifier' },
    }).allowed, true);
  }
});

test('Desktop native exception does not cover simple browser form types', () => {
  for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain', 'application/jsonp', '']) {
    blocked({ path: '/oauth/desktop-session', session: {}, headers: { 'content-type': contentType } });
  }
  blocked({ path: '/oauth/desktop-session', method: 'PUT', session: {}, headers: { 'content-type': 'application/json' } });
  blocked({ path: '/oauth/desktop-session/extra', session: {}, headers: { 'content-type': 'application/json' } });
});

test('any browser Origin, Referer or Fetch Metadata header prevents native Desktop exemption', () => {
  for (const headers of [
    { origin: 'https://attacker.example' },
    { origin: 'null' },
    { origin: '' },
    { referer: 'https://attacker.example/page' },
    { referer: 'not-a-url' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': '' },
    { 'sec-fetch-mode': 'navigate' },
    { 'sec-fetch-dest': 'document' },
    { 'sec-fetch-user': '?1' },
  ]) {
    blocked({
      path: '/oauth/desktop-session',
      session: {},
      headers: { 'content-type': 'application/json', ...headers },
    });
  }
  assert.equal(evaluate({
    path: '/oauth/desktop-session',
    headers: { 'content-type': 'application/json', origin: 'http://router.example', 'sec-fetch-site': 'same-origin' },
  }).allowed, true);
  assert.equal(evaluate({
    path: '/oauth/desktop-session',
    headers: { 'content-type': 'application/json', 'x-csrf-token': TOKEN, 'sec-fetch-site': 'same-origin' },
  }).allowed, true);
});

test('untrusted X-Forwarded-Proto cannot manufacture an allowed origin', () => {
  const headers = { origin: 'https://router.example', 'x-forwarded-proto': 'https' };
  const result = evaluate({ headers });
  assert.equal(result.protocol, 'http');
  assert.equal(result.allowed, false);
  assert.equal(result.status, 403);
  assert.equal(evaluate({
    headers: { origin: 'http://router.example', 'x-forwarded-proto': 'https' },
  }).allowed, true);
});

test('TLS and trusted reverse proxies retain their actual HTTPS origin', () => {
  assert.equal(evaluate({ encrypted: true, headers: { origin: 'https://router.example' } }).allowed, true);
  const headers = { origin: 'https://router.example', 'x-forwarded-proto': 'https' };
  assert.equal(evaluate({ trustProxy: 'loopback', remoteAddress: '127.0.0.1', headers }).allowed, true);
  blocked({ trustProxy: 'loopback', remoteAddress: '203.0.113.9', headers });
});

test('configured public origins are exact matches and origin takes priority over referer', () => {
  assert.equal(evaluate({
    allowedOrigins: ['https://public.example'],
    headers: { origin: 'https://public.example' },
  }).allowed, true);
  blocked({ allowedOrigins: ['https://public.example'], headers: { origin: 'https://public.example.attacker.test' } });
  blocked({ headers: { origin: 'https://attacker.example', referer: 'http://router.example/console' } });
});

test('safe methods and OAuth callbacks remain reachable', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(evaluate({ method, path: '/auth/passport/callback', headers: { origin: 'https://passport.example' } }).allowed, true);
  }
});

test('CSRF tokens are stable within a session and independent across sessions', () => {
  const req = { session: {} };
  const first = ensureCsrfToken(req);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ensureCsrfToken(req), first);
  assert.notEqual(ensureCsrfToken({ session: {} }), first);
  let payload;
  csrfTokenRoute(req, { json(value) { payload = value; } });
  assert.equal(payload.token, first);
});

test('all legacy GitHub endpoints return 410 without importing database or upstream clients', async () => {
  const filename = require.resolve('../routes/oauth-github');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    require(name) {
      assert.equal(name, 'express', 'retired router must not load DB/config/network integrations');
      return express;
    },
  }, { filename });
  const router = module.exports;
  for (const [method, url] of [
    ['GET', '/'],
    ['GET', '/github'],
    ['GET', '/github/callback?code=untrusted-code&state=untrusted-state'],
    ['GET', '/github/status'],
    ['POST', '/github/unbind'],
    ['POST', '/github/callback'],
    ['DELETE', '/github'],
  ]) {
    const response = await new Promise((resolve, reject) => {
      let status;
      const req = { method, url, headers: {}, session: { user: { id: 7, avatar: 'unchanged' } } };
      const res = { status(code) { status = code; return this; }, json(body) { resolve({ status, body, req }); } };
      router.handle(req, res, error => reject(error || new Error('legacy route unexpectedly fell through')));
    });
    assert.equal(response.status, 410);
    assert.equal(response.body.type, 'auth_method_disabled');
    assert.equal(response.req.session.user.id, 7);
  }
});
