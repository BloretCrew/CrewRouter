'use strict';

// Only the newly created Unix-socket database is reachable from these fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const money = require('../utils/money');

function loadBalance(pool, notifications) {
  const module = { exports: {} };
  const pendingInitialization = [];
  const isolatedPool = {
    connect: () => pool.connect(),
    query(...args) {
      const pending = pool.query(...args);
      pendingInitialization.push(pending);
      return pending;
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../utils/balance.js'), 'utf8'), {
    module,
    require(name) {
      if (name === '../models/database') return { pool: isolatedPool };
      if (name === '../logger') return { info() {}, warn() {}, error() {} };
      if (name === './money') return money;
      if (name === './balance-alert') return { checkBalanceAlert: async () => { notifications.push('alert'); } };
      if (name === '../routes/api') return { invalidateUserApiKeyCache: () => { notifications.push('cache'); } };
      throw new Error(`Unexpected fixture dependency: ${name}`);
    },
  });
  return { balance: module.exports, async ready() {
    // The module's migration issues its index query after its CREATE resolves.
    for (let i = 0; i < pendingInitialization.length; i++) await pendingInitialization[i];
  } };
}

async function main() {
  const cluster = await createIsolatedPostgres('balance-transactions');
  const postmasterPid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  let pool;
  try {
    pool = new Pool({ ...cluster.connection, max: 8 });
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE users (
      id INTEGER PRIMARY KEY, balance NUMERIC(18,6) NOT NULL DEFAULT 0,
      refund_balance NUMERIC(18,6) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ); CREATE TABLE user_code_balances (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      amount NUMERIC(18,6) NOT NULL, fee_rate NUMERIC(10,4) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ); INSERT INTO users(id, balance) VALUES (1, 10)`);
    const notifications = [];
    const fixture = loadBalance(pool, notifications);
    await fixture.ready();
    const { deductBalance } = fixture.balance;

    const results = await Promise.all([deductBalance(1, 7), deductBalance(1, 7)]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal((await pool.query('SELECT balance::text FROM users WHERE id=1')).rows[0].balance, '3.000000');
    assert.deepEqual(notifications.sort(), ['alert', 'cache']);

    await pool.query(`UPDATE users SET balance=2, refund_balance=8 WHERE id=1;
      INSERT INTO user_code_balances(id,user_id,amount,fee_rate) VALUES (1,1,3,0.2),(2,1,5,0.1);
      CREATE FUNCTION fail_final_balance_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('fixture.fail_balance_update', true) = 'on' AND NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
          RAISE EXCEPTION 'isolated failure after balance writes';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_final_balance_update BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION fail_final_balance_update()`);
    // Every owned connection enables a transaction-local failure after both
    // regular and refundable debits, exercising rollback of all affected rows.
    const originalConnect = pool.connect.bind(pool);
    const failingPool = { query: (...args) => pool.query(...args), async connect() {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      return {
        async query(sql, params) {
          const result = await originalQuery(sql, params);
          if (sql === 'BEGIN') await originalQuery("SET LOCAL fixture.fail_balance_update='on'");
          return result;
        }, release: () => client.release(),
      };
    } };
    const failedFixture = loadBalance(failingPool, notifications);
    await failedFixture.ready();
    notifications.length = 0;
    assert.equal((await failedFixture.balance.deductBalance(1, 7)).ok, false);
    assert.deepEqual((await pool.query('SELECT balance::text, refund_balance::text FROM users WHERE id=1')).rows[0],
      { balance: '2.000000', refund_balance: '8.000000' });
    assert.deepEqual((await pool.query('SELECT amount::text FROM user_code_balances ORDER BY id')).rows.map(row => row.amount), ['3.000000', '5.000000']);
    assert.deepEqual(notifications, []);

    assert.equal((await deductBalance(1, 7)).ok, true);
    assert.deepEqual((await pool.query(`SELECT balance::text, refund_balance::text,
      (SELECT SUM(amount)::text FROM user_code_balances WHERE user_id=1) AS details FROM users WHERE id=1`)).rows[0],
    { balance: '0.000000', refund_balance: '3.000000', details: '3.000000' });

    notifications.length = 0;
    const client = await pool.connect();
    const statements = [];
    let releaseAttempts = 0;
    try {
      await client.query('BEGIN');
      const external = { query(sql, params) { statements.push(sql); return client.query(sql, params); }, release() { releaseAttempts++; } };
      assert.equal((await deductBalance(1, 1, external)).ok, true);
      assert.equal((await client.query('SELECT refund_balance::text FROM users WHERE id=1')).rows[0].refund_balance, '2.000000');
      assert.equal(statements.some(sql => /^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)), false);
      assert.equal(releaseAttempts, 0);
      assert.deepEqual(notifications, [], 'external transaction has not committed');
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query("SET LOCAL fixture.fail_balance_update='on'");
      statements.length = 0;
      assert.equal((await deductBalance(1, 1, external)).ok, false);
      assert.equal(statements.some(sql => /^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)), false,
        'an external failure leaves rollback to the owner');
      assert.equal(releaseAttempts, 0);
      assert.deepEqual(notifications, []);
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    assert.equal((await pool.query('SELECT refund_balance::text FROM users WHERE id=1')).rows[0].refund_balance, '3.000000');
    console.log('Balance transaction isolation: concurrent debit, full rollback, refund details and external ownership passed');
  } finally {
    try { if (pool) await pool.end(); }
    finally {
      await cluster.stop();
      assert.throws(() => process.kill(postmasterPid, 0), error => error.code === 'ESRCH',
        'the isolated postmaster process must be gone');
      assert.equal(fs.existsSync(cluster.dataDir), false);
      assert.equal(fs.existsSync(cluster.socketDir), false);
      console.log('Balance transaction isolation: pool closed, postmaster gone, temporary data and socket directories removed');
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
