'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

const makeRuntime = (client = { isAdmin: true }) => ({ client, cfg: { tui: { days: 30 } }, profileName: 'test' });
const pageById = (id, runtime = makeRuntime()) => buildPages(runtime).find(page => page.id === id);

test('provider tag page creates and deletes tags through supported endpoints', async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/provider-tags') return [{ id: 2, name: 'Featured', color: '#123456' }];
    return {};
  };
  const page = pageById('provider-tags');
  const data = await page.load(api);
  const tag = data.sections[0].rows[0];
  await tag.run({ choose: async () => 'delete', confirm: async () => false });
  assert.equal(calls.some(call => call.options.method === 'DELETE'), false);
  await tag.run({ choose: async () => 'delete', confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.equal(calls.at(-1).path, '/api/admin/provider-tags/2');
  assert.equal(calls.at(-1).options.method, 'DELETE');
  const create = data.actions.find(action => action.label === '新建标签');
  await create.run({ form: async () => ({ name: 'Priority', color: '#ff0000' }), notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.at(-1).options.body, { name: 'Priority', color: '#ff0000' });
});

test('provider assignment uses the confirmed replacement tag id list', async () => {
  const calls = [];
  const provider = { id: 'p1', name: 'Provider', base_url: 'https://example.test', format: 'openai', enabled: true, created_by: null, tags: [{ id: 1, name: 'Old' }] };
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/providers') return { items: [provider], total: 1, stats: { total: 1, enabledCount: 1, globalCount: 1, userCount: 0, tags: [{ id: 1, name: 'Old' }, { id: 2, name: 'Featured' }] } };
    if (path === '/api/admin/provider-tags') return [{ id: 1, name: 'Old' }, { id: 2, name: 'Featured' }];
    if (path === '/api/admin/providers/p1') return provider;
    return {};
  };
  const client = {
    get: async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/admin/providers') return { items: [provider], total: 1, stats: { total: 1, enabledCount: 1, globalCount: 1, userCount: 0, tags: [{ id: 1, name: 'Old' }, { id: 2, name: 'Featured' }] } }; if (path === '/api/user/my-providers') return []; if (path === '/api/user/providers') return []; return path === '/api/admin/provider-tags' ? [{ id: 1, name: 'Old' }, { id: 2, name: 'Featured' }] : provider; },
    put: async (path, body) => { calls.push({ path, options: { method: 'PUT', body } }); return {}; },
  };
  const page = pageById('providers', makeRuntime(client));
  const data = await page.load(api);
  let choices = 0;
  await data.sections[0].rows[0].run({
    choose: async (_title, options) => { choices++; return choices === 1 ? 'tags' : options.find(item => item.label.includes('Featured')).value; },
    confirm: async () => true, notify() {}, refresh: async () => {},
  });
  const write = calls.find(call => call.path === '/api/admin/providers/p1/tags');
  assert.equal(write.options.method, 'PUT');
  assert.deepEqual(write.options.body.tagIds.sort(), [1, 2]);
});
