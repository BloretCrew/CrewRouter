'use strict';
// Execute source-extracted startup functions only, never server initialization,
// deployment configuration, application database modules or real business data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { Pool } = require('pg');
const membership = require('../utils/team-membership');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
function load(pool) {
  const context = { pool, Logger: { info() {}, error() {} }, require(name) {
    assert.equal(name, './utils/team-membership'); return membership;
  } };
  vm.createContext(context);
  for (const [name, ending] of [['migrateUtcWallTimestampsToShanghai', '\n/**'], ['ensureReservedResources', '\n// 为 providers 添加 quota_script']]) {
    const start = source.indexOf('async function ' + name + '()');
    assert(start >= 0);
    vm.runInContext(source.slice(start, source.indexOf(ending, start)), context);
  }
  return context;
}
function intercept(pool, before) {
  return { query: (...args) => pool.query(...args), async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), async query(sql, args) {
      await before(sql, args);
      return client.query(sql, args);
    } };
  } };
}
function gate() {
  let enter, release;
  const reached = new Promise(resolve => { enter = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  return { reached, release, async pause() { enter(); await resumed; } };
}
async function waiting(pool, fragment) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if ((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND position($1 in query)>0", [fragment])).rows[0].n > 0) return;
  }
  assert.fail('expected isolated lock wait');
}
test('启动数据迁移真实 PostgreSQL 原子性、并发及清理', async t => {
  const cluster = createIsolatedPostgres('startup-migrations');
  const pid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  const pool = new Pool({ ...cluster.connection, max: 8, options: '-c statement_timeout=8000 -c idle_in_transaction_session_timeout=10000' });
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE settings(key text PRIMARY KEY,value jsonb);
      CREATE TABLE usage_records(id int PRIMARY KEY,created_at timestamp);
      CREATE TABLE fusion_usage_records(id int PRIMARY KEY,created_at timestamp);
      INSERT INTO usage_records VALUES(1,'2026-01-01 00:00:00');
      INSERT INTO fusion_usage_records VALUES(1,'2026-01-01 00:00:00');
      CREATE TABLE api_keys(id int,is_system boolean);
      CREATE TABLE teams(id serial PRIMARY KEY,name text UNIQUE,description text,is_personal boolean);
      CREATE TABLE users(id int PRIMARY KEY,username text,team_id int REFERENCES teams(id),updated_at timestamp);
      CREATE TABLE user_teams(user_id int REFERENCES users(id),team_id int REFERENCES teams(id),UNIQUE(user_id,team_id));
      INSERT INTO users VALUES(1,'synthetic',NULL,NULL);`);
    const resetTimes = () => pool.query("DELETE FROM settings; UPDATE usage_records SET created_at='2026-01-01 00:00:00'; UPDATE fusion_usage_records SET created_at='2026-01-01 00:00:00'");
    const times = async () => (await pool.query('SELECT (SELECT created_at::text FROM usage_records) AS usage,(SELECT created_at::text FROM fusion_usage_records) AS fusion,(SELECT count(*)::int FROM settings) AS flags')).rows[0];
    await t.test('两个首启实际等待迁移锁，仅加八小时一次', async () => {
      const barrier = gate();
      let paused = false;
      const first = load(intercept(pool, async sql => {
        if (!paused && sql.startsWith('SELECT value FROM settings')) { paused = true; await barrier.pause(); }
      })).migrateUtcWallTimestampsToShanghai();
      await barrier.reached;
      const second = load(pool).migrateUtcWallTimestampsToShanghai();
      try { await waiting(pool, 'pg_advisory_xact_lock'); } finally { barrier.release(); }
      await Promise.all([first, second]);
      assert.deepEqual(await times(), { usage: '2026-01-01 08:00:00', fusion: '2026-01-01 08:00:00', flags: 1 });
      await load(pool).migrateUtcWallTimestampsToShanghai();
      assert.deepEqual(await times(), { usage: '2026-01-01 08:00:00', fusion: '2026-01-01 08:00:00', flags: 1 });
    });
    for (const [name, pattern] of [['第二张表更新失败', /^UPDATE fusion_usage_records/], ['最终标志写入失败', /INSERT INTO settings/]]) {
      await t.test(name + '完整回滚，重试只迁移一次', async () => {
        await resetTimes();
        const fail = load(intercept(pool, async sql => { if (pattern.test(sql.trim())) throw new Error('synthetic migration failure'); }));
        await assert.rejects(fail.migrateUtcWallTimestampsToShanghai(), /synthetic migration failure/);
        assert.deepEqual(await times(), { usage: '2026-01-01 00:00:00', fusion: '2026-01-01 00:00:00', flags: 0 });
        await load(pool).migrateUtcWallTimestampsToShanghai();
        assert.deepEqual(await times(), { usage: '2026-01-01 08:00:00', fusion: '2026-01-01 08:00:00', flags: 1 });
      });
    }
    const resetTeams = () => pool.query('DELETE FROM user_teams; UPDATE users SET team_id=NULL; DELETE FROM teams');
    const readTeam = async () => (await pool.query('SELECT u.team_id AS primary,ut.team_id AS projected FROM users u LEFT JOIN user_teams ut ON ut.user_id=u.id WHERE u.id=1')).rows[0];
    await t.test('启动补个人Team原子写入两投影，重复及并发执行不重复建Team', async () => {
      await Promise.all([load(pool).ensureReservedResources(), load(pool).ensureReservedResources()]);
      await load(pool).ensureReservedResources();
      const row = await readTeam();
      assert.equal(row.primary, row.projected); assert(row.primary > 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM teams')).rows[0].n, 1);
    });
    await t.test('启动预选后管理员已分配Team时保留新归属', async () => {
      await resetTeams();
      const team = (await pool.query("INSERT INTO teams(name,is_personal) VALUES('admin-team',false) RETURNING id")).rows[0].id;
      const barrier = gate();
      const running = load(intercept(pool, async sql => {
        if (sql.startsWith('SELECT id, username, team_id FROM users')) await barrier.pause();
      })).ensureReservedResources();
      await barrier.reached;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM teams WHERE id=$1 FOR SHARE', [team]);
        await membership.setUserTeam(client, 1, team);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); barrier.release(); }
      await running;
      assert.deepEqual(await readTeam(), { primary: team, projected: team });
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM teams')).rows[0].n, 1);
    });
    await t.test('个人Team投影写入失败回滚新Team与关联并向启动抛错', async () => {
      await resetTeams();
      const failing = load(intercept(pool, async sql => {
        if (sql.startsWith('UPDATE users SET team_id')) throw new Error('synthetic projection failure');
      }));
      await assert.rejects(failing.ensureReservedResources(), /synthetic projection failure/);
      assert.deepEqual(await readTeam(), { primary: null, projected: null });
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM teams')).rows[0].n, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_teams')).rows[0].n, 0);
    });
  } finally {
    try { await pool.end(); } finally {
      cluster.stop();
      assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
      assert.equal(fs.existsSync(cluster.dataDir), false);
      assert.equal(fs.existsSync(cluster.socketDir), false);
    }
  }
});
