'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Client } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const { ensureUsageWriteGuards } = require('../utils/usage-write-guards');

test('write guards reject new invalid data without rewriting or blocking untouched historical fields', async () => {
  const cluster = createIsolatedPostgres('usage-write');
  const client = new Client(cluster.connection);
  try {
    await client.connect();
    await cluster.assertIsolation(client);
    await client.query(`CREATE SCHEMA "usage-test"; SET search_path = "usage-test"; SET timezone = 'UTC';
      CREATE TABLE usage_records (
        id SERIAL PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        tokens_used INTEGER DEFAULT 0, prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0, weighted_tokens BIGINT DEFAULT 0, cost NUMERIC DEFAULT 0,
        user_id INTEGER, request_source TEXT, messages JSONB
      );
      CREATE TABLE usage_message_analysis (
        usage_id INTEGER REFERENCES usage_records(id), created_at TIMESTAMP, tokens_used BIGINT DEFAULT 0, cost NUMERIC DEFAULT 0
      );
      CREATE TABLE request_attempts (
        logical_request_id UUID, started_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), status TEXT,
        provider_id TEXT, capture_status TEXT, input_tokens NUMERIC, output_tokens NUMERIC,
        cache_read_tokens NUMERIC, cache_creation_tokens NUMERIC, total_tokens NUMERIC,
        weighted_tokens NUMERIC, points NUMERIC
      );
      INSERT INTO usage_records(created_at, tokens_used, messages) VALUES(NULL, -7, '[]');
      INSERT INTO usage_records(created_at, messages) VALUES(TIMESTAMP '9983-08-29', '[]');
      INSERT INTO usage_message_analysis(usage_id, created_at, tokens_used) VALUES(NULL, NULL, -7);
      INSERT INTO request_attempts(status) VALUES(NULL);
    `);
    const snapshot = async () => (await client.query(`SELECT 'usage' AS kind, row_to_json(record)::text AS value FROM usage_records record
      UNION ALL SELECT 'analysis', row_to_json(record)::text FROM usage_message_analysis record
      UNION ALL SELECT 'attempt', row_to_json(record)::text FROM request_attempts record ORDER BY kind, value`)).rows;
    const before = await snapshot();
    await ensureUsageWriteGuards(client);
    await ensureUsageWriteGuards(client);
    assert.deepEqual(await snapshot(), before);

    const inserted = await client.query(`INSERT INTO usage_records(created_at, tokens_used) VALUES(NULL, 12) RETURNING id,
      abs(extract(epoch FROM (created_at - (statement_timestamp() AT TIME ZONE 'Asia/Shanghai')))) < 5 AS current_time`);
    assert.equal(inserted.rows[0].current_time, true);
    const usageId = inserted.rows[0].id;
    await client.query("UPDATE usage_records SET messages='[]' WHERE id=$1", [usageId]);
    const analysisSource = fs.readFileSync(path.resolve(__dirname, '../utils/message-analysis-store.js'), 'utf8');
    const pendingQuery = analysisSource.match(/`(SELECT ur\.id[\s\S]*?LIMIT \$1)`/);
    assert(pendingQuery);
    assert.deepEqual((await client.query(pendingQuery[1], [50])).rows.map(row => row.id), [usageId]);
    const implicit = await client.query(`INSERT INTO usage_records DEFAULT VALUES RETURNING
      abs(extract(epoch FROM (created_at - (statement_timestamp() AT TIME ZONE 'Asia/Shanghai')))) < 5 AS current_time`);
    assert.equal(implicit.rows[0].current_time, true);
    const rejected = async (sql, values) => assert.rejects(client.query(sql, values), error => error.code === '23514');
    for (const column of ['tokens_used', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'weighted_tokens', 'cost']) {
      await rejected(`INSERT INTO usage_records(${column}) VALUES(-1)`);
      await rejected(`UPDATE usage_records SET ${column}=-1 WHERE id=$1`, [usageId]);
    }
    for (const timestamp of ['0947-06-28', '9983-08-29', 'infinity', '-infinity']) {
      await rejected('INSERT INTO usage_records(created_at) VALUES($1)', [timestamp]);
    }
    await rejected("INSERT INTO usage_records(created_at) VALUES((statement_timestamp() AT TIME ZONE 'Asia/Shanghai') + INTERVAL '6 minutes')");
    await rejected('UPDATE usage_records SET created_at=NULL WHERE id=$1', [usageId]);
    await rejected("INSERT INTO usage_records(cost) VALUES('NaN')");
    await client.query('UPDATE usage_records SET cost=1 WHERE id=1');
    assert.equal((await client.query('SELECT tokens_used FROM usage_records WHERE id=1')).rows[0].tokens_used, -7);

    await rejected("INSERT INTO usage_message_analysis(created_at) VALUES(TIMESTAMP '2026-01-01')");
    await rejected('INSERT INTO usage_message_analysis(usage_id) VALUES($1)', [usageId]);
    await rejected("INSERT INTO usage_message_analysis(usage_id, created_at, tokens_used) VALUES($1, TIMESTAMP '2026-01-01', -1)", [usageId]);
    await client.query("INSERT INTO usage_message_analysis(usage_id, created_at) VALUES($1, TIMESTAMP '2026-01-01')", [usageId]);

    const attemptSql = `INSERT INTO request_attempts(logical_request_id, started_at, status, provider_id, capture_status)
      VALUES($1, $2, $3, $4, $5)`;
    const validAttempt = ['c3aa4535-5ab0-49d1-9e1d-a31d3a53f564', new Date(), 'running', 'provider', 'pending'];
    for (const index of [0, 1, 2, 3, 4]) {
      const invalid = [...validAttempt];
      invalid[index] = null;
      await rejected(attemptSql, invalid);
    }
    await client.query(attemptSql, validAttempt);
    await rejected('UPDATE request_attempts SET input_tokens=-1 WHERE logical_request_id=$1', [validAttempt[0]]);
    await rejected("UPDATE request_attempts SET points='NaN' WHERE logical_request_id=$1", [validAttempt[0]]);

    await client.query('BEGIN');
    await client.query('UPDATE usage_records SET cost=9 WHERE id=1');
    await rejected('INSERT INTO usage_records(tokens_used) VALUES(-1)');
    await client.query('ROLLBACK');
    assert.equal(Number((await client.query('SELECT cost FROM usage_records WHERE id=1')).rows[0].cost), 1);
  } finally {
    try { await client.end(); } finally { cluster.stop(); }
  }
});

test('startup installs guards after historical migrations and before accepting requests', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
  const migration = source.slice(source.indexOf('async function runPendingMigrations()'), source.indexOf('function isRetryableStartupDbError'));
  assert(migration.indexOf('ensureUsageWriteGuards(pool)') > migration.indexOf('importLegacyQuotaHistory(pool)'));
  assert(migration.indexOf('ensureUsageWriteGuards(pool)') < migration.indexOf("Logger.info('[启动] 数据库迁移完成')"));
});

test('missing guard target tables prevent startup instead of silently skipping protection', async () => {
  await assert.rejects(ensureUsageWriteGuards({ async query() { return { rows: [] }; } }), /usage_write_guard_tables_missing/);
});
