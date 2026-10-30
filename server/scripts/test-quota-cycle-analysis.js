'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Client } = require('pg');
const crypto = require('node:crypto');
const cycle = require('../utils/quota-cycle-analysis');
const { ensureQuotaHistorySchema } = require('../utils/provider-quota-history');
const { createIsolatedPostgresFixture } = require('./test-support/isolated-postgres');

test('周期数值、变更分类、百分位与未知用量', () => {
  assert.equal(cycle.percent({ kind: 'window', used_percent: 0 }), 0);
  assert.equal(cycle.percent({ kind: 'balance', total: null, remaining: 0 }), null);
  assert.equal(cycle.percent({ kind: 'balance', total: 100, remaining: 0 }), 100);
  assert.equal(cycle.classify({ total: 100, remaining: 20 }, { kind: 'balance', total: 100, remaining: 50 }), 'topup');
  assert.equal(cycle.classify({ total: 100 }, { kind: 'balance', total: 200 }), 'adjustment');
  assert.equal(cycle.classify({}, { quality: { correction: true } }), 'correction');
  assert.equal(cycle.classify({ used_percent: 99 }, { kind: 'window', used_percent: 0 }), 'reset');
  const summary = cycle.summarize([{ attempt_id: '1', relation: 'certain', snapshot: { started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T00:00:01Z', status: 'success', total_tokens: 0 } }]);
  assert.equal(summary.total_tokens, 0);
  assert.equal(summary.points, null);
  assert.equal(summary.latency_ms.p95, 1000);
});

test('隔离PG：多窗口、完整/partial、重置充值、修正回补、重叠、保留、权限和导出', async context => {
  const cluster = createIsolatedPostgresFixture(context, 'quota-cycle');
  const db = cluster.track(new Client(cluster.connection));
  await db.connect();
  await cluster.assertIsolation(db);
  const schema = `quota_cycle_${process.pid}`;
  await db.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  const account = crypto.randomUUID(), account2 = crypto.randomUUID();
  const t = second => new Date(Date.UTC(2026, 0, 2, 0, 0, second)).toISOString();
  const options = { now: t(31), reconciliationSeconds: 60 };
  async function observe(second, percent, extra = {}, items) {
    const observation = { id: crypto.randomUUID(), account_id: account, provider_id: 'p', observed_at: t(second), status: 'success' };
    const normalized = items || [{ kind: 'window', unit: 'percent', window_key: '5h', used_percent: percent, resets_at: t(3600), ...extra }];
    const result = await cycle.processObservation(db, observation, normalized, options);
    await cycle.reconcileCycles(db,options);
    return { observation, normalized, result };
  }
  try {
    await db.query(`CREATE TABLE providers(id TEXT PRIMARY KEY,enabled BOOLEAN,quota_enabled BOOLEAN);
      CREATE TABLE models(id TEXT PRIMARY KEY,provider TEXT);
      CREATE TABLE teams(id INTEGER PRIMARY KEY,hide_provider_quota BOOLEAN);
      CREATE TABLE user_teams(user_id INTEGER,team_id INTEGER);
      CREATE TABLE team_models(team_id INTEGER,model_id TEXT);
      CREATE TABLE request_attempts(id UUID PRIMARY KEY,account_id UUID,started_at TIMESTAMPTZ,ended_at TIMESTAMPTZ,
        user_id INTEGER,logical_request_id UUID,status TEXT,total_tokens NUMERIC,points NUMERIC,metadata JSONB);
      INSERT INTO providers VALUES('p',TRUE,TRUE);
      INSERT INTO models VALUES('m','p'); INSERT INTO teams VALUES(1,FALSE);
      INSERT INTO user_teams VALUES(1,1); INSERT INTO team_models VALUES(1,'m');`);
    await ensureQuotaHistorySchema(db);
    await cycle.ensureQuotaCycleSchema(db);
    await cycle.ensureQuotaCycleSchema(db);
    await db.query(`INSERT INTO provider_quota_accounts(id,identity,provider_id,label,scope) VALUES($1,'a','p','账户','upstream_key'),($2,'b','p','账户2','upstream_key');
    `, [account, account2]);
    await db.query(`INSERT INTO provider_quota_account_providers(account_id,provider_id) VALUES($1,'p'),($2,'p')`, [account, account2]);
    const first = await observe(0, 0);
    const repeated = await cycle.processObservation(db, first.observation, first.normalized, options);
    assert.equal(repeated.cycles.length, 0);
    const a = crypto.randomUUID(), b = crypto.randomUUID(), c = crypto.randomUUID();
    await db.query(`INSERT INTO request_attempts VALUES
      ($1,$4,$5,$6,1,$1,'success',10,2,'{"model":"m","source":"cli","project_id":"project","api_key_id":1,"session_id":"s"}'),
      ($2,$4,$5,$7,2,$2,'failed',100,20,'{}'),
      ($3,$4,$8,$9,1,$3,'success',5,1,'{}')`, [a, b, c, account, t(1), t(8), t(24), t(18), t(28)]);
    await observe(5, 0);
    await observe(10, 40);
    await observe(20, 100);
    const range = { start: '2026-01-01', end: '2026-01-03' };
    const list = await cycle.queryQuotaCycles(db, range);
    assert.equal(list.total, 1);
    const id = list.rows[0].id;
    assert.equal(list.rows[0].state, 'exhausted_pending_reconciliation');
    const report = await cycle.queryQuotaCycle(db, id, range);
    assert.equal(report.summary.attempts, 3);
    assert.equal(report.summary.certain, 1);
    assert.equal(report.summary.candidate, 2);
    assert.equal(report.summary.total_tokens, 115);
    const self = await cycle.queryQuotaCycle(db, id, range, 'user', 1);
    assert.equal(self.summary.attempts, 2);
    assert.equal(self.summary.total_tokens, 15);
    assert.equal(self.dimensions.user.length, 1);
    assert.equal(self.dimensions.model.find(row => row.key === 'm').attempts, 1);
    assert.equal(self.versions, undefined);
    await assert.rejects(cycle.queryQuotaCycle(db, id, { ...range, user_id: '2' }, 'user', 1), /无效/);
    const intervals = await cycle.queryQuotaIntervals(db, id, range, 'user', 1);
    assert.equal(intervals.rows[0].started_at.toISOString(), t(0));
    assert.equal(intervals.rows[0].quality.candidate, undefined);
    assert.equal(intervals.rows[0].summary.total_tokens, 10);
    const requests = await cycle.queryQuotaRequests(db, id, { ...range, limit: '1', page: '2' }, 'user', 1);
    assert.equal(requests.total, 2);
    assert.equal(requests.rows.length, 1);
    const csv = await cycle.exportQuotaCycle(db, id, { ...range, format: 'csv' }, 'user', 1);
    assert.ok(!csv.includes(b));
    await cycle.reconcileCycles(db, { now: t(100), reconciliationSeconds: 60 });
    assert.equal((await cycle.queryQuotaCycle(db, id, range)).cycle.state, 'partial', '无前后采集不能complete');
    const stableVersion = (await cycle.queryQuotaCycle(db, id, range)).cycle.version;
    await cycle.reconcileCycles(db, { now: t(110), reconciliationSeconds: 60 });
    assert.equal((await cycle.queryQuotaCycle(db, id, range)).cycle.version, stableVersion, '重复对账不得发布重复版本');
    const versions = (await cycle.queryQuotaCycle(db, id, range)).versions;
    assert.ok(versions.length >= 3);
    const old = await cycle.queryQuotaCycle(db, id, { ...range, version: '1' });
    assert.equal(old.cycle.state, 'active');
    await db.query('DELETE FROM request_attempts; DELETE FROM provider_quota_observations');
    await cycle.reconcileCycles(db, { now: t(120), reconciliationSeconds: 60 });
    assert.equal((await cycle.queryQuotaCycle(db, id, range)).summary.total_tokens, 115);
    await observe(30, 0, { resets_at: t(7200) });
    const reset = await cycle.queryQuotaCycles(db, range);
    assert.equal(reset.total, 2);
    await observe(40, 99, { resets_at: t(7200) });
    await observe(50, 0, { resets_at: t(10800) });
    const closed = (await cycle.queryQuotaCycles(db, range)).rows.find(row => row.started_at.toISOString() === t(30));
    assert.equal(closed.state, 'reset_before_exhaustion');
    await observe(45, 80, { resets_at: t(7200) });
    await observe(45, 85, { resets_at: t(7200), quality: { correction: true } });
    assert.ok((await cycle.queryQuotaCycle(db, closed.id, range)).versions.some(v => v.reason === 'backfill'));
    assert.ok((await cycle.queryQuotaCycle(db, closed.id, range)).cycle.quality.correction);
    await cycle.processObservation(db, { id: crypto.randomUUID(), account_id: account2, provider_id: 'p', observed_at: t(0) },
      [{ kind: 'window', unit: 'percent', window_key: 'weekly', used_percent: 40 }], options);
    const partial = (await cycle.queryQuotaCycles(db, range)).rows.find(row => row.account_id === account2);
    assert.equal(partial.state, 'partial');
    await cycle.processObservation(db, { id: crypto.randomUUID(), account_id: account2, provider_id: 'p', observed_at: t(20) },
      [{ kind: 'window', unit: 'percent', window_key: 'weekly', used_percent: 100 }], options);
    await cycle.reconcileCycles(db, { now: t(120) });
    assert.equal((await cycle.queryQuotaCycle(db, partial.id, range)).cycle.state, 'partial');
    await observe(60, null, {}, [{ kind: 'balance', unit: 'USD', window_key: '', total: 100, used: 0, remaining: 100 }]);
    await observe(70, null, {}, [{ kind: 'balance', unit: 'USD', window_key: '', total: 100, used: 10, remaining: 90 }]);
    await observe(80, null, {}, [{ kind: 'balance', unit: 'USD', window_key: '', total: 100, used: 5, remaining: 95 }]);
    await observe(90, null, {}, [{ kind: 'balance', unit: 'USD', window_key: '', total: 200, used: 5, remaining: 195 }]);
    const adjusted = (await cycle.queryQuotaCycles(db, range)).rows.filter(row => row.kind === 'balance' && row.state === 'adjusted');
    assert.equal(adjusted.length, 2);
    assert.ok((await cycle.queryQuotaIntervals(db, adjusted[0].id, range)).rows.some(row => ['topup', 'adjustment'].includes(row.event)));
    await db.query('UPDATE teams SET hide_provider_quota=TRUE');
    assert.equal((await cycle.queryQuotaCycles(db, range, 'user', 1)).total, 0);
    await assert.rejects(cycle.exportQuotaCycle(db, id, range, 'user', 1), error => error.status === 404);
    await db.query('UPDATE teams SET hide_provider_quota=FALSE; DELETE FROM team_models');
    await assert.rejects(cycle.queryQuotaCycle(db, id, range, 'user', 1), error => error.status === 404);
  } finally {
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
  }
});
