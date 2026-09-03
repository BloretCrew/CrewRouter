'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = require('../src/main');

test('main module can be required without Electron installed', () => {
  assert.equal(typeof main.allowedNavigation, 'function');
  assert.equal(typeof main.createDemoState, 'function');
  assert.equal(main.allowedNavigation('file:///tmp/other.html'), false);
});

test('main uses the official CrewRouter demo by default', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(source, /process\.env\.CREWROUTER_DEMO_URL \|\| 'https:\/\/crewrouter\.bloret\.net'/);
  assert.match(source, /async function connectCustomRemote/);
  assert.match(source, /desktop:connect-custom-remote/);
  assert.match(source, /if \(active\.mode === 'local'\) return startLocal\(active\.displayName\)/);
  assert.match(source, /state\.connection\.inspect\(target\.url\.toString\(\)\)/);
  assert.match(source, /targetOrigin/);
});

test('main status exposes an explicit connect state', () => {
  assert.deepEqual(main.currentStatus(), {
    mode: 'connect',
    target: null,
    runtime: null,
    edition: null,
    auth: null,
    demo: null,
    capabilities: {},
    protocolVersion: null,
    profile: null,
    localProfile: null,
    needsLocalProfile: true,
  });
});

test('forged URL or header context cannot authorize privileged settings IPC', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(source, /const isSettingsFrame = \(event\) => Boolean\(state\.settingsWindow/);
  assert.match(source, /event\.sender === state\.settingsWindow\.webContents/);
  assert.match(source, /settingsEntry/);
  assert.doesNotMatch(source, /trustedRemote|x-crewrouter|authorization.*settings/i);
});

test('Electron acceptance writes required screenshots in the repository root', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-electron-acceptance.js'), 'utf8');
  assert.match(source, /path\.resolve\(root, '\.\.', '\.hermes', 'screenshots'\)/);
  assert.match(source, /desktop-settings-local-960x700\.png/);
  assert.match(source, /desktop-settings-local-600x700\.png/);
});

test('preload bridge is present at the formal renderer path', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'preload.js')), true);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.match(preload, /contextBridge\.exposeInMainWorld\('crewrouterDesktop'/);
  assert.doesNotMatch(preload, /restartLocal/);
  const settingsPreload = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings-preload.js'), 'utf8');
  assert.match(settingsPreload, /restartLocal/);
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(mainSource, /desktop:restart-local', async \(event\) => \{ if \(!isSettingsFrame\(event\)/);
});
