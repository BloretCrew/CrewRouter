'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');
const { runPagedTui } = require('../tui/engine');
const { terminal, until } = require('./helpers/tty');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const makeRuntime = () => ({ client: { get: async () => ({ summary: {}, daily: [], byModel: [], byApiKey: [], byProvider: [], bySource: [] }) }, cfg: { tui: { days: 30 } }, profileName: 'test' });
const page = runtime => buildPages(runtime).find(item => item.id === 'usage');

test('usage overview TUI places date and filter controls before statistics content', { timeout: 15000 }, async () => {
  const runtime = makeRuntime();
  const usage = page(runtime);
  const tty = terminal(160, 48);
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api: async () => ({}), pages: [usage], authenticate: async () => true });
  try {
    await until(() => tty.screen().includes('最近 30 天'));
    const screen = tty.screen();
    const toolbar = screen.indexOf('筛选与操作');
    const customRange = screen.indexOf('自定义日期范围');
    const reset = screen.indexOf('重置筛选与日期');
    const filters = screen.indexOf('时间范围与筛选');
    const overview = screen.indexOf('统计概览');
    assert.ok(toolbar >= 0 && customRange > toolbar && reset > customRange && filters > reset && overview > filters, `overview filter controls must precede statistics sections: ${toolbar},${customRange},${reset},${filters},${overview}`);
  } finally { tty.input.write('q'); await task; }
});

test('usage tabs request latency, message and log data with shared filters', async () => {
  const runtime = makeRuntime();
  const calls = [];
  runtime.client.get = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/user/usage-logs/export' && options.raw) return { statusCode: 200, headers: { 'content-type': 'text/csv; charset=utf-8' }, text: '\\uFEFF时间,模型\\n今天,Model One' }; if (path === '/api/user/stats') return { summary: { total_requests: 20, total_tokens: 2000, total_prompt_tokens: 1200, total_completion_tokens: 800, total_cached_tokens: 300, total_cost: 10, avg_latency: 40, identified_rate: 0.9, known_requests: 18, unknown_requests: 2, active_sources: 1 }, daily: Array.from({ length: 14 }, (_, index) => ({ date: `2026-11-${String(index + 1).padStart(2, '0')}`, requests: 3, prompt_tokens: 10, completion_tokens: 20, tokens: 30, cost: index < 7 ? 1 : 2 })), hourly: [{ hour: 9, requests: 4, tokens: 120, cached_tokens: 20, cost: 0.4 }, { hour: 10, requests: 2, tokens: 60, cached_tokens: 10, cost: 0.2 }], byModel: [{ model_name: 'Model One', requests: 2, tokens: 10, prompt_tokens: 8, completion_tokens: 2, cached_tokens: 4, avg_latency: 42, cost: 0.25 }, { model_name: 'Model Two', requests: 1, tokens: 5, prompt_tokens: 4, completion_tokens: 1, cached_tokens: 0, avg_latency: 20, cost: 0.1 }], byApiKey: [{ key_name: 'Main Key', key_prefix: 'cr_live_', requests: 1, tokens: 5, cached_tokens: 2, cost: 0.1 }, { key_name: 'Old Key', key_prefix: null, requests: 3, tokens: 20, cached_tokens: 0, cost: 0.5 }], byProvider: [{ provider_name: 'Provider One', requests: 1, tokens: 7, cost: 0.2 }], bySource: [{ request_source: 'codex', requests: 12, share_requests: 60, tokens: 600, prompt_tokens: 500, completion_tokens: 100, cached_tokens: 200, avg_latency: 125.6, cost: 0.15 }, { request_source: 'claude_code', requests: 8, share_requests: 40, tokens: 400, prompt_tokens: 300, completion_tokens: 100, cached_tokens: 50, avg_latency: 80, cost: 0.15 }], bySourceModel: [{ request_source: 'codex', model_name: 'Model One', requests: 10, tokens: 500, cost: 0.12 }, { request_source: 'claude_code', model_name: 'Model Two', requests: 5, tokens: 200, cost: 0.05 }] }; if (path === '/api/user/stats/latency') return { window: { start: '2026-11-01', end: '2026-11-25', timezone: 'Asia/Shanghai' }, coverage: { totalRequests: 20, measuredRequests: 10, rate: 0.5 }, summary: { requests: 20, measuredRequests: 10, coverage: 0.5, ttft: { p50: 24, p75: 40, p95: 80, p99: 100 }, e2e: { p95: 120 }, tpot: { p50: 2.5 }, outputTps: { p50: 12, ge50: 0.3 }, cacheHitRate: 0.25, upstreamProcessingAvg: 30, tpsThresholds: { ge50: 0.3, ge80: 0.2, ge90: 0.1, ge100: 0.05 } }, byModel: [{ name: 'Model One', requests: 12, measuredRequests: 8, coverage: 2 / 3, ttft: { p50: 20, p75: 30, p95: 60, p99: 90 }, tpot: { p50: 2.5 }, outputTps: { p50: 12.25 }, e2e: { p95: 110 }, cacheHitRate: 0.25 }], rateLimits: [{ providerId: 'p1', providerName: 'Provider One', rateLimit: { requests_remaining: 10, tokens_remaining: 100 }, serviceTier: 'standard', observedAt: '2026-11-25T00:00:00Z' }], daily: [{ date: 'today', requests: 10, measuredRequests: 8, ttft: { p50: 24, p95: 80 }, e2e: { p95: 120 }, outputTps: { p50: 12 } }] }; if (path === '/api/user/message-stats') return { summary: { requests: 12, analyzed_requests: 10, total_tokens: 2000, total_cost: 3, metadata_rate: 0.5, git_rate: 0.25, peak_day: { date: '2026-11-24', requests: 4 }, analysis_status: { pending_requests: 2, enabled: true } }, by_workspace: [{ workspace_path: '/work/repo', requests: 4, tokens: 1500, cost: 2, characters: 900, sources: { codex: 3 } }], daily: [{ date: '2026-11-24', requests: 4, messages: 8, tokens: 1500, git_requests: 2 }], by_block: [{ block: 'git_status', requests: 3, occurrences: 4, tokens: 1000, cost: 1.2 }], by_source: [{ request_source: 'codex', requests: 2, messages: 10, characters: 400, tokens: 1000 }] }; if (path === '/api/user/usage-logs') return { page: 1, total: 1, logs: [{ id: 42, created_at: '2026-11-24T00:00:00Z', model_name: 'Model One', series: 'S', request_source: 'codex', key_prefix: 'cr_live_', key_name: 'Main', tokens_used: 100, cached_tokens: 15, cost: 0.5 }] }; if (path === '/api/user/usage-logs/42') return { log: { id: 42, created_at: '2026-11-24T00:00:00Z', model_name: 'Model One', upstream_model_id: 'up-1', provider_name: 'Provider One', request_type: 'chat', request_source: 'codex', key_prefix: 'abcd', key_name: 'Main', tokens_used: 100, prompt_tokens: 80, completion_tokens: 20, cached_tokens: 30, latency_ms: 25, is_stream: true, ttft_ms: 10, tpot_ms: 2, output_tps: 12, cost: 0.5 } }; return {}; };
  const usage = page(runtime);
  const overview = await usage.load();
  assert.deepEqual(overview.sections.slice(0, 8).map(section => section.title), ['统计概览', 'Prompt 缓存命中', '今日与昨日对比', '最常用模型', '高峰时段', '积分消耗趋势', '关键指标', '客户端来源']);
  assert.ok(overview.sections[0].cards.some(card => card.label === '总请求数' && card.detail.startsWith('日均')));
  assert.ok(overview.sections[1].cards.some(card => card.label === '缓存命中率' && card.value === '25.0%'));
  assert.ok(overview.sections[2].cards.some(card => card.label.startsWith('今日请求')));
  assert.ok(overview.sections[3].rows.some(row => row.label.includes('Model One')));
  assert.ok(overview.sections[4].rows.some(row => row.label.includes('09:00')));
  assert.ok(overview.sections[5].rows.some(row => row.cells.cost_bar));
  assert.ok(overview.sections[6].rows.some(row => row.label === '平均 Token/请求'));
  assert.ok(overview.sections[7].rows.some(row => row.label.includes('Codex') && row.detail.includes('████████████████████')));
  assert.equal(overview.sections[8].title, '插件维度');
  usage.onTabChange({ id: 'latency' });
  const latencyData = await usage.load();
  const latencySection = latencyData.sections.find(section => section.tab === 'latency');
  assert.equal(latencySection.title, '延迟指标说明');
  assert.match(latencySection.rows[1].label, /2026-11-01 至 2026-11-25 · 时区 Asia\/Shanghai/);
  const latencyCards = latencyData.sections.find(section => section.title === '延迟与吞吐摘要');
  assert.deepEqual(latencyCards.cards.slice(0, 5).map(card => card.label), ['TTFT P50', 'TTFT P95', '输出速度 P50', 'TPOT P50', 'E2E P95']);
  assert.equal(latencyCards.cards[0].value, '24 毫秒');
  assert.equal(latencyCards.cards[1].value, '80 毫秒');
  assert.equal(latencyCards.cards[4].value, '120 毫秒');
  assert.deepEqual(latencyCards.cards.slice(5).map(card => card.label), ['缓存命中率', '上游处理时间均值', '吞吐达标率']);
  assert.equal(latencyCards.cards[5].value, '25.0%');
  assert.equal(latencyCards.cards[6].value, '30 毫秒');
  assert.equal(latencyCards.cards[7].value, '≥50：30.0% · ≥80：20.0% · ≥90：10.0% · ≥100：5.0%');
  assert.match(latencySection.rows[2].label, /已采集 10 \/ 20 条请求（50\.0%）/);
  const latencyModelSection = latencyData.sections.find(section => section.title === '模型延迟与吞吐');
  assert.deepEqual(latencyModelSection.columns.map(column => column.label), ['模型', '请求数', '已采集', 'TTFT P50', 'TTFT P75', 'TTFT P95', 'TTFT P99', 'TPOT P50', '输出 TPS P50', 'E2E P95', '缓存命中']);
  assert.equal(latencyModelSection.rows[0].cells.tps50, '12.25 Token/秒');
  assert.match(latencyModelSection.rows[0].cells.measured, /66\.7%/);
  const rateLimitSection = latencyData.sections.find(section => section.title === '最近一次上游限流状态');
  assert.match(rateLimitSection.rows[0].detail, /剩余请求 10 · 剩余 Token 100/);
  assert.ok(latencyModelSection.columns.length === 11);
  usage.onTabChange({ id: 'daily' });
  const dailySection = (await usage.load()).sections.find(section => section.tab === 'daily');
  assert.deepEqual(dailySection.columns.map(column => column.label), ['日期', '请求数', 'Prompt Token', 'Completion Token', '缓存命中', '积分', '平均延迟']);
  assert.equal(dailySection.rows[0].cells.input, '10');
  assert.equal(dailySection.rows[0].cells.cached, '0 Token');
  assert.equal(dailySection.rows[0].cells.latency, '0 毫秒');
  usage.onTabChange({ id: 'hourly' });
  const hourlySection = (await usage.load()).sections.find(section => section.tab === 'hourly');
  assert.equal(hourlySection.rows.length, 24);
  assert.deepEqual(hourlySection.columns.map(column => column.label), ['小时', '请求数', '请求分布', 'Token', 'Token 分布']);
  assert.deepEqual(hourlySection.rows[9].cells, { hour: '09:00', requests: '4', requests_bar: '[████████████]', tokens: '120', tokens_bar: '[████████]' });
  assert.match(hourlySection.description, /请求高峰 09:00（4 次）/);
  assert.match(hourlySection.description, /Token 高峰 09:00（120 Token）/);
  usage.onTabChange({ id: 'models' });
  const modelData = await usage.load();
  const modelSection = modelData.sections.find(section => section.tab === 'models');
  assert.deepEqual(modelSection.columns.map(column => column.label), ['模型', '请求数', 'Prompt Token', 'Completion Token', '缓存命中', '积分', '平均延迟']);
  assert.deepEqual(modelSection.rows[0].cells, { model: 'Model One', requests: '2', prompt: '8', completion: '2', cached: '4 (50.0%)', cost: '0.2500', latency: '42 毫秒' });
  assert.ok(modelData.actions.some(action => action.label === '时间范围与筛选' && action.toolbar === 'page'));
  assert.ok(modelData.pageToolbar);
  usage.onTabChange({ id: 'keys' });
  const keyData = await usage.load();
  const keySection = keyData.sections.find(section => section.tab === 'keys');
  assert.deepEqual(keySection.columns.map(column => column.label), ['密钥名称', '前缀', '请求数', 'Token', '缓存命中', '积分']);
  assert.deepEqual(keySection.rows[0].cells, { name: 'Main Key', prefix: 'cr_live_****', requests: '1', tokens: '5', cached: '2', cost: '0.1000' });
  assert.deepEqual(keySection.rows[1].cells, { name: 'Old Key', prefix: '—', requests: '3', tokens: '20', cached: '—', cost: '0.5000' });
  usage.onTabChange({ id: 'sources' });
  const sourceData = await usage.load();
  const sourceInfo = sourceData.sections.find(section => section.tab === 'sources' && section.title === '客户端分析说明');
  assert.match(sourceInfo.description, /harness 客户端汇总用量/);
  const sourceSection = sourceData.sections.find(section => section.tab === 'sources' && section.title === '客户端详细数据');
  assert.deepEqual(sourceSection.columns.map(column => column.label), ['客户端', '请求数', '占比', 'Token', 'Prompt', 'Completion', '缓存', '积分', '平均延迟', '操作']);
  assert.deepEqual(sourceSection.rows[0].cells, { client: 'Codex', requests: '12', share: '60.0% [██████████]', tokens: '600', prompt: '500', completion: '100', cached: '200', cost: '0.1500', latency: '126 毫秒', actions: '筛选 / 记录' });
  assert.ok(sourceData.sections.some(section => section.tab === 'sources' && section.title === '客户端 × 模型'));
  await sourceSection.rows[0].run({ choose: async () => 'filter', refresh: async () => {} });
  assert.equal(runtime.usageFilters.request_source, 'codex');
  await sourceSection.rows[0].run({ choose: async () => 'logs', refresh: async () => {} });
  assert.equal(runtime.usageTab, 'logs');
  assert.equal(runtime.usageLogFilters.request_source, 'codex');
  usage.onTabChange({ id: 'messages' });
  const messages = await usage.load();
  const messageSections = messages.sections.filter(section => section.tab === 'messages');
  assert.deepEqual(messageSections.slice(0, 4).map(section => section.title), ['项目活跃趋势', '消息读取概要', '项目结构区块', 'Harness 消息结构']);
  assert.ok(messageSections[0].rows.some(row => row.detail.includes('Token')));
  assert.ok(messageSections[1].rows.some(row => row.label === '总 Token' && row.detail === '2.0K Token'));
  assert.ok(messageSections[1].rows.some(row => row.label === 'Git 状态率' && row.detail === '25.0%'));
  assert.ok(messageSections[1].rows.some(row => row.label === '后台待分析：2 个请求'));
  assert.deepEqual(messageSections[2].columns.map(column => column.label), ['区块', '请求数', '出现次数']);
  assert.equal(messageSections[2].rows[0].cells.block, 'git_status');
  assert.equal(messageSections[2].rows[0].cells.occurrences, '4');
  assert.deepEqual(messageSections[3].columns.map(column => column.label), ['Harness', '请求数', '平均消息', '平均字符', 'Token']);
  assert.equal(messageSections[3].rows[0].cells.source, 'Codex');
  assert.ok(messages.sections.some(section => section.title === '工作区明细' && section.rows.some(row => row.label === '/work/repo' && /4 次活跃请求.*2.0000 积分.*客户端 Codex/.test(row.detail))));
  usage.onTabChange({ id: 'logs' });
  const logData = await usage.load();
  const logSection = logData.sections.find(section => section.tab === 'logs');
  assert.deepEqual(logSection.columns.map(column => column.label), ['时间', '模型', '系列', '客户端', 'API Key', 'Token', '缓存命中', '积分']);
  assert.match(logSection.description, /每页 50 条/);
  const logRow = logSection.rows[0];
  assert.equal(logRow.cells.series, 'S');
  assert.equal(logRow.cells.key, 'cr_live_••••（Main）');
  assert.equal(logRow.cells.cached, '15 Token');
  let detail = '';
  await logRow.run({ api: async (path, options) => runtime.client.get(path, options), show: async (_title, body) => { detail = body; } });
  assert.match(detail, /输入 Token：80/);
  assert.match(detail, /缓存命中 Token：30（37.5%）/);
  assert.match(detail, /每输出 Token 耗时（TPOT）：2.0 毫秒/);
  assert.doesNotMatch(detail, /"model_name"|"cached_tokens"/);
  const filterAction = logData.actions.find(action => action.label === '筛选调用记录');
  const filterChoices = [{ name: 'model_q', value: 'Model One' }, { name: 'request_type', value: 'chat' }, { name: 'request_source', value: 'codex' }, { name: 'start_date', value: '2026-11-01' }, { name: 'end_date', value: '2026-11-07' }];
  await filterAction.run({ form: async () => Object.fromEntries(filterChoices.map(item => [item.name, item.value])), show: async () => {}, refresh: async () => {} });
  assert.deepEqual(runtime.usageLogFilters, { model_q: 'Model One', request_type: 'chat', request_source: 'codex', start_date: '2026-11-01', end_date: '2026-11-07' });
  assert.equal(calls.find(call => call.path === '/api/user/usage-logs').options.query.limit, 50);
  let invalidDateNotice = '';
  await filterAction.run({ form: async () => ({ model_q: '', request_type: '', request_source: '', start_date: '2026-11-01', end_date: '' }), show: async (_title, message) => { invalidDateNotice = message; }, refresh: async () => {} });
  assert.match(invalidDateNotice, /必须同时填写/);
  assert.equal(runtime.usageLogFilters.end_date, '2026-11-07', 'invalid query must not replace existing filters');
  await filterAction.run({ form: async () => ({ model_q: 'Model One', request_type: 'chat', request_source: 'codex', start_date: '', end_date: '', clear_dates: true }), show: async () => {}, refresh: async () => {} });
  assert.deepEqual(runtime.usageLogFilters, { model_q: 'Model One', request_type: 'chat', request_source: 'codex' }, 'clearing dates should preserve the other filters');
  const refreshedLogData = await usage.load();
  const clearAction = refreshedLogData.actions.find(action => action.label === '清除调用记录筛选');
  assert.equal(clearAction.disabled, false);
  await clearAction.run({ refresh: async () => {} });
  assert.deepEqual(runtime.usageLogFilters, {});
  assert.deepEqual(calls.map(call => call.path), [
    '/api/user/stats', '/api/user/stats', '/api/user/stats/latency',
    '/api/user/stats', '/api/user/stats', '/api/user/stats', '/api/user/stats', '/api/user/stats', '/api/user/stats',
    '/api/user/message-stats', '/api/user/stats', '/api/user/usage-logs', '/api/user/usage-logs/42', '/api/user/stats', '/api/user/usage-logs',
  ]);
});

test('usage CSV export honors filters and requires confirmation before replacing an existing file', async () => {
  const runtime = makeRuntime();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewrouter-logs-'));
  const destination = path.join(tempDir, 'usage.csv');
  const calls = [];
  runtime.usageTab = 'logs';
  runtime.usageLogFilters = { model_q: 'Model One', request_type: 'chat' };
  runtime.client.get = async (endpoint, options = {}) => { calls.push({ endpoint, options }); if (endpoint === '/api/user/stats') return { summary: {}, daily: [], hourly: [] }; if (options.raw) return { statusCode: 200, headers: { 'content-type': 'text/csv; charset=utf-8' }, text: '\\uFEFF时间,模型\\n今天,Model One' }; return { total: 0, page: 1, logs: [] }; };
  try {
    const data = await page(runtime).load();
    const exportAction = data.actions.find(action => action.label === '导出当前筛选 CSV');
    let confirms = 0;
    await exportAction.run({ ask: async () => destination, confirm: async () => { confirms++; return false; }, notify() {}, show: async () => {} });
    assert.equal(await fs.access(destination).then(() => true).catch(() => false), false, 'declining confirmation must not create a file');
    assert.equal(confirms, 1);

    await fs.writeFile(destination, 'preserve existing', 'utf8');
    confirms = 0;
    await exportAction.run({ ask: async () => destination, confirm: async () => { confirms++; return confirms > 1; }, notify() {}, show: async () => {} });
    assert.equal(await fs.readFile(destination, 'utf8'), 'preserve existing', 'declining overwrite must preserve the destination');
    assert.equal(confirms, 1);

    await exportAction.run({ ask: async () => destination, confirm: async () => true, notify() {}, show: async () => {} });
    assert.equal(await fs.readFile(destination, 'utf8'), '\\uFEFF时间,模型\\n今天,Model One');
    const exportRequest = calls.find(call => call.endpoint === '/api/user/usage-logs/export');
    assert.deepEqual(exportRequest.options.query, { model_q: 'Model One', request_type: 'chat', limit: 50000 });
    assert.equal((await fs.stat(destination)).mode & 0o077, 0, 'export files should not be readable by other users');
  } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
});

test('usage custom dates validate dates and send the same interval to stats, latency and message analysis', async () => {
  const runtime = makeRuntime();
  const calls = [];
  runtime.client.get = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/user/stats/filters') return { models: [], providers: [], teams: [], sources: [] }; return { summary: {}, daily: [], hourly: [] }; };
  const usage = page(runtime);
  const initial = await usage.load();
  const action = initial.actions.find(item => item.label === '自定义日期范围');
  let invalidShown = '';
  await action.run({ form: async () => ({ start: '2026-02-30', end: '2026-03-01' }), show: async (_title, message) => { invalidShown = message; }, refresh: async () => {} });
  assert.match(invalidShown, /真实存在的 YYYY-MM-DD/);
  assert.equal(runtime.usageCustomRange, undefined, 'invalid date must not update the active range');
  await action.run({ form: async () => ({ start: '2026-11-01', end: '2026-11-07' }), show: async () => {}, refresh: async () => {} });
  assert.deepEqual(runtime.usageCustomRange, { start: '2026-11-01', end: '2026-11-07' });
  usage.onTabChange({ id: 'latency' }); await usage.load();
  usage.onTabChange({ id: 'messages' }); await usage.load();
  assert.deepEqual(calls.filter(call => ['/api/user/stats', '/api/user/stats/latency', '/api/user/message-stats'].includes(call.path)).slice(-3).map(call => call.options.query), [
    { start: '2026-11-01', end: '2026-11-07' }, { start: '2026-11-01', end: '2026-11-07' }, { start: '2026-11-01', end: '2026-11-07' },
  ]);
});

test('latency query omits unsupported Team filter and warns that it is unapplied', async () => {
  const runtime = makeRuntime();
  const calls = [];
  runtime.usageFilters = { model_id: 'm1', provider_id: 'p1', team_id: '2', request_source: 'codex' };
  runtime.usageTab = 'latency';
  runtime.client.get = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/stats') return { summary: {}, daily: [], hourly: [] };
    if (path === '/api/user/stats/latency') return { window: {}, coverage: { totalRequests: 0, measuredRequests: 0, rate: 0 }, summary: {}, byModel: [], daily: [], rateLimits: [] };
    return {};
  };
  const usage = page(runtime);
  const data = await usage.load();
  const latencyCall = calls.find(call => call.path === '/api/user/stats/latency');
  assert.deepEqual(latencyCall.options.query, { days: 30, model_id: 'm1', provider_id: 'p1', request_source: 'codex' });
  const notes = data.sections.find(section => section.title === '延迟指标说明').rows.map(row => row.label);
  assert.ok(notes.some(note => note.includes('Team 筛选不适用于')));
  assert.ok(notes.some(note => note.includes('模型、供应商、客户端')));
});

test('usage filter action mirrors web model, provider, team and client filters', async () => {
  const runtime = makeRuntime();
  const calls = [];
  runtime.client.get = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/user/stats/filters') return { models: [{ model_id: 'm1', name: 'Model One' }], providers: [{ provider_id: 'p1', name: 'Provider One' }], teams: [{ id: 2, name: 'Team A' }], sources: [{ id: 'codex', name: 'Codex' }] }; return { summary: {}, daily: [], byModel: [], byApiKey: [], byProvider: [], bySource: [] }; };
  const usage = page(runtime);
  runtime.usageFilters = { team_id: 'old-team', obsolete: 'stale' };
  const initial = await usage.load();
  const action = initial.actions.find(item => item.label === '时间范围与筛选');
  const picks = ['m1', 'p1', '2', 'codex'];
  let refreshes = 0;
  await action.run({ choose: async () => picks.shift(), refresh: async () => { refreshes++; } });
  assert.deepEqual(runtime.usageFilters, { model_id: 'm1', provider_id: 'p1', team_id: '2', request_source: 'codex' });
  assert.equal(refreshes, 1);
  const refreshed = await usage.load();
  assert.deepEqual(calls.filter(call => call.path === '/api/user/stats').at(-1).options.query, { days: 30, model_id: 'm1', provider_id: 'p1', team_id: '2', request_source: 'codex' });
  const picksClear = ['', '', '', ''];
  await refreshed.actions.find(item => item.label === '时间范围与筛选').run({ choose: async () => picksClear.shift(), refresh: async () => {} });
  assert.deepEqual(runtime.usageFilters, {});
});
