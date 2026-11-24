'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

const runtime = { client: { isAdmin: true }, cfg: { tui: { days: 30 } }, profileName: 'test' };
const pageById = id => buildPages(runtime).find(page => page.id === id);

test('user audit log filters send action/resource_type and page size', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { items: [], total: 0, page: 1 }; };
  const page = pageById('audit-logs');
  runtime.userAuditAction = 'provider';
  runtime.userAuditResourceType = 'team';
  await page.load(api);
  assert.deepEqual(calls.at(-1).options.query, { page: 1, limit: 50, action: 'provider', resource_type: 'team' });
});

test('admin user edits confirm before sending profile and quota fields', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/admin/users') return { items: [{ id: 5, username: 'alice', email: 'a@example.test', is_admin: false, email_verified: false, team_id: 2, rate_limit_rpm: 10, rate_limit_tpm: 100, tags: ['ops'] }], total: 1, page: 1 }; return {}; };
  const page = pageById('admin-users');
  const data = await page.load(api);
  const row = data.sections[0].rows[0];
  const formValues = { email: 'new@example.test', email_verified: true, isAdmin: false, balance: '12', team_id: '3', rate_limit_rpm: '20', rate_limit_tpm: '200', tags: 'ops,urgent' };
  await row.run({ choose: async () => 'edit', form: async () => formValues, confirm: async () => false, notify() {}, refresh: async () => {} });
  assert.equal(calls.some(call => call.options.method === 'PUT'), false);
  await row.run({ choose: async () => 'edit', form: async () => formValues, confirm: async () => true, notify() {}, refresh: async () => {} });
  const write = calls.find(call => call.options.method === 'PUT');
  assert.deepEqual(write.options.body, { email: 'new@example.test', email_verified: true, isAdmin: false, balance: 12, team_id: 3, rate_limit_rpm: 20, rate_limit_tpm: 200, tags: ['ops', 'urgent'] });
});

test('admin error logs pass user/model/provider/status/date filters to API', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { logs: [], total: 0, page: 1 }; };
  const page = pageById('admin-error-logs');
  runtime.errorPage = 2;
  runtime.errorFilters = { user_q: 'alice', model_q: 'm1', provider_q: 'P', status_code: '500', start_date: '2026-11-01', end_date: '2026-11-07', final_only: '1' };
  const data = await page.load(api);
  assert.deepEqual(calls[0].options.query, { page: 2, limit: 30, ...runtime.errorFilters });
  assert.ok(data.actions.some(action => action.label === '设置日期范围'));
  assert.ok(data.actions.some(action => action.label === '筛选供应商'));
});

test('admin popup notices are read-only and route to the actual list endpoint', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { items: [{ id: 2, title: 'Maintenance', body: 'Service notice', closeText: 'OK', enabled: true, seenCount: 5, createdAt: '2026-11-01' }] }; };
  const data = await pageById('admin-popups').load(api);
  assert.equal(calls[0].path, '/api/admin/popup-notices');
  assert.ok(data.sections[0].rows[0].label.includes('Maintenance'));
  assert.ok(!data.actions.some(action => /删除|创建|重置|启用|停用/.test(action.label)));
});

test('admin updates page only performs the confirmed version check and never applies an update', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return path.endsWith('/runtime') ? { currentVersion: '1.0', status: { state: 'idle' } } : { hasUpdate: true, latestVersion: '1.1' }; };
  const page = pageById('admin-updates');
  const data = await page.load(api);
  assert.deepEqual(calls.map(call => call.path), ['/api/admin/update/runtime', '/api/admin/update/status']);
  const action = data.actions.find(item => item.label === '检查官方更新');
  await action.run({ confirm: async () => false, show: async () => {}, refresh: async () => {} });
  assert.equal(calls.some(call => call.path.endsWith('/check')), false);
  await action.run({ confirm: async () => true, show: async () => {}, refresh: async () => {} });
  assert.ok(calls.some(call => call.path.endsWith('/check')));
  assert.equal(calls.some(call => call.path.endsWith('/apply')), false);
});

test('Team page separates member, model access and quota sections in web order', async () => {
  const api = async path => {
    if (path === '/api/admin/teams') return [{ id: 4, name: 'Team Four', member_count: 1 }];
    if (path.endsWith('/members')) return [{ id: 9, username: 'alice', email: 'a@example.test' }];
    if (path.endsWith('/rules')) return [{ id: 'r1', rule_type: 'requests', rule_value: 100, duration_hours: 24 }];
    if (path.endsWith('/models')) return [{ model_id: 'm1', name: 'Model One', provider_name: 'Provider', enabled: true }];
    return {};
  };
  const data = await pageById('admin-teams').load(api);
  const section = data.sections[0];
  assert.equal(section.title, 'Team Four · Team #4');
  assert.deepEqual(section.cards.map(card => card.label), ['成员', '模型授权', '限额规则']);
  const labels = section.rows.map(row => row.label);
  assert.ok(labels.findIndex(label => label.startsWith('成员列表')) < labels.findIndex(label => label.startsWith('模型授权')));
  assert.ok(labels.findIndex(label => label.startsWith('模型授权')) < labels.findIndex(label => label.startsWith('限额规则')));
});
