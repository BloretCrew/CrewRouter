'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

test('session row opens cached summary through the web read endpoint', async () => {
  const runtime = { client: { get: async path => ({ summary: 'cached summary', createdAt: '2026-11-20T00:00:00Z', path }) }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const page = buildPages(runtime).find(item => item.id === 'sessions');
  runtime.client.get = async path => path === '/api/user/sessions' ? { items: [{ sessionKey: 'session-1', harness: 'codex', requestCount: 2, totalTokens: 100, models: ['m1'] }], page: 1, total: 1 } : { summary: 'cached summary', createdAt: '2026-11-20T00:00:00Z' };
  const data = await page.load();
  let shown;
  await data.sections[0].rows[0].run({ choose: async () => 'summary', show: async (_title, content) => { shown = content; } });
  assert.match(shown, /cached summary/);
});
