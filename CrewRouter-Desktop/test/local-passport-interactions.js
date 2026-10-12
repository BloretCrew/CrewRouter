'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const electron = require('electron');
const { AppState } = require('../src/app/state');
const { createMainWindow } = require('../src/app/window');
const { createLocalPassport } = require('../src/app/local-passport');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const waitFor = async (predicate) => {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('交互测试等待超时');
};

async function run() {
  let localOrigin;
  let passportCookie = false;
  let callbackCookie = false;
  let callbackToken = false;
  let externalCalls = 0;
  const passportServer = http.createServer((req, res) => {
    passportCookie = req.headers.cookie?.includes('passport_session=shared') || false;
    res.setHeader('content-type', 'text/html');
    res.end(`<button id="authorize" onclick="location.href='${localOrigin}/auth/passport/callback?code=mock&state=strict'">批准</button>`);
  });
  const origin = await listen(passportServer);
  const localServer = http.createServer((req, res) => {
    if (req.url === '/auth/status') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ passportOrigin: origin })); return; }
    if (req.url === '/auth/me') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 1 })); return; }
    if (req.url === '/auth/passport/cancel') { res.writeHead(204); res.end(); return; }
    if (req.url.startsWith('/auth/passport/callback')) {
      callbackCookie = req.headers.cookie?.includes('local_state=strict') || false;
      callbackToken = req.headers['x-crewrouter-desktop-token'] === 'test-token';
      res.writeHead(302, { location: '/console', 'set-cookie': 'local_login=success; Path=/; HttpOnly' }); res.end(); return;
    }
    if (req.url.startsWith('/auth/passport')) {
      assert.equal(req.headers['x-crewrouter-desktop-token'], 'test-token');
      res.writeHead(302, { location: `${origin}/app/oauth`, 'set-cookie': 'local_state=strict; Path=/; HttpOnly' }); res.end(); return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/console') { res.end('<h1>Console</h1>'); return; }
    res.end('<a id="login" href="/auth/passport">登录</a>');
  });
  localOrigin = await listen(localServer);
  await electron.session.defaultSession.cookies.set({ url: origin, name: 'passport_session', value: 'shared', path: '/' });
  electron.session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${localOrigin}/*`] }, (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, 'x-crewrouter-desktop-token': 'test-token' } }));
  const state = new AppState();
  state.set({ target: localOrigin, instance: { runtime: 'desktop-local' } });
  let flow;
  const main = createMainWindow({ electron, state, rendererEntry: path.join(__dirname, '../src/renderer/index.html'), preloadPath: path.join(__dirname, '../src/preload.js'), openSafeExternal: async () => { externalCalls += 1; }, interceptNavigation: (...args) => flow.intercept(...args) });
  flow = createLocalPassport({ electron, getTarget: () => state.target, getWindow: () => main, getToken: () => 'test-token', fetchImpl: fetch });
  const authWindow = () => electron.BrowserWindow.getAllWindows().find((win) => win !== main.win);
  const open = async (script) => {
    await main.win.webContents.executeJavaScript(script);
    await waitFor(() => authWindow()?.webContents.getURL().startsWith(origin));
    assert.equal(main.currentUrl(), `${localOrigin}/`);
    return authWindow();
  };
  try {
    await main.loadTarget(`${localOrigin}/`);
    let auth = await open("document.getElementById('login').click()");
    assert.equal(auth.webContents.session, electron.session.defaultSession);
    assert.equal(await auth.webContents.executeJavaScript("typeof window.desktop + ':' + typeof require"), 'undefined:undefined');
    auth.close();
    await waitFor(() => !flow.isPending());
    auth = await open("document.getElementById('login').click()");
    flow.cancel();
    await waitFor(() => !authWindow());
    // 主进程 loadURL 不触发 will-navigate，必须捕获 will-redirect。
    main.win.loadURL(`${localOrigin}/auth/passport`).catch((error) => { if (error.code !== 'ERR_ABORTED') throw error; });
    await waitFor(() => authWindow()?.webContents.getURL().startsWith(origin));
    await waitFor(() => main.currentUrl() === `${localOrigin}/`);
    auth = authWindow();
    await auth.webContents.executeJavaScript("document.getElementById('authorize').click()");
    await waitFor(() => main.currentUrl() === `${localOrigin}/console` && !main.win.webContents.isLoading() && !authWindow());
    assert.equal(passportCookie, true);
    assert.equal(callbackCookie, true);
    assert.equal(callbackToken, true);
    assert.equal(externalCalls, 0);
    console.log('PASS: 实际 Electron 链接、取消重试、HTTP 302、共享 Cookie/Token、无 preload 授权窗口及回到 console');
  } finally {
    await flow.cancel();
    main.win.destroy();
    localServer.close();
    passportServer.close();
  }
}

electron.app.whenReady().then(run).then(() => electron.app.exit(0)).catch((error) => { console.error(error); electron.app.exit(1); });
