'use strict';

const { fileURLToPath } = require('node:url');
const { sameFile } = require('./ipc');

const ABORTED = (error) => error?.code === 'ERR_ABORTED' || error?.errno === -3;

// 导航白名单：启动页只允许自身文件；连接后只允许当前目标 origin。
function allowedNavigation(target, { state, rendererEntry }) {
  try {
    const url = new URL(target);
    if (url.protocol === 'file:') return !state.target && sameFile(fileURLToPath(url), rendererEntry);
    return Boolean(state.target && url.origin === state.target);
  } catch { return false; }
}

function backgroundColorFor(theme, nativeTheme) {
  const dark = theme === 'dark' || (theme !== 'light' && Boolean(nativeTheme?.shouldUseDarkColors));
  return dark ? '#17161C' : '#FAFAF9';
}

function createMainWindow({ electron, state, rendererEntry, preloadPath, env = process.env, logger = console, onLoadFailed, openSafeExternal }) {
  const width = Number(env.CREWROUTER_WINDOW_WIDTH) || 1024;
  const height = Number(env.CREWROUTER_WINDOW_HEIGHT) || 720;
  const win = new electron.BrowserWindow({
    width,
    height,
    minWidth: 720,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: backgroundColorFor(state.theme, electron.nativeTheme),
    title: 'CrewRouter Desktop',
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const contents = win.webContents;
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    logger.error(`[renderer] load failed (${errorCode}) ${errorDescription} ${validatedURL}`);
    onLoadFailed?.({ errorCode, errorDescription, url: validatedURL });
  });
  contents.on('render-process-gone', (_event, details) => { logger.error(`[renderer] render process gone: ${details.reason}`); });
  contents.on('console-message', (_event, level, message, line, sourceId) => { if (level >= 2) logger.error(`[renderer:${level}] ${message} (${sourceId}:${line})`); });
  contents.setWindowOpenHandler(({ url }) => { openSafeExternal(url).catch((error) => logger.warn(`[window-open] ${error.message}`)); return { action: 'deny' }; });
  contents.on('will-navigate', (event, url) => {
    if (allowedNavigation(url, { state, rendererEntry })) return;
    event.preventDefault();
    openSafeExternal(url).catch((error) => logger.warn(`[navigate] ${error.message}`));
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());

  async function loadLauncher() {
    if (win.isDestroyed()) return;
    try { await win.loadFile(rendererEntry); } catch (error) { if (!ABORTED(error)) throw error; }
  }
  async function loadTarget(url) {
    if (win.isDestroyed()) throw new Error('主窗口已关闭');
    try { await win.loadURL(url); } catch (error) { if (!ABORTED(error)) throw error; }
  }
  function currentUrl() { try { return win.isDestroyed() ? '' : contents.getURL(); } catch { return ''; } }
  function send(channel, payload) { if (!win.isDestroyed()) contents.send(channel, payload); }
  function focus() { if (win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.focus(); }

  return { win, loadLauncher, loadTarget, currentUrl, send, focus };
}

module.exports = { createMainWindow, allowedNavigation, backgroundColorFor };
