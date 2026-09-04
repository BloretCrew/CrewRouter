'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { LocalServerManager } = require('../CrewRouter-Desktop/src/server-manager');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.hermes', 'screenshots');
const pages = [
  'admin', 'console', 'data', 'feishu-bind', 'index', 'oauth-consent', 'playground',
  'plugin-install', 'purchase', 'set-password', 'setup', 'showcase', 'store',
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
function startDemo(port) {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-runtime-config-')), 'config.json');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  for (const key of Object.keys(env)) if (/^(?:CR(?:W)?_|DATABASE_URL$|PG(?:HOST|PORT|USER|PASSWORD|DATABASE)$)/.test(key)) delete env[key];
  Object.assign(env, {
    CR_APP_HOST: '127.0.0.1', CR_APP_PORT: String(port), CR_RUNTIME: 'server',
    CR_EDITION: 'team', CR_DEMO: 'true', CR_CONFIG_PATH: configPath,
    CR_LOGIN_REPORT_ENABLED: 'false', CR_STATS_REPORT_ENABLED: 'false', NODE_ENV: 'test',
  });
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  return child;
}
function waitFor(url) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const poll = () => http.get(url, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 500) resolve(res.statusCode);
      else if (Date.now() < deadline) setTimeout(poll, 250);
      else reject(new Error(`Timed out waiting for ${url}`));
    }).on('error', () => Date.now() < deadline ? setTimeout(poll, 250) : reject(new Error(`Timed out waiting for ${url}`)));
    poll();
  });
}
async function inspect(win, baseUrl, name, viewport, theme) {
  await win.setSize(viewport.width, viewport.height);
  const url = `${baseUrl}/${name}`;
  let loadError = null;
  try { await win.loadURL(url); } catch (error) { loadError = error.message; }
  await win.webContents.executeJavaScript(`localStorage.setItem('theme', ${JSON.stringify(theme)}); document.documentElement.classList.remove('dark','light'); document.documentElement.classList.add(${JSON.stringify(theme)}); document.documentElement.style.colorScheme=${JSON.stringify(theme)}; void 0`, true).catch(() => {});
  await sleep(1200);
  const interaction = await win.webContents.executeJavaScript(`(async () => {
    const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    const firstControl = [...document.querySelectorAll('button,input,select,textarea,[role="button"]')].find(visible);
    firstControl?.focus();
    const more = [...document.querySelectorAll('button,[role="button"]')].find((el) => visible(el) && /更多/.test(el.textContent || ''));
    more?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const dialog = [...document.querySelectorAll('blora-dialog')].find((el) => !el.hasAttribute('open'));
    if (dialog && typeof dialog.show === 'function' && typeof dialog.close === 'function') {
      dialog.show();
      await new Promise((resolve) => setTimeout(resolve, 80));
      dialog.close('runtime-check');
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return { focused: document.activeElement?.tagName || '', clickedMore: Boolean(more), dialogLifecycle: Boolean(dialog) };
  })()`, true).catch(() => ({ focused: '', clickedMore: false, dialogLifecycle: false }));
  const details = await win.webContents.executeJavaScript(`(() => {
    const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    const buttons = [...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
    const dialogs = [...document.querySelectorAll('blora-dialog,[role="dialog"],dialog')];
    const opened = dialogs.filter(d => d.hasAttribute('open') || visible(d));
    const controls = [...document.querySelectorAll('input,select,textarea,button,[role="button"]')].filter(visible);
    const errors = [...document.querySelectorAll('[data-blora-state="error"],[role="alert"]')].filter(visible);
    const customElements = [...document.querySelectorAll('*')].filter((el) => el.tagName.toLowerCase().startsWith('blora-') || el.getAttribute('is')?.startsWith('blora-'));
    const legacy = [...document.querySelectorAll('.modal-overlay,.dialog-overlay,.modal-panel,.dialog-panel')].filter(visible);
    return { href: location.href, title: document.title, text: document.body?.innerText?.slice(0, 1200) || '', customElements: customElements.length, dialogs: dialogs.length, openedDialogs: opened.length, controls: controls.length, buttons: buttons.length, errors: errors.length, legacyOverlay: legacy.length, bodyOverflow: getComputedStyle(document.body).overflowX };
  })()`, true).catch((error) => ({ error: error.message }));
  const screenshot = path.join(output, `runtime-${name.replace(/\W/g, '-')}-${theme}-${viewport.width}x${viewport.height}.png`);
  fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  return { page: name, theme, viewport, screenshot: path.relative(root, screenshot), loadError, interaction, ...details };
}
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const teamPort = await freePort();
  const team = startDemo(teamPort);
  let personal;
  const results = [];
  try {
    await waitFor(`http://127.0.0.1:${teamPort}/api/version`);
    await app.whenReady();
    const win = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { sandbox: false } });
    try {
      for (const name of pages) {
        results.push(await inspect(win, `http://127.0.0.1:${teamPort}`, name, { width: 1440, height: 900 }, 'light'));
        results.push(await inspect(win, `http://127.0.0.1:${teamPort}`, name, { width: 1440, height: 900 }, 'dark'));
      }
      personal = new LocalServerManager({ mode: 'development', userData: fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-runtime-personal-')), startupTimeoutMs: 30000 });
      const status = await personal.start();
      for (const name of ['console', 'playground', 'store']) {
        results.push(await inspect(win, status.baseUrl, name, { width: 600, height: 700 }, 'light'));
      }
    } finally {
      await personal?.stop().catch(() => {});
      await win.destroy();
      app.quit();
    }
  } finally {
    team.kill('SIGTERM');
  }
  const observed = results.filter((r) => !r.loadError && !r.error);
  const failures = results.filter((r) => r.error || r.legacyOverlay > 0 || r.bodyOverflow === 'scroll' || (r.loadError && !r.href));
  const evidence = { schema: 'crewrouter.blora-runtime/v1', generatedAt: new Date().toISOString(), pages: results, summary: { observations: observed.length, failures: failures.length, pages: new Set(results.map((r) => r.page)).size } };
  fs.writeFileSync(path.join(root, 'audit', 'blora-runtime.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ output, summary: evidence.summary, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
})().catch((error) => { console.error(error.stack || error.message); app.exit(1); });
