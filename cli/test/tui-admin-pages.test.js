'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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

test('admin model management presents web columns, selects web filters and avoids raw JSON details', async () => {
  const calls = [];
  const model = { id: 'm1', name: 'Model One', alias: 'Friendly', upstream_model_id: 'up-1', provider: 'p1', provider_name: 'Provider One', series: 'S', enabled: true, input_price_per_1k_tokens: 0.1, output_price_per_1k_tokens: 0.2, cached_output_price_per_1k_tokens: 0.05, reference_input_price_per_1k_tokens: 0.3, reference_output_price_per_1k_tokens: 0.4, model_multiplier: 1.2, completion_multiplier: 1.3, rate_limit_rpm: 10, rate_limit_tpm: 100, test_ok: true, test_latency_ms: 25 };
  const api = async (path, options = {}) => { calls.push({ path, options }); return { items: [model], total: 1, page: 1, stats: { enabledCount: 1, providerCount: 1, avgInputPrice: 0.1 }, providers: [{ id: 'p1', name: 'Provider One', model_count: 1 }], series: ['S'] }; };
  const data = await pageById('admin-models').load(api);
  const section = data.sections[0];
  assert.deepEqual(section.columns.map(column => column.label), ['模型名称', '供应商', '系列', '输入价/千Token', '输出价/千Token', '缓存输出价', '请求/Token限额', '状态/测试']);
  assert.equal(section.rows[0].cells.input, '0.1 元');
  assert.equal(section.rows[0].cells.limits, '10 次/分 · 100 Token/分');
  assert.ok(data.actions.find(action => action.label === '筛选供应商' && action.toolbar === 'page'));
  assert.ok(data.actions.find(action => action.label === '筛选系列' && action.toolbar === 'page'));
  const providerChoices = [];
  await data.actions.find(action => action.label === '筛选供应商').run({ choose: async (_title, options) => { providerChoices.push(...options); return 'p1'; }, refresh: async () => {} });
  assert.deepEqual(runtime.adminModelFilters.provider, 'p1');
  assert.equal(providerChoices[1].label, 'Provider One · 1 个模型');
  let detail = '';
  await section.rows[0].run({ choose: async () => 'detail', show: async (_title, value) => { detail = value; } });
  assert.match(detail, /上游模型 ID：up-1/);
  assert.match(detail, /输入价格：0.1 元\/千 Token/);
  assert.doesNotMatch(detail, /input_price_per_1k_tokens/);
});

test('admin model actions create, edit, batch update, delete and export through confirmed routes', async () => {
  const model = { id: 'm1', name: 'Model One', alias: 'Friendly', upstream_model_id: 'up-1', provider: 'p1', provider_name: 'Provider One', series: 'S', enabled: true, input_price_per_1k_tokens: 0.1, output_price_per_1k_tokens: 0.2, cached_output_price_per_1k_tokens: 0.05, reference_input_price_per_1k_tokens: 0.3, reference_output_price_per_1k_tokens: 0.4, reference_cached_output_price_per_1k_tokens: 0.06, model_multiplier: 1.2, completion_multiplier: 1.3, rate_limit_rpm: 10, rate_limit_tpm: 100, thinking_model_id: '', non_thinking_model_id: '' };
  const calls = [];
  const api = async (endpoint, options = {}) => { calls.push({ endpoint, options }); if (endpoint === '/api/admin/models') return { items: [model], total: 1, page: options.query?.page || 1, stats: {}, providers: [{ id: 'p1', name: 'Provider One', model_count: 1 }], series: ['S'] }; if (endpoint === '/api/admin/models/batch-update-prices') return { updated: 1 }; return { updated: 1, deleted: 1, cleared_keys: 2 }; };
  const page = pageById('admin-models');
  const initial = await page.load(api);
  const add = initial.actions.find(action => action.label === '添加模型');
  let addFields = [];
  const formValues = { upstream_model_id: 'up-new', alias: 'New', provider: 'p1', series: 'S', description: 'desc', enabled: true, input_price_per_1k_tokens: '0.1', output_price_per_1k_tokens: '0.2', cached_output_price_per_1k_tokens: '0.03', reference_input_price_per_1k_tokens: '0', reference_output_price_per_1k_tokens: '0', reference_cached_output_price_per_1k_tokens: '0', rate_limit_rpm: '0', rate_limit_tpm: '0', model_multiplier: '1', completion_multiplier: '1', thinking_model_id: '', non_thinking_model_id: '' };
  await add.run({ form: async (_title, fields) => { addFields = fields; return formValues; }, confirm: async () => false });
  assert.equal(calls.some(call => call.options.method === 'POST' && call.endpoint === '/api/admin/models'), false);
  await add.run({ form: async () => formValues, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.ok(addFields.some(field => field.label === '输入价格（元/千 Token）'));
  const create = calls.find(call => call.endpoint === '/api/admin/models' && call.options.method === 'POST');
  assert.equal(create.options.body.upstream_model_id, 'up-new');
  assert.equal(create.options.body.input_price_per_1k_tokens, 0.1);

  const editCalls = [];
  const editData = await page.load(async (endpoint, options = {}) => { if (options.method) editCalls.push({ endpoint, options }); return { items: [model], total: 1, providers: [{ id: 'p1', name: 'Provider One' }], series: ['S'] }; });
  const editRow = editData.sections[0].rows[0];
  let editForm = {};
  await editRow.run({ choose: async () => 'edit', form: async (_title, fields) => { editForm = Object.fromEntries(fields.map(field => [field.name, field.value])); return { ...editForm, alias: 'Updated', input_price_per_1k_tokens: '0.5' }; }, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.equal(editCalls[0].endpoint, '/api/admin/models');
  assert.equal(editCalls[0].options.body.id, 'm1');
  assert.equal(editCalls[0].options.body.reference_cached_output_price_per_1k_tokens, 0.06);

  const bulkApi = async (endpoint, options = {}) => { calls.push({ endpoint, options }); if (endpoint === '/api/admin/models') return { items: [model], total: 1, providers: [], series: [] }; return { updated: 1, deleted: 1, cleared_keys: 0 }; };
  const selectable = await page.load(bulkApi);
  const choices = ['select', 'select'];
  await selectable.sections[0].rows[0].run({ choose: async () => choices.shift(), refresh: async () => {} });
  const bulk = (await page.load(bulkApi)).actions.find(action => action.label.startsWith('批量管理'));
  const bulkChoices = ['prices', 'set', 'set'];
  await bulk.run({ choose: async (_title, options) => options.some(option => option.value === 'set' || option.value === 'multiply') ? bulkChoices.shift() : bulkChoices.shift(), form: async () => ({ input_price: '1', output_price: '2', cached_output_price: '0.5' }), confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.find(call => call.endpoint === '/api/admin/models/batch-update-prices').options.body, { ids: ['m1'], mode: 'set', input_price: 1, output_price: 2, cached_output_price: 0.5 });

  runtime.adminModelSelectedIds = ['m1'];
  const deleteBulk = (await page.load(bulkApi)).actions.find(action => action.label.startsWith('批量管理'));
  let warning = '';
  await deleteBulk.run({ choose: async () => 'delete', confirm: async (_title, message) => { warning = message; return false; } });
  assert.match(warning, /不可撤销/);
  assert.equal(calls.some(call => call.endpoint === '/api/admin/models/batch-delete'), false);

  const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-model-export-'));
  const exportPath = path.join(exportDir, 'models.csv');
  const exportAction = initial.actions.find(action => action.label === '导出当前筛选 CSV');
  await exportAction.run({ ask: async () => exportPath, confirm: async () => true, show: async () => {}, notify() {} });
  const csv = await fs.readFile(exportPath, 'utf8');
  assert.match(csv, /模型 ID/);
  assert.match(csv, /m1/);
  await fs.writeFile(exportPath, 'KEEP');
  await exportAction.run({ ask: async () => exportPath, confirm: async () => false, show: async () => {}, notify() {} });
  assert.equal(await fs.readFile(exportPath, 'utf8'), 'KEEP', 'cancelled overwrite must preserve existing file');
  await fs.rm(exportDir, { recursive: true, force: true });
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
