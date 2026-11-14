'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '../../public/js/app.js'), 'utf8');
const methodStart = source.indexOf('  async generateCcSwitchLink(app) {');
const methodEnd = source.indexOf('\n  copyCcSwitchLink() {', methodStart);
assert.notEqual(methodStart, -1, 'CC Switch link generator exists');
assert.notEqual(methodEnd, -1, 'CC Switch link generator has an end');
const method = source.slice(methodStart, methodEnd).trim();

const html = fs.readFileSync(require('node:path').join(__dirname, '../../public/pages/console.html'), 'utf8');
assert.match(html, /onclick="app\.generateCcSwitchLink\('claude-desktop'\)"/);
assert.match(html, /<span class="config-tool-option-label">Claude Desktop<\/span>/);
assert.match(html, /<span class="config-tool-option-label">Claude Code<\/span>/);

let generatedUrl = '';
const apiKey = 'sk-cc-switch-fixture';
const baseUrl = 'https://gateway.example.test';
const app = {
  _configKey: { id: 42 },
  closeModals() {},
  showToast() {},
};
const context = {
  app,
  fetch: async (url) => {
    assert.equal(url, '/api/user/api-keys/42/config');
    return { ok: true, json: async () => ({ env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: apiKey } }) };
  },
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  unescape,
  encodeURIComponent,
  window: { location: { set href(value) { generatedUrl = value; } } },
  t: (value) => value,
};
vm.runInNewContext(`({ ${method} })`, context).generateCcSwitchLink.call(app, 'claude-desktop').then(() => {
  const url = new URL(generatedUrl);
  assert.equal(url.protocol, 'ccswitch:');
  assert.equal(url.hostname, 'v1');
  assert.equal(url.searchParams.get('resource'), 'provider');
  assert.equal(url.searchParams.get('app'), 'claude-desktop');
  assert.equal(url.searchParams.get('name'), 'CrewRouter');
  const config = JSON.parse(Buffer.from(url.searchParams.get('config'), 'base64').toString('utf8'));
  assert.equal(url.searchParams.get('configFormat'), 'json');
  assert.equal(config.env.ANTHROPIC_BASE_URL, baseUrl);
  assert.equal(config.env.ANTHROPIC_AUTH_TOKEN, apiKey);
  assert.equal(config.env.ANTHROPIC_MODEL, 'claude-fable-5');
  console.log('PASS CC Switch Claude Desktop provider link');
}).catch((error) => { console.error(error); process.exitCode = 1; });
