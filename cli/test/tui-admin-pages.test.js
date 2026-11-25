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

test('admin error details use readable basic fields and separate original response', async () => {
  const page = pageById('admin-error-logs');
  const api = async () => ({ logs: [{ created_at: '2026-11-25T08:00:00Z', user_id: 7, username: 'alice', model_id: 'm1', upstream_model_id: 'up-model', series: 'Test Series', provider_name: 'Provider', status_code: 500, error_type: 'upstream_timeout', error_message: 'Upstream timed out', error_body: '{"type":"timeout"}', latency_ms: 123, ip_address: '127.0.0.1', key_prefix: 'cr_live_x', key_name: 'Main', is_final: false }], total: 1, page: 1, retention_days: 30 });
  const data = await page.load(api);
  const row = data.sections[0].rows[0];
  let body = '';
  await row.run({ choose: async () => 'overview', show: async (_title, content) => { body = content; } });
  assert.match(body, /请求状态码：500/);
  assert.match(body, /模型：m1/);
  assert.match(body, /最终失败|中间失败/);
  assert.match(body, /响应时间：123 毫秒/);
  assert.match(body, /cr_live_x••••/);
  assert.doesNotMatch(body, /status_code|api_key_id|error_body/);
  await row.run({ choose: async () => 'response', show: async (_title, content) => { body = content; } });
  assert.match(body, /"type": "timeout"/);
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
  assert.equal(section.title, 'Team Four · 团队编号 4');
  assert.deepEqual(section.cards.map(card => card.label), ['成员', '模型授权', '限额规则']);
  const labels = section.rows.map(row => row.label);
  assert.ok(labels.findIndex(label => label.startsWith('成员列表')) < labels.findIndex(label => label.startsWith('模型授权')));
  assert.ok(labels.findIndex(label => label.startsWith('模型授权')) < labels.findIndex(label => label.startsWith('限额规则')));
});
