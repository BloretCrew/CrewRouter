'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { notificationSettingsPage } = require('../tui/pages-user-settings');

test('notification settings never display saved Bark key and require a new key when enabled', async () => {
  const page = notificationSettingsPage({ client: {} });
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/notification-settings') return { barkEnabled: true, barkServerKey: 'stored-secret', barkEndpoint: 'https://push.example', notifyQuota: true, notifyErrors: false };
    if (path === '/api/user/notifications') return [];
    return { success: true };
  };
  const data = await page.load(api);
  assert.ok(!JSON.stringify(data.sections).includes('stored-secret'));
  const edit = data.actions.find(action => action.label === '编辑通知设置');
  let shown = false;
  await edit.run({ form: async () => ({ barkEnabled: true, barkServerKey: '', barkEndpoint: 'https://push.example', notifyQuota: true, notifyErrors: false }), show: async () => { shown = true; }, confirm: async () => true });
  assert.equal(shown, true);
  assert.equal(calls.some(call => call.options.method === 'PUT'), false);
});

test('Bark test notification requires confirmation before external request', async () => {
  const calls = [];
  const page = notificationSettingsPage({ client: {} });
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/notification-settings') return { barkEndpoint: 'https://push.example' };
    if (path === '/api/user/notifications') return [];
    return { success: true };
  };
  const data = await page.load(api);
  await data.actions.find(action => action.label === '发送 Bark 测试通知').run({ confirm: async () => false });
  assert.equal(calls.some(call => call.path.endsWith('/test')), false);
});
