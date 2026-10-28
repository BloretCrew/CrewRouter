'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { Client } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const { repairUsageTimestamps } = require('./repair-usage-timestamps');

test('timestamp recovery uses only unique verified copies and preserves other historical data', async context => {
  const cluster = createIsolatedPostgres('usage-repair');
  const client = new Client(cluster.connection);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-usage-repair-evidence-'));
  try {
    await client.connect();
    await cluster.assertIsolation(client);
    await client.query(`SET timezone = 'UTC';
      CREATE TABLE usage_records (id integer PRIMARY KEY, user_id integer, created_at timestamp,
        tokens_used integer, prompt_tokens integer, completion_tokens integer, cached_tokens integer, cost numeric);
      CREATE TABLE usage_message_analysis (id serial PRIMARY KEY, usage_id integer, user_id integer,
        created_at timestamp, analyzed_at timestamp);
      CREATE TABLE request_attempts (id integer PRIMARY KEY, created_at timestamptz);
      INSERT INTO request_attempts VALUES (1, NULL);
      INSERT INTO usage_records SELECT identifier, 10, NULL, -7, 9, 4, 0, 0.12345678 FROM generate_series(1, 12) identifier;
      INSERT INTO usage_message_analysis (usage_id, user_id, created_at, analyzed_at)
        SELECT identifier, 10, TIMESTAMP '2001-01-01 12:00:00.123', TIMESTAMP '2001-01-01 12:00:03'
        FROM generate_series(1, 11) identifier;
      UPDATE usage_records SET created_at = TIMESTAMP '9983-08-29' WHERE id = 2;
      UPDATE usage_records SET created_at = TIMESTAMP '2000-02-01' WHERE id = 3;
      UPDATE usage_records SET created_at = TIMESTAMP '2001-01-01 12:00:00.123456' WHERE id = 4;
      UPDATE usage_message_analysis SET user_id = 11 WHERE usage_id = 5;
      UPDATE usage_message_analysis SET created_at = TIMESTAMP '9983-08-29' WHERE usage_id = 6;
      UPDATE usage_message_analysis SET analyzed_at = TIMESTAMP '2000-01-01' WHERE usage_id = 7;
      INSERT INTO usage_message_analysis SELECT 99, usage_id, user_id, created_at, analyzed_at FROM usage_message_analysis WHERE usage_id = 8;
      UPDATE usage_message_analysis SET created_at = TIMESTAMP '2001-01-01 12:00:00.123456' WHERE usage_id = 9;
      UPDATE usage_records SET user_id = NULL WHERE id = 10;
      UPDATE usage_message_analysis SET analyzed_at = TIMESTAMP '9983-08-29' WHERE usage_id = 11;
    `);
    const snapshot = async () => (await client.query('SELECT row_to_json(record) AS value FROM usage_records record ORDER BY id')).rows;
    const before = await snapshot();

    await context.test('dry-run is read-only and creates no backup directory', async () => {
      const backupDirectory = path.join(directory, 'dry-run');
      const result = await repairUsageTimestamps(client, { backupDirectory });
      assert.equal(result.candidates, 3);
      assert.equal(result.updated, 0);
      assert.deepEqual(await snapshot(), before);
      assert.equal(fs.existsSync(backupDirectory), false);
    });

    await context.test('apply requires a new private backup and fails closed before changing data', async () => {
      await assert.rejects(repairUsageTimestamps(client, { apply: true }), /absolute_new_backup_directory/);
      await assert.rejects(repairUsageTimestamps(client, { apply: true, backupDirectory: directory }), /EEXIST/);
      assert.deepEqual(await snapshot(), before);
    });

    await context.test('a failed later batch rolls back all writes but retains recovery evidence', async () => {
      await client.query(`CREATE FUNCTION reject_repair() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id = 3 THEN RAISE EXCEPTION 'injected_repair_failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_repair BEFORE UPDATE ON usage_records FOR EACH ROW EXECUTE FUNCTION reject_repair()`);
      const backupDirectory = path.join(directory, 'failed');
      await assert.rejects(repairUsageTimestamps(client, { apply: true, backupDirectory, batchSize: 2 }), /injected_repair_failure/);
      assert.deepEqual(await snapshot(), before);
      assert.equal(JSON.parse(fs.readFileSync(path.join(backupDirectory, 'failure.json'))).status, 'rolled_back');
      assert.equal(JSON.parse(fs.readFileSync(path.join(backupDirectory, 'original-values.json'))).repairs.length, 3);
      await client.query('DROP TRIGGER reject_repair ON usage_records');
    });

    await context.test('a silently skipped update also causes a complete rollback', async () => {
      await client.query(`CREATE FUNCTION skip_repair() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id = 3 THEN RETURN NULL; END IF; RETURN NEW; END $$;
        CREATE TRIGGER skip_repair BEFORE UPDATE ON usage_records FOR EACH ROW EXECUTE FUNCTION skip_repair()`);
      await assert.rejects(repairUsageTimestamps(client, { apply: true, backupDirectory: path.join(directory, 'skipped'), batchSize: 2 }), /row_count_mismatch/);
      assert.deepEqual(await snapshot(), before);
      await client.query('DROP TRIGGER skip_repair ON usage_records');
    });

    await context.test('apply restores timestamps atomically, preserves precision and never changes token or billing fields', async () => {
      const backupDirectory = path.join(directory, 'success');
      const result = await repairUsageTimestamps(client, { apply: true, backupDirectory, batchSize: 2 });
      assert.equal(result.updated, 3);
      assert.equal(result.after.usage.negative_tokens, 12);
      assert.equal(result.after.analysis.missing_usage_id, 0);
      const rows = (await client.query('SELECT id, created_at::text AS created_at FROM usage_records ORDER BY id')).rows;
      for (const row of rows.slice(0, 3)) assert.equal(row.created_at, '2001-01-01 12:00:00.123');
      assert.equal(rows[3].created_at, '2001-01-01 12:00:00.123456');
      for (const row of rows.slice(4)) assert.equal(row.created_at, null);
      const omitTime = records => records.map(({ value: { created_at, ...record } }) => record);
      assert.deepEqual(omitTime(await snapshot()), omitTime(before));
      const evidence = fs.readFileSync(path.join(backupDirectory, 'original-values.json'));
      assert.equal(crypto.createHash('sha256').update(evidence).digest('hex'), result.sha256);
      assert.equal(fs.statSync(backupDirectory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(backupDirectory, 'original-values.json')).mode & 0o777, 0o600);
      assert.equal(JSON.parse(evidence).repairs[0].original_created_at, null);
      assert.equal(JSON.parse(fs.readFileSync(path.join(backupDirectory, 'result.json'))).status, 'committed');
      const secondDirectory = path.join(directory, 'idempotent');
      assert.equal((await repairUsageTimestamps(client, { apply: true, backupDirectory: secondDirectory })).updated, 0);
      assert.equal(fs.existsSync(secondDirectory), false);
    });
  } finally {
    try { await client.end(); } finally {
      try { cluster.stop(); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
  }
});
