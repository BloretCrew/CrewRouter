'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildPages } = require('../tui/pages');

const runtime = { client: { isAdmin: true }, cfg: { tui: { days: 30 } }, profileName: 'test' };
const pageById = id => buildPages(runtime).find(page => page.id === id);

test('user audit log uses the web action-category filter and page size', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { items: [], total: 0, page: 1 }; };
  const page = pageById('audit-logs');
  runtime.userAuditResourceType = 'provider';
  await page.load(api);
  assert.deepEqual(calls.at(-1).options.query, { page: 1, limit: 50, resource_type: 'provider' });
  assert.equal(Object.hasOwn(calls.at(-1).options.query, 'action'), false);
});

test('user audit log uses web resource filter and renders readable event details with bounded pagination', async () => {
  const calls = [];
  runtime.userAuditResourceType = '';
  runtime.userAuditPage = 2;
  const page = pageById('audit-logs');
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    return { page: 2, limit: 50, total: 51, items: [{ created_at: '2026-11-25T08:00:00Z', action: 'api_key.create', resource_type: 'api_key', resource_id: '17', description: '创建 API Key「Main」', status: 201, duration_ms: 12, ip_address: '127.0.0.1', details: { name: 'Main', enabled: true } }] };
  };
  const data = await page.load(api);
  const section = data.sections[0];
  assert.match(section.description, /第 2\/2 页.*操作：全部资源/);
  assert.equal(section.rows[0].label.split(' · ')[1], '创建 API Key');
  for (const value of ['目标：API Key #17', '结果：HTTP 201', '耗时：12 毫秒', 'IP 地址：127.0.0.1', '详细信息：name=Main · enabled=true']) assert.ok(section.rows[0].detail.includes(value));
  const filterAction = data.actions.find(action => action.label === '筛选操作');
  await filterAction.run({ choose: async (_title, options) => { assert.deepEqual(options.map(option => option.label), ['全部操作', 'API Key', 'Co-Key', '用户', '认证', '供应商', '模型']); return 'api_key'; }, refresh: async () => {} });
  assert.equal(runtime.userAuditResourceType, 'api_key');
  assert.equal(runtime.userAuditPage, 1);
  assert.equal(data.actions.find(action => action.label === '上一页').disabled, false);
  assert.equal(data.actions.find(action => action.label === '下一页').disabled, true);
  assert.equal(runtime.userAuditPage, 1, 'choosing a web action category restarts pagination at page one');
  assert.equal(runtime.userAuditResourceType, 'api_key');
  const lastPage = await page.load(async (_path, options) => { assert.equal(options.query.page, 1); return { page: 1, limit: 50, total: 0, items: [] }; });
  assert.equal(lastPage.actions.find(action => action.label === '上一页').disabled, true);
  assert.equal(lastPage.actions.find(action => action.label === '下一页').disabled, true);
  assert.equal(lastPage.sections[0].rows[0].label, '暂无操作日志。');
});

test('admin user list mirrors web summary cards, columns, readable details and bounded pagination', async () => {
  const calls = [];
  const runtime = { client: { isAdmin: true }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/admin/users') return { items: [{ id: 5, username: 'alice', email: 'a@example.test', is_admin: false, email_verified: false, balance: 12.6, team_id: 2, team_name: 'Team A', rate_limit_rpm: 10, rate_limit_tpm: 100, tags: ['ops'], created_at: '2026-11-25T00:00:00Z' }], total: 61, page: options.query.page, limit: 30, stats: { adminCount: 3, verifiedCount: 45, totalBalance: 1234.5 } }; return {}; };
  const page = buildPages(runtime).find(item => item.id === 'admin-users');
  const data = await page.load(api);
  assert.deepEqual(data.sections.map(section => section.title), ['用户概览', '用户列表']);
  assert.deepEqual(data.sections[0].cards.map(card => [card.label, card.value]), [['总用户数', '61'], ['管理员', '3'], ['邮箱已验证', '45'], ['总积分', '1,235']]);
  const table = data.sections[1];
  assert.deepEqual(table.columns.map(column => column.label), ['用户名', '邮箱', '验证状态', '积分', '角色', '速率限制', '注册时间', '操作']);
  assert.equal(table.rows[0].cells.verified, '未验证');
  assert.equal(table.rows[0].cells.rate, '10 次/分 · 100 Token/分');
  assert.equal(data.actions.find(action => action.label === '上一页').disabled, true);
  assert.equal(data.actions.find(action => action.label === '下一页').disabled, false);
  runtime.adminUsersPage = 3;
  const lastPage = await page.load(api);
  assert.equal(lastPage.actions.find(action => action.label === '下一页').disabled, true);
  let detail = '';
  await lastPage.sections[1].rows[0].run({ choose: async () => 'detail', show: async (_title, body) => { detail = body; } });
  assert.match(detail, /用户编号：5/);
  assert.match(detail, /Team：Team A/);
  assert.doesNotMatch(detail, /"email"|"team_id"/);
  let destination = '';
  await lastPage.actions.find(action => action.label === '生成邀请链接').run({ navigate: async pageId => { destination = pageId; } });
  assert.equal(destination, 'admin-invites');
  assert.deepEqual(calls.map(call => call.options.query), [{ page: 1, limit: 30, q: '' }, { page: 3, limit: 30, q: '' }]);
});

test('admin user edits use named Teams and refundable balances with confirmed net-amount refunds', async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/users') return { items: [{ id: 5, username: 'alice', email: 'a@example.test', is_admin: false, email_verified: false, balance: 20, team_id: 2, rate_limit_rpm: 10, rate_limit_tpm: 100, tags: ['ops'] }], total: 1, page: 1 };
    if (path === '/api/admin/teams') return [{ id: 2, name: 'Team Two' }, { id: 3, name: 'Team Three' }];
    if (path.endsWith('/code-balances')) return [{ code: 'SECRET-CODE-12345', amount: 11, fee_rate: 0.1, net_amount: 10 }, { code: 'ANOTHER-CODE-12345', amount: 5.5, fee_rate: 0, net_amount: 5.5 }];
    if (path.endsWith('/refund')) return { success: true, actualRefundAmount: 12, grossDeducted: 13.2, newRefundBalance: 2.3 };
    return {};
  };
  const page = pageById('admin-users');
  const data = await page.load(api);
  const row = data.sections.find(section => section.title === '用户列表').rows[0];
  const formValues = { email: 'new@example.test', email_verified: true, isAdmin: false, balance: '12', team_id: '3', rate_limit_rpm: '20', rate_limit_tpm: '200', tags: 'ops,urgent' };
  let fields;
  let formDescription = '';
  await row.run({ choose: async () => 'edit', form: async (_title, formFields, options) => { fields = formFields; formDescription = options.description; return formValues; }, confirm: async () => false, notify() {}, refresh: async () => {} });
  assert.equal(calls.some(call => call.options.method === 'PUT'), false);
  const teamField = fields.find(field => field.name === 'team_id');
  assert.deepEqual(teamField.options, [{ value: '', label: '未指定 Team' }, { value: '2', label: 'Team Two' }, { value: '3', label: 'Team Three' }]);
  assert.match(formDescription, /可退款余额：15\.50 积分（2 条兑换记录/);
  assert.equal(fields.some(field => field.name === 'refund_info'), false, 'read-only balance summary must not become an editable form field');
  await row.run({ choose: async () => 'edit', form: async () => formValues, confirm: async () => true, notify() {}, refresh: async () => {} });
  const write = calls.find(call => call.options.method === 'PUT');
  assert.deepEqual(write.options.body, { email: 'new@example.test', email_verified: true, isAdmin: false, balance: 12, team_id: 3, rate_limit_rpm: 20, rate_limit_tpm: 200, tags: ['ops', 'urgent'] });

  let details = '';
  await row.run({ choose: async () => 'balance', show: async (_title, body) => { details = body; } });
  assert.match(details, /SEC…345 · 原余额 11\.00 · 可退净额 10\.00 积分 · 手续费 10\.0%/);
  assert.doesNotMatch(details, /SECRET-CODE|ANOTHER-CODE/);

  let amountNotice = '';
  await row.run({ choose: async () => 'refund', ask: async () => '16', show: async (_title, body) => { amountNotice = body; } });
  assert.match(amountNotice, /不超过可退净额 15\.50/);
  assert.equal(calls.some(call => call.path.endsWith('/refund')), false);
  let refundWarning = '';
  await row.run({ choose: async () => 'refund', ask: async () => '12.00', confirm: async (_title, body) => { refundWarning = body; return false; } });
  assert.match(refundWarning, /退款净额：12\.00\n可退余额：15\.50/);
  assert.equal(calls.some(call => call.path.endsWith('/refund')), false, 'declining refund confirmation must not post');
  let refundResult = '';
  await row.run({ choose: async () => 'refund', ask: async () => '12.00', confirm: async () => true, show: async (_title, body) => { refundResult = body; }, refresh: async () => {} });
  const refund = calls.find(call => call.path.endsWith('/refund'));
  assert.deepEqual(refund.options.body, { refundAmount: 12 });
  assert.match(refundResult, /实际退款：12\.00/);
});

test('admin general settings and request capture use readable web fields with validated payloads', async () => {
  const calls = [];
  const runtime = { client: { isAdmin: true }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const general = { site_name: 'Router', defaultBalance: 250, defaultKeyExpiry: 90, billing_mode: 'rate', rate_price_per_request: 0.05, stats_refresh_interval_sec: 20, login_report_enabled: false, stats_report_enabled: true, stats_report_granularity: 'counts', model_list: ['fusion', 'model-a'] };
  const quota = { enabled: true, mode: 'strict', reconciliation_seconds: 90, max_tries: 4, worker_interval_ms: 3000, batch_size: 12, lease_seconds: 180 };
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/admin/settings') return general; if (path === '/api/admin/request-quota-config') return quota; if (path === '/api/admin/agent-web') return {}; if (path === '/api/admin/retention-config') return {}; if (path === '/api/admin/feishu-login') return {}; return {}; };
  const data = await pageById('admin-settings').load(api);
  const generalSection = data.sections.find(section => section.title === '常规设置');
  assert.deepEqual(generalSection.cards.map(card => card.label), ['系统名称', '默认新用户积分', '默认 Key 有效期', '统计刷新间隔']);
  assert.ok(generalSection.rows.some(row => row.label === '计费模式：按请求计费 · 0.0500 积分/次'));
  assert.ok(generalSection.rows.some(row => row.label === '匿名统计上报：开启' && row.detail.includes('仅聚合计数')));
  assert.ok(generalSection.rows.some(row => row.label === '可用模型：2 个' && row.detail === 'fusion、model-a'));
  const generalAction = data.actions.find(action => action.label === '编辑常规设置');
  let generalFields;
  const generalValues = { site_name: 'Router Two', defaultBalance: '300', defaultKeyExpiry: '0', billing_mode: 'rate', rate_price_per_request: '0.08', stats_refresh_interval_sec: '25', login_report_enabled: true, stats_report_enabled: false, stats_report_granularity: 'detailed' };
  const modelChoices = ['remove:model-a', 'add', 'add', 'add', 'done'];
  const modelInputs = ['fusion', 'model-b', 'model-b'];
  const runGeneralEdit = confirm => generalAction.run({
    form: async (_title, fields) => { generalFields = fields; return generalValues; },
    choose: async (_title, options) => { assert.ok(options.some(option => option.label === '完成模型列表')); return modelChoices.shift(); },
    ask: async () => modelInputs.shift(), show: async (_title, message) => { assert.match(message, /fusion (?:已)?固定保留|已在可用列表中|至少保留一个非 fusion/); },
    confirm, notify() {}, refresh: async () => {},
  });
  await runGeneralEdit(async () => false);
  assert.deepEqual(generalFields.map(field => field.name), ['site_name', 'defaultBalance', 'defaultKeyExpiry', 'billing_mode', 'rate_price_per_request', 'stats_refresh_interval_sec', 'login_report_enabled', 'stats_report_enabled', 'stats_report_granularity']);
  assert.equal(calls.some(call => call.path === '/api/admin/settings' && call.options.method === 'PUT'), false);
  modelChoices.push('add', 'add', 'done'); modelInputs.push('model-b', 'model-c');
  await runGeneralEdit(async () => true);
  assert.deepEqual(calls.find(call => call.path === '/api/admin/settings' && call.options.method === 'PUT').options.body, { site_name: 'Router Two', defaultBalance: 300, defaultKeyExpiry: 0, billing_mode: 'rate', rate_price_per_request: 0.08, stats_refresh_interval_sec: 25, login_report_enabled: true, stats_report_enabled: false, stats_report_granularity: 'detailed', model_list: ['fusion', 'model-a', 'model-b', 'model-c'] });

  const invalidChoices = ['remove:model-a', 'done'];
  let emptyListNotice = '';
  await generalAction.run({ form: async () => generalValues, choose: async () => invalidChoices.shift(), show: async (_title, message) => { emptyListNotice = message; } });
  assert.match(emptyListNotice, /至少保留一个非 fusion 模型/);
  assert.equal(calls.filter(call => call.path === '/api/admin/settings' && call.options.method === 'PUT').length, 1, 'empty editable model list must be rejected before saving');

  const quotaSection = data.sections.find(section => section.title === '请求额度采集');
  assert.ok(quotaSection.cards.some(card => card.label === '采集模式' && card.value === '请求前后精细采集'));
  const quotaAction = data.actions.find(action => action.label === '编辑请求额度采集');
  const quotaValues = { enabled: false, mode: 'async', reconciliation_seconds: '0', max_tries: '2', worker_interval_ms: '1000', batch_size: '8', lease_seconds: '90' };
  await quotaAction.run({ form: async () => quotaValues, confirm: async () => false });
  assert.equal(calls.some(call => call.path === '/api/admin/request-quota-config' && call.options.method === 'PUT'), false);
  let quotaNotice = '';
  await quotaAction.run({ form: async () => ({ ...quotaValues, batch_size: '101' }), show: async (_title, message) => { quotaNotice = message; } });
  assert.match(quotaNotice, /batch_size.*1–100/);
  await quotaAction.run({ form: async () => quotaValues, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.find(call => call.path === '/api/admin/request-quota-config' && call.options.method === 'PUT').options.body, { enabled: false, mode: 'async', reconciliation_seconds: 0, max_tries: 2, worker_interval_ms: 1000, batch_size: 8, lease_seconds: 90 });
});

test('admin Agent Web settings expose web fields with masked keys and validated complete updates', async () => {
  const calls = [];
  const runtime = { client: { isAdmin: true }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const agentConfig = { search: { enabled: true, provider: 'brave', apiKey: '[configured]', hasApiKey: true, maxResults: 4, timeoutMs: 6000 }, fetch: { enabled: true, maxBytes: 524288, timeoutMs: 9000 } };
  let feishuConfig = { enabled: true, appId: 'cli_public_123', appSecret: '[redacted]', hasAppSecret: true, tenantKey: 'tenant-a', redirectUri: 'https://router.example/auth/feishu/callback', source: 'config' };
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/admin/settings') return {}; if (path === '/api/admin/request-quota-config') return {}; if (path === '/api/admin/agent-web') return agentConfig; if (path === '/api/admin/retention-config') return {}; if (path === '/api/admin/feishu-login' && options.method === 'PUT') { assert.equal(options.body.appSecret, ''); assert.equal(options.body.tenantKey, ''); feishuConfig = { ...feishuConfig, ...options.body, appSecret: '[redacted]', hasAppSecret: true, source: 'settings' }; return { success: true, ...feishuConfig }; } if (path === '/api/admin/feishu-login') return feishuConfig; return {}; };
  const page = buildPages(runtime).find(item => item.id === 'admin-settings');
  const data = await page.load(api);
  const section = data.sections.find(item => item.title === 'Agent Web 资料设置');
  assert.deepEqual(section.cards.map(card => card.label), ['联网搜索', '搜索结果数', '搜索超时', '链接抓取']);
  assert.match(section.cards[0].detail, /Brave Search.*API Key：已配置（不显示密钥）/);
  assert.ok(section.rows.some(row => row.label === '抓取内容上限：512 KB'));
  assert.doesNotMatch(JSON.stringify(section), /\\[configured\\]/);
  const action = data.actions.find(item => item.label === '编辑 Agent Web 设置');
  let formFields;
  const values = { search_enabled: true, provider: 'brave', apiKey: '', clearApiKey: false, maxResults: '6', searchTimeoutMs: '10000', fetch_enabled: true, maxBytes: '1048576', fetchTimeoutMs: '12000' };
  await action.run({ form: async (_title, fields) => { formFields = fields; return values; }, confirm: async () => false });
  assert.deepEqual(formFields.map(field => field.name), ['search_enabled', 'provider', 'apiKey', 'clearApiKey', 'maxResults', 'searchTimeoutMs', 'fetch_enabled', 'maxBytes', 'fetchTimeoutMs']);
  assert.equal(calls.some(call => call.path === '/api/admin/agent-web' && call.options.method === 'PUT'), false);
  await action.run({ form: async () => values, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.find(call => call.path === '/api/admin/agent-web' && call.options.method === 'PUT').options.body, { search: { enabled: true, provider: 'brave', maxResults: 6, timeoutMs: 10000 }, fetch: { enabled: true, maxBytes: 1048576, timeoutMs: 12000 } });
  let invalidNotice = '';
  await action.run({ form: async () => ({ ...values, maxResults: '9' }), show: async (_title, message) => { invalidNotice = message; } });
  assert.match(invalidNotice, /搜索结果数须为 1-8/);
  assert.equal(calls.filter(call => call.path === '/api/admin/agent-web' && call.options.method === 'PUT').length, 1);
  const feishu = data.sections.find(item => item.title === '飞书登录');
  assert.deepEqual(feishu.cards.map(card => [card.label, card.value]), [['飞书登录', '已启用'], ['App ID', 'cli_public_123'], ['App Secret', '已配置（隐藏）'], ['企业限制', '仅允许指定企业']]);
  assert.ok(feishu.rows.some(row => row.label === '配置来源：配置文件/环境变量（尚未保存到后台）'));
  assert.doesNotMatch(JSON.stringify(feishu), /\\[redacted\\]/);
  let callbackDetails = '';
  await feishu.rows.find(row => row.label === 'OAuth 回调地址').run({ show: async (_title, body) => { callbackDetails = body; } });
  assert.match(callbackDetails, /https:\/\/router\.example\/auth\/feishu\/callback/);
  assert.doesNotMatch(callbackDetails, /redacted|secret/i);
  const editFeishu = data.actions.find(action => action.label === '编辑飞书登录');
  let feishuFields = [];
  await editFeishu.run({ form: async (_title, fields, options) => { feishuFields = fields; assert.match(options.description, /保存后写入后台数据库/); return { enabled: true, appId: 'cli_public_123', appSecret: '', tenantKey: '' }; }, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.match(feishuFields.find(field => field.name === 'tenantKey').label, /留空表示不限制企业/);
  assert.deepEqual(calls.find(call => call.path === '/api/admin/feishu-login' && call.options.method === 'PUT').options.body, { enabled: true, appId: 'cli_public_123', appSecret: '', tenantKey: '' });
});

test('admin proxy pool settings redact credentials and manage subscription/manual proxy drafts safely', async () => {
  const calls = [];
  const runtime = { client: { isAdmin: true, baseUrl: 'https://router.example' }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/settings') return { proxy_pool_subscription_url: 'https://feed-user:feed-pass@proxy.example/list?token=feed-secret', proxy_pool_manual_proxies: [{ id: 'p1', url: 'socks5://user:pass@proxy.example:1080', enabled: true }] };
    if (path === '/api/admin/fetch-proxies-url') return { success: true, count: 2, proxies: ['http://proxy-one.example:8080', 'socks5://user:pass@proxy-two.example:1080'] };
    return {};
  };
  const page = buildPages(runtime).find(item => item.id === 'admin-settings');
  const data = await page.load(api);
  const proxySection = data.sections.find(section => section.title === '网络与代理池');
  assert.ok(proxySection.rows.some(row => row.label.includes('•••:•••@proxy.example') && row.label.includes('token=•••')));
  assert.ok(proxySection.rows.some(row => row.label.includes('•••:•••@proxy.example:1080')));
  assert.doesNotMatch(JSON.stringify(proxySection), /feed-pass|feed-secret|user:pass/);
  let importConfirm = '';
  await data.actions.find(action => action.label === '从公网 URL 导入代理列表').run({ ask: async () => 'https://import.example/proxies?token=secret-import', confirm: async (_title, message) => { importConfirm = message; return false; }, show: async () => {} });
  assert.match(importConfirm, /token=•••/);
  assert.equal(calls.some(call => call.path === '/api/admin/fetch-proxies-url'), false, 'declining confirmation must not make the server fetch the URL');

  await data.actions.find(action => action.label === '从公网 URL 导入代理列表').run({ ask: async () => 'https://import.example/proxies', confirm: async () => true, show: async () => {}, refresh: async () => {} });
  assert.deepEqual(calls.find(call => call.path === '/api/admin/fetch-proxies-url').options.body, { url: 'https://import.example/proxies' });
  assert.equal(runtime.adminProxyPoolDraft.length, 3);
  const save = data.actions.find(action => action.label === '保存代理池设置');
  await save.run({ confirm: async (_title, message) => { assert.match(message, /手动代理：3 个/); assert.doesNotMatch(message, /user:pass|feed-pass/); return true; }, notify() {}, refresh: async () => {} });
  const write = calls.find(call => call.path === '/api/admin/settings' && call.options.method === 'PUT');
  assert.equal(write.options.body.proxy_pool_subscription_url, 'https://feed-user:feed-pass@proxy.example/list?token=feed-secret');
  assert.equal(write.options.body.proxy_pool_manual_proxies.length, 3);
});

test('user settings show readable profile/signature fields and edit the complete signature form', async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/user/signature') return { enabled: true, template: 'Hello {{username}}', defaults: { variables: [{ name: 'username' }, { name: 'model' }] } };
    if (path === '/auth/me') return { username: 'alice', email: 'alice@example.test', avatar: 'https://example.test/avatar.png' };
    if (path === '/api/user/plugin-pref-optin') return { optedIn: true };
    if (path === '/api/user/hook-notify-rules') return { pushEnabled: true, selection: { harnesses: ['codex'], eventTypes: ['tool_use'] } };
    if (path === '/api/user/notification-settings') return { barkEnabled: true, barkServerKey: 'private-bark-token', barkEndpoint: 'https://api.day.app', notifyQuota: true, notifyErrors: false };
    if (path === '/api/user/notifications') return [{ id: 1, title: '额度不足', body: 'Quota low', read_at: null, created_at: '2026-11-25T00:00:00Z' }];
    return {};
  };
  const page = pageById('settings');
  const data = await page.load(api);
  assert.deepEqual(data.sections.map(section => section.title), ['个人资料', '通知', '我的通知', 'API 签名', '插件授权', '事件通知', '网页专属设置']);
  assert.ok(data.sections[0].rows.some(row => row.label.includes('alice@example.test')));
  assert.ok(data.sections[1].rows.some(row => row.detail.includes('Server Key：已配置（不显示密钥）')));
  assert.ok(data.sections[1].rows.some(row => row.label.includes('额度不足开启 · 请求异常关闭')));
  assert.equal(data.sections[2].rows[0].label, '未读 · 额度不足');
  assert.doesNotMatch(JSON.stringify(data.sections), /private-bark-token/);
  assert.ok(data.sections[3].rows.some(row => row.label.includes('可用变量：username、model')));
  assert.ok(data.sections[4].rows.some(row => row.label.includes('已授权')));
  assert.ok(data.sections[5].rows.some(row => row.label === '客户端：Codex'));
  assert.ok(data.sections[5].rows.some(row => row.label === '事件：工具调用'));
  assert.ok(data.sections[6].rows.some(row => row.label === '全局代理池（网页网络设置）' && /供应商选择“代理池”模式并启用后才生效/.test(row.detail)));
  assert.ok(data.sections[6].rows.some(row => row.label.includes('界面背景与主题')));
  const notificationEdit = data.actions.find(action => action.label === '编辑通知设置');
  let notificationFields;
  await notificationEdit.run({ form: async (_title, fields) => { notificationFields = fields; return { barkEnabled: true, barkServerKey: '', barkEndpoint: 'https://api.day.app', notifyQuota: true, notifyErrors: false }; }, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(notificationFields.map(field => field.name), ['barkEnabled', 'barkServerKey', 'barkEndpoint', 'notifyQuota', 'notifyErrors']);
  const notificationWrite = calls.find(call => call.path === '/api/user/notification-settings' && call.options.method === 'PUT');
  assert.deepEqual(notificationWrite.options.body, { barkEnabled: true, barkEndpoint: 'https://api.day.app', notifyQuota: true, notifyErrors: false });
  assert.equal(Object.hasOwn(notificationWrite.options.body, 'barkServerKey'), false, 'blank secret preserves the stored Bark key');

  let testNoticeConfirmed = false;
  await data.actions.find(action => action.label === '发送测试 Bark 通知').run({ confirm: async () => { testNoticeConfirmed = true; return false; } });
  assert.equal(testNoticeConfirmed, true);
  assert.equal(calls.some(call => call.path.endsWith('/notification-settings/test')), false);
  let clearConfirmed = false;
  await data.actions.find(action => action.label === '清空站内通知').run({ confirm: async () => { clearConfirmed = true; return false; } });
  assert.equal(clearConfirmed, true);
  assert.equal(calls.some(call => call.path === '/api/user/notifications' && call.options.method === 'DELETE'), false);

  const edit = data.actions.find(action => action.label === '编辑 API 签名');
  let fields;
  await edit.run({ form: async (_title, input) => { fields = input; return { enabled: false, template: 'Updated {{model}}' }; }, confirm: async () => false, notify() {}, refresh: async () => {} });
  assert.deepEqual(fields.map(field => field.name), ['enabled', 'template']);
  assert.equal(calls.some(call => call.path === '/api/user/signature' && call.options.method === 'PUT'), false);
  await edit.run({ form: async () => ({ enabled: false, template: 'Updated {{model}}' }), confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.find(call => call.path === '/api/user/signature' && call.options.method === 'PUT').options.body, { enabled: false, template: 'Updated {{model}}' });

  const optin = data.actions.find(action => action.label === '关闭插件偏好授权');
  await optin.run({ confirm: async () => false, notify() {}, refresh: async () => {} });
  assert.equal(calls.some(call => call.path === '/api/user/plugin-pref-optin' && call.options.method === 'PUT'), false);
  await optin.run({ confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.find(call => call.path === '/api/user/plugin-pref-optin' && call.options.method === 'PUT').options.body, { enabled: false });

  const pushToggle = data.actions.find(action => action.label === '关闭事件推送');
  await pushToggle.run({ confirm: async () => false, notify() {}, refresh: async () => {} });
  assert.equal(calls.some(call => call.path.endsWith('/push-enabled')), false);
  await pushToggle.run({ confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.find(call => call.path.endsWith('/push-enabled')).options.body, { enabled: false });

  const selectionAction = data.actions.find(action => action.label === '选择事件推送范围');
  const selectionChoices = ['claude_code', '__done__', 'session_start', '__done__'];
  await selectionAction.run({
    choose: async () => selectionChoices.shift(),
    confirm: async () => true,
    notify() {}, refresh: async () => {},
  });
  assert.deepEqual(calls.find(call => call.path.endsWith('/selection')).options.body, { harnesses: ['codex', 'claude_code'], eventTypes: ['tool_use', 'session_start'] });
});

test('admin OAuth clients mirror web columns and support scoped client lifecycle actions', async () => {
  const calls = [];
  const scopeCatalog = [{ scope: 'gateway:invoke', description: '通过网关调用模型接口' }, { scope: 'events:report', description: '仅向 CrewRouter 上报客户端使用事件' }];
  const clients = [{ client_id: 'custom-app', name: 'Custom App', type: 'confidential', source: 'database', editable: true, enabled: true, scopes: ['gateway:invoke'], redirect_uris: ['https://app.example/callback'], has_secret: true, secret_hint: 'abc123', description: 'Internal' }, { client_id: 'builtin-cli', name: 'Built-in CLI', type: 'public', source: 'builtin', editable: false, enabled: true, scopes: ['gateway:invoke'], redirect_uris: ['http://127.0.0.1/callback'], has_secret: false }];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/oauth-clients') return { clients, scopes: scopeCatalog };
    if (path === '/api/admin/oauth-clients/custom-app') return { client: clients[0], revokedTokens: 0 };
    return {};
  };
  const data = await pageById('admin-oauth-clients').load(api);
  assert.deepEqual(data.sections[0].columns.map(column => column.label), ['应用', '类型', '权限 / 回调', '客户端密钥', '状态', '操作']);
  assert.deepEqual(data.sections[0].rows.map(row => [row.cells.scopes, row.cells.secret, row.cells.actions]), [['gateway:invoke · 1 个回调', '已设置 abc123…', '管理'], ['gateway:invoke · 1 个回调', '不使用', '只读']]);
  const builtInOptions = [];
  let builtInDetail = '';
  await data.sections[0].rows[1].run({ choose: async (_title, options) => { builtInOptions.push(...options); return 'detail'; }, show: async (_title, body) => { builtInDetail = body; } });
  assert.deepEqual(builtInOptions.map(option => option.value), ['detail']);
  assert.match(builtInDetail, /回调地址：http:\/\/127\.0\.0\.1\/callback/);
  const confidentialOptions = [];
  await data.sections[0].rows[0].run({ choose: async (_title, options) => { confidentialOptions.push(...options); return null; } });
  assert.ok(confidentialOptions.some(option => option.value === 'rotate'));
  const publicClient = { ...clients[0], client_id: 'public-app', type: 'public' };
  const publicData = await pageById('admin-oauth-clients').load(async () => ({ clients: [publicClient], scopes: scopeCatalog }));
  const publicOptions = [];
  await publicData.sections[0].rows[0].run({ choose: async (_title, options) => { publicOptions.push(...options); return null; } });
  assert.ok(!publicOptions.some(option => option.value === 'rotate'), 'public OAuth clients have no secret to rotate');
  const choices = ['events:report', '__done__'];
  const formData = { name: 'New Client', clientId: '', type: 'public', redirects: 'https://client.example/cb', allowLoopbackAnyPath: false, description: '', enabled: true };
  await data.actions.find(action => action.label === '新建 OAuth 应用').run({
    choose: async () => choices.shift(),
    form: async () => formData,
    confirm: async () => true,
    show: async (_title, content) => { assert.match(content, /仅显示一次/); },
    notify() {}, refresh: async () => {},
  });
  const create = calls.find(call => call.path === '/api/admin/oauth-clients' && call.options.method === 'POST');
  assert.deepEqual(create.options.body.scopes, ['gateway:invoke', 'events:report']);
  assert.deepEqual(create.options.body.redirectUris, ['https://client.example/cb']);
  assert.equal(create.options.body.type, 'public');
});

test('admin retention page mirrors web thresholds, validates saves and runs preview tasks', async () => {
  const calls = [];
  const config = { compress_days: 30, compress_size_gb: 10, purge_days: 90, purge_size_gb: 20, provider_quota_days: 60, agg_enabled: true };
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/retention-config') return config;
    if (path === '/api/admin/retention/run-compress') return { taskId: 'task-1', status: 'queued' };
    if (path === '/api/admin/retention/run-purge') return { taskId: 'task-2', status: 'queued' };
    if (path === '/api/admin/retention/tasks/task-1') return { status: 'completed', result: { compressed: 0 } };
    if (path === '/api/admin/retention/tasks/task-2') return { status: 'completed', result: { purged: 0 } };
    return {};
  };
  const page = pageById('admin-retention');
  const data = await page.load(api);
  assert.deepEqual(data.sections.map(section => section.title), ['压缩阈值', '清除阈值', '其他保留配置', '任务状态']);
  assert.ok(data.sections[0].rows[0].label.includes('30 天'));
  const edit = data.actions.find(action => action.label === '编辑保留配置');
  let invalidNotice = '';
  await edit.run({ form: async () => ({ ...config, compress_days: 90 }), show: async (_title, message) => { invalidNotice = message; } });
  assert.match(invalidNotice, /压缩天数必须小于清除天数/);
  await edit.run({ form: async () => ({ ...config, compress_size_gb: 20 }), show: async (_title, message) => { invalidNotice = message; } });
  assert.match(invalidNotice, /压缩大小必须小于清除大小/);
  const values = { ...config };
  await edit.run({ form: async () => values, confirm: async () => true, notify() {}, refresh: async () => {} });
  const save = calls.find(call => call.path === '/api/admin/retention-config' && call.options.method === 'PUT');
  assert.deepEqual(save.options.body, config);

  let result = '';
  await data.actions.find(action => action.label === '预览压缩（dry-run）').run({ confirm: async () => false, show: async (_title, body) => { result = body; } });
  assert.ok(calls.some(call => call.path === '/api/admin/retention/run-compress' && call.options.body.dry_run === true));
  assert.match(result, /已压缩：0/);
  assert.doesNotMatch(result, /"compressed"/);
  calls.length = 0;
  let preview = '';
  let previewTitle = '';
  await data.actions.find(action => action.label === '预览清除（dry-run）').run({ confirm: async () => { assert.fail('dry-run preview should not require destructive confirmation'); }, show: async (title, body) => { previewTitle = title; preview = body; } });
  assert.deepEqual(calls.find(call => call.path === '/api/admin/retention/run-purge').options.body, { dry_run: true });
  assert.match(previewTitle, /预览完成（dry-run）/);
  assert.match(preview, /预览模式：未修改或删除数据/);
  assert.doesNotMatch(preview, /"taskId"|"status"|"result"/);
  calls.length = 0;
  await data.actions.find(action => action.label === '立即执行清除').run({ confirm: async () => false, show: async () => {} });
  assert.equal(calls.length, 0, 'destructive purge must not start when confirmation is declined');
});

test('admin model management presents web columns, selects web filters and avoids raw JSON details', async () => {
  const calls = [];
  const model = { id: 'm1', name: 'Model One', alias: 'Friendly', upstream_model_id: 'up-1', provider: 'p1', provider_name: 'Provider One', series: 'S', enabled: true, input_price_per_1k_tokens: 0.1, output_price_per_1k_tokens: 0.2, cached_output_price_per_1k_tokens: 0.05, reference_input_price_per_1k_tokens: 0.3, reference_output_price_per_1k_tokens: 0.4, model_multiplier: 1.2, completion_multiplier: 1.3, rate_limit_rpm: 10, rate_limit_tpm: 100, test_ok: true, test_latency_ms: 25, test_tokens_per_second: 42.5 };
  const api = async (path, options = {}) => { calls.push({ path, options }); return { items: [model], total: 1, page: 1, stats: { enabledCount: 1, providerCount: 1, avgInputPrice: 0.1 }, providers: [{ id: 'p1', name: 'Provider One', model_count: 1 }], series: ['S'] }; };
  const data = await pageById('admin-models').load(api);
  const section = data.sections[0];
  assert.deepEqual(section.columns.map(column => column.label), ['模型名称', '供应商', '系列', '输入价/千Token', '输出价/千Token', '倍率', '缓存输出价', '请求/Token限额', '状态/测试']);
  assert.equal(section.rows[0].cells.input, '0.1 元');
  assert.equal(section.rows[0].cells.multiplier, '×1.20');
  assert.match(section.rows[0].cells.state, /42\.50 Token\/秒/);
  assert.equal(section.rows[0].cells.limits, '10 次/分 · 100 Token/分');
  assert.ok(data.actions.find(action => action.label === '筛选供应商' && action.toolbar === 'page'));
  assert.ok(data.actions.find(action => action.label === '筛选系列' && action.toolbar === 'page'));
  const providerChoices = [];
  await data.actions.find(action => action.label === '筛选供应商').run({ choose: async (_title, options) => { providerChoices.push(...options); return 'p1'; }, refresh: async () => {} });
  assert.deepEqual(runtime.adminModelFilters.provider, 'p1');
  assert.equal(providerChoices[1].label, 'Provider One · 1 个模型');
  let detail = '';
  await section.rows[0].run({ choose: async () => 'detail', show: async (_title, value) => { detail = value; } });
  assert.match(detail, /上游模型 ID：up-1/);
  assert.match(detail, /输入价格：0.1 元\/千 Token/);
  assert.doesNotMatch(detail, /input_price_per_1k_tokens/);
});

test('admin model actions create, edit, batch update, delete and export through confirmed routes', async () => {
  const model = { id: 'm1', name: 'Model One', alias: 'Friendly', upstream_model_id: 'up-1', provider: 'p1', provider_name: 'Provider One', series: 'S', enabled: true, input_price_per_1k_tokens: 0.1, output_price_per_1k_tokens: 0.2, cached_output_price_per_1k_tokens: 0.05, reference_input_price_per_1k_tokens: 0.3, reference_output_price_per_1k_tokens: 0.4, reference_cached_output_price_per_1k_tokens: 0.06, model_multiplier: 1.2, completion_multiplier: 1.3, rate_limit_rpm: 10, rate_limit_tpm: 100, thinking_model_id: '', non_thinking_model_id: '' };
  const calls = [];
  const api = async (endpoint, options = {}) => { calls.push({ endpoint, options }); if (endpoint === '/api/admin/models') return { items: [model], total: 1, page: options.query?.page || 1, stats: {}, providers: [{ id: 'p1', name: 'Provider One', model_count: 1 }], series: ['S'] }; if (endpoint === '/api/admin/models/batch-update-prices') return { updated: 1 }; return { updated: 1, deleted: 1, cleared_keys: 2 }; };
  const page = pageById('admin-models');
  const initial = await page.load(api);
  const add = initial.actions.find(action => action.label === '添加模型');
  let addFields = [];
  const formValues = { upstream_model_id: 'up-new', alias: 'New', provider: 'p1', series: 'S', description: 'desc', enabled: true, input_price_per_1k_tokens: '0.1', output_price_per_1k_tokens: '0.2', cached_output_price_per_1k_tokens: '0.03', reference_input_price_per_1k_tokens: '0', reference_output_price_per_1k_tokens: '0', reference_cached_output_price_per_1k_tokens: '0', rate_limit_rpm: '0', rate_limit_tpm: '0', model_multiplier: '1', completion_multiplier: '1', thinking_model_id: '', non_thinking_model_id: '' };
  await add.run({ form: async (_title, fields) => { addFields = fields; return formValues; }, confirm: async () => false });
  assert.equal(calls.some(call => call.options.method === 'POST' && call.endpoint === '/api/admin/models'), false);
  await add.run({ form: async () => formValues, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.ok(addFields.some(field => field.label === '输入价格（元/千 Token）'));
  const create = calls.find(call => call.endpoint === '/api/admin/models' && call.options.method === 'POST');
  assert.equal(create.options.body.upstream_model_id, 'up-new');
  assert.equal(create.options.body.input_price_per_1k_tokens, 0.1);

  const editCalls = [];
  const editData = await page.load(async (endpoint, options = {}) => { if (options.method) editCalls.push({ endpoint, options }); return { items: [model], total: 1, providers: [{ id: 'p1', name: 'Provider One' }], series: ['S'] }; });
  const editRow = editData.sections[0].rows[0];
  let editForm = {};
  await editRow.run({ choose: async () => 'edit', form: async (_title, fields) => { editForm = Object.fromEntries(fields.map(field => [field.name, field.value])); return { ...editForm, alias: 'Updated', input_price_per_1k_tokens: '0.5' }; }, confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.equal(editCalls[0].endpoint, '/api/admin/models');
  assert.equal(editCalls[0].options.body.id, 'm1');
  assert.equal(editCalls[0].options.body.reference_cached_output_price_per_1k_tokens, 0.06);

  const bulkApi = async (endpoint, options = {}) => { calls.push({ endpoint, options }); if (endpoint === '/api/admin/models') return { items: [model], total: 1, providers: [], series: [] }; return { updated: 1, deleted: 1, cleared_keys: 0 }; };
  const selectable = await page.load(bulkApi);
  const choices = ['select', 'select'];
  await selectable.sections[0].rows[0].run({ choose: async () => choices.shift(), refresh: async () => {} });
  const bulk = (await page.load(bulkApi)).actions.find(action => action.label.startsWith('批量管理'));
  const bulkChoices = ['prices', 'set', 'set'];
  await bulk.run({ choose: async (_title, options) => options.some(option => option.value === 'set' || option.value === 'multiply') ? bulkChoices.shift() : bulkChoices.shift(), form: async () => ({ input_price: '1', output_price: '2', cached_output_price: '0.5' }), confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.find(call => call.endpoint === '/api/admin/models/batch-update-prices').options.body, { ids: ['m1'], mode: 'set', input_price: 1, output_price: 2, cached_output_price: 0.5 });

  runtime.adminModelSelectedIds = ['m1'];
  const deleteBulk = (await page.load(bulkApi)).actions.find(action => action.label.startsWith('批量管理'));
  let warning = '';
  await deleteBulk.run({ choose: async () => 'delete', confirm: async (_title, message) => { warning = message; return false; } });
  assert.match(warning, /不可撤销/);
  assert.equal(calls.some(call => call.endpoint === '/api/admin/models/batch-delete'), false);

  const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-model-export-'));
  const exportPath = path.join(exportDir, 'models.csv');
  const exportAction = initial.actions.find(action => action.label === '导出当前筛选 CSV');
  await exportAction.run({ ask: async () => exportPath, confirm: async () => true, show: async () => {}, notify() {} });
  const csv = await fs.readFile(exportPath, 'utf8');
  assert.match(csv, /模型 ID/);
  assert.match(csv, /m1/);
  await fs.writeFile(exportPath, 'KEEP');
  await exportAction.run({ ask: async () => exportPath, confirm: async () => false, show: async () => {}, notify() {} });
  assert.equal(await fs.readFile(exportPath, 'utf8'), 'KEEP', 'cancelled overwrite must preserve existing file');
  await fs.rm(exportDir, { recursive: true, force: true });
});

test('admin policy hits mirror web search/source/decision/range filters and detail endpoint', async () => {
  const calls = [];
  const hit = { id: 7, policy_id: 3, policy_name: 'Block risky request', user_id: 9, username: 'alice', team_id: 2, team_name: 'Team A', created_at: '2026-11-25T00:00:00Z', decision: 'block', effect: 'deny', action: 'block', requested_model: 'model-x', request_source: 'codex', reason: 'matched client rule', ip_address: '127.0.0.1' };
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/admin/policy-hits') return { items: [hit], total: 1, page: 1 }; if (path === '/api/admin/policy-clients') return { items: [{ request_source: 'codex', label: 'Codex' }] }; if (path === '/api/admin/policy-hits/7') return hit; return { id: 12 }; };
  const page = pageById('admin-policy-hits');
  const data = await page.load(api);
  assert.equal(calls[0].options.query.limit, 100);
  const initialFrom = Date.parse(calls[0].options.query.from);
  assert.ok(Math.abs(initialFrom - (Date.now() - 24 * 3600000)) < 5000);
  let details = '';
  const row = data.sections[0].rows[0];
  await row.run({ choose: async () => 'detail', show: async (_title, body) => { details = body; } });
  assert.match(details, /决策结果：拦截/);
  assert.match(details, /客户端：codex/);
  await data.actions.find(action => action.label.startsWith('搜索成员或策略')).run({ ask: async () => 'alice', refresh: async () => {} });
  assert.deepEqual(runtime.policyHitFilters, { range: '24h', q: 'alice' });
  await data.actions.find(action => action.label === '筛选客户端').run({ choose: async (_title, options) => { assert.ok(options.some(option => option.value === 'codex')); return 'codex'; }, refresh: async () => {} });
  assert.equal(runtime.policyHitFilters.request_source, 'codex');
  await data.actions.find(action => action.label === '筛选拦截/放行').run({ choose: async () => 'block', refresh: async () => {} });
  assert.equal(runtime.policyHitFilters.decision, 'block');
  await data.actions.find(action => action.label === '筛选时间范围').run({ choose: async () => '7d', refresh: async () => page.load(api) });
  assert.equal(runtime.policyHitFilters.range, '7d');
  assert.equal(runtime.policyHitFilters.decision, 'block');
  const updatedHitCall = calls.filter(call => call.path === '/api/admin/policy-hits').at(-1);
  assert.equal(updatedHitCall.options.query.limit, 100);
  assert.equal(updatedHitCall.options.query.decision, 'block');
  assert.equal(updatedHitCall.options.query.request_source, 'codex');
  assert.ok(updatedHitCall.options.query.from);
  assert.equal(data.actions.some(action => /上一页|下一页/.test(action.label)), false);
  await row.run({ choose: async () => 'detail', show: async () => {} });
  assert.equal(calls.some(call => call.path.endsWith('/from-hit/7')), false, 'hit details stay read-only; exemptions are created from the exemption page');
});

test('admin policy exceptions and appeals filter, revoke, approve and reject with explicit impact', async () => {
  const calls = [];
  const exemption = { id: 11, subject_type: 'user', subject_id: 9, username: 'alice', policy_name: 'Block risky request', reason: 'temporary access', status: 'active', ends_at: '2026-11-26T00:00:00Z', used_count: 1, max_uses: 3 };
  const appeal = { id: 21, user_id: 9, username: 'alice', policy_id: 3, policy_name: 'Block risky request', reason: 'false positive', hit_reason: 'matched rule', hit_action: 'block', status: 'pending', created_at: '2026-11-25T00:00:00Z' };
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/admin/policy-exemptions') return { items: [exemption], total: 1, page: 1 }; if (path === '/api/admin/policy-appeals') return { items: [appeal], total: 1, page: 1 }; if (path === '/api/admin/policies') return { items: [{ id: 3, name: 'Block risky request', scope_type: 'global', effect: 'deny' }] }; return {}; };
  const page = pageById('admin-policy-exceptions');
  const data = await page.load(api);
  assert.deepEqual(calls.slice(0, 2).map(call => call.options.query), [{ limit: 100 }, { limit: 100 }]);
  const create = data.actions.find(action => action.label === '创建策略豁免');
  const createValues = { subject_type: 'user', subject_id: '9', policy_id: '3', hours: '12', max_uses: '4', reason: 'approved test' };
  await create.run({ form: async () => createValues, confirm: async () => false });
  assert.equal(calls.some(call => call.path === '/api/admin/policy-exemptions' && call.options.method === 'POST'), false);
  await create.run({ form: async () => createValues, confirm: async () => true, notify() {}, refresh: async () => {} });
  const created = calls.find(call => call.path === '/api/admin/policy-exemptions' && call.options.method === 'POST');
  assert.deepEqual({ subject_type: created.options.body.subject_type, subject_id: created.options.body.subject_id, policy_id: created.options.body.policy_id, max_uses: created.options.body.max_uses, reason: created.options.body.reason }, { subject_type: 'user', subject_id: 9, policy_id: 3, max_uses: 4, reason: 'approved test' });
  assert.ok(Date.parse(created.options.body.ends_at) > Date.now());
  let revokeMessage = '';
  await data.sections[0].rows[0].run({ confirm: async (_title, message) => { revokeMessage = message; return false; } });
  assert.match(revokeMessage, /恢复接受相关策略检查/);
  assert.equal(calls.some(call => call.path.endsWith('/11') && call.options.method === 'DELETE'), false);
  await data.sections[0].rows[0].run({ confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.ok(calls.some(call => call.path.endsWith('/11') && call.options.method === 'DELETE'));
  let approveMessage = '';
  await data.sections[1].rows[0].run({ choose: async () => 'approve', confirm: async (_title, message) => { approveMessage = message; return true; }, notify() {}, refresh: async () => {} });
  assert.match(approveMessage, /24 小时豁免/);
  assert.deepEqual(calls.find(call => call.path.endsWith('/21/decide')).options.body, { decision: 'approve' });
  let rejectMessage = '';
  await data.sections[1].rows[0].run({ choose: async () => 'reject', confirm: async (_title, message) => { rejectMessage = message; return true; }, notify() {}, refresh: async () => {} });
  assert.match(rejectMessage, /仍受原策略约束/);
  assert.deepEqual(calls.filter(call => call.path.endsWith('/21/decide')).at(-1).options.body, { decision: 'reject' });
});

test('admin error logs mirror web columns, filters and bounded pagination', async () => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { logs: [], total: 51, page: options.query.page, limit: options.query.limit, retention_days: 14 }; };
  const runtime = { client: { isAdmin: true }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  runtime.errorPage = 2;
  runtime.errorFilters = { user_q: 'alice', model_q: 'm1', provider_q: 'P', status_code: '500', error_type: 'timeout', start_date: '2026-11-01', end_date: '2026-11-07', final_only: '1' };
  const page = buildPages(runtime).find(item => item.id === 'admin-error-logs');
  const data = await page.load(api);
  assert.deepEqual(calls[0].options.query, { page: 2, limit: 50, ...runtime.errorFilters });
  assert.deepEqual(data.sections[0].columns.map(column => column.label), ['时间', '用户', '模型', '供应商', '状态码', '错误类型', '错误信息', '延迟', '详情']);
  assert.match(data.sections[0].description, /第 2\/2 页.*每页 50 条.*仅最终错误/);
  assert.ok(data.actions.some(action => action.label === '设置日期范围'));
  assert.ok(data.actions.some(action => action.label === '筛选供应商'));
  assert.equal(data.actions.find(action => action.label === '上一页').disabled, false);
  assert.equal(data.actions.find(action => action.label === '下一页').disabled, true);
  const finalAction = data.actions.find(action => action.label === '筛选错误范围');
  await finalAction.run({ choose: async (_title, options) => { assert.deepEqual(options.map(option => option.value), ['1', '0', '']); return '0'; }, refresh: async () => {} });
  assert.equal(runtime.errorFilters.final_only, '0');
  assert.equal(runtime.errorPage, 1);
  let dateNotice = '';
  const callsBeforeInvalidDate = calls.length;
  await data.actions.find(action => action.label === '设置日期范围').run({ form: async () => ({ start_date: '2026-11-05', end_date: '' }), show: async (_title, message) => { dateNotice = message; } });
  assert.match(dateNotice, /同时提供真实有效/);
  assert.equal(calls.length, callsBeforeInvalidDate, 'invalid date filters must not trigger a request');
  assert.equal(runtime.errorFilters.final_only, '0', 'invalid date filters must preserve the previous error-scope selection');
  assert.equal(runtime.errorPage, 1);
});

test('admin error details use readable basic fields and separate original response', async () => {
  const page = pageById('admin-error-logs');
  const api = async () => ({ logs: [{ created_at: '2026-11-25T08:00:00Z', user_id: 7, username: 'alice', model_id: 'm1', upstream_model_id: 'up-model', series: 'Test Series', provider_name: 'Provider', status_code: 500, error_type: 'upstream_timeout', error_message: 'Upstream timed out', error_body: '{"type":"timeout"}', latency_ms: 123, ip_address: '127.0.0.1', key_prefix: 'cr_live_x', key_name: 'Main', is_final: false }], total: 1, page: 1, retention_days: 30 });
  const data = await page.load(api);
  const row = data.sections[0].rows[0];
  assert.equal(data.sections[0].columns.map(column => column.label).join(','), '时间,用户,模型,供应商,状态码,错误类型,错误信息,延迟,详情');
  assert.equal(row.cells.type, 'upstream_timeout');
  assert.equal(row.cells.latency, '123 ms');
  assert.match(row.cells.model, /重试中/);
  let body = '';
  await row.run({ choose: async () => 'overview', show: async (_title, content) => { body = content; } });
  assert.match(body, /请求类型：未知/);
  assert.match(body, /请求状态码：500/);
  assert.match(body, /模型：m1/);
  assert.match(body, /中间失败（系统仍在尝试备用模型）/);
  assert.match(body, /响应时间：123 毫秒/);
  assert.match(body, /cr_live_x••••/);
  assert.doesNotMatch(body, /status_code|api_key_id|error_body/);
  await row.run({ choose: async () => 'response', show: async (_title, content) => { body = content; } });
  assert.match(body, /"type": "timeout"/);
  const finalData = await page.load(async () => ({ logs: [{ error_type: 'auth', is_final: true }], total: 1, page: 1 }));
  await finalData.sections[0].rows[0].run({ choose: async () => 'overview', show: async (_title, content) => { body = content; } });
  assert.match(body, /请求结果：最终失败（已返回客户端）/);
  const unknownData = await page.load(async () => ({ logs: [{ error_type: 'auth' }], total: 1, page: 1 }));
  await unknownData.sections[0].rows[0].run({ choose: async () => 'overview', show: async (_title, content) => { body = content; } });
  assert.match(body, /请求结果：未知/);
});

test('admin popup notices mirror web fields and confirmed lifecycle operations', async () => {
  const calls = [];
  const notice = { id: 2, title: 'Maintenance', body: 'Service notice', closeText: 'OK', enabled: true, seenCount: 5, createdAt: '2026-11-01', updatedAt: '2026-11-02' };
  const api = async (path, options = {}) => { calls.push({ path, options }); if (path === '/api/admin/popup-notices') return { items: [notice] }; if (path.endsWith('/reset')) return { success: true, cleared: 5 }; return { success: true }; };
  const page = pageById('admin-popups');
  const data = await page.load(api);
  assert.equal(calls[0].path, '/api/admin/popup-notices');
  assert.deepEqual(data.sections[0].columns.map(column => column.label), ['标题', '状态', '已读人数', '关闭按钮', '更新时间', '操作']);
  assert.deepEqual(data.sections[0].rows[0].cells, { title: 'Maintenance', status: '已启用', seen: '5 人已读', close: 'OK', updated: data.sections[0].rows[0].cells.updated, actions: 'Enter 管理' });
  assert.ok(data.actions.some(action => action.label === '新建弹窗通知'));
  const row = data.sections[0].rows[0];
  const choices = [];
  await row.run({ choose: async (_title, options) => { choices.push(...options); return 'preview'; }, show: async (_title, body) => { assert.match(body, /Service notice/); assert.match(body, /5 人已读/); } });
  assert.deepEqual(choices.map(option => option.value), ['preview', 'edit', 'toggle', 'reset', 'delete']);

  let fields;
  await row.run({ choose: async () => 'edit', form: async (_title, values) => { fields = values; return { title: 'Updated', body: 'New body', closeText: 'Done', enabled: true }; }, confirm: async () => false });
  assert.deepEqual(fields.map(field => field.name), ['title', 'body', 'closeText', 'enabled']);
  assert.equal(calls.some(call => call.options.method === 'PUT' && call.path === '/api/admin/popup-notices/2'), false);
  await row.run({ choose: async () => 'edit', form: async () => ({ title: 'Updated', body: 'New body', closeText: 'Done', enabled: false }), confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.find(call => call.options.method === 'PUT' && call.path === '/api/admin/popup-notices/2').options.body, { title: 'Updated', body: 'New body', closeText: 'Done', enabled: false });

  let resetConfirmed = false;
  await row.run({ choose: async () => 'reset', confirm: async (_title, message) => { resetConfirmed = true; assert.match(message, /5 条已读记录/); return false; } });
  assert.equal(resetConfirmed, true);
  assert.equal(calls.some(call => call.path.endsWith('/reset')), false);
  let deleteConfirmed = false;
  await row.run({ choose: async () => 'delete', confirm: async (_title, message) => { deleteConfirmed = true; assert.match(message, /不可撤销/); return false; } });
  assert.equal(deleteConfirmed, true);
  assert.equal(calls.some(call => call.options.method === 'DELETE'), false);
});

test('admin audit log renders readable event metadata and bounds its web-compatible filters/pages', async () => {
  const calls = [];
  const runtime = { client: { isAdmin: true }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path !== '/api/admin/audit-logs') return {};
    return { page: options.query.page, limit: 50, total: 51, items: [{ id: 9, created_at: '2026-11-25T08:00:00Z', username: 'alice', is_admin: true, action: 'user.update', resource_type: 'user', resource_id: '7', description: '更新账户设置', details: { email_verified: true, rate_limit_rpm: 30 }, ip_address: '127.0.0.1', user_agent: 'TestClient/1', status: 200, duration_ms: 8 }] };
  };
  const page = buildPages(runtime).find(item => item.id === 'admin-audit-logs');
  runtime.adminAuditPage = 2;
  const data = await page.load(api);
  assert.match(data.sections[0].description, /第 2\/2 页 · 共 51 条 · 每页 50 条/);
  const row = data.sections[0].rows[0];
  assert.ok(row.label.includes('更新用户'));
  assert.ok(row.label.includes('管理员'));
  assert.match(row.detail, /用户 #7/);
  assert.match(row.detail, /HTTP 200/);
  assert.match(row.detail, /8 毫秒/);
  let details = '';
  await row.run({ show: async (_title, body) => { details = body; } });
  assert.match(details, /操作人：alice（管理员）/);
  assert.match(details, /目标：用户 #7/);
  assert.match(details, /客户端：TestClient\/1/);
  assert.match(details, /邮箱已验证=true · RPM 限额=30/);
  assert.doesNotMatch(details, /email_verified|rate_limit_rpm/);
  const filter = data.actions.find(action => action.label === '筛选资源类型');
  await filter.run({ choose: async (_title, options) => { assert.ok(options.some(option => option.label === '弹窗通知')); return 'user'; }, refresh: async () => page.load(api) });
  assert.equal(runtime.adminAuditResourceType, 'user');
  assert.equal(runtime.adminAuditPage, 1);
  assert.equal(calls.at(-1).options.query.resource_type, 'user');
  const nextPage = data.actions.find(action => action.label === '下一页');
  assert.equal(nextPage.disabled, true, 'the last page must disable pagination forward');
});

test('admin invite page renders readable rows, confirms revoke and creates a one-time link with web payload', async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/auth-invites' && options.method === 'POST') return { id: 5, token: 'one-time-token', url: 'https://router.example/?invite=one-time-token', max_uses: 3, expires_at: '2026-12-02T00:00:00Z', team_name: 'Team Two' };
    if (path === '/api/auth-invites') return [{ id: 4, status: 'active', max_uses: 5, used_count: 2, expires_at: '2026-12-01T00:00:00Z', team_id: 2, team_name: 'Team Two', created_by_name: 'admin', created_at: '2026-11-20T00:00:00Z', used_by_name: 'alice', used_at: '2026-11-21T00:00:00Z' }, { id: 3, status: 'revoked', max_uses: 1, used_count: 0, created_by_name: 'admin', created_at: '2026-11-19T00:00:00Z' }];
    if (path === '/api/admin/teams') return [{ id: 2, name: 'Team Two' }];
    return {};
  };
  const page = pageById('admin-invites');
  const data = await page.load(api);
  assert.deepEqual(data.sections[0].columns.map(column => column.label), ['编号', '状态', '使用人数', '有效期', 'Team', '创建人', '创建时间', '最近使用', '操作']);
  assert.deepEqual(data.sections[0].rows[0].cells, { id: '#4', status: '有效', usage: '2 / 5', expires: data.sections[0].rows[0].cells.expires, team: 'Team Two', creator: 'admin', created: data.sections[0].rows[0].cells.created, last_used: 'alice · 2026/11/21 08:00:00', actions: 'Enter 管理' });
  assert.equal(data.sections[0].rows[1].cells.status, '已撤销');
  assert.match(data.sections[0].rows[0].detail, /Team：Team Two.*使用 2\/5 次/);
  let inviteDetails = '';
  await data.sections[0].rows[0].run({ choose: async () => 'detail', show: async (_title, body) => { inviteDetails = body; } });
  assert.match(inviteDetails, /原始 token 只在创建响应中出现/);
  let revokeWarning = '';
  await data.sections[0].rows[0].run({ choose: async () => 'revoke', confirm: async (_title, message) => { revokeWarning = message; return false; } });
  assert.match(revokeWarning, /不可撤销/);
  assert.equal(calls.some(call => call.path.endsWith('/4/revoke')), false);
  const create = data.actions.find(action => action.label === '生成邀请链接');
  const values = { maxUses: '3', days: '14', teamId: '2' };
  await create.run({ form: async () => values, confirm: async () => false });
  assert.equal(calls.some(call => call.options.method === 'POST' && call.path === '/api/auth-invites'), false);
  let createdDetails = '';
  await create.run({ form: async () => values, confirm: async () => true, show: async (_title, content) => { createdDetails = content; }, notify() {}, refresh: async () => {} });
  const write = calls.find(call => call.path === '/api/auth-invites' && call.options.method === 'POST');
  assert.deepEqual(write.options.body, { maxUses: 3, days: 14, teamId: '2' });
  assert.match(createdDetails, /https:\/\/router.example/);
  assert.match(createdDetails, /one-time-token/);
});

test('admin updates page renders readable version cards and limits actions to safe checks', async () => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith('/runtime')) return { currentVersion: '1.0', canApply: false, isDocker: true, fromSource: false, isDistLayout: false, reason: 'Docker 请重建镜像更新。', appRoot: '/srv/crewrouter', status: { state: 'idle' } };
    if (path.endsWith('/status')) return { phase: 'error', message: '版本检查失败', error: '上游暂时不可用', progress: 0, lastCheckedAt: '2026-11-26T10:00:00Z' };
    if (path.endsWith('/check')) return { currentVersion: '1.0', latestVersion: '1.1', hasUpdate: true, canApply: false, reason: 'Docker 请重建镜像更新。', lastCheckedAt: '2026-11-26T10:01:00Z' };
    return {};
  };
  const page = pageById('admin-updates');
  const data = await page.load(api);
  assert.deepEqual(calls.map(call => call.path), ['/api/admin/update/runtime', '/api/admin/update/status']);
  assert.deepEqual(data.sections[0].cards.map(card => card.label), ['当前版本', '最新版本', '更新状态', '上次检查']);
  assert.deepEqual(data.sections[0].cards.map(card => card.value.slice(0, 2)), ['v1', '未检', '检查', '20']);
  assert.match(data.sections[0].cards[2].value, /检查或更新失败/);
  assert.match(data.sections[1].rows[0].label, /运行方式：Docker/);
  assert.match(data.sections[1].rows[1].detail, /Docker 请重建镜像更新/);
  assert.ok(data.sections[2].rows.some(row => row.label === '更新进度：0%'));
  assert.doesNotMatch(JSON.stringify(data.sections), /\\"currentVersion\\"|\\"lastCheckedAt\\"/);
  const action = data.actions.find(item => item.label === '检查官方更新');
  await action.run({ confirm: async () => false, show: async () => {}, refresh: async () => {} });
  assert.equal(calls.some(call => call.path.endsWith('/check')), false);
  let checkDetails = '';
  await action.run({ confirm: async () => true, show: async (_title, body) => { checkDetails = body; }, refresh: async () => {} });
  assert.ok(calls.some(call => call.path.endsWith('/check')));
  assert.match(checkDetails, /发现新版本/);
  assert.match(checkDetails, /自动更新：不支持/);
  assert.equal(calls.some(call => call.path.endsWith('/apply')), false);
});

test('Team page mirrors web overview, search, create and selected-Team detail flow', async () => {
  const calls = [];
  const runtime = { client: { isAdmin: true }, cfg: { tui: { days: 30 } }, profileName: 'test' };
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/admin/teams') return [
      { id: 4, name: 'Team Four', description: 'Research', member_count: 1, created_at: '2026-11-20T00:00:00Z', is_default: true },
      { id: 5, name: 'Team Five', description: 'Support', member_count: 2, is_frontier: true },
    ];
    if (path.endsWith('/members')) return [{ id: 9, username: 'alice', email: 'a@example.test' }];
    if (path.endsWith('/rules')) return [{ id: 'r1', rule_type: 'requests', rule_value: 100, duration_hours: 24 }];
    if (path.endsWith('/models')) return [{ model_id: 'm1', name: 'Model One', provider_name: 'Provider', enabled: true }];
    return {};
  };
  const page = buildPages(runtime).find(item => item.id === 'admin-teams');
  const list = await page.load(api);
  assert.deepEqual(list.sections.map(section => section.title), ['Team 管理']);
  assert.deepEqual(list.sections[0].cards.map(card => card.label), ['团队总数', '默认团队', '前沿团队', '总成员数']);
  assert.match(list.sections[0].rows[0].detail, /默认.*1 位成员.*Research.*创建于/);
  await list.actions.find(action => action.label === '搜索 Team').run({ ask: async () => 'support', refresh: async () => {} });
  assert.deepEqual(runtime.adminTeamSearch, 'support');
  const filtered = await page.load(api);
  assert.equal(filtered.sections[0].rows.length, 1);
  assert.equal(filtered.sections[0].rows[0].label, 'Team Five');
  const create = filtered.actions.find(action => action.label === '创建团队');
  await create.run({ form: async () => ({ name: 'New Team', description: 'Platform' }), confirm: async () => true, notify() {}, refresh: async () => {} });
  assert.deepEqual(calls.find(call => call.options.method === 'POST').options.body, { name: 'New Team', description: 'Platform' });
  await filtered.sections[0].rows[0].run({ refresh: async () => {} });
  runtime.adminSelectedTeamId = 4;
  const detail = await page.load(api);
  const section = detail.sections[0];
  assert.equal(section.title, 'Team Four · 团队编号 4');
  assert.deepEqual(section.cards.map(card => card.label), ['成员', '模型授权', '限额规则']);
  const labels = section.rows.map(row => row.label);
  assert.ok(labels.findIndex(label => label.startsWith('成员管理')) < labels.findIndex(label => label.startsWith('模型授权')));
  assert.ok(labels.findIndex(label => label.startsWith('模型授权')) < labels.findIndex(label => label.startsWith('限额规则')));
  const searchMembers = section.actions.find(action => action.label === '搜索 Team 成员');
  await searchMembers.run({ ask: async () => 'alice', refresh: async () => {} });
  assert.equal(runtime.team_4_memberSearch, 'alice');
  const filteredDetail = await page.load(api);
  assert.ok(filteredDetail.sections[0].rows.some(row => row.label === '成员管理 · 显示 1/1 人'));
  await filteredDetail.sections[0].actions.find(action => action.label === '返回 Team 列表').run({ refresh: async () => {} });
  assert.equal(runtime.adminSelectedTeamId, null);
});

test('project recent workspace opens a safely quoted terminal copy command', async () => {
  const page = pageById('projects');
  const data = await page.load(async () => ({ summary: { projects: 1 }, projects: [{ workspace_path: "/work/O'Brien", requests: 2, tokens: 30, cost: 0.5 }], daily: [] }));
  const recent = data.sections.find(section => section.title === '最近活跃项目');
  let detail = '';
  await recent.rows[0].run({ show: async (_title, body) => { detail = body; } });
  assert.match(detail, /项目：\/work\/O'Brien/);
  assert.match(detail, /cd -- '\/work\/O'\\''Brien'/);
  assert.match(detail, /CLI 不会调用系统剪贴板/);
});
