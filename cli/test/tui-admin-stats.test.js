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
    if (path === '/api/admin/stats') return { users: 2, models: 3, apiKeys: 4, daily: [{ date: '2026-11-24', requests: 2, prompt_tokens: 5, completion_tokens: 7, tokens: 12, cost: 1.5 }], byModel: [{ model_name: 'm1', requests: 2, tokens: 3, cost: 1.5, avg_latency: 40 }], byProvider: [{ provider_name: 'p1', requests: 1, tokens: 2 }], bySource: [{ request_source: 'codex', requests: 1, tokens: 2 }], byUser: [{ user_name: 'alice', requests: 1, tokens: 2 }], byTeam: [{ team_name: 'Team', requests: 1, tokens: 2 }] };
    if (path === '/api/admin/stats/latency') return { summary: { requests: 4, measuredRequests: 3, coverage: .75, e2e: { p50: 40, p95: 90 }, ttft: { p95: 20 } }, daily: [{ date: '2026-11-24', requests: 2, e2e: { p95: 80 }, ttft: { p95: 15 }, outputTps: { p50: 40 } }] };
    return {};
  };
  const page = buildPages(runtime).find(item => item.id === 'admin-stats');
  assert.deepEqual(page.tabs.map(tab => tab.id), ['overview', 'latency', 'multi', 'daily', 'models', 'providers', 'clients', 'members', 'messages', 'logs']);
  page.onTabChange({ id: 'overview' });
  const overview = await page.load(api);
  assert.deepEqual(overview.sections[0].cards.map(card => card.label), ['总请求数', '总 Token 消耗', '总积分消耗', '活跃模型']);
  assert.deepEqual(overview.sections[0].cards.map(card => card.value), ['2', '12', '1.50 积分', '1']);
  assert.equal(overview.sections[0].cards[0].detail, '日均 2 次');
  assert.equal(overview.sections[0].cards[3].detail, '供应商 1');
  assert.ok(overview.actions.some(action => action.label === '最近 1 年'));
  page.onTabChange({ id: 'latency' });
  const data = await page.load(api);
  assert.ok(calls.some(call => call.path === '/api/admin/stats/latency'));
  assert.equal(data.sections[0].cards.find(card => card.label === '完整响应95%分位延迟（P95）').value, '90');
  assert.ok(data.sections[0].toolbar);
  assert.ok(data.actions.some(action => action.label === '最近 7 天' && action.toolbar === true));
  page.onTabChange({ id: 'models' });
  const modelData = await page.load(api);
  const modelSection = modelData.sections[0];
  assert.deepEqual(modelSection.columns.map(column => column.label), ['名称', '请求数', 'Token 用量', '费用（积分）', '平均响应时间']);
  assert.deepEqual(modelSection.rows[0].cells, { name: 'm1', requests: '2 次', tokens: '3 Token', cost: '1.5000 积分', latency: '40 毫秒' });
});

test('admin stats mirrors web multi, messages and logs tabs with API filters and details', async () => {
  const runtime = makeRuntime();
  const calls = [];
  runtime.adminStatsTab = 'multi';
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/stats') return { daily: [] };
    if (path === '/api/admin/stats/multi' && options.query?.data_source === 'quota') return { data_source: 'quota', dimensions: ['provider', 'account'], metric: 'remaining', rows: [{ labels: ['Provider One', 'Main Account'], values: ['p1', 'a1'], value: 4.5, unit: 'credits', kind: 'balance', status: 'success', observed_at: '2026-11-25T00:00:00Z', account_ids: ['a1'], coverage: { start: '2026-11-01', end: '2026-11-25' } }], coverage: { start: '2026-11-01', end: '2026-11-25', samples: 12, caveats: ['额度是上游独立观测值。'] }, provider_quota: { summary: { accounts: 1 }, accounts: [{ provider_id: 'p1', provider_name: 'Provider One', account_id: 'a1', label: 'Main Account', kind: 'balance', unit: 'credits', total: 10, used: 5.5, remaining: 4.5, status: 'success', observed_at: '2026-11-25T00:00:00Z' }], coverage: { start: '2026-11-01', end: '2026-11-25', samples: 12, caveats: ['额度是上游独立观测值。'] } } };
    if (path === '/api/admin/stats/multi') return { summary: { requests: 10, tokens: 200, cost: 3, active_users: 2, active_projects: 1, active_models: 3, active_providers: 2 }, relationships: { user_project: [{ left: 'alice', right: '/work/a', requests: 8, tokens: 160, cost: 2 }] }, caveats: ['Team 按当前归属统计。'] };
    if (path === '/api/admin/stats/multi/filters') return { users: [{ id: 9, name: 'alice' }], teams: [{ id: 2, name: 'Team A' }], models: [{ id: 'm1', name: 'Model One' }], providers: [{ id: 'p1', name: 'Provider One' }], sources: [{ id: 'codex', name: 'Codex' }], projects: [{ id: '/work/a', name: '/work/a' }] };
    if (path === '/api/admin/message-stats') return { summary: { requests: 5, analyzed_requests: 4, total_messages: 12, total_tokens: 250, total_cost: 2.5, metadata_rate: 0.5 }, by_block: [{ block: 'git_status', requests: 2, occurrences: 3, tokens: 100, cost: 1 }], by_source: [{ request_source: 'codex', requests: 2, messages: 6, tokens: 120 }] };
    if (path === '/api/admin/usage-logs') return { page: 1, total: 31, logs: [{ id: 41, user_id: 9, username: 'alice', created_at: '2026-11-24T00:00:00Z', model_name: 'Model One', provider_name: 'Provider One', request_source: 'codex', tokens_used: 100, cost: 0.5, latency_ms: 30 }] };
    if (path === '/api/admin/usage-logs/41') return { log: { id: 41, user_id: 9, username: 'alice', model_name: 'Model One', upstream_model_id: 'up-1', provider_name: 'Provider One', request_type: 'chat', request_source: 'codex', tokens_used: 100, prompt_tokens: 80, completion_tokens: 20, cached_tokens: 10, cost: 0.5, latency_ms: 30, is_stream: true, ttft_ms: 10, output_tps: 12 } };
    if (path === '/api/admin/stats/multi-dimension') return options.query?.quota_mode === 'member_estimate' ? { dimensions: ['user', 'provider'], metric: 'tokens', quota_mode: 'member_estimate', quota_estimates: [{ user_name: 'alice', provider_name: 'Provider One', kind: 'balance', unit: 'credits', estimated_value: 8.25, estimated_percent: 16.5, share_label: 'Token' }], quota_estimate_status: 'ok', quota_estimate_caveat: '按同一供应商内占比估算。', rows: [{ labels: ['alice', 'Provider One'], requests: 4, tokens: 120, cost: 1.2 }] } : { dimensions: ['model'], metric: 'tokens', rows: [{ labels: ['Model One'], requests: 4, tokens: 120, cost: 1.2 }] };
    return {};
  };
  const page = buildPages(runtime).find(item => item.id === 'admin-stats');
  let multi = await page.load(api);
  assert.ok(multi.sections[0].rows.some(row => /alice → \/work\/a/.test(row.label)));
  const filterAction = multi.actions.find(action => action.label === '筛选关联分析');
  const choices = ['team_id', '2'];
  await filterAction.run({ api, choose: async () => choices.shift(), refresh: async () => {} });
  assert.equal(runtime.adminStatsMultiFilters.team_id, '2');
  const dimAction = multi.actions.find(action => action.label === '选择维度与指标');
  const dimensions = ['model', '__done__'];
  await dimAction.run({ choose: async title => {
    if (title.startsWith('统计维度')) return dimensions.shift();
    if (title === '分析数据源') return 'usage';
    if (title === '统计指标') return 'tokens';
    if (title.includes('叠加供应商额度')) return false;
    return null;
  }, refresh: async () => {} });
  assert.deepEqual(runtime.adminStatsDimensionQuery, { dimensions: 'model', metric: 'tokens', data_source: 'usage', days: 30 });
  await page.load(api);
  assert.ok(calls.some(call => call.path === '/api/admin/stats/multi-dimension' && call.options.query.dimensions === 'model'));
  const estimateChoices = ['user', '__done__'];
  const chooseEstimate = async (title, options) => {
    if (title.startsWith('统计维度')) return estimateChoices.shift();
    if (title === '统计指标') return 'tokens';
    if (title.includes('叠加供应商额度')) return true;
    if (title === '成员额度展示方式') return 'member_estimate';
    if (title === '统计数据来源') return 'usage';
    return options[0]?.value;
  };
  const estimateAction = multi.actions.find(action => action.label === '选择维度与指标');
  await estimateAction.run({ choose: chooseEstimate, refresh: async () => {} });
  assert.equal(runtime.adminStatsDimensionQuery.quota_mode, 'member_estimate');
  await page.load(api);
  const estimateSection = (await page.load(api)).sections[0];
  assert.ok(estimateSection.rows.some(row => /成员额度估算：1 条/.test(row.label)));
  assert.ok(estimateSection.rows.some(row => /不是实际个人账单/.test(row.detail || row.label)));
  assert.equal(calls.filter(call => call.path === '/api/admin/stats/multi-dimension' && call.options.query.quota_mode === 'member_estimate').length > 0, true);
  assert.ok(estimateSection.rows.find(row => /估算使用/.test(row.detail || '')).detail.includes('16.5% [██░░░░░░░░]'));
  assert.ok(estimateSection.rows.some(row => String(row.detail || '').includes('[████████████████]')));
  runtime.adminStatsDimensionQuery = { dimensions: 'model', metric: 'tokens', data_source: 'usage', days: 30 };
  const limitedPage = await page.load(async (path, options = {}) => { if (path === '/api/admin/stats/multi-dimension') throw new Error('企业版功能不可用'); return api(path, options); });
  assert.ok(limitedPage.sections[0].rows.some(row => /自选维度分析不可用/.test(row.label)));
  const quotaAction = multi.actions.find(action => action.label === '选择维度与指标');
  let usageDimensionChoice = 0; const quotaDimensions = ['provider', 'account', '__done__'];
  await quotaAction.run({ confirm: async () => true, choose: async title => {
    if (title.startsWith('统计维度')) return usageDimensionChoice++ === 0 ? 'provider' : '__done__';
    if (title === '分析数据源') return 'quota';
    if (title.startsWith('额度维度')) return quotaDimensions.shift();
    if (title === '额度统计指标') return 'remaining';
    return null;
  }, refresh: async () => {} });
  assert.deepEqual(runtime.adminStatsQuotaQuery, { dimensions: 'provider,account', metric: 'remaining', data_source: 'quota', days: 30 });
  const quotaPage = await page.load(api);
  assert.equal(quotaPage.sections[0].title, '供应商额度多维分析');
  assert.match(quotaPage.sections[0].rows[1].label, /Provider One · Main Account · 余额额度/);
  assert.match(quotaPage.sections[0].rows[1].detail, /4.5 credits/);
  assert.match(quotaPage.sections[0].rows[1].detail, /已用 5.5 \/ 总额 10 \/ 剩余 4.5 credits/);
  assert.ok(quotaPage.sections[0].rows[1].detail.includes('使用率 55.0% [██████░░░░]'));
  assert.match(quotaPage.sections[0].rows[1].detail, /查询状态：success/);
  assert.ok(quotaPage.sections[0].rows.some(row => /上游独立观测值/.test(row.label)));
  assert.ok(calls.some(call => call.path === '/api/admin/stats/multi' && call.options.query.data_source === 'quota' && call.options.query.dimensions === 'provider,account'));
  await quotaPage.actions.find(action => action.label === '最近 7 天').run({ refresh: async () => {} });
  assert.equal(runtime.adminStatsQuotaQuery.days, 7, 'range buttons update the active quota query');
  const invalidQuotaDimensions = ['provider', '__done__', 'used_percent'];
  let invalidQuotaMessage = '';
  await quotaPage.actions.find(action => action.label === '查询供应商额度维度').run({ choose: async () => invalidQuotaDimensions.shift(), show: async (_title, message) => { invalidQuotaMessage = message; } });
  assert.match(invalidQuotaMessage, /必须包含“额度账户”维度/);
  assert.equal(runtime.adminStatsQuotaQuery.dimensions, 'provider,account', 'invalid metric selection leaves the active quota query unchanged');

  runtime.adminStatsTab = 'messages';
  const messages = await page.load(api);
  assert.ok(messages.sections[0].cards.some(card => card.label === '已分析请求数'));
  assert.match(messages.sections[0].rows[0].label, /git status/);

  runtime.adminStatsTab = 'logs';
  runtime.adminStatsLogPage = 1;
  const logs = await page.load(api);
  assert.equal(logs.sections[0].rows[0].cells.user, 'alice');
  assert.equal(logs.actions.find(action => action.label === '调用记录下一页').disabled, false);
  let details = '';
  await logs.sections[0].rows[0].run({ api, show: async (_title, content) => { details = content; } });
  assert.match(details, /缓存命中：10（12.5%）/);
  assert.doesNotMatch(details, /"model_name"/);
  assert.ok(calls.some(call => call.path === '/api/admin/usage-logs/41'));
  assert.ok(logs.actions.some(action => action.label === '筛选调用记录'));
});

test('admin stats date selection is explicit and includes 365 days', async () => {
  const runtime = makeRuntime();
  const page = buildPages(runtime).find(item => item.id === 'admin-stats');
  const api = async () => ({ users: 0, models: 0, apiKeys: 0, daily: [] });
  const data = await page.load(api);
  assert.ok(data.actions.some(action => action.label === '最近 1 年'));
  assert.equal(data.actions.some(action => action.label === '最近 365 天'), false);
});
