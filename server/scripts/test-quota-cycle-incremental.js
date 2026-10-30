'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const history = require('../utils/provider-quota-history');
const capture = require('../utils/request-quota-capture');
const cycle = require('../utils/quota-cycle-analysis');
const { DEFAULTS } = require('../utils/request-quota-config');
const { createIsolatedPostgresFixture } = require('./test-support/isolated-postgres');

test('真实attempt schema：增量1000样本预算、无变化不scan、质量与两phase、完整导出、late usage', async context => {
  const cluster = createIsolatedPostgresFixture(context, 'quota-incremental');
  const admin = cluster.track(new Pool(cluster.connection));
  await cluster.assertIsolation(admin);
  const schema = `quota_incremental_${process.pid}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = cluster.track(new Pool({ ...cluster.connection, options: `-c search_path=${schema}` }));
  let samplesRead = 0, historyReads = 0, queryCount = 0;
  const db = { query: async (sql, params) => {
    queryCount++;
    const text = String(sql);
    if (/SELECT DISTINCT ON\(observed_at\)/.test(text)) samplesRead++;
    if (/SELECT.*(?:FROM quota_cycles|FROM request_attempts|FROM quota_cycle_samples)/s.test(text)) historyReads++;
    return pool.query(sql, params);
  } };
  const account = crypto.randomUUID();
  const t = second => new Date(Date.UTC(2026, 0, 2, 0, 0, second)).toISOString();
  const range = { start: '2026-01-01', end: '2026-01-03' };
  const observe = (second, percent, resets_at = t(3600)) => cycle.processObservation(db, {
    id: crypto.randomUUID(), account_id: account, provider_id: 'p', observed_at: t(second), status: 'success'
  }, [{ kind: 'window', unit: 'percent', window_key: '5h', used_percent: percent, resets_at }]);
  try {
    assert.equal(DEFAULTS.reconciliation_seconds, 60);
    await db.query(`CREATE TABLE providers(id TEXT PRIMARY KEY,enabled BOOLEAN,quota_enabled BOOLEAN);
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE models(id TEXT PRIMARY KEY,provider TEXT);
      CREATE TABLE teams(id INTEGER PRIMARY KEY,hide_provider_quota BOOLEAN);
      CREATE TABLE user_teams(user_id INTEGER,team_id INTEGER);
      CREATE TABLE team_models(team_id INTEGER,model_id TEXT);
      INSERT INTO providers VALUES('p',TRUE,TRUE);
      INSERT INTO models VALUES('m','p'); INSERT INTO teams VALUES(1,FALSE);
      INSERT INTO user_teams VALUES(1,1); INSERT INTO team_models VALUES(1,'m');`);
    await history.ensureQuotaHistorySchema(db);
    await capture.ensureRequestQuotaSchema(db);
    await cycle.ensureQuotaCycleSchema(db);
    await db.query(`INSERT INTO provider_quota_accounts(id,identity,provider_id,label,scope) VALUES($1,'a','p','account','upstream_key')`, [account]);
    await db.query('INSERT INTO provider_quota_account_providers(account_id,provider_id) VALUES($1,\'p\')', [account]);
    assert.deepEqual(await capture.getCaptureConfig(pool), DEFAULTS);
    const started = performance.now();
    for (let i = 0; i < 1000; i++) await observe(i, i / 10);
    const elapsed = performance.now() - started;
    assert.equal(samplesRead, 0, '正常新样本不得读取整series');
    assert.ok(elapsed < Number(process.env.QUOTA_PERF_BUDGET_MS || 30000), `1000样本预算超限：${elapsed}ms`);
    assert.ok(queryCount < 16000, `1000样本SQL必须线性有界：${queryCount}`);
    await observe(1000, 100);
    const own = crypto.randomUUID(), other = crypto.randomUUID(), boundary = crypto.randomUUID();
    for (const [id, user, start, end, tokens] of [[own,1,1,2,10],[other,2,3,4,100],[boundary,1,2,3,5]]) {
      await db.query(`INSERT INTO request_attempts(id,logical_request_id,user_id,provider_id,account_id,started_at,ended_at,status,total_tokens,points,usage_quality,capture_status)
        VALUES($1,$1,$2,'p',$3,$4,$5,'success',$6,'0.000001','actual','success')`, [id,user,account,t(start),t(end),tokens]);
      for (const phase of ['baseline','terminal']) await db.query(`INSERT INTO request_quota_samples(id,attempt_id,phase,quality,normalized_snapshot)
        VALUES($1,$2,$3,'{"status":"success"}',$4::jsonb)`, [crypto.randomUUID(),id,phase,JSON.stringify({ observed_at:t(phase==='baseline'?start-1:end),items:[{kind:'window',unit:'percent',window_key:'5h',used_percent:phase==='baseline'?0:100}] })]);
    }
    await cycle.markSeriesDirty(db,account);
    await cycle.reconcileCycles(db,{now:t(1100)});
    const list = await cycle.queryQuotaCycles(db,range);
    const id = list.rows[0].id;
    const report = await cycle.queryQuotaCycle(db,id,range);
    assert.equal(report.cycle.state,'complete',JSON.stringify(report.cycle.quality));
    assert.equal(report.summary.points,'0.000003');
    const requests = await cycle.queryQuotaRequests(db,id,range,'user',1);
    assert.equal(requests.total,2);
    assert.equal(requests.rows[0].samples.length,2);
    assert.equal(requests.rows[0].samples[0].normalized_snapshot.items.length,1);
    const membership = await db.query(`SELECT i.started_at,i.ended_at,r.relation FROM quota_interval_requests r JOIN quota_change_intervals i ON i.id=r.interval_id WHERE r.attempt_id=$1`,[boundary]);
    assert.equal(membership.rows.length,1,'精确start=end边界不应重复归集');
    const beforeScan=historyReads,beforeQueries=queryCount;
    for(let i=0;i<10;i++) assert.equal((await cycle.reconcileCycles(db,{now:t(1200)})).reconciled,0);
    assert.equal(historyReads,beforeScan,'空dirty/due队列不得扫描历史表');
    assert.equal(queryCount-beforeQueries,10);
    await db.query('UPDATE request_attempts SET total_tokens=20 WHERE id=$1',[own]);
    await cycle.markAccountDirty(db,account);
    await cycle.reconcileCycles(db,{now:t(1200)});
    assert.equal((await cycle.queryQuotaCycle(db,id,range,'user',1)).summary.total_tokens,25);
    await db.query(`UPDATE request_quota_samples SET quality='{"status":"unsupported"}' WHERE attempt_id=$1 AND phase='terminal'`,[own]);
    await cycle.markSeriesDirty(db,account);
    await cycle.reconcileCycles(db,{now:t(1200)});
    assert.equal((await cycle.queryQuotaCycle(db,id,range)).cycle.state,'partial');
    const full = await cycle.exportQuotaCycle(db,id,range,'user',1);
    assert.equal(full.export.complete,true);
    assert.equal(full.requests.rows.length,2);
    assert.ok(!JSON.stringify(full).includes(other));
    await db.query(`INSERT INTO request_attempts(id,logical_request_id,user_id,provider_id,account_id,started_at,ended_at,status,capture_status)
      SELECT gen_random_uuid(),gen_random_uuid(),1,'p',$1,$2,$3,'failed','unsupported' FROM generate_series(1,205)`,[account,t(1),t(2)]);
    await cycle.markSeriesDirty(db,account);
    await cycle.reconcileCycles(db,{now:t(1200)});
    const exported = await cycle.exportQuotaCycle(db,id,range,'user',1);
    assert.equal(exported.requests.rows.length,207,'完整导出不能截断200条');
    await observe(1001,0,t(7200));
    await cycle.reconcileCycles(db,{now:t(1200)});
    const closed = (await cycle.queryQuotaCycle(db,id,range)).cycle;
    assert.equal(Number(closed.end_percent),100);
    assert.equal(closed.final_snapshot.used_percent,100);
    await cycle.processObservation(db,{id:crypto.randomUUID(),account_id:account,provider_id:'p',observed_at:t(2000)},[{kind:'window',unit:'percent',window_key:'stale',used_percent:0,resets_at:t(2030)}]);
    for(const [second,value] of [[2035,0],[2040,10],[2045,20]]) await cycle.processObservation(db,{id:crypto.randomUUID(),account_id:account,provider_id:'p',observed_at:t(second)},[{kind:'window',unit:'percent',window_key:'stale',used_percent:value,resets_at:t(2030)}]);
    await cycle.reconcileCycles(db,{now:t(2100)});
    const stale=(await cycle.queryQuotaCycles(db,range)).rows.filter(row=>row.window_key==='stale');
    assert.equal(stale.length,1);
    assert.equal((await cycle.queryQuotaIntervals(db,stale[0].id,range)).rows.filter(row=>row.event==='consumption').length,2);
    assert.notEqual(cycle.classify({used_percent:10,resets_at:t(3600)},{kind:'window',used_percent:11,resets_at:null}), 'reset');
    console.log(`quota incremental perf: 1000 samples ${elapsed.toFixed(0)}ms, ${queryCount} SQL total, ${samplesRead} full-series reads`);
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  }
});
