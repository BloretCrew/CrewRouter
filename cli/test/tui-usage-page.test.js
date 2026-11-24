'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

const makeRuntime = () => ({ client: { get: async () => ({ summary: {}, daily: [], byModel: [], byApiKey: [], byProvider: [], bySource: [] }) }, cfg: { tui: { days: 30 } }, profileName: 'test' });
const page = runtime => buildPages(runtime).find(item => item.id === 'usage');

test('usage tabs request latency, message and log data with shared filters', async () => {
  const runtime = makeRuntime();
  const calls = [];
  runtime.client.get = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/user/stats') return { summary: {}, daily: [], byModel: [], byApiKey: [], byProvider: [], bySource: [] }; return {}; };
  const usage = page(runtime);
  usage.onTabChange({ id: 'latency' });
  await usage.load();
  usage.onTabChange({ id: 'messages' });
  await usage.load();
  usage.onTabChange({ id: 'logs' });
  await usage.load();
  assert.deepEqual(calls.map(call => call.path), [
    '/api/user/stats', '/api/user/stats/latency',
    '/api/user/stats', '/api/user/message-stats',
    '/api/user/stats', '/api/user/usage-logs',
  ]);
});

test('usage filters action stores model/provider/client selections', async () => {
  const runtime = makeRuntime();
  runtime.client.get = async path => path === '/api/user/stats/filters'
    ? { models: [{ id: 'm1', name: 'Model One' }], providers: [{ id: 'p1', name: 'Provider One' }], sources: [{ id: 'codex', name: 'Codex' }] }
    : { summary: {}, daily: [], byModel: [], byApiKey: [], byProvider: [], bySource: [] };
  const usage = page(runtime);
  const action = (await usage.load()).actions.find(item => item.label === '时间范围与筛选');
  const picks = ['m1', 'p1', 'codex'];
  let refreshes = 0;
  await action.run({ choose: async () => picks.shift(), refresh: async () => { refreshes++; } });
  assert.deepEqual(runtime.usageFilters, { model_id: 'm1', provider_id: 'p1', request_source: 'codex' });
  assert.equal(refreshes, 1);
});
