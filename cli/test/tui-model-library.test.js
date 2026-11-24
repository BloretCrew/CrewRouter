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
    if (path === '/api/user/model-library/search') return { page: 1, total: 1, items: [{ id: 'm1', name: 'Model One', provider_name: 'Provider A', input_price_per_1k_tokens: 0.1, output_price_per_1k_tokens: 0.2, test_ok: true, test_latency_ms: 21 }] };
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
  const query = calls.find(call => call.path === '/api/user/model-library/search').options.query;
  assert.equal(query.provider, 'p1');
  assert.ok(expanded.sections.find(section => section.title.includes('模型目录')).rows[0].detail.includes('测试通过'));
});
