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
const js = fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(rendererDir, 'settings.html'), 'utf8');
const settingsJs = fs.readFileSync(path.join(rendererDir, 'settings.js'), 'utf8');

test('renderer resolves the published Blora 2 package and loads its CSS', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.match(packageJson.version, /^2\./);
  assert.equal(packageJson.type, 'module');
  assert.equal(require.resolve('@bloret-crew/blora-design/package.json'), path.join(packageRoot, 'package.json'));
  for (const file of ['dist/blora.css', 'dist/tokens.dark.css', 'dist/components/card/card.css', 'dist/components/badge/badge.css', 'dist/components/input/input.css', 'dist/components/button/button.css']) {
    const vendorFile = file.replace(/^dist\//, '');
    assert.equal(fs.existsSync(path.join(packageRoot, file)), true, file);
    assert.equal(fs.existsSync(path.join(vendorRoot, vendorFile)), true, `vendor/${vendorFile}`);
    assert.match(html, new RegExp(`vendor\\/blora-design\\/${vendorFile.replaceAll('/', '\\/')}`));
  }
});

test('renderer keeps visible content without CSS or preload bridge', () => {
  assert.match(html, /<main class="oobe-shell"/);
  assert.match(html, /开始使用 CrewRouter/);
  assert.match(html, /选择一种方式/);
  assert.match(html, /连接服务器/);
  assert.match(html, /本地使用/);
  assert.match(html, /启动本地服务，无需登录/);
  assert.match(html, /<form id="connection-form"/);
  assert.match(js, /preload API unavailable/);
  assert.match(html, /runtime-error/);
  assert.match(html, /id="custom-back"[^>]+type="button"/);
  assert.match(html, /id="remote-choice"/);
});

test('renderer keeps one active OOBE panel and uses official Blora structure', () => {
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(min-width: 701px\) and \(max-height: 760px\)/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(html, /class="blora-hero oobe-hero"/);
  assert.match(html, /<blora-steps id="oobe-steps"/);
  assert.match(html, /<blora-field id="local-username-field"/);
  assert.match(html, /<blora-field id="official-url-field"/);
  assert.match(html, /<blora-field id="custom-url-field"/);
  assert.match(html, /id="local-profile-panel"[^>]+hidden/);
  assert.match(html, /id="remote-method-panel"[^>]+hidden/);
  assert.match(html, /id="official-target-panel"[^>]+hidden/);
  assert.match(html, /id="custom-target-panel"[^>]+hidden/);
  assert.match(js, /function renderStep\(step/);
  assert.match(js, /Object\.entries\(panels\)\.forEach/);
  assert.match(html, /id="status-result"/);
});

test('renderer uses official Blora 2 structure without the 1.x API or local token fallback', () => {
  assert.match(html, /class="oobe-shell"/);
  assert.match(html, /class="blora-card oobe-choice"/);
  assert.match(html, /class="blora-button" data-variant="primary" data-size="lg"/);
  assert.equal((html.match(/class="blora-button" data-variant="primary" data-size="lg"/g) || []).length, 3);
  assert.match(html, /vendor\/blora-design\/auto\.js/);
  assert.doesNotMatch(`${html}${css}${js}`, /blora-btn|Blora\.init|blora\.js/);
  assert.doesNotMatch(css, /--blora-[a-z-]+\s*:/);
});

test('connection controls expose accessible labels and live feedback', () => {
  assert.match(html, /<blora-field id="custom-url-field"[^>]+label="服务器地址"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /id="status" class="oobe-status__text" role="status"/);
  assert.match(html, /id="status-result"/);
  assert.match(html, /id="quit"[^>]+type="button"/);
});

test('renderer validates empty and unsupported remote URLs before IPC', () => {
  assert.match(js, /if \(!value\)/);
  assert.match(js, /仅支持 http:\/\/ 或 https:\/\/ 地址/);
  assert.match(js, /setFieldError\(field, errorElement/);
});

test('renderer guards repeated actions and renders server metadata/errors', () => {
  assert.match(js, /if \(isBusy\) return/);
  assert.match(js, /status\.runtime/);
  assert.match(js, /status\.edition/);
  assert.match(js, /status\.auth/);
  assert.match(js, /status\.auth\.methods/);
  assert.match(js, /正在验证目标并打开官方站/);
  assert.match(js, /official-remote-form/);
  assert.match(js, /正在直接连接自定义服务器/);
  assert.match(js, /connectCustomRemote/);
  assert.match(js, /setStatus\(error\?\.message/);
});

test('remote renderer hides settings and does not expose the privileged entry point', () => {
  assert.match(fs.readFileSync(path.join(rendererDir, 'renderer.js'), 'utf8'), /settingsButton\.hidden = status\.mode === 'remote' \|\| status\.runtime !== 'desktop-local'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'), /id = 'desktop-settings'/);
  assert.match(settingsJs, /remoteNote/);
  assert.doesNotMatch(settingsJs, /trustedRemote|remoteTrust|highPrivilege/);
});

test('desktop settings are localized, bridge-safe, system-theme aware and remote-limited', () => {
  assert.match(settingsHtml, /Content-Security-Policy/);
  assert.match(settingsJs, /required =/);
  assert.match(settingsJs, /prefers-color-scheme/);
  assert.match(settingsJs, /remoteNote/);
  assert.match(settingsJs, /copied/);
  assert.match(settingsJs, /escapeHtml\(p.id\)/);
  assert.match(settingsJs, /return; }/);
});

test('main registers visible diagnostics for failed renderer loads', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(mainSource, /did-fail-load/);
  assert.match(mainSource, /render-process-gone/);
  assert.match(mainSource, /console-message/);
});
