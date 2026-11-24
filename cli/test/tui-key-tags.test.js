'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

function makeRuntime(isOwner = true) {
  const calls = [];
  const client = {
    isAdmin: false,
    get: async path => {
      calls.push({ path, method: 'GET' });
      if (path === '/api/user/api-keys') return [{ id: 1, name: 'Main', key_prefix: 'cr_x', enabled: true, is_owner: isOwner, total_requests: 2, tags: [{ id: 3, name: 'Ops', color: '#123456' }] }];
      if (path === '/oauth/authorizations') return { authorizations: [] };
      if (path === '/api/user/key-tags') return [{ id: 3, name: 'Ops', color: '#123456' }, { id: 4, name: 'Dev', color: '#654321' }];
      return {};
    },
    put: async (path, body) => { calls.push({ path, method: 'PUT', body }); return {}; },
    post: async (path, body) => { calls.push({ path, method: 'POST', body }); return { id: 4 }; },
    delete: async path => { calls.push({ path, method: 'DELETE' }); return {}; },
  };
  return { runtime: { client, cfg: { tui: { days: 30 } }, profileName: 'test' }, calls };
}

test('API Key page applies tag filter and only exposes tag editing to owners', async () => {
  const { runtime } = makeRuntime(true);
  runtime.apiKeyTagFilter = '3';
  const page = buildPages(runtime).find(item => item.id === 'keys');
  const data = await page.load(async () => ({}));
  assert.deepEqual(data.sections.map(section => section.title), ['我的 Key 用量概览', '标签筛选', 'API Key', 'OAuth 授权']);
  assert.equal(data.sections.find(section => section.title === 'API Key').rows.length, 1);
  assert.ok(data.sections.find(section => section.title === '标签筛选').rows.some(row => row.label.includes('Ops')));
  const { runtime: memberRuntime } = makeRuntime(false);
  const memberPage = buildPages(memberRuntime).find(item => item.id === 'keys');
  const memberData = await memberPage.load(async () => ({}));
  let choices;
  await memberData.sections.find(section => section.title === 'API Key').rows[0].run({ choose: async (_title, options) => { choices = options; return 'detail'; }, show: async () => {} });
  assert.ok(!choices.some(option => option.value === 'tags'));
});

test('API Key tag assignment is owner-only and sends tagIds after confirmation', async () => {
  const { runtime, calls } = makeRuntime(true);
  const page = buildPages(runtime).find(item => item.id === 'keys');
  const data = await page.load(async () => ({}));
  const row = data.sections.find(section => section.title === 'API Key').rows[0];
  await row.run({ choose: async () => 'tags', ask: async () => '3,4', confirm: async () => true, notify() {}, refresh: async () => {} });
  const write = calls.find(call => call.method === 'PUT' && call.path.endsWith('/tags'));
  assert.deepEqual(write.body, { tagIds: [3, 4] });
});
