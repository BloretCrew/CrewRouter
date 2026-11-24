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

test('Team model rows confirm before changing authorization and call the web route', async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/teams') return [{ id: 4, name: 'Team Four', member_count: 1 }];
    if (path.endsWith('/members')) return [];
    if (path.endsWith('/rules')) return [];
    if (path.endsWith('/models')) return [{ model_id: 'm1', name: 'Model One', provider_name: 'Provider', enabled: true, input_price_per_1k_tokens: 0.1 }];
    return { cleared_keys: 2 };
  };
  const page = pageById('admin-teams');
  const data = await page.load(api);
  const row = data.sections[0].rows.find(item => item.label.includes('Model One'));
  let message = '';
  await row.run({ confirm: async (_title, body) => { message = body; return false; }, notify() {}, refresh: async () => {} });
  assert.ok(message.includes('清除'));
  assert.equal(calls.some(call => call.options.method === 'PUT'), false);
  await row.run({ confirm: async () => true, notify() {}, refresh: async () => {} });
  const write = calls.find(call => call.path.endsWith('/models/m1'));
  assert.equal(write.options.method, 'PUT');
  assert.deepEqual(write.options.body, { enabled: false });
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
