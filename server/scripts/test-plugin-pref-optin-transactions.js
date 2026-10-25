'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');

function loadRoute(pool, onResponse = () => {}) {
  const handlers = new Map();
  const router = {};
  for (const method of ['get', 'put']) router[method] = (url, ...callbacks) => handlers.set(method, callbacks.at(-1));
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../routes/plugin-pref-optin.js'), 'utf8'), {
    module: { exports: {} },
    require(id) {
      if (id === 'express') return { Router: () => router };
      if (id === '../models/database') return { pool };
      if (id === '../middleware/auth') return { requireAuth() {} };
      if (id === '../logger') return { error() {} };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return async (method, userId, enabled) => {
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { onResponse(value); this.body = value; } };
    await handlers.get(method)({ session: { user: { id: userId } }, body: { enabled } }, res);
    return res;
  };
}
function gate() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await waiting; } };
}
function instrument(pool, afterQuery) {
  return { query: (...args) => pool.query(...args), async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), async query(sql, args) {
      const result = await client.query(sql, args);
      await afterQuery(client, sql, args);
      return result;
    } };
  } };
}
async function observeLockWait(pool) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0");
    if (result.rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected real PostgreSQL Lock waiting');
}

async function main() {
  const cluster = createIsolatedPostgres('plugin-optin');
  const pool = new Pool({ ...cluster.connection, max: 5, options: '-c statement_timeout=8000 -c idle_in_transaction_session_timeout=10000' });
  try {
    await cluster.assertIsolation(pool);
    await pool.query('CREATE TABLE settings(key text PRIMARY KEY,value jsonb,updated_at timestamp DEFAULT now())');
    const route = loadRoute(pool);
    const storedUsers = async () => ((await pool.query("SELECT value FROM settings WHERE key='plugin_pref_optin'")).rows[0]?.value.users || []).sort((a, b) => a - b);
    assert.equal((await route('get', 7)).body.optedIn, false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM settings')).rows[0].n, 0);
    console.log('PASS reading absent opt-in settings does not create consent');

    // First-ever writers compete on the newly seeded unique settings row.
    const firstGate = gate();
    let paused = false;
    const firstRoute = loadRoute(instrument(pool, async (_client, sql) => {
      if (!paused && sql.endsWith('FOR UPDATE')) { paused = true; await firstGate.wait(); }
    }));
    const first = firstRoute('put', 7, true);
    await firstGate.entered;
    const second = route('put', 8, true);
    await observeLockWait(pool);
    firstGate.release();
    assert.equal((await first).statusCode, 200);
    assert.equal((await second).statusCode, 200);
    assert.deepEqual(await storedUsers(), [7, 8]);
    console.log('PASS absent-row concurrent grants wait on a real lock and retain both users');

    for (const withdrawFirst of [false, true]) {
      await pool.query("UPDATE settings SET value=' {\"users\":[7]}'::jsonb WHERE key='plugin_pref_optin'");
      const barrier = gate();
      let held = false;
      const delayed = loadRoute(instrument(pool, async (_client, sql) => {
        if (!held && sql.endsWith('FOR UPDATE')) { held = true; await barrier.wait(); }
      }));
      const a = delayed('put', withdrawFirst ? 7 : 8, !withdrawFirst);
      await barrier.entered;
      const b = route('put', withdrawFirst ? 8 : 7, withdrawFirst);
      await observeLockWait(pool);
      barrier.release();
      assert.equal((await a).statusCode, 200);
      assert.equal((await b).statusCode, 200);
      assert.deepEqual(await storedUsers(), [8]);
      assert.equal((await route('get', 7)).body.optedIn, false);
      assert.equal((await route('get', 8)).body.optedIn, true);
    }
    console.log('PASS grant/withdrawal races in either order cannot restore another user consent');

    const failing = loadRoute(instrument(pool, async (client, sql) => {
      if (sql.startsWith('UPDATE settings')) await client.query('SELECT 1/0');
    }));
    assert.equal((await failing('put', 7, true)).statusCode, 500);
    assert.deepEqual(await storedUsers(), [8]);
    await pool.query('DELETE FROM settings');
    assert.equal((await failing('put', 7, true)).statusCode, 500);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM settings')).rows[0].n, 0);
    console.log('PASS failures roll back both existing consent and newly seeded rows');

    let committed = false;
    const observed = loadRoute(instrument(pool, async (_client, sql) => {
      if (sql === 'COMMIT') committed = true;
    }), () => { assert.equal(committed, true); });
    const saved = await observed('put', '7', true);
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.success, true);
    assert.equal(saved.body.optedIn, true);
    assert.deepEqual(await storedUsers(), [7]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n, 0);
    console.log('PASS responses follow COMMIT, string session IDs remain compatible, and no transaction leaks');
  } finally {
    await pool.end();
    const pid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
    cluster.stop();
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    assert.equal(fs.existsSync(cluster.dataDir), false);
    assert.equal(fs.existsSync(cluster.socketDir), false);
    console.log('PASS isolated PostgreSQL PID, data and socket directories are gone');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
