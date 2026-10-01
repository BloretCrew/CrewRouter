'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { allowedNavigation, backgroundColorFor, createMainWindow } = require('../src/app/window');
const { AppState } = require('../src/app/state');
const { createElectronStub, silentLogger } = require('./helpers/electron-stub');

const rendererEntry = path.join(__dirname, '..', 'src', 'renderer', 'index.html');

test('navigation whitelist allows the launcher file before connecting and only the target origin after', () => {
  const state = new AppState();
  const options = { state, rendererEntry };
  assert.equal(allowedNavigation(pathToFileURL(rendererEntry).href, options), true);
  assert.equal(allowedNavigation(pathToFileURL('/tmp/other.html').href, options), false);
  assert.equal(allowedNavigation('https://team.example/', options), false);
  state.set({ target: 'https://team.example' });
  assert.equal(allowedNavigation('https://team.example/console#models', options), true);
  assert.equal(allowedNavigation('https://evil.example/', options), false);
  assert.equal(allowedNavigation(pathToFileURL(rendererEntry).href, options), false, '连接后不再允许文件导航');
  assert.equal(allowedNavigation('not a url', options), false);
});

test('background colour follows the resolved theme', () => {
  assert.equal(backgroundColorFor('dark', { shouldUseDarkColors: false }), '#17161C');
  assert.equal(backgroundColorFor('light', { shouldUseDarkColors: true }), '#FAFAF9');
  assert.equal(backgroundColorFor('system', { shouldUseDarkColors: true }), '#17161C');
});

test('main window blocks foreign navigation, denies popups and reports main-frame load failures', async () => {
  const electron = createElectronStub({ userData: '/tmp/unused' });
  const state = new AppState();
  const opened = [];
  const failures = [];
  const window = createMainWindow({ electron, state, rendererEntry, preloadPath: '/tmp/preload.js', env: {}, logger: silentLogger, onLoadFailed: (info) => failures.push(info), openSafeExternal: async (url) => { opened.push(url); } });
  const { win } = window;
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.minWidth, 720);
  assert.deepEqual(win.webContents.openHandler({ url: 'https://docs.example' }), { action: 'deny' });
  let prevented = 0;
  win.webContents.emit('will-navigate', { preventDefault: () => { prevented += 1; } }, 'https://evil.example/');
  assert.equal(prevented, 1);
  await Promise.resolve();
  assert.deepEqual(opened, ['https://docs.example', 'https://evil.example/']);
  win.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://team.example/', true);
  win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://team.example/', true);
  win.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://team.example/frame', false);
  assert.deepEqual(failures, [{ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', url: 'https://team.example/' }]);
  await window.loadLauncher();
  assert.equal(window.currentUrl(), pathToFileURL(rendererEntry).href);
  win.emit('ready-to-show');
  assert.equal(win.shown, true);
});
