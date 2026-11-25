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

test('prompt history detail uses readable content, occurrence and source labels instead of raw JSON', async () => {
  const runtime = makeRuntime();
  runtime.client.get = async path => {
    if (path === '/api/user/custom-instructions') return { items: [{ fingerprint: 'f'.repeat(64), file: 'CLAUDE.md', source: 'claude_code', chars: 42, occurrence_count: 3, first_seen: '2026-11-20T00:00:00Z', last_seen: '2026-11-24T00:00:00Z', preview: 'prompt preview' }], total: 1, page: 1 };
    if (path.endsWith(`/custom-instructions/${'f'.repeat(64)}`)) return { file: 'CLAUDE.md', source: 'claude_code', content: 'Full instruction body', chars: 20, occurrence_count: 3, first_seen: '2026-11-20T00:00:00Z', last_seen: '2026-11-24T00:00:00Z', truncated: false, recent_refs: [{ created_at: '2026-11-24T00:00:00Z', model_id: 'model-a', request_source: 'claude_code' }] };
    if (path === '/api/user/inject-prompts') return [];
    return {};
  };
  const page = buildPages(runtime).find(item => item.id === 'prompts');
  const data = await page.load(async (path, options) => runtime.client.get(path, options));
  assert.ok(data.sections[0].toolbar);
  assert.ok(data.actions.some(action => action.label === '搜索历史提示词' && action.toolbar === true));
  let body = '';
  await data.sections[0].rows[0].run({ show: async (_title, text) => { body = text; } });
  assert.match(body, /客户端来源：Claude Code/);
  assert.match(body, /出现次数：3 次/);
  assert.match(body, /Full instruction body/);
  assert.match(body, /最近 1 条调用/);
  assert.doesNotMatch(body, /fingerprint|occurrence_count|recent_refs/);
});

test('inject prompt edit validates fields and updates content without changing key bindings', async () => {
  const calls = [];
  const runtime = makeRuntime();
  runtime.client.get = async path => path === '/api/user/custom-instructions' ? { items: [], total: 0, page: 1 } : [{ id: 3, name: 'Context', content: 'old body', enabled: true, bound_key_ids: [9] }];
  const page = buildPages(runtime).find(item => item.id === 'prompts');
  const writes = [];
  const ctx = {
    choose: async (_title, options) => { assert.ok(options.some(option => option.value === 'edit')); return 'edit'; },
    form: async () => ({ name: '  Updated  ', content: 'new body' }),
    confirm: async () => true,
    show: async () => {},
    notify() {},
    refresh: async () => {},
  };
  const api = async (path, options = {}) => { if (options.method) writes.push({ path, ...options }); else return runtime.client.get(path); };
  const loaded = await page.load(api);
  await loaded.sections.find(section => section.title === '注入提示词').rows[0].run({ ...ctx, api, form: async () => ({ name: 'Updated', content: 'new body' }) });
  assert.deepEqual(writes[0], { path: '/api/user/inject-prompts/3', method: 'PUT', body: { name: 'Updated', content: 'new body' } });
  assert.equal(writes.some(call => call.path.endsWith('/keys')), false);

  const invalidWrites = [];
  const invalidPage = await page.load(async path => runtime.client.get(path));
  await invalidPage.sections.find(section => section.title === '注入提示词').rows[0].run({ ...ctx, form: async () => ({ name: '', content: 'body' }), show: async () => {}, api: async (...args) => invalidWrites.push(args) });
  assert.equal(invalidWrites.length, 0);
});

test('injected prompt detail displays its purpose, effective scope and content with labels', async () => {
  const runtime = makeRuntime();
  runtime.client.get = async path => path === '/api/user/custom-instructions' ? { items: [], total: 0, page: 1 } : [{ id: 3, name: 'Context', content: 'Add source attribution.', enabled: true, bound_key_ids: [9], bound_keys: [{ id: 9, name: 'Main' }], created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-24T00:00:00Z' }];
  const page = buildPages(runtime).find(item => item.id === 'prompts');
  const data = await page.load(async (path, options) => runtime.client.get(path, options));
  let body = '';
  await data.sections.find(section => section.title === '注入提示词').rows[0].run({ choose: async () => 'detail', show: async (_title, text) => { body = text; } });
  assert.match(body, /生效范围：绑定到 1 个 Key/);
  assert.match(body, /注入内容：\nAdd source attribution/);
  assert.doesNotMatch(body, /bound_key_ids|created_at/);
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
