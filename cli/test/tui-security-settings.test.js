'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { securitySettingsPage } = require('../tui/pages-user-settings');

test('security page only reads 2FA status and points browser-only flows to web settings', async () => {
  const calls = [];
  const runtime = { client: { baseUrl: 'https://router.example' } };
  const page = securitySettingsPage(runtime);
  const data = await page.load(async path => { calls.push(path); return { enabled: true, enabledAt: '2026-11-01' }; });
  assert.deepEqual(calls, ['/api/2fa/status']);
  assert.ok(data.sections[0].rows[0].label.includes('已启用'));
  assert.ok(data.actions.some(action => action.label === '在浏览器打开安全设置'));
});
