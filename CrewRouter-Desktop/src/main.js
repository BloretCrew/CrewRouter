'use strict';

const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { LocalServerManager } = require('./server-manager');
const { ConnectionManager } = require('./connection-manager');
const { ProfileStore } = require('./profile-store');
const { RedirectFlow } = require('./redirect-flow');
const { validateRemoteUrl } = require('./url-policy');

let electron;
try { electron = require('electron'); } catch { electron = null; }

const DEMO_URL = process.env.CREWROUTER_DEMO_URL || '';
const rendererEntry = path.join(__dirname, 'renderer', 'index.html');
const state = { mainWindow: null, currentTarget: null, mode: 'connect', instance: null, local: null, quitting: false };
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
  return { mode: state.mode, target: state.currentTarget, edition: state.instance?.edition || null, capabilities: state.instance?.capabilities || {}, protocolVersion: state.instance?.protocolVersion || null, profile: state.instance?.profile || null };
}

async function connect(url, { local = false, name = local ? '本地 CrewRouter' : 'CrewRouter' } = {}) {
  sendStatus({ message: local ? '正在读取本地服务信息…' : '正在检查远程服务器…' });
  const profile = await state.connection.connect({ url, mode: local ? 'local' : 'remote', allowLocalhost: local, name });
  state.currentTarget = new URL(profile.url).origin;
  state.mode = local ? 'local' : 'remote';
  state.instance = { ...profile, profile: { id: profile.id, name: profile.name, lastConnectedAt: profile.lastConnectedAt } };
  await state.mainWindow.loadURL(state.currentTarget);
  sendStatus({ message: `${profile.edition} Server 已连接`, ...currentStatus() });
  return currentStatus();
}

async function startLocal() {
  if (state.local) await state.local.stop();
  state.local = new LocalServerManager({
    mode: electron.app.isPackaged ? 'packaged' : 'development',
    serverRoot: process.env.CREWROUTER_SERVER_ROOT,
    resourceRoot: electron.app.isPackaged ? path.join(process.resourcesPath, 'server') : undefined,
    userData: electron.app.getPath('userData'),
    demo: true,
  });
  sendStatus({ message: '正在启动本地服务…' });
  const localStatus = await state.local.start();
  return connect(localStatus.baseUrl, { local: true });
}

async function handleProtocol(raw) {
  try {
    const callback = await redirectFlow.parseCallback(raw);
    await connect(callback.serverUrl, { name: '协议连接' });
  } catch (error) { sendStatus({ error: error.message }); }
}

function isRendererFrame(event) {
  return Boolean(state.mainWindow && event.sender === state.mainWindow.webContents && event.senderFrame?.url === `file://${rendererEntry}` && !state.currentTarget);
}
function allowedNavigation(target) {
  try {
    const url = new URL(target);
    if (url.protocol === 'file:') return url.pathname === rendererEntry && !state.currentTarget;
    return Boolean(state.currentTarget && url.origin === state.currentTarget);
  } catch { return false; }
}
async function openSafeExternal(raw) {
  const result = await validateRemoteUrl(raw);
  if (!result.ok) fail(result.error);
  return electron.shell.openExternal(result.url.toString());
}
function createWindow() {
  state.mainWindow = new electron.BrowserWindow({ width: 960, height: 700, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  state.mainWindow.webContents.setWindowOpenHandler(({ url }) => { openSafeExternal(url).catch((error) => sendStatus({ error: error.message })); return { action: 'deny' }; });
  state.mainWindow.webContents.on('will-navigate', (event, url) => { if (allowedNavigation(url)) return; event.preventDefault(); openSafeExternal(url).catch((error) => sendStatus({ error: error.message })); });
  state.mainWindow.loadFile(rendererEntry);
}
function registerIpc() {
  const { ipcMain } = electron;
  ipcMain.handle('desktop:get-status', (event) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); return currentStatus(); });
  ipcMain.handle('desktop:choose-mode', async (event, requested) => { if (!isRendererFrame(event) || requested !== 'local') fail('不支持的模式'); return startLocal(); });
  ipcMain.handle('desktop:connect-remote', async (event, url) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); return connect(url); });
  ipcMain.handle('desktop:open-external', async (event, url) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); return openSafeExternal(url); });
  ipcMain.handle('desktop:list-profiles', (event) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); return state.connection.listProfiles(); });
  ipcMain.handle('desktop:switch-profile', async (event, id) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); const profile = state.connection.activeProfile(); if (!profile || profile.id !== id) state.connection.switchProfile(id); const active = state.connection.activeProfile(); return connect(active.url, { name: active.name }); });
  ipcMain.handle('desktop:restart-local', async (event) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); return startLocal(); });
  ipcMain.handle('desktop:quit', (event) => { if (!isRendererFrame(event)) fail('IPC 来源不可信'); electron.app.quit(); });
}
function bootstrap() {
  const gotLock = electron.app.requestSingleInstanceLock();
  if (!gotLock) return electron.app.quit();
  electron.app.on('second-instance', (_event, argv) => { const protocolArg = argv.find((arg) => arg.startsWith('crewrouter://')); if (protocolArg) handleProtocol(protocolArg); });
  electron.app.whenReady().then(() => {
    state.connection = new ConnectionManager({ store: new ProfileStore(path.join(electron.app.getPath('userData'), 'profiles.json')), fetchImpl: requestFetch });
    registerIpc(); electron.app.setAsDefaultProtocolClient('crewrouter'); createWindow();
    const protocolArg = process.argv.find((value) => value.startsWith('crewrouter://'));
    if (protocolArg) handleProtocol(protocolArg);
    if (DEMO_URL) { const redirect = redirectFlow.buildDemoUrl(DEMO_URL, { metadata: { source: 'demo' } }); electron.shell.openExternal(redirect.url).catch(() => {}); }
  });
  electron.app.on('before-quit', (event) => { if (state.local && !state.quitting) { event.preventDefault(); state.quitting = true; state.local.stop().finally(() => electron.app.quit()); } });
}

if (electron?.app) bootstrap();

module.exports = { allowedNavigation, handleProtocol, createDemoState: (metadata) => redirectFlow.createState(metadata), currentStatus };
