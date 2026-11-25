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

test('admin OAuth clients mirror web columns and support scoped client lifecycle actions', async () => {
  const calls = [];
  const scopeCatalog = [{ scope: 'gateway:invoke', description: '通过网关调用模型接口' }, { scope: 'events:report', description: '仅向 CrewRouter 上报客户端使用事件' }];
  const clients = [{ client_id: 'custom-app', name: 'Custom App', type: 'confidential', source: 'database', editable: true, enabled: true, scopes: ['gateway:invoke'], redirect_uris: ['https://app.example/callback'], has_secret: true, secret_hint: 'abc123', description: 'Internal' }, { client_id: 'builtin-cli', name: 'Built-in CLI', type: 'public', source: 'builtin', editable: false, enabled: true, scopes: ['gateway:invoke'], redirect_uris: ['http://127.0.0.1/callback'], has_secret: false }];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/oauth-clients') return { clients, scopes: scopeCatalog };
    if (path === '/api/admin/oauth-clients/custom-app') return { client: clients[0], revokedTokens: 0 };
    return {};
  };
  const data = await pageById('admin-oauth-clients').load(api);
  assert.deepEqual(data.sections[0].columns.map(column => column.label), ['应用', '类型', '权限 / 回调', '客户端密钥', '状态', '操作']);
  const builtInOptions = [];
  await data.sections[0].rows[1].run({ choose: async (_title, options) => { builtInOptions.push(...options); return 'detail'; }, show: async () => {} });
  assert.deepEqual(builtInOptions.map(option => option.value), ['detail']);
  const choices = ['events:report', '__done__'];
  const formData = { name: 'New Client', clientId: '', type: 'public', redirects: 'https://client.example/cb', allowLoopbackAnyPath: false, description: '', enabled: true };
  await data.actions.find(action => action.label === '新建 OAuth 应用').run({
    choose: async () => choices.shift(),
    form: async () => formData,
    confirm: async () => true,
    show: async (_title, content) => { assert.match(content, /仅显示一次/); },
    notify() {}, refresh: async () => {},
  });
  const create = calls.find(call => call.path === '/api/admin/oauth-clients' && call.options.method === 'POST');
  assert.deepEqual(create.options.body.scopes, ['gateway:invoke', 'events:report']);
  assert.deepEqual(create.options.body.redirectUris, ['https://client.example/cb']);
  assert.equal(create.options.body.type, 'public');
});

test('admin retention page mirrors web thresholds, validates saves and runs preview tasks', async () => {
  const calls = [];
  const config = { compress_days: 30, compress_size_gb: 10, purge_days: 90, purge_size_gb: 20, provider_quota_days: 60, agg_enabled: true };
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/retention-config') return config;
    if (path === '/api/admin/retention/run-compress') return { taskId: 'task-1', status: 'queued' };
    if (path === '/api/admin/retention/tasks/task-1') return { status: 'completed', result: { compressed: 0 } };
    return {};
  };
  const page = pageById('admin-retention');
  const data = await page.load(api);
  assert.deepEqual(data.sections.map(section => section.title), ['压缩阈值', '清除阈值', '其他保留配置', '任务状态']);
  assert.ok(data.sections[0].rows[0].label.includes('30 天'));
  const edit = data.actions.find(action => action.label === '编辑保留配置');
  const values = { ...config };
  await edit.run({ form: async () => values, confirm: async () => true, notify() {}, refresh: async () => {} });
  const save = calls.find(call => call.path === '/api/admin/retention-config' && call.options.method === 'PUT');
  assert.deepEqual(save.options.body, config);

  let result = '';
  await data.actions.find(action => action.label === '预览压缩（dry-run）').run({ confirm: async () => false, show: async (_title, body) => { result = body; } });
  assert.ok(calls.some(call => call.path === '/api/admin/retention/run-compress' && call.options.body.dry_run === true));
  assert.match(result, /compressed/);
  calls.length = 0;
  await data.actions.find(action => action.label === '立即执行清除').run({ confirm: async () => false, show: async () => {} });
  assert.equal(calls.length, 0, 'destructive purge must not start when confirmation is declined');
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

test('admin policy hits mirror web search/source/decision/range filters and detail endpoint', async () => {
  const calls = [];
  const hit = { id: 7, policy_id: 3, policy_name: 'Block risky request', user_id: 9, username: 'alice', team_id: 2, team_name: 'Team A', created_at: '2026-11-25T00:00:00Z', decision: 'block', effect: 'deny', action: 'block', requested_model: 'model-x', request_source: 'codex', reason: 'matched client rule', ip_address: '127.0.0.1' };
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/admin/policy-hits') return { items: [hit], total: 1, page: 1 }; if (path === '/api/admin/policy-clients') return { items: [{ request_source: 'codex', label: 'Codex' }] }; if (path === '/api/admin/policy-hits/7') return hit; return { id: 12 }; };
  const page = pageById('admin-policy-hits');
  const data = await page.load(api);
  assert.equal(calls[0].options.query.limit, 100);
  const initialFrom = Date.parse(calls[0].options.query.from);
  assert.ok(Math.abs(initialFrom - (Date.now() - 24 * 3600000)) < 5000);
  let details = '';
  const row = data.sections[0].rows[0];
  await row.run({ choose: async () => 'detail', show: async (_title, body) => { details = body; } });
  assert.match(details, /决策结果：拦截/);
  assert.match(details, /客户端：codex/);
  await data.actions.find(action => action.label.startsWith('搜索成员或策略')).run({ ask: async () => 'alice', refresh: async () => {} });
  assert.deepEqual(runtime.policyHitFilters, { range: '24h', q: 'alice' });
  await data.actions.find(action => action.label === '筛选客户端').run({ choose: async (_title, options) => { assert.ok(options.some(option => option.value === 'codex')); return 'codex'; }, refresh: async () => {} });
  assert.equal(runtime.policyHitFilters.request_source, 'codex');
  await data.actions.find(action => action.label === '筛选拦截/放行').run({ choose: async () => 'block', refresh: async () => {} });
  assert.equal(runtime.policyHitFilters.decision, 'block');
  await data.actions.find(action => action.label === '筛选时间范围').run({ choose: async () => '7d', refresh: async () => page.load(api) });
  assert.equal(runtime.policyHitFilters.range, '7d');
  assert.equal(runtime.policyHitFilters.decision, 'block');
  const updatedHitCall = calls.filter(call => call.path === '/api/admin/policy-hits').at(-1);
  assert.equal(updatedHitCall.options.query.limit, 100);
  assert.equal(updatedHitCall.options.query.decision, 'block');
  assert.equal(updatedHitCall.options.query.request_source, 'codex');
  assert.ok(updatedHitCall.options.query.from);
  assert.equal(data.actions.some(action => /上一页|下一页/.test(action.label)), false);
  await row.run({ choose: async () => 'detail', show: async () => {} });
  assert.equal(calls.some(call => call.path.endsWith('/from-hit/7')), false, 'hit details stay read-only; exemptions are created from the exemption page');
});

test('admin policy exceptions and appeals filter, revoke, approve and reject with explicit impact', async () => {
  const calls = [];
  const exemption = { id: 11, subject_type: 'user', subject_id: 9, username: 'alice', policy_name: 'Block risky request', reason: 'temporary access', status: 'active', ends_at: '2026-11-26T00:00:00Z', used_count: 1, max_uses: 3 };
  const appeal = { id: 21, user_id: 9, username: 'alice', policy_id: 3, policy_name: 'Block risky request', reason: 'false positive', hit_reason: 'matched rule', hit_action: 'block', status: 'pending', created_at: '2026-11-25T00:00:00Z' };
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/admin/policy-exemptions') return { items: [exemption], total: 1, page: 1 }; if (path === '/api/admin/policy-appeals') return { items: [appeal], total: 1, page: 1 }; if (path === '/api/admin/policies') return { items: [{ id: 3, name: 'Block risky request', scope_type: 'global', effect: 'deny' }] }; return {}; };
  const page = pageById('admin-policy-exceptions');
  const data = await page.load(api);
  assert.deepEqual(calls.slice(0, 2).map(call => call.options.query), [{ limit: 100 }, { limit: 100 }]);
  const create = data.actions.find(action => action.label === '创建策略豁免');
  const createValues = { subject_type: 'user', subject_id: '9', policy_id: '3', hours: '12', max_uses: '4', reason: 'approved test' };
  await create.run({ form: async () => createValues, confirm: async () => false });
  assert.equal(calls.some(call => call.path === '/api/admin/policy-exemptions' && call.options.method === 'POST'), false);
  await create.run({ form: async () => createValues, confirm: async () => true, notify() {}, refresh: async () => {} });
  const created = calls.find(call => call.path === '/api/admin/policy-exemptions' && call.options.method === 'POST');
  assert.deepEqual({ subject_type: created.options.body.subject_type, subject_id: created.options.body.subject_id, policy_id: created.options.body.policy_id, max_uses: created.options.body.max_uses, reason: created.options.body.reason }, { subject_type: 'user', subject_id: 9, policy_id: 3, max_uses: 4, reason: 'approved test' });
  assert.ok(Date.parse(created.options.body.ends_at) > Date.now());
  let revokeMessage = '';
  await data.sections[0].rows[0].run({ confirm: async (_title, message) => { revokeMessage = message; return false; } });
  assert.match(revokeMessage, /恢复接受相关策略检查/);
  assert.equal(calls.some(call => call.path.endsWith('/11') && call.options.method === 'DELETE'), false);
  await data.sections[0].rows[0].run({ confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.ok(calls.some(call => call.path.endsWith('/11') && call.options.method === 'DELETE'));
  let approveMessage = '';
  await data.sections[1].rows[0].run({ choose: async () => 'approve', confirm: async (_title, message) => { approveMessage = message; return true; }, notify() {}, refresh: async () => {} });
  assert.match(approveMessage, /24 小时豁免/);
  assert.deepEqual(calls.find(call => call.path.endsWith('/21/decide')).options.body, { decision: 'approve' });
  let rejectMessage = '';
  await data.sections[1].rows[0].run({ choose: async () => 'reject', confirm: async (_title, message) => { rejectMessage = message; return true; }, notify() {}, refresh: async () => {} });
  assert.match(rejectMessage, /仍受原策略约束/);
  assert.deepEqual(calls.filter(call => call.path.endsWith('/21/decide')).at(-1).options.body, { decision: 'reject' });
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

test('admin invite page renders readable rows, confirms revoke and creates a one-time link with web payload', async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/auth-invites' && options.method === 'POST') return { id: 5, token: 'one-time-token', url: 'https://router.example/?invite=one-time-token', max_uses: 3, expires_at: '2026-12-02T00:00:00Z', team_name: 'Team Two' };
    if (path === '/api/auth-invites') return [{ id: 4, status: 'active', max_uses: 5, used_count: 2, expires_at: '2026-12-01T00:00:00Z', team_id: 2, team_name: 'Team Two', created_by_name: 'admin', created_at: '2026-11-20T00:00:00Z', used_by_name: 'alice', used_at: '2026-11-21T00:00:00Z' }];
    if (path === '/api/admin/teams') return [{ id: 2, name: 'Team Two' }];
    return {};
  };
  const page = pageById('admin-invites');
  const data = await page.load(api);
  assert.match(data.sections[0].rows[0].detail, /Team：Team Two.*使用 2\/5 次/);
  let inviteDetails = '';
  await data.sections[0].rows[0].run({ choose: async () => 'detail', show: async (_title, body) => { inviteDetails = body; } });
  assert.match(inviteDetails, /原始 token 只在创建响应中出现/);
  let revokeWarning = '';
  await data.sections[0].rows[0].run({ choose: async () => 'revoke', confirm: async (_title, message) => { revokeWarning = message; return false; } });
  assert.match(revokeWarning, /不可撤销/);
  assert.equal(calls.some(call => call.path.endsWith('/4/revoke')), false);
  const create = data.actions.find(action => action.label === '生成邀请链接');
  const values = { maxUses: '3', days: '14', teamId: '2' };
  await create.run({ form: async () => values, confirm: async () => false });
  assert.equal(calls.some(call => call.options.method === 'POST' && call.path === '/api/auth-invites'), false);
  let createdDetails = '';
  await create.run({ form: async () => values, confirm: async () => true, show: async (_title, content) => { createdDetails = content; }, notify() {}, refresh: async () => {} });
  const write = calls.find(call => call.path === '/api/auth-invites' && call.options.method === 'POST');
  assert.deepEqual(write.options.body, { maxUses: 3, days: 14, teamId: '2' });
  assert.match(createdDetails, /https:\/\/router.example/);
  assert.match(createdDetails, /one-time-token/);
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

test('project recent workspace opens a safely quoted terminal copy command', async () => {
  const page = pageById('projects');
  const data = await page.load(async () => ({ summary: { projects: 1 }, projects: [{ workspace_path: "/work/O'Brien", requests: 2, tokens: 30, cost: 0.5 }], daily: [] }));
  const recent = data.sections.find(section => section.title === '最近活跃项目');
  let detail = '';
  await recent.rows[0].run({ show: async (_title, body) => { detail = body; } });
  assert.match(detail, /项目：\/work\/O'Brien/);
  assert.match(detail, /cd -- '\/work\/O'\\''Brien'/);
  assert.match(detail, /CLI 不会调用系统剪贴板/);
});
