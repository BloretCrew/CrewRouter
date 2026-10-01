'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const TRUST = Object.freeze({ LAUNCHER: 'launcher', LOCAL_CONSOLE: 'localConsole', REMOTE_CONSOLE: 'remoteConsole' });

// 每个 channel 允许的调用来源；未登记的 channel 一律拒绝。
const ALLOW = Object.freeze({
  'desktop:get-status': ['launcher', 'localConsole', 'remoteConsole'],
  'desktop:open-launcher': ['launcher', 'localConsole', 'remoteConsole'],
  'desktop:start-local': ['launcher'],
  'desktop:connect-custom-remote': ['launcher'],
  'desktop:open-official-login': ['launcher'],
  'desktop:reopen-official-login': ['launcher'],
  'desktop:cancel-pending': ['launcher'],
  'desktop:clear-error': ['launcher'],
  'desktop:retry': ['launcher'],
  'desktop:open-external': ['launcher', 'localConsole'],
  'desktop:list-profiles': ['launcher', 'localConsole'],
  'desktop:switch-profile': ['launcher', 'localConsole'],
  'desktop:rename-profile': ['launcher', 'localConsole'],
  'desktop:delete-profile': ['launcher', 'localConsole'],
  'desktop:get-settings': ['launcher', 'localConsole'],
  'desktop:save-settings': ['launcher', 'localConsole'],
  'desktop:restart-local': ['launcher', 'localConsole'],
  'desktop:stop-local': ['launcher', 'localConsole'],
  'desktop:open-logs': ['launcher', 'localConsole'],
  'desktop:get-diagnostics': ['launcher', 'localConsole', 'remoteConsole'],
  'desktop:quit': ['launcher', 'localConsole', 'remoteConsole'],
  'desktop:restart-app': ['launcher', 'localConsole', 'remoteConsole'],
});

function sameFile(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// 判定 IPC 调用来源的信任级别；任何无法判定的来源返回 null。
function classifySender(event, { mainWindow, rendererEntry, state }) {
  const contents = mainWindow && !(typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed()) ? mainWindow.webContents : null;
  if (!contents || !event || event.sender !== contents) return null;
  const frame = event.senderFrame;
  if (!frame || frame.isMainFrame === false) return null;
  let url;
  try { url = new URL(frame.url || ''); } catch { return null; }
  if (url.protocol === 'file:') {
    let framePath;
    try { framePath = fileURLToPath(url); } catch { return null; }
    // 启动页是应用自带文件，远程内容无法把主帧导航到 file://，因此主窗口主帧只要是启动页文件即受信。
    return sameFile(framePath, rendererEntry) ? TRUST.LAUNCHER : null;
  }
  if (!state.target || url.origin !== state.target) return null;
  return state.instance?.runtime === 'desktop-local' ? TRUST.LOCAL_CONSOLE : TRUST.REMOTE_CONSOLE;
}

function audienceOf(trust) { return trust === TRUST.REMOTE_CONSOLE ? 'remoteConsole' : 'launcher'; }

function registerIpc({ ipcMain, ctx, actions }) {
  const guard = (channel, handler) => {
    if (!ALLOW[channel]) throw new Error(`IPC channel 未登记：${channel}`);
    ipcMain.handle(channel, async (event, ...args) => {
      const trust = classifySender(event, ctx);
      if (!trust || !ALLOW[channel].includes(trust)) throw new Error('IPC 来源不可信');
      return handler({ trust, event }, ...args);
    });
  };
  const state = ctx.state;
  const snapshot = (trust) => state.snapshot(audienceOf(trust));

  guard('desktop:get-status', ({ trust }) => snapshot(trust));
  guard('desktop:open-launcher', async ({ trust }) => { await actions.showLauncher(); return snapshot(trust); });
  guard('desktop:start-local', async (_meta, displayName) => actions.startLocal({ displayName: typeof displayName === 'string' ? displayName : undefined }));
  guard('desktop:connect-custom-remote', async (_meta, url) => actions.connectCustom(String(url || '')));
  guard('desktop:open-official-login', async () => actions.openOfficialLogin());
  guard('desktop:reopen-official-login', async ({ trust }) => { await actions.reopenOfficialLogin(); return snapshot(trust); });
  guard('desktop:cancel-pending', async ({ trust }) => { await actions.cancelPending(); return snapshot(trust); });
  guard('desktop:clear-error', ({ trust }) => { if (state.mode === 'error') state.reset(); return snapshot(trust); });
  guard('desktop:retry', async () => actions.retry());
  guard('desktop:open-external', async (_meta, url) => actions.openSafeExternal(String(url || '')));
  guard('desktop:list-profiles', () => ctx.connection.listProfiles());
  guard('desktop:switch-profile', async (_meta, id) => actions.switchProfile(String(id || '')));
  guard('desktop:rename-profile', (_meta, id, name) => { ctx.connection.store.rename(String(id || ''), name); return ctx.connection.listProfiles(); });
  guard('desktop:delete-profile', (_meta, id) => actions.deleteProfile(String(id || '')));
  guard('desktop:get-settings', ({ trust }) => ({ status: snapshot(trust), profiles: ctx.connection.listProfiles(), settings: ctx.connection.store.getSettings(), local: ctx.local?.getStatus() || null }));
  guard('desktop:save-settings', (_meta, settings) => actions.saveSettings(settings));
  guard('desktop:restart-local', async () => actions.restartLocal());
  guard('desktop:stop-local', async ({ trust }) => { await actions.stopLocal(); return snapshot(trust); });
  guard('desktop:open-logs', async () => actions.openLogs());
  guard('desktop:get-diagnostics', ({ trust }) => actions.diagnostics(audienceOf(trust)));
  guard('desktop:quit', () => { ctx.electron.app.quit(); });
  guard('desktop:restart-app', () => { ctx.electron.app.relaunch(); ctx.electron.app.exit(0); });
}

module.exports = { registerIpc, classifySender, ALLOW, TRUST, sameFile };
