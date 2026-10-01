'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
const packageRoot = path.join(__dirname, '..', 'node_modules', '@bloret-crew', 'blora-design');
const vendorRoot = path.join(rendererDir, 'vendor', 'blora-design');
const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(rendererDir, 'launcher.js'), 'utf8');
const i18nSource = fs.readFileSync(path.join(rendererDir, 'i18n.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');

function loadI18n() {
  const sandbox = { window: {}, document: { documentElement: {}, querySelectorAll: () => [] } };
  new Function('window', 'document', i18nSource)(sandbox.window, sandbox.document);
  return sandbox.window.CrewRouterDesktopI18n;
}

test('launcher resolves the published Blora 2 package and loads vendored CSS only', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.match(packageJson.version, /^2\./);
  for (const link of html.match(/href="vendor\/blora-design\/[^"]+"/g) || []) {
    const file = link.slice('href="vendor/blora-design/'.length, -1);
    assert.equal(fs.existsSync(path.join(vendorRoot, file)), true, `vendor/${file} 缺失`);
    assert.equal(fs.existsSync(path.join(packageRoot, 'dist', file)), true, `dist/${file} 缺失`);
  }
  assert.match(html, /vendor\/blora-design\/blora\.global\.js/);
  for (const reference of html.match(/(?:src|href)="([^"]+)"/g)) assert.doesNotMatch(reference, /https?:/, `启动页不加载远程资源：${reference}`);
  assert.doesNotMatch(`${html}${css}${js}`, /blora-btn|Blora\.init|blora\.js"/);
  assert.doesNotMatch(css, /--blora-[a-z-]+\s*:/, '页面样式不得声明自己的 token');
});

test('launcher markup exposes one section per state and the controls the main process expects', () => {
  const views = [...html.matchAll(/<section class="launcher__view" data-view="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(views, ['welcome', 'local-name', 'remote-method', 'custom-url', 'progress', 'error', 'settings']);
  for (const id of ['choose-local', 'choose-remote', 'profile-list', 'saved-panel', 'local-profile-form', 'local-username-field', 'connection-form', 'custom-url-field', 'official-remote', 'custom-remote', 'progress-bar', 'official-wait', 'reopen-login', 'cancel-pending', 'error-result', 'retry', 'error-open-logs', 'dismiss-error', 'open-settings', 'pref-autoConnect', 'pref-theme', 'pref-language', 'local-restart', 'local-stop', 'copy-diagnostics', 'restart-app', 'quit-app', 'confirm-dialog', 'rename-dialog', 'inline-alert', 'local-chip']) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id}`);
  }
  assert.match(html, /<blora-progress id="progress-bar"/);
  assert.match(html, /<blora-result id="error-result" variant="error"/);
  assert.match(html, /<blora-dialog id="confirm-dialog"[^>]*close-on-outside-click="false"/);
  assert.match(html, /<blora-switch id="pref-autoConnect"/);
  assert.match(html, /<blora-select id="pref-theme"/);
  assert.match(html, /class="blora-descriptions/);
  assert.doesNotMatch(html, /⌘Q|settings\.html|desktop-settings"/);
  assert.equal((html.match(/type="submit"/g) || []).length, 2);
  for (const button of html.match(/<button[^>]*>/g)) assert.match(button, /type="(button|submit)"/, `按钮缺少 type: ${button}`);
});

test('launcher script renders from status snapshots and never writes HTML strings', () => {
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(js, /api\.onStatus\(render\)/);
  for (const method of ['startLocal', 'connectCustomRemote', 'openOfficialLogin', 'reopenOfficialLogin', 'cancelPending', 'clearError', 'retry', 'openLogs', 'listProfiles', 'switchProfile', 'renameProfile', 'deleteProfile', 'getDesktopSettings', 'saveDesktopSettings', 'restartLocal', 'stopLocal', 'getDiagnostics', 'restartApp', 'quit']) {
    assert.match(js, new RegExp(`api\\.${method}\\(`), `launcher 未使用 ${method}`);
    assert.match(preload, new RegExp(`\\b${method}:`), `preload 未暴露 ${method}`);
  }
  assert.doesNotMatch(preload, /chooseMode|connectRemote|openSettings|setupLocalProfile|openOfficialDemo/);
  assert.match(js, /awaiting-official-login/);
  assert.match(js, /status\.prefill\?\.serverUrl/);
  assert.match(js, /Error invoking remote method/);
  assert.match(js, /confirmDialog\(/);
  assert.doesNotMatch(js, /window\.confirm|window\.prompt|\balert\(/);
});

test('i18n dictionaries are complete for both languages and switch the document language', () => {
  const i18n = loadI18n();
  const zhKeys = i18n.keys;
  assert.ok(zhKeys.length > 60);
  assert.equal(i18n.t('nav.back'), '返回');
  assert.equal(i18n.setLanguage('en'), 'en');
  for (const key of zhKeys) assert.ok(i18n.has('en', key), `en 缺少 ${key}`);
  assert.equal(i18n.t('saved.lastConnected', { time: 'now' }), 'Last connected now');
  assert.equal(i18n.setLanguage('fr'), 'zh');
  for (const key of html.match(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g).map((item) => item.replace(/.*="([^"]+)"/, '$1'))) assert.ok(zhKeys.includes(key), `HTML 引用了未定义的文案 ${key}`);
});

test('launcher styles keep the two-column choice grid responsive and hidden views collapsed', () => {
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /overflow-wrap: anywhere/);
});
