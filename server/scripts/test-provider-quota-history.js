'use strict';

const assert = require('node:assert/strict');
process.env.CRW_MASTER_KEY = 'isolated-quota-history-test-secret';
const history = require('../utils/provider-quota-history');

const provider = { id: 'p1', name: '测试供应商', base_url: 'https://example.com', quota_mode: 'script', api_key: 'sk-private-key-for-test' };
const balance = (used, remaining) => ({ unit: 'balance', currency: 'USD', total: 100, used, remaining });

function pureTests() {
  assert.equal(history.numberOrNull(null), null);
  assert.equal(history.numberOrNull(''), null);
  assert.equal(history.numberOrNull(0), 0);
  assert.equal(history.numberOrNull(Infinity), null);
  assert.equal(history.stableIdentity(provider, 'a').identity, history.stableIdentity({ ...provider, name: '改名' }, 'a').identity);
  assert.notEqual(history.stableIdentity(provider, 'a').identity, history.stableIdentity(provider, 'b').identity);
  const cpa = { ...provider, quota_mode: 'cpa', cpa_management_url: 'https://cpa.example', quota_script: '{"auth_index":"account1"}' };
  assert.equal(history.stableIdentity(cpa).identity, history.stableIdentity({ ...cpa, id: 'p2', api_key: 'different' }).identity);
  assert.equal(history.normalizeQuotaItems({ unit: 'balance', remaining: 0 }, provider)[0].remaining, 0);
  assert.equal(history.normalizeQuotaItems({ unit: 'balance', remaining: 0 }, provider)[0].total, null);
  assert.equal(history.normalizeQuotaItems({ unit: 'balance', remaining: 0 }, provider)[0].unit, 'unknown');
  const windows = history.normalizeQuotaItems({ unit: 'percent', used: 20, periods: [{ key: 'daily', percent: 0 }, { key: 'weekly', percent: 20 }] }, provider);
  assert.equal(windows.length, 2);
  assert.ok(windows.every(item => item.kind === 'window' && item.used === null));
  assert.equal(history.normalizeQuotaItems({ isValid: false, remaining: 1 }, provider).length, 0);
  const cleaned = JSON.stringify(history.serializeSafeResult({ ok: true, quota: { ...balance(10, 90), token: provider.api_key, planName: provider.api_key, periods: [{ key: 'x', token: provider.api_key }] } }, provider));
  assert.ok(!cleaned.includes(provider.api_key));
  assert.ok(!cleaned.includes('token'));
  const previous = { total: 100, used: 10, remaining: 90, observed_at: '2026-10-01T00:00:00Z', resets_at: null };
  const item = history.normalizeQuotaItems(balance(20, 80), provider)[0];
  assert.equal(history.classifyChange(previous, item, '2026-10-01T01:00:00Z').consumption, 10);
  assert.equal(history.classifyChange(previous, { ...item, total: 110 }, '2026-10-01T01:00:00Z').event, 'adjustment');
  assert.equal(history.classifyChange(previous, { ...item, resets_at: '2026-11-01T00:00:00Z' }, '2026-10-01T01:00:00Z').event, 'reset');
  assert.equal(history.classifyChange(previous, { ...item, used: 0 }, '2026-10-01T01:00:00Z').event, 'recharge_or_reset');
  assert.equal(history.classifyChange(previous, item, '2026-10-03T01:00:00Z').event, 'gap');
  const newapi = history.normalizeQuotaItems({ ...balance(0,100),extra:'站点未开放 usage 接口，已用按 0 计' },{ ...provider,quota_mode:'newapi' })[0];
  assert.equal(newapi.unit,'USD');
  assert.equal(newapi.used,null);
  assert.equal(newapi.remaining,null);
  assert.equal(newapi.quality.unknown_used,true);
  assert.equal(history.normalizeQuotaItems(balance(1,99),{ ...provider,quota_mode:'cursor' })[0].unit,'USD');
  const compat = history.serializeSafeResult({ quota:{ credits:{ balance:'2',hasCredits:true,token:provider.api_key },rateLimitResetCredits:{ available_count:3,token:provider.api_key } } },provider);
  assert.equal(compat.credits.balance,2);
  assert.equal(compat.rateLimitResetCredits.available_count,3);
  assert.ok(!JSON.stringify(compat).includes(provider.api_key));
  console.log('额度历史纯函数测试通过');
}

async function databaseTests() {
  const modulePath = process.env.QUOTA_HISTORY_PGLITE_MODULE;
  const dbUrl = process.env.QUOTA_HISTORY_TEST_DATABASE_URL;
  if (!modulePath && !dbUrl) {
    console.log('未配置隔离数据库，跳过数据库测试（设置 QUOTA_HISTORY_PGLITE_MODULE 或 QUOTA_HISTORY_TEST_DATABASE_URL）');
    return;
  }
  let db;
  let pool;
  let schema;
  let adminPool;
  if (modulePath) {
    const { PGlite } = require(modulePath);
    db = new PGlite();
    const client = { query: async (sql, args) => {
      const value = args ? await db.query(sql, args) : (await db.exec(sql)).at(-1);
      return { ...value, rowCount: value.affectedRows ?? value.rows?.length ?? 0 };
    }, release() {} };
    pool = { query: client.query, connect: async () => client };
  } else {
    const { Pool } = require('pg');
    adminPool = new Pool({ connectionString: dbUrl });
    const check = await adminPool.query('SELECT current_database() AS name');
    if (!/test|isolated/i.test(check.rows[0].name)) throw new Error('拒绝在非隔离测试数据库执行');
    schema = 'quota_history_' + require('node:crypto').randomBytes(8).toString('hex');
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema} -c timezone=Asia/Shanghai` });
  }
  try {
    await pool.query(`CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT,base_url TEXT,quota_mode TEXT,api_key TEXT,
      quota_last_checked_at TIMESTAMPTZ,quota_last_ok BOOLEAN,quota_last_result JSONB,quota_last_error TEXT)`);
    await pool.query('INSERT INTO providers(id,name,base_url,quota_mode,api_key) VALUES($1,$2,$3,$4,$5)', [provider.id,provider.name,provider.base_url,provider.quota_mode,provider.api_key]);
    await history.ensureQuotaHistorySchema(pool);
    await history.ensureQuotaHistorySchema(pool);
    await require('../utils/provider-usage-history').ensureProviderUsageHistory(pool);
    await pool.query('SELECT * FROM provider_usage_daily_agg LIMIT 0');
    const count = async table => Number((await pool.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
    const record = (result, time, extra = {}) => history.recordQuotaHistory(pool, provider, result, { checkedAt: time, ...extra });
    const first = { ok: true, quota: balance(10, 90) };
    await record(first, '2026-10-01T15:00:00Z');
    await record(first, '2026-10-01T15:00:00Z');
    await Promise.all([record(first,'2026-10-01T15:00:00Z'),record(first,'2026-10-01T15:00:00Z')]);
    assert.equal(await count('provider_quota_observations'), 1);
    await record({ ok: true, quota: balance(20, 80) }, '2026-10-01T15:30:00Z');
    const daily = (await pool.query('SELECT *,date::text AS date_text FROM provider_quota_daily_agg')).rows[0];
    assert.equal(daily.date_text, '2026-10-01');
    assert.equal(Number(daily.sample_count), 2);
    assert.equal(Number(daily.observed_consumption), 10);
    await record({ ok: false, error: provider.api_key }, '2026-10-01T16:00:00Z');
    const snapshot = (await pool.query('SELECT * FROM providers')).rows[0];
    assert.equal(snapshot.quota_last_ok, false);
    assert.equal(snapshot.quota_last_result.remaining, 80);
    assert.ok(!snapshot.quota_last_error.includes(provider.api_key));
    await record({ ok:true,quota:{ ...balance(999,0),isValid:false } },'2026-10-01T16:30:00Z');
    assert.equal((await pool.query('SELECT quota_last_result FROM providers')).rows[0].quota_last_result.remaining,80);
    await record({ ok:true,quota:{} },'2026-10-01T17:00:00Z');
    assert.equal((await pool.query('SELECT quota_last_ok FROM providers')).rows[0].quota_last_ok,false);
    const before = await count('provider_quota_batches');
    const failedPool = { connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), query: (sql, args) => {
        if (sql.includes('UPDATE providers SET quota_last_checked_at')) throw new Error('injected snapshot failure');
        return client.query(sql,args);
      } };
    } };
    await assert.rejects(history.recordQuotaHistory(failedPool, provider, { ok: true, quota: balance(30, 70) }, { checkedAt: '2026-10-02T00:00:00Z' }), /injected/);
    assert.equal(await count('provider_quota_batches'), before);
    assert.equal((await pool.query('SELECT quota_last_result FROM providers')).rows[0].quota_last_result.remaining, 80);
    const multi = { ...provider, api_keys: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] };
    await history.recordQuotaHistory(pool, multi, { ok: true, keys: [{ ok: true, quota: balance(5,95) }, { ok: false, error: 'bad' }] }, { checkedAt: '2026-10-02T00:00:00Z' });
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM provider_quota_observations WHERE status='partial'")).rows[0].n), 1);
    await history.recordQuotaHistory(pool, multi, { ok: true, keys: [{ ok: false }, { ok: true, quota: balance(2,98) }] }, { checkedAt: '2026-10-02T00:30:00Z' });
    const partialSnapshot = (await pool.query('SELECT quota_last_result FROM providers')).rows[0].quota_last_result;
    assert.equal(partialSnapshot.keys[0].quota.remaining,95);
    assert.equal(partialSnapshot.keys[0].stale,true);
    const identitiesBefore = (await pool.query("SELECT identity FROM provider_quota_accounts WHERE scope='upstream_key' ORDER BY identity")).rows.map(row => row.identity);
    await history.recordQuotaHistory(pool, { ...multi, api_keys: [...multi.api_keys].reverse() }, { ok: true, keys: [{ ok: false }, { ok: true, quota: balance(6,94) }] }, { checkedAt: '2026-10-02T01:00:00Z' });
    assert.deepEqual((await pool.query("SELECT identity FROM provider_quota_accounts WHERE scope='upstream_key' ORDER BY identity")).rows.map(row => row.identity), identitiesBefore);
    const cpa = { ...provider, quota_mode: 'cpa', cpa_management_url: 'https://cpa', quota_script: '{"auth_index":"shared"}' };
    const cached = { unit: 'percent', source: 'passive', observedAt: '2026-10-02T00:00:00Z', used: 30 };
    await history.recordQuotaHistory(pool,cpa,{ ok:true,quota:cached },{ checkedAt:'2026-10-02T01:00:00Z' });
    const samples = await count('provider_quota_observation_items');
    await history.recordQuotaHistory(pool,{ ...cpa,id:'p2' },{ ok:true,quota:cached },{ checkedAt:'2026-10-02T02:00:00Z' });
    assert.equal(await count('provider_quota_observation_items'), samples);
    assert.equal(Number((await pool.query("SELECT count(*) AS n FROM provider_quota_accounts WHERE scope='shared_subscription'")).rows[0].n),1);
    const mappings = await pool.query("SELECT * FROM provider_quota_account_providers WHERE account_id=(SELECT id FROM provider_quota_accounts WHERE scope='shared_subscription')");
    assert.equal(mappings.rows.length,2);
    assert.ok(mappings.rows.every(row => row.active && row.last_attempt_status === 'success'));
    await history.recordQuotaHistory(pool,{ ...cpa,quota_script:'{\"auth_index\":\"rotated\"}' },{ ok:false },{ checkedAt:'2026-10-03T02:00:00Z' });
    assert.equal((await pool.query("SELECT active FROM provider_quota_account_providers WHERE provider_id='p1' AND account_id=(SELECT id FROM provider_quota_accounts WHERE scope='shared_subscription' AND identity=$1)", [history.stableIdentity(cpa).identity])).rows[0].active,false);
    await history.recordQuotaHistory(pool,cpa,{ ok:true,quota:{ unit:'percent',periods:[{ key:'monthly',percent:10 }] } },{ checkedAt:'2026-10-04T01:00:00Z' });
    await history.recordQuotaHistory(pool,cpa,{ ok:true,quota:{ unit:'percent',periods:[{ key:'weekly',percent:20 }] } },{ checkedAt:'2026-10-04T02:00:00Z' });
    assert.equal((await pool.query('SELECT quota_last_result FROM providers')).rows[0].quota_last_result.periods.length,2);
    await history.recordQuotaHistory(pool,{ ...cpa,quota_script:'{"auth_index":"another"}' },{ ok:true,quota:{ unit:'percent',periods:[{ key:'weekly',percent:30 }] } },{ checkedAt:'2026-10-04T03:00:00Z' });
    assert.equal((await pool.query('SELECT quota_last_result FROM providers')).rows[0].quota_last_result.periods.length,1);
    const legacyCount = await history.importLegacyQuotaHistory(pool);
    assert.equal(legacyCount,1);
    assert.equal(await history.importLegacyQuotaHistory(pool),0);
    assert.ok((await pool.query('SELECT active,legacy FROM provider_quota_account_providers WHERE legacy=TRUE')).rows.every(row => !row.active));
    assert.equal(await history.cleanupQuotaHistory(pool,0),0);
    const aggregates = await count('provider_quota_daily_agg');
    await pool.query("UPDATE provider_quota_observations SET checked_at=NOW()-INTERVAL '100 days'");
    const deleted = await history.cleanupQuotaHistory(pool,90);
    assert.ok(deleted > 0);
    assert.equal(await count('provider_quota_daily_agg'),aggregates);
    assert.equal(await count('provider_quota_observation_items'),0);
    await record(first,'2026-10-01T15:00:00Z');
    assert.equal(await count('provider_quota_observation_items'),0);
    await record({ ok:true,quota:balance(25,75) },'2026-10-02T02:00:00Z');
    assert.equal(await count('provider_quota_observation_items'),1);
    assert.equal(await history.importLegacyQuotaHistory(pool),0);
    await pool.query('DELETE FROM providers');
    assert.ok(await count('provider_quota_accounts') > 0);
    const rows = await pool.query('SELECT error,quality FROM provider_quota_observations');
    assert.ok(!JSON.stringify(rows.rows).includes(provider.api_key));
    console.log('额度历史隔离 PostgreSQL 测试通过：幂等迁移/批次/legacy、回滚、失败保留、部分成功、重排、共享缓存、上海日期、清理连续性');
  } finally {
    if (db) await db.close();
    else {
      if (pool) await pool.end();
      if (schema) await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
      if (adminPool) await adminPool.end();
    }
  }
}

async function queryBatchTests() {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../utils/provider-quota'),'utf8');
  let calls = 0;
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const sandbox = { module: { exports: {} }, console, setTimeout, setInterval, require: name => {
    if (name === './commandcode-usage') return { fetchCommandCodeUsage: async () => { calls++; await wait; return balance(10,90); } };
    if (name === '../logger') return { info() {},warn() {} };
    if (name === '../models/database') return { pool: {} };
    return require(require.resolve(name, { paths: [require('node:path').dirname(require.resolve('../utils/provider-quota'))] }));
  } };
  vm.runInNewContext(source,sandbox);
  const api = sandbox.module.exports;
  const p = { ...provider,quota_mode:'commandcode' };
  const a = api.queryProviderQuota(p);
  const b = api.queryProviderQuotaPerKey(p);
  const c = api.queryProviderQuotaPerKey(p);
  release();
  const results = await Promise.all([a,b,c]);
  assert.equal(calls,1);
  const rows = [];
  const fakePool = { connect: async () => ({ release() {},query: async (sql,args) => {
    if (sql.includes('INSERT INTO provider_quota_batches')) { rows.push(args[0]); return { rows:[],rowCount:0 }; }
    return { rows:[],rowCount:0 };
  } }) };
  for (const result of results) await history.recordQuotaHistory(fakePool,p,result);
  assert.equal(new Set(rows).size,1);
  console.log('并发实际查询批次复用测试通过');
}

async function queryLogSafetyTests() {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(require.resolve('../utils/provider-quota'),'utf8');
  const logs = [];
  const sandbox = { module: { exports: {} }, console, setTimeout, setInterval, AbortSignal,
    fetch: async () => ({ok:true,text:async()=>JSON.stringify({remaining:0})}), require: name => {
      if (name === '../logger') return Object.fromEntries(['info','warn','error'].map(key=>[key,text=>logs.push(text)]));
      if (name === '../models/database') return {pool:{}};
      if (name === './url-validator') return {validateUrl:async()=>({ok:true})};
      return require(require.resolve(name,{paths:[path.dirname(require.resolve('../utils/provider-quota'))]}));
    }};
  vm.runInNewContext(source,sandbox);
  const fixture = {...provider,quota_script:JSON.stringify({request:{url:'https://example.invalid/quota?token={apiKey}'},extractor:'function(r){return {isValid:true,remaining:r.remaining,currency:"USD"};}'})};
  const result = await sandbox.module.exports.queryProviderQuota(fixture);
  assert.equal(result.quota.remaining,0);
  assert.equal(result.quota.total,null);
  assert.equal(result.quota.used,null);
  assert.equal(result.quota.currency,'USD');
  fixture.quota_script=JSON.stringify({request:{url:'https://example.invalid/quota?token={apiKey}'},extractor:'function(){throw new Error("{apiKey}");}'});
  await sandbox.module.exports.queryProviderQuota(fixture);
  assert(!JSON.stringify(logs).includes(provider.api_key));
  console.log('额度请求日志脱敏与脚本缺失值测试通过');
}

pureTests();
queryBatchTests().then(queryLogSafetyTests).then(databaseTests).catch(error => { console.error(error); process.exitCode = 1; });
