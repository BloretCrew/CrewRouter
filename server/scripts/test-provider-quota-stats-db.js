'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Client } = require('pg');
const { ensureQuotaHistorySchema } = require('../utils/provider-quota-history');
const { ensureProviderUsageHistory, archiveProviderUsage } = require('../utils/provider-usage-history');
const { queryProviderQuotaOverview, queryProviderQuotaHistory } = require('../utils/provider-quota-stats');
const { queryMultiDimensionStats } = require('../utils/multi-dimension-stats');

// Only an explicitly supplied disposable database may run this integration test.
test('隔离 PostgreSQL：权限撤回、多 Team、分页、归档互斥和明细清理回退', { skip: !process.env.QUOTA_STATS_TEST_DATABASE_URL }, async () => {
  const db = new Client({ connectionString: process.env.QUOTA_STATS_TEST_DATABASE_URL });
  await db.connect();
  const schema = `quota_stats_${process.pid}`;
  await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`SET search_path TO ${schema}; SET timezone TO 'Asia/Shanghai'`);
  try {
    await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE providers(id TEXT PRIMARY KEY,name TEXT,enabled BOOLEAN,quota_enabled BOOLEAN);
      CREATE TEMP TABLE models(id TEXT PRIMARY KEY,name TEXT,provider TEXT,upstream_model_id TEXT);
      CREATE TEMP TABLE users(id INTEGER PRIMARY KEY,username TEXT,team_id INTEGER);
      CREATE TEMP TABLE teams(id INTEGER PRIMARY KEY,name TEXT,hide_provider_quota BOOLEAN);
      CREATE TEMP TABLE user_teams(user_id INTEGER,team_id INTEGER);
      CREATE TEMP TABLE team_models(team_id INTEGER,model_id TEXT);
      CREATE TEMP TABLE api_keys(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT);
      CREATE TEMP TABLE usage_records(id BIGINT PRIMARY KEY,user_id INTEGER,provider_id TEXT,model_id TEXT,api_key_id INTEGER,request_source TEXT,tokens_used BIGINT,cost NUMERIC,created_at TIMESTAMP);
      CREATE TEMP TABLE usage_message_analysis(usage_id BIGINT,workspace_path TEXT);`);
    await ensureQuotaHistorySchema(db);
    await ensureProviderUsageHistory(db);
    await db.query(`INSERT INTO providers VALUES('p1','供应商',true,true),('p2','隐藏供应商',true,true);
      INSERT INTO models VALUES('m1','模型','p1','up1'),('m2','隐藏模型','p2','up2');
      INSERT INTO users VALUES(1,'本人',1),(2,'其他人',2);
      INSERT INTO teams VALUES(1,'隐藏Team',true),(2,'可见Team',false);
      INSERT INTO user_teams VALUES(1,1),(1,2);
      INSERT INTO team_models VALUES(1,'m1'),(2,'m1'),(1,'m2');
      INSERT INTO api_keys VALUES(1,1,'平台Key');
      INSERT INTO usage_records VALUES(1,1,'p1','m1',1,'cli',10,2,'2026-01-02 08:00:00'),(2,2,'p1','m1',1,'cli',100,20,'2026-01-02 08:00:00');
      INSERT INTO usage_message_analysis VALUES(1,'project');
      INSERT INTO provider_quota_accounts(id,identity,provider_id,label,scope) VALUES
        ('00000000-0000-0000-0000-000000000001','identity1','p1','账户','upstream_key'),
        ('00000000-0000-0000-0000-000000000002','identity2','p2','隐藏账户','upstream_key');
      INSERT INTO provider_quota_account_providers(account_id,provider_id,last_attempt_at,last_attempt_status) VALUES
        ('00000000-0000-0000-0000-000000000001','p1','2026-01-02T00:00:00Z','success'),
        ('00000000-0000-0000-0000-000000000002','p2',NULL,NULL);
      INSERT INTO provider_quota_batches VALUES('batch1','p1','2026-01-02T00:00:00Z','manual','success');
      INSERT INTO provider_quota_observations(id,batch_id,provider_id,account_id,provider_name,source,checked_at,observed_at,status) VALUES
        ('00000000-0000-0000-0000-000000000011','batch1','p1','00000000-0000-0000-0000-000000000001','供应商','manual','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','success');
      INSERT INTO provider_quota_observation_items(observation_id,account_id,provider_id,observed_at,kind,unit,window_key,total,used,remaining) VALUES
        ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','p1','2026-01-02T00:00:00Z','balance','USD','',100,20,80);
      INSERT INTO provider_quota_daily_agg(account_id,provider_id,provider_name,date,kind,unit,window_key,sample_count,success_count,first_observed_at,last_observed_at,last_total,last_used,last_remaining,observed_consumption) VALUES
        ('00000000-0000-0000-0000-000000000001','p1','供应商','2026-01-02','balance','USD','',1,1,'2026-01-02T00:00:00Z','2026-01-02T00:00:00Z',100,20,80,5);`);
    const range = { start: '2026-01-01', end: '2026-01-03' };
    const overview = await queryProviderQuotaOverview(db, range, 'user', 1);
    assert.equal(overview.accounts.length, 1);
    assert.equal(overview.accounts[0].remaining, 80);
    assert.equal(overview.accounts[0].requests, 1);
    assert.equal(overview.accounts[0].tokens, 10);
    assert.equal(overview.groups[0].observed_consumption, 5);
    assert.equal(overview.trend[0].date, '2026-01-02');
    const history = await queryProviderQuotaHistory(db, { ...range, limit: 1 }, 'user', 1);
    assert.equal(history.total, 1);
    assert.equal(history.rows.length, 1);
    const denied = await queryProviderQuotaHistory(db, { ...range, account_id: '00000000-0000-0000-0000-000000000002' }, 'user', 1);
    assert.equal(denied.total, 0);
    const quota = await queryMultiDimensionStats(db, { ...range, data_source: 'quota', dimensions: 'account,date', metric: 'observed_consumption' }, 'user', 1);
    assert.equal(quota.rows[0].value, 5);
    const association = await queryMultiDimensionStats(db, { ...range, data_source: 'association' }, 'user', 1);
    assert.equal(association.rows[0].requests, 1);
    await archiveProviderUsage(db, { ids: [1] });
    const archived = await queryProviderQuotaOverview(db, range, 'user', 1);
    assert.equal(archived.accounts[0].requests, 1, '归档后未清理不重复');
    await db.query('DELETE FROM usage_records WHERE id=1; DELETE FROM provider_quota_observations');
    const retained = await queryProviderQuotaOverview(db, range, 'user', 1);
    assert.equal(retained.accounts[0].remaining, 80, '额度明细清理后从长期聚合回退');
    assert.equal(retained.accounts[0].requests, 1, '用量明细清理后从长期聚合读取');
    await db.query(`SAVEPOINT status_filter;
      UPDATE provider_quota_account_providers SET last_attempt_status='failed' WHERE provider_id='p1';
      UPDATE provider_quota_daily_agg SET observed_consumption=10 WHERE provider_id='p1';
      UPDATE provider_quota_account_providers SET last_attempt_at='2026-01-02T00:00:00Z',last_attempt_status='success' WHERE provider_id='p2';
      INSERT INTO provider_quota_daily_agg(account_id,provider_id,provider_name,date,kind,unit,window_key,sample_count,success_count,first_observed_at,last_observed_at,last_total,last_used,last_remaining,observed_consumption)
      VALUES('00000000-0000-0000-0000-000000000002','p2','成功供应商','2026-01-02','balance','USD','',7,7,'2025-11-01T00:00:00Z','2026-01-02T00:00:00Z',100,30,70,30);`);
    const failedOnly = await queryProviderQuotaOverview(db, { ...range, status: 'failed' }, 'admin');
    assert.equal(failedOnly.groups.find(row => row.unit === 'USD').observed_consumption, 10, 'failed消耗不能混入成功账户的30');
    assert.equal(failedOnly.trend.length, 1);
    assert.equal(failedOnly.trend[0].provider_id, 'p1');
    assert.equal(failedOnly.coverage.samples, 1);
    assert.equal(failedOnly.coverage.started_at.toISOString(), '2026-01-02T00:00:00.000Z');
    await db.query('ROLLBACK TO SAVEPOINT status_filter');
    await db.query(`INSERT INTO provider_quota_account_providers(account_id,provider_id,last_attempt_at,last_attempt_status)
      VALUES('00000000-0000-0000-0000-000000000001','p2','2026-01-02T00:00:00Z','success');
      INSERT INTO team_models VALUES(2,'m2');`);
    const shared = await queryProviderQuotaOverview(db, range, 'user', 1);
    assert.equal(shared.accounts.filter(row => row.account_id === '00000000-0000-0000-0000-000000000001').length, 2);
    assert.equal(shared.groups.find(row => row.unit === 'USD').remaining, 80, '共享账户按账户去重');
    assert.equal(shared.coverage.samples, 1);
    const grouped = await queryMultiDimensionStats(db, { ...range, data_source: 'quota', dimensions: 'unit', metric: 'remaining' }, 'user', 1);
    assert.equal(grouped.rows.find(row => row.unit === 'USD').value, 80, '未选供应商维度共享账户只计一次');
    await db.query(`UPDATE provider_quota_account_providers SET last_attempt_status='failed' WHERE provider_id='p1';
      INSERT INTO provider_quota_accounts(id,identity,provider_id,label,scope) VALUES
        ('00000000-0000-0000-0000-000000000003','legacy','p1','旧账户','legacy');
      INSERT INTO provider_quota_account_providers(account_id,provider_id,active,legacy)
        VALUES('00000000-0000-0000-0000-000000000003','p1',FALSE,TRUE);
      INSERT INTO provider_quota_daily_agg(account_id,provider_id,provider_name,date,kind,unit,window_key,sample_count,success_count,first_observed_at,last_observed_at,last_remaining)
        VALUES('00000000-0000-0000-0000-000000000003','p1','供应商','2025-12-01','balance','USD','',1,1,'2025-12-01T01:00:00Z','2025-12-01T01:00:00Z',999);
      INSERT INTO provider_quota_daily_agg(account_id,provider_id,provider_name,date,kind,unit,window_key,sample_count,success_count,first_observed_at,last_observed_at,first_used_percent,last_used_percent,anomaly_count,quality,percent_change)
        VALUES('00000000-0000-0000-0000-000000000001','p1','供应商','2026-01-02','window','percent','monthly',2,2,'2026-01-02T01:00:00Z','2026-01-02T02:00:00Z',10,20,0,'{"last_event":"window_change"}',10),
        ('00000000-0000-0000-0000-000000000001','p1','供应商','2026-01-03','window','percent','weekly',1,1,'2026-01-03T01:00:00Z','2026-01-03T01:00:00Z',30,30,0,'{"last_event":"window_change"}',NULL);`);
    const sharedFailed = await queryProviderQuotaOverview(db, { ...range, status: 'failed' }, 'user', 1);
    assert.ok(sharedFailed.accounts.every(row => row.provider_id === 'p1'));
    assert.ok(sharedFailed.trend.every(row => row.provider_id === 'p1'), '共享账户也按(account_id,provider_id)限制，不能仅按account_id');
    assert.equal(sharedFailed.coverage.samples, 4);
    assert.equal(sharedFailed.coverage.started_at.toISOString(), '2026-01-02T00:00:00.000Z', 'status过滤历史起点排除未选中的legacy账户');
    const windows = await queryProviderQuotaOverview(db, { ...range, provider_id: 'p1' }, 'user', 1);
    assert.equal(windows.groups.find(row => row.unit === 'USD').remaining, 80, 'legacy不纳入当前总量');
    assert.equal(windows.accounts.find(row => row.kind === 'balance').status, 'failed', '明细清理后保持持久失败状态');
    assert.ok(windows.accounts.some(row => row.window_key === 'monthly'), '后续weekly不能覆盖monthly');
    assert.ok(windows.accounts.some(row => row.window_key === 'weekly'));
    assert.equal(windows.coverage.started_at.toISOString(), '2025-12-01T01:00:00.000Z', '历史起点包含inactive/legacy历史');
    assert.equal(windows.trend.find(row => row.window_key === 'monthly').percent_change, 10);
    const percentChange = await queryMultiDimensionStats(db, { ...range, provider_id: 'p1', data_source: 'quota', dimensions: 'account,window', metric: 'percent_change' }, 'user', 1);
    assert.equal(percentChange.rows.find(row => row.window_key === 'monthly').value, 10);
    await db.query("DELETE FROM team_models WHERE model_id='m2'");
    await db.query('DELETE FROM team_models WHERE team_id=2');
    assert.equal((await queryProviderQuotaOverview(db, range, 'user', 1)).accounts.length, 0, '撤回未隐藏Team授权后不可见');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const Module = require('node:module');
    const sourceFile = require.resolve('../routes/admin');
    const realRequire = Module.createRequire(sourceFile);
    const express = require('express');
    const next = (req, res, done) => done();
    const generic = new Proxy({}, { get: () => () => next });
    let mockQuotaResult;
    const fakeRequire = name => {
      if (name === 'express') return express;
      if (name === 'crypto') return require('node:crypto');
      if (name === '../models/database') return { pool: db };
      if (name === '../middleware/auth') return { requireAuth: next, requireAdmin: next, requireProviderManager: next };
      if (name === '../utils/instance-edition') return { requireTeamEdition: () => (req, res, done) => req.headers['x-test-personal'] ? res.status(403).json({ error: 'Team required' }) : done(), loadPersistedEdition: async () => 'team' };
      if (name === '../utils/provider-quota') return { queryProviderQuotaPerKey: async () => mockQuotaResult, saveQuotaSnapshot: async () => ({ recorded: true }) };
      if (name === '../utils/provider-quota-history') return realRequire(name);
      if (name === '../utils/provider-quota-stats' || name === '../utils/provider-usage-history' || name === '../utils/multi-dimension-stats') return realRequire(name);
      return generic;
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(sourceFile, 'utf8'), { require: fakeRequire, module, exports: module.exports, console, Buffer, process, setTimeout, clearTimeout }, { filename: sourceFile });
    const app = express();
    app.use((req, res, done) => { req.session = { user: { id: 1 } }; done(); });
    app.use('/api/admin', module.exports);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/admin`;
      await db.query("ALTER TABLE providers ADD COLUMN api_key TEXT; UPDATE providers SET api_key='sk-test-sensitive-quota-secret' WHERE id='p1'");
      const secret = 'sk-test-sensitive-quota-secret';
      mockQuotaResult = { ok: true, provider: { id: 'p1', token: secret }, quota: { unit: 'balance', remaining: 80, extra: `USD ${secret}`, credits: { balance: 5, hasCredits: true, token: secret }, authorization: secret },
        keys: [{ ok: false, label: secret, error: `Bearer ${secret}`, token: secret }], aggregated: { remaining: 80, unit: 'balance', token: secret } };
      const safeResponse = await fetch(`${url}/providers/p1/check-quota`);
      assert.equal(safeResponse.status, 200);
      const safeData = await safeResponse.json();
      assert.ok(!JSON.stringify(safeData).includes(secret));
      assert.equal(safeData.quota.remaining, 80);
      assert.equal(safeData.quota.credits.balance, 5);
      assert.equal(safeData.keys[0].error, '额度查询失败');
      assert.equal(safeData.history.recorded, true);
      mockQuotaResult = { ok: false, error: secret, status: 502, provider: { token: secret } };
      const failureResponse = await fetch(`${url}/providers/p1/check-quota`);
      assert.equal(failureResponse.status, 502);
      const failureData = await failureResponse.json();
      assert.equal(failureData.error, '额度查询失败');
      assert.ok(!JSON.stringify(failureData).includes(secret));
      const personal = await fetch(`${url}/stats/provider-quota/history?start=2026-01-01&end=2026-01-03`, { headers: { 'x-test-personal': '1' } });
      assert.equal(personal.status, 200, '个人provider manager历史入口不被Team门禁拦截');
      const multiResponse = await fetch(`${url}/stats/multi?data_source=association&start=2026-01-01&end=2026-01-03`);
      assert.equal(multiResponse.status, 200);
      const multiData = await multiResponse.json();
      assert.equal(Number(multiData.summary.requests), 2, '固定组合关联分析读取清理后的归档请求');
      assert.equal(multiData.summary.avg_latency, null);
      assert.deepEqual(multiData.unavailable_dimensions, ['plugin', 'latency']);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    await db.query('ROLLBACK');
  } finally {
    await db.query('ROLLBACK');
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  }
});
