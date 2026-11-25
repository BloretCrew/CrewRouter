'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

test('session row opens the paginated web message timeline with readable event labels', async () => {
  const calls = [];
  const runtime = { client: { get: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/sessions') return { items: [{ sessionKey: 'session-1', harness: 'codex', requestCount: 2, totalTokens: 100, totalCachedTokens: 30, toolCallCount: 4, lastToolName: 'read_file', cwd: '/work/repo', lastMessagePreview: 'Recent assistant answer.', pressureLevel: 'warning', summary: 'A useful session summary.', summaryCreatedAt: '2026-11-22T00:00:00Z', models: ['m1'] }], page: options.query.page || 1, pageSize: 20, total: 21 };
    if (path.endsWith('/messages')) return options.query.beforeId
      ? { total: 2, page: 2, records: [{ ts: '2026-11-20T00:00:00Z', model: 'm1', tokens: 50, events: [{ type: 'text', role: 'assistant', text: '第二页模型回复' }] }] }
      : { total: 2, page: 1, records: [{ ts: '2026-11-21T00:00:00Z', model: 'm1', tokens: 50, cachedTokens: 10, latencyMs: 90, events: [{ type: 'text', role: 'user', text: '请查看配置', attachments: [{ kind: 'image', mimeType: 'image/png', data: 'data:image/png;base64,AA==' }] }, { type: 'tool_call', name: 'read_file', argsPreview: 'README.md' }, { type: 'tool_result', name: 'read_file', resultPreview: '项目配置文件' }] }], nextCursor: { beforeCreatedAt: '2026-11-21T00:00:00Z', beforeId: 21 } };
    return { summary: 'cached summary', createdAt: '2026-11-20T00:00:00Z' };
  } }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const page = buildPages(runtime).find(item => item.id === 'sessions');
  const data = await page.load();
  assert.deepEqual(calls[0].options.query, { days: 7, page: 1, pageSize: 20 });
  const sessionRow = data.sections[0].rows[0];
  assert.match(sessionRow.label, /缓存 30 Token.*4 次工具调用/);
  for (const detail of ['工作区：/work/repo', '会话摘要：A useful sessio', '最近工具：read_file', '上下文压力：注意']) assert.ok(sessionRow.detail.includes(detail), `missing session detail: ${detail}; actual=${sessionRow.detail}`);
  assert.equal(data.actions.find(action => action.label === '下一页').disabled, false);
  const rows = [];
  const choices = ['messages', 'more', 'close'];
  await data.sections[0].rows[0].run({ choose: async () => choices.shift(), show: async (_title, body) => { rows.push(body); } });
  assert.equal(calls.filter(call => call.path.endsWith('/messages')).length, 2);
  assert.deepEqual(calls.filter(call => call.path.endsWith('/messages')).map(call => call.options.query), [
    { page: 1, pageSize: 40 }, { page: 2, pageSize: 40, beforeCreatedAt: '2026-11-21T00:00:00Z', beforeId: 21 },
  ]);
  assert.match(rows[0], /用户：请查看配置/);
  assert.match(rows[0], /包含 1 个图片附件/);
  assert.match(rows[0], /调用工具：read_file · 参数摘要 README\.md/);
  assert.match(rows[0], /工具返回 · read_file：项目配置文件/);
  assert.ok(!rows[0].includes('"role"'), 'message details should not show raw database/API JSON');
  assert.match(rows[1], /模型回复：第二页模型回复/);
});

test('session list applies web client source filter and bounds page controls', async () => {
  const calls = [];
  const runtime = { client: { get: async (path, options = {}) => { calls.push({ path, options }); return { days: options.query.days, page: options.query.page, pageSize: 20, total: 21, items: [{ sessionKey: 'session-1', harness: 'codex', requestCount: 2, totalTokens: 20 }] }; } }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const page = buildPages(runtime).find(item => item.id === 'sessions');
  runtime.sessionsSource = 'codex'; runtime.sessionsDays = 7;
  let data = await page.load();
  assert.deepEqual(calls[0].options.query, { days: 7, page: 1, pageSize: 20, source: 'codex' });
  assert.equal(data.actions.find(action => action.label === '下一页').disabled, false);
  runtime.sessionsPageNumber = 2;
  data = await page.load();
  assert.equal(data.actions.find(action => action.label === '下一页').disabled, true);
  const sourceChoices = ['claude_code'];
  await data.actions.find(action => action.label === '筛选客户端').run({ choose: async () => sourceChoices.shift(), refresh: async () => {} });
  assert.equal(runtime.sessionsSource, 'claude_code');
  assert.equal(runtime.sessionsPageNumber, 1);
});

test('session content search reads the web results array and renders matching excerpts', async () => {
  const calls = [];
  const runtime = { client: { get: async (path, options = {}) => { calls.push({ path, options }); return { q: 'workflow', days: 7, totalSessions: 1, results: [{ sessionKey: 'session-search', harness: 'codex', matchCount: 3, firstSeen: '2026-11-20T00:00:00Z', lastSeen: '2026-11-21T00:00:00Z', previews: [{ ts: '2026-11-21T00:00:00Z', excerpt: 'before <<<MARK>>>workflow<<<END>>> after' }, { ts: '2026-11-20T00:00:00Z', excerpt: 'second workflow hit' }, { ts: '2026-11-19T00:00:00Z', excerpt: 'third workflow hit' }] }] }; } }, cfg: { tui: { days: 7 } }, profileName: 'test', sessionsSearch: 'workflow', sessionsDays: 30, sessionsSource: 'codex' };
  const page = buildPages(runtime).find(item => item.id === 'sessions');
  const data = await page.load();
  assert.equal(data.sections[0].description, '最近 7 天 · 搜索“workflow” · 共 1 个匹配会话（最多显示 20 个）');
  assert.equal(data.sections[0].rows[0].label, 'session-search · Codex · 3 条匹配消息');
  assert.match(data.sections[0].rows[0].detail, /【命中：workflow】/);
  assert.match(data.sections[0].rows[0].detail, /second workflow hit/);
  assert.match(data.sections[0].rows[0].detail, /third workflow hit/);
  assert.deepEqual(calls[0].options.query, { q: 'workflow', days: 7 });
  assert.equal(data.actions.some(action => action.label === '筛选客户端'), false, 'session search API does not accept source filter');
  assert.ok(data.actions.find(action => action.label === '清除搜索').toolbar === 'page');
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
