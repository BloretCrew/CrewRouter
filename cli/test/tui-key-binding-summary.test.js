'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

test('model library binding summary separates default queue, Harness models and request-name mappings', async () => {
  const calls = [];
  const runtime = { client: {}, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/model-library') return { teams: [], starred_models: [], available_series: [], total_models: 0 };
    if (path === '/api/user/api-keys') return [{
      id: 9,
      name: 'Main Key',
      current_model_name: 'Default Model',
      current_model_provider_name: 'Provider One',
      model_queue: [{ model_id: 'm1', name: 'Default Model', sort_order: 0 }],
      harness_models: [{ harness: 'codex', model_id: 'm2', name: 'Codex Model', provider_name: 'Provider Two' }],
      request_model_bindings: [{ request_model_name: 'reasoning', harness: 'claude_code', model_id: 'm3', name: 'Reasoning Model', provider_name: 'Provider Three' }],
    }];
    if (path === '/api/user/provider-tags') return [];
    if (path === '/api/user/providers/quota') return { providers: [] };
    if (path === '/api/user/api-keys/9/models') return { queue: [{ model_id: 'm1', name: 'Default Model' }] };
    return {};
  };
  const page = buildPages(runtime).find(item => item.id === 'model-library');
  const data = await page.load(api);
  const binding = data.sections.find(section => section.title === '当前 Key 绑定');
  assert.ok(binding.rows.some(row => row.label === '当前 Key：Main Key'));
  assert.ok(binding.rows.some(row => row.detail === '供应商：Provider One · 当前模型：Default Model'));
  assert.ok(binding.rows.some(row => row.label === '默认模型队列：1 个' && row.detail.includes('Default Model')));
  assert.ok(binding.rows.some(row => row.label === 'Codex 专属模型' && row.detail === 'Codex Model · Provider Two'));
  assert.ok(binding.rows.some(row => row.label === '请求名映射：reasoning · Claude Code' && row.detail === 'Reasoning Model · Provider Three'));
  assert.deepEqual(calls.filter(call => call.path.includes('/api/user/api-keys/9/models')).map(call => call.path), ['/api/user/api-keys/9/models']);
  assert.doesNotMatch(JSON.stringify(binding.rows), /secret|key_value/i, 'binding summary must not expose secret values');
});
