'use strict';

// Standalone store login: no Core session, no real store/database, no external
// identity-provider requests. Tests use real Express and signed-cookie logic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const express = require('express');
const storeState = require('../utils/passport-store-state');
const noLog = { info() {}, warn() {}, error() {} };
const TEST_SESSION_SECRET = crypto.randomBytes(32).toString('base64url');
const ROTATED_SESSION_SECRET = crypto.randomBytes(32).toString('base64url');

function loadModule(file, overrides = {}, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, Buffer, URL, URLSearchParams, ...globals,
    require: name => overrides[name] || (name.startsWith('.') ? require(path.resolve(path.dirname(file), name)) : require(name)),
  }, { filename: file });
  return module.exports;
}

function stateChecks() {
  const cfg = { isConfigured: true, appId: 'test-app', appSecret: 'offline-secret', sessionSecret: TEST_SESSION_SECRET, baseUrl: 'https://passport.example.test' };
  const callback = 'https://router.example/store/auth/callback';
  const req = { secure: true, headers: {}, query: {} };
  let setCookie;
  let cleared;
  const res = { cookie(name, value, opts) { setCookie = { name, value, opts }; }, clearCookie(name) { cleared = name; } };
  const flow = storeState.issueState(req, res, cfg, callback, '/store?plugin=demo#reviews', 1000);
  assert.equal(setCookie.name, '__Host-cr-store-oauth');
  assert.equal(setCookie.opts.secure, true);
  assert.equal(setCookie.opts.httpOnly, true);
  assert.equal(setCookie.opts.path, '/');
  assert.equal(setCookie.opts.domain, undefined);
  assert.equal(new URL(flow.redirectUri).searchParams.get('state'), flow.state);
  req.query = { code: 'code', state: flow.state };
  req.headers.cookie = `${setCookie.name}=${setCookie.value}`;
  const cookie = req.headers.cookie;
  for (const value of ['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/..//evil.example', '/%2e%2e//evil.example', '/safe/..//evil.example', 'https://evil.example', 'javascript:alert(1)', null, ['/store']]) {
    assert.equal(storeState.safeReturnTo(value), '/store');
  }
  assert.equal(storeState.safeReturnTo('/store?plugin=demo#reviews'), '/store?plugin=demo#reviews');
  for (const value of ['/store', '/safe/../store?plugin=demo#reviews', '/%2e%2e//evil.example']) {
    const sanitized = storeState.safeReturnTo(value);
    assert.equal(storeState.safeReturnTo(sanitized), sanitized, 'return targets must remain safe after repeated normalization');
    assert.equal(new URL(sanitized, 'https://router.example').origin, 'https://router.example');
  }
  assert.equal(storeState.successReturnTo('/store?plugin=demo#reviews'), '/store?plugin=demo&auth=ok#reviews');
  assert.throws(() => storeState.consumeState({ ...req, headers: {} }, res, cfg, callback, 1001), /状态/);
  assert.throws(() => storeState.consumeState({ ...req, query: { code: 'code' } }, res, cfg, callback, 1001), /状态/);
  assert.throws(() => storeState.consumeState({ ...req, query: { code: ['code'], state: flow.state } }, res, cfg, callback, 1001), /状态/);
  assert.throws(() => storeState.consumeState({ ...req, headers: { cookie: `${cookie}; ${cookie}` } }, res, cfg, callback, 1001), /状态/);
  assert.throws(() => storeState.consumeState(req, res, { ...cfg, sessionSecret: ROTATED_SESSION_SECRET }, callback, 1001), /状态/);
  assert.throws(() => storeState.consumeState(req, res, cfg, 'https://other.example/store/auth/callback', 1001), /状态/);
  assert.throws(() => storeState.consumeState(req, res, cfg, callback, 1000 + storeState.STATE_TTL_MS), /状态/);
  assert.equal(storeState.consumeState(req, res, cfg, callback, 1001).returnTo, '/store?plugin=demo#reviews');
  assert.equal(cleared, '__Host-cr-store-oauth');
  assert.throws(() => storeState.consumeState(req, res, cfg, callback, 1001), /状态/);

  const cross = storeState.issueState(req, res, cfg, callback, '/store', 2000);
  req.query = { code: 'cross-process-code', state: cross.state };
  req.headers.cookie = `${setCookie.name}=${setCookie.value}`;
  const independent = loadModule(path.resolve(__dirname, '../utils/passport-store-state.js'));
  assert.equal(independent.consumeState(req, res, cfg, callback, 2001).code, 'cross-process-code');
}

function gate() {
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { entered, release, async pause() { enter(); await wait; } };
}

async function fixture() {
  const cfg = { isConfigured: true, appId: 'test-app', appSecret: 'offline-secret', sessionSecret: TEST_SESSION_SECRET, baseUrl: 'https://passport.example.test' };
  const data = { verifies: 0, profile: { username: 'alice', avatar: '', admin: false } };
  const passportLib = {
    getPassportConfig: () => cfg,
    resolveRedirectUri: (_cfg, req) => `${req.protocol}://${req.get('host')}/store/auth/callback`,
    buildAuthorizeUrl: (_cfg, redirectUri, state) => 'https://passport.example.test/app/oauth?' + new URLSearchParams({ app_id: cfg.appId, redirect_uri: redirectUri, state }),
    isAdminUser: (_username, flag) => flag === true,
    async verifyCode(_cfg, code) {
      assert.equal(typeof code, 'string');
      data.verifies++;
      if (data.verifyGate) { const paused = data.verifyGate; data.verifyGate = null; await paused.pause(); }
      if (data.verifyError) throw new Error('Offline IdP failure');
      return data.profile;
    },
  };
  const sessionLib = loadModule(path.resolve(__dirname, '../store/session.js'), { '../logger': noLog });
  const routeFile = path.resolve(__dirname, '../routes/store.js');
  const { createStoreRoutes } = loadModule(routeFile, {
    '../config-loader': {}, '../logger': noLog, '../store/passport': passportLib,
    '../store/session': sessionLib, '../store/store': {},
  });
  const app = express();
  app.use('/store', createStoreRoutes());
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const root = `http://127.0.0.1:${server.address().port}`;
  async function call(url, jar = new Map(), headers = {}) {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(root + url, { redirect: 'manual', headers: { ...headers, ...(cookie ? { cookie } : {}) } });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0];
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value) jar.set(name, value); else jar.delete(name);
    }
    return { status: response.status, headers: response.headers, body: await response.text() };
  }
  async function start(jar = new Map(), returnTo = '/store') {
    const response = await call('/store/auth/login?return_to=' + encodeURIComponent(returnTo), jar);
    assert.equal(response.status, 302);
    const oauth = new URL(response.headers.get('location'));
    const callback = new URL(oauth.searchParams.get('redirect_uri'));
    assert.equal(callback.origin, root);
    assert.equal(callback.searchParams.get('state'), oauth.searchParams.get('state'));
    callback.searchParams.set('code', 'test-code');
    return { jar, callback: callback.pathname + callback.search, state: oauth.searchParams.get('state') };
  }
  return { cfg, data, root, call, start, async close() { await new Promise(resolve => server.close(resolve)); } };
}

async function withFixture(check) {
  const f = await fixture();
  try { await check(f); } finally { await f.close(); }
}

async function main() {
  stateChecks();
  await withFixture(async f => {
    const unsolicited = await f.call('/store/auth/callback?code=valid-code');
    assert.equal(unsolicited.headers.get('location'), '/store?auth=error');
    assert.equal(f.data.verifies, 0);
    const forgedState = Buffer.from(JSON.stringify({ return_to: '/\\attacker.example' })).toString('base64url');
    assert.equal((await f.call(`/store/auth/callback?code=valid-code&state=${forgedState}`)).headers.get('location'), '/store?auth=error');
    assert.equal(f.data.verifies, 0);
    const begin = await f.start(undefined, '/store?plugin=demo#reviews');
    assert.equal((await f.call(begin.callback)).headers.get('location'), '/store?auth=error', 'another browser has no matching nonce cookie');
    assert.equal(f.data.verifies, 0);
    const prior = new Map(begin.jar);
    const success = await f.call(begin.callback, begin.jar);
    assert.equal(success.headers.get('location'), '/store?plugin=demo&auth=ok#reviews');
    assert.equal(begin.jar.has('cr_store_oauth'), false);
    assert.equal(begin.jar.has('bl_store_session'), true);
    assert.equal(JSON.parse((await f.call('/store/api/me', begin.jar)).body).user.username, 'alice');
    assert.equal((await f.call(begin.callback, prior)).headers.get('location'), '/store?auth=error');
    assert.equal(f.data.verifies, 1);
  });
  await withFixture(async f => {
    f.data.profile = { username: 'bob', admin: false };
    const victim = await f.start(); await f.call(victim.callback, victim.jar);
    f.data.profile = { username: 'alice', admin: false };
    const attacker = await f.start();
    assert.equal((await f.call(attacker.callback, victim.jar)).headers.get('location'), '/store?auth=error');
    assert.equal(JSON.parse((await f.call('/store/api/me', victim.jar)).body).user.username, 'bob', 'login CSRF cannot switch an existing store identity');
    assert.equal(f.data.verifies, 1);
  });
  await withFixture(async f => {
    const begin = await f.start();
    const stale = new Map(begin.jar);
    const paused = gate(); f.data.verifyGate = paused;
    const first = f.call(begin.callback, begin.jar);
    await paused.entered;
    try {
      assert.equal((await f.call(begin.callback, stale)).headers.get('location'), '/store?auth=error');
      assert.equal(f.data.verifies, 1);
    } finally { paused.release(); }
    assert.equal((await first).headers.get('location'), '/store?auth=ok');
  });
  await withFixture(async f => {
    const begin = await f.start();
    const original = new Map(begin.jar);
    const value = begin.jar.get('cr_store_oauth');
    const [payload, sig] = decodeURIComponent(value).split('.');
    const changed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    changed.returnTo = '/attacker-selected-path';
    begin.jar.set('cr_store_oauth', `${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${sig}`);
    assert.equal((await f.call(begin.callback, begin.jar)).headers.get('location'), '/store?auth=error');
    assert.equal(f.data.verifies, 0, 'signed return target cannot be tampered with');
    f.cfg.sessionSecret = ROTATED_SESSION_SECRET;
    assert.equal((await f.call(begin.callback, original)).headers.get('location'), '/store?auth=error');
    assert.equal(f.data.verifies, 0);
  });
  for (const returnTo of ['/\\attacker.example', '//attacker.example', '/\t/attacker.example', '/..//attacker.example', '/%2e%2e//attacker.example', '/safe/..//attacker.example']) await withFixture(async f => {
    const begin = await f.start(undefined, returnTo);
    const response = await f.call(begin.callback, begin.jar);
    const location = response.headers.get('location');
    assert.equal(location, '/store?auth=ok');
    assert.equal(new URL(location, f.root).origin, f.root);
  });
  await withFixture(async f => {
    const begin = await f.start();
    const prior = new Map(begin.jar);
    f.data.verifyError = true;
    assert.equal((await f.call(begin.callback, begin.jar)).headers.get('location'), '/store?auth=error');
    assert.equal(begin.jar.has('cr_store_oauth'), false);
    f.data.verifyError = false;
    assert.equal((await f.call(begin.callback, prior)).headers.get('location'), '/store?auth=error');
    assert.equal(f.data.verifies, 1);
  });
  await withFixture(async f => {
    const begin = await f.start();
    f.cfg.isConfigured = false;
    assert.equal((await f.call(begin.callback, begin.jar)).headers.get('location'), '/store?auth=error');
    assert.equal(f.data.verifies, 0);
  });
  await withFixture(async f => {
    const jar = new Map();
    const response = await f.call('/store/auth/login', jar, { 'x-forwarded-proto': 'https' });
    assert.equal(response.status, 302);
    assert.equal(jar.has('cr_store_oauth'), true, 'raw forwarded headers cannot override Express proxy trust');
    assert.equal(jar.has('__Host-cr-store-oauth'), false);
  });
  assert(!require.cache[require.resolve('../store/db')], 'must not load the store database');
  assert(!require.cache[require.resolve('../logger')], 'must not write application logs');
  console.log('Store PassPort nonce cookie, replay, redirect and standalone identity security checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
