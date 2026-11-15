'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createWebhookApi, MAX_ATTEMPTS } = require('./webhook');

function fixture({ responseStatuses = [204], validate = { ok: true }, rows = [{ id: 7, url: 'https://hooks.example.com/events', secret: 'never-store-this' }] } = {}) {
  const calls = [];
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/SELECT id, url, secret FROM plugin_webhooks/.test(sql)) return { rows };
      if (/SELECT id, webhook_id/.test(sql)) return { rows: [{ id: 1, status: 'failed' }] };
      return { rows: [] };
    },
  };
  const api = createWebhookApi({
    pluginId: 'test-webhook', pool,
    validateUrl: async url => { calls.push({ kind: 'validate', url }); return validate; },
    fetchValidated: async (_check, options) => {
      calls.push({ kind: 'fetch', options });
      const status = responseStatuses.shift();
      if (status instanceof Error) throw status;
      return { status };
    },
    allowedHosts: ['hooks.example.com'], sleep: async () => {},
  });
  return { api, calls, queries };
}

test('rejects non-https, non-allowlisted and SSRF-blocked webhook URLs', async () => {
  const { api } = fixture();
  await assert.rejects(api.register({ url: 'http://hooks.example.com/hook' }), /必须 https/);
  await assert.rejects(api.register({ url: 'https://other.example.com/hook' }), /白名单/);
  const blocked = createWebhookApi({ pluginId: 'p', pool: { query: async () => ({ rows: [] }) },
    validateUrl: async () => ({ ok: false, error: 'private address' }), fetchValidated: async () => {}, allowedHosts: ['hooks.example.com'] });
  await assert.rejects(blocked.register({ url: 'https://hooks.example.com/hook' }), /SSRF/);
});

test('retries transient failures, records success, and reports accurate counts', async () => {
  const { api, calls, queries } = fixture({ responseStatuses: [503, 204] });
  const result = await api.emit('demo.event', { ok: true });
  assert.deepEqual({ matched: result.matched, delivered: result.delivered, failed: result.failed }, { matched: 1, delivered: 1, failed: 0 });
  assert.equal(result.results[0].status, 'delivered');
  assert.equal(result.results[0].attempts, 2);
  assert.equal(calls.filter(call => call.kind === 'fetch').length, 2);
  const insert = queries.find(query => /INSERT INTO plugin_webhook_deliveries/.test(query.sql));
  assert.ok(insert);
  assert.equal(insert.params[3], 'delivered');
  assert.equal(insert.params.includes('never-store-this'), false, 'secret must not be persisted in delivery history');
});

test('caps retries, records terminal failure and scopes history to the current plugin', async () => {
  const { api, calls, queries } = fixture({ responseStatuses: new Array(MAX_ATTEMPTS).fill(500) });
  const result = await api.emit('demo.event');
  assert.deepEqual({ matched: result.matched, delivered: result.delivered, failed: result.failed }, { matched: 1, delivered: 0, failed: 1 });
  assert.equal(result.results[0].attempts, MAX_ATTEMPTS);
  assert.equal(calls.filter(call => call.kind === 'fetch').length, MAX_ATTEMPTS);
  const history = await api.deliveries({ status: 'failed', limit: 500 });
  assert.equal(history.length, 1);
  const select = queries.find(query => /SELECT id, webhook_id/.test(query.sql));
  assert.match(select.sql, /WHERE plugin_id = \$1 AND status = \$2/);
  assert.deepEqual(select.params, ['test-webhook', 'failed', 100]);
  assert.doesNotMatch(select.sql, /secret/i);
});
