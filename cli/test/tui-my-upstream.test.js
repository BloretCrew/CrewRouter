'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');
const { runPagedTui } = require('../tui/engine');
const { terminal, until, tick } = require('./helpers/tty');

function makeRuntime(client = {}) { return { client: { isAdmin: false, ...client }, cfg: { tui: { days: 30 } }, profileName: 'test' }; }

test('my upstream page mirrors providers/models tabs and Team model columns', async () => {
  const calls = [];
  const runtime = makeRuntime({ get: async path => { calls.push(path); if (path === '/api/user/my-providers') return [{ id: 'p1', name: 'Personal', base_url: 'https://p.example', format: 'openai', enabled: true, model_count: 2 }]; if (path === '/api/user/my-team-models') return [{ id: 'm1', name: 'Model One', alias: 'Friendly', upstream_model_id: 'up-1', provider_name: 'Personal', series: 'S', enabled: true, model_multiplier: 1.2 }]; return {}; } });
  const page = buildPages(runtime).find(item => item.id === 'my-upstream');
  assert.deepEqual(page.tabs.map(tab => tab.id), ['providers', 'models']);
  const data = await page.load();
  const section = data.sections.find(item => item.title === '我的模型');
  assert.equal(section.rows[0].cells.name, 'Friendly');
  assert.equal(section.rows[0].cells.upstream_id, 'up-1');
  assert.equal(section.rows[0].cells.provider, 'Personal');
  assert.equal(section.rows[0].cells.multiplier, '计费倍率 ×1.20');
  assert.deepEqual(calls, ['/api/user/my-providers', '/api/user/my-team-models']);
  const rows = data.sections.find(item => item.title === '我的模型').rows;
  assert.equal(rows[0].cells.name, 'Friendly');
  assert.equal(rows[0].cells.upstream_id, 'up-1');
  assert.equal(rows[0].cells.provider, 'Personal');
  assert.equal(rows[0].cells.multiplier, '计费倍率 ×1.20');
  assert.equal(rows[0].cells.status, '已启用');
});

test('my upstream provider page exposes web statistics and enabled/disabled filters', async () => {
  const runtime = makeRuntime({ get: async path => path === '/api/user/my-providers' ? [
    { id: 'p1', name: 'On', enabled: true, model_count: 2 }, { id: 'p2', name: 'Off', enabled: false, model_count: 3 },
  ] : [] });
  const page = buildPages(runtime).find(item => item.id === 'my-upstream');
  const initial = await page.load();
  const providers = initial.sections.find(section => section.title === '供应商');
  assert.deepEqual(providers.cards.map(card => card.label), ['我的供应商', '已启用', '已配置模型', '连通性已测']);
  runtime.myUpstreamProviderStatus = 'enabled';
  const enabled = await page.load();
  assert.deepEqual(enabled.sections.find(section => section.title === '供应商').rows.map(row => row.label.split(' · ')[0]), ['On']);
  assert.ok(enabled.actions.some(action => action.label === '添加供应商'));
  assert.ok(enabled.actions.some(action => action.label === '检测本页供应商'));
});

test('my provider table places toolbar after stats and before web column headers', { timeout: 15000 }, async () => {
  const runtime = makeRuntime({ get: async path => path === '/api/user/my-providers' ? [{ id: 'p1', name: 'Personal', base_url: 'https://p.example', format: 'openai', enabled: true, model_count: 2 }] : [] });
  const page = buildPages(runtime).find(item => item.id === 'my-upstream');
  const providerPage = { ...page, tabs: [{ id: 'providers', label: '供应商' }] };
  const tty = terminal(160, 32);
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages: [providerPage], authenticate: async () => true });
  try {
    await until(() => tty.screen().includes('Personal'));
    const screen = tty.screen();
    const stats = screen.indexOf('我的供应商');
    const toolbar = screen.indexOf('常用操作');
    const header = screen.indexOf('名称');
    assert.ok(stats >= 0 && stats < toolbar && toolbar < header, 'provider layout must be stats → toolbar → table');
    for (const column of ['名称', 'Base URL', '格式', '状态', '延迟', '模型数', '操作']) assert.ok(screen.includes(column), `provider column missing: ${column}`);
    for (const value of ['https://p.example', 'OpenAI 兼容', '2 个', 'Enter 管理']) assert.ok(screen.includes(value), `provider cell missing: ${value}`);
  } finally { tty.input.write('q'); await task; }
});

test('my upstream uses web column order on wide terminals and readable field rows on narrow terminals', { timeout: 15000 }, async () => {
  const model = { id: 'm1', alias: 'Friendly', name: 'Model One', upstream_model_id: 'up-1', provider: 'p1', provider_name: 'Personal', series: 'S', enabled: true, model_multiplier: 1.2, description: 'Short description' };
  const runtime = makeRuntime({ get: async path => path === '/api/user/my-providers' ? [] : [model] });
  const basePage = buildPages(runtime).find(item => item.id === 'my-upstream');
  const modelsPage = { ...basePage, id: 'my-upstream-model-layout', tabs: [{ id: 'models', label: '模型' }] };
  const wide = terminal(160, 32);
  const wideTask = runPagedTui({ ...wide, env: { NO_COLOR: '1' }, api: async () => ({}), pages: [modelsPage], authenticate: async () => true });
  try {
    await until(() => wide.screen().includes('Friendly'));
    const wideScreen = wide.screen();
    assert.ok(wideScreen.indexOf('常用操作') < wideScreen.indexOf('模型名称'));
    for (const header of ['模型名称', '上游模型 ID', '供应商', '系列', '计费倍率', '状态', '操作']) assert.ok(wideScreen.includes(header), `wide table header missing: ${header}`);
    for (const value of ['Friendly', 'up-1', 'Personal', 'S', '计费倍率 ×1.20', '已启用']) assert.ok(wideScreen.includes(value), `wide table value missing: ${value}`);
  } finally { wide.input.write('q'); await wideTask; }

  const narrow = terminal(60, 20);
  const narrowTask = runPagedTui({ ...narrow, env: { NO_COLOR: '1' }, api: async () => ({}), pages: [modelsPage], authenticate: async () => true });
  try {
    await until(() => narrow.screen().includes('模型名称：Friendly'));
    let narrowScreen = narrow.screen();
    narrow.input.write('\x1b[6~');
    await tick(30);
    narrowScreen += narrow.screen();
    for (const field of ['模型名称：Friendly', '上游模型 ID：up-1', '供应商：Personal', '系列：S', '计费倍率：计费倍率 ×1.20', '状态：已启用']) assert.ok(narrowScreen.includes(field), `narrow field missing: ${field}`);
  } finally { narrow.input.write('q'); await narrowTask; }
});

test('my upstream provider detail uses readable labels without exposing the API key', async () => {
  const runtime = makeRuntime({ get: async path => path === '/api/user/my-providers' ? [{ id: 'p1', name: 'Personal', base_url: 'https://p.example', format: 'anthropic', enabled: true, has_api_key: true, model_count: 2, endpoints: [{ url: 'https://secondary.example', label: '备用接口', format: 'openai', enabled: false }] }] : [] });
  const page = buildPages(runtime).find(item => item.id === 'my-upstream');
  const data = await page.load();
  const row = data.sections.find(section => section.title === '供应商').rows[0];
  let detail = '';
  await row.run({ choose: async () => 'detail', show: async (_title, body) => { detail = body; } });
  assert.match(detail, /接口格式：Anthropic Messages 格式/);
  assert.match(detail, /API Key：已配置（不显示密钥）/);
  assert.match(detail, /备用接口（openai，已停用）/);
  assert.doesNotMatch(detail, /api_key/);
});

test('my provider edit confirms and does not overwrite an absent API key', async () => {
  const calls = [];
  const runtime = makeRuntime({
    get: async path => path === '/api/user/my-providers' ? [{ id: 'p1', name: 'Personal', base_url: 'https://p.example', format: 'openai', enabled: true, model_count: 2, notes: 'safe note', forward_headers: true }] : [],
    put: async (path, body) => { calls.push({ path, body }); return { success: true }; },
  });
  const page = buildPages(runtime).find(item => item.id === 'my-upstream');
  const data = await page.load();
  const row = data.sections.find(section => section.title === '供应商').rows[0];
  const form = async () => ({ name: 'Renamed', base_url: 'https://new.example', format: 'anthropic', notes: 'n', enabled: true, models_url: '', test_user_agent: '', forward_headers: true, api_key: '' });
  await row.run({ choose: async () => 'edit', form, confirm: async () => false });
  assert.equal(calls.length, 0);
  await row.run({ choose: async () => 'edit', form, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.equal(calls[0].path, '/api/user/providers/p1');
  assert.equal(calls[0].body.name, 'Renamed');
  assert.equal(Object.hasOwn(calls[0].body, 'api_key'), false);
});

test('my provider creation confirms and sends only supported input fields', async () => {
  const calls = [];
  const runtime = makeRuntime({
    get: async path => path === '/api/user/my-providers' ? [] : path === '/api/user/providers/lookup-index' ? [{ id: 'preset', name: 'Preset Provider', base_url: 'https://preset.example' }] : [],
    post: async (path, body) => { calls.push({ path, body }); return { provider_id: 'created-1' }; },
  });
  const page = buildPages(runtime).find(item => item.id === 'my-upstream');
  const data = await page.load();
  const action = data.actions.find(item => item.label === '添加供应商');
  const form = async () => ({ name: 'New Provider', base_url: 'https://new.example/v1', format: 'openai', api_key: 'secret-value', models_url: '', notes: '' });
  await action.run({ choose: async () => '__custom__', form, confirm: async () => false });
  assert.equal(calls.length, 0);
  await action.run({ choose: async () => '__custom__', form, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.equal(calls[0].path, '/api/user/providers');
  assert.deepEqual(calls[0].body, { name: 'New Provider', base_url: 'https://new.example/v1', format: 'openai', api_key: 'secret-value' });
});

test('provider model manager uses supported batch price endpoint and guards deletion', async () => {
  const calls = [];
  const runtime = makeRuntime({
    get: async path => path === '/api/user/my-providers' ? [{ id: 'p1', name: 'Personal', enabled: true, model_count: 1 }] : path.endsWith('/models') ? [{ id: 'm1', name: 'Model One', enabled: true }] : [],
    post: async (path, body) => { calls.push({ path, method: 'POST', body }); return { updated: 1, deleted: 1 }; },
  });
  const page = buildPages(runtime).find(item => item.id === 'my-upstream');
  const data = await page.load();
  const row = data.sections.find(section => section.title === '供应商').rows[0];
  let choices = ['m1', '__done__', 'edit', 'input_price_per_1k_tokens', '__done__'];
  await row.run({ choose: async (_title, options) => options.some(option => option.value === 'models') ? 'models' : choices.shift(), ask: async () => '1.25', confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls[0], { path: '/api/user/providers/p1/models/batch-update', method: 'POST', body: { modelIds: ['m1'], updates: { input_price_per_1k_tokens: 1.25 } } });
  choices = ['m1', '__done__', 'delete'];
  let warning = '';
  await row.run({ choose: async (_title, options) => options.some(option => option.value === 'models') ? 'models' : choices.shift(), confirm: async (_title, message) => { warning = message; return false; } });
  assert.match(warning, /API Key 模型授权/);
  assert.equal(calls.length, 1);
});

test('my provider bulk sync calls web refresh endpoint after confirmation', async () => {
  const posts = [];
  const runtime = makeRuntime({
    get: async path => path === '/api/user/my-providers' ? [{ id: 'p1', name: 'Personal', enabled: true, model_count: 2 }] : [],
    post: async (path, body) => { posts.push({ path, body }); return { added: 2, total: 3 }; },
  });
  const page = buildPages(runtime).find(item => item.id === 'my-upstream');
  const data = await page.load();
  const choices = ['p1', '__done__', 'sync'];
  await data.actions.find(action => action.label === '批量管理供应商').run({ choose: async () => choices.shift(), confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(posts, [{ path: '/api/user/providers/p1/refresh-models', body: {} }]);
});

test('personal model tab creates a model with the web form fields and confirmed unit labels', async () => {
  const calls = [];
  const runtime = makeRuntime({
    get: async path => path === '/api/user/my-providers' ? [] : path === '/api/user/providers' ? [{ id: 'p1', name: 'Personal Provider' }] : [{ id: 'known', name: 'Known Model', provider: 'p1', provider_name: 'Personal Provider' }],
    post: async (path, body) => { calls.push({ path, body }); return { model_id: 'created-model' }; },
  });
  const page = buildPages(runtime).find(item => item.id === 'my-upstream');
  const data = await page.load();
  const action = data.actions.find(item => item.label === '添加模型');
  assert.ok(action.toolbar);
  let fields = [];
  const form = async (_title, options) => { fields = options; return { upstream_model_id: 'up-model', alias: 'Friendly Model', provider: 'p1', series: 'S', enabled: true, input_price_per_1k_tokens: '0.01', output_price_per_1k_tokens: '0.02', cached_output_price_per_1k_tokens: '0', reference_input_price_per_1k_tokens: '0', reference_output_price_per_1k_tokens: '0', description: 'description', thinking_model_id: '', non_thinking_model_id: '', rate_limit_rpm: '0', rate_limit_tpm: '0' }; };
  await action.run({ form, confirm: async () => false });
  assert.equal(calls.length, 0);
  await action.run({ form, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.ok(fields.some(field => field.label === '输入价格（人民币/千 Token）'));
  assert.equal(calls[0].path, '/api/user/models');
  assert.deepEqual(calls[0].body, { upstream_model_id: 'up-model', alias: 'Friendly Model', provider: 'p1', series: 'S', enabled: true, input_price_per_1k_tokens: 0.01, output_price_per_1k_tokens: 0.02, cached_output_price_per_1k_tokens: 0, reference_input_price_per_1k_tokens: 0, reference_output_price_per_1k_tokens: 0, description: 'description', thinking_model_id: '', non_thinking_model_id: '', rate_limit_rpm: 0, rate_limit_tpm: 0 });
});

test('my Team model tab clears searches and exposes web-equivalent bulk enable controls', async () => {
  const posts = [];
  const runtime = makeRuntime({
    get: async path => path === '/api/user/my-providers' ? [] : [
      { id: 'm1', name: 'Model One', alias: 'One', provider_name: 'Personal', enabled: false },
      { id: 'm2', name: 'Model Two', alias: 'Two', provider_name: 'Personal', enabled: false },
    ],
    post: async (path, body) => { posts.push({ path, body }); return { updated: body.modelIds.length }; },
  });
  runtime.myUpstreamProviderSearch = 'persisted provider search';
  runtime.myUpstreamModelSearch = 'persisted model search';
  runtime.myUpstreamSelectedModels = ['m1'];
  const page = buildPages(runtime).find(item => item.id === 'my-upstream');
  page.onTabChange({ id: 'models' });
  assert.equal(runtime.myUpstreamProviderSearch, '');
  assert.equal(runtime.myUpstreamModelSearch, '');
  assert.deepEqual(runtime.myUpstreamSelectedModels, []);
  const data = await page.load();
  const choices = ['m1', '__done__', 'enable'];
  await data.actions.find(action => action.label === '批量管理个人模型').run({ choose: async () => choices.shift(), confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(posts, [{ path: '/api/user/my-team-models/batch-update', body: { modelIds: ['m1'], updates: { enabled: true } } }]);
});

test('personal Team model edit sends the complete web form and delete warns about cascades', async () => {
  const calls = [];
  const model = { id: 'm1', name: 'Model One', alias: 'Friendly', upstream_model_id: 'up-1', provider: 'p1', provider_name: 'Personal', series: 'S', enabled: true, description: 'old', input_price_per_1k_tokens: 1, output_price_per_1k_tokens: 2, cached_output_price_per_1k_tokens: 3, reference_input_price_per_1k_tokens: 4, reference_output_price_per_1k_tokens: 5, rate_limit_rpm: 10, rate_limit_tpm: 20, model_multiplier: 1.2, completion_multiplier: 1.3, thinking_model_id: '', non_thinking_model_id: '' };
  const runtime = makeRuntime({
    get: async path => path === '/api/user/my-providers' ? [] : [model],
    put: async (path, body) => { calls.push({ path, method: 'PUT', body }); return {}; },
    delete: async path => { calls.push({ path, method: 'DELETE' }); return {}; },
  });
  const page = buildPages(runtime).find(item => item.id === 'my-upstream');
  const data = await page.load();
  const row = data.sections.find(section => section.title === '我的模型').rows[0];
  let formFields = [];
  const form = async (_title, fields) => { formFields = fields; return { upstream_model_id: 'up-1', alias: 'Updated', description: 'desc', series: 'S', enabled: true, input_price_per_1k_tokens: '1.5', output_price_per_1k_tokens: '2.5', cached_output_price_per_1k_tokens: '3.5', reference_input_price_per_1k_tokens: '4', reference_output_price_per_1k_tokens: '5', rate_limit_rpm: '10', rate_limit_tpm: '20', model_multiplier: '1.4', completion_multiplier: '1.3', thinking_model_id: '', non_thinking_model_id: '' }; };
  await row.run({ choose: async () => 'edit', form, confirm: async () => false });
  assert.equal(calls.length, 0);
  await row.run({ choose: async () => 'edit', form, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.ok(formFields.some(field => field.label === '每分钟最大请求数（不限制填 0）'));
  assert.ok(formFields.some(field => field.label === '思考模式模型 ID（可空）'));
  assert.ok(formFields.some(field => field.label === '计费倍率'));
  const update = calls.find(call => call.method === 'PUT');
  assert.equal(update.path, '/api/user/models/m1');
  assert.equal(update.body.input_price_per_1k_tokens, 1.5);
  assert.equal(update.body.model_multiplier, 1.4);
  let warning = '';
  await row.run({ choose: async () => 'delete', confirm: async (_title, message) => { warning = message; return false; } });
  assert.match(warning, /清除关联团队和 API Key 模型授权/);
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
});
