'use strict';

// Only synthetic rows in a new Unix-socket PostgreSQL cluster. No deployment
// configuration, application database module or upstream is loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');

const promptPath = '/inject-prompts/:id(\\d+)';
function gate() {
  let reached, release;
  const entered = new Promise(resolve => { reached = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  return { entered, release, async pause() { reached(); await resumed; } };
}
function fixture(pool, hooks = {}) {
  const routes = new Map();
  const invalidations = [];
  const router = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    router[method] = (route, ...handlers) => routes.set(`${method} ${route}`, handlers.at(-1));
  }
  const query = async (db, sql, args) => {
    await hooks.before?.(sql, args, db);
    const result = await db.query(sql, args);
    await hooks.after?.(sql, args, result);
    return result;
  };
  const db = { query: (sql, args) => query(pool, sql, args), async connect() {
    const client = await pool.connect();
    return { query: (sql, args) => query(client, sql, args), release: () => client.release() };
  } };
  const dependencies = {
    express: { Router: () => router }, '../models/database': { pool: db },
    '../logger': { error() {}, warn() {} }, '../middleware/auth': { requireAuth() {} },
    './api': {
      invalidateUserApiKeyCache(id) { invalidations.push({ user: id }); hooks.invalidate?.(); },
      invalidateApiKeyCacheByKeyId(id) { invalidations.push({ key: id }); },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../routes/inject-prompts.js'), 'utf8'), {
    Buffer, module: { exports: {} }, require(id) {
      assert(Object.hasOwn(dependencies, id), `Unexpected fixture dependency: ${id}`);
      return dependencies[id];
    },
  });
  return { invalidations, async request(method, suffix = '', body = {}, userId = 1) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await routes.get(`${method} ${promptPath}${suffix}`)({ session: { user: { id: userId } }, params: { id: '1' }, body }, res);
    return res;
  } };
}
async function lockWait(pool) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0");
    if (result.rows[0].n) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('expected a real PostgreSQL lock wait');
}

test('注入提示词写入串行化、作用域和故障回滚', async t => {
  const cluster = createIsolatedPostgres('inject-transactions');
  const pid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  const pool = new Pool({ ...cluster.connection, max: 6, options: '-c statement_timeout=7000 -c idle_in_transaction_session_timeout=10000' });
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY);
      INSERT INTO users VALUES(1),(2);
      CREATE TABLE api_keys(id SERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),name TEXT,key_prefix TEXT,enabled BOOLEAN DEFAULT TRUE,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO api_keys(id,user_id) VALUES(11,1),(12,1),(21,2);`);
    const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    for (const table of ['inject_prompts', 'inject_prompt_key_bindings']) {
      const ddl = index.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n      \\)`));
      assert(ddl, `production DDL for ${table}`);
      await pool.query(ddl[0]);
    }
    const reset = async () => pool.query("DELETE FROM inject_prompts; INSERT INTO inject_prompts(id,user_id,name,content) VALUES(1,1,'original','base')");
    const bindings = async () => (await pool.query('SELECT api_key_id FROM inject_prompt_key_bindings WHERE prompt_id=1 ORDER BY api_key_id')).rows.map(row => row.api_key_id);
    const prompt = async () => (await pool.query('SELECT name,content,enabled,sort_order FROM inject_prompts WHERE id=1')).rows[0];

    await t.test('名称更新与禁用交错不能重新启用条目', async () => {
      await reset(); const barrier = gate(); let paused = false; let locked = false;
      const firstRoute = fixture(pool, { async after(sql) {
        if (!paused && sql.includes('SELECT * FROM inject_prompts')) {
          paused = true; locked = sql.includes('FOR UPDATE'); await barrier.pause();
        }
      } });
      const first = firstRoute.request('put', '', { name: 'renamed' });
      await barrier.entered;
      const second = fixture(pool).request('put', '/toggle', { enabled: false });
      try { if (locked) await lockWait(pool); else await second; } finally { barrier.release(); }
      assert.equal((await first).statusCode, 200); assert.equal((await second).statusCode, 200);
      assert.deepEqual(await prompt(), { name: 'renamed', content: 'base', enabled: false, sort_order: 0 });
      assert(locked, 'the snapshot used for a merged update must be locked');
    });
    await t.test('空绑定集合的并发替换不会混合两个请求', async () => {
      await reset(); const barrier = gate(); let paused = false; let locked = false;
      const firstRoute = fixture(pool, { async after(sql) {
        if (sql.includes('SELECT * FROM inject_prompts') && sql.includes('FOR UPDATE')) locked = true;
        if (!paused && sql.startsWith('DELETE FROM inject_prompt_key_bindings')) { paused = true; await barrier.pause(); }
      } });
      const first = firstRoute.request('put', '/keys', { keyIds: [11] });
      await barrier.entered;
      const second = fixture(pool).request('put', '/keys', { keyIds: [12] });
      try { if (locked) await lockWait(pool); else await second; } finally { barrier.release(); }
      assert.equal((await first).statusCode, 200); assert.equal((await second).statusCode, 200);
      assert.deepEqual(await bindings(), [12]);
      assert(locked, 'an empty child set still needs the parent prompt lock');
    });
    await t.test('全局与指定Key互转必须使该用户全部Key缓存失效', async () => {
      await reset();
      for (const keyIds of [[11], []]) {
        const route = fixture(pool);
        assert.equal((await route.request('put', '/keys', { keyIds })).statusCode, 200);
        assert(route.invalidations.some(item => item.user === 1));
      }
    });
    await t.test('非法Key选择不能被静默过滤成全局或另一条Key', async () => {
      await reset();
      await pool.query('INSERT INTO inject_prompt_key_bindings VALUES(1,11)');
      for (const keyIds of [['invalid'], ['12junk'], [null], [true], [0], [-1], [1.5], [2147483648]]) {
        const route = fixture(pool);
        assert.equal((await route.request('put', '/keys', { keyIds })).statusCode, 400, JSON.stringify(keyIds));
        assert.deepEqual(await bindings(), [11]); assert.deepEqual(route.invalidations, []);
      }
      assert.equal((await fixture(pool).request('put', '/keys', { keyIds: ['12', 12] })).statusCode, 200);
      assert.deepEqual(await bindings(), [12]);
    });
    await t.test('批量绑定任一步失败保留原作用域且不失效缓存', async () => {
      await reset(); await pool.query('INSERT INTO inject_prompt_key_bindings VALUES(1,11)');
      const route = fixture(pool, { async before(sql, args, db) {
        if (sql.startsWith('INSERT INTO inject_prompt_key_bindings') && args[1] === 12) await db.query('SELECT 1/0');
      } });
      assert.equal((await route.request('put', '/keys', { keyIds: [11, 12] })).statusCode, 500);
      assert.deepEqual(await bindings(), [11]); assert.deepEqual(route.invalidations, []);
    });
    await t.test('删除先提交再失效，缓存回调异常不能误报已提交失败', async () => {
      await reset(); let committed = false;
      let callbackRan = false;
      const route = fixture(pool, {
        after(sql) { if (sql === 'COMMIT') committed = true; },
        invalidate() { callbackRan = true; assert(committed); throw new Error('synthetic cache failure after commit'); },
      });
      assert.equal((await route.request('delete')).statusCode, 200);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM inject_prompts')).rows[0].n, 0);
      assert(committed, 'delete must commit before it announces completion');
      assert(callbackRan, 'the committed deletion must survive an invalidation exception');
      assert(route.invalidations.some(item => item.user === 1));
    });
    await t.test('其他用户和不存在条目不写入，事务全部结束', async () => {
      await reset(); const original = await prompt();
      for (const [method, suffix, body] of [['put', '', { content: 'foreign' }], ['put', '/toggle', {}], ['put', '/keys', { keyIds: [21] }], ['delete', '', {}]]) {
        assert.equal((await fixture(pool).request(method, suffix, body, 2)).statusCode, 404);
      }
      assert.equal((await fixture(pool).request('put', '/keys', { keyIds: [21] })).statusCode, 403);
      assert.deepEqual(await prompt(), original); assert.deepEqual(await bindings(), []);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].n, 0);
    });
  } finally {
    try { await pool.end(); } finally {
      cluster.stop();
      assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
      assert.equal(fs.existsSync(cluster.dataDir), false); assert.equal(fs.existsSync(cluster.socketDir), false);
    }
  }
});
