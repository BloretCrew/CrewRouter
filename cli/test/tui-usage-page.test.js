'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

const makeRuntime = () => ({ client: { get: async () => ({ summary: {}, daily: [], byModel: [], byApiKey: [], byProvider: [], bySource: [] }) }, cfg: { tui: { days: 30 } }, profileName: 'test' });
const page = runtime => buildPages(runtime).find(item => item.id === 'usage');

test('usage tabs request latency, message and log data with shared filters', async () => {
  const runtime = makeRuntime();
  const calls = [];
  runtime.client.get = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/user/stats') return { summary: { total_requests: 20, total_tokens: 2000, total_prompt_tokens: 1200, total_completion_tokens: 800, total_cached_tokens: 300, total_cost: 10, avg_latency: 40, identified_rate: 0.9, known_requests: 18, unknown_requests: 2, active_sources: 1 }, daily: Array.from({ length: 14 }, (_, index) => ({ date: `2026-11-${String(index + 1).padStart(2, '0')}`, requests: 3, prompt_tokens: 10, completion_tokens: 20, tokens: 30, cost: index < 7 ? 1 : 2 })), hourly: [{ hour: 9, requests: 4, tokens: 120, cached_tokens: 20, cost: 0.4 }, { hour: 10, requests: 2, tokens: 60, cached_tokens: 10, cost: 0.2 }], byModel: [{ model_name: 'Model One', requests: 2, tokens: 10, cost: 0.25 }, { model_name: 'Model Two', requests: 1, tokens: 5, cost: 0.1 }], byApiKey: [{ key_name: 'Main Key', requests: 1, tokens: 5, cost: 0.1 }], byProvider: [{ provider_name: 'Provider One', requests: 1, tokens: 7, cost: 0.2 }], bySource: [{ request_source: 'codex', requests: 12, tokens: 600, cost: 0.15 }, { request_source: 'claude_code', requests: 8, tokens: 400, cost: 0.15 }] }; if (path === '/api/user/stats/latency') return { p50_ms: 24, p95_ms: 80, p99_ms: 100, total_requests: 10, daily: [{ date: 'today', requests: 10, p95_ms: 80, tokens_per_second: 12 }] }; if (path === '/api/user/message-stats') return { summary: { requests: 12, total_tokens: 2000, total_cost: 3, metadata_rate: 0.5, git_rate: 0.25, peak_day: { date: '2026-11-24', requests: 4 } }, by_block: [{ block: 'git_status', requests: 3, occurrences: 4, tokens: 1000, cost: 1.2 }], by_source: [{ request_source: 'codex', requests: 2, messages: 10, characters: 400, tokens: 1000 }] }; if (path === '/api/user/usage-logs') return { page: 1, total: 1, logs: [{ id: 42, created_at: '2026-11-24T00:00:00Z', model_name: 'Model One', request_source: 'codex', tokens_used: 100, cost: 0.5 }] }; if (path === '/api/user/usage-logs/42') return { log: { id: 42, created_at: '2026-11-24T00:00:00Z', model_name: 'Model One', upstream_model_id: 'up-1', provider_name: 'Provider One', request_type: 'chat', request_source: 'codex', key_prefix: 'abcd', key_name: 'Main', tokens_used: 100, prompt_tokens: 80, completion_tokens: 20, cached_tokens: 30, latency_ms: 25, is_stream: true, ttft_ms: 10, tpot_ms: 2, output_tps: 12, cost: 0.5 } }; return {}; };
  const usage = page(runtime);
  const overview = await usage.load();
  assert.ok(overview.sections[0].rows.some(row => row.label === '常用模型 Top 1：Model One'));
  assert.ok(overview.sections[0].rows.some(row => row.label.startsWith('高峰时段 Top 1：09:00')));
  assert.ok(overview.sections[0].rows.some(row => row.label.includes('客户端：Codex') && row.detail.includes('████████████████')));
  assert.ok(overview.sections[0].rows.some(row => row.label === '积分环比变化' && row.detail === '+100.0%'));
  assert.ok(overview.sections[0].rows.some(row => row.label === '关键指标：平均 Token/请求'));
  usage.onTabChange({ id: 'latency' });
  const latencyData = await usage.load();
  const latencySection = latencyData.sections.find(section => section.tab === 'latency');
  assert.equal(latencySection.cards[0].label, '请求中位延迟（P50）');
  assert.equal(latencySection.cards[1].value, '80');
  assert.match(latencySection.rows[0].label, /输出速度 12 Token\/秒/);
  assert.ok(latencySection.toolbar);
  usage.onTabChange({ id: 'daily' });
  const dailySection = (await usage.load()).sections.find(section => section.tab === 'daily');
  assert.deepEqual(dailySection.columns.map(column => column.label), ['日期', '请求数', '输入 Token', '输出 Token', '总 Token', '费用（积分）']);
  assert.equal(dailySection.rows[0].cells.input, '10 Token');
  usage.onTabChange({ id: 'hourly' });
  const hourlySection = (await usage.load()).sections.find(section => section.tab === 'hourly');
  assert.equal(hourlySection.rows.length, 24);
  assert.deepEqual(hourlySection.rows[9].cells, { hour: '09:00', requests: '4 次', tokens: '120 Token', cached: '20 Token', cost: '0.4000 积分' });
  assert.match(hourlySection.description, /高峰时段 09:00（4 次请求）/);
  usage.onTabChange({ id: 'models' });
  const modelData = await usage.load();
  const modelSection = modelData.sections.find(section => section.tab === 'models');
  assert.deepEqual(modelSection.rows[0].cells, { name: 'Model One', requests: '2 次', tokens: '10 Token', cost: '0.2500 积分' });
  assert.ok(modelData.actions.some(action => action.label === '时间范围与筛选' && action.toolbar === true));
  usage.onTabChange({ id: 'messages' });
  const messages = await usage.load();
  const messagesSection = messages.sections.find(section => section.tab === 'messages');
  assert.ok(messagesSection.cards.some(card => card.label === 'Token 总量' && card.value === '2.0K Token'));
  assert.ok(messagesSection.cards.some(card => card.label === '元数据覆盖率' && card.value === '50.0%'));
  assert.match(messagesSection.rows[0].label, /git_status/);
  assert.match(messagesSection.rows[0].detail, /出现 4 次.*1.0K Token/);
  usage.onTabChange({ id: 'logs' });
  const logData = await usage.load();
  const logRow = logData.sections.find(section => section.tab === 'logs').rows[0];
  let detail = '';
  await logRow.run({ api: async (path, options) => runtime.client.get(path, options), show: async (_title, body) => { detail = body; } });
  assert.match(detail, /输入 Token：80/);
  assert.match(detail, /缓存命中 Token：30（37.5%）/);
  assert.match(detail, /每输出 Token 耗时（TPOT）：2.0 毫秒/);
  assert.doesNotMatch(detail, /"model_name"|"cached_tokens"/);
  assert.deepEqual(calls.map(call => call.path), [
    '/api/user/stats', '/api/user/stats', '/api/user/stats/latency',
    '/api/user/stats', '/api/user/stats', '/api/user/stats', '/api/user/stats',
    '/api/user/message-stats', '/api/user/stats', '/api/user/usage-logs', '/api/user/usage-logs/42',
  ]);
});

test('usage filter action mirrors web model, provider, team and client filters', async () => {
  const runtime = makeRuntime();
  const calls = [];
  runtime.client.get = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/user/stats/filters') return { models: [{ id: 'm1', name: 'Model One' }], providers: [{ id: 'p1', name: 'Provider One' }], teams: [{ id: 2, name: 'Team A' }], sources: [{ id: 'codex', name: 'Codex' }] }; return { summary: {}, daily: [], byModel: [], byApiKey: [], byProvider: [], bySource: [] }; };
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
