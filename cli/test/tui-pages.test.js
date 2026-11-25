'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages, WEB_PAGE_MAP, navGroups, navAreas, PAGE_CAPABILITIES } = require('../tui/pages');
const { runPagedTui } = require('../tui/engine');
const { terminal, until } = require('./helpers/tty');

function runtime(isAdmin = true) {
  return { client: { isAdmin }, cfg: { tui: { days: 30 } }, profileName: 'test', baseUrl: 'http://localhost' };
}

test('TUI pages map every console and admin navigation entry', () => {
  const pages = buildPages(runtime());
  const ids = new Set(pages.map(page => page.id));
  assert.equal(new Set(pages.map(page => page.id)).size, pages.length);
  for (const mapping of WEB_PAGE_MAP) assert.ok(ids.has(mapping.cli), `${mapping.area}.${mapping.web} maps to ${mapping.cli}`);
  assert.ok(ids.has('service'), 'CLI retains its local service/profile page');
  assert.ok(ids.has('overview'), 'CLI retains its overview page');
  assert.deepEqual(navGroups.map(group => group.id), ['console', 'admin', 'admin-subpages', 'tools', 'cli']);
  assert.deepEqual(PAGE_CAPABILITIES, {
    'my-upstream': 'personalProviders', projects: 'projects', 'audit-logs': 'auditLogs', 'policy-center': 'teamPolicies',
    'admin-users': 'multiUser', 'admin-policies': 'teamPolicies', 'admin-policy-settings': 'teamPolicies',
    'admin-policy-members': 'teamPolicies', 'admin-policy-hits': 'teamPolicies', 'admin-policy-exceptions': 'teamPolicies', 'admin-policy-approvals': 'teamPolicies', 'admin-policy-clients': 'teamPolicies',
    'admin-policy-notifications': 'teamPolicies', 'admin-teams': 'multiUser', 'admin-stats': 'adminStats', 'admin-audit-logs': 'teamAuditLogs',
  });
  assert.deepEqual(navAreas.map(area => ({ ...area })), [
    { id: 'console', label: '控制台', groups: ['console', 'tools', 'cli'] },
    { id: 'admin', label: '管理后台', groups: ['admin', 'admin-subpages'], adminOnly: true },
  ]);
  assert.deepEqual(navGroups[0].pages, ['model-library', 'my-upstream', 'keys', 'usage', 'projects', 'leaderboard', 'balance', 'audit-logs', 'prompts', 'sessions', 'blora-agent', 'policy-center', 'settings', 'notification-settings']);
  assert.deepEqual(navGroups[1].pages, ['admin-users', 'admin-policies', 'admin-model-library', 'admin-stats', 'admin-error-logs', 'admin-audit-logs', 'admin-prompts', 'admin-plugins', 'admin-settings']);
  assert.deepEqual(navGroups[3].pages, ['providers', 'provider-tags', 'models', 'account', 'overview', 'security-settings']);
  assert.ok(navGroups[2].pages.includes('admin-policy-hits'));
  assert.ok(navGroups[2].pages.includes('admin-policy-exceptions'));
  assert.ok(WEB_PAGE_MAP.some(mapping => mapping.cli === 'admin-policy-hits'));
  assert.ok(WEB_PAGE_MAP.some(mapping => mapping.cli === 'admin-policy-exceptions'));
  assert.equal(WEB_PAGE_MAP.find(mapping => mapping.area === 'admin' && mapping.web === 'adminPolicies').kind, 'tabbed-page');
  assert.equal(WEB_PAGE_MAP.find(mapping => mapping.area === 'admin' && mapping.web === 'policyMembers').kind, 'tab');
  for (const page of pages) assert.ok(navGroups.some(group => group.pages.includes(page.id)), `${page.id} belongs to a navigation group`);
});

test('admin-only pages require a verified admin identity before calling APIs', async () => {
  for (const isAdmin of [false, null]) {
    const pages = buildPages(runtime(isAdmin));
    const ids = ['admin-users', 'admin-error-logs', 'admin-prompts', 'admin-plugins', 'admin-model-library', 'admin-models', 'admin-teams', 'admin-stats', 'admin-settings'];
    for (const id of ids) {
      const page = pages.find(item => item.id === id);
      assert.ok(page, `${id} exists`);
      let requested = false;
      const data = await page.load(async () => { requested = true; throw new Error('unexpected request'); });
      assert.equal(requested, false, `${id} must not request admin API without a verified admin`);
      assert.match(data.sections[0].rows[0].label, /管理员/);
    }
  }
});

test('user console pages query matching endpoints and expose equivalent controls', async () => {
  const pages = new Map(buildPages(runtime(false)).map(page => [page.id, page]));
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/project-stats') return { summary: { projects: 1, requests: 2, tokens: 30 }, projects: [{ workspace_path: '/repo/a', requests: 2, tokens: 30, sources: { codex: 2 } }], daily: [] };
    if (path === '/api/user/leaderboard') return { leaderboard: [{ rank: 1, username: 'alice', totalRequests: 4, totalTokens: 40, totalPoints: 2, cacheHitRate: 25, balance: 3 }] };
    if (path === '/api/user/audit-logs') return { items: [{ action: 'api_key', description: 'created', created_at: '2026-11-01T00:00:00Z' }], total: 1, page: 1 };
    if (path === '/api/user/balance') return { balance: 25, refund_balance: 10, rate_limit_rpm: 60, rate_limit_tpm: 1000, group: { name: 'Team A', rules: [{ rule_type: 'requests', rule_value: 100, duration_hours: 24, current: 8 }] } };
    if (path === '/api/user/custom-instructions') return { items: [{ file: 'CLAUDE.md', source: 'claude_code', chars: 4, occurrence_count: 2, fingerprint: 'fp', preview: 'hint' }], total: 1, page: 1 };
    if (path === '/api/user/inject-prompts') return [];
    if (path === '/api/user/model-library') return { models: [{ id: 'm1', name: 'Model One' }] };
    if (path === '/api/user/api-keys') return [{ id: 8, name: 'Main Key' }];
    if (path === '/api/user/provider-tags') return [{ id: 2, name: 'Featured' }];
    if (path.endsWith('/models')) return { models: [{ id: 'm1', name: 'Model One' }], queue: [] };
    return {};
  };
  const project = await pages.get('projects').load(api);
  assert.ok(project.sections.some(section => section.title === '每日活动'));
  assert.ok(project.actions.some(action => action.label === '选择时间范围'));
  assert.ok(project.actions.some(action => action.label === '筛选客户端'));
  const leaderboard = await pages.get('leaderboard').load(api);
  assert.ok(leaderboard.sections[0].rows[0].label.includes('alice'));
  assert.ok(leaderboard.actions.some(action => action.label === '按缓存命中率排序'));
  const balance = await pages.get('balance').load(api);
  assert.deepEqual(balance.sections.map(section => section.title), ['当前积分', 'Team 与限额']);
  assert.ok(balance.sections[0].cards.some(card => card.label === '当前积分'));
  const audit = await pages.get('audit-logs').load(api);
  assert.ok(audit.sections[0].rows[0].label.includes('api_key'));
  assert.ok(audit.actions.some(action => action.label === '下一页'));
  const prompts = await pages.get('prompts').load(api);
  assert.ok(prompts.sections.some(section => section.title === '历史提示词'));
  assert.ok(prompts.actions.some(action => action.label === '搜索历史提示词'));
  assert.ok(calls.some(call => call.path === '/api/user/custom-instructions' && call.options.query.pageSize === 20));
});

test('model library requires confirmation and sends the ordered key model queue', async () => {
  const page = buildPages(runtime(false)).find(item => item.id === 'model-library');
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/model-library') return { teams: [{ team_id: 2, team_name: 'Team A', providers: [{ provider_id: 'p1', provider_name: 'Provider A', model_count: 1, visible_model_count: 1, tags: [{ id: 2, name: 'Featured' }] }] }], starred_models: [], available_series: [], total_models: 1 };
    if (path === '/api/user/api-keys') return [{ id: 8, name: 'Main Key' }];
    if (path === '/api/user/provider-tags') return [{ id: 2, name: 'Featured' }];
    if (path.endsWith('/models')) return { models: [{ id: 'm1', name: 'Model One' }], queue: [] };
    if (path === '/api/user/team/2/provider/p1/models') return { models: [{ model_id: 'm1', name: 'Model One', provider: 'p1', provider_name: 'Provider A', team_id: 2 }], pagination: { page: 1, total: 1, limit: 30, total_pages: 1, has_prev: false, has_next: false } };
    return {};
  };
  const data = await page.load(api);
  assert.ok(calls.some(call => call.path === '/api/user/model-library'));
  assert.ok(calls.some(call => call.path === '/api/user/api-keys/8/models'));
  const providerAction = data.sections.find(section => section.title === '搜索与筛选').actions.find(action => action.label === '选择供应商展开模型');
  await providerAction.run({ choose: async () => 0, refresh: async () => {} });
  const expanded = await page.load(api);
  assert.ok(calls.some(call => call.path === '/api/user/team/2/provider/p1/models'));
  const row = expanded.sections.find(section => section.title.includes('模型目录')).rows[0];
  let confirmCount = 0;
  await row.run({ choose: async () => 'bind', confirm: async () => { confirmCount++; return false; }, notify() {}, refresh: async () => {} });
  assert.equal(confirmCount, 1);
  assert.equal(calls.some(call => call.options.method === 'PUT'), false, 'cancelled confirmation does not write');
  await row.run({ choose: async () => 'bind', confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.equal(calls.at(-1).options.method, 'PUT');
  assert.deepEqual(calls.at(-1).options.body.modelIds, ['m1']);
});

test('error log filters use the actual admin API parameter names', async () => {
  const runtimeState = runtime(true);
  const page = buildPages(runtimeState).find(item => item.id === 'admin-error-logs');
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { logs: [], total: 0, page: 1, retention_days: 30 }; };
  const first = await page.load(api);
  const finalOnly = first.actions.find(action => action.label === '仅最终错误');
  await finalOnly.run({ refresh: async () => page.load(api) });
  assert.equal(calls.at(-1).options.query.final_only, '1');
  assert.equal(calls.at(-1).options.query.is_final, undefined);
});

test('project date query sends the web API range parameters', async () => {
  const page = buildPages(runtime(false)).find(item => item.id === 'projects');
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { summary: { projects: 1, active_days: 2, requests: 3, tokens: 100 }, projects: [{ workspace_path: '/work/Example', requests: 3, tokens: 100, active_days: 2, cost: 1.25, sources: { codex: 3 } }], daily: [{ date: '2026-11-07', requests: 3, projects: 1 }] }; };
  const actions = (await page.load(api)).actions;
  const form = async (_title, fields) => Object.fromEntries(fields.map(field => [field.name, field.name === 'start' ? '2026-11-01' : '2026-11-07']));
  await actions.find(action => action.label === '选择时间范围').run({ choose: async (_title, options) => options.find(option => option.value === 'custom').value, form, notify() {}, refresh: async () => {} });
  const data = await page.load(api);
  assert.deepEqual(calls.at(-1).options.query, { start: '2026-11-01', end: '2026-11-07' });
  const projectSection = data.sections.find(section => section.title === '项目工作台');
  assert.deepEqual(projectSection.columns.map(column => column.label), ['工作区', '请求数', 'Token 用量', '活跃天数', '费用（积分）']);
  assert.equal(projectSection.rows[0].cells.tokens, '100 Token');
});

test('leaderboard renders web column order, current-user marker and footer totals', { timeout: 15000 }, async () => {
  const page = buildPages(runtime(false)).find(item => item.id === 'leaderboard');
  const tty = terminal(160, 36);
  const api = async path => path === '/api/user/leaderboard' ? { totalUsers: 23, currentUserRank: 4, leaderboard: [{ rank: 4, username: 'alice', isCurrentUser: true, totalRequests: 12, totalTokens: 2400, totalPoints: 3.25, cacheHitRate: 20, balance: 9.5 }] } : {};
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api, pages: [page], authenticate: async () => true });
  try {
    await until(() => tty.screen().includes('当前余额'));
    const screen = tty.screen();
    const headerLine = screen.split('\n').find(line => ['排名', '用户', '请求数', 'Token 数', '消耗积分', '缓存命中率', '当前余额'].every(value => line.includes(value)));
    assert.ok(headerLine, 'expected the complete leaderboard column header row');
    const positions = ['排名', '用户', '请求数', 'Token 数', '消耗积分', '缓存命中率', '当前余额'].map(value => headerLine.indexOf(value));
    assert.ok(positions.every((value, index) => index === 0 || positions[index - 1] < value), `unexpected leaderboard column order: ${positions.join(',')}`);
    assert.ok(screen.includes('alice · 我'));
    assert.ok(screen.includes('20.0%'));
    assert.ok(screen.includes('共 23 名活跃用户'));
    assert.ok(screen.includes('您的排名：第 4 名'));
  } finally { tty.input.write('q'); await task; }
});

test('leaderboard presents token, request, points, cache and balance fields as web columns', async () => {
  const page = buildPages(runtime(false)).find(item => item.id === 'leaderboard');
  const data = await page.load(async () => ({ totalUsers: 23, currentUserRank: 4, leaderboard: [{ rank: 4, username: 'alice', isCurrentUser: true, totalRequests: 12, totalTokens: 2400, totalPoints: 3.25, cacheHitRate: 20, balance: 9.5 }] }));
  const section = data.sections[0];
  assert.deepEqual(section.columns.map(column => column.label), ['排名', '用户', '请求数', 'Token 数', '消耗积分', '缓存命中率', '当前余额']);
  assert.deepEqual(section.rows[0].cells, { rank: '#4', username: 'alice · 我', requests: '12', tokens: '2.4K', points: '3.25', cache: '20.0%', balance: '9.50' });
  assert.deepEqual(data.sections[1].rows.map(row => row.label), ['共 23 名活跃用户', '您的排名：第 4 名']);
  assert.ok(data.actions.some(action => action.label === '最近 30 天' && action.toolbar));
});
