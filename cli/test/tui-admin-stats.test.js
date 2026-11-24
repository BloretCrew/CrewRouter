'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

function makeRuntime() { return { client: { isAdmin: true }, cfg: { tui: { days: 30 } }, profileName: 'test' }; }

test('admin stats tabs expose web dimensions and latency endpoint', async () => {
  const runtime = makeRuntime();
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/stats') return { users: 2, models: 3, apiKeys: 4, daily: [], byModel: [{ model_name: 'm1', requests: 2, tokens: 3 }], byProvider: [{ provider_name: 'p1', requests: 1, tokens: 2 }], bySource: [{ request_source: 'codex', requests: 1, tokens: 2 }], byUser: [{ user_name: 'alice', requests: 1, tokens: 2 }], byTeam: [{ team_name: 'Team', requests: 1, tokens: 2 }] };
    if (path === '/api/admin/stats/latency') return { summary: { requests: 4, measuredRequests: 3, coverage: .75, e2e: { p50: 40, p95: 90 }, ttft: { p95: 20 } }, daily: [{ date: '2026-11-24', requests: 2, e2e: { p95: 80 }, ttft: { p95: 15 }, outputTps: { p50: 40 } }] };
    return {};
  };
  const page = buildPages(runtime).find(item => item.id === 'admin-stats');
  assert.deepEqual(page.tabs.map(tab => tab.id), ['overview', 'daily', 'models', 'providers', 'sources', 'users', 'teams', 'latency']);
  page.onTabChange({ id: 'latency' });
  const data = await page.load(api);
  assert.ok(calls.some(call => call.path === '/api/admin/stats/latency'));
  assert.equal(data.sections[0].cards.find(card => card.label === '端到端 P95').value, '90');
});

test('admin stats date selection is explicit and includes 365 days', async () => {
  const runtime = makeRuntime();
  const page = buildPages(runtime).find(item => item.id === 'admin-stats');
  const api = async () => ({ users: 0, models: 0, apiKeys: 0, daily: [] });
  const data = await page.load(api);
  assert.ok(data.actions.some(action => action.label === '最近 365 天'));
});
