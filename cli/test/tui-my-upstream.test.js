'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

test('my upstream page mirrors providers/models tabs and team model columns', async () => {
  const calls = [];
  const runtime = { client: { get: async path => { calls.push(path); if (path === '/api/user/my-providers') return [{ id: 'p1', name: 'Personal', base_url: 'https://p.example', format: 'openai', enabled: true, model_count: 2 }]; if (path === '/api/user/my-team-models') return [{ id: 'm1', name: 'Model One', alias: 'Friendly', upstream_model_id: 'up-1', provider_name: 'Personal', series: 'S', enabled: true, model_multiplier: 1.2 }]; return {}; } }, cfg: { tui: { days: 30 } }, profileName: 'test' };
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
