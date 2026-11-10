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
    const result = await api.listProviders(client);
    assert.equal(result.scope, 'user');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, 'p1');
  } finally { await fake.close(); }
});

test('admin listProviders uses paginated admin response', async () => {
  const fake = await createFakeServer();
  try {
    const client = new CliClient({ baseUrl: fake.baseUrl });
    await loginApiKey(client, 'sk-admin');
    const result = await api.listProviders(client);
    assert.equal(result.scope, 'admin');
    assert.equal(result.total, 1);
    assert.equal(result.stats.enabledCount, 1);
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

test('statsSummary normalizes numeric fields', () => {
  const summary = api.statsSummary({
    summary: { total_requests: '10', total_tokens: '1000', total_cost: '1.5', avg_latency: '120' },
    daily: [{ date: 'x' }], byModel: [], byApiKey: [], bySource: [],
  });
  assert.equal(summary.requests, 10);
  assert.equal(summary.tokens, 1000);
  assert.equal(summary.cost, 1.5);
  assert.equal(summary.avgLatency, 120);
});
