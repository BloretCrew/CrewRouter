'use strict';
const assert = require('assert');
const Module = require('module');
const express = require('express');
const session = require('express-session');
const local = require('../utils/local-passport');

function request(state, code = 'code') {
  return { sessionID: 'session-a', session: { localPassportState: state }, query: { state, code } };
}
function originRequest(host = '127.0.0.1:20003', redirect_origin) {
  return { protocol: 'http', socket: { remoteAddress: '127.0.0.1' }, get: name => name === 'host' ? host : 'secret', query: { redirect_origin } };
}

async function main() {
  local.validateLocalToken(originRequest(), 'secret');
  assert.throws(() => local.validateLocalToken(originRequest(), ''), /token/);
  assert.throws(() => local.validateLocalToken(originRequest(), 'wrong'), /token/);
  const remote = originRequest(); remote.socket.remoteAddress = '10.0.0.1';
  assert.throws(() => local.validateLocalToken(remote, 'secret'), /本机/);
  for (const host of ['evil.test:20003', '127.0.0.1:20004', 'user@localhost:20003', 'localhost:20003/path', 'localhost:20003?x=1']) {
    assert.throws(() => local.localOrigin(originRequest(host), 20003), /origin/);
  }
  assert.strictEqual(local.localOrigin(originRequest(), 20003), 'http://127.0.0.1:20003');
  assert.throws(() => local.localOrigin(originRequest(undefined, 'http://evil.test'), 20003), /回调/);
  assert.throws(() => local.localOrigin(originRequest(undefined, ['http://127.0.0.1:20003']), 20003), /回调/);
  const req = request();
  const state = local.issueState(req, 'http://127.0.0.1:20003', 100);
  assert.throws(() => local.consumeState(request(), 'http://127.0.0.1:20003', 101), /状态/);
  assert.throws(() => local.consumeState({ ...request(state), sessionID: 'other' }, 'http://127.0.0.1:20003', 101), /状态/);
  local.consumeState(request(state), 'http://127.0.0.1:20003', 101);
  assert.throws(() => local.consumeState(request(state), 'http://127.0.0.1:20003', 101), /状态/);
  const expired = local.issueState(req, 'http://127.0.0.1:20003', 100);
  assert.throws(() => local.consumeState(request(expired), 'http://127.0.0.1:20003', 100 + local.STATE_TTL_MS), /过期/);
  const badCode = local.issueState(req, 'http://127.0.0.1:20003');
  assert.throws(() => local.consumeState(request(badCode, ['code']), 'http://127.0.0.1:20003'), /授权码/);
  assert.throws(() => local.consumeState(request(badCode), 'http://127.0.0.1:20003'), /状态/);
  const wrongOrigin = local.issueState(req, 'http://127.0.0.1:20003');
  assert.throws(() => local.consumeState(request(wrongOrigin), 'http://localhost:20003'), /origin/);
  const replaced = local.issueState(req, 'http://127.0.0.1:20003');
  local.issueState(req, 'http://127.0.0.1:20003');
  assert.throws(() => local.consumeState(request(replaced), 'http://127.0.0.1:20003'), /状态/);
  for (const username of [123, [], '', 'x'.repeat(256)]) assert.throws(() => local.passportIdentity({ username, apptoken: 'token' }), /身份/);
  assert.strictEqual(local.passportIdentity({ username: ' alice ', apptoken: 'token' }), 'alice');
  const legacy = { id: 7, username: '任意显示名', is_admin: true, balance: 42 };
  assert.strictEqual(local.chooseLocalUser([legacy], 'alice'), legacy);
  assert.strictEqual(local.chooseLocalUser([], 'alice'), null);
  for (const users of [[{ ...legacy, is_admin: false }], [legacy, { ...legacy, id: 8 }], [{ ...legacy, email: 'a@b.c' }], [{ ...legacy, password_hash: 'hash' }], [{ ...legacy, feishu_open_id: 'id' }], [{ ...legacy, github_id: 'id' }], [{ ...legacy, two_factor_enabled: true }]]) {
    assert.throws(() => local.chooseLocalUser(users, 'alice'), /管理员|身份/);
  }
  for (const passkeys of [[{ credentialID: 'key' }], [{}], '[{"credentialID":"key"}]', 'broken', '', '{}', {}, 'null', '"[]"', 0, false]) {
    assert.throws(() => local.chooseLocalUser([{ ...legacy, passkeys }], 'alice'), /身份/);
  }
  for (const passkeys of [undefined, null, [], '[]']) {
    const candidate = { ...legacy, passkeys };
    assert.strictEqual(local.chooseLocalUser([candidate], 'alice'), candidate);
  }
  const activeReq = request();
  activeReq.query.state = local.issueState(activeReq, 'http://127.0.0.1:20003');
  const inflight = local.consumeState(activeReq, 'http://127.0.0.1:20003');
  local.assertActive(inflight);
  local.cancelSession({ sessionID: 'unrelated' });
  local.assertActive(inflight);
  local.cancelSession(activeReq);
  assert.throws(() => local.assertActive(inflight), /取消/);
  const bound = { ...legacy, passport_username: 'alice' };
  assert.strictEqual(local.chooseLocalUser([bound], 'alice'), bound);
  assert.throws(() => local.chooseLocalUser([bound], 'bob'), /绑定/);
  assert.throws(() => local.chooseLocalUser([bound, { ...bound, id: 8 }], 'alice'), /绑定/);
  let rotated = false;
  await local.localSessionGuard({ query: async () => { throw new Error('unexpected query'); } })({ session: { user: { local: true }, regenerate: callback => { rotated = true; callback(); } } }, {}, () => {});
  assert(rotated);
  let passed = false;
  await local.localSessionGuard({ query: async () => ({ rows: [{ passport_username: 'alice', is_admin: true }] }) })({ session: { localPassportAuth: true, user: { id: 7, passportUsername: 'alice' } } }, {}, () => { passed = true; });
  assert(passed);
  let status;
  await local.localSessionGuard({ query: async () => { throw new Error('offline'); } })({ session: { localPassportAuth: true, user: { id: 7, passportUsername: 'alice' } } }, { status(code) { status = code; return this; }, json() {} }, () => assert.fail('must fail closed'));
  assert.strictEqual(status, 503);

  const previousRuntime = process.env.CR_RUNTIME;
  const previousToken = process.env.CR_LOCAL_TOKEN;
  process.env.CR_RUNTIME = 'desktop-local'; process.env.CR_LOCAL_TOKEN = 'secret';
  let users = [];
  let rotations = 0;
  let verificationCount = 0;
  let verifyIdentity = 'alice';
  let verifyGate;
  let commitGate;
  let regenerateGate;
  let saveGate;
  let authenticatedSaveError = false;
  function gate() {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    return { entered, release, async pause() { enter(); await wait; } };
  }
  const client = {
    release() {},
    async query(sql, params = []) {
      if (sql === 'COMMIT' && commitGate) { const paused = commitGate; commitGate = null; await paused.pause(); }
      if (sql.startsWith('SELECT * FROM users WHERE passport_username')) return { rows: users.filter(user => user.passport_username === params[0]) };
      if (sql === 'SELECT * FROM users ORDER BY id FOR UPDATE') return { rows: users };
      if (sql.startsWith('UPDATE users SET passport_username')) { users[0] = { ...users[0], passport_username: params[0] }; return { rows: [users[0]] }; }
      if (sql.includes('INSERT INTO users')) { const user = { id: 1, username: params[0], passport_username: params[1], is_admin: true }; users.push(user); return { rows: [user] }; }
      if (sql.includes('SELECT t.id') || sql.includes('INSERT INTO teams')) return { rows: [{ id: 10 }] };
      return { rows: [] };
    }
  };
  const pool = { connect: async () => client, query: async () => ({ rows: [{ edition: 'personal' }] }) };
  const testConfig = { app: { port: 20003, sessionSecret: 'test-secret' }, passport: { appId: 'app', appSecret: 'secret' } };
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  global.fetch = async () => { verificationCount++; if (verifyGate) { const paused = verifyGate; verifyGate = null; await paused.pause(); } return new Response(JSON.stringify({ username: verifyIdentity, apptoken: 'token' })); };
  Module._load = function(name, parent, ...args) {
    if (name === '../logger') return { info() {}, warn() {}, error() {}, debug() {} };
    if (name === '../models/database') return { pool };
    if (name === '../config-loader') return testConfig;
    if (name === '../utils/audit-log') return { ACTIONS: {}, logAction() {} };
    if (parent?.filename.endsWith('/routes/passport-auth.js')) {
      if (name === '../models/database') return { pool };
      if (name === '../config-loader') return testConfig;
      if (name === '../utils/auth-mode') return { getAuthMode: async () => 'feishu' };
    }
    if (parent?.filename.endsWith('/utils/passport-verifier.js')) {
      if (name === './url-validator') return { validateUrl: async value => ({ ok: true, url: new URL(value) }) };
      if (name === '../proxy-pool') return { pinnedFetchValidated: async (check, options) => global.fetch(check.url.toString(), options) };
    }
    if (name === '../utils/login-reporter') return { reportLoginEvent() {}, reportLogoutEvent() {} };
    if (name === '../utils/inject-prompt') return { seedDefaultPrompt: async () => {} };
    if (name === './auth-invites') return { validateInvite: async () => ({ team_id: 10 }), consumeInvite: async () => true };
    return originalLoad.call(this, name, parent, ...args);
  };
  const router = require('../routes/passport-auth');
  const app = express();
  const store = new session.MemoryStore();
  const originalSet = store.set.bind(store);
  store.set = (id, value, callback) => {
    if (value.localPassportAuth && authenticatedSaveError) {
      authenticatedSaveError = false;
      return callback(new Error('Offline session persistence failure'));
    }
    if (value.localPassportAuth && saveGate) {
      const paused = saveGate; saveGate = null;
      paused.pause().then(() => originalSet(id, value, callback));
    } else originalSet(id, value, callback);
  };
  app.use(session({ store, secret: 'test-secret', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => { const regenerate = req.session.regenerate.bind(req.session); req.session.regenerate = callback => { rotations++; if (regenerateGate) { const paused = regenerateGate; regenerateGate = null; paused.pause().then(() => regenerate(callback)); } else regenerate(callback); }; next(); });
  app.use('/auth', router);
  app.use('/auth', require('../routes/auth'));
  app.get('/test/session', (req, res) => res.json({ authenticated: !!req.session.user }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  testConfig.app.port = server.address().port;
  const root = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function call(path, token = 'secret') {
    const response = await originalFetch(root + path, { redirect: 'manual', headers: { cookie, 'x-crewrouter-desktop-token': token } });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    await response.text();
    return response;
  }
  try {
    testConfig.passport.appSecret = '';
    const unconfigured = await call('/auth/passport');
    assert.strictEqual(unconfigured.status, 503);
    assert.strictEqual(unconfigured.headers.get('location'), null);
    assert.match(unconfigured.headers.get('content-type'), /html/);
    testConfig.passport.appSecret = 'secret';
    assert.strictEqual((await call('/auth/passport', 'wrong')).status, 403);
    assert.strictEqual((await call('/auth/passport?redirect_origin=http://evil.test')).status, 403);
    assert.strictEqual((await call('/auth/passport/callback?code=code')).status, 403);
    const start = await call('/auth/passport');
    assert.strictEqual(start.status, 302);
    const authorization = new URL(start.headers.get('location'));
    const state = authorization.searchParams.get('state');
    assert.strictEqual(new URL(authorization.searchParams.get('redirect_uri')).searchParams.get('state'), state);
    const startCookie = cookie;
    assert.strictEqual((await call(`/auth/passport/callback?code=code&state=${state}`)).status, 302);
    assert.notStrictEqual(cookie, startCookie);
    assert.strictEqual(users[0].is_admin, true);
    assert.strictEqual(users[0].passport_username, 'alice');
    assert.strictEqual((await call(`/auth/passport/callback?code=code&state=${state}`)).status, 403);
    assert.strictEqual(verificationCount, 1);
    for (const passkeys of [[{ credentialID: 'key' }], '[{"credentialID":"key"}]', 'broken']) {
      users = [{ ...legacy, passkeys }];
      const blockedStart = await call('/auth/passport');
      const blockedState = new URL(blockedStart.headers.get('location')).searchParams.get('state');
      assert.strictEqual((await call(`/auth/passport/callback?code=code&state=${blockedState}`)).status, 403);
      assert.strictEqual(users[0].passport_username, undefined);
    }
    users = [{ ...legacy }];
    let next = await call('/auth/passport');
    let nextState = new URL(next.headers.get('location')).searchParams.get('state');
    assert.strictEqual((await call(`/auth/passport/callback?code=code&state=${nextState}`)).status, 302);
    assert.strictEqual(users[0].id, 7); assert.strictEqual(users[0].balance, 42); assert.strictEqual(users[0].username, legacy.username);
    verifyIdentity = 'bob';
    next = await call('/auth/passport'); nextState = new URL(next.headers.get('location')).searchParams.get('state');
    assert.strictEqual((await call(`/auth/passport/callback?code=code&state=${nextState}`)).status, 403);
    assert.strictEqual(users.length, 1); assert.strictEqual(users[0].passport_username, 'alice');
    assert(rotations >= 5);
    next = await call('/auth/passport'); nextState = new URL(next.headers.get('location')).searchParams.get('state');
    assert.strictEqual((await call(`/auth/passport/callback?code=code&state=${nextState}`, 'wrong')).status, 403);
    verifyIdentity = 'alice';
    assert.strictEqual((await call(`/auth/passport/callback?code=code&state=${nextState}`)).status, 302);
    for (const endpoint of ['/auth/passport/cancel', '/auth/logout']) {
      for (const phase of ['verify', 'commit', 'regenerate', 'save']) {
        const begin = await call('/auth/passport');
        const attemptState = new URL(begin.headers.get('location')).searchParams.get('state');
        const paused = gate();
        if (phase === 'verify') verifyGate = paused;
        if (phase === 'commit') commitGate = paused;
        if (phase === 'regenerate') regenerateGate = paused;
        if (phase === 'save') saveGate = paused;
        const count = verificationCount;
        const callback = call(`/auth/passport/callback?code=code&state=${attemptState}`);
        await paused.entered;
        assert.strictEqual((await call(`/auth/passport/callback?code=code&state=${attemptState}`)).status, 403);
        assert.strictEqual(verificationCount, count + 1);
        if (endpoint.endsWith('cancel')) assert.strictEqual((await call(endpoint, 'wrong')).status, 403);
        assert.strictEqual((await call(endpoint)).status, endpoint.endsWith('cancel') ? 204 : 302);
        paused.release();
        assert.strictEqual((await callback).status, 403, `${endpoint} during ${phase}`);
        const response = await originalFetch(root + '/test/session', { headers: { cookie } });
        assert.strictEqual((await response.json()).authenticated, false);
        const all = await new Promise((resolve, reject) => store.all((error, value) => error ? reject(error) : resolve(value)));
        assert(Object.values(all).every(value => !value.user), 'revoked callback must not leave an authenticated session');
      }
    }
    const pendingStart = await call('/auth/passport');
    const pendingState = new URL(pendingStart.headers.get('location')).searchParams.get('state');
    assert.strictEqual((await call('/auth/passport/cancel')).status, 204);
    assert.strictEqual((await call(`/auth/passport/callback?code=code&state=${pendingState}`)).status, 403);
    const failedStart = await call('/auth/passport');
    const failedState = new URL(failedStart.headers.get('location')).searchParams.get('state');
    authenticatedSaveError = true;
    assert.strictEqual((await call(`/auth/passport/callback?code=code&state=${failedState}`)).status, 502);
    const failedSession = await originalFetch(root + '/test/session', { headers: { cookie } });
    assert.strictEqual((await failedSession.json()).authenticated, false);
    const afterFailure = await new Promise((resolve, reject) => store.all((error, value) => error ? reject(error) : resolve(value)));
    assert(Object.values(afterFailure).every(value => !value.user), 'failed authentication persistence must not be retried at response end');
    process.env.CR_RUNTIME = 'server';
    assert.strictEqual((await call('/auth/passport/cancel')).status, 404);
    testConfig.passport.appSecret = '';
    const serverMissingConfig = await call('/auth/passport');
    assert.strictEqual(serverMissingConfig.status, 302);
    assert.strictEqual(serverMissingConfig.headers.get('location'), '/?error=passport_not_configured');
    testConfig.passport.appSecret = 'secret';
    assert.strictEqual((await call('/auth/passport?redirect_origin=https://example.test', 'wrong')).status, 500);
    const serverStart = await call(`/auth/passport?redirect_origin=${encodeURIComponent(root)}`, 'wrong');
    assert.strictEqual(serverStart.status, 302);
    const serverAuthorization = new URL(serverStart.headers.get('location'));
    const serverState = serverAuthorization.searchParams.get('state');
    const serverCallback = new URL(serverAuthorization.searchParams.get('redirect_uri'));
    assert.strictEqual(serverCallback.origin, root);
    assert.strictEqual(serverCallback.pathname, '/auth/passport/callback');
    assert.strictEqual(serverCallback.searchParams.get('state'), serverState);
    assert.strictEqual((await call('/auth/passport/callback?code=code', 'wrong')).status, 400);
    assert.strictEqual((await call(`/auth/passport/callback?code=code&state=${serverState}`, 'wrong')).status, 302);
    assert(!require.cache[require.resolve('../models/database')], 'real database must not load');
    assert(!require.cache[require.resolve('../utils/login-reporter')], 'real login reporter must not load');
    assert(!require.cache[require.resolve('../logger')], 'offline tests must not write application logs');
  } finally {
    await new Promise(resolve => server.close(resolve));
    Module._load = originalLoad;
    global.fetch = originalFetch;
    if (previousRuntime === undefined) delete process.env.CR_RUNTIME; else process.env.CR_RUNTIME = previousRuntime;
    if (previousToken === undefined) delete process.env.CR_LOCAL_TOKEN; else process.env.CR_LOCAL_TOKEN = previousToken;
  }
  console.log('Local Passport token/origin/state/session/binding and HTTP route tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
