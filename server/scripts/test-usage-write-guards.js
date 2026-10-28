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
        usage_id INTEGER REFERENCES usage_records(id), created_at TIMESTAMP, analyzed_at TIMESTAMP DEFAULT NOW(),
        request_source TEXT DEFAULT 'unknown', message_count INTEGER DEFAULT 0, total_characters INTEGER DEFAULT 0,
        total_lines INTEGER DEFAULT 0, metadata_message_count INTEGER DEFAULT 0,
        has_workspace_path BOOLEAN DEFAULT FALSE, has_git_status BOOLEAN DEFAULT FALSE,
        has_project_layout BOOLEAN DEFAULT FALSE, has_environment_context BOOLEAN DEFAULT FALSE,
        block_counts JSONB DEFAULT '{}', observed_fields JSONB DEFAULT '{}', "values" JSONB DEFAULT '{}',
        tokens_used BIGINT DEFAULT 0, cost NUMERIC DEFAULT 0
      );
      CREATE TABLE request_attempts (
        logical_request_id UUID, started_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), status TEXT,
        provider_id TEXT, capture_status TEXT, input_tokens NUMERIC, output_tokens NUMERIC,
        cache_read_tokens NUMERIC, cache_creation_tokens NUMERIC, total_tokens NUMERIC,
        weighted_tokens NUMERIC, points NUMERIC, streaming BOOLEAN DEFAULT FALSE, usage_quality TEXT DEFAULT 'unknown'
      );
      INSERT INTO usage_records(created_at, tokens_used, messages) VALUES(NULL, -7, '[]');
      INSERT INTO usage_records(created_at, messages) VALUES(TIMESTAMP '9983-08-29', '[]');
      INSERT INTO usage_message_analysis(usage_id, created_at, tokens_used) VALUES(NULL, NULL, -7);
      INSERT INTO request_attempts(status, created_at, streaming, usage_quality) VALUES(NULL, NULL, NULL, NULL);
    `);
    const snapshot = async () => (await client.query(`SELECT 'usage' AS kind, row_to_json(record)::text AS value FROM usage_records record
      UNION ALL SELECT 'analysis', row_to_json(record)::text FROM usage_message_analysis record
      UNION ALL SELECT 'attempt', row_to_json(record)::text FROM request_attempts record ORDER BY kind, value`)).rows;
    const before = await snapshot();
    const repairs = await ensureUsageWriteGuards(client);
    assert(repairs.find(repair => repair.table === 'usage_message_analysis').restored.includes('analyzed_at'));
    assert(repairs.find(repair => repair.table === 'usage_message_analysis').retainedNullable.some(column => column.column === 'usage_id' && column.nullRows === 1));
    assert(repairs.find(repair => repair.table === 'request_attempts').retainedNullable.some(column => column.column === 'streaming' && column.nullRows === 1));
    assert((await ensureUsageWriteGuards(client)).every(repair => repair.restored.length === 0));
    assert.deepEqual(await snapshot(), before);
    assert.equal((await client.query(`SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='usage-test' AND table_name='usage_message_analysis' AND column_name='analyzed_at'`)).rows[0].is_nullable, 'NO');

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
    await client.query(`INSERT INTO usage_records(tokens_used, prompt_tokens, completion_tokens, cached_tokens, weighted_tokens, cost)
      VALUES(NULL, NULL, NULL, NULL, NULL, NULL)`);
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
    assert.equal((await client.query(`SELECT abs(extract(epoch FROM
      (analyzed_at - (statement_timestamp() AT TIME ZONE 'Asia/Shanghai')))) < 5 AS correct_time
      FROM usage_message_analysis WHERE usage_id=$1`, [usageId])).rows[0].correct_time, true);
    for (const column of ['analyzed_at', 'request_source', 'message_count', 'total_characters', 'total_lines',
      'metadata_message_count', 'has_workspace_path', 'has_git_status', 'has_project_layout',
      'has_environment_context', 'block_counts', 'observed_fields', 'values', 'tokens_used', 'cost']) {
      await rejected(`UPDATE usage_message_analysis SET "${column}"=NULL WHERE usage_id=$1`, [usageId]);
    }
    for (const column of ['message_count', 'total_characters', 'total_lines', 'metadata_message_count']) {
      await rejected(`UPDATE usage_message_analysis SET ${column}=-1 WHERE usage_id=$1`, [usageId]);
    }
    await client.query('UPDATE usage_message_analysis SET cost=1 WHERE usage_id IS NULL');
    assert.equal((await client.query('SELECT tokens_used FROM usage_message_analysis WHERE usage_id IS NULL')).rows[0].tokens_used, '-7');

    const attemptSql = `INSERT INTO request_attempts(logical_request_id, started_at, status, provider_id, capture_status)
      VALUES($1, $2, $3, $4, $5)`;
    const validAttempt = ['c3aa4535-5ab0-49d1-9e1d-a31d3a53f564', new Date(), 'running', 'provider', 'pending'];
    for (const index of [0, 1, 2, 3, 4]) {
      const invalid = [...validAttempt];
      invalid[index] = null;
      await rejected(attemptSql, invalid);
    }
    await client.query(attemptSql, validAttempt);
    await rejected('UPDATE request_attempts SET streaming=NULL WHERE logical_request_id=$1', [validAttempt[0]]);
    await rejected('UPDATE request_attempts SET usage_quality=NULL WHERE logical_request_id=$1', [validAttempt[0]]);
    await rejected("UPDATE request_attempts SET usage_quality='invalid' WHERE logical_request_id=$1", [validAttempt[0]]);
    await rejected('UPDATE request_attempts SET input_tokens=-1 WHERE logical_request_id=$1', [validAttempt[0]]);
    await rejected("UPDATE request_attempts SET points='NaN' WHERE logical_request_id=$1", [validAttempt[0]]);

    await client.query('BEGIN');
    await client.query('UPDATE usage_records SET cost=9 WHERE id=1');
    await rejected('INSERT INTO usage_records(tokens_used) VALUES(-1)');
    await client.query('ROLLBACK');
    assert.equal(Number((await client.query('SELECT cost FROM usage_records WHERE id=1')).rows[0].cost), 1);

    const definitions = async () => (await client.query(`SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc
      WHERE pronamespace='"usage-test"'::regnamespace AND proname LIKE 'crewrouter_guard_%' ORDER BY proname`)).rows;
    const definitionsBefore = await definitions();
    await client.query('BEGIN');
    await client.query('ALTER TABLE usage_message_analysis DROP COLUMN block_counts');
    await assert.rejects(ensureUsageWriteGuards(client), /usage_write_guard_columns_missing/);
    await client.query('ROLLBACK');
    assert.deepEqual(await definitions(), definitionsBefore);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema='usage-test' AND table_name='usage_message_analysis' AND column_name='block_counts'`)).rows[0].count, 1);
  } finally {
    try { await client.end(); } finally { cluster.stop(); }
  }
});

test('startup installs guards after historical migrations and before accepting requests', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
  const migration = source.slice(source.indexOf('async function runPendingMigrations()'), source.indexOf('function isRetryableStartupDbError'));
  assert(migration.indexOf('ensureUsageWriteGuards(writeGuardClient)') > migration.indexOf('importLegacyQuotaHistory(pool)'));
  assert(migration.indexOf('ensureUsageWriteGuards(writeGuardClient)') < migration.indexOf("Logger.info('[启动] 数据库迁移完成')"));
  const installation = migration.slice(migration.indexOf('const writeGuardClient = await pool.connect()'));
  assert(installation.indexOf("writeGuardClient.query('BEGIN')") < installation.indexOf('ensureUsageWriteGuards(writeGuardClient)'));
  assert(installation.indexOf("writeGuardClient.query('COMMIT')") > installation.indexOf('ensureUsageWriteGuards(writeGuardClient)'));
  assert(installation.includes("writeGuardClient.query('ROLLBACK')"));
  assert(installation.includes('writeGuardClient.release()'));
});

test('missing guard target tables prevent startup instead of silently skipping protection', async () => {
  await assert.rejects(ensureUsageWriteGuards({ async query() { return { rows: [] }; } }), /usage_write_guard_tables_missing/);
});
