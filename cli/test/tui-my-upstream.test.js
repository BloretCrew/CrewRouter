'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

function makeRuntime(client = {}) { return { client: { isAdmin: false, ...client }, cfg: { tui: { days: 30 } }, profileName: 'test' }; }

test('my upstream page mirrors providers/models tabs and Team model columns', async () => {
  const calls = [];
  const runtime = makeRuntime({ get: async path => { calls.push(path); if (path === '/api/user/my-providers') return [{ id: 'p1', name: 'Personal', base_url: 'https://p.example', format: 'openai', enabled: true, model_count: 2 }]; if (path === '/api/user/my-team-models') return [{ id: 'm1', name: 'Model One', alias: 'Friendly', upstream_model_id: 'up-1', provider_name: 'Personal', series: 'S', enabled: true, model_multiplier: 1.2 }]; return {}; } });
  const page = buildPages(runtime).find(item => item.id === 'my-upstream');
  assert.deepEqual(page.tabs.map(tab => tab.id), ['providers', 'models']);
  const data = await page.load();
  const section = data.sections.find(item => item.title === '个人 Team 模型');
  assert.ok(section.rows[0].label.includes('Friendly'));
  assert.ok(section.rows[0].label.includes('up-1'));
  assert.ok(section.rows[0].label.includes('Personal'));
  assert.ok(section.rows[0].detail.includes('×1.20'));
  assert.deepEqual(calls, ['/api/user/my-providers', '/api/user/my-team-models']);
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
  const row = data.sections.find(section => section.title === '个人 Team 模型').rows[0];
  const form = async () => ({ upstream_model_id: 'up-1', alias: 'Updated', description: 'desc', series: 'S', enabled: true, input_price_per_1k_tokens: '1.5', output_price_per_1k_tokens: '2.5', cached_output_price_per_1k_tokens: '3.5', reference_input_price_per_1k_tokens: '4', reference_output_price_per_1k_tokens: '5', rate_limit_rpm: '10', rate_limit_tpm: '20', model_multiplier: '1.4', completion_multiplier: '1.3', thinking_model_id: '', non_thinking_model_id: '' });
  await row.run({ choose: async () => 'edit', form, confirm: async () => false });
  assert.equal(calls.length, 0);
  await row.run({ choose: async () => 'edit', form, confirm: async () => true, notify() {}, refresh: async () => {} });
  const update = calls.find(call => call.method === 'PUT');
  assert.equal(update.path, '/api/user/models/m1');
  assert.equal(update.body.input_price_per_1k_tokens, 1.5);
  assert.equal(update.body.model_multiplier, 1.4);
  let warning = '';
  await row.run({ choose: async () => 'delete', confirm: async (_title, message) => { warning = message; return false; } });
  assert.match(warning, /清除关联 Team 和 API Key/);
  assert.equal(calls.some(call => call.method === 'DELETE'), false);
});
