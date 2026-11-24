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

test('invite list is read-only and revocation requires explicit confirmation', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return [{ id: 4, status: 'active', team_id: 2, team_name: 'Team A', used_count: 1, max_uses: 3, expires_at: '2026-12-01', created_by_name: 'admin' }]; };
  const data = await pageById('admin-invites').load(api);
  assert.equal(calls[0].path, '/api/auth-invites');
  const row = data.sections[0].rows[0];
  await row.run({ show: async () => {}, confirm: async () => false });
  assert.equal(calls.some(call => call.options.method === 'POST'), false);
  await row.run({ show: async () => {}, confirm: async () => true, notify() {}, refresh: async () => {} });
  const revoke = calls.find(call => call.options.method === 'POST');
  assert.equal(revoke.path, '/api/auth-invites/4/revoke');
  assert.deepEqual(revoke.options.body, {});
});

test('OAuth clients list is read-only and displays only a redacted secret hint', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { clients: [{ client_id: 'client-1', name: 'Desktop', type: 'confidential', enabled: true, scopes: ['profile'], redirect_uris: ['https://app.example/callback'], has_secret: true, secret_hint: 'abc123', secret_hash: 'must-not-appear', editable: true, builtin: false }], scopes: [{ scope: 'profile', description: 'Profile access' }] }; };
  const data = await pageById('admin-oauth-clients').load(api);
  assert.equal(calls[0].path, '/api/admin/oauth-clients');
  assert.ok(data.sections[0].rows[0].label.includes('Desktop'));
  assert.ok(!JSON.stringify(data.sections).includes('must-not-appear'));
  assert.ok(!data.actions.some(action => /创建|轮换|删除|启用|停用/.test(action.label)));
});

test('admin popup notices are read-only and route to the actual list endpoint', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { items: [{ id: 2, title: 'Maintenance', body: 'Service notice', closeText: 'OK', enabled: true, seenCount: 5, createdAt: '2026-11-01' }] }; };
  const data = await pageById('admin-popups').load(api);
  assert.equal(calls[0].path, '/api/admin/popup-notices');
  assert.ok(data.sections[0].rows[0].label.includes('Maintenance'));
  assert.ok(!data.actions.some(action => /删除|创建|重置|启用|停用/.test(action.label)));
});
