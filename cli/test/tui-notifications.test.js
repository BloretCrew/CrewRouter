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

test('notification settings allow disabling Bark and clearing its saved key', async () => {
  const calls = [];
  const page = notificationSettingsPage({ client: {} });
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/user/notification-settings') return { barkEnabled: true, barkServerKey: 'stored-secret', barkEndpoint: 'https://push.example', notifyQuota: true, notifyErrors: false }; if (path === '/api/user/notifications') return []; return { success: true }; };
  const data = await page.load(api);
  let confirmation = '';
  await data.actions.find(action => action.label === '编辑通知设置').run({
    form: async () => ({ barkEnabled: false, barkServerKey: '', barkEndpoint: 'https://push.example', notifyQuota: false, notifyErrors: true }),
    confirm: async (_title, message) => { confirmation = message; return true; }, notify() {}, refresh: async () => {},
  });
  assert.match(confirmation, /Bark 关闭.*清除已保存密钥/s);
  assert.doesNotMatch(confirmation, /stored-secret/);
  assert.deepEqual(calls.find(call => call.options.method === 'PUT').options.body, { barkEnabled: false, barkServerKey: '', barkEndpoint: 'https://push.example', notifyQuota: false, notifyErrors: true });
});

test('notification settings reject malformed endpoints and disclose private HTTP allowlist rules', async () => {
  const calls = [];
  const page = notificationSettingsPage({ client: {} });
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/user/notification-settings') return {}; if (path === '/api/user/notifications') return []; return { success: true }; };
  const data = await page.load(api);
  const edit = data.actions.find(action => action.label === '编辑通知设置');
  let error = '';
  await edit.run({ form: async () => ({ barkEnabled: false, barkServerKey: '', barkEndpoint: 'https://user:pass@push.example/path?token=x', notifyQuota: true, notifyErrors: true }), show: async (_title, body) => { error = body; } });
  assert.match(error, /不要包含用户名、密码、查询参数或片段/);
  assert.equal(calls.some(call => call.options.method === 'PUT'), false);
  let confirmation = '';
  await edit.run({ form: async () => ({ barkEnabled: false, barkServerKey: '', barkEndpoint: 'http://192.168.1.20:8080', notifyQuota: true, notifyErrors: true }), confirm: async (_title, body) => { confirmation = body; return false; } });
  assert.match(confirmation, /CR_BARK_PRIVATE_ORIGINS/);
  assert.equal(calls.some(call => call.options.method === 'PUT'), false);
});

test('clear notifications requires confirmation and uses the web clear-all endpoint', async () => {
  const calls = [];
  const page = notificationSettingsPage({ client: {} });
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/notification-settings') return {};
    if (path === '/api/user/notifications') return [{ id: 1, title: 'Notice', body: 'Body', read_at: null }];
    return { success: true };
  };
  const data = await page.load(api);
  const clear = data.actions.find(action => action.label === '清空所有通知');
  await clear.run({ confirm: async () => false, notify() {}, refresh: async () => {} });
  assert.equal(calls.some(call => call.options.method === 'DELETE'), false);
  await clear.run({ confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.ok(calls.some(call => call.path === '/api/user/notifications' && call.options.method === 'DELETE'));
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
