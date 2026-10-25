'use strict';

// Only synthetic notification rules in a new Unix-only PostgreSQL cluster.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const { test } = require('node:test');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');

function route(pool) {
  const handlers = new Map();
  const router = { get() {}, put(url, ...fns) { handlers.set(url, fns.at(-1)); } };
  const context = { module: { exports: {} }, require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === '../models/database') return { pool };
    if (name === '../logger') return { error() {} };
    if (name === '../middleware/auth') return { requireAuth() {} };
    if (name === '../utils/request-source') return { HARNESS_SOURCES: ['claude-code', 'codex'] };
    throw new Error(`Unexpected fixture dependency: ${name}`);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/hook-notify-rules.js'), 'utf8'), context);
  return async (body, id = 1) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handlers.get('/hook-notify-rules/selection')({ body, session: { user: { id } } }, res);
    return res;
  };
}

test('notification rule replacement uses an owned transaction and user lock', async t => {
  const cluster = createIsolatedPostgres('hook-rules');
  const pid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  const pool = new Pool({ ...cluster.connection, max: 6,
    options: '-c statement_timeout=8000 -c idle_in_transaction_session_timeout=10000' });
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE users(id int PRIMARY KEY);
      INSERT INTO users VALUES(1),(2);
      CREATE TABLE hook_notify_rules(id serial PRIMARY KEY,user_id int REFERENCES users(id),name text,
        harness text,event_type text,tool_name_pattern text,enabled boolean);
      CREATE FUNCTION reject_fixture_rule() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.harness='codex' AND current_setting('fixture.fail_hook',true)='on'
        THEN RAISE EXCEPTION 'synthetic rule write failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_fixture_rule BEFORE INSERT ON hook_notify_rules FOR EACH ROW EXECUTE FUNCTION reject_fixture_rule()`);
    const reset = () => pool.query("TRUNCATE hook_notify_rules; INSERT INTO hook_notify_rules(user_id,harness,event_type,enabled) VALUES(1,'original','*',true),(2,'other-user','*',true)");
    const rules = async (id = 1) => (await pool.query('SELECT harness,event_type FROM hook_notify_rules WHERE user_id=$1 ORDER BY harness,event_type', [id])).rows;
    const replace = route(pool);

    await t.test('a pool may use different physical connections; failure preserves the complete old selection', async () => {
      await reset();
      const physical = [await pool.connect(), await pool.connect()];
      let next = 0;
      // Rotation is a permitted pool behavior. BEGIN via pool.query cannot own
      // subsequent statements even when a low-load pool happens to reuse one PID.
      const rotating = { query: (sql, params) => physical[next++ % 2].query(sql, params),
        async connect() {
          const client = await pool.connect();
          await client.query("SET fixture.fail_hook='on'");
          return client;
        } };
      try {
        for (const client of physical) await client.query("SET fixture.fail_hook='on'");
        const response = await route(rotating)({ harnesses: ['claude-code', 'codex'], eventTypes: ['session_start'] });
        assert.equal(response.statusCode, 500);
        assert.deepEqual(await rules(), [{ harness: 'original', event_type: '*' }]);
        assert.deepEqual(await rules(2), [{ harness: 'other-user', event_type: '*' }]);
      } finally {
        for (const client of physical) { await client.query('ROLLBACK'); client.release(); }
        // Reset on all used connections, including the checked-out route client.
        const all = await Promise.all(Array.from({ length: 3 }, () => pool.connect()));
        for (const client of all) { await client.query("SET fixture.fail_hook='off'"); client.release(); }
      }
    });

    await t.test('same-user replacements wait for the parent lock and never merge two selections', async () => {
      await reset();
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const resumed = new Promise(resolve => { release = resolve; });
      let paused = false;
      const gated = { query: (...args) => pool.query(...args), async connect() {
        const client = await pool.connect();
        return { release: () => client.release(), async query(sql, params) {
          const result = await client.query(sql, params);
          if (!paused && sql.startsWith('DELETE FROM hook_notify_rules')) {
            paused = true; enter(); await resumed;
          }
          return result;
        } };
      } };
      const first = route(gated)({ harnesses: ['claude-code'], eventTypes: ['session_start'] });
      let timer;
      try {
        await Promise.race([entered, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('replacement did not reach its transaction')), 3000);
        })]);
      } finally { clearTimeout(timer); }
      const second = replace({ harnesses: ['codex'], eventTypes: ['session_end'] });
      let blocked = false;
      try {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0");
          if (result.rows[0].n) { blocked = true; break; }
        }
      } finally { release(); }
      assert.equal((await first).statusCode, 200);
      assert.equal((await second).statusCode, 200);
      assert(blocked, 'the second transaction must really wait for the same user');
      assert.deepEqual(await rules(), [{ harness: 'codex', event_type: 'session_end' }]);
    });

    await t.test('deduplicates selections, preserves wildcard semantics and rejects missing users', async () => {
      const saved = await replace({ harnesses: ['codex', 'codex'], eventTypes: ['tool_use', 'tool_use'] });
      assert.equal(saved.statusCode, 200); assert.equal(saved.body.ruleCount, 1);
      assert.equal((await replace({})).body.ruleCount, 1);
      assert.deepEqual(await rules(), [{ harness: '*', event_type: '*' }]);
      assert.equal((await replace({}, 99)).statusCode, 404);
      assert.deepEqual(await rules(2), [{ harness: 'other-user', event_type: '*' }]);
    });
    const observer = new Pool({ ...cluster.connection, max: 1 });
    try {
      assert.equal((await observer.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name=$1 AND pid<>pg_backend_pid() AND xact_start IS NOT NULL`,
      [cluster.connection.application_name])).rows[0].n, 0);
    } finally { await observer.end(); }
  } finally {
    await pool.end(); cluster.stop();
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    assert.equal(fs.existsSync(cluster.dataDir), false);
    assert.equal(fs.existsSync(cluster.socketDir), false);
  }
});
