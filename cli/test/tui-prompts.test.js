'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

const makeRuntime = () => ({ client: { isAdmin: false }, cfg: { tui: { days: 30 } }, profileName: 'test' });

test('inject prompt toggle requires confirmation before changing request content', async () => {
  const calls = [];
  const runtime = makeRuntime();
  runtime.client.get = async path => {
    if (path === '/api/user/custom-instructions') return { items: [], total: 0, page: 1 };
    if (path === '/api/user/inject-prompts') return [{ id: 3, name: 'Context', content: 'body', enabled: false, bound_key_ids: [9] }];
    return {};
  };
  runtime.client.put = async (path, body) => { calls.push({ path, method: 'PUT', body }); return {}; };
  runtime.client.delete = async path => { calls.push({ path, method: 'DELETE' }); return {}; };
  const page = buildPages(runtime).find(item => item.id === 'prompts');
  const api = async (path, options = {}) => { if (options.method) calls.push({ path, ...options }); if (!options.method) return runtime.client.get(path, options); return {}; };
  const data = await page.load(api);
  const row = data.sections.find(section => section.title === '注入提示词').rows[0];
  await row.run({ choose: async () => 'toggle', confirm: async () => false });
  assert.equal(calls.length, 0);
  await row.run({ choose: async () => 'toggle', confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.find(call => call.path.endsWith('/toggle')), { path: '/api/user/inject-prompts/3/toggle', method: 'PUT', body: { enabled: true } });
});

test('inject prompt binding empty list requires explicit global scope confirmation', async () => {
  const calls = [];
  const runtime = makeRuntime();
  runtime.client.get = async path => {
    if (path === '/api/user/custom-instructions') return { items: [], total: 0, page: 1 };
    if (path === '/api/user/inject-prompts') return [{ id: 3, name: 'Context', content: 'body', enabled: true, bound_key_ids: [9] }];
    if (path === '/api/user/inject-prompts/my-keys') return [{ id: 9, name: 'Main Key' }];
    return {};
  };
  runtime.client.put = async (path, body) => { calls.push({ path, method: 'PUT', body }); return {}; };
  runtime.client.delete = async path => { calls.push({ path, method: 'DELETE' }); return {}; };
  const page = buildPages(runtime).find(item => item.id === 'prompts');
  const api = async (path, options = {}) => { if (options.method) calls.push({ path, ...options }); if (!options.method) return runtime.client.get(path, options); return {}; };
  const data = await page.load(api);
  const row = data.sections.find(section => section.title === '注入提示词').rows[0];
  let confirms = 0;
  await row.run({ choose: async () => 'keys', ask: async () => '', confirm: async () => { confirms++; return true; }, notify() {}, refresh: async () => {} });
  assert.equal(confirms, 2);
  assert.deepEqual(calls.find(call => call.path.endsWith('/keys')).body, { keyIds: [] });
});
