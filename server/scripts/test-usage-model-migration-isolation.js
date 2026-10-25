'use strict';

// Execute only the extracted migration against a newly initialized Unix-only DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const migrationKey = 'migration_usage_model_id_to_local_id_v1';

function loadMigration(pool) {
  const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const start = source.indexOf('async function migrateUsageModelIdToLocalId()');
  const end = source.indexOf('\n/**', start);
  assert(start > 0 && end > start);
  return vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    pool, Logger: { info() {}, warn() {}, error() {} },
  });
}

function interceptPool(pool, intercept) {
  return {
    async query(sql, params) { return intercept(sql, params, () => pool.query(sql, params)); },
    async connect() {
      const client = await pool.connect();
      return {
        query: (sql, params) => intercept(sql, params, () => client.query(sql, params)),
        release: () => client.release(),
      };
    },
  };
}

test('usage model migration is conservative, atomic and serialized', async t => {
  const cluster = createIsolatedPostgres('usage-model-migration');
  const pid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  const pool = new Pool({ ...cluster.connection, max: 6,
    options: '-c statement_timeout=8000 -c idle_in_transaction_session_timeout=10000' });
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE models(id text PRIMARY KEY, provider text, upstream_model_id text);
      CREATE TABLE usage_records(id int PRIMARY KEY, provider_id text, model_id text);
      CREATE TABLE settings(key text PRIMARY KEY, value text);
      INSERT INTO models VALUES
        ('local-a','p1','remote-a'), ('local-b','p1','local-a'),
        ('dup-a','p1','shared'), ('dup-b','p1','shared'),
        ('other-a','p2','remote-a'), ('other-p1','p1','other-a');`);
    const migrate = loadMigration(pool);
    const reset = async () => {
      await pool.query('TRUNCATE usage_records, settings');
      await pool.query(`INSERT INTO usage_records VALUES
        (1,'p1','local-a'), (2,'p1','remote-a'), (3,'p1','shared'),
        (4,'p1','missing'), (5,NULL,'remote-a'), (6,'p1','other-a')`);
    };
    const models = async () => (await pool.query('SELECT model_id FROM usage_records ORDER BY id')).rows.map(row => row.model_id);
    const original = ['local-a', 'remote-a', 'shared', 'missing', 'remote-a', 'other-a'];
    const expected = ['local-a', 'local-a', 'shared', 'missing', 'remote-a', 'other-p1'];

    await t.test('preserves valid local IDs and ambiguous history; converts only unique provider matches', async () => {
      await reset();
      await migrate();
      assert.deepEqual(await models(), expected);
      const flag = JSON.parse((await pool.query('SELECT value FROM settings WHERE key=$1', [migrationKey])).rows[0].value);
      assert.equal(flag.updated, 2);
      assert.equal(flag.unresolved, 2);
      await migrate();
      assert.deepEqual(await models(), expected, 'repeated startup must not reinterpret a converted local ID');
    });

    await t.test('failure writing the marker rolls back all model rewrites and a retry succeeds once', async () => {
      await reset();
      let failed = false;
      const faulty = loadMigration(interceptPool(pool, async (sql, params, run) => {
        if (!failed && /INSERT INTO settings/.test(sql)) {
          failed = true;
          throw new Error('synthetic marker write failure');
        }
        return run();
      }));
      await assert.rejects(faulty(), /synthetic marker write failure/);
      assert.deepEqual(await models(), original);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM settings')).rows[0].n, 0);
      await migrate();
      assert.deepEqual(await models(), expected);
    });

    await t.test('concurrent startup actually waits on a shared transaction lock and changes history once', async () => {
      await reset();
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const resumed = new Promise(resolve => { release = resolve; });
      let held = false;
      const guarded = loadMigration(interceptPool(pool, async (sql, params, run) => {
        const result = await run();
        if (!held && /pg_advisory_xact_lock/.test(sql)) {
          held = true;
          enter();
          await resumed;
        }
        return result;
      }));
      const first = guarded();
      let timer;
      try {
        await Promise.race([entered, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('migration never acquired its transaction lock')), 3000);
        })]);
      } finally { clearTimeout(timer); }
      const second = migrate();
      let blocked = false;
      try {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const locks = await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted");
          if (locks.rows[0].n) { blocked = true; break; }
        }
      } finally { release(); }
      await Promise.all([first, second]);
      assert(blocked, 'the second real PostgreSQL transaction must wait for the first');
      assert.deepEqual(await models(), expected);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM settings')).rows[0].n, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory'")).rows[0].n, 0);
    });

    await t.test('returned connections have no open transaction', async () => {
      const observer = new Pool({ ...cluster.connection, max: 1 });
      try {
        const result = await observer.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name=$1 AND pid<>pg_backend_pid() AND xact_start IS NOT NULL`,
        [cluster.connection.application_name]);
        assert.equal(result.rows[0].n, 0);
      } finally { await observer.end(); }
    });
  } finally {
    await pool.end();
    cluster.stop();
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    assert.equal(fs.existsSync(cluster.dataDir), false);
    assert.equal(fs.existsSync(cluster.socketDir), false);
  }
});
