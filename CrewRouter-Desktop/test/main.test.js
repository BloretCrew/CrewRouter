'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createApp, rendererEntry } = require('../src/app/create-app');
const { createElectronStub, ipcEvent, silentLogger } = require('./helpers/electron-stub');

const TEAM = { runtime: 'server', edition: 'team', auth: { required: true, methods: ['password', 'feishu'] }, capabilities: { teamAdmin: true }, protocolVersion: '1' };
const LOCAL = { runtime: 'desktop-local', edition: 'personal', auth: { required: false, methods: ['local'] }, capabilities: { models: true }, demo: false };
const REMOTE_URL = 'http://203.0.113.10:8080';
const LOCAL_BASE = 'http://127.0.0.1:4321';
const launcherUrl = pathToFileURL(rendererEntry).href;
const ok = (body) => ({ ok: true, status: 200, headers: {}, json: async () => body });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeLocalManager extends EventEmitter {
  constructor(options) { super(); this.options = options; this.status = { ready: false, pid: null, port: null, baseUrl: null, logsDir: path.join(options.userData, 'logs'), version: null }; this.localToken = 'local-token'; this.started = 0; this.stopped = 0; this.aborted = false; }
  async start() {
    this.started += 1;
    this.emit('progress', { step: 1, total: 4, label: '正在准备本地数据库' });
    if (this.options.failStart) throw new Error('initdb exploded');
    this.emit('progress', { step: 3, total: 4, label: '正在检查服务就绪' });
    this.status = { ready: true, pid: 777, port: 4321, baseUrl: LOCAL_BASE, logsDir: this.status.logsDir, version: '1.0.0' };
    return this.getStatus();
  }
  getStatus() { return { ...this.status }; }
  abort() { this.aborted = true; }
  async stop() { this.stopped += 1; this.status = { ...this.status, ready: false }; }
  crash() { this.status = { ...this.status, ready: false }; this.emit('exit', { code: 1, signal: null, wasReady: true, aborted: false, logPath: '/tmp/server.log' }); }
}

async function boot({ fetchImpl, failStart = false } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-app-'));
  const electron = createElectronStub({ userData });
  const managers = [];
  const app = createApp({
    electron,
    userData,
    env: {},
    logger: silentLogger,
    fetchImpl: fetchImpl || (async (url) => (String(url).startsWith(LOCAL_BASE) ? ok(LOCAL) : ok(TEAM))),
    localManagerFactory: (options) => { const manager = new FakeLocalManager({ ...options, failStart }); managers.push(manager); return manager; },
  });
  await app.init();
  const win = electron.BrowserWindow.instances.at(-1);
  return { app, electron, userData, win, managers, launcher: () => ipcEvent(win, launcherUrl) };
}

test('init opens the launcher, registers IPC and protocol handling', async () => {
  const { app, electron, win } = await boot();
  assert.equal(app.state.mode, 'idle');
  assert.deepEqual(win.loads, [{ type: 'file', file: rendererEntry }]);
  assert.ok(electron.ipcMain.handlers.has('desktop:start-local'));
  assert.deepEqual(electron.app.protocolClients, ['crewrouter']);
  assert.ok(electron.Menu.template.some((item) => item.submenu?.some((entry) => entry.accelerator === 'CmdOrCtrl+Shift+H')));
});

test('custom remote connection saves a profile, loads the target and trims the remote status', async () => {
  const { app, electron, win, launcher } = await boot();
  const result = await electron.ipcMain.invoke('desktop:connect-custom-remote', launcher(), REMOTE_URL);
  assert.equal(result.mode, 'connected');
  assert.equal(result.target, REMOTE_URL);
  assert.equal(win.loads.at(-1).url, REMOTE_URL);
  const profiles = app.ctx.connection.listProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, '203.0.113.10');
  assert.equal(profiles[0].edition, 'team');
  const remote = ipcEvent(win, `${REMOTE_URL}/console`);
  const status = await electron.ipcMain.invoke('desktop:get-status', remote);
  assert.equal(status.edition, 'team');
  assert.equal('localServer' in status, false);
  await assert.rejects(electron.ipcMain.invoke('desktop:rename-profile', remote, profiles[0].id, 'x'), /不可信/);
  const pushed = win.webContents.sent.filter((item) => item.channel === 'desktop:status');
  assert.ok(pushed.length > 0);
  assert.equal('localServer' in pushed.at(-1).payload, false, '推送给远程页面的状态必须裁剪');
  await electron.ipcMain.invoke('desktop:open-launcher', remote);
  assert.equal(app.state.mode, 'idle');
  assert.equal(app.state.target, null);
  assert.equal(win.loads.at(-1).type, 'file');
});

test('remote failure moves to the error state, keeps launcher trust and supports retry', async () => {
  let attempts = 0;
  const { app, electron, launcher } = await boot({ fetchImpl: async () => { attempts += 1; return attempts === 1 ? { ok: false, status: 503, headers: {}, json: async () => ({}) } : ok(TEAM); } });
  await assert.rejects(electron.ipcMain.invoke('desktop:connect-custom-remote', launcher(), REMOTE_URL), /503/);
  assert.equal(app.state.mode, 'error');
  assert.equal(app.state.target, null);
  assert.deepEqual(app.state.error.retry, { action: 'custom', payload: { url: `${REMOTE_URL}/` } });
  assert.equal(app.ctx.connection.listProfiles().length, 0, '失败不得写入 profile');
  const retried = await electron.ipcMain.invoke('desktop:retry', launcher());
  assert.equal(retried.mode, 'connected');
  assert.equal(attempts, 2);
});

test('local mode starts the server once, injects the token header and can be reused after returning to the launcher', async () => {
  const { app, electron, win, managers, launcher } = await boot();
  await assert.rejects(electron.ipcMain.invoke('desktop:start-local', launcher()), /用户名/);
  const result = await electron.ipcMain.invoke('desktop:start-local', launcher(), '  Ada ');
  assert.equal(result.mode, 'connected');
  assert.equal(result.runtime, 'desktop-local');
  assert.equal(result.localServer.pid, 777);
  assert.equal(win.loads.at(-1).url, `${LOCAL_BASE}/console`);
  assert.equal(managers.length, 1);
  assert.equal(managers[0].options.displayName, 'Ada');
  assert.equal(managers[0].options.runtime, 'desktop-local');
  const listener = electron.session.defaultSession.webRequest.headerListeners.at(-1);
  assert.deepEqual(listener.filter, { urls: [`${LOCAL_BASE}/*`] });
  let headers;
  listener.fn({ requestHeaders: { accept: 'x' } }, (out) => { headers = out.requestHeaders; });
  assert.equal(headers['x-crewrouter-desktop-token'], 'local-token');
  assert.equal(app.state.localProfile.displayName, 'Ada');
  const local = ipcEvent(win, `${LOCAL_BASE}/console`);
  const settings = await electron.ipcMain.invoke('desktop:get-settings', local);
  assert.equal(settings.local.ready, true);
  assert.equal(settings.profiles[0].displayName, 'Ada');
  await electron.ipcMain.invoke('desktop:open-launcher', local);
  assert.equal(app.state.target, null);
  assert.equal(app.state.localServer.ready, true, '返回启动页不停止本地服务');
  const again = await electron.ipcMain.invoke('desktop:start-local', launcher());
  assert.equal(again.mode, 'connected');
  assert.equal(managers.length, 1, '已运行的本地服务被复用');
  assert.equal(managers[0].started, 1);
  await electron.ipcMain.invoke('desktop:stop-local', ipcEvent(win, `${LOCAL_BASE}/console`));
  assert.equal(managers[0].stopped, 1);
  assert.equal(app.state.localServer.ready, false);
  assert.equal(win.loads.at(-1).type, 'file');
});

test('local start failure and unexpected exit both land in the error state with a local retry', async () => {
  const failing = await boot({ failStart: true });
  await assert.rejects(failing.electron.ipcMain.invoke('desktop:start-local', failing.launcher(), 'Ada'), /initdb exploded/);
  assert.equal(failing.app.state.mode, 'error');
  assert.deepEqual(failing.app.state.error.retry, { action: 'local', payload: { displayName: 'Ada' } });
  assert.equal(failing.managers[0].stopped, 1);
  assert.equal(failing.app.ctx.local, null);

  const { app, electron, win, managers, launcher } = await boot();
  await electron.ipcMain.invoke('desktop:start-local', launcher(), 'Ada');
  managers[0].crash();
  await sleep(20);
  assert.equal(app.state.mode, 'error');
  assert.match(app.state.error.message, /意外退出/);
  assert.equal(app.state.target, null);
  assert.equal(win.loads.at(-1).type, 'file');
  assert.equal(app.state.localServer.ready, false);
});

test('official login can be started from the launcher and cancelled', async () => {
  const { app, electron, launcher } = await boot();
  const status = await electron.ipcMain.invoke('desktop:open-official-login', launcher());
  assert.equal(status.mode, 'awaiting-official-login');
  assert.match(electron.shell.opened[0], /^https:\/\/crewrouter\.bloret\.net\/store\?helper_login=1/);
  await assert.rejects(electron.ipcMain.invoke('desktop:connect-custom-remote', launcher(), REMOTE_URL), /正在进行/);
  const cancelled = await electron.ipcMain.invoke('desktop:cancel-pending', launcher());
  assert.equal(cancelled.mode, 'idle');
  assert.equal(app.ctx.officialLogin.isPending(), false);
});

test('deep links only prefill the custom address', async () => {
  const { app, win } = await boot();
  assert.equal(app.actions.handleProtocol('crewrouter://connect?serverUrl=https%3A%2F%2Frouter.example'), true);
  assert.deepEqual(app.state.prefill, { serverUrl: 'https://router.example' });
  assert.equal(app.state.mode, 'idle');
  assert.equal(win.loads.filter((load) => load.type === 'url').length, 0);
  assert.equal(app.actions.handleProtocol('https://evil.example'), false);
});

test('preferences drive native theme, language, menu and are persisted', async () => {
  const { app, electron, launcher } = await boot();
  assert.equal(app.state.language, 'zh');
  const saved = await electron.ipcMain.invoke('desktop:save-settings', launcher(), { theme: 'light', language: 'en', autoConnect: false });
  assert.equal(saved.theme, 'light');
  assert.equal(electron.nativeTheme.themeSource, 'light');
  assert.equal(app.state.language, 'en');
  assert.ok(electron.Menu.template.some((item) => item.label === 'File'));
  assert.equal(app.ctx.connection.store.getSettings().autoConnect, false);
  const diagnostics = await electron.ipcMain.invoke('desktop:get-diagnostics', launcher());
  assert.equal(diagnostics.app, 'CrewRouter Desktop');
  assert.doesNotMatch(JSON.stringify(diagnostics), /token|cookie|password/i);
});

test('profiles cannot be deleted while connected and auto connect restores the last local profile', async () => {
  const first = await boot();
  await first.electron.ipcMain.invoke('desktop:start-local', first.launcher(), 'Ada');
  const local = ipcEvent(first.win, `${LOCAL_BASE}/console`);
  const [profile] = first.app.ctx.connection.listProfiles();
  await assert.rejects(first.electron.ipcMain.invoke('desktop:delete-profile', local, profile.id), /不能删除/);

  const electron = createElectronStub({ userData: first.userData });
  const managers = [];
  const app = createApp({ electron, userData: first.userData, env: {}, logger: silentLogger, fetchImpl: async (url) => (String(url).startsWith(LOCAL_BASE) ? ok(LOCAL) : ok(TEAM)), localManagerFactory: (options) => { const manager = new FakeLocalManager(options); managers.push(manager); return manager; } });
  await app.init();
  assert.equal(app.state.mode, 'connected');
  assert.equal(managers[0].options.displayName, 'Ada');
  assert.equal(managers[0].options.localIdentityId, profile.localIdentityId, '本地身份在重启后保持稳定');
});
