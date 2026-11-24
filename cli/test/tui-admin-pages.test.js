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

test('admin model library sends web-compatible filters and pagination', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { items: [{ id: 'm1', name: 'Model One', enabled: true, test_ok: true }], total: 1, page: 2 }; };
  runtime.adminModelPage = 2;
  runtime.adminModelSearch = 'model';
  runtime.adminModelFilters = { provider: 'p1', series: 'sonnet', enabled: 'true', test: 'pass' };
  const data = await pageById('admin-models').load(api);
  assert.deepEqual(calls[0].options.query, { page: 2, limit: 30, q: 'model', provider: 'p1', series: 'sonnet', enabled: 'true', test: 'pass' });
  assert.ok(data.actions.some(action => action.label === '筛选测试状态'));
  assert.ok(data.sections[0].rows[0].run);
});
