'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { securitySettingsPage } = require('../tui/pages-user-settings');

test('security page enables and disables 2FA with masked TOTP and password input', async () => {
  const calls = [];
  const runtime = { client: { baseUrl: 'https://router.example' } };
  const page = securitySettingsPage(runtime);
  let enabled = false;
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/2fa/status') return { enabled, enabledAt: enabled ? '2026-11-01' : null };
    if (path === '/api/passkey/list') return [];
    if (path === '/api/2fa/generate') return { secret: 'JBSWY3DPEHPK3PXP', qrcode: 'data:image/png;base64,placeholder' };
    if (path === '/api/2fa/enable') { enabled = true; return { success: true }; }
    if (path === '/api/2fa/disable') { enabled = false; return { success: true }; }
    return {};
  };
  let data = await page.load(api);
  assert.deepEqual(calls.slice(0, 2).map(call => call.path), ['/api/2fa/status', '/api/passkey/list']);
  assert.deepEqual(data.sections.map(section => section.title), ['双重认证（2FA）', '通行密钥（Passkeys）']);
  assert.match(data.sections[0].description, /身份验证器应用/);
  const start = data.sections[0].actions.find(action => action.label === '开始设置双重认证');
  const shown = [];
  let tokenOptions;
  await start.run({ show: async (_title, body) => { shown.push(body); }, ask: async (_title, options) => { tokenOptions = options; return '123456'; }, notify() {}, refresh: async () => {} });
  assert.match(shown[0], /JBSWY3DPEHPK3PXP/);
  assert.match(shown[0], /不要将密钥发送给他人/);
  assert.equal(tokenOptions.secret, true, 'TOTP entry must be masked');
  assert.deepEqual(calls.find(call => call.path === '/api/2fa/enable').options.body, { token: '123456' });
  const wrongCodePage = await page.load(async (path, options = {}) => path === '/api/2fa/status' ? { enabled: false } : path === '/api/passkey/list' ? [] : path === '/api/2fa/generate' ? { secret: 'NEWSECRET' } : path === '/api/2fa/enable' ? { success: false, error: '验证码错误或已过期，请重试' } : {});
  let wrongCodeMessage = '';
  await wrongCodePage.sections[0].actions.find(action => action.label === '开始设置双重认证').run({ show: async (_title, body) => { wrongCodeMessage = body; }, ask: async () => '000000', notify() {}, refresh: async () => {} });
  assert.match(wrongCodeMessage, /设置密钥仍有效.*重新生成密钥/);

  enabled = true;
  data = await page.load(api);
  let passwordOptions;
  let disabled = false;
  await data.sections[0].actions.find(action => action.label === '关闭双重认证').run({ ask: async (_title, options) => { passwordOptions = options; return 'password'; }, confirm: async () => true, notify() { disabled = true; }, refresh: async () => {} });
  assert.equal(passwordOptions.secret, true, 'password entry must be masked');
  assert.deepEqual(calls.find(call => call.path === '/api/2fa/disable').options.body, { password: 'password' });
  assert.equal(disabled, true);
});

test('security page validates TOTP and password gates before writing', async () => {
  const calls = [];
  const page = securitySettingsPage({ client: { baseUrl: 'https://router.example' } });
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/2fa/status') return { enabled: false }; if (path === '/api/passkey/list') return []; if (path === '/api/2fa/generate') return { secret: 'BASE32SECRET' }; return {}; };
  const data = await page.load(api);
  let formatError = '';
  await data.sections[0].actions[0].run({ show: async (_title, body) => { formatError = body; }, ask: async () => '12ab', notify() {}, refresh: async () => {} });
  assert.match(formatError, /必须是 6 位数字/);
  assert.equal(calls.some(call => call.path === '/api/2fa/enable'), false);
});

test('security page lists and confirms passkey deletion, while registration opens the browser', async () => {
  const calls = [];
  const runtime = { client: { baseUrl: 'https://router.example' } };
  const page = securitySettingsPage(runtime);
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/2fa/status') return { enabled: true }; if (path === '/api/passkey/list') return [{ credentialID: 'credential-id-123456', deviceType: 'multiDevice', createdAt: '2026-11-01T00:00:00Z' }]; return { success: true }; };
  const data = await page.load(api);
  const row = data.sections[1].rows[0];
  assert.match(row.label, /同步通行密钥.*credential-i…/);
  assert.doesNotMatch(row.label, /credential-id-123456/);
  assert.match(row.detail, /创建于/);
  let deletePrompt = '';
  await row.run({ choose: async () => 'delete', confirm: async (_title, message) => { deletePrompt = message; return false; } });
  assert.match(deletePrompt, /不能再使用该通行密钥登录/);
  assert.equal(calls.some(call => call.options.method === 'DELETE'), false);
  await row.run({ choose: async () => 'delete', confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.equal(calls.find(call => call.options.method === 'DELETE').path, '/api/passkey/credential-id-123456');
  assert.ok(data.sections[1].actions.some(action => action.label === '在网页中添加通行密钥'));
});
