'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeServer } = require('./helpers/fake-server');
const { CliClient } = require('../lib/client');
const { loginPassword, loginApiKey } = require('../lib/auth');
const api = require('../lib/api');

test('non-admin listProviders falls back from admin endpoint to user providers', async () => {
  const fake = await createFakeServer();
  try {
    const client = new CliClient({ baseUrl: fake.baseUrl });
    await loginPassword(client, { login: 'admin', password: 'pass' });
    fake.sessions.forEach(session => { if (session.user) session.user = { ...session.user, isAdmin: false }; });
    client.isAdmin = false;
    fake.state.providers.push({ id: 'p2', name: 'Another', base_url: 'https://other.example' });
    const result = await api.listProviders(client, { search: 'provider' });
    assert.equal(result.scope, 'user');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, 'p1');
  } finally { await fake.close(); }
});

test('admin listProviders uses paginated response and web-compatible filters', async () => {
  const fake = await createFakeServer();
  try {
    const client = new CliClient({ baseUrl: fake.baseUrl });
    await loginApiKey(client, 'sk-admin');
    const result = await api.listProviders(client, { search: 'acme', status: 'enabled', scope: 'global', keyMode: 'fixed', tagId: 4, page: 2, limit: 25 });
    assert.equal(result.scope, 'admin');
    assert.equal(result.total, 1);
    assert.equal(result.stats.enabledCount, 1);
    const request = fake.state.requests.filter(item => item.path === '/api/admin/providers').at(-1);
    assert.deepEqual(request.query, { page: '2', limit: '25', q: 'acme', status: 'enabled', scope: 'global', key_mode: 'fixed', tag_id: '4' });
  } finally { await fake.close(); }
});

test('models and sessions normalize their API shapes', async () => {
  const fake = await createFakeServer();
  try {
    const client = new CliClient({ baseUrl: fake.baseUrl });
    await loginApiKey(client, 'sk-admin');
    const models = await api.listModels(client, { search: '' });
    assert.equal(models.scope, 'admin');
    assert.equal(models.items[0].id, 'm1');
    const sessions = await api.listSessions(client, { days: 30, page: 1, pageSize: 30 });
    assert.equal(sessions.items[0].sessionKey, 'sess-1');
    const messages = await api.getSessionMessages(client, 'sess-1');
    assert.equal(messages.records[0].response_preview, 'hello');
  } finally { await fake.close(); }
});

test('API key lifecycle helpers call the expected endpoints', async () => {
  const fake = await createFakeServer();
  try {
    const client = new CliClient({ baseUrl: fake.baseUrl });
    await loginPassword(client, { login: 'admin', password: 'pass' });
    const created = await api.createApiKey(client, { name: 'cli', expiresIn: 24 });
    assert.equal(created.key, 'sk-new-secret');
    const toggled = await api.toggleApiKey(client, 2, false);
    assert.equal(toggled.enabled, false);
    await api.deleteApiKey(client, 2);
    const keys = await api.listApiKeys(client);
    assert.ok(!keys.some(key => key.id === 2));
  } finally { await fake.close(); }
});

test('usage analytics helpers pass filters to web-compatible endpoints', async () => {
  const calls = [];
  const client = { get: async (path, options = {}) => { calls.push({ path, options }); return {}; } };
  await api.getStats(client, 30, { model_id: 'm1', provider_id: 'p1', team_id: 4, request_source: 'codex' });
  await api.getStatsFilters(client);
  await api.getLatencyStats(client, { days: 7, request_source: 'codex' });
  await api.getMessageStats(client, { days: 7, workspace_path: '/repo' });
  await api.getUsageLogs(client, { page: 2, pageSize: 10, days: 7, request_source: 'codex' });
  assert.deepEqual(calls.map(call => call.path), ['/api/user/stats', '/api/user/stats/filters', '/api/user/stats/latency', '/api/user/message-stats', '/api/user/usage-logs']);
  assert.deepEqual(calls[0].options.query, { days: 30, model_id: 'm1', provider_id: 'p1', team_id: 4, request_source: 'codex' });
  assert.deepEqual(calls.at(-1).options.query, { page: 2, pageSize: 10, days: 7, request_source: 'codex' });
});

test('statsSummary normalizes numeric fields', () => {
  const summary = api.statsSummary({
    summary: { total_requests: '10', total_tokens: '1000', total_cost: '1.5', avg_latency: '120', known_requests: '8', unknown_requests: '2', identified_rate: '80.5', active_sources: '3' },
    daily: [{ date: 'x' }], byModel: [], byApiKey: [], bySource: [],
  });
  assert.equal(summary.requests, 10);
  assert.equal(summary.tokens, 1000);
  assert.equal(summary.cost, 1.5);
  assert.equal(summary.avgLatency, 120);
  assert.equal(summary.identifiedRate, 80.5);
  assert.equal(summary.activeSources, 3);
  assert.equal(summary.knownRequests, 8);
  assert.equal(summary.unknownRequests, 2);
});
