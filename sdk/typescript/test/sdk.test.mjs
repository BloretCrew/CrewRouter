import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';

import {
  CrewRouter,
  CrewRouterAuthenticationError,
  CrewRouterPermissionError,
  CrewRouterRateLimitError,
} from '../dist/esm/index.js';

let server;
let baseUrl;
let requests = [];
let handler = null;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function reset(next) {
  requests = [];
  handler = next;
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body);
}

test('gateway chat send bearer auth, JSON body and reads response metadata', async () => {
  reset((req, res) => json(res, 200, { id: 'chatcmpl-1', choices: [] }, {
    'x-crewrouter-request-id': 'req-123',
    'x-crewrouter-signature': 'signed',
  }));
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  const response = await client.gateway.chat.completions.create({
    model: 'claude-fable-5',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { id: 'chatcmpl-1', choices: [] });
  assert.equal(response.requestId, 'req-123');
  assert.equal(response.signature, 'signed');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].headers.authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(requests[0].body), {
    model: 'claude-fable-5',
    messages: [{ role: 'user', content: 'hi' }],
  });
});

test('x-api-key auth style is supported', async () => {
  reset((req, res) => json(res, 200, { object: 'list', data: [] }));
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test', authStyle: 'x-api-key' });
  await client.gateway.models.list();
  assert.equal(requests[0].headers['x-api-key'], 'sk-test');
  assert.equal(requests[0].headers.authorization, undefined);
});

test('call() substitutes path params and serializes query arrays', async () => {
  reset((req, res) => json(res, 200, { data: [] }));
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  await client.call('user.apiKeys.byId.models.list', {
    pathParams: { id: 42 },
    query: { days: 7, tag: ['a', 'b'], skip: undefined },
  });
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].url, '/api/user/api-keys/42/models?days=7&tag=a&tag=b');
});

test('management wrappers preserve their documented response payload shapes', async () => {
  reset((req, res) => {
    if (req.url === '/api/user/api-keys') {
      json(res, 200, [{ id: 7, name: 'CI', key_value: null, permissions: ['keys.read'], tags: [], model_queue: [] }]);
      return;
    }
    if (req.url === '/api/user/usage') {
      json(res, 200, [{ date: '2026-01-01', total_tokens: '12', total_cost: '0.25', total_requests: '2' }]);
      return;
    }
    if (req.url === '/api/user/balance') {
      json(res, 200, { balance: 10, refund_balance: 8, rate_limit_rpm: 60, rate_limit_tpm: 1000, group: null });
      return;
    }
    if (req.url === '/api/user/models') {
      json(res, 200, [{ id: 'model-1', upstream_model_id: 'upstream-1', name: 'Model One', alias: null, provider: 'p1', provider_name: 'Provider', input_price_per_1k_tokens: '0.01', output_price_per_1k_tokens: 0.02, output_kind: 'chat' }]);
      return;
    }
    if (req.url === '/api/user/models/m1/info') {
      json(res, 200, { model_id: 'm1', name: 'Model', alias: null, series: null, description: null, input_price_per_1k_tokens: '0.01', output_price_per_1k_tokens: 0.02, cached_output_price_per_1k_tokens: null, reference_input_price_per_1k_tokens: null, reference_output_price_per_1k_tokens: null, rate_limit_rpm: null, rate_limit_tpm: null, icon_url: null, series_icon_url: null, created_by: null, enabled: true, billing_mode: 'ratio', model_multiplier: '1.0', completion_multiplier: '1.0', thinking_model_id: null, non_thinking_model_id: null, upstream_model_id: 'upstream-m1', provider_id: 'p1', provider_name: 'Provider', test_ok: null, test_latency_ms: null, test_tokens_per_second: null, test_total_tokens: '0', test_error: null, test_tested_at: null });
      return;
    }
    if (req.url === '/api/user/providers') {
      json(res, 200, [{ id: 'shared-provider', name: 'Shared', format: 'openai', created_by: null }]);
      return;
    }
    if (req.url === '/api/user/providers/quota') {
      json(res, 200, { providers: [{ id: 'p1', name: 'Provider', quota: { remaining: '3' }, keys: [], aggregated: null, cached: true, checked_at: null, last_attempt_at: null, last_valid_at: null, status: 'success', coverage: null, stale: false }] });
      return;
    }
    if (req.url === '/api/user/api-keys/7/usage') {
      json(res, 200, [{ date: '2026-01-01', model_id: 'm1', model_name: null, tokens: '12', cost: '0.1', requests: '2' }]);
      return;
    }
    if (req.url === '/api/user/api-keys/7/models' && req.method === 'GET') {
      json(res, 200, { models: [], queue: [{ model_id: 'm1', id: 'm1', name: 'Model', provider: 'p1', series: 's1', icon_url: null, sort_order: 0 }] });
      return;
    }
    if (req.url === '/api/user/api-keys/7/models' && req.method === 'PUT') {
      json(res, 200, { success: true, modelIds: ['m1'], current_model_id: 'm1' });
      return;
    }
    if (req.url === '/api/user/api-keys/7/tags' && req.method === 'PUT') {
      json(res, 200, { tags: [{ id: 2, name: 'prod', color: '#445566' }] });
      return;
    }
    if (req.url === '/api/user/products') {
      json(res, 200, [{ id: 1, name: 'Product', description: null, image_url: null, link: null, sort_order: 0 }]);
      return;
    }
    if (req.url === '/api/user/stats/filters') {
      json(res, 200, { sources: [{ id: 'claude_code', name: 'Claude Code' }], models: [{ id: 'm1', name: 'Model' }], providers: [{ id: 'p1', name: 'Provider' }], teams: [{ id: 2, name: 'Team' }] });
      return;
    }
    if (req.url === '/api/user/code-balances') {
      json(res, 200, [{ amount: '2.5', fee_rate: '0.1', code: 'redeem-1', code_amount: '3', net_amount: '2.2727' }]);
      return;
    }
    if (req.url === '/api/admin/usage-logs?page=1') {
      json(res, 200, { total: 1, page: 1, logs: [{ id: 1, user_id: 9, model_id: 'm1', api_key_id: null, tokens_used: '12', prompt_tokens: '10', completion_tokens: '2', cached_tokens: '0', provider_id: null, request_type: 'chat', request_source: 'unknown', user_agent: null, latency_ms: '25', ip_address: null, custom_instruction_count: 0, cost: '0.01', created_at: '2026-01-01T00:00:00.000Z', username: 'alice', key_prefix: null, key_name: null, series: null, model_name: 'Model', upstream_model_id: null, requested_model: null, resolved_model: null, response_model: null, provider_name: null }] });
      return;
    }
    if (req.url === '/api/admin/stats/multi/filters') {
      json(res, 200, { users: [{ id: 9, name: 'alice' }], teams: [{ id: 2, name: 'Team' }], models: [{ id: 'm1', name: 'Model' }], providers: [{ id: 'p1', name: 'Provider' }], sources: [{ id: 'claude_code', name: 'Claude Code' }], projects: [{ id: '/workspace', name: '/workspace' }] });
      return;
    }
    if (req.url === '/api/admin/products') {
      json(res, 200, [{ id: 1, name: 'Product', description: null, price: '2.5', image_url: null, link: null, is_active: true, sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }]);
      return;
    }
    if (req.url === '/api/admin/teams/2/members') {
      json(res, 200, [{ id: 9, username: 'alice', email: null, avatar: null, created_at: '2026-01-01T00:00:00.000Z' }]);
      return;
    }
    if (req.url === '/api/admin/teams/2/models') {
      json(res, 200, [{ mapping_id: null, enabled: false, model_id: 'm1', name: 'Model', provider: 'p1', series: null, description: null, input_price_per_1k_tokens: '0.01', output_price_per_1k_tokens: 0.02, icon_url: null, upstream_model_id: null, alias: null, model_multiplier: '1.0', test_ok: null, test_latency_ms: null, test_tokens_per_second: null, test_error: null, test_tested_at: null, provider_id: 'p1', provider_name: 'Provider', provider_enabled: true }]);
      return;
    }
    if (req.url === '/api/admin/teams/2/rules') {
      json(res, 200, [{ id: 'team-rule-1', rule_type: 'requests', rule_value: 100, duration_hours: 24, description: 'daily cap' }]);
      return;
    }
    if (req.url === '/api/admin/provider-tags' && req.method === 'GET') {
      json(res, 200, [{ id: 4, name: 'global', color: '#123456', sort_order: 0, created_at: '2026-01-01T00:00:00.000Z' }]);
      return;
    }
    if (req.url === '/api/admin/provider-tags' && req.method === 'POST') {
      json(res, 200, { id: 4, name: 'global', color: '#123456', sort_order: 0 });
      return;
    }
    if (req.url === '/api/admin/provider-tags/4' && req.method === 'PUT') {
      json(res, 200, { id: 4, name: 'global', color: '#123456', sort_order: 0 });
      return;
    }
    if (req.url === '/api/admin/provider-tags/4' && req.method === 'DELETE') {
      json(res, 200, { success: true });
      return;
    }
    if (req.url === '/api/admin/provider-tags/reorder' && req.method === 'PUT') {
      json(res, 200, { success: true });
      return;
    }
    if (req.url === '/api/admin/users') {
      json(res, 200, [{ id: 9, username: 'alice', email: null, email_verified: false, avatar: null, balance: '1.5', refund_balance: '0', is_admin: false, tags: [], rate_limit_rpm: 0, rate_limit_tpm: 0, created_at: '2026-01-01T00:00:00.000Z', team_id: null, team_name: null }]);
      return;
    }
    if (req.url === '/api/admin/users?page=1') {
      json(res, 200, { items: [{ id: 9, username: 'alice', email: null, email_verified: false, avatar: null, balance: '1.5', refund_balance: '0', is_admin: false, tags: [], rate_limit_rpm: 0, rate_limit_tpm: 0, created_at: '2026-01-01T00:00:00.000Z', team_id: null, team_name: null }], total: 1, page: 1, limit: 50, stats: { adminCount: 0, verifiedCount: 0, totalBalance: 1.5 } });
      return;
    }
    if (req.url === '/api/user/provider-tags') {
      json(res, 200, [{ id: 2, name: 'gateway', color: '#445566', sort_order: 1 }]);
      return;
    }
    if (req.url.startsWith('/api/user/models/uptime') || req.url.startsWith('/api/admin/models/uptime')) {
      json(res, 200, { days: 1, hours: 24, slots: 96, granularity: '15m', items: { m1: { uptime_pct: null, label: 'No data', total_success: 0, total_fail: 0, spark: ['none'] } } });
      return;
    }
    if (req.url.startsWith('/api/user/models/m1/uptime')) {
      json(res, 200, { model_id: 'm1', uptime_pct: null, label: 'No data', total_success: 0, total_fail: 0, granularity: '15m', hours: 24, slots: 96, days: [{ date: '2026-01-01T00:00:00.000Z', status: 'none', success: 0, fail: 0 }] });
      return;
    }
    if (req.url === '/api/user/key-tags') {
      json(res, 200, [{ id: 3, name: 'prod', color: '#00aa00', sort_order: 1, created_at: '2026-01-01T00:00:00.000Z' }]);
      return;
    }
    if (req.url === '/api/user/api-keys/7/members') {
      json(res, 200, { is_owner: true, members: [{ id: 9, username: 'member', email: 'member@example.test', created_at: '2026-01-01T00:00:00.000Z' }] });
      return;
    }
    if (req.url === '/api/user/api-keys/7/config') {
      json(res, 200, { env: { ANTHROPIC_BASE_URL: 'http://localhost', ANTHROPIC_AUTH_TOKEN: 'sk-fixture-secret', ANTHROPIC_MODEL: 'claude-fable-5', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-fable-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-fable-5', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-fable-5' }, model: 'claude-fable-5', effortLevel: 'high' });
      return;
    }
    if (req.url === '/api/user/api-keys/7/fusion-config' && req.method === 'GET') {
      json(res, 200, { panel_models: ['m1'], judge_model_id: '', outer_model_id: '', fusion_enabled: true, fusion_synthesis_prompt_enabled: true });
      return;
    }
    if (req.url === '/api/user/api-keys/7/fusion-config' && req.method === 'PUT') {
      json(res, 200, { success: true });
      return;
    }
    if (req.url === '/api/user/api-keys/7/harness-models') {
      json(res, 200, { harness_models: [{ harness: 'codex', model_id: 'm1', name: 'Model', provider_name: 'Provider', label: 'Codex' }], available_harnesses: [{ id: 'codex', label: 'Codex' }] });
      return;
    }
    if (req.url === '/api/user/api-keys/7/request-model-bindings') {
      json(res, 200, { bindings: [{ request_model_name: 'fast', harness: null, model_id: 'm1', name: 'Model', provider_name: 'Provider' }], models: [{ id: 'm1', name: 'Model', alias: null, upstream_model_id: 'upstream-m1' }], available_harnesses: [{ id: 'codex', label: 'Codex' }] });
      return;
    }
    if (req.url === '/api/user/api-keys/7/quota-warning') {
      json(res, 200, { quota_warning_enabled: true });
      return;
    }
    if (req.url === '/api/user/api-keys/7/schedule') {
      json(res, 200, { schedule_enabled: false, schedule_on_time: null, schedule_off_time: null, schedule_days: [0, 1, 2, 3, 4, 5, 6], schedule_timezone: 'Asia/Shanghai' });
      return;
    }
    if (req.url === '/api/user/api-keys/7/enabled') {
      json(res, 200, { success: true, enabled: true });
      return;
    }
    if (req.url === '/api/user/api-keys/7/swallow-images') {
      json(res, 200, { success: true, swallow_images: false });
      return;
    }
    if (req.url === '/api/user/api-keys/7/crewrouter-commands') {
      json(res, 200, { success: true, crewrouter_commands: true });
      return;
    }
    if (req.url === '/api/user/current-model') {
      json(res, 200, { currentModel: null });
      return;
    }
    if (req.url === '/api/user/usage-logs/1') {
      json(res, 200, { log: { id: 1, user_id: 7, model_id: null, api_key_id: 3, tokens_used: '12', prompt_tokens: '10', completion_tokens: '2', cached_tokens: '0', provider_id: null, request_type: 'chat', request_source: 'unknown', user_agent: null, latency_ms: '25', is_stream: false, ttft_ms: null, upstream_first_byte_ms: null, generation_ms: null, tpot_ms: null, output_tps: null, e2e_ms: null, upstream_processing_ms: null, service_tier: null, rate_limit: null, ip_address: null, messages: [{ role: 'user', content: 'hi' }], response: { choices: [] }, cost: '0.01', created_at: '2026-01-01T00:00:00.000Z', key_prefix: 'sk-test', key_name: 'CI', series: null, model_name: 'Model', upstream_model_id: null, requested_model: null, resolved_model: null, response_model: null, provider_name: null } });
      return;
    }
    if (req.url.startsWith('/api/user/usage-logs')) {
      json(res, 200, { total: 1, page: 1, logs: [{ id: 1, user_id: 7, model_id: null, api_key_id: 3, tokens_used: '12', prompt_tokens: '10', completion_tokens: '2', cached_tokens: '0', provider_id: null, request_type: 'chat', request_source: 'unknown', user_agent: null, latency_ms: '25', ip_address: null, cost: '0.01', created_at: '2026-01-01T00:00:00.000Z', key_prefix: 'sk-test', key_name: 'CI', series: null, model_name: 'Model', upstream_model_id: null, requested_model: null, resolved_model: null, response_model: null, provider_name: null }] });
      return;
    }
    json(res, 404, { error: 'not found' });
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  const keys = await client.keys.list();
  const keyConfig = await client.keys.getConfig(7);
  const fusionConfig = await client.keys.getFusionConfig(7);
  const fusionSaved = await client.keys.setFusionConfig(7, { panel_models: ['m1'] });
  const harnessModels = await client.keys.getHarnessModels(7);
  const requestModelBindings = await client.keys.getRequestModelBindings(7);
  const usage = await client.usage.get();
  const balance = await client.balance.get();
  const models = await client.models.list();
  const modelInfo = await client.models.getInfo('m1');
  const providers = await client.providers.list();
  const providerQuota = await client.providers.getQuota();
  const keyUsage = await client.keys.getUsage(7);
  const keyModels = await client.keys.getModels(7);
  const setKeyModels = await client.keys.setModels(7, { modelIds: ['m1'] });
  const updatedKeyTags = await client.keys.setTags(7, { tagIds: [2] });
  const keyTags = await client.keyTags.list();
  const members = await client.keys.getMembers(7);
  const quotaWarning = await client.keys.getQuotaWarning(7);
  const schedule = await client.keys.getSchedule(7);
  const enabled = await client.keys.setEnabled(7, true);
  const swallowImages = await client.keys.setSwallowImages(7, false);
  const commands = await client.keys.setCrewRouterCommands(7, true);
  const currentModel = await client.currentModel.get();
  const usageLogs = await client.usage.logs({ page: 1 });
  const statsFilters = await client.stats.filters();
  const usageLogDetail = await client.usage.getLog(1);
  const products = await client.products.list();
  const codeBalances = await client.codeBalances.list();
  const providerTags = await client.providerTags.list();
  const uptime = await client.modelUptime.get();
  const uptimeDetail = await client.modelUptime.getDetail('m1');
  const adminUsageLogs = await client.admin.usageLogs.list({ page: 1 });
  const adminStatsFilters = await client.admin.stats.filters();
  const adminUptime = await client.admin.models.getUptime({ days: 7 });
  const adminProducts = await client.admin.products.list();
  const teamMembers = await client.admin.teams.getMembers(2);
  const teamModels = await client.admin.teams.getModels(2);
  const teamRules = await client.admin.teams.getRules(2);
  const adminProviderTags = await client.admin.providerTags.list();
  const createdAdminTag = await client.admin.providerTags.create({ name: 'global' });
  const updatedAdminTag = await client.admin.providerTags.update(4, { name: 'global' });
  const deletedAdminTag = await client.admin.providerTags.delete(4);
  const reorderedAdminTags = await client.admin.providerTags.reorder({ orderedIds: [4] });
  const adminUsersLegacy = await client.admin.users.list();
  const adminUsersPage = await client.admin.users.list({ query: { page: 1 } });

  assert.equal(keys.data[0].key_value, null);
  assert.deepEqual(keys.data[0].permissions, ['keys.read']);
  assert.equal(keyConfig.data.env.ANTHROPIC_AUTH_TOKEN, 'sk-fixture-secret');
  assert.deepEqual(fusionConfig.data.panel_models, ['m1']);
  assert.equal(fusionSaved.data.success, true);
  assert.equal(harnessModels.data.harness_models[0].harness, 'codex');
  assert.equal(requestModelBindings.data.bindings[0].harness, null);
  assert.equal(requestModelBindings.data.models[0].upstream_model_id, 'upstream-m1');
  assert.equal(usage.data[0].total_tokens, '12');
  assert.equal(balance.data.refund_balance, 8);
  assert.equal(balance.data.group, null);
  assert.equal(models.data[0].alias, null);
  assert.equal(models.data[0].input_price_per_1k_tokens, '0.01');
  assert.equal(modelInfo.data.cached_output_price_per_1k_tokens, null);
  assert.equal(providers.data[0].created_by, null);
  assert.equal(providerQuota.data.providers[0].quota.remaining, '3');
  assert.equal(providerQuota.data.providers[0].stale, false);
  assert.equal(keyUsage.data[0].model_id, 'm1');
  assert.equal(keyUsage.data[0].model_name, null);
  assert.equal(keyModels.data.queue[0].sort_order, 0);
  assert.equal(keyModels.data.models.length, 0);
  assert.equal(setKeyModels.data.current_model_id, 'm1');
  assert.equal(updatedKeyTags.data.tags[0].id, 2);
  assert.equal(keyTags.data[0].sort_order, 1);
  assert.equal(members.data.is_owner, true);
  assert.equal(members.data.members[0].username, 'member');
  assert.equal(quotaWarning.data.quota_warning_enabled, true);
  assert.equal(schedule.data.schedule_on_time, null);
  assert.equal(enabled.data.enabled, true);
  assert.equal(swallowImages.data.swallow_images, false);
  assert.equal(commands.data.crewrouter_commands, true);
  assert.deepEqual(schedule.data.schedule_days, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(currentModel.data.currentModel, null);
  assert.equal(usageLogs.data.total, 1);
  assert.equal(usageLogs.data.logs[0].tokens_used, '12');
  assert.equal(usageLogDetail.data.log.id, 1);
  assert.equal(usageLogDetail.data.log.messages[0].content, 'hi');
  assert.equal(statsFilters.data.teams[0].id, 2);
  assert.equal(products.data[0].description, null);
  assert.equal(codeBalances.data[0].net_amount, '2.2727');
  assert.equal(providerTags.data[0].sort_order, 1);
  assert.equal(uptime.data.granularity, '15m');
  assert.equal(uptime.data.items.m1.uptime_pct, null);
  assert.equal(uptimeDetail.data.granularity, '15m');
  assert.equal(uptimeDetail.data.days[0].status, 'none');
  assert.equal(adminUsageLogs.data.logs[0].custom_instruction_count, 0);
  assert.equal(adminUsageLogs.data.logs[0].username, 'alice');
  assert.equal(adminStatsFilters.data.projects[0].id, '/workspace');
  assert.equal(adminUptime.data.granularity, '15m');
  assert.equal(adminProducts.data[0].price, '2.5');
  assert.equal(teamMembers.data[0].email, null);
  assert.equal(teamModels.data[0].model_id, 'm1');
  assert.equal(teamModels.data[0].mapping_id, null);
  assert.equal(teamRules.data[0].rule_type, 'requests');
  assert.equal(adminProviderTags.data[0].created_at, '2026-01-01T00:00:00.000Z');
  assert.equal(createdAdminTag.data.id, 4);
  assert.equal(updatedAdminTag.data.sort_order, 0);
  assert.equal(deletedAdminTag.data.success, true);
  assert.equal(reorderedAdminTags.data.success, true);
  assert.equal(adminUsersLegacy.data[0].username, 'alice');
  assert.equal(adminUsersPage.data.stats.adminCount, 0);
  assert.equal(adminUsersLegacy.data[0].username, 'alice');
  assert.equal(adminUsersPage.data.stats.adminCount, 0);
});

test('management errors expose code and permission', async () => {
  reset((req, res) => json(res, 403, {
    error: 'API Key 没有该权限: keys.read',
    code: 'permission_denied',
    permission: 'keys.read',
  }));
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  await assert.rejects(client.keys.list(), (error) => {
    assert(error instanceof CrewRouterPermissionError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'permission_denied');
    assert.equal(error.permission, 'keys.read');
    assert.equal(error.protocol, 'management');
    return true;
  });
});

test('anthropic error shape is normalized', async () => {
  reset((req, res) => json(res, 401, {
    type: 'error',
    error: { type: 'authentication_error', message: 'invalid key' },
  }));
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  await assert.rejects(client.gateway.messages.create({ messages: [] }), (error) => {
    assert(error instanceof CrewRouterAuthenticationError);
    assert.equal(error.type, 'authentication_error');
    assert.equal(error.protocol, 'anthropic');
    assert.equal(error.message, 'invalid key');
    return true;
  });
});

test('SSE parser handles split UTF-8, multi-line data and [DONE]', async () => {
  reset((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"你');
    res.write('好"}}]}\n\n');
    res.write(': keep-alive\n\n');
    res.write('event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  const events = [];
  for await (const event of client.gateway.chat.completions.stream({ messages: [] })) {
    events.push(event);
  }

  assert.equal(events.length, 3);
  assert.deepEqual(events[0].parsed, { choices: [{ delta: { content: '你好' } }] });
  assert.equal(events[0].done, false);
  assert.equal(events[1].event, 'message_delta');
  assert.deepEqual(events[1].parsed, { delta: { stop_reason: 'end_turn' } });
  assert.equal(events[2].done, true);
  assert.equal(events[2].data, '[DONE]');
});

test('stream idle timeout does not limit response header wait time', async () => {
  reset((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"ready":true}\n\n');
      setTimeout(() => res.end(), 10);
    }, 80);
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  const events = [];
  for await (const event of client.gateway.chat.completions.stream({ messages: [] }, { idleTimeoutMs: 50 })) events.push(event);
  assert.equal(events[0].data, '{"ready":true}');
});

test('breaking from an SSE iterator cancels the reader and closes the response', async () => {
  let responseClosed = false;
  reset((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"chunk":1}\n\n');
    const interval = setInterval(() => res.write('data: {"chunk":2}\\n\\n'), 20);
    res.on('close', () => {
      responseClosed = true;
      clearInterval(interval);
    });
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  for await (const _event of client.gateway.chat.completions.stream({ messages: [] })) break;

  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const poll = () => {
      if (responseClosed) return resolve();
      if (Date.now() >= deadline) return reject(new Error('SSE response was not closed after iterator break'));
      setTimeout(poll, 10);
    };
    poll();
  });
});

test('GET retries 429 when maxRetries is enabled and honors Retry-After', async () => {
  let attempts = 0;
  reset((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      json(res, 429, { error: 'slow down' }, { 'retry-after': '0' });
      return;
    }
    json(res, 200, { ok: true });
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test', maxRetries: 2 });
  const response = await client.gateway.models.list();
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test('POST does not retry by default even when maxRetries is enabled', async () => {
  let attempts = 0;
  reset((req, res) => {
    attempts += 1;
    json(res, 429, { error: 'slow down' }, { 'retry-after': '0' });
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test', maxRetries: 2 });
  await assert.rejects(client.gateway.chat.completions.create({ messages: [] }), (error) => {
    assert(error instanceof CrewRouterRateLimitError);
    return true;
  });
  assert.equal(attempts, 1);
});

test('retryNonIdempotent allows POST retries', async () => {
  let attempts = 0;
  reset((req, res) => {
    attempts += 1;
    if (attempts === 1) {
      json(res, 429, { error: 'slow down' }, { 'retry-after': '0' });
      return;
    }
    json(res, 200, { ok: true });
  });
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test', maxRetries: 1, retryNonIdempotent: true });
  const response = await client.gateway.chat.completions.create({ messages: [] });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test('session-only operations are rejected before sending a request', async () => {
  reset((req, res) => json(res, 200, { ok: true }));
  const client = new CrewRouter({ baseUrl, apiKey: 'sk-test' });
  await assert.rejects(client.call('2fa.status.list'), /session-only/);
  assert.equal(requests.length, 0);
});
