'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages, WEB_PAGE_MAP, navGroups } = require('../tui/pages');

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
  assert.deepEqual(navGroups.map(group => group.id), ['console', 'admin', 'cli']);
  assert.deepEqual(navGroups[0].pages.slice(0, 13), ['model-library', 'providers', 'keys', 'usage', 'projects', 'leaderboard', 'balance', 'audit-logs', 'prompts', 'sessions', 'blora-agent', 'policy-center', 'settings']);
  assert.deepEqual(navGroups[1].pages.filter(id => !['admin-policy-members', 'admin-policy-approvals', 'admin-policy-notifications', 'admin-policy-settings', 'admin-policy-clients', 'admin-models', 'admin-teams'].includes(id)), ['admin-users', 'admin-policies', 'admin-model-library', 'admin-stats', 'admin-error-logs', 'admin-audit-logs', 'admin-prompts', 'admin-plugins', 'admin-settings']);
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
  assert.ok(project.actions.some(action => action.label === '自定义日期范围'));
  const leaderboard = await pages.get('leaderboard').load(api);
  assert.ok(leaderboard.sections[0].rows[0].label.includes('alice'));
  assert.ok(leaderboard.actions.some(action => action.label === '按缓存命中率排序'));
  const balance = await pages.get('balance').load(api);
  assert.ok(balance.sections.some(section => section.title === 'Team 与个人限额'));
  assert.ok(balance.sections[0].cards.some(card => card.label === '积分'));
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
    if (path === '/api/user/model-library') return { models: [{ id: 'm1', name: 'Model One' }] };
    if (path === '/api/user/api-keys') return [{ id: 8, name: 'Main Key' }];
    if (path === '/api/user/provider-tags') return [{ id: 2, name: 'Featured' }];
    if (path.endsWith('/models')) return { models: [{ id: 'm1', name: 'Model One' }], queue: [] };
    return {};
  };
  const data = await page.load(api);
  assert.ok(calls.some(call => call.path === '/api/user/model-library'));
  assert.ok(calls.some(call => call.path === '/api/user/api-keys/8/models'));
  const row = data.sections.find(section => section.title === '模型目录').rows[0];
  let confirmCount = 0;
  await row.run({ choose: async () => 'toggle', confirm: async () => { confirmCount++; return false; } });
  assert.equal(confirmCount, 1);
  assert.equal(calls.some(call => call.options.method === 'PUT'), false, 'cancelled confirmation does not write');
  await row.run({ choose: async () => 'toggle', confirm: async () => true, notify() {}, refresh: async () => {} });
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
  const api = async (path, options = {}) => { calls.push({ path, options }); return { projects: [] }; };
  const actions = (await page.load(api)).actions;
  const form = async (_title, fields) => Object.fromEntries(fields.map(field => [field.name, field.name === 'start' ? '2026-11-01' : '2026-11-07']));
  await actions.find(action => action.label === '自定义日期范围').run({ form, notify() {} });
  assert.deepEqual(calls.at(-1).options.query, { start: '2026-11-01', end: '2026-11-07' });
});
