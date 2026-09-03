'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { LocalServerManager } = require('./server-manager');
const { ConnectionManager } = require('./connection-manager');
const { ProfileStore, validateLocalDisplayName } = require('./profile-store');
const { RedirectFlow } = require('./redirect-flow');
const { validateRemoteUrl } = require('./url-policy');

let electron;
try { electron = require('electron'); } catch { electron = null; }

const DEMO_URL = process.env.CREWROUTER_DEMO_URL || 'https://crewrouter.bloret.net';
const rendererEntry = path.join(__dirname, 'renderer', 'index.html');
const settingsEntry = path.join(__dirname, 'renderer', 'settings.html');
const state = { mainWindow: null, settingsWindow: null, currentTarget: null, mode: 'connect', instance: null, local: null, connection: null, quitting: false, localProfile: null, localIdentityId: null };
const redirectFlow = new RedirectFlow();

function requestFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === 'https:' ? https : http).get(target, { headers: options.headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => JSON.parse(body) }));
    });
    request.setTimeout(8000, () => request.destroy(new Error('连接超时')));
    request.once('error', reject);
  });
}

function sendStatus(payload) { state.mainWindow?.webContents.send('desktop:status', payload); }
function fail(message) { throw new Error(message); }
function currentStatus() {
  const active = state.connection?.activeProfile() || null;
  const localProfile = state.localProfile || (active?.mode === 'local' ? active : null);
  const needsLocalProfile = state.mode === 'connect' && (!active || (active.mode === 'local' && !active.displayName));
  const localStatus = state.local?.getStatus?.() || null;
  return { mode: state.mode, target: state.currentTarget, runtime: state.instance?.runtime || localStatus?.runtime || null, edition: state.instance?.edition || localStatus?.edition || null, auth: state.instance?.auth || localStatus?.auth || null, demo: state.instance?.demo ?? localStatus?.demo ?? null, capabilities: state.instance?.capabilities || localStatus?.capabilities || {}, protocolVersion: state.instance?.protocolVersion || null, profile: state.instance?.profile || null, localProfile: localProfile ? { id: localProfile.id, displayName: localProfile.displayName || null, localIdentityId: localProfile.localIdentityId || null } : null, needsLocalProfile };
}

async function connect(url, { local = false, name = local ? '本地 CrewRouter' : 'CrewRouter', id, displayName, localIdentityId } = {}) {
  sendStatus({ message: local ? '正在读取本地服务信息…' : '正在检查远程服务器…' });
  const profile = await state.connection.connect({ id, url, mode: local ? 'local' : 'remote', allowLocalhost: local, name, displayName, localIdentityId });
  state.currentTarget = new URL(profile.url).origin;
  state.mode = local ? 'local' : 'remote';
  state.instance = { ...profile, profile: { id: profile.id, name: profile.name, lastConnectedAt: profile.lastConnectedAt } };
  try {
    await state.mainWindow.loadURL(local ? `${state.currentTarget}/console` : state.currentTarget);
    if (local) await state.mainWindow.webContents.executeJavaScript(`(() => { let button = document.getElementById('desktop-settings'); if (!button) { button = document.createElement('button'); button.id = 'desktop-settings'; button.type = 'button'; button.textContent = '⚙ Desktop 设置'; Object.assign(button.style, { position: 'fixed', top: '12px', right: '16px', zIndex: '2147483647', padding: '8px 12px', borderRadius: '8px', border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' }); document.body.appendChild(button); } button.onclick = () => window.crewrouterDesktop?.openSettings?.(); })()`, true);
  } catch (error) {
    // A redirect can supersede the initial navigation after the target is already loaded.
    if (error?.code !== 'ERR_ABORTED' && error?.errno !== -3) throw error;
  }
  sendStatus({ message: `${profile.edition} Server 已连接`, ...currentStatus() });
  if (local) createSettingsWindow();
  return currentStatus();
}

async function startRemoteRedirect(rawTarget) {
  if (!DEMO_URL) fail('未配置官方 Demo 转向地址（CREWROUTER_DEMO_URL）。');
  const target = await validateRemoteUrl(rawTarget);
  if (!target.ok) fail(`目标服务器地址无效：${target.error}`);
  const inspected = await state.connection.inspect(target.url.toString());
  const demo = await validateRemoteUrl(DEMO_URL);
  if (!demo.ok) fail(`官方 Demo 地址无效：${demo.error}`);
  const metadata = { source: 'demo', serverUrl: inspected.url, targetOrigin: new URL(inspected.url).origin, runtime: inspected.runtime, edition: inspected.edition };
  const redirect = redirectFlow.buildDemoUrl(demo.url.toString(), { metadata, target: inspected.url });
  sendStatus({ message: '正在打开官方 Demo 转向入口…', redirect: true, target: metadata.targetOrigin });
  await electron.shell.openExternal(redirect.url);
  return { ...currentStatus(), mode: 'redirecting', target: null };
}

async function connectCustomRemote(rawUrl) {
  const target = await validateRemoteUrl(rawUrl);
  if (!target.ok) fail(target.error);
  sendStatus({ message: '正在直接连接自定义服务器…', target: target.url.origin });
  return connect(target.url.toString(), { name: '自定义服务器' });
}

function localProfileStore() { return state.connection?.store; }

async function startLocal(displayName) {
  const active = localProfileStore()?.getActive();
  const profile = state.localProfile?.mode === 'local' ? state.localProfile : (active?.mode === 'local' ? active : null);
  const resolvedName = displayName || profile?.displayName;
  if (!resolvedName) fail('首次本地使用需要先设置用户名。');
  const localIdentityId = profile?.localIdentityId || crypto.randomUUID();
  if (state.local) await state.local.stop();
  state.local = new LocalServerManager({ mode: electron.app.isPackaged ? 'packaged' : 'development', serverRoot: undefined, resourceRoot: electron.app.isPackaged ? path.join(process.resourcesPath, 'server') : undefined, userData: electron.app.getPath('userData'), runtime: 'desktop-local', edition: 'personal', auth: { required: false, methods: ['local'] }, demo: false, localIdentityId, displayName: resolvedName });
  sendStatus({ message: '正在启动本地服务…' });
  try {
    const localStatus = await state.local.start();
    state.localIdentityId = localIdentityId;
    const connected = await connect(localStatus.baseUrl, { local: true, name: resolvedName, id: profile?.id || crypto.randomUUID(), displayName: resolvedName, localIdentityId });
    state.localProfile = connected.profile;
    return connected;
  } catch (error) {
    await state.local.stop().catch(() => {});
    state.local = null;
    throw error;
  }
}

async function handleProtocol(raw) {
  try {
    const callback = await redirectFlow.parseCallback(raw);
    sendStatus({ message: '已从官方 Demo 返回，正在验证目标服务器…' });
    await connect(callback.serverUrl, { name: '协议连接' });
  } catch (error) { sendStatus({ error: `远程转向失败：${error.message}` }); }
}

function getWindowWebPreferences() { return { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }; }
function isRendererFrame(event) {
  let framePath = '';
  try { const frameUrl = new URL(event.senderFrame?.url || ''); if (frameUrl.protocol === 'file:') framePath = decodeURIComponent(frameUrl.pathname); } catch {}
  let localConsole = false;
  try { localConsole = state.mode === 'local' && state.instance?.runtime === 'desktop-local' && new URL(event.senderFrame?.url || '').origin === state.currentTarget; } catch {}
  return Boolean(state.mainWindow && event.sender === state.mainWindow.webContents && (framePath === rendererEntry || localConsole) && (!state.currentTarget || localConsole));
}
function allowedNavigation(target) {
  try { const url = new URL(target); if (url.protocol === 'file:') return url.pathname === rendererEntry && !state.currentTarget; return Boolean(state.currentTarget && url.origin === state.currentTarget); } catch { return false; }
}
async function openSafeExternal(raw) {
  const result = await validateRemoteUrl(raw);
  if (!result.ok) fail(result.error);
  return electron.shell.openExternal(result.url.toString());
}
function createSettingsWindow() {
  if (state.settingsWindow && !state.settingsWindow.isDestroyed()) { state.settingsWindow.focus(); return; }
  state.settingsWindow = new electron.BrowserWindow({ width: 760, height: 720, minWidth: 600, webPreferences: { ...getWindowWebPreferences(), preload: path.join(__dirname, 'settings-preload.js') }, title: 'CrewRouter Desktop Settings' });
  state.settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  state.settingsWindow.webContents.on('will-navigate', (event, url) => { try { if (new URL(url).protocol !== 'file:' || decodeURIComponent(new URL(url).pathname) !== settingsEntry) event.preventDefault(); } catch { event.preventDefault(); } });
  state.settingsWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  state.settingsWindow.loadFile(settingsEntry);
  state.settingsWindow.on('closed', () => { state.settingsWindow = null; });
}
function createWindow() {
  const width = Number(process.env.CREWROUTER_WINDOW_WIDTH) || 960;
  const height = Number(process.env.CREWROUTER_WINDOW_HEIGHT) || 700;
  state.mainWindow = new electron.BrowserWindow({ width, height, webPreferences: getWindowWebPreferences() });
  state.mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    const message = `启动页面加载失败（${errorCode}）：${errorDescription}`;
    console.error(`[renderer] ${message} ${validatedURL}`);
    const safeMessage = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    state.mainWindow.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(`<main class="blora-load-error"><h1>CrewRouter Desktop</h1><p>${safeMessage}</p><p>请重启应用；如果问题持续，请查看应用日志。</p></main>`)}`, true).catch(() => {});
  });
  state.mainWindow.webContents.on('render-process-gone', (_event, details) => { console.error(`[renderer] render process gone: ${details.reason}`); });
  state.mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => { if (level >= 2) console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`); });
  state.mainWindow.webContents.setWindowOpenHandler(({ url }) => { openSafeExternal(url).catch((error) => sendStatus({ error: error.message })); return { action: 'deny' }; });
  state.mainWindow.webContents.on('will-navigate', (event, url) => { if (allowedNavigation(url)) return; event.preventDefault(); openSafeExternal(url).catch((error) => sendStatus({ error: error.message })); });
  state.mainWindow.loadFile(rendererEntry);
}
function registerIpc() {
  const { ipcMain } = electron;
  ipcMain.handle('desktop:get-status', (event) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); return currentStatus(); });
  ipcMain.handle('desktop:choose-mode', async (event, requested) => { if (!isRendererFrame(event) || requested !== 'local') fail('不支持的模式'); return startLocal(); });
  ipcMain.handle('desktop:setup-local-profile', async (event, displayName) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); const result = validateLocalDisplayName(displayName); if (!result.ok) fail(result.error); return startLocal(result.value); });
  ipcMain.handle('desktop:connect-remote', async (event, url) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); return startRemoteRedirect(url); });
  ipcMain.handle('desktop:connect-custom-remote', async (event, url) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); return connectCustomRemote(url); });
  ipcMain.handle('desktop:open-external', async (event, url) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); return openSafeExternal(url); });
  ipcMain.handle('desktop:list-profiles', (event) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); return state.connection.listProfiles(); });
  ipcMain.handle('desktop:switch-profile', async (event, id) => {
    if (!isRendererFrame(event)) fail('IPC 来源不可信');
    const profile = state.connection.activeProfile();
    if (!profile || profile.id !== id) state.connection.switchProfile(id);
    const active = state.connection.activeProfile();
    if (!active) fail('profile 不存在');
    if (active.mode === 'local') return startLocal(active.displayName);
    return connect(active.url, { name: active.name });
  });
  const isSettingsFrame = (event) => Boolean(state.settingsWindow && event.sender === state.settingsWindow.webContents && event.senderFrame?.isMainFrame !== false && (() => { try { return new URL(event.senderFrame?.url || '').protocol === 'file:' && decodeURIComponent(new URL(event.senderFrame.url).pathname) === settingsEntry; } catch { return false; } })());
  ipcMain.handle('desktop:restart-local', async (event) => { if (!isSettingsFrame(event)) fail('IPC 来源不可信'); return startLocal(); });
  ipcMain.handle('desktop:open-settings', (event) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); createSettingsWindow(); });

  ipcMain.handle('desktop:get-settings', (event) => { if (!isSettingsFrame(event)) fail('IPC 来源不可信'); return { status: currentStatus(), profiles: state.connection.listProfiles(), settings: state.connection.store.getSettings(), local: state.local?.getStatus() || null }; });
  ipcMain.handle('desktop:save-settings', (event, settings) => { if (!isSettingsFrame(event)) fail('IPC 来源不可信'); return state.connection.store.saveSettings(settings); });
  ipcMain.handle('desktop:rename-profile', (event, id, name) => { if (!isSettingsFrame(event)) fail('IPC 来源不可信'); return state.connection.store.rename(id, name); });
  ipcMain.handle('desktop:delete-profile', (event, id) => { if (!isSettingsFrame(event)) fail('IPC 来源不可信'); if (state.localProfile?.id === id || state.connection.activeProfile()?.id === id) fail('不能删除当前连接 profile'); return state.connection.store.remove(id); });
  ipcMain.handle('desktop:stop-local', async (event) => { if (!isSettingsFrame(event)) fail('IPC 来源不可信'); if (state.local) await state.local.stop(); state.local = null; state.mode = 'local'; return currentStatus(); });
  ipcMain.handle('desktop:get-diagnostics', (event) => { if (!isSettingsFrame(event)) fail('IPC 来源不可信'); const active = state.connection.activeProfile(); return { app: 'CrewRouter Desktop', version: electron.app.getVersion(), runtime: state.instance?.runtime || null, edition: state.instance?.edition || null, mode: state.mode, target: state.currentTarget, profileId: active?.id || null, localServer: Boolean(state.local?.getStatus().ready) }; });
  ipcMain.handle('desktop:quit', (event) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); electron.app.quit(); });
}
function bootstrap() {
  const gotLock = electron.app.requestSingleInstanceLock();
  if (!gotLock) return electron.app.quit();
  electron.app.on('second-instance', (_event, argv) => { const protocolArg = argv.find((arg) => arg.startsWith('crewrouter://')); if (protocolArg) handleProtocol(protocolArg); });
  electron.app.whenReady().then(() => {
    delete process.env.CREWROUTER_SERVER_ROOT;
    delete process.env.CREWROUTER_PACKAGED_SERVER_ROOT;
    state.connection = new ConnectionManager({ store: new ProfileStore(path.join(electron.app.getPath('userData'), 'profiles.json')), fetchImpl: requestFetch });
    if (!electron.ipcMain._crewrouterHandlersRegistered) {
      registerIpc();
      electron.ipcMain._crewrouterHandlersRegistered = true;
    }
    electron.app.setAsDefaultProtocolClient('crewrouter');
    const activeProfile = state.connection.activeProfile();
    if (activeProfile?.mode === 'local' && activeProfile.displayName) state.localProfile = activeProfile;
    createWindow();
    if (activeProfile?.mode === 'local' && activeProfile.displayName && state.connection.store.getSettings().autoConnect) startLocal(activeProfile.displayName).catch((error) => sendStatus({ error: `本地服务启动失败：${error.message}` }));
    const protocolArg = process.argv.find((value) => value.startsWith('crewrouter://'));
    if (protocolArg) handleProtocol(protocolArg);
  });
  electron.app.on('before-quit', (event) => { if (state.local && !state.quitting) { event.preventDefault(); state.quitting = true; state.local.stop().finally(() => electron.app.quit()); } });
}

if (electron?.app) bootstrap();

module.exports = { allowedNavigation, handleProtocol, createDemoState: (metadata) => redirectFlow.createState(metadata), currentStatus, startRemoteRedirect };
