'use strict';

// Electron 假实现：覆盖主进程代码用到的 app / BrowserWindow / ipcMain / session / shell / nativeTheme / Menu。
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

class FakeWebContents extends EventEmitter {
  constructor(win) { super(); this.win = win; this.url = ''; this.sent = []; this.openHandler = null; }
  send(channel, payload) { this.sent.push({ channel, payload }); }
  getURL() { return this.url; }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  executeJavaScript() { return Promise.resolve(); }
}

class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents(this);
    this.destroyed = false;
    this.loads = [];
    this.shown = false;
    this.minimized = false;
    this.focused = false;
    this.loadBehavior = null;
    FakeBrowserWindow.instances.push(this);
  }
  isDestroyed() { return this.destroyed; }
  show() { this.shown = true; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; }
  focus() { this.focused = true; }
  async loadFile(file) { this.loads.push({ type: 'file', file }); this.webContents.url = pathToFileURL(file).href; }
  async loadURL(url) {
    this.loads.push({ type: 'url', url });
    if (this.loadBehavior) await this.loadBehavior(url, this);
    this.webContents.url = url;
  }
  destroy() { this.destroyed = true; this.emit('closed'); }
  static getAllWindows() { return FakeBrowserWindow.instances.filter((win) => !win.destroyed); }
}
FakeBrowserWindow.instances = [];

function createElectronStub({ userData }) {
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    quitCalls: 0,
    exitCode: null,
    relaunched: false,
    locale: 'zh-CN',
    protocolClients: [],
    getPath: (name) => (name === 'userData' ? userData : path.join(userData, name)),
    getVersion: () => '0.0.0-test',
    getLocale() { return this.locale; },
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient(scheme) { this.protocolClients.push(scheme); return true; },
    whenReady: () => Promise.resolve(),
    quit() { this.quitCalls += 1; this.emit('before-quit', { preventDefault() {} }); },
    exit(code) { this.exitCode = code; },
    relaunch() { this.relaunched = true; },
  });
  const handlers = new Map();
  const ipcMain = {
    handlers,
    handle: (channel, fn) => { if (handlers.has(channel)) throw new Error(`duplicate handler ${channel}`); handlers.set(channel, fn); },
    invoke: (channel, event, ...args) => { const fn = handlers.get(channel); if (!fn) throw new Error(`no handler for ${channel}`); return fn(event, ...args); },
  };
  const cookies = {
    store: new Map(),
    async set(cookie) { this.store.set(`${cookie.url}|${cookie.name}`, cookie); },
    async get({ url, name }) { const cookie = this.store.get(`${url}|${name}`); return cookie ? [cookie] : []; },
    async remove(url, name) { this.store.delete(`${url}|${name}`); },
  };
  const webRequest = { headerListeners: [], onBeforeSendHeaders(filter, fn) { this.headerListeners.push({ filter, fn }); } };
  const session = { defaultSession: { cookies, webRequest } };
  const shell = { opened: [], openedPaths: [], async openExternal(url) { this.opened.push(url); }, async openPath(target) { this.openedPaths.push(target); return ''; } };
  const nativeTheme = { themeSource: 'system', shouldUseDarkColors: true };
  const Menu = { template: null, applied: null, setApplicationMenu(menu) { Menu.applied = menu; }, buildFromTemplate(template) { Menu.template = template; return { template }; } };
  return { app, BrowserWindow: FakeBrowserWindow, ipcMain, session, shell, nativeTheme, Menu };
}

function ipcEvent(win, url, { isMainFrame = true } = {}) {
  return { sender: win.webContents, senderFrame: { url, isMainFrame } };
}

const silentLogger = { info() {}, warn() {}, error() {}, log() {} };

module.exports = { createElectronStub, FakeBrowserWindow, ipcEvent, silentLogger };
