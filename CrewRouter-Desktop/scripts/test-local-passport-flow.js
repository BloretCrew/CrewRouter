'use strict';

// node CrewRouter-Desktop/scripts/test-local-passport-flow.js [--scenario=fresh|legacy]
const path = require('node:path');
const desktop = path.resolve(__dirname, '..');
const root = path.resolve(desktop, '..');
const fs = require('node:fs');
const os = require('node:os');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-local-passport-flow-'));
  const home = path.join(temporary, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(temporary, 'cache'), LOCAL_PASSPORT_FLOW_TEMP: temporary, LOCAL_PASSPORT_FLOW_NODE: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = require('electron');
  const args = ['--disable-gpu', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), __filename, ...process.argv.slice(2)];
  const child = spawn(process.platform === 'linux' ? 'xvfb-run' : electron, process.platform === 'linux' ? ['-a', electron, ...args] : args, { cwd: desktop, env, stdio: 'inherit' });
  const timer = setTimeout(() => { console.error('FAIL: Local PassPort flow exceeded 8 minutes'); child.kill('SIGTERM'); }, 480000);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  const finish = code => {
    clearTimeout(timer);
    if (code && process.env.LOCAL_PASSPORT_FLOW_KEEP_FAILED === '1') console.error(`Failure artifacts retained: ${temporary}`);
    else fs.rmSync(temporary, { recursive: true, force: true });
    process.exitCode = code;
  };
  child.once('error', error => { console.error(error); finish(1); });
  child.once('exit', code => finish(code ?? 1));
} else {
  const assert = require('node:assert/strict');
  const http = require('node:http');
  const crypto = require('node:crypto');
  const electron = require('electron');
  const { app, BrowserWindow, session } = electron;
  const { LocalServerManager } = require('../src/server-manager');
  const { createApp } = require('../src/app/create-app');
  const { Pool } = require(path.join(root, 'node_modules/pg'));
  const temporary = process.env.LOCAL_PASSPORT_FLOW_TEMP;
  if (!temporary || !path.basename(temporary).startsWith('crewrouter-local-passport-flow-')) throw new Error('Run this script with Node to create isolated userData.');
  app.setPath('userData', path.join(temporary, 'electron'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const identity = { username: 'desktop-passport-fixture', nickname: 'Desktop PassPort Tester', email: 'desktop-passport@example.test', apptoken: 'fixture-only-not-a-real-token' };
  const appId = 'desktop-flow-fixture';
  const appSecret = 'desktop-flow-fixture-secret';
  const managers = new Set();
  const databaseDirectories = new Set();
  const external = [];
  let mock;
  let runtime;
  let checks = 0;
  let activePool;
  let stage = 'bootstrap';
  const check = (condition, message) => { assert.ok(condition, message); checks++; };

  async function wait(test, label, timeout = 20000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { const result = await test(); if (result) return result; } catch (error) { last = error; }
      await pause(100);
    }
    throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
  }

  async function execute(win, source) {
    let timer;
    try {
      return await Promise.race([win.webContents.executeJavaScript(source, true), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Renderer evaluation timed out during navigation')), 30000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function click(win, selector) {
    await wait(() => execute(win, `(() => {const el=document.querySelector(${JSON.stringify(selector)}); return !!el && !el.disabled && !!el.getBoundingClientRect().width;})()`), `click target ${selector}`);
    win.show(); win.focus();
    await execute(win, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'}); void 0`);
    await pause(180);
    const point = await wait(async () => {
      if (selector.includes('blora-sidebar-nav__link') && await execute(win, `document.getElementById('statsConsentModal')?.hasAttribute('open')`)) {
        await click(win, '#statsConsentReject');
      }
      return execute(win, `(() => {
      const el=document.querySelector(${JSON.stringify(selector)}), r=el.getBoundingClientRect();
      const x=r.left+r.width/2, y=r.top+r.height/2, hit=document.elementFromPoint(x,y);
      if (!r.width || !r.height || el.disabled || x<0 || x>=innerWidth || y<0 || y>=innerHeight || !(hit===el || el.contains(hit))) return null;
      return {x:Math.round(x),y:Math.round(y)};
    })()`);
    }, `mouse target ${selector}`);
    check(point, `Real mouse target reachable: ${selector}`);
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await pause(150);
  }

  function request(url, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { headers }, res => {
        let body = '';
        res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.setTimeout(5000, () => req.destroy(new Error('HTTP probe timeout')));
      req.once('error', reject);
    });
  }

  async function startMock() {
    const codes = new Map();
    const oauth = [];
    const verified = [];
    let next = 'success';
    mock = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        assert.equal(req.headers['x-crewrouter-desktop-token'], undefined, 'Desktop token must never leak to PassPort');
        if (req.method === 'GET' && url.pathname === '/app/oauth') {
          assert.equal(url.searchParams.get('app_id'), appId);
          const state = url.searchParams.get('state');
          const redirect = new URL(url.searchParams.get('redirect_uri'));
          assert.ok(state && state.length >= 32, 'OAuth state is present and unpredictable');
          assert.equal(redirect.hostname, '127.0.0.1');
          assert.equal(redirect.pathname, '/auth/passport/callback');
          const ticket = crypto.randomUUID();
          oauth.push({ state, redirect: redirect.href, ticket });
          codes.set(ticket, { state, redirect: redirect.href, mode: next });
          next = 'success';
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><html><head><title>Mock PassPort</title></head><body><h1>PassPort 测试授权</h1><p>固定测试身份：desktop-passport-fixture</p><form action="/approve"><input type="hidden" name="ticket" value="${ticket}"><button id="approve" type="submit" style="padding:24px">授权 CrewRouter</button></form></body></html>`);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/approve') {
          const ticket = url.searchParams.get('ticket');
          const entry = codes.get(ticket);
          assert.ok(entry, 'Approval ticket exists');
          entry.approved = true;
          const callback = new URL(entry.redirect);
          callback.searchParams.set('code', ticket);
          callback.searchParams.set('state', entry.mode === 'bad-state' ? 'invalid-state' : entry.state);
          res.writeHead(302, { Location: callback.href }); res.end(); return;
        }
        if (req.method === 'POST' && url.pathname === '/app/verify') {
          let body = '';
          for await (const chunk of req) { body += chunk; assert.ok(body.length < 16384); }
          const data = JSON.parse(body);
          assert.equal(data.app_id, appId); assert.equal(data.app_secret, appSecret);
          const entry = codes.get(data.code);
          assert.ok(entry?.approved, 'Only a real browser approval code can be verified');
          codes.delete(data.code);
          verified.push({ code: data.code, mode: entry.mode });
          res.writeHead(entry.mode === 'verify-failure' ? 502 : 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(entry.mode === 'verify-failure' ? { error: 'Fixture verification failure' } : { code: 0, data: identity }));
          return;
        }
        res.writeHead(404); res.end();
      } catch (error) {
        mock.failure = error;
        res.writeHead(500); res.end('Mock assertion failed');
      }
    });
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    return { base: `http://127.0.0.1:${mock.address().port}`, oauth, verified, setMode: mode => { next = mode; } };
  }

  async function fetchPage(win, pathname) {
    return execute(win, `fetch(${JSON.stringify(pathname)}).then(async r=>({status:r.status,body:await r.json()}))`);
  }

  async function loginWindow(main, fixture, mode = 'success') {
    fixture.setMode(mode);
    const before = fixture.oauth.length;
    await wait(() => execute(main, `!!document.querySelector('a[href^="/auth/passport"], #passportLogin, #local-passport-login, #localPassportLogin')`), 'local PassPort login control');
    await click(main, 'a[href^="/auth/passport"], #passportLogin, #local-passport-login, #localPassportLogin');
    let feedback = '';
    const auth = await wait(async () => {
      const candidate = BrowserWindow.getAllWindows().find(win => win !== main && win.webContents.getURL().startsWith(`${fixture.base}/app/oauth`));
      if (candidate) return candidate;
      const message = await execute(main, 'document.getElementById("errorMessage")?.textContent || ""');
      if (message && message !== feedback) { feedback = message; console.error(`Local login feedback: ${message}`); }
      return false;
    }, 'dedicated PassPort authorization window');
    await wait(() => fixture.oauth.length === before + 1, 'mock OAuth request');
    check(auth.webContents.session === main.webContents.session, 'Authorization window shares the main Electron session');
    const prefs = auth.webContents.getLastWebPreferences();
    check(!prefs.preload && !prefs.nodeIntegration && prefs.contextIsolation, 'Authorization window has no preload or Node integration');
    check(await execute(auth, '!window.crewrouterDesktop && typeof require === "undefined"'), 'PassPort has no desktop bridge');
    return auth;
  }

  async function expectLoggedOut(main) {
    await wait(() => execute(main, '!location.pathname.startsWith("/console")'), 'local login page');
    check((await fetchPage(main, '/auth/me')).status === 401, 'Desktop token alone never authenticates a user');
    check((await fetchPage(main, '/api/user/api-keys')).status === 401, 'Private Key API remains protected after logout');
  }

  async function consoleReady(main) {
    await wait(() => execute(main, 'location.pathname === "/console" && typeof app !== "undefined" && !!app.user'), 'authenticated real console', 30000);
    const me = await fetchPage(main, '/auth/me');
    check(me.status === 200 && me.body.isAdmin === true && me.body.passportUsername === identity.username, 'PassPort session belongs to the local administrator');
    check(me.body.needsPasswordSetup === false, 'Local PassPort login never prompts password setup');
    return me.body;
  }

  async function inspectConsole(main) {
    await wait(() => execute(main, `!!document.getElementById('statsConsentModal')?.hasAttribute('open') || !!app.user`), 'console initialization');
    for (const [page, endpoint] of [['apiKeys', '/api/user/api-keys'], ['myUpstream', '/api/user/providers'], ['stats', '/api/user/stats'], ['settings', '/api/user/notification-settings']]) {
      stage = `console ${page}`;
      if (await execute(main, `document.getElementById('statsConsentModal')?.hasAttribute('open')`)) {
        await click(main, '#statsConsentReject');
        await wait(() => execute(main, `!document.getElementById('statsConsentModal')?.hasAttribute('open')`), 'stats consent dismissed');
      }
      await click(main, `.business-sidebar-host .blora-sidebar-nav__link[data-value="${page}"]`);
      await wait(() => execute(main, `document.getElementById(${JSON.stringify(page + 'Page')})?.classList.contains('active')`), `${page} page active`);
      const result = await fetchPage(main, endpoint);
      check(result.status === 200, `Real authenticated ${page} API returns HTTP 200`);
      check(await execute(main, `(() => {const el=document.getElementById(${JSON.stringify(page + 'Page')});return !!el && el.getBoundingClientRect().height>0;})()`), `${page} renders visibly`);
      if (page === 'apiKeys') await wait(() => execute(main, 'document.getElementById("apiKeysList")?.dataset.bloraState !== "loading"'), 'Key list finishes loading');
      console.log(`PASS real console page: ${page}`);
    }
  }

  async function scenario(name, fixture) {
    stage = `${name}: startup`;
    const userData = path.join(temporary, name);
    fs.mkdirSync(userData);
    let legacy;
    const observed = [];
    const created = [];
    runtime = createApp({ electron: { ...electron, shell: { ...electron.shell, openExternal: async url => { external.push(url); throw new Error('External browser is forbidden in Local PassPort flow'); } } }, userData, isPackaged: false,
      env: { ...process.env, CREWROUTER_WINDOW_WIDTH: '1280', CREWROUTER_WINDOW_HEIGHT: '900' },
      localManagerFactory: options => {
        const manager = new LocalServerManager({ ...options, serverEntry: path.join(root, 'server/index.js'), startupTimeoutMs: 90000,
          // 开发依赖要求 Node 24；Electron 32 内置的 Node 20 无法 require ESM 依赖。
          runAsNode: false, spawn: (_executable, args, childOptions) => require('node:child_process').spawn(process.env.LOCAL_PASSPORT_FLOW_NODE, args, { ...childOptions, env: { ...childOptions.env, ELECTRON_RUN_AS_NODE: undefined } }),
          config: { passport: { baseUrl: fixture.base, appId, appSecret }, loginReport: { enabled: false }, statsReport: { enabled: false } } });
        managers.add(manager);
        const start = manager.start.bind(manager);
        manager.start = async () => {
          const status = await start();
          if (manager.database?.dataDir) databaseDirectories.add(path.dirname(manager.database.dataDir));
          activePool = new Pool({ ...manager.runtime.config.database, database: manager.runtime.config.database.name });
          check(status.database && status.database.port !== 5432, 'LocalServerManager starts a dedicated PostgreSQL on a temporary port');
          check(manager.runtime.config.auth.required === true && JSON.stringify(manager.runtime.config.auth.methods) === '["passport"]', 'Production desktop config requires PassPort');
          check((await activePool.query('SELECT id FROM users')).rowCount === 0, 'Fresh startup creates no unauthenticated local administrator');
          if (name === 'legacy') {
            legacy = (await activePool.query("INSERT INTO users (username, is_admin, email_verified, balance) VALUES ('desktop-local', TRUE, TRUE, 37) RETURNING *")).rows[0];
            await activePool.query("INSERT INTO api_keys (user_id, key_hash, key_value, key_prefix, name) VALUES ($1, $2, $3, $4, 'Legacy retained Key')", [legacy.id, require(path.join(root, 'server/utils/key-hash')).sha256Hex('sk-legacy-fixture-only'), 'sk-legacy-fixture-only', 'sk-legacy-fi']);
          }
          return status;
        };
        return manager;
      } });
    const onWindow = (_, win) => { created.push(win); win.webContents.on('preload-error', (_, file, error) => observed.push(`${file}: ${error.message}`)); };
    app.on('browser-window-created', onWindow);
    try {
      await runtime.init();
      const main = runtime.ctx.mainWindow;
      await wait(() => execute(main, '!!window.crewrouterDesktop && !!document.getElementById("choose-local")'), 'real launcher ready');
      await click(main, '#choose-local');
      await pause(250);
      if (await execute(main, '!!document.querySelector("#local-username-field input") && !document.getElementById("view-local-name").hidden')) {
        await click(main, '#local-username-field input');
        main.webContents.insertText('Desktop Fixture');
        await click(main, '#local-continue');
      }
      await wait(() => runtime.state.mode === 'error' || (runtime.state.mode === 'connected' && runtime.ctx.local?.getStatus().ready && runtime.ctx.window.currentUrl().startsWith('http:')), 'Local starts and opens real login page', 120000);
      check(runtime.state.mode !== 'error', `Local startup succeeds: ${runtime.state.error?.message || ''}`);
      const manager = runtime.ctx.local;
      const base = manager.getStatus().baseUrl;
      await expectLoggedOut(main);
      check((await request(`${base}/auth/passport`)).status === 403, 'OAuth entry without Desktop token is forbidden');
      const token = { 'x-crewrouter-desktop-token': manager.localToken };
      const noState = await request(`${base}/auth/passport/callback?code=unsolicited`, token);
      check([400, 403].includes(noState.status), 'Callback without session state is rejected');
      const countBefore = fixture.verified.length;
      stage = `${name}: cancel`;
      let auth = await loginWindow(main, fixture);
      auth.close();
      await wait(() => auth.isDestroyed(), 'closed authorization window');
      await expectLoggedOut(main);
      stage = `${name}: strict state`;
      auth = await loginWindow(main, fixture, 'bad-state');
      await click(auth, '#approve');
      await wait(() => auth.isDestroyed() || auth.webContents.getURL().includes('/auth/passport/callback'), 'bad state callback');
      check(fixture.verified.length === countBefore, 'Invalid state never reaches PassPort verification');
      if (!auth.isDestroyed()) {
        await wait(() => execute(auth, 'document.body.innerText.includes("状态")'), 'state rejection displayed');
        auth.close();
      }
      await expectLoggedOut(main);
      stage = `${name}: verification failure`;
      auth = await loginWindow(main, fixture, 'verify-failure');
      await click(auth, '#approve');
      await wait(() => fixture.verified.length === countBefore + 1, 'failed verification request');
      await wait(() => auth.isDestroyed(), 'failure closes authorization window');
      await wait(() => execute(main, 'document.getElementById("errorMessage")?.textContent.includes("失败")'), 'failure visible on login page');
      if (!auth.isDestroyed()) auth.close();
      await expectLoggedOut(main);
      stage = `${name}: successful retry`;
      auth = await loginWindow(main, fixture);
      const approved = fixture.oauth.at(-1);
      await click(auth, '#approve');
      const me = await consoleReady(main);
      await wait(() => auth.isDestroyed(), 'authorization window closes after success');
      const users = (await activePool.query('SELECT * FROM users ORDER BY id')).rows;
      check(users.length === 1 && users[0].passport_username === identity.username, 'One administrator is bound to the fixed PassPort identity');
      if (legacy) {
        check(me.id === legacy.id && Number(users[0].balance) === 37, 'Legacy administrator identity and balance are preserved');
        check((await activePool.query('SELECT name FROM api_keys WHERE user_id = $1', [legacy.id])).rows.some(row => row.name === 'Legacy retained Key'), 'Legacy Key ownership survives binding');
      }
      const cookies = await session.defaultSession.cookies.get({ url: base });
      const replay = await request(`${base}/auth/passport/callback?code=${approved.ticket}&state=${approved.state}`, { ...token, cookie: cookies.map(item => `${item.name}=${item.value}`).join('; ') });
      check([400, 403].includes(replay.status), 'Consumed state cannot be replayed');
      await inspectConsole(main);
      stage = `${name}: logout and relogin`;
      await click(main, '#logoutBtn');
      await expectLoggedOut(main);
      auth = await loginWindow(main, fixture);
      await click(auth, '#approve');
      const relogin = await consoleReady(main);
      check(relogin.id === me.id && (await activePool.query('SELECT id FROM users')).rowCount === 1, 'Relogin reuses the same administrator without duplicate users');
      await wait(() => auth.isDestroyed(), 'relogin authorization window closes');
      check(observed.length === 0, `No preload errors: ${observed.join('; ')}`);
      check(!mock.failure, `Mock PassPort assertions: ${mock.failure?.message || 'none'}`);
      check(external.length === 0, 'Local authentication never opens an external browser');
      console.log(`PASS Local PassPort ${name}: real launcher/login/OAuth/console, strict state, cancel/failure retry, logout/relogin`);
    } catch (error) {
      const main = runtime.ctx.mainWindow;
      if (main && !main.isDestroyed()) {
        fs.writeFileSync(path.join(userData, 'failure.png'), (await main.webContents.capturePage()).toPNG());
        console.error(`Stage: ${stage}; main URL: ${main.webContents.getURL()}; desktop mode: ${runtime.state.mode}`);
      }
      for (const manager of managers) if (manager.runtime?.logsDir) {
        const file = path.join(manager.runtime.logsDir, 'server.log');
        if (fs.existsSync(file)) console.error(fs.readFileSync(file, 'utf8').slice(-12000));
      }
      throw error;
    } finally {
      app.removeListener('browser-window-created', onWindow);
      await activePool?.end(); activePool = null;
      runtime.ctx.quitting = true;
      await runtime.ctx.localPassport?.cancel();
      await runtime.ctx.local?.stop().catch(() => {});
      for (const win of created) if (!win.isDestroyed()) win.destroy();
      for (const channel of Object.keys(require('../src/app/ipc').ALLOW)) electron.ipcMain.removeHandler(channel);
      runtime = null;
      await session.defaultSession.clearStorageData();
      session.defaultSession.webRequest.onBeforeSendHeaders(null);
    }
  }

  async function run() {
    const argument = process.argv.find(value => value.startsWith('--scenario='));
    const selected = argument?.slice('--scenario='.length);
    if (selected && !['fresh', 'legacy'].includes(selected)) throw new Error('Use --scenario=fresh or --scenario=legacy');
    const fixture = await startMock();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      let permitted = details.url.startsWith('file:') || details.url.startsWith('data:') || details.url === 'about:blank';
      try { permitted ||= new URL(details.url).hostname === '127.0.0.1'; } catch {}
      callback({ cancel: !permitted });
    });
    try {
      for (const name of selected ? [selected] : ['fresh', 'legacy']) await scenario(name, fixture);
      console.log(`PASS: ${checks} assertions; isolated userData, temporary ports, independent PostgreSQL and real Desktop Local PassPort browser flow.`);
    } finally {
      for (const manager of managers) await manager.stop().catch(() => {});
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
      session.defaultSession.webRequest.onBeforeRequest(null);
      mock.closeAllConnections();
      await new Promise(resolve => mock.close(resolve));
      for (const directory of databaseDirectories) {
        if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('crewrouter-desktop-postgres-')) fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  }
  app.whenReady().then(run).then(() => app.exit(0)).catch(async error => {
    console.error(error.stack || error);
    for (const manager of managers) await manager.stop().catch(() => {});
    app.exit(1);
  });
}
