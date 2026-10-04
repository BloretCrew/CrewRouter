'use strict';

const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { ensureUsageModelIdentityColumns } = require('../utils/usage-model-migration');

async function main() {
  const port = Number(process.env.MODEL_TEST_PG_PORT);
  if (!port || port === 5432) throw new Error('Specify MODEL_TEST_PG_PORT for a disposable local PostgreSQL instance.');
  const pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
  const client = await pool.connect();
  const blocker = await pool.connect();
  try {
    // Temporary tables keep tests away from any persistent application data.
    await client.query('CREATE TEMP TABLE usage_records (id SERIAL PRIMARY KEY, cost NUMERIC, response TEXT)');
    await client.query("INSERT INTO usage_records(cost,response) VALUES (0.123456,'historical')");
    for (let i = 0; i < 2; i++) {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1234ms'");
      await client.query("SET LOCAL statement_timeout = '2345ms'");
      await ensureUsageModelIdentityColumns(client);
      const settings = await client.query("SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s");
      assert.equal(settings.rows[0].l, '1234ms');
      assert.equal(settings.rows[0].s, '2345ms');
      await client.query('COMMIT');
    }
    const historical = await client.query('SELECT * FROM usage_records WHERE id=1');
    for (const field of ['requested_model', 'resolved_model', 'response_model']) assert.equal(historical.rows[0][field], null);
    assert.equal(historical.rows[0].cost, '0.123456');
    const saved = await client.query('INSERT INTO usage_records(requested_model,resolved_model,response_model,cost) VALUES($1,$2,$3,$4) RETURNING *', ['alias', 'route', 'served', '0.000001']);
    assert.equal(saved.rows[0].response_model, 'served');
    assert.equal(saved.rows[0].cost, '0.000001');

    // A blocker on the temp table exercises the real migration lock timeout.
    const oid = (await client.query("SELECT 'usage_records'::regclass::oid AS oid")).rows[0].oid;
    const qualified = (await client.query('SELECT quote_ident(n.nspname)||\'.\'||quote_ident(c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=$1', [oid])).rows[0].name;
    await client.query('ALTER TABLE usage_records DROP COLUMN response_model');
    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE ${qualified} IN ACCESS SHARE MODE`);
    await client.query('BEGIN');
    const started = Date.now();
    await assert.rejects(ensureUsageModelIdentityColumns(client), error => error.code === '55P03');
    assert.ok(Date.now() - started < 25000, 'migration lock wait must be bounded');
    await client.query('ROLLBACK');
    await blocker.query('ROLLBACK');
    await client.query('BEGIN');
    await ensureUsageModelIdentityColumns(client);
    await client.query('COMMIT');
    console.log('PASS PostgreSQL model identity: migration twice, nullable history, precise costs, insertion, restored settings, bounded lock wait and recovery.');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await blocker.query('ROLLBACK').catch(() => {});
    client.release(); blocker.release();
    await pool.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
