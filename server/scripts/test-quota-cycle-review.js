'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const history = require('../utils/provider-quota-history');
const capture = require('../utils/request-quota-capture');
const cycle = require('../utils/quota-cycle-analysis');
const { createIsolatedPostgresFixture } = require('./test-support/isolated-postgres');

test('最终复审：缺series不污染事务、推断终止长期快照、导出版本一致性', async context => {
  const cluster = createIsolatedPostgresFixture(context, 'quota-review');
  const admin = cluster.track(new Pool(cluster.connection));
  await cluster.assertIsolation(admin);
  const schema = `quota_review_${process.pid}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = cluster.track(new Pool({ ...cluster.connection, options: `-c search_path=${schema}` }));
  const account = crypto.randomUUID(), attempt = crypto.randomUUID();
  const t = second => new Date(Date.UTC(2026, 0, 2, 0, 0, second)).toISOString();
  const range = { start: '2026-01-01', end: '2026-01-03' };
  try {
    await db.query(`CREATE TABLE providers(id TEXT PRIMARY KEY,enabled BOOLEAN,quota_enabled BOOLEAN);
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
      INSERT INTO providers VALUES('p',TRUE,TRUE)`);
    await history.ensureQuotaHistorySchema(db);
    await capture.ensureRequestQuotaSchema(db);
    await db.query(`INSERT INTO provider_quota_accounts(id,identity,provider_id,label,scope) VALUES($1,'a','p','account','upstream_key')`, [account]);
    await db.query('INSERT INTO provider_quota_account_providers(account_id,provider_id) VALUES($1,\'p\')', [account]);
    await db.query(`INSERT INTO request_attempts(id,logical_request_id,provider_id,account_id,started_at,status,capture_status,user_id)
      VALUES($1,$1,'p',$2,$3,'running','unsupported',1)`, [attempt, account, t(1)]);
    await db.query('CREATE TABLE quota_cycle_samples(id UUID PRIMARY KEY)');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await cycle.markAccountDirty(client, account);
      assert.equal((await client.query('SELECT 1 AS ok')).rows[0].ok, 1);
      await client.query('COMMIT');
    } finally { client.release(); }
    await capture.endAttempt(attempt, { status: 'success', ended_at: t(8), total_tokens: 10 }, { pool: db });
    assert.equal((await db.query('SELECT status FROM request_attempts WHERE id=$1', [attempt])).rows[0].status, 'success');
    await db.query('DROP TABLE quota_cycle_samples');
    await cycle.ensureQuotaCycleSchema(db);
    await db.query(`UPDATE request_attempts SET termination_quality=$2::jsonb WHERE id=$1`, [attempt, JSON.stringify({ interrupted: true, end_time_inferred: true, end_time_basis: 'last_owner_heartbeat', secret: 'must-not-preserve' })]);
    for (const [second, percent] of [[0, 0], [10, 100]]) await cycle.processObservation(db, { id: crypto.randomUUID(), account_id: account, provider_id: 'p', observed_at: t(second) }, [{ kind: 'window', unit: 'percent', window_key: '5h', used_percent: percent, resets_at: t(3600) }]);
    await cycle.reconcileCycles(db, { now: t(100) });
    const id = (await cycle.queryQuotaCycles(db, range)).rows[0].id;
    const before = await cycle.queryQuotaCycle(db, id, range);
    assert.equal(before.summary.inferred_terminal, 1);
    assert.equal(before.summary.certain, 0);
    assert.equal(before.summary.candidate, 1);
    assert.equal(before.summary.latency_ms.p50, null);
    const requests = await cycle.queryQuotaRequests(db, id, range);
    assert.deepEqual(requests.rows[0].snapshot.termination_quality, { interrupted: true, end_time_inferred: true, end_time_basis: 'last_owner_heartbeat' });
    const version = before.cycle.version;
    const exported = await cycle.exportQuotaCycle(db, id, { ...range, expected_version: String(version) });
    assert.equal(exported.export.version, version);
    assert.equal(exported.requests.rows[0].snapshot.total_tokens, '10');
    await assert.rejects(cycle.exportQuotaCycle(db, id, { ...range, expected_version: '0' }), error => error.status === 400);
    await assert.rejects(cycle.exportQuotaCycle(db, id, { ...range, cursor: '1' }), error => error.status === 400);
    await capture.endAttempt(attempt, { total_tokens: 20 }, { pool: db });
    await cycle.reconcileCycles(db, { now: t(110) });
    assert.ok((await cycle.queryQuotaCycle(db, id, range)).cycle.version > version);
    await assert.rejects(cycle.exportQuotaCycle(db, id, { ...range, version: String(version) }), error => error.status === 400);
    await assert.rejects(cycle.exportQuotaCycle(db, id, { ...range, expected_version: String(version), cursor: '1' }), error => error.status === 400);
    assert.equal((await cycle.queryQuotaCycle(db, id, { ...range, version: String(version) })).summary.total_tokens, 10);
    await db.query('DELETE FROM request_quota_samples; DELETE FROM quota_capture_jobs; DELETE FROM request_attempts');
    const retained = await cycle.queryQuotaRequests(db, id, range);
    assert.equal(retained.rows[0].snapshot.termination_quality.end_time_inferred, true);
    const summary = (await cycle.queryQuotaCycle(db, id, range)).summary;
    assert.equal(summary.inferred_terminal, 1);
    assert.equal(summary.latency_ms.p99, null);
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  }
});
