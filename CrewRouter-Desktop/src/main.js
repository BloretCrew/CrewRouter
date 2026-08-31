'use strict';

const { app, BrowserWindow, shell, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const DEMO_URL = process.env.CREWROUTER_DEMO_URL || '';
let mainWindow;
let localProcess;
let currentTarget = null;
let mode = 'connect';
let pendingState = null;

function sendStatus(payload) { mainWindow?.webContents.send('desktop:status', payload); }
function error(message) { return new Error(message); }
function isLocal(url) { return /^http:\/\/127\.0\.0\.1:\d+$/.test(url) || /^http:\/\/localhost:\d+$/.test(url); }
function isPrivateHost(hostname) { return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname); }
function validateRemote(raw, allowLocal = false) {
  let url; try { url = new URL(raw); } catch { throw error('服务器地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw error('仅允许 http/https 地址');
  if (url.username || url.password || url.searchParams.has('token') || url.searchParams.has('key')) throw error('地址不得包含凭据');
  if (!allowLocal && isPrivateHost(url.hostname)) throw error('远程地址不得指向本机或内网地址');
  url.hash = '';
  return url.origin;
}
function requestJson(base, route) {
  return new Promise((resolve, reject) => {
    const target = new URL(route, base);
    const request = (target.protocol === 'https:' ? https : http).get(target, { timeout: 8000, headers: { Accept: 'application/json' } }, (response) => {
      let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { if (response.statusCode < 200 || response.statusCode >= 300) return reject(error(`服务器返回 HTTP ${response.statusCode}`)); try { resolve(JSON.parse(body)); } catch { reject(error('服务器响应不是有效 JSON')); } });
    });
    request.on('timeout', () => request.destroy(error('连接超时'))); request.on('error', reject);
  });
}
async function connect(url, local = false) {
  const target = validateRemote(url, local); sendStatus({ message: '正在读取服务器信息…' });
  const instance = await requestJson(target, '/api/instance');
  if (!instance || !['personal', 'team'].includes(instance.edition)) throw error('目标服务器未返回有效 Personal/Team edition');
  currentTarget = target; mode = local ? 'local' : 'remote';
  await mainWindow.loadURL(target); sendStatus({ message: `${instance.edition} Server 已连接` });
}
async function startLocal() {
  const root = process.env.CREWROUTER_SERVER_ROOT || path.resolve(__dirname, '..', 'server');
  const entry = path.join(root, 'server', 'index.js');
  const serverRoot = fs.existsSync(entry) ? root : path.join(process.resourcesPath, 'server');
  const serverEntry = fs.existsSync(path.join(serverRoot, 'server', 'index.js')) ? path.join(serverRoot, 'server', 'index.js') : path.join(serverRoot, 'index.js');
  const port = await new Promise((resolve, reject) => { const probe = http.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });
  const logDir = path.join(app.getPath('userData'), 'logs'); fs.mkdirSync(logDir, { recursive: true });
  const log = fs.createWriteStream(path.join(logDir, 'local-server.log'), { flags: 'a' });
  localProcess = spawn(process.execPath, [serverEntry], { cwd: serverRoot, env: { ...process.env, NODE_ENV: 'production', CR_RUNTIME: 'desktop-local', CR_EDITION: 'personal', CR_APP_HOST: '127.0.0.1', CR_APP_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  localProcess.stdout.pipe(log); localProcess.stderr.pipe(log); localProcess.once('exit', (code) => { if (mode === 'local') sendStatus({ error: `本地服务已退出（${code ?? 'unknown'}）` }); });
  for (let i = 0; i < 30; i += 1) { try { await requestJson(`http://127.0.0.1:${port}`, '/api/version'); return connect(`http://127.0.0.1:${port}`, true); } catch { await new Promise((resolve) => setTimeout(resolve, 500)); } }
  throw error('本地服务启动超时，请检查日志和 PostgreSQL 依赖');
}
function allowedNavigation(target) { try { const url = new URL(target); return currentTarget && url.origin === currentTarget && (mode !== 'local' || isLocal(target)); } catch { return false; } }
function handleProtocol(raw) { let parsed; try { parsed = new URL(raw); } catch { return; } if (!['crewrouter:'].includes(parsed.protocol)) return; const candidate = parsed.searchParams.get('serverUrl') || parsed.searchParams.get('redirect'); if (!candidate) return; try { pendingState = null; connect(validateRemote(candidate, false)); } catch (e) { sendStatus({ error: e.message }); } }
function createWindow() { mainWindow = new BrowserWindow({ width: 960, height: 700, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } }); mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (allowedNavigation(url)) return { action: 'allow' }; shell.openExternal(url); return { action: 'deny' }; }); mainWindow.webContents.on('will-navigate', (event, url) => { if (!allowedNavigation(url) && !url.startsWith('file://')) { event.preventDefault(); shell.openExternal(url); } }); mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')); }

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit(); else { app.on('second-instance', (_event, argv) => handleProtocol(argv.find((arg) => arg.startsWith('crewrouter://')))); app.whenReady().then(() => { app.setAsDefaultProtocolClient('crewrouter'); ipcMain.handle('desktop:get-status', () => ({ mode, target: currentTarget })); ipcMain.handle('desktop:choose-mode', async (_event, requested) => { if (requested !== 'local') throw error('不支持的模式'); return startLocal(); }); ipcMain.handle('desktop:connect-remote', (_event, url) => connect(url)); ipcMain.handle('desktop:open-external', (_event, url) => shell.openExternal(validateRemote(url, true))); ipcMain.handle('desktop:restart-local', async () => { if (localProcess) { localProcess.kill(); localProcess = null; } return startLocal(); }); ipcMain.handle('desktop:quit', () => app.quit()); createWindow(); const arg = process.argv.find((value) => value.startsWith('crewrouter://')); if (arg) handleProtocol(arg); }); app.on('before-quit', () => { if (localProcess && !localProcess.killed) localProcess.kill('SIGTERM'); }); }
