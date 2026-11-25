'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');
const { runPagedTui } = require('../tui/engine');
const { terminal, until } = require('./helpers/tty');

function makeRuntime(isOwner = true) {
  const calls = [];
  const client = {
    isAdmin: false,
    get: async path => {
      calls.push({ path, method: 'GET' });
      if (path === '/api/user/api-keys') return [{ id: 1, name: 'Main', key_prefix: 'cr_x', enabled: true, is_owner: isOwner, total_requests: 2, tags: [{ id: 3, name: 'Ops', color: '#123456' }] }];
      if (path === '/oauth/authorizations') return { authorizations: [] };
      if (path === '/api/user/key-tags') return [{ id: 3, name: 'Ops', color: '#123456' }, { id: 4, name: 'Dev', color: '#654321' }];
      if (path === '/api/user/api-keys/1/members') return { is_owner: isOwner, members: [{ id: 9, username: 'alice', email: 'alice@example.test', created_at: '2026-11-20T00:00:00Z' }] };
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
  const keySection = data.sections.find(section => section.title === 'API Key');
  assert.equal(keySection.rows.length, 1);
  assert.deepEqual(keySection.columns.map(column => column.label), ['名称', 'Key 掩码', '状态', '当前模型', '请求数', 'Token 消耗', '积分消耗', '有效期', '操作']);
  assert.equal(keySection.rows[0].cells.masked_key, 'cr_x••••');
  assert.equal(keySection.rows[0].cells.requests, '2 次');
  assert.ok(keySection.toolbar);
  assert.ok(data.sections.find(section => section.title === '标签筛选').rows.some(row => row.label.includes('Ops')));
  const { runtime: memberRuntime } = makeRuntime(false);
  const memberPage = buildPages(memberRuntime).find(item => item.id === 'keys');
  const memberData = await memberPage.load(async () => ({}));
  let choices;
  await memberData.sections.find(section => section.title === 'API Key').rows[0].run({ choose: async (_title, options) => { choices = options; return 'detail'; }, show: async () => {} });
  assert.ok(!choices.some(option => option.value === 'tags'));
});

test('API Key page uses web field order and masked values in the wide TUI table', { timeout: 15000 }, async () => {
  const runtime = makeRuntime(true).runtime;
  runtime.client.get = async path => path === '/api/user/api-keys' ? [{ id: 1, name: 'Main Key', key_prefix: 'cr_live_', enabled: true, current_model_name: 'Model One', total_requests: 1234, total_tokens: 5678, total_cost: 2.5, created_at: '2026-11-01T00:00:00Z', last_used_at: '2026-11-22T00:00:00Z', expires_at: null, is_owner: true, tags: [] }] : path === '/oauth/authorizations' ? { authorizations: [] } : [];
  const page = buildPages(runtime).find(item => item.id === 'keys');
  const tty = terminal(200, 44);
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages: [page], authenticate: async () => true });
  try {
    await until(() => tty.screen().includes('cr_live_'));
    const screen = tty.screen();
    const positions = ['▸ 我的 Key 用量概览', '▸ 标签筛选', '▸ API Key', '搜索 API Key', 'Key 掩码', 'Main Key'].map(value => screen.indexOf(value));
    assert.ok(positions.every(index => index >= 0), 'expected API Key page sections and columns');
    assert.ok(positions[0] < positions[1] && positions[1] < positions[2] && positions[2] < positions[3] && positions[3] < positions[4] && positions[4] < positions[5], `unexpected page order: ${positions.join(',')}`);
    for (const header of ['名称', 'Key 掩码', '状态', '当前模型', '请求数', 'Token 消耗', '积分消耗', '有效期', '操作']) assert.ok(screen.includes(header), `missing Key table header: ${header}`);
    assert.ok(screen.includes('cr_live_••••'));
    assert.ok(!screen.includes('secret-key-value'));
  } finally { tty.input.write('q'); await task; }
});

test('API Key shared member management is owner-only and uses web member endpoints with confirmation', async () => {
  const { runtime, calls } = makeRuntime(true);
  const page = buildPages(runtime).find(item => item.id === 'keys');
  const data = await page.load(async () => ({}));
  const row = data.sections.find(section => section.title === 'API Key').rows[0];
  const choices = ['members', 'add', 'done'];
  await row.run({ choose: async () => choices.shift(), ask: async () => 'alice@example.test', confirm: async () => false, notify() {}, refresh: async () => {} });
  assert.equal(calls.some(call => call.method === 'POST' && call.path.includes('/members')), false, 'cancelled add must not write');
  const memberChoices = ['alice@example.test'];
  let memberLoop = 0;
  const memberTitles = [];
  await row.run({ choose: async (title, options) => {
    memberTitles.push([title, options.map(option => option.value)]);
    if (title === 'API Key 操作') return 'members';
    if (title.startsWith('共同成员')) return memberLoop++ === 0 ? 'add' : 'done';
    return 'done';
  }, ask: async () => memberChoices.shift(), confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.ok(memberTitles.some(([title]) => title.startsWith('共同成员')), JSON.stringify(memberTitles));
  let removalStep = 0;
  await row.run({ choose: async (title, options) => {
    if (title === 'API Key 操作') return 'members';
    if (title.startsWith('共同成员 ·')) return removalStep++ === 0 ? 'remove' : 'done';
    if (title === '选择要移除的共同成员') return 9;
    return 'done';
  }, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.ok(calls.some(call => call.method === 'POST' && call.path === '/api/user/api-keys/1/members' && call.body.identity === 'alice@example.test'));
  assert.ok(calls.some(call => call.method === 'DELETE' && call.path === '/api/user/api-keys/1/members/9'));

  const { runtime: sharedRuntime } = makeRuntime(false);
  const shared = await buildPages(sharedRuntime).find(item => item.id === 'keys').load(async () => ({}));
  let memberMenu = [];
  await shared.sections.find(section => section.title === 'API Key').rows[0].run({ choose: async (_title, options) => { memberMenu = options; return 'detail'; }, show: async () => {} });
  assert.ok(!memberMenu.some(option => option.value === 'members'));
});

test('API Key detail uses readable labels and discloses shared member count', async () => {
  const { runtime } = makeRuntime(false);
  runtime.client.get = async path => path === '/api/user/api-keys' ? [{ id: 1, name: 'Shared', key_prefix: 'cr_shared_', enabled: true, is_owner: false, current_model_name: 'Model One', total_requests: 5, total_tokens: 100, total_cost: 0.25, created_at: '2026-11-20T00:00:00Z', last_used_at: '2026-11-25T00:00:00Z', expires_at: null, permissions: { usage: true }, members: [{ id: 9, username: 'alice', email: 'alice@example.test' }] }] : path === '/oauth/authorizations' ? { authorizations: [] } : [];
  const page = buildPages(runtime).find(item => item.id === 'keys');
  const data = await page.load(async () => ({}));
  const row = data.sections.find(section => section.title === 'API Key').rows[0];
  assert.match(row.detail, /共同使用的 Key · 1 位共同成员/);
  let detail = '';
  await row.run({ choose: async () => 'detail', show: async (_title, body) => { detail = body; } });
  assert.match(detail, /身份：共同成员访问/);
  assert.match(detail, /Token 消耗：100 Token/);
  assert.doesNotMatch(detail, /total_requests|current_model|key_prefix/);
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
