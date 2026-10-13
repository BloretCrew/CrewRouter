'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const { Pool } = require('pg');
const { createStore, keyId } = require('../utils/model-trace-store');
const { ensureModelTraceTables } = require('../utils/model-trace-migration');

const forbidden = () => { throw new Error('Default database access is forbidden in this test'); };
const mocks = new Map([
  [path.resolve(__dirname, '../models/database.js'), { pool: { query: forbidden, connect: forbidden } }],
  [path.resolve(__dirname, '../utils/quota-data.js'), { getUserQuotaBuffer: () => [] }],
]);
const originalLoad = Module._load;
let checkQuotaRules;
try {
  Module._load = function load(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    return mocks.has(resolved) ? mocks.get(resolved) : originalLoad.call(this, request, parent, isMain);
  };
  ({ checkQuotaRules } = require('../utils/points-deduct'));
} finally {
  Module._load = originalLoad;
}

async function main() {
  if (process.env.MODEL_TRACE_TEST_PG_PORT !== '19483') {
    throw new Error('This regression only permits MODEL_TRACE_TEST_PG_PORT=19483 on 127.0.0.1.');
  }
  const connection = { host: '127.0.0.1', port: 19483, user: 'postgres', database: 'postgres' };
  const admin = new Pool(connection);
  const schema = `model_trace_recovery_${randomUUID().replace(/-/g, '')}`;
  let pool;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    pool = new Pool({ ...connection, options: `-c search_path=${schema} -c timezone=UTC`, max: 4 });
    await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY,balance NUMERIC(18,6),is_admin BOOLEAN DEFAULT FALSE);
      CREATE TABLE teams(id INTEGER PRIMARY KEY,quota_rules JSONB);
      CREATE TABLE user_teams(user_id INTEGER,team_id INTEGER);
      CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT,base_url TEXT,format TEXT,api_key TEXT,api_keys JSONB,key_mode TEXT,
        proxy_pool JSONB,proxy_subscription_url TEXT,proxy_enabled BOOLEAN,proxy_mode TEXT,proxy_url TEXT,proxy_use_system BOOLEAN,
        test_user_agent TEXT,created_by INTEGER,enabled BOOLEAN);
      CREATE TABLE models(id TEXT PRIMARY KEY,name TEXT,upstream_model_id TEXT,model_multiplier NUMERIC,provider TEXT,enabled BOOLEAN);
      CREATE TABLE team_models(team_id INTEGER,model_id TEXT,enabled BOOLEAN);
      CREATE TABLE usage_records(id SERIAL PRIMARY KEY,user_id INTEGER,model_id TEXT,provider_id TEXT,request_type TEXT,
        request_source TEXT,tokens_used INTEGER,prompt_tokens INTEGER,completion_tokens INTEGER,cached_tokens INTEGER,
        weighted_tokens BIGINT,cost NUMERIC(10,6),history_hidden BOOLEAN,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE quota_data(user_id INTEGER,model_name TEXT,created_at TIMESTAMP,token_used INTEGER,weighted_tokens BIGINT,count INTEGER,quota NUMERIC,
        UNIQUE(user_id,model_name,created_at));
      INSERT INTO users VALUES(1,0,FALSE),(2,1,FALSE),(3,1,FALSE);
      INSERT INTO teams VALUES(1,'[{"rule_type":"tokens","rule_value":10000,"duration_hours":24}]'),(2,'[]'),(3,'[]');
      INSERT INTO user_teams VALUES(1,1),(2,2),(3,3);
      INSERT INTO providers(id,name,base_url,format,api_key,key_mode,enabled)
        VALUES('p','Provider','https://mock.invalid','openai','isolated-secret','fixed',TRUE);
      INSERT INTO models VALUES('m','Model','fixed-model',1,'p',TRUE);
      INSERT INTO team_models VALUES(1,'m',TRUE),(2,'m',TRUE),(3,'m',TRUE);
      INSERT INTO usage_records(user_id,weighted_tokens) VALUES(1,9999);`);

    async function quota(userId, teamId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
        const rules = await checkQuotaRules(userId, teamId, client);
        assert.equal((await client.query('SELECT 1 AS alive')).rows[0].alive, 1);
        await client.query('COMMIT');
        return rules;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }

    // The missing-table error must not poison the caller's real transaction.
    const beforeMigration = await pool.connect();
    try {
      await beforeMigration.query('BEGIN');
      let rules = await checkQuotaRules(1, 1, beforeMigration);
      assert.equal(rules[0].used, 9999);
      assert.equal(rules[0].exceeded, false);
      await beforeMigration.query('UPDATE users SET balance=0.1234 WHERE id=1');
      rules = await checkQuotaRules(1, 1, beforeMigration);
      assert.equal(rules[0].remaining, 1);
      await beforeMigration.query('COMMIT');
    } catch (error) {
      await beforeMigration.query('ROLLBACK');
      throw error;
    } finally { beforeMigration.release(); }
    assert.equal(Number((await pool.query('SELECT balance FROM users WHERE id=1')).rows[0].balance), 0.1234);
    await pool.query('UPDATE users SET balance=0 WHERE id=1');
    console.log('PASS real PostgreSQL pre-migration 42P01 fallback preserves transaction and commit');

    await ensureModelTraceTables(pool);
    const store = createStore({ pool, getKeys: model => [{ key: model.api_key, enabled: true }], quotaBuffer: () => [] });
    const version = { algorithm_version: 'isolated-regression' };
    const body = () => ({ model_id: 'm', key_id: keyId('isolated-secret'), idempotency_key: randomUUID() });
    const balance = async id => Number((await pool.query('SELECT balance FROM users WHERE id=$1', [id])).rows[0].balance);
    const probe = async job => (await pool.query('SELECT * FROM model_trace_probes WHERE job_id=$1 AND ordinal=1', [job.id])).rows[0];
    const usageCount = async id => Number((await pool.query('SELECT COUNT(*) AS count FROM usage_records WHERE user_id=$1', [id])).rows[0].count);

    const free = await store.create(1, body(), version);
    await store.claim(free.id);
    assert.ok(await store.reserve(free.id, 1, 100));
    const held = await probe(free);
    assert.equal(held.quota_covered, true);
    assert.equal(Number(held.reserved_cost), 0);
    assert.equal(await balance(1), 0);
    let rules = await quota(1, 1);
    assert.equal(rules[0].used, 9999 + Number(held.reserved_weight));
    assert.equal(rules[0].exceeded, true);
    await pool.query(`UPDATE teams SET quota_rules='[{"rule_type":"requests","rule_value":2,"duration_hours":24}]' WHERE id=1`);
    rules = await quota(1, 1);
    assert.equal(rules[0].used, 2);
    assert.equal(rules[0].exceeded, true);
    await store.finish(free.id, 'failed');
    assert.equal((await store.get(1, free.id)).status, 'running', 'reserved probe blocks terminal transition');
    assert.equal(await store.markSent(free.id, 1), true);
    await store.settle(free.id, 1, { usage: { promptTokens: 50, completionTokens: 50, cachedTokens: 0 }, valid: true });
    assert.equal((await quota(1, 1))[0].used, 2, 'settled request replaces held request exactly once');
    await pool.query(`UPDATE teams SET quota_rules='[{"rule_type":"tokens","rule_value":10000,"duration_hours":24}]' WHERE id=1`);
    assert.equal((await quota(1, 1))[0].used, 10099, 'settled tokens exclude the old reserved weight');
    await store.settle(free.id, 1, {});
    assert.equal(await usageCount(1), 2);
    await store.finish(free.id, 'completed');
    assert.equal((await store.get(1, free.id)).status, 'completed');
    console.log('PASS real PostgreSQL zero-balance 9999/10000 free admission, held quota, atomic settlement and finish guard');

    const unsent = await store.create(2, body(), version);
    await store.claim(unsent.id);
    await store.reserve(unsent.id, 1, 100);
    const unsentProbe = await probe(unsent);
    assert.ok(Number(unsentProbe.reserved_cost) > 0);
    assert.equal(await balance(2), 1 - Number(unsentProbe.reserved_cost));
    await pool.query(`UPDATE teams SET quota_rules='[{"rule_type":"requests","rule_value":1,"duration_hours":24},
      {"rule_type":"tokens","rule_value":1,"duration_hours":24}]' WHERE id=2`);
    assert.deepEqual((await quota(2, 2)).map(rule => rule.used), [0, 0], 'paid reservations do not consume free quota');
    // Simulate a legacy failure that marked the job terminal before settling.
    await pool.query("UPDATE model_trace_jobs SET status='failed' WHERE id=$1", [unsent.id]);
    await store.recover();
    assert.equal(await balance(2), 1);
    assert.equal((await probe(unsent)).status, 'failed');
    assert.equal(await usageCount(2), 0);
    await store.recover();
    assert.equal(await balance(2), 1, 'recovery refund is idempotent');
    assert.equal(await usageCount(2), 0);

    const sent = await store.create(3, body(), version);
    await store.claim(sent.id);
    await store.reserve(sent.id, 1, 100);
    await store.markSent(sent.id, 1);
    const sentProbe = await probe(sent);
    const reservedBalance = await balance(3);
    await pool.query("UPDATE model_trace_jobs SET status='failed' WHERE id=$1", [sent.id]);
    await store.recover();
    assert.equal(await balance(3), reservedBalance, 'unknown sent usage retains its reservation');
    const recovered = await probe(sent);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.usage_unknown, true);
    assert.equal(Number(recovered.cost), Number(sentProbe.reserved_cost));
    const usage = (await pool.query('SELECT weighted_tokens,cost FROM usage_records WHERE user_id=3')).rows;
    assert.equal(usage.length, 1);
    assert.equal(Number(usage[0].weighted_tokens), Number(sentProbe.reserved_weight));
    assert.equal(Number(usage[0].cost), Number(sentProbe.reserved_cost));
    await store.recover();
    await store.settle(sent.id, 1, {});
    assert.equal(await balance(3), reservedBalance);
    assert.equal(await usageCount(3), 1);
    assert.equal(Number((await pool.query('SELECT SUM(count) AS count FROM quota_data WHERE user_id=3')).rows[0].count), 1);
    assert.equal(Number((await pool.query("SELECT COUNT(*) AS count FROM model_trace_probes WHERE status='reserved'")).rows[0].count), 0);
    console.log('PASS real PostgreSQL failed-job orphan recovery: unsent refund and unknown sent settlement are idempotent');
  } finally {
    if (pool) await pool.end();
    try { if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
