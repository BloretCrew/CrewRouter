'use strict';
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { ensureProviderUsageHistory, archiveProviderUsage, makeProviderUsageSourceSql } = require('../utils/provider-usage-history');

async function main() {
  const url = process.env.QUOTA_TEST_DATABASE_URL;
  if (!url) throw new Error('设置 QUOTA_TEST_DATABASE_URL 为隔离测试库');
  const parsed = new URL(url);
  assert(['127.0.0.1','localhost'].includes(parsed.hostname));
  assert(parsed.pathname.startsWith('/crewrouter_quota_test'));
  const client = new Client({ connectionString: url });
  await client.connect();
  const schema = `provider_usage_test_${process.pid}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query("SET timezone TO 'Asia/Shanghai'");
    await client.query(`CREATE TABLE usage_records(id BIGINT PRIMARY KEY,created_at TIMESTAMP,user_id INTEGER,
      provider_id VARCHAR(100),model_id VARCHAR(100),api_key_id INTEGER,request_source TEXT,tokens_used BIGINT,cost NUMERIC)`);
    await client.query('CREATE TABLE usage_message_analysis(usage_id BIGINT,workspace_path TEXT)');
    await ensureProviderUsageHistory(client);
    await ensureProviderUsageHistory(client);
    await client.query(`INSERT INTO usage_records VALUES
      (1,'2026-01-01 00:00',1,'p','m',1,'codex',10,0.25),
      (2,'2026-01-01 23:59',1,'p','m',1,'codex',20,0.5),
      (3,'2026-01-02 00:00',2,'q','n',2,NULL,30,0.75)`);
    await client.query("INSERT INTO usage_message_analysis VALUES(1,'/project'),(2,'/project')");
    const totals = async () => (await client.query(`SELECT SUM(request_count)::int AS requests,SUM(tokens_used)::int AS tokens,SUM(cost)::text AS cost FROM ${makeProviderUsageSourceSql()} s`)).rows[0];
    assert.deepEqual(await totals(), {requests:3,tokens:60,cost:'1.50'});
    await archiveProviderUsage(client, {start:'2026-01-01',end:'2026-01-01'});
    await archiveProviderUsage(client, {start:'2026-01-01',end:'2026-01-01'});
    assert.deepEqual(await totals(), {requests:3,tokens:60,cost:'1.50'});
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM provider_usage_archived')).rows[0].n,2);
    await client.query('BEGIN');
    await archiveProviderUsage(client, {ids:[3]});
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM provider_usage_archived')).rows[0].n,2);
    await client.query('BEGIN');
    await archiveProviderUsage(client, {ids:[1,2,3]});
    await client.query('DELETE FROM usage_records');
    await client.query('COMMIT');
    assert.deepEqual(await totals(), {requests:3,tokens:60,cost:'1.50'});
    const isolated = (await client.query(`SELECT SUM(request_count)::int AS n FROM ${makeProviderUsageSourceSql()} s WHERE user_id=1 AND provider_id='p'`)).rows[0];
    assert.equal(isolated.n,2);
    await client.query("INSERT INTO usage_records VALUES(4,'2026-01-01 22:00',1,'p','m',1,'codex',40,1.0)");
    await client.query("INSERT INTO usage_message_analysis VALUES(4,'/project')");
    await archiveProviderUsage(client,{start:'2026-01-01',end:'2026-01-01'});
    assert.deepEqual(await totals(),{requests:4,tokens:100,cost:'2.50'});
    console.log('PASS provider usage archive: idempotence, rollback, Shanghai dates, isolation, purge continuity, late arrivals');
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}
main().catch(error => { console.error(error); process.exitCode=1; });
