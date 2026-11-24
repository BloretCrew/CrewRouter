'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

function makeRuntime() { return { client: { isAdmin: false, get: async path => path === '/api/user/my-providers' ? [{ id: 'p1', name: 'Personal', base_url: 'https://p.example', format: 'openai', enabled: true, model_count: 2, notes: 'safe note', forward_headers: true }] : [] }, cfg: { tui: { days: 30 } }, profileName: 'test' }; }

test('my upstream page mirrors providers/models tabs and Team model columns', async () => {
  const calls = [];
  const runtime = makeRuntime();
  runtime.client.get = async path => { calls.push(path); if (path === '/api/user/my-providers') return [{ id: 'p1', name: 'Personal', base_url: 'https://p.example', format: 'openai', enabled: true, model_count: 2 }]; if (path === '/api/user/my-team-models') return [{ id: 'm1', name: 'Model One', alias: 'Friendly', upstream_model_id: 'up-1', provider_name: 'Personal', series: 'S', enabled: true, model_multiplier: 1.2 }]; return {}; };
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
  const runtime = makeRuntime();
  const calls = [];
  runtime.client.put = async (path, body) => { calls.push({ path, body }); return { success: true }; };
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
