'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');

async function waitForLock(pool, pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected a real PostgreSQL lock wait');
}

(async () => {
  const cluster = createIsolatedPostgres('prompt-seed');
  const pool = new Pool(cluster.connection);
  const postmasterPid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  let blocker;
  let waiter;
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE inject_prompts (id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, content TEXT NOT NULL, enabled BOOLEAN NOT NULL, sort_order INTEGER NOT NULL);
      INSERT INTO users VALUES (1), (2), (3), (4), (5)`);
    const context = vm.createContext({ module: { exports: {} }, Buffer, Date,
      require(name) {
        if (name === '../logger') return { info() {}, warn() {} };
        assert.equal(name, '../models/database');
        return { pool };
      } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../utils/inject-prompt.js'), 'utf8'), context);
    const { seedDefaultPrompt: seed } = context.module.exports;
    // Reproduce the old SELECT/INSERT race against actual PostgreSQL: both
    // readers observe empty, and the schema accepts both default rows.
    const readers = await Promise.all([pool.query('SELECT 1 FROM inject_prompts WHERE user_id=5'),
      pool.query('SELECT 1 FROM inject_prompts WHERE user_id=5')]);
    assert.ok(readers.every(result => result.rowCount === 0));
    await Promise.all([1, 2].map(() => pool.query("INSERT INTO inject_prompts(user_id,name,content,enabled,sort_order) VALUES (5,'old','old',TRUE,-10)")));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM inject_prompts WHERE user_id=5')).rows[0].n, 2);

    blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id=1 FOR NO KEY UPDATE');
    waiter = await pool.connect();
    const pid = (await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await waiter.query('BEGIN');
    const pending = seed(1, waiter);
    await waitForLock(pool, pid);
    // Existing transaction ownership is preserved, including rollback behavior.
    await seed(1, blocker);
    await blocker.query('COMMIT');
    await pending;
    await waiter.query('COMMIT');
    waiter.release();
    waiter = null;
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM inject_prompts WHERE user_id=1')).rows[0].n, 1);
    await Promise.all(Array.from({ length: 8 }, () => seed(2)));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM inject_prompts WHERE user_id=2')).rows[0].n, 1);
    await blocker.query('BEGIN');
    await seed(3, blocker);
    await blocker.query('ROLLBACK');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM inject_prompts WHERE user_id=3')).rows[0].n, 0);
    // A failed INSERT must roll back and return a usable, unlocked connection.
    await pool.query('ALTER TABLE inject_prompts ADD CONSTRAINT seed_failure CHECK (user_id <> 3)');
    await assert.rejects(seed(3), /seed_failure/);
    await pool.query('ALTER TABLE inject_prompts DROP CONSTRAINT seed_failure');
    await seed(3);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM inject_prompts WHERE user_id=3')).rows[0].n, 1);
    // A deleting parent serializes before initialization; no orphan or deadlock.
    await blocker.query('BEGIN');
    await blocker.query('DELETE FROM users WHERE id=4');
    const deleted = seed(4);
    await blocker.query('COMMIT');
    await deleted;
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM inject_prompts WHERE user_id=4')).rows[0].n, 0);
    // Existing disabled/custom entries prevent re-seeding; deleting all still
    // retains the established automatic default behavior.
    await pool.query("UPDATE inject_prompts SET enabled=FALSE, content='custom' WHERE user_id=2");
    await seed(2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM inject_prompts WHERE user_id=2')).rows[0].n, 1);
    await pool.query('DELETE FROM inject_prompts WHERE user_id=2');
    await seed(2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM inject_prompts WHERE user_id=2')).rows[0].n, 1);
    // Execute the exact setup/admin seeding block, using a pool with only one
    // connection. A fresh user is visible only through the enclosing client.
    const setupSource = fs.readFileSync(path.join(__dirname, '../routes/setup.js'), 'utf8');
    const start = setupSource.indexOf('    // 播种使用当前事务');
    const end = setupSource.indexOf('    // 分配默认 Team', start);
    assert.ok(start >= 0 && end > start);
    const runSetupSeed = vm.runInNewContext(`(async function(client, adminId) {${setupSource.slice(start, end)}})`, {
      require(name) { assert.equal(name, '../utils/inject-prompt'); return { seedDefaultPrompt: seed }; },
      Logger: { warn() {} },
    });
    const singlePool = new Pool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1000 });
    const setupClient = await singlePool.connect();
    try {
      await setupClient.query('BEGIN');
      await setupClient.query('INSERT INTO users VALUES (6)');
      await runSetupSeed(setupClient, 6);
      assert.equal((await setupClient.query('SELECT count(*)::int AS n FROM inject_prompts WHERE user_id=6')).rows[0].n, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE id=6')).rows[0].n, 0);
      await setupClient.query('ROLLBACK');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE id=6')).rows[0].n, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM inject_prompts WHERE user_id=6')).rows[0].n, 0);
      await setupClient.query('ALTER TABLE inject_prompts ADD CONSTRAINT setup_seed_failure CHECK (user_id <> 7)');
      await setupClient.query('BEGIN');
      await setupClient.query('INSERT INTO users VALUES (7)');
      await runSetupSeed(setupClient, 7);
      // The savepoint recovers the failed INSERT without poisoning OOBE.
      assert.equal((await setupClient.query('SELECT count(*)::int AS n FROM inject_prompts WHERE user_id=7')).rows[0].n, 0);
      await setupClient.query('INSERT INTO users VALUES (8)');
      await setupClient.query('COMMIT');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE id IN (7,8)')).rows[0].n, 2);
      await setupClient.query('ALTER TABLE inject_prompts DROP CONSTRAINT setup_seed_failure');
    } finally {
      await setupClient.query('ROLLBACK').catch(() => {});
      setupClient.release();
      await singlePool.end();
    }
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state LIKE 'idle in transaction%'")).rows[0].n, 0);
    console.log('PASS isolated PostgreSQL prompt seeding: old duplicate reproduction, lock waiting, concurrent creation, caller/owned rollback, parent delete, re-seed semantics');
  } finally {
    if (blocker) { await blocker.query('ROLLBACK').catch(() => {}); blocker.release(); }
    if (waiter) { await waiter.query('ROLLBACK').catch(() => {}); waiter.release(); }
    await pool.end();
    cluster.stop();
    assert.throws(() => process.kill(postmasterPid, 0), { code: 'ESRCH' }, 'temporary postmaster PID must exit');
    assert.equal(fs.existsSync(cluster.dataDir), false);
    assert.equal(fs.existsSync(cluster.socketDir), false);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
