'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { parseCpaQuotaConfig, normalizeCpaQuota, fetchCpaUsage } = require('../utils/cpa-usage');

async function main() {
  assert.throws(() => parseCpaQuotaConfig('bad'), /JSON/);
  for (const value of ['null', '[]', '{}', '{"plugin_id":"p"}']) assert.throws(() => parseCpaQuotaConfig(value));
  assert.deepEqual(parseCpaQuotaConfig('{"plugin_id":" p ","auth_index":" a "}'), { pluginId: 'p', authIndex: 'a' });
  const quota = normalizeCpaQuota({ subscription: { plan: 'Pro' }, groups: [
    { displayName: 'Codex', buckets: [{ window: '5h', remainingFraction: 0.75 }, { window: 'weekly', remaining_fraction: 0, reset_time: '2026-10-08T00:00:00Z' }] }
  ] });
  assert.equal(quota.planName, 'Pro');
  assert.equal(quota.periods[0].percent, 25);
  assert.equal(quota.periods[1].exceeded, true);
  assert.equal(quota.periods[1].resetsAt, '2026-10-08T00:00:00Z');
  assert.equal(quota.remaining, 0);
  assert.equal(normalizeCpaQuota({ groups: [{ buckets: [{ remainingFraction: 1 }] }] }).remaining, 100);
  for (const fraction of [null, '', '0.5', -1, 2]) assert.throws(() => normalizeCpaQuota({ groups: [{ buckets: [{ remainingFraction: fraction }] }] }));
  assert.throws(() => normalizeCpaQuota({}));
  assert.equal(normalizeCpaQuota({ summary: [{ key: 'balance', label: '余额', value: 12, currency: 'USD' }] }).remaining, 12);
  assert.throws(() => normalizeCpaQuota({ summary: [{ key: 'spent', label: '已用', value: 12 }] }));

  const env = { url: process.env.CPA_MANAGEMENT_URL, key: process.env.CPA_MANAGEMENT_KEY };
  let status = 200;
  let body = JSON.stringify({ groups: [{ buckets: [{ remainingFraction: 0.5 }] }] });
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.url, '/v8/management/plugins/plugin%2Fname/quota?auth_index=account+index');
    assert.equal(req.headers.authorization, 'Bearer isolated-test-key');
    res.writeHead(status, status === 302 ? { Location: '/secret-target' } : { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = { quota_script: '{"plugin_id":"plugin/name","auth_index":"account index"}' };
  try {
    process.env.CPA_MANAGEMENT_URL = `http://127.0.0.1:${server.address().port}/v8/management/`;
    delete process.env.CPA_MANAGEMENT_KEY;
    await assert.rejects(fetchCpaUsage(provider), /CPA_MANAGEMENT_KEY/);
    assert.equal(requests, 0);
    process.env.CPA_MANAGEMENT_KEY = 'isolated-test-key';
    assert.equal((await fetchCpaUsage(provider)).remaining, 50);
    const { queryProviderQuotaPerKey, generateDefaultQuotaScript } = require('../utils/provider-quota');
    assert.deepEqual(JSON.parse(generateDefaultQuotaScript({ quota_mode: 'cpa' })), { plugin_id: '', auth_index: '' });
    const beforeShared = requests;
    const shared = { ...provider, id: 'isolated-cpa', name: 'CPA', quota_mode: 'cpa', api_keys: [{ key: 'one' }, { key: 'two' }] };
    const results = await Promise.all([queryProviderQuotaPerKey(shared), queryProviderQuotaPerKey(shared)]);
    assert.ok(results.every(result => result.ok && result.quota.remaining === 50));
    assert.equal(requests, beforeShared + 1);
    assert.equal(results[0].keys, undefined);
    for (status of [401, 403, 404, 502]) await assert.rejects(fetchCpaUsage(provider), new RegExp(`HTTP ${status}`));
    status = 200; body = 'invalid';
    await assert.rejects(fetchCpaUsage(provider), /JSON/);
    status = 302;
    const before = requests;
    await assert.rejects(fetchCpaUsage(provider));
    assert.equal(requests, before + 1);
    process.env.CPA_MANAGEMENT_URL = 'file:///tmp/cpa';
    await assert.rejects(fetchCpaUsage(provider), /HTTP/);
  } finally {
    for (const [key, value] of [['CPA_MANAGEMENT_URL', env.url], ['CPA_MANAGEMENT_KEY', env.key]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise(resolve => server.close(resolve));
  }
  console.log('CPA quota normalization and HTTP integration tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
