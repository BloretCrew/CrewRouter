'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createOfficialLogin, parseSetCookie } = require('../src/app/official-login');
const { AppState } = require('../src/app/state');
const { validateRemoteUrl } = require('../src/url-policy');
const { createElectronStub, silentLogger } = require('./helpers/electron-stub');

function get(url) {
  return new Promise((resolve, reject) => {
    // 每次新建连接，确保回调服务器关闭后新的请求会被拒绝。
    http.get(url, { agent: false }, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body })); }).once('error', reject);
  });
}
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup({ fetchImpl, ttlMs } = {}) {
  const electron = createElectronStub({ userData: '/tmp/unused' });
  const state = new AppState();
  const connects = [];
  const login = createOfficialLogin({
    electron,
    demoUrl: 'https://demo.example',
    fetchImpl: fetchImpl || (async (url, options) => { connects.push({ url: String(url), options }); return { ok: true, status: 200, headers: { 'set-cookie': ['crewrouter.sid=abc123; Path=/; HttpOnly'] }, json: async () => ({ ok: true }) }; }),
    state,
    connect: async (url, options) => { connects.push({ connect: url, options }); state.connected({ target: new URL(url).origin, instance: { runtime: 'server', edition: 'personal' }, profile: { id: 'p', name: 'router' } }); return state.snapshot(); },
    validateRemoteUrl,
    ttlMs: ttlMs || 60000,
    logger: silentLogger,
  });
  return { electron, state, login, connects };
}

test('official login opens the store picker with PKCE and a loopback callback', async () => {
  const { electron, state, login } = setup();
  await login.start();
  assert.equal(state.mode, 'awaiting-official-login');
  assert.equal(state.pending.kind, 'official-login');
  const loginUrl = new URL(electron.shell.opened[0]);
  assert.equal(loginUrl.origin, 'https://demo.example');
  assert.equal(loginUrl.pathname, '/store');
  assert.equal(loginUrl.searchParams.get('helper_login'), '1');
  assert.equal(loginUrl.searchParams.get('client_id'), 'crewrouter-desktop');
  assert.equal(loginUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.match(loginUrl.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(new URL(loginUrl.searchParams.get('redirect_uri')).port, String(login.callbackPort()));
  assert.equal(state.pending.loginUrl, loginUrl.toString());
  login.cancel();
  assert.equal(state.mode, 'idle');
  assert.equal(login.isPending(), false);
});

test('invalid callbacks are rejected without ending the pending login', async () => {
  const { electron, state, login } = setup();
  await login.start();
  const redirectUri = new URL(electron.shell.opened[0]).searchParams.get('redirect_uri');
  const wrongNonce = await get(`${redirectUri}?code=abc&state=${b64({ nonce: 'nope', router_url: 'https://router.example' })}`);
  assert.equal(wrongNonce.status, 400);
  assert.equal(login.isPending(), true);
  assert.equal(state.mode, 'awaiting-official-login');
  const wrongPath = await get(`${redirectUri.replace('/callback', '/other')}`);
  assert.equal(wrongPath.status, 404);
  login.cancel();
});

test('valid callback exchanges the code, installs the session cookie and connects the target', async () => {
  const { electron, state, login, connects } = setup();
  await login.start();
  const opened = new URL(electron.shell.opened[0]);
  const nonce = opened.searchParams.get('state');
  const redirectUri = opened.searchParams.get('redirect_uri');
  const response = await get(`${redirectUri}?code=code-1&state=${b64({ nonce, router_url: 'https://router.example' })}`);
  assert.equal(response.status, 200);
  assert.match(response.body, /CrewRouter Desktop/);
  await sleep(50);
  assert.equal(login.isPending(), false);
  const exchange = connects.find((item) => item.url);
  assert.equal(exchange.url, 'https://router.example/oauth/desktop-session');
  assert.equal(exchange.options.method, 'POST');
  const body = new URLSearchParams(exchange.options.body);
  assert.equal(body.get('code'), 'code-1');
  assert.equal(body.get('client_id'), 'crewrouter-desktop');
  assert.match(body.get('code_verifier'), /^[A-Za-z0-9_-]{40,}$/);
  const cookie = await electron.session.defaultSession.cookies.get({ url: 'https://router.example/', name: 'crewrouter.sid' });
  assert.equal(cookie[0].value, 'abc123');
  assert.equal(cookie[0].secure, true);
  const connect = connects.find((item) => item.connect);
  assert.equal(connect.connect, 'https://router.example/');
  assert.equal(connect.options.officialTarget, true);
  assert.equal(state.mode, 'connected');
  await assert.rejects(get(`${redirectUri}`), /ECONNREFUSED/);
});

test('exchange failure lands in the error state with a retry action', async () => {
  const { electron, state, login } = setup({ fetchImpl: async () => ({ ok: false, status: 500, headers: {}, json: async () => ({}) }) });
  await login.start();
  const opened = new URL(electron.shell.opened[0]);
  await get(`${opened.searchParams.get('redirect_uri')}?code=x&state=${b64({ nonce: opened.searchParams.get('state'), router_url: 'https://router.example' })}`);
  await sleep(50);
  assert.equal(state.mode, 'error');
  assert.match(state.error.message, /HTTP 500/);
  assert.deepEqual(state.error.retry, { action: 'official-login' });
});

test('pending login expires after the TTL', async () => {
  const { state, login } = setup({ ttlMs: 40 });
  await login.start();
  await sleep(90);
  assert.equal(login.isPending(), false);
  assert.equal(state.mode, 'error');
  assert.match(state.error.message, /超时/);
});

test('parseSetCookie extracts the first cookie pair', () => {
  assert.deepEqual(parseSetCookie({ 'set-cookie': ['sid=v=1; Path=/'] }), { name: 'sid', value: 'v=1' });
  assert.throws(() => parseSetCookie({}), /Cookie/);
  assert.throws(() => parseSetCookie({ 'set-cookie': '=x' }), /格式无效/);
});
