'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPages } = require('../tui/pages');

const runtime = isAdmin => ({ client: { isAdmin }, cfg: { tui: { days: 30 } }, profileName: 'test' });
const pageById = (id, isAdmin = true) => buildPages(runtime(isAdmin)).find(page => page.id === id);

test('policy member page uses web member filters and renders member actions', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { page: 1, total: 1, items: [{ id: 7, username: 'alice', email: 'a@example.test', team_id: 2, team_name: 'Team A', team_role: 'member', policy_count: 1, hits_24h: 2 }] }; };
  const result = await pageById('admin-policy-members').load(api);
  assert.equal(calls[0].path, '/api/admin/policy-members');
  assert.equal(calls[0].options.query.limit, 50);
  assert.ok(result.sections[0].rows[0].label.includes('alice'));
  assert.ok(result.actions.some(action => action.label === '搜索成员'));
});

test('policy approval row confirms before sending a decision', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return path === '/api/admin/policy-approvals' ? { items: [{ id: 11, kind: 'request', policy_name: 'Model gate', requested_by_name: 'alice', status: 'pending', preview: { model: 'x' } }] } : { success: true }; };
  const result = await pageById('admin-policy-approvals').load(api);
  const row = result.sections[0].rows[0];
  await row.run({ choose: async () => 'approve', confirm: async () => false, ask: async () => '' });
  assert.equal(calls.some(call => call.path.endsWith('/decide')), false);
  await row.run({ choose: async () => 'approve', confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.find(call => call.path.endsWith('/decide')).options.body, { decision: 'approve' });
});

test('policy notification endpoints are not queried for an unverified administrator', async () => {
  const page = pageById('admin-policy-notifications', null);
  const calls = [];
  const result = await page.load(async (path, options) => { calls.push({ path, options }); return []; });
  assert.deepEqual(calls, []);
  assert.match(result.sections[0].rows[0].label, /管理员/);
});

test('policy channel creation sends selected type and secret config only after confirmation', async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/policy-channels') return [];
    if (path === '/api/admin/policy-alert-rules') return [];
    if (path.includes('/analytics')) return { totals: {}, rows: [] };
    return { id: 8 };
  };
  const result = await pageById('admin-policy-notifications', true).load(api);
  const action = result.actions.find(item => item.label === '新建通知渠道');
  const values = { name: 'Ops', type: 'webhook', min_severity: 'critical', url: 'https://hooks.example.test/x', secret: 'secret-value', port: '514' };
  await action.run({ form: async () => values, confirm: async () => false });
  assert.equal(calls.some(call => call.options.method === 'POST' && call.path === '/api/admin/policy-channels'), false);
  let confirmation;
  await action.run({ form: async () => values, confirm: async (_title, message) => { confirmation = message; return true; }, notify() {}, refresh: async () => {} });
  const create = calls.find(call => call.options.method === 'POST' && call.path === '/api/admin/policy-channels');
  assert.equal(create.options.body.config.secret, 'secret-value');
  assert.ok(!confirmation.includes('secret-value'));
});

test('policy settings preserve current allowlist defaults and send complete settings payload', async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/policy-settings') return { global: { enforcement_mode: 'shadow', fail_mode: 'open', hit_retention_days: 90, default_timezone: 'UTC', allowlist_dimensions: ['models'], notify_admins: true, notify_member: false, kill_switch: false }, team: { team_id: 4 } };
    return {};
  };
  const page = pageById('admin-policy-settings', true);
  const result = await page.load(api);
  const edit = result.actions.find(action => action.label === '编辑策略设置');
  let confirmation;
  await edit.run({
    form: async (_title, fields) => Object.fromEntries(fields.map(field => [field.name, field.name.startsWith('dimension_') ? field.name === 'dimension_models' : field.type === 'boolean' ? field.value : field.value])),
    confirm: async (_title, message) => { confirmation = message; return true; },
    notify() {}, refresh: async () => {},
  });
  const write = calls.find(call => call.path === '/api/admin/policy-settings' && call.options.method === 'PUT');
  assert.equal(write.options.body.team_id, null);
  assert.deepEqual(write.options.body.allowlist_dimensions, ['models']);
  assert.equal(write.options.body.enforcement_mode, 'shadow');
  assert.ok(confirmation.includes('未匹配 allow'));
});

test('policy client page is read-only and warns before high-impact block action', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { items: [{ label: 'Claude Code', request_source: 'claude_code', requests: 10, tokens: 100, hits: 2, blocked: 1 }] }; };
  const result = await pageById('admin-policy-clients', true).load(api);
  assert.equal(calls[0].path, '/api/admin/policy-clients');
  assert.ok(result.sections[0].rows[0].label.includes('claude_code'));
  assert.ok(result.actions.find(action => action.label === '禁止客户端策略'));
});
