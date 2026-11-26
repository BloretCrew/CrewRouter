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
  assert.deepEqual(navGroups.map(group => group.id), ['console', 'console-settings', 'admin', 'admin-system', 'admin-subpages', 'tools', 'cli']);
  assert.deepEqual(navGroups.filter(group => !group.hidden).map(group => group.id), ['console', 'console-settings', 'admin', 'admin-system']);
  assert.deepEqual(PAGE_CAPABILITIES, {
    'my-upstream': 'personalProviders', projects: 'projects', 'audit-logs': 'auditLogs', 'policy-center': 'teamPolicies',
    'admin-users': 'multiUser', 'admin-policies': 'teamPolicies', 'admin-policy-settings': 'teamPolicies',
    'admin-policy-members': 'teamPolicies', 'admin-policy-hits': 'teamPolicies', 'admin-policy-exceptions': 'teamPolicies', 'admin-policy-approvals': 'teamPolicies', 'admin-policy-clients': 'teamPolicies',
    'admin-policy-notifications': 'teamPolicies', 'admin-teams': 'multiUser', 'admin-stats': 'adminStats', 'admin-audit-logs': 'teamAuditLogs',
  });
  assert.deepEqual(navAreas.map(area => ({ ...area })), [
    { id: 'console', label: '控制台', groups: ['console', 'console-settings', 'tools', 'cli'] },
    { id: 'admin', label: '管理后台', groups: ['admin', 'admin-system', 'admin-subpages'], adminOnly: true },
  ]);
  assert.deepEqual(navGroups.map(group => group.hidden || false), [false, false, false, false, true, true, true]);
  assert.deepEqual(navGroups[0].pages, ['model-library', 'my-upstream', 'keys', 'usage', 'projects', 'leaderboard', 'balance', 'audit-logs', 'prompts', 'sessions', 'blora-agent']);
  assert.deepEqual(navGroups[1].pages, ['policy-center', 'settings']);
  assert.deepEqual(navGroups[2].pages, ['admin-users', 'admin-policies', 'admin-model-library', 'admin-stats', 'admin-error-logs', 'admin-audit-logs', 'admin-prompts', 'admin-plugins']);
  assert.deepEqual(navGroups[3].pages, ['admin-settings']);
  assert.deepEqual(navGroups[5].pages, ['providers', 'provider-tags', 'models', 'account', 'overview', 'security-settings', 'notification-settings']);
  assert.ok(navGroups[4].pages.includes('admin-policy-hits'));
  assert.ok(navGroups[4].pages.includes('admin-policy-exceptions'));
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

test('CLI overview shows clearly labeled balance, usage, API Key count and unknown latency', async () => {
  const page = buildPages(runtime(false)).find(item => item.id === 'overview');
  const api = async path => {
    if (path === '/api/version') return { name: 'CrewRouter', version: '1.2.3' };
    if (path === '/api/instance') return { edition: 'team', runtime: 'server', auth: { methods: ['password'] } };
    if (path === '/api/user/balance') return { balance: 12.5, group: { name: 'Team A' } };
    if (path === '/api/user/stats') return { summary: { total_requests: 3, total_tokens: 1234, total_cost: 0.75 }, daily: [{ date: '2026-11-25', requests: 3, tokens: 1234, cost: 0.75 }] };
    if (path === '/api/user/api-keys') return [{ id: 1 }, { id: 2 }];
    if (path === '/api/user/current-model') return { currentModel: { name: 'Model A' } };
    return {};
  };
  const data = await page.load(api);
  const usage = data.sections.find(section => section.title === '账户与用量');
  assert.deepEqual(usage.cards.map(card => card.label), ['余额', '请求', 'Token 用量', '费用（积分）', 'API Key']);
  assert.deepEqual(usage.cards.map(card => card.value), ['12.5000 积分', '3', '1.2K Token', '0.7500 积分', '2 个']);
  assert.equal(usage.cards[3].detail, '平均响应时间：暂无数据');
  assert.ok(usage.rows.some(row => row.label === '当前模型：Model A'));
  assert.ok(!usage.rows.some(row => row.label.startsWith('API Key：')));
  assert.equal(data.sections.find(section => section.title === '最近每日用量').rows[0].label, '2026-11-25 · 3 次请求 · 1.2K Token · 0.7500 积分');
  const measured = await page.load(async path => path === '/api/user/stats' ? { summary: { avg_latency: 45 } } : path === '/api/user/balance' ? { balance: 0 } : path === '/api/user/api-keys' ? [] : {});
  assert.equal(measured.sections.find(section => section.title === '账户与用量').cards[3].detail, '平均响应时间 45 毫秒');
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
  const balance = await pages.get('balance').load(async (path, options) => path === '/api/user/balance' ? { balance: 40, refund_balance: 12.5, rate_limit_rpm: 60, rate_limit_tpm: 1000, group: { name: 'Team A', rules: [{ rule_type: 'requests', rule_value: 100, duration_hours: 24, current: 8 }] } } : [{ code: 'SECRET-CODE-12345', amount: 10, fee_rate: 0.1, net_amount: 9.0909 }]);
  assert.deepEqual(balance.sections.map(section => section.title), ['当前积分', '可退款兑换码明细（补充信息）', 'Team 与限额']);
  assert.ok(balance.sections[0].cards.some(card => card.label === '当前积分'));
  assert.match(balance.sections[0].rows.find(row => row.label === '个人请求限额').detail, /60 次请求.*1\.0K Token/);
  const codeSection = balance.sections[1];
  assert.deepEqual(codeSection.columns.map(column => column.label), ['兑换码（遮掩）', '充值金额', '手续费率', '可退净额']);
  assert.deepEqual(codeSection.rows[0].cells, { code: 'SEC…345', amount: '10.0000 积分', fee: '10.00%', net: '9.0909 积分' });
  assert.doesNotMatch(JSON.stringify(codeSection.rows[0]), /SECRET-CODE/);
  assert.equal(balance.sections[2].rows.length, 1);
  const audit = await pages.get('audit-logs').load(api);
  assert.ok(audit.sections[0].rows[0].label.includes('API Key'));
  assert.ok(audit.actions.some(action => action.label === '下一页'));
  const prompts = await pages.get('prompts').load(api);
  assert.ok(prompts.sections.some(section => section.title === '提示词'));
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
  const finalOnly = first.actions.find(action => action.label === '筛选错误范围');
  await finalOnly.run({ choose: async (_title, options) => { assert.deepEqual(options.map(option => option.value), ['1', '0', '']); return '1'; }, refresh: async () => page.load(api) });
  assert.equal(calls.at(-1).options.query.final_only, '1');
  assert.equal(calls.at(-1).options.query.is_final, undefined);
});

test('project work TUI renders summary, daily activity, recent projects and workspace table in web order', { timeout: 15000 }, async () => {
  const page = buildPages(runtime(false)).find(item => item.id === 'projects');
  const tty = terminal(160, 40);
  const api = async () => ({ summary: { projects: 1, active_days: 2, requests: 3, tokens: 100, cost: 1.25, last_activity: '2026-11-24T12:00:00Z', analysis_status: { pending_requests: 0, last_scanned_at: '2026-11-25T00:00:00Z', enabled: true } }, projects: [{ workspace_path: '/work/Example', requests: 3, tokens: 100, active_days: 2, last_activity: '2026-11-24T12:00:00Z', cost: 1.25, sources: { codex: 3 } }], daily: [{ date: '2026-11-24', requests: 3, projects: 1 }] });
  const task = runPagedTui({ ...tty, env: { NO_COLOR: '1' }, api, pages: [page], authenticate: async () => true });
  try {
    await until(() => tty.screen().includes('/work/Example'));
    const screen = tty.screen();
    const positions = ['▸ 项目工作摘要', '▸ 每日活动', '▸ 最近活跃项目', '▸ 项目工作台'].map(value => screen.indexOf(value));
    assert.ok(positions.every(value => value >= 0), `missing project section: ${positions.join(',')}`);
    assert.ok(positions.every((value, index) => index === 0 || positions[index - 1] < value), `unexpected project section order: ${positions.join(',')}`);
    for (const header of ['最近活动', '客户端', '费用（积分）']) assert.ok(screen.includes(header), `missing project table field: ${header}`);
    assert.ok(screen.includes('已同步 · 最近更新'), 'project page should show the web sync status even when no records are pending');
  } finally { tty.input.write('q'); await task; }
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
  assert.deepEqual(data.sections.map(section => section.title), ['项目工作摘要', '每日活动', '最近活跃项目', '项目工作台']);
  const projectSection = data.sections.find(section => section.title === '项目工作台');
  assert.deepEqual(projectSection.columns.map(column => column.label), ['工作区', '请求', 'Token', '活跃天数', '最近活动', '客户端', '费用（积分）']);
  assert.equal(projectSection.rows[0].cells.tokens, '100 Token');
  assert.equal(projectSection.rows[0].cells.sources, 'Codex');
  assert.equal(projectSection.rows[0].cells.last_activity, '—');
  const filter = data.actions.find(action => action.label === '筛选客户端');
  await filter.run({ choose: async (_title, options) => { assert.ok(options.some(option => option.label === 'Codex' && option.value === 'codex')); return 'codex'; }, refresh: async () => {} });
  const filtered = await page.load(api);
  assert.ok(filtered.sections[0].description.includes('客户端 Codex'));
  assert.deepEqual(calls.at(-1).options.query, { start: '2026-11-01', end: '2026-11-07', request_source: 'codex' });
});

test('policy center mirrors the web section order and readable table columns', async () => {
  const calls = [];
  const page = buildPages(runtime(false)).find(item => item.id === 'policy-center');
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/policies/mine') return { suspension: { suspended: false }, settings: { enforcement_mode: 'enforce', allowlist_dimensions: ['model'] }, bypass: true, bypass_until: '2026-11-27T00:00:00Z', policies: [{ id: 5, name: 'Safe model', scope_type: 'team', effect: 'deny', action: 'block', category: 'content', priority: 20, starts_at: null, ends_at: null, description: 'Block unsafe models', conditions: { models: ['m1'] } }], exemptions: [{ id: 8, policy_id: 5, reason: 'Maintenance', ends_at: '2026-11-26T00:00:00Z', used_count: 1, max_uses: 3 }] };
    if (path === '/api/user/policies/blocks') return [{ id: 17, policy_id: 5, policy_name: 'Safe model', action: 'block', decision: 'block', request_source: 'codex', requested_model: 'm1', status_code: 403, reason: 'Model is not allowed', created_at: '2026-11-25T08:00:00Z' }];
    if (path === '/api/user/policy-appeals') return [{ id: 3, policy_id: 5, policy_name: 'Safe model', reason: 'Please review', status: 'pending', resolution: null, created_at: '2026-11-25T09:00:00Z' }];
    return {};
  };
  const data = await page.load(api);
  assert.deepEqual(data.sections.slice(0, 5).map(section => section.title), ['策略状态', '我的生效策略', '临时豁免', '最近拦截', '我的申诉']);
  assert.deepEqual(data.sections[1].columns.map(column => column.label), ['名称', '作用域', '效果', '动作', '分类', '有效期']);
  assert.deepEqual(data.sections[2].columns.map(column => column.label), ['策略', '原因', '到期', '次数']);
  assert.deepEqual(data.sections[3].columns.map(column => column.label), ['时间', '策略', '客户端', '模型', '原因', '操作']);
  assert.deepEqual(data.sections[4].columns.map(column => column.label), ['时间', '策略', '原因', '状态', '处理结果']);
  assert.equal(data.sections[0].cards[0].value, '正常');
  assert.equal(data.sections[0].cards[1].value, '1 条');
  assert.ok(data.sections[0].cards[2].detail.includes('账号豁免已开启'));
  assert.equal(data.sections[4].rows[0].cells.status, '处理中');
});

test('policy block row submits an appeal linked to that hit after confirmation', async () => {
  const calls = [];
  const page = buildPages(runtime(false)).find(item => item.id === 'policy-center');
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/policies/mine') return { policies: [], exemptions: [], suspension: {} };
    if (path === '/api/user/policies/blocks') return [{ id: 17, policy_id: 5, policy_name: 'Safe model', request_source: 'codex', requested_model: 'm1', status_code: 403, reason: 'Not allowed', created_at: '2026-11-25T08:00:00Z' }];
    if (path === '/api/user/policy-appeals') return [];
    return {};
  };
  const data = await page.load(api);
  const hit = data.sections.find(section => section.title === '最近拦截').rows[0];
  let formTitle = '';
  await hit.run({ form: async title => { formTitle = title; return { reason: 'Please review this block.' }; }, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.equal(formTitle, '提交策略申诉');
  assert.deepEqual(calls.find(call => call.path === '/api/user/policy-appeals' && call.options.method === 'POST').options.body, { hit_id: 17, policy_id: 5, reason: 'Please review this block.' });
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
  assert.ok(data.actions.some(action => action.label === '最近 1 年' && action.toolbar));
  assert.equal(data.actions.some(action => action.label === '最近 365 天'), false);
});
