'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

function makeRuntime() {
  const calls = [];
  const runtime = { client: { get: async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/stats') return { summary: {}, daily: [], hourly: [], byModel: [], byApiKey: [], byProvider: [], bySource: [] };
    if (path === '/api/user/stats/multi-dimension') return { data_source: options.query.data_source, dimensions: options.query.dimensions.split(','), metric: 'tokens', rows: [{ labels: options.query.dimensions.split(',').map(dimension => ({ source: 'codex', model: 'Model One', provider: 'p1', key: 'k1' })[dimension]), requests: 4, tokens: 2500, cost: 1.25, quality: { event: 'backfill' } }], provider_quota: { accounts: [] } };
    if (path === '/api/user/providers/quota') return { providers: [{ id: 'p1', name: 'Provider One', accounts: [{ account_id: 'a1', label: 'Main account', unit: 'credits' }] }] };
    return {};
  } }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  return { runtime, calls };
}

test('usage page includes the web multi-dimension tab and renders the web result columns', async () => {
  const { runtime, calls } = makeRuntime();
  const page = buildPages(runtime).find(item => item.id === 'usage');
  assert.deepEqual(page.tabs.map(tab => tab.id), ['overview', 'multi', 'daily', 'hourly', 'models', 'providers', 'keys', 'sources', 'latency', 'messages', 'logs']);
  page.onTabChange({ id: 'multi' });
  const initial = await page.load();
  const setup = initial.actions.find(action => action.label === '设置多维分析');
  const picks = ['usage', 'source', 'model', 'provider', 'key', null, 'tokens', false];
  await setup.run({ api: (path, options) => runtime.client.get(path, options), choose: async () => picks.shift(), confirm: async () => true, refresh: async () => {} });
  const request = calls.find(call => call.path === '/api/user/stats/multi-dimension');
  assert.deepEqual(request.options.query, { days: 30, dimensions: 'source,provider,key', metric: 'tokens', data_source: 'usage' });
  const resultPage = await page.load();
  const result = resultPage.sections.find(section => section.tab === 'multi');
  assert.deepEqual(result.columns.map(column => column.label), ['客户端 / 供应商 / 密钥', 'Token', '数据质量']);
  assert.deepEqual(result.rows[0].cells, { dimensions: 'Codex / p1 / k1', metric: '2.5K Token', quality: '历史回补' });
});

test('usage multi-dimension quota query uses quota-specific metrics and renders quota units', async () => {
  const { runtime, calls } = makeRuntime();
  runtime.client.get = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/stats') return { summary: {}, daily: [], hourly: [], byModel: [], byApiKey: [], byProvider: [], bySource: [] };
    if (path === '/api/user/stats/multi-dimension') return { data_source: 'quota', dimensions: ['provider', 'account'], metric: 'remaining', rows: [{ labels: ['Provider One', 'Main account'], values: ['p1', 'a1'], value: 125, unit: 'credits', status: 'success' }] };
    if (path === '/api/user/providers/quota') return { providers: [{ id: 'p1', name: 'Provider One', accounts: [{ account_id: 'a1', label: 'Main account', unit: 'credits' }] }] };
    return {};
  };
  const page = buildPages(runtime).find(item => item.id === 'usage');
  page.onTabChange({ id: 'multi' });
  const initial = await page.load();
  const picks = ['quota', 'provider', 'account', null, 'remaining', '', '', '', '', '', ''];
  await initial.actions.find(action => action.label === '设置多维分析').run({ api: (path, options) => runtime.client.get(path, options), choose: async () => picks.shift(), confirm: async () => true, refresh: async () => {} });
  const query = calls.find(call => call.path === '/api/user/stats/multi-dimension').options.query;
  assert.equal(query.data_source, 'quota');
  assert.equal(query.metric, 'remaining');
  const section = (await page.load()).sections.find(item => item.tab === 'multi');
  assert.deepEqual(section.columns.map(column => column.label), ['供应商 / 额度账户', '剩余额度', '数据质量']);
  assert.equal(section.rows[0].cells.metric, '125 credits');
  assert.equal(section.rows[0].cells.quality, '正常');
});
