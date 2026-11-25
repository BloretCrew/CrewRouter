'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

test('session row opens the paginated web message timeline with readable event labels', async () => {
  const calls = [];
  const runtime = { client: { get: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/sessions') return { items: [{ sessionKey: 'session-1', harness: 'codex', requestCount: 2, totalTokens: 100, models: ['m1'] }], page: 1, total: 1 };
    if (path.endsWith('/messages')) return options.query.beforeId
      ? { total: 2, page: 2, records: [{ ts: '2026-11-20T00:00:00Z', model: 'm1', tokens: 50, events: [{ type: 'text', role: 'assistant', text: '第二页模型回复' }] }] }
      : { total: 2, page: 1, records: [{ ts: '2026-11-21T00:00:00Z', model: 'm1', tokens: 50, cachedTokens: 10, latencyMs: 90, events: [{ type: 'text', role: 'user', text: '请查看配置' }, { type: 'tool_call', name: 'read_file', argsPreview: 'README.md' }, { type: 'tool_result', name: 'read_file', resultPreview: '项目配置文件' }] }], nextCursor: { beforeCreatedAt: '2026-11-21T00:00:00Z', beforeId: 21 } };
    return { summary: 'cached summary', createdAt: '2026-11-20T00:00:00Z' };
  } }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const page = buildPages(runtime).find(item => item.id === 'sessions');
  const data = await page.load();
  const rows = [];
  const choices = ['messages', 'more', 'close'];
  await data.sections[0].rows[0].run({ choose: async () => choices.shift(), show: async (_title, body) => { rows.push(body); } });
  assert.equal(calls.filter(call => call.path.endsWith('/messages')).length, 2);
  assert.deepEqual(calls.filter(call => call.path.endsWith('/messages')).map(call => call.options.query), [
    { page: 1, pageSize: 40 }, { page: 2, pageSize: 40, beforeCreatedAt: '2026-11-21T00:00:00Z', beforeId: 21 },
  ]);
  assert.match(rows[0], /用户：请查看配置/);
  assert.match(rows[0], /调用工具：read_file · 参数摘要 README\.md/);
  assert.match(rows[0], /工具返回 · read_file：项目配置文件/);
  assert.ok(!rows[0].includes('"role"'), 'message details should not show raw database/API JSON');
  assert.match(rows[1], /模型回复：第二页模型回复/);
});

test('session content search reads the web results array and renders matching excerpts', async () => {
  const runtime = { client: { get: async (path, options = {}) => ({ q: 'workflow', days: 7, totalSessions: 1, results: [{ sessionKey: 'session-search', harness: 'codex', matchCount: 3, firstSeen: '2026-11-20T00:00:00Z', lastSeen: '2026-11-21T00:00:00Z', previews: [{ ts: '2026-11-21T00:00:00Z', excerpt: 'The workflow finished successfully.' }] }] }) }, cfg: { tui: { days: 7 } }, profileName: 'test', sessionsSearch: 'workflow', sessionsDays: 7 };
  const page = buildPages(runtime).find(item => item.id === 'sessions');
  const data = await page.load();
  assert.equal(data.sections[0].description, '最近 7 天 · 搜索“workflow” · 共 1 个匹配会话');
  assert.equal(data.sections[0].rows[0].label, 'session-search · Codex · 3 条匹配消息');
  assert.match(data.sections[0].rows[0].detail, /The workflow finished successfully/);
});

test('session row opens cached summary through the web read endpoint', async () => {
  const runtime = { client: { get: async path => ({ summary: 'cached summary', createdAt: '2026-11-20T00:00:00Z', path }) }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const page = buildPages(runtime).find(item => item.id === 'sessions');
  runtime.client.get = async path => path === '/api/user/sessions' ? { items: [{ sessionKey: 'session-1', harness: 'codex', requestCount: 2, totalTokens: 100, models: ['m1'] }], page: 1, total: 1 } : { summary: 'cached summary', createdAt: '2026-11-20T00:00:00Z' };
  const data = await page.load();
  let shown;
  await data.sections[0].rows[0].run({ choose: async () => 'summary', show: async (_title, content) => { shown = content; } });
  assert.match(shown, /cached summary/);
});
