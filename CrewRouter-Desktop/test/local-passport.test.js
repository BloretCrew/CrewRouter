'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalPassport, passportOrigin } = require('../src/app/local-passport');
const { createMainWindow } = require('../src/app/window');
const { classifySender } = require('../src/app/ipc');
const { AppState } = require('../src/app/state');
const { createElectronStub, ipcEvent, silentLogger } = require('./helpers/electron-stub');

const LOCAL = 'http://127.0.0.1:4321';
const PASSPORT = 'https://passport.bloret.net';
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function setup(options = {}) {
  const electron = createElectronStub({ userData: '/tmp/unused' });
  const state = new AppState();
  state.set({ target: LOCAL, instance: { runtime: 'desktop-local' } });
  let flow;
  const main = createMainWindow({ electron, state, rendererEntry: '/tmp/index.html', preloadPath: '/tmp/preload.js', logger: silentLogger, openSafeExternal: (url) => electron.shell.openExternal(url), interceptNavigation: (...args) => flow.intercept(...args) });
  await main.loadTarget(`${LOCAL}/`);
  flow = createLocalPassport({ electron, getTarget: () => state.target, getWindow: () => main, logger: silentLogger, fetchImpl: async () => ({ ok: true, json: async () => ({ passportOrigin: PASSPORT }) }), ...options });
  const start = async (url = `${LOCAL}/auth/passport?invite=abc`) => {
    let prevented = false;
    main.win.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, url);
    assert.equal(prevented, true);
    await tick();
    return electron.BrowserWindow.instances.at(-1);
  };
  return { electron, state, main, flow, start };
}

function navigation(win, event, url, isMainFrame = true) {
  let blocked = false;
  win.webContents.emit(event, { preventDefault() { blocked = true; } }, url, false, isMainFrame);
  return blocked;
}

test('Passport origin accepts HTTPS and loopback mock, rejects unsafe configuration', () => {
  assert.equal(passportOrigin(), PASSPORT);
  assert.equal(passportOrigin('http://127.0.0.1:9876'), 'http://127.0.0.1:9876');
  for (const raw of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?token=x', 'file:///tmp']) assert.throws(() => passportOrigin(raw));
});

test('link interaction isolates authorization, shares session and returns only after callback success', async () => {
  const { electron, state, main, flow, start } = await setup();
  const auth = await start();
  assert.equal(main.currentUrl(), `${LOCAL}/`);
  assert.equal(auth.loads[0].url, `${LOCAL}/auth/passport?invite=abc`);
  assert.equal(auth.options.webPreferences.session, electron.session.defaultSession);
  assert.equal(auth.options.webPreferences.preload, undefined);
  assert.equal(auth.options.webPreferences.sandbox, true);
  assert.equal(auth.options.webPreferences.nodeIntegration, false);
  assert.equal(auth.options.webPreferences.contextIsolation, true);
  assert.equal(classifySender(ipcEvent(auth, `${LOCAL}/auth/passport/callback`), { mainWindow: main.win, rendererEntry: '/tmp/index.html', state }), null);
  assert.equal(navigation(auth, 'will-redirect', `${PASSPORT}/app/oauth?state=xyz`), false);
  assert.equal(navigation(auth, 'will-navigate', `${LOCAL}/console`), true);
  for (const url of ['https://evil.example/', `${LOCAL}/api/settings`, 'file:///tmp/x', `${PASSPORT}:443.evil.example/`]) assert.equal(navigation(auth, 'will-redirect', url), true);
  assert.deepEqual(auth.webContents.openHandler({ url: `${PASSPORT}/new` }), { action: 'deny' });
  assert.equal(navigation(auth, 'will-redirect', `${LOCAL}/auth/passport/callback?code=abc&state=xyz`), false);
  assert.equal(navigation(auth, 'will-redirect', `${LOCAL}/console`), false);
  auth.webContents.emit('did-navigate', {}, `${LOCAL}/console`, 200);
  await tick();
  assert.equal(main.currentUrl(), `${LOCAL}/console`);
  assert.equal(auth.isDestroyed(), true);
  assert.equal(flow.isPending(), false);
  assert.deepEqual(electron.shell.opened, []);
});

test('cancel, user close, timeout and failure leave local page intact and permit retry', async () => {
  const { main, flow, start } = await setup({ timeoutMs: 30 });
  let auth = await start();
  await flow.cancel();
  assert.equal(auth.isDestroyed(), true);
  auth = await start();
  auth.destroy();
  assert.equal(flow.isPending(), false);
  auth = await start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(auth.isDestroyed(), true);
  auth = await start();
  auth.webContents.emit('did-fail-load', {}, -105, 'unreachable', PASSPORT, true);
  assert.equal(auth.isDestroyed(), true);
  assert.equal(main.currentUrl(), `${LOCAL}/`);
  auth = await start();
  assert.equal(auth.isDestroyed(), false);
  flow.cancel();
});

test('HTTP will-redirect and popup initiation stay inside Electron', async () => {
  const { main, flow, electron } = await setup();
  main.win.webContents.emit('did-start-navigation', {}, `${LOCAL}/auth/passport`, false, true);
  assert.equal(navigation(main.win, 'will-redirect', `${PASSPORT}/app/oauth`), true);
  await tick();
  assert.equal(main.currentUrl(), `${LOCAL}/`);
  assert.equal(electron.BrowserWindow.instances.at(-1).loads[0].url, `${LOCAL}/auth/passport`);
  flow.cancel();
  assert.deepEqual(main.win.webContents.openHandler({ url: `${LOCAL}/auth/passport` }), { action: 'deny' });
  await tick();
  assert.equal(flow.isPending(), true);
  assert.deepEqual(electron.shell.opened, []);
  flow.cancel();
});

test('stale metadata response cannot open an authorization window after cancellation', async () => {
  let resolve;
  const { flow, start, electron } = await setup({ fetchImpl: () => new Promise((done) => { resolve = done; }) });
  const count = electron.BrowserWindow.instances.length;
  await start();
  flow.cancel();
  resolve({ ok: true, json: async () => ({ passportOrigin: PASSPORT }) });
  await tick();
  assert.equal(electron.BrowserWindow.instances.length, count);
});

test('missing PassPort credentials show a configuration message without opening authorization', async () => {
  const { main, flow, start, electron } = await setup({
    fetchImpl: async () => ({ ok: true, json: async () => ({ passportOrigin: PASSPORT, passportConfigured: false }) }),
  });
  const el = errorElement(main);
  const count = electron.BrowserWindow.instances.length;
  await start();
  await tick();
  assert.equal(electron.BrowserWindow.instances.length, count);
  assert.equal(main.currentUrl(), `${LOCAL}/`);
  assert.equal(flow.isPending(), false);
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /PassPort 登录尚未配置/);
  await flow.cancel();
});

test('provider login, session and 2FA navigation allows only exact GitHub/Feishu HTTPS origins', async () => {
  const { flow, start } = await setup();
  const auth = await start();
  const allowed = [
    'https://github.com/login/oauth/authorize?client_id=mock',
    'https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize',
    'https://github.com/session',
    'https://github.com/sessions/two-factor',
    'https://github.com/login/device#verify',
    'https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=mock',
    'https://passport.feishu.cn/accounts/page/login?app_id=mock',
    'https://passport.feishu.cn/suite/passport/auth',
  ];
  const blocked = [
    'http://github.com/login', 'http://passport.feishu.cn/login',
    'https://github.com.evil.example/login', 'https://evil.github.com/login',
    'https://github.com:444/login', 'https://user:secret@github.com/login',
    'https://github.com@evil.example/login', 'https://api.github.com/user',
    'https://accounts.feishu.cn/login', 'https://feishu.cn/login',
    'https://passport.feishu.cn.evil.example/login', 'https://passport.feishu.cn:444/login',
    'https://user@passport.feishu.cn/login', 'javascript:alert(1)',
    'data:text/html,evil', `${LOCAL}/auth/passport/cancel`, `${LOCAL}/console`,
  ];
  for (const event of ['will-navigate', 'will-redirect']) {
    for (const url of allowed) assert.equal(navigation(auth, event, url), false, `${event}: ${url}`);
    for (const url of blocked) assert.equal(navigation(auth, event, url), true, `${event}: ${url}`);
    assert.equal(navigation(auth, event, allowed[0], false), true, '子框架导航被阻止');
  }
  await flow.cancel();
});

function errorElement(main) {
  const el = { textContent: '', hidden: true, shown: false, classList: { toggle(_name, visible) { el.shown = visible; } } };
  main.win.webContents.executeJavaScript = async (source) => {
    const document = { getElementById: (id) => id === 'errorMessage' ? el : null };
    require('node:vm').runInNewContext(source, { document });
  };
  return el;
}

test('timeout and network error make errorMessage visible on plain and styled login pages', async () => {
  for (const reason of ['timeout', 'network']) {
    const { main, flow, start } = await setup({ timeoutMs: reason === 'timeout' ? 20 : 1000 });
    const el = errorElement(main);
    const auth = await start();
    assert.equal(el.hidden, true);
    assert.equal(el.shown, false);
    if (reason === 'timeout') await new Promise((resolve) => setTimeout(resolve, 40));
    else auth.webContents.emit('did-fail-load', {}, -105, 'unreachable', PASSPORT, true);
    await tick();
    assert.equal(auth.isDestroyed(), true);
    assert.equal(el.hidden, false);
    assert.equal(el.shown, true);
    assert.match(el.textContent, reason === 'timeout' ? /超时/ : /网络错误/);
    await start();
    assert.equal(el.hidden, true);
    assert.equal(el.shown, false);
    await flow.cancel();
  }
});

test('failed revocation retries serially and cannot open a new flow until revocation succeeds', async () => {
  const { electron, main, flow, start } = await setup({ getToken: () => 'private-token' });
  const el = errorElement(main);
  const requests = [];
  electron.session.defaultSession.fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  await start();
  const first = flow.cancel();
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${LOCAL}/auth/passport/cancel`);
  assert.equal(requests[0].options.headers['x-crewrouter-desktop-token'], 'private-token');
  requests[0].reject(new Error('offline'));
  await first;
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /取消授权失败.*offline/);
  const count = electron.BrowserWindow.instances.length;
  await start();
  await start();
  assert.equal(requests.length, 2, '并发重试共用一个撤销请求');
  assert.equal(electron.BrowserWindow.instances.length, count);
  requests[1].resolve({ ok: false, status: 503 });
  await tick();
  assert.equal(flow.isPending(), false);
  assert.equal(electron.BrowserWindow.instances.length, count);
  assert.match(el.textContent, /503/);
  const retried = flow.cancel();
  const opening = start();
  await tick();
  assert.equal(requests.length, 3);
  assert.equal(electron.BrowserWindow.instances.length, count);
  requests[2].resolve({ ok: true, status: 204 });
  await retried;
  await opening;
  await tick();
  assert.equal(electron.BrowserWindow.instances.length, count + 1);
  assert.equal(flow.isPending(), true);
  assert.equal(el.hidden, true);
  const done = flow.cancel();
  await tick();
  requests[3].resolve({ ok: true, status: 204 });
  await done;
  assert.equal(el.hidden, false);
  assert.equal(el.shown, true);
  assert.match(el.textContent, /已取消登录/);
});

test('callback session verification rejects invalid sessions and only success loads console', async () => {
  for (const response of [{ ok: false, status: 401 }, { ok: true, json: async () => ({}) }, { ok: true, json: async () => ({ id: 1 }) }]) {
    const { electron, main, flow, start } = await setup();
    const el = errorElement(main);
    electron.session.defaultSession.fetch = async (url) => url.endsWith('/auth/me') ? response : { ok: true, status: 204 };
    const auth = await start();
    navigation(auth, 'will-redirect', `${LOCAL}/auth/passport/callback?state=x&code=y`);
    navigation(auth, 'will-redirect', `${LOCAL}/console`);
    auth.webContents.emit('did-navigate', {}, `${LOCAL}/console`, 200);
    await tick();
    const success = response.ok && (await response.json()).id;
    assert.equal(main.currentUrl(), success ? `${LOCAL}/console` : `${LOCAL}/`);
    if (!success) { assert.equal(el.hidden, false); assert.match(el.textContent, /登录会话无效/); }
    assert.equal(auth.isDestroyed(), true);
    await flow.cancel();
  }
});
