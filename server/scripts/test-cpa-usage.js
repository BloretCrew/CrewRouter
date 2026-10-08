'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { parseCpaQuotaConfig, normalizeCpaQuota, fetchCpaUsage } = require('../utils/cpa-usage');

async function main() {
  assert.throws(() => parseCpaQuotaConfig('bad'), /JSON/);
  for (const value of ['null', '[]', '{}', '{"plugin_id":"p"}']) assert.throws(() => parseCpaQuotaConfig(value));
  assert.deepEqual(parseCpaQuotaConfig('{"plugin_id":" p ","auth_index":" a "}'), { pluginId: 'p', authIndex: 'a' });
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { decryptSecret } = require('../utils/secret-crypto');
  const source = fs.readFileSync(require.resolve('../routes/admin'), 'utf8');
  const start = source.indexOf('}), async (req, res) => {', source.indexOf("router.post('/providers',")) + 4;
  const end = source.indexOf('\n});', start);
  let stored = null;
  let insert = null;
  const pool = { query: async (sql, args) => {
    if (sql.includes('SELECT cpa_management_key')) return { rows: stored ? [stored] : [] };
    if (sql.includes('SELECT api_key')) return { rows: [] };
    if (sql.includes('INSERT INTO providers')) {
      insert = { sql, args };
      stored = { cpa_management_key: args[35] || stored?.cpa_management_key };
    }
    return { rows: [] };
  } };
  const save = vm.runInNewContext('(' + source.slice(start, end) + '\n})', {
    pool, URL, require, crypto: require('node:crypto'), encryptSecret: require('../utils/secret-crypto').encryptSecret,
    ensureKeyModeColumn: async () => {}, normalizeKeysInput: () => null,
    normalizeTestUserAgent: value => value || '', normalizeQuotaScheduleInterval: () => 3600,
    keyRefresher: { registerProvider() {} }, Logger: { error() {} }
  });
  async function saveBody(body) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
    insert = null;
    await save({ body }, res);
    return res;
  }
  const config = { name: 'CPA', base_url: 'https://example.com', quota_mode: 'cpa', quota_script: '{"plugin_id":"p","auth_index":"a"}', cpa_management_url: 'http://127.0.0.1:8317' };
  assert.equal((await saveBody(config)).code, 400);
  assert.equal(insert, null);
  assert.equal((await saveBody({ ...config, cpa_management_key: 'isolated-save-key' })).code, 200);
  assert.equal(decryptSecret(insert.args[35]), 'isolated-save-key');
  assert.notEqual(insert.args[35], 'isolated-save-key');
  assert.equal(insert.args[34], config.cpa_management_url);
  assert.ok(insert.sql.includes('ELSE providers.cpa_management_key END'));
  const oldKey = stored.cpa_management_key;
  assert.equal((await saveBody({ ...config, id: 'test' })).code, 200);
  assert.equal(stored.cpa_management_key, oldKey);
  assert.equal(insert.args[35], '');
  assert.equal((await saveBody({ ...config, id: 'test', cpa_management_url: 'file:///tmp' })).code, 400);
  assert.equal(insert, null);
  assert.equal((await saveBody({ name: 'Other', base_url: 'https://example.com', quota_mode: 'script' })).code, 200);
  assert.equal(insert.args[36], false);
  const details = source.slice(source.indexOf("router.get('/providers/:id',"), source.indexOf('// 切换供应商额度查询开关'));
  assert.ok(details.includes('const { cpa_management_key, ...publicProvider } = p'));
  assert.ok(source.includes('ark_secret_key, cpa_management_key, ...rest'));
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

  let status = 200;
  let body = JSON.stringify({ groups: [{ buckets: [{ remainingFraction: 0.5 }] }] });
  let requests = 0;
  let noPlugin = false;
  let credentialType = 'codex';
  let upstreamStatus = 200;
  let passive = {};
  let activeBody = { rate_limit: { primary_window: { used_percent: 30 } }, plan_type: 'Pro' };
  let disabled = false;
  const server = http.createServer((req, res) => {
    requests++;
    if (!noPlugin) assert.equal(req.url, '/v8/management/plugins/plugin%2Fname/quota?auth_index=account%20index');
    assert.equal(req.headers.authorization, 'Bearer isolated-test-key');
    if (noPlugin) {
      if (req.url === '/v8/management/credentials') return res.end(JSON.stringify({ files: [{ auth_index: 'account index', provider: credentialType, disabled, quota: passive, id_token: { chatgpt_account_id: 'acct' } }] }));
      assert.equal(req.url, '/v8/management/requests/api-call');
      let text = '';
      req.on('data', chunk => { text += chunk; });
      req.on('end', () => {
        const request = JSON.parse(text);
        assert.equal(request.auth_index, 'account index');
        assert.equal(request.header.Authorization, 'Bearer $TOKEN$');
        assert.equal(request.method, 'GET');
        if (credentialType === 'codex') {
          assert.equal(request.url, 'https://chatgpt.com/backend-api/wham/usage');
          assert.equal(request.header['ChatGPT-Account-Id'], 'acct');
        } else {
          assert.equal(request.url, 'https://api.anthropic.com/api/oauth/usage');
          assert.equal(request.header['anthropic-beta'], 'oauth-2025-04-20');
        }
        res.end(JSON.stringify({ status_code: upstreamStatus, body: JSON.stringify(activeBody) }));
      });
      return;
    }
    res.writeHead(status, status === 302 ? { Location: '/secret-target' } : { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = { quota_script: '{"plugin_id":"plugin/name","auth_index":"account index"}' };
  try {
    provider.cpa_management_url = `http://127.0.0.1:${server.address().port}/v8/management/`;
    delete provider.cpa_management_key;
    await assert.rejects(fetchCpaUsage(provider), /管理密钥/);
    assert.equal(requests, 0);
    provider.cpa_management_key = require('../utils/secret-crypto').encryptSecret('isolated-test-key');
    assert.notEqual(provider.cpa_management_key, 'isolated-test-key');
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
    noPlugin = true;
    provider.quota_script = '{"auth_index":"account index"}';
    assert.equal((await fetchCpaUsage(provider)).remaining, 70);
    assert.equal((await fetchCpaUsage(provider)).source, 'active');
    credentialType = 'claude';
    activeBody = { five_hour: { utilization: 20, resets_at: '2026-10-08T00:00:00Z' }, seven_day: { utilization: 65 } };
    assert.equal((await fetchCpaUsage(provider)).remaining, 35);
    activeBody = {};
    await assert.rejects(fetchCpaUsage(provider), /没有可用/);
    upstreamStatus = 401;
    passive = { observed_at: '2026-10-07T00:00:00Z', signals: { 'Anthropic-Ratelimit-Unified-5h-Utilization': '0.4' } };
    const fallback = await fetchCpaUsage(provider);
    assert.equal(fallback.remaining, 60);
    assert.equal(fallback.source, 'passive');
    assert.equal(fallback.observedAt, passive.observed_at);
    credentialType = 'devin'; passive = {};
    await assert.rejects(fetchCpaUsage(provider), /暂无可用/);
    credentialType = 'codex';
    passive = { signals: { 'X-Codex-Primary-Used-Percent': '100' } };
    assert.equal((await fetchCpaUsage(provider)).remaining, 0);
    passive = { signals: { 'X-Codex-Primary-Used-Percent': '' } };
    await assert.rejects(fetchCpaUsage(provider), /HTTP 401/);
    disabled = true;
    await assert.rejects(fetchCpaUsage(provider), /已禁用/);
    disabled = false;
    provider.quota_script = '{"auth_index":"missing"}';
    await assert.rejects(fetchCpaUsage(provider), /找不到/);
    provider.cpa_management_url = 'file:///tmp/cpa';
    await assert.rejects(fetchCpaUsage(provider), /HTTP/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('CPA quota normalization and HTTP integration tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
