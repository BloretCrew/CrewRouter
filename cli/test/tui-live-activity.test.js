'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

test('usage live activity is a one-shot session-authenticated snapshot', async () => {
  const calls = [];
  const runtime = { client: { get: async path => { calls.push(path); if (path === '/api/user/stats') return { summary: {}, daily: [], byModel: [], byProvider: [], byApiKey: [], bySource: [] }; return { window: 300, sources: [{ harness: 'codex', active_sessions: 1, tool_calls: 3, failure_count: 0 }], machines: {} }; } }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const page = buildPages(runtime).find(item => item.id === 'usage');
  const data = await page.load(async (path, options = {}) => { calls.push(path); return path === '/api/client-events/live' ? { window: options.query.window, sources: [{ harness: 'codex', active_sessions: 1, tool_calls: 3, failure_count: 0 }], machines: {} } : {}; });
  const action = data.actions.find(item => item.label === '查看实时活动快照');
  await action.run({ choose: async () => null, show: async () => {} });
  assert.equal(calls.includes('/api/client-events/live'), false);
  let shown = '';
  let title = '';
  await action.run({ choose: async () => 300, show: async (label, body) => { title = label; shown = body; } });
  assert.ok(calls.includes('/api/client-events/live'));
  assert.match(shown, /Codex/);
  assert.match(title, /一次性/);
});
