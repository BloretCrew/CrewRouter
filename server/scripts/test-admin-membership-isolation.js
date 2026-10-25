'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function main() {
  const cluster = createIsolatedPostgres('admin-membership');
  const pid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  const pool = new Pool({ ...cluster.connection, max: 5 });
  const firstLocked = deferred();
  const continueFirst = deferred();
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE teams(id INTEGER PRIMARY KEY);
      INSERT INTO teams VALUES(1);
      CREATE TABLE users(id INTEGER PRIMARY KEY, is_admin BOOLEAN NOT NULL,
        team_id INTEGER REFERENCES teams(id), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO users(id,is_admin) VALUES(1,true),(2,true)`);
    const histories = [];
    const backendPids = [];
    let locks = 0;
    const fixturePool = { async connect() {
      const client = await pool.connect();
      backendPids.push(client.processID);
      const history = [];
      histories.push(history);
      return {
        async query(sql, params) {
          history.push(sql);
          const result = await client.query(sql, params);
          if (sql.startsWith('SELECT pg_advisory_xact_lock') && ++locks === 1) {
            firstLocked.resolve();
            await continueFirst.promise;
          }
          return result;
        },
        release() { client.release(); },
      };
    } };
    // Execute the current route body without importing app config, middleware,
    // logger, authentication, database modules or application startup code.
    const source = fs.readFileSync(path.resolve(__dirname, '../routes/admin.js'), 'utf8');
    const start = source.indexOf('async (req, res) => {', source.indexOf("router.put('/users/:id'"));
    const end = source.indexOf('\n});\n\n// 管理员退款', start);
    assert(start > 0 && end > start);
    const handler = vm.runInNewContext(`(${source.slice(start, end + 2)})`, {
      pool: fixturePool, isUniqueViolation: () => false, Logger: { error() {} },
      require(name) {
        if (name === './api') return { invalidateUserApiKeyCache() {} };
        if (name === '../utils/team-membership') return { async setUserTeam() {} };
        throw new Error(`Unexpected isolated route dependency: ${name}`);
      },
    });
    async function call(id) {
      const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await handler({ params: { id: String(id) }, body: { isAdmin: false, team_id: 1 } }, response);
      return response;
    }
    const first = call(1);
    let lockTimer;
    try {
      await Promise.race([firstLocked.promise, new Promise((_, reject) => {
        lockTimer = setTimeout(() => reject(new Error('First demotion failed to acquire administrator lock')), 3000);
      })]);
    } finally { clearTimeout(lockTimer); }
    const second = call(2);
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting = await pool.query("SELECT COUNT(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted");
      if (waiting.rows[0].count > 0) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    continueFirst.resolve();
    const results = await Promise.all([first, second]);
    assert(blocked, 'the second request must wait on the same real PostgreSQL advisory lock');
    assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 400]);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM users WHERE is_admin')).rows[0].count, 1);
    for (const history of histories) {
      const advisory = history.findIndex(sql => sql.startsWith('SELECT pg_advisory_xact_lock'));
      const team = history.findIndex(sql => sql.startsWith('SELECT id FROM teams'));
      const user = history.findIndex(sql => sql.startsWith('SELECT id, is_admin FROM users'));
      assert(advisory >= 0 && advisory < team && team < user, 'lock order must remain administrator set, Team, User');
    }
    assert.equal((await call(2)).statusCode, 400, 'the remaining administrator cannot be demoted');
    const lockCount = await pool.query("SELECT COUNT(*)::int AS count FROM pg_locks WHERE locktype='advisory'");
    assert.equal(lockCount.rows[0].count, 0, 'commit and rejection rollback must release transaction locks');
    // A separate physical connection observes every handler connection, even
    // if the regular pool would reuse a connection with a leaked transaction.
    const observer = new Pool({ ...cluster.connection, max: 1 });
    try {
      const connections = await observer.query('SELECT state, xact_start FROM pg_stat_activity WHERE pid=ANY($1::int[])', [backendPids]);
      assert.equal(connections.rows.length, new Set(backendPids).size);
      for (const connection of connections.rows) {
        assert.equal(connection.state, 'idle');
        assert.equal(connection.xact_start, null, 'returned connections must have no active transaction');
      }
    } finally { await observer.end(); }
    console.log('Administrator membership isolation: concurrent demotions preserve one administrator; lock order, release and rejected-transaction cleanup passed');
  } finally {
    continueFirst.resolve();
    try { await pool.end(); }
    finally {
      cluster.stop();
      assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
      assert.equal(fs.existsSync(cluster.dataDir), false);
      assert.equal(fs.existsSync(cluster.socketDir), false);
      console.log('Administrator membership isolation: pool closed, postmaster gone and temporary directories removed');
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
