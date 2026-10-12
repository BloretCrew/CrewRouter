'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { createApp } = require('../src/app/create-app');
const { resolveDataRoot } = require('../src/postgres/embedded');

app.on('window-all-closed', () => {});
let desktop;
let userData;
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
async function waitFor(expression, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (desktop.state.mode === 'error') throw new Error(desktop.state.error);
    if (await desktop.ctx.mainWindow.webContents.executeJavaScript(`Boolean(${expression})`, true).catch(() => false)) return;
    await pause();
  }
  const diagnostic = await desktop.ctx.mainWindow.webContents.executeJavaScript("({href: location.href, text: document.body.innerText.slice(0, 3000)})", true);
  throw new Error(`Timed out: ${expression}; ${JSON.stringify(diagnostic)}`);
}

app.whenReady().then(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'crewrouter-embedded-ui-'));
  process.env.CREWROUTER_POSTGRES_PROVIDER = 'embedded';
  desktop = createApp({ electron: require('electron'), userData, isPackaged: false });
  try {
    await desktop.init();
    const execute = (source) => desktop.ctx.mainWindow.webContents.executeJavaScript(source, true);
    await waitFor("document.querySelector('#choose-local') && window.crewrouterDesktop");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await execute("document.getElementById('choose-local').click(); void 0");
    await waitFor("!document.getElementById('view-local-name').hidden && document.querySelector('#local-username-field input')");
    await execute("document.querySelector('#local-username-field input').value = 'Embedded Tester'; document.getElementById('local-profile-form').requestSubmit(); void 0");
    await waitFor("location.hostname === '127.0.0.1' && location.pathname.startsWith('/console') && document.readyState === 'complete'");
    assert.equal(desktop.ctx.local.getStatus().database.provider, 'embedded');
    const identity = await execute("fetch('/auth/me').then(r => r.json()).then(me => me.username)");
    assert.equal(identity, 'Embedded Tester');
    await waitFor("document.getElementById('desktopSettingsCard') && !document.getElementById('desktopSettingsCard').hidden");
    await desktop.actions.showLauncher();
    await desktop.actions.stopLocal();
    await waitFor("document.querySelector('#profile-list [data-action=connect]')");
    await pause();
    await execute("document.querySelector('#profile-list [data-action=connect]').click(); void 0");
    await waitFor("location.hostname === '127.0.0.1' && location.pathname.startsWith('/console') && document.readyState === 'complete'");
    assert.equal(desktop.ctx.local.getStatus().database.provider, 'embedded');
    assert.equal(await execute("fetch('/auth/me').then(r => r.json()).then(me => me.username)"), 'Embedded Tester');
    console.log('PASS: Electron UI first local connection, embedded database, identity, settings and saved-profile restart');
  } finally {
    await desktop.actions.stopLocal();
    desktop.ctx.mainWindow?.destroy();
    await fs.rm(resolveDataRoot(userData), { recursive: true, force: true });
    await fs.rm(userData, { recursive: true, force: true });
  }
}).then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1); });
