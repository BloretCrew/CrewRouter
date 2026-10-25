'use strict';

// Real PostgreSQL concurrency, exclusively in a new Unix-only temporary cluster.
// Route handlers run without application config, authentication, logging or IdPs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const membership = require('../utils/team-membership');
const noop = () => {};
const middleware = () => noop;

function gate() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await waiting; } };
}

function gatedPool(pool, pattern, barrier) {
  let paused = false;
  return {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return {
        release: () => client.release(),
        async query(sql, args) {
          if (!paused && pattern.test(sql)) { paused = true; await barrier.wait(); }
          return client.query(sql, args);
        },
      };
    },
  };
}

function loadRoutes(name, pool, onInvalidate = noop) {
  const handlers = new Map();
  const router = { use() {} };
  for (const method of ['get', 'post', 'put', 'delete']) router[method] = (route, ...callbacks) => handlers.set(`${method} ${route}`, callbacks.at(-1));
  const file = path.resolve(__dirname, `../routes/${name}.js`);
  let source = fs.readFileSync(file, 'utf8');
  if (name === 'admin') source = source.slice(source.indexOf("router.put('/users/:id'"), source.indexOf('// 管理员退款'));
  const api = { invalidateUserApiKeyCache: onInvalidate, invalidateApiKeyCacheByKeyId: noop };
  const context = {
    module: { exports: {} }, router, requireAuth: noop, requireAdmin: noop,
    requireTeamAdminEdition: noop, auditMiddleware: middleware, ACTIONS: {},
    pool, Logger: { info: noop, error: noop, warn: noop },
    normalizeEmail: value => value, isUniqueViolation: error => error.code === '23505',
    require(id) {
      if (id === 'express') return { Router: () => router };
      if (id === '../models/database') return { pool };
      if (id === '../middleware/auth') return { requireAuth: noop, requireAdmin: noop };
      if (id === '../utils/instance-edition') return { requireTeamEdition: middleware };
      if (id === '../logger') return context.Logger;
      if (id === './api') return api;
      if (id === '../utils/audit-log') return { ACTIONS: {}, auditMiddleware: middleware };
      if (id === '../utils/team-model-access') return require('../utils/team-model-access');
      if (id === '../utils/team-membership') return membership;
      throw new Error(`Unexpected application dependency: ${id}`);
    },
  };
  vm.runInNewContext(source, context, { filename: file });
  return async (method, route, params, body = {}) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handlers.get(`${method} ${route}`)({ params, body }, res);
    return res;
  };
}

async function main() {
  const cluster = createIsolatedPostgres('team-membership');
  const pool = new Pool({ ...cluster.connection, max: 6, options: '-c statement_timeout=8000 -c idle_in_transaction_session_timeout=10000' });
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`
      CREATE TABLE teams (id serial PRIMARY KEY, name text UNIQUE, description text, is_personal boolean DEFAULT false, is_default boolean DEFAULT false);
      CREATE TABLE users (id serial PRIMARY KEY, username text, is_admin boolean DEFAULT false, team_id int REFERENCES teams(id), email text, updated_at timestamptz DEFAULT now());
      CREATE TABLE user_teams (user_id int REFERENCES users(id) ON DELETE CASCADE, team_id int REFERENCES teams(id), UNIQUE(user_id, team_id));
      CREATE TABLE user_group_team_map (team_id int REFERENCES teams(id));
      INSERT INTO teams(id,name,is_default) VALUES(10,'A',true),(20,'B',false),(30,'C',false);
      SELECT setval('teams_id_seq',100);
      INSERT INTO users(id,username,is_admin,team_id) VALUES(1,'alice',true,10);
      INSERT INTO user_teams VALUES(1,10);
    `);
    const invalidatedUsers = [];
    const admin = loadRoutes('admin', pool, userId => { invalidatedUsers.push(userId); });
    const teams = loadRoutes('teams', pool);
    const assign = async teamId => {
      const response = await admin('put', '/users/:id', { id: '1' }, { team_id: teamId });
      assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    };
    const read = async () => (await pool.query('SELECT u.team_id AS primary_team, ut.team_id AS projected_team FROM users u LEFT JOIN user_teams ut ON ut.user_id=u.id WHERE u.id=1')).rows[0];
    const assertTeam = async teamId => assert.deepEqual(await read(), { primary_team: teamId, projected_team: teamId });

    // Different destination Team locks must still serialize on the same user.
    await Promise.all([assign(20), assign(30)]);
    const state = await read();
    assert.equal(state.primary_team, state.projected_team);
    assert([20, 30].includes(state.primary_team));
    assert.deepEqual(invalidatedUsers, [1, 1]);
    // Use the production cache invalidator against synthetic cache entries. A
    // string route parameter would fail its strict numeric-ID comparison.
    const apiSource = fs.readFileSync(path.resolve(__dirname, '../routes/api.js'), 'utf8');
    const start = apiSource.indexOf('function invalidateUserApiKeyCache(userId) {');
    const end = apiSource.indexOf('\n}', start) + 2;
    const cache = new Map([['fixture-key', { data: { userId: 1 } }]]);
    const context = { apiKeyCache: cache };
    vm.runInNewContext(apiSource.slice(start, end) + '\nthis.invalidate = invalidateUserApiKeyCache;', context);
    context.invalidate(invalidatedUsers[0]);
    assert.equal(cache.size, 0);
    console.log('PASS concurrent administrative transfers keep both projections equal');

    let committed = false;
    const commitTrackingPool = {
      async connect() {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          async query(sql, args) {
            const result = await client.query(sql, args);
            if (sql === 'COMMIT') committed = true;
            return result;
          },
        };
      },
    };
    const observedAdmin = loadRoutes('admin', commitTrackingPool, userId => {
      assert.equal(committed, true, 'cache invalidation must follow successful COMMIT');
      assert.equal(userId, 1, 'HTTP string parameters must become numeric cache IDs');
    });
    assert.equal((await observedAdmin('put', '/users/:id', { id: '1' }, { team_id: 10 })).statusCode, 200);
    console.log('PASS numeric user cache invalidation follows successful COMMIT');

    await assign(10);
    const removeGate = gate();
    const removing = loadRoutes('teams', gatedPool(pool, /^SELECT id FROM users WHERE id = \$1 FOR UPDATE$/, removeGate));
    const removal = removing('delete', '/teams/:id/members/:userId', { id: '10', userId: '1' });
    await removeGate.entered;
    await assign(20);
    removeGate.release();
    assert.equal((await removal).statusCode, 200);
    await assertTeam(20);
    console.log('PASS removing a former Team cannot erase a concurrent transfer');

    await assign(null);
    const registrationGate = gate();
    const registration = membership.assignInitialUserTeam(gatedPool(pool, /^SELECT id, team_id FROM users/, registrationGate), 1, 'alice');
    await registrationGate.entered;
    await assign(20);
    registrationGate.release();
    await registration;
    await assertTeam(20);
    console.log('PASS Feishu registration preserves a concurrent administrator assignment');

    await assign(null);
    await membership.assignInitialUserTeam(pool, 1, 'alice');
    await assertTeam(10);
    await pool.query('UPDATE teams SET is_default=false');
    await assign(null);
    await Promise.all([membership.assignInitialUserTeam(pool, 1, 'alice'), membership.assignInitialUserTeam(pool, 1, 'alice')]);
    const personal = await read();
    assert.equal(personal.primary_team, personal.projected_team);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM teams WHERE name='alice 的个人账户'")).rows[0].n, 1);
    console.log('PASS initial default/personal Team assignment is atomic and idempotent');

    // A rejected request must release the user lock and never return an open
    // transaction to the pool, including the no-fields and last-admin branches.
    for (const body of [{}, { isAdmin: false }]) {
      assert.equal((await admin('put', '/users/:id', { id: '1' }, body)).statusCode, 400);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n, 0);
      const probe = await pool.connect();
      try {
        await probe.query('BEGIN');
        await probe.query("SET LOCAL lock_timeout='500ms'");
        await probe.query('SELECT id FROM users WHERE id=1 FOR UPDATE');
        await probe.query('ROLLBACK');
      } finally { probe.release(); }
    }
    console.log('PASS rejected user edits release transactions and row locks');

    await pool.query("INSERT INTO users(id,username,team_id) VALUES(2,'bob',10); INSERT INTO user_teams VALUES(2,10)");
    const batches = await Promise.all([
      teams('post', '/teams/:id/members', { id: '10' }, { userIds: [2, 1] }),
      teams('post', '/teams/:id/members', { id: '20' }, { userIds: [1, 2] }),
    ]);
    assert(batches.every(response => response.statusCode === 200));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users u JOIN user_teams ut ON ut.user_id=u.id WHERE u.team_id IS DISTINCT FROM ut.team_id')).rows[0].n, 0);
    const personalId = personal.primary_team;
    assert.equal((await teams('post', '/teams/:id/members', { id: String(personalId) }, { userIds: [1] })).statusCode, 403);
    assert.equal((await teams('delete', '/teams/:id/members/:userId', { id: String(personalId), userId: '1' })).statusCode, 403);
    console.log('PASS overlapping batches use stable user lock order and personal Team protections remain');

    // A destination Team already being deleted is rechecked after waiting.
    await assign(10);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM teams WHERE id=30 FOR UPDATE');
    const moving = admin('put', '/users/:id', { id: '1' }, { team_id: 30 });
    await blocker.query('DELETE FROM teams WHERE id=30');
    await blocker.query('COMMIT');
    blocker.release();
    assert.equal((await moving).statusCode, 400);
    await assertTeam(10);
    assert.equal((await teams('delete', '/teams/:id', { id: '10' })).statusCode, 409);
    console.log('PASS deleted destination is rejected and assigned Team deletion stays protected');

    // No caller may accidentally use the pool as an auto-commit client again.
    await assert.rejects(membership.setUserTeam(pool, 1, 20), /transactional client/);
    console.log('PASS membership helper rejects auto-commit pool callers');
  } finally {
    await pool.end();
    const postmasterPid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
    cluster.stop();
    assert.throws(() => process.kill(postmasterPid, 0), error => error.code === 'ESRCH');
    assert.equal(fs.existsSync(cluster.dataDir), false);
    assert.equal(fs.existsSync(cluster.socketDir), false);
    console.log('PASS temporary PostgreSQL PID, data directory and socket directory are gone');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
