'use strict';
// Real route handlers with synthetic users and a newly initialized Unix-only DB.
// No application config, logger, database module, network provider or live data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { Pool } = require('pg');
const security = require('../utils/redemption-code-security');
const money = require('../utils/money');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const quiet = { info() {}, error() {} };
function routes(pool) {
  const handlers = {};
  const context = { pool, Logger: quiet, ...money, requireAuth() {}, requireAdmin() {},
    auditMiddleware: () => () => {}, ACTIONS: {},
    require(name) { assert.equal(name, '../utils/redemption-code-security'); return security; },
    router: Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (route, ...fns) => { handlers[method + route] = fns.at(-1); }])) };
  const admin = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
  vm.runInNewContext(admin.slice(admin.indexOf('// 所有创建别名共用校验'), admin.indexOf('// 批量设置兑换码可退款属性')), context);
  const user = fs.readFileSync(path.join(__dirname, '../routes/user.js'), 'utf8');
  const start = user.indexOf("router.post('/redeem',");
  vm.runInNewContext(user.slice(start, user.indexOf('\n});', start) + 4), context);
  return handlers;
}
async function request(handler, body = {}, { id, user = 1 } = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
  await handler({ body, params: id === undefined ? {} : { id }, session: { user: { id: user, username: 'synthetic' } } }, res);
  return res;
}
function gatePool(pool, match) {
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  return { reached, release, pool: { query: (...args) => pool.query(...args), async connect() {
    const client = await pool.connect();
    return { release: () => client.release(), async query(sql, params) {
      if (match(sql)) { entered(); await resumed; }
      return client.query(sql, params);
    } };
  } } };
}
async function waitForLock(pool, fragment) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND position($1 in query)>0", [fragment]);
    if (result.rows[0].n > 0) return;
  }
  assert.fail('expected isolated PostgreSQL lock wait: ' + fragment);
}
test('兑换码真实 PostgreSQL 回归及隔离清理', async t => {
  const cluster = createIsolatedPostgres('redemption');
  const postmasterPid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  const pool = new Pool({ ...cluster.connection, max: 8, options: '-c statement_timeout=8000 -c idle_in_transaction_session_timeout=10000' });
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE users(id int PRIMARY KEY, username text, balance numeric(10,4) NOT NULL DEFAULT 0, refund_balance numeric(10,4) NOT NULL DEFAULT 0, updated_at timestamp);
      INSERT INTO users(id,username) VALUES (1,'synthetic'),(2,'other');
      CREATE TABLE redemption_codes(id serial PRIMARY KEY, code varchar(32) UNIQUE NOT NULL, amount numeric(10,4) NOT NULL, max_uses int DEFAULT 1, used_count int DEFAULT 0, expires_at timestamp, batch_name varchar(255),created_by int REFERENCES users(id),refundable boolean DEFAULT false,fee_rate numeric(5,4) DEFAULT 0);
      CREATE TABLE redemption_code_uses(id serial PRIMARY KEY, code_id int REFERENCES redemption_codes(id) ON DELETE CASCADE, user_id int REFERENCES users(id), UNIQUE(code_id,user_id));
      CREATE TABLE user_code_balances(id serial PRIMARY KEY,user_id int REFERENCES users(id),code_id int REFERENCES redemption_codes(id) ON DELETE CASCADE,amount numeric(10,4),fee_rate numeric(5,4),updated_at timestamp,UNIQUE(user_id,code_id));`);
    const handlers = routes(pool);
    const reset = () => pool.query('TRUNCATE user_code_balances,redemption_code_uses,redemption_codes RESTART IDENTITY; UPDATE users SET balance=0,refund_balance=0');
    const create = async (extra = {}) => {
      const result = await request(handlers['post/redemption-codes'], { code: 'test-code', amount: '10.0000', ...extra });
      assert.equal(result.statusCode, 200);
      return result.data;
    };
    await t.test('创建别名保持响应、规范码和零次无限语义', async () => {
      const code = await create({ code: ' lower_code ', max_uses: 0, maxUses: '0' });
      assert.equal(code.code, 'LOWER_CODE'); assert.equal(code.max_uses, 0);
      const batch = await request(handlers['post/redemption-codes/batch'], { amount: '1.1234', count: 2, prefix: 'old-', maxUses: 2 });
      assert.equal(batch.statusCode, 200); assert.equal(batch.data.count, 2);
      const generated = await request(handlers['post/redemption-codes/generate'], { amount: '2', count: 1, refundable: true, fee_rate: '.1' });
      assert.equal(generated.statusCode, 400);
      const valid = await request(handlers['post/redemption-codes/generate'], { amount: '2', count: 1, refundable: true, fee_rate: '0.1' });
      assert.equal(valid.statusCode, 200); assert.equal(valid.data.codes[0].fee_rate, '0.1000');
      assert.equal((await pool.query('SELECT code FROM redemption_codes WHERE code LIKE $1', ['OLD-%'])).rows.length, 2);
    });
    await t.test('所有创建别名拒绝非法金额、次数及冲突字段，批量有界', async () => {
      for (const route of ['/redemption-codes', '/redemption-codes/batch', '/redemption-codes/generate']) {
        for (const invalid of [{ amount: '-1' }, { amount: '0' }, { amount: '1.00001' }, { amount: 'NaN' }, { amount: true }, { max_uses: -1 }, { max_uses: 1.5 }, { max_uses: 1, maxUses: 2 }, { refundable: 'false' }, { feeRate: '10' }, { maxUses: 1, max_uses: [1] },
          { maxUses: 1, max_uses: { toString: null } }, { maxUses: null }, { feeRate: null },
          { feeRate: '0', fee_rate: { toString: {} } }, { batchName: 'name', batch_name: ['name'] },
          { batchName: null, batch_name: 'null' }, { expiresAt: null, expires_at: { toString: null } },
          { batchName: true }, { expiresAt: 123 }]) {
          assert.equal((await request(handlers['post' + route], { code: 'invalid', amount: '1', count: 1, ...invalid })).statusCode, 400);
        }
      }
      for (const count of [0, -1, 1001, 'Infinity', 1.5]) assert.equal((await request(handlers['post/redemption-codes/batch'], { amount: 1, count })).statusCode, 400);
    });
    await t.test('正常并发兑换不突破上限且同一人仅一次', async () => {
      await reset(); await create({ maxUses: 1 });
      const result = await Promise.all([1,2].map(user => request(handlers['post/redeem'], { code: 'test-code' }, { user })));
      assert.deepEqual(result.map(r => r.statusCode).sort(), [200,400]);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM redemption_code_uses')).rows[0].n, 1);
      await reset(); await create({ maxUses: 0 });
      const repeated = await Promise.all([1,1].map(user => request(handlers['post/redeem'], { code: 'test-code' }, { user })));
      assert.deepEqual(repeated.map(r => r.statusCode).sort(), [200,400]);
    });
    await t.test('历史计数异常拒绝兑换且不重建数据', async () => {
      await reset(); await create({ maxUses: 1 });
      await pool.query('INSERT INTO redemption_code_uses(code_id,user_id) VALUES(1,2)');
      assert.equal((await request(handlers['post/redeem'], { code: 'test-code' })).statusCode, 409);
      assert.equal((await pool.query('SELECT balance FROM users WHERE id=1')).rows[0].balance, '0.0000');
      await pool.query('UPDATE redemption_codes SET used_count=NULL');
      assert.equal((await request(handlers['post/redeem'], { code: 'test-code' })).statusCode, 409);
    });
    await t.test('已使用且余额为零的码保留历史，批删全部回滚', async () => {
      await reset(); const used = await create({ refundable: true });
      assert.equal((await request(handlers['post/redeem'], { code: used.code })).statusCode, 200);
      await pool.query('UPDATE user_code_balances SET amount=0; UPDATE users SET refund_balance=0');
      const unused = await create({ code: 'unused' });
      assert.equal((await request(handlers['post/redemption-codes/batch-delete'], { ids: [unused.id,used.id] })).statusCode, 409);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM redemption_codes')).rows[0].n, 2);
      assert.equal((await request(handlers['delete/redemption-codes/:id'], {}, { id: used.id })).statusCode, 409);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM redemption_code_uses')).rows[0].n, 1);
      assert.equal((await request(handlers['delete/redemption-codes/:id'], {}, { id: unused.id })).statusCode, 200);
    });
    await t.test('兑换先锁码时并发删除等待并拒绝，余额保持一致', async () => {
      await reset(); await create({ refundable: true });
      const gate = gatePool(pool, sql => sql.includes('COUNT(DISTINCT user_id)'));
      const redeem = request(routes(gate.pool)['post/redeem'], { code: 'test-code' });
      await gate.reached;
      const deleting = request(handlers['delete/redemption-codes/:id'], {}, { id: 1 });
      try { await waitForLock(pool, 'ORDER BY id FOR UPDATE'); } finally { gate.release(); }
      assert.equal((await redeem).statusCode, 200);
      assert.equal((await deleting).statusCode, 409);
      assert.equal((await pool.query('SELECT refund_balance FROM users WHERE id=1')).rows[0].refund_balance, '10.0000');
      assert.equal((await pool.query('SELECT amount FROM user_code_balances')).rows[0].amount, '10.0000');
    });
    await t.test('删除先锁码时并发兑换不能新增悬空余额', async () => {
      await reset(); await create({ refundable: true });
      const gate = gatePool(pool, sql => sql.includes('SELECT EXISTS'));
      const deleting = request(routes(gate.pool)['delete/redemption-codes/:id'], {}, { id: 1 });
      await gate.reached;
      const redeem = request(handlers['post/redeem'], { code: 'test-code' });
      try { await waitForLock(pool, 'WHERE code = $1 FOR UPDATE'); } finally { gate.release(); }
      assert.equal((await deleting).statusCode, 200);
      assert.equal((await redeem).statusCode, 400);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_code_balances')).rows[0].n, 0);
    });
    await t.test('审计实际 SQL 检出孤儿、重复、缺使用关联及非法码值', async () => {
      const client = await pool.connect();
      try {
        await client.query(`CREATE TEMP TABLE users(id int);
          CREATE TEMP TABLE redemption_codes(id int,created_by int,used_count int,max_uses int,amount numeric,fee_rate numeric);
          CREATE TEMP TABLE redemption_code_uses(code_id int,user_id int);
          CREATE TEMP TABLE user_code_balances(code_id int,user_id int);
          INSERT INTO users VALUES(1);
          INSERT INTO redemption_codes VALUES(1,1,2,3,10,0),(2,1,NULL,1,10,0),(3,1,0,1,0,-1);
          INSERT INTO redemption_code_uses VALUES(1,1),(1,1),(99,999);
          INSERT INTO user_code_balances VALUES(2,1);`);
        const source = fs.readFileSync(path.join(__dirname, 'security-audit.js'), 'utf8');
        const start = source.indexOf('SELECT count(*) FILTER(WHERE COALESCE(rc.used_count');
        const sql = source.slice(start, source.indexOf('`)).rows[0]', start));
        const result = (await client.query(sql)).rows[0];
        assert.equal(result.orphanUses, 1);
        assert.equal(result.duplicateUses, 1);
        assert.equal(result.balancesWithoutUse, 1);
        assert.equal(result.invalidCodeValues, 2);
      } finally { client.release(); }
    });
  } finally {
    try { await pool.end(); }
    finally {
      cluster.stop();
      assert.throws(() => process.kill(postmasterPid, 0), error => error.code === 'ESRCH', 'isolated PostgreSQL PID must be gone');
      assert.equal(fs.existsSync(cluster.dataDir), false);
      assert.equal(fs.existsSync(cluster.socketDir), false);
    }
  }
});
