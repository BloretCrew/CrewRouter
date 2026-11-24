'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

function makeRuntime() {
  return { client: {}, cfg: { tui: { days: 30 } }, profileName: 'test' };
}

test('user model library renders teams, provider summaries, stars and searchable details', async () => {
  const runtime = makeRuntime();
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/model-library') return { teams: [{ team_id: 2, team_name: 'Team A', providers: [{ provider_id: 'p1', provider_name: 'Provider A', model_count: 4, visible_model_count: 3, test_summary: { tested: 2, success: 1, avg_latency_ms: 20 }, tags: [{ id: 5, name: 'Featured' }] }] }], starred_models: [{ model_id: 'star-1', name: 'Starred', provider_name: 'Provider A' }], available_series: ['S'], total_models: 4 };
    if (path === '/api/user/api-keys') return [{ id: 1, name: 'Main' }];
    if (path === '/api/user/provider-tags') return [{ id: 5, name: 'Featured' }];
    if (path.endsWith('/models')) return { queue: [], models: [] };
    if (path === '/api/user/model-library/search') return { page: 1, total: 1, items: [{ id: 'm1', name: 'Model One', provider: 'p1', team_id: 2, team_name: 'Team A', provider_name: 'Provider A', input_price_per_1k_tokens: 0.1, output_price_per_1k_tokens: 0.2, test_ok: true, test_latency_ms: 21, is_starred: false, is_hidden: false }] };
    return {};
  };
  const page = buildPages(runtime).find(item => item.id === 'model-library');
  const initial = await page.load(api);
  assert.ok(initial.sections.some(section => section.title === '模型库概览'));
  assert.ok(initial.sections.some(section => section.title === '星标模型'));
  const providerRow = initial.sections.find(section => section.title === '团队与供应商目录').rows[0];
  assert.match(providerRow.label, /Team A.*Provider A.*3\/4 模型/);
  await providerRow.run({ refresh: async () => {} });
  const expanded = await page.load(api);
  assert.ok(expanded.sections.some(section => section.title.includes('模型目录')));
  runtime.librarySort = 'test_tps_desc';
  await page.load(api);
  const query = calls.filter(call => call.path === '/api/user/model-library/search').at(-1).options.query;
  assert.equal(query.provider, 'p1');
  assert.equal(query.sort, 'test_tps_desc');
  const modelRow = expanded.sections.find(section => section.title.includes('模型目录')).rows[0];
  assert.ok(modelRow.detail.includes('测试通过'));
  const actions = [];
  const liveApi = async (path, options = {}) => { actions.push({ path, options }); if (path === '/api/user/model-library') return { teams: [{ team_id: 2, team_name: 'Team A', providers: [{ provider_id: 'p1', provider_name: 'Provider A', model_count: 1, visible_model_count: 1 }] }], starred_models: [], available_series: [], total_models: 1 }; if (path === '/api/user/api-keys') return [{ id: 8, name: 'Main Key' }]; if (path === '/api/user/provider-tags') return []; if (path.endsWith('/models')) return { queue: [] }; if (path === '/api/user/model-library/search') return { page: 1, total: 1, items: [{ id: 'm1', name: 'Model One', provider: 'p1', team_id: 2, team_name: 'Team A', is_starred: false, is_hidden: false }] }; return {}; };
  const refreshed = await page.load(liveApi);
  const providerAction = refreshed.sections.find(section => section.title === '团队与供应商目录').rows[0];
  await providerAction.run({ refresh: async () => {} });
  const ready = await page.load(liveApi);
  const readyRow = ready.sections.find(section => section.title.includes('模型目录')).rows[0];
  await readyRow.run({ choose: async () => 'star', confirm: async () => false });
  assert.equal(actions.some(call => call.path === '/api/user/model-library/star'), false);
  await readyRow.run({ choose: async () => 'hide', confirm: async () => true, notify() {}, refresh: async () => {} });
  const hide = actions.find(call => call.path === '/api/user/model-library/hidden');
  assert.deepEqual(hide.options.body, { scope: 'model', teamId: 2, providerId: 'p1', modelId: 'm1', hidden: true });
});
