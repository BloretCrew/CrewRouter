'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { classifySender, ALLOW, TRUST, registerIpc } = require('../src/app/ipc');
const { AppState } = require('../src/app/state');

const rendererEntry = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const launcherUrl = pathToFileURL(rendererEntry).href;

function makeCtx() {
  const webContents = {};
  const mainWindow = { webContents, isDestroyed: () => false };
  const state = new AppState();
  return { ctx: { mainWindow, rendererEntry, state }, webContents, state };
}
const frame = (sender, url, isMainFrame = true) => ({ sender, senderFrame: { url, isMainFrame } });

test('launcher main frame is trusted; other files, subframes and foreign contents are not', () => {
  const { ctx, webContents, state } = makeCtx();
  assert.equal(classifySender(frame(webContents, launcherUrl), ctx), TRUST.LAUNCHER);
  assert.equal(classifySender(frame(webContents, launcherUrl + '?x=1'), ctx), TRUST.LAUNCHER);
  assert.equal(classifySender(frame({}, launcherUrl), ctx), null, '其他 webContents 不受信');
  assert.equal(classifySender(frame(webContents, pathToFileURL('/tmp/other.html').href), ctx), null);
  assert.equal(classifySender(frame(webContents, launcherUrl, false), ctx), null, '子帧不受信');
  assert.equal(classifySender({ sender: webContents, senderFrame: null }, ctx), null);
  state.set({ target: 'https://team.example', instance: { runtime: 'server' } });
  assert.equal(classifySender(frame(webContents, launcherUrl), ctx), TRUST.LAUNCHER, '连接进行中启动页仍可取消/查看状态');
});

test('connected consoles are classified by origin and runtime', () => {
  const { ctx, webContents, state } = makeCtx();
  assert.equal(classifySender(frame(webContents, 'https://team.example/console'), ctx), null, '未连接时任何 http 帧都不受信');
  state.set({ target: 'https://team.example', instance: { runtime: 'server', edition: 'team' } });
  assert.equal(classifySender(frame(webContents, 'https://team.example/console#x'), ctx), TRUST.REMOTE_CONSOLE);
  assert.equal(classifySender(frame(webContents, 'https://evil.example/console'), ctx), null);
  assert.equal(classifySender(frame(webContents, 'http://team.example/console'), ctx), null, '协议不同即不同 origin');
  state.set({ target: 'http://127.0.0.1:4321', instance: { runtime: 'desktop-local', edition: 'personal' } });
  assert.equal(classifySender(frame(webContents, 'http://127.0.0.1:4321/console'), ctx), TRUST.LOCAL_CONSOLE);
  assert.equal(classifySender(frame(webContents, 'http://127.0.0.1:4322/console'), ctx), null);
});

test('allow matrix keeps profiles and settings away from remote consoles', () => {
  for (const [channel, audiences] of Object.entries(ALLOW)) {
    assert.ok(audiences.includes('launcher'), `${channel} 必须允许启动页`);
  }
  const remoteOnly = Object.entries(ALLOW).filter(([, audiences]) => audiences.includes('remoteConsole')).map(([channel]) => channel).sort();
  assert.deepEqual(remoteOnly, ['desktop:get-diagnostics', 'desktop:get-status', 'desktop:open-launcher', 'desktop:quit', 'desktop:restart-app']);
  for (const channel of ['desktop:list-profiles', 'desktop:rename-profile', 'desktop:delete-profile', 'desktop:get-settings', 'desktop:save-settings', 'desktop:stop-local', 'desktop:restart-local', 'desktop:open-external']) {
    assert.ok(!ALLOW[channel].includes('remoteConsole'), `${channel} 不得暴露给远程页面`);
  }
});

test('registered handlers reject untrusted senders before touching actions', async () => {
  const { ctx, webContents, state } = makeCtx();
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  let quitCalls = 0;
  ctx.electron = { app: { quit: () => { quitCalls += 1; }, relaunch() {}, exit() {} } };
  ctx.connection = { listProfiles: () => [{ id: 'a', name: 'A', url: 'https://a.example' }], store: { rename() {}, getSettings: () => ({}) } };
  const calls = [];
  registerIpc({ ipcMain, ctx, actions: { showLauncher: async () => calls.push('launcher'), diagnostics: (audience) => ({ audience }), saveSettings: () => ({}), deleteProfile: () => [] } });
  assert.equal(handlers.size, Object.keys(ALLOW).length);
  await assert.rejects(handlers.get('desktop:get-status')(frame({}, launcherUrl)), /不可信/);
  assert.equal((await handlers.get('desktop:get-status')(frame(webContents, launcherUrl))).mode, 'idle');
  state.set({ target: 'https://team.example', instance: { runtime: 'server', edition: 'team' } });
  const remote = frame(webContents, 'https://team.example/console');
  await assert.rejects(handlers.get('desktop:list-profiles')(remote), /不可信/);
  await assert.rejects(handlers.get('desktop:get-settings')(remote), /不可信/);
  assert.deepEqual(await handlers.get('desktop:get-diagnostics')(remote), { audience: 'remoteConsole' });
  const status = await handlers.get('desktop:get-status')(remote);
  assert.equal('localServer' in status, false);
  await handlers.get('desktop:open-launcher')(remote);
  assert.deepEqual(calls, ['launcher']);
  await handlers.get('desktop:quit')(remote);
  assert.equal(quitCalls, 1);
});
