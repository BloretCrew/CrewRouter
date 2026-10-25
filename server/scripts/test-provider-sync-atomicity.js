'use strict';
// Real handler, cleanup SQL and frontier writer against synthetic Unix-only PG.
// Application configuration, logger, network and live database modules are absent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { Pool } = require('pg');
const { clearDisabledModelBindings } = require('../utils/model-access-cleanup');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
function frontierWriter() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/frontier-auto-add.js'), 'utf8'), {
    module, require(id) { assert.equal(id, './personal-model-access'); return { addModelsToPersonalTeams: async () => 0 }; },
  });
  return module.exports.addModelsToFrontierTeams;
}
function gate() {
  let enter, release;
  const reached = new Promise(resolve => { enter = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  return { reached, release, async pause() { enter(); await resumed; } };
}
function fixture(pool, { before = async () => {}, fetch, invalidate } = {}) {
  let handler;
  const events = [];
  const db = { query: (...args) => pool.query(...args), async connect() {
    events.push('connect');
    const client = await pool.connect();
    return { release() { events.push('release'); client.release(); }, async query(sql, args) {
      await before(sql, args);
      const result = await client.query(sql, args);
      if (sql === 'COMMIT') events.push('commit');
      return result;
    } };
  } };
  const source = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
  const start = source.indexOf("router.post('/providers/:id/sync-models'");
  vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), {
    pool: db, crypto, clearDisabledModelBindings,
    addModelsToFrontierTeamsIfEnabled: frontierWriter(),
    invalidateModelKeyCaches(ids) { events.push('invalidate'); assert(events.includes('commit')); if (invalidate) invalidate(ids); },
    async fetchUpstreamModelsForProvider(provider) {
      events.push('fetch');
      assert(!events.includes('connect'), 'network must finish before transaction checkout');
      return fetch ? fetch(provider) : { ok: true, models: ['old', 'other', 'new'].map(id => ({ id })) };
    },
    Logger: { info() {}, error() {}, warn() {} }, requireAuth() {}, requireProviderManager() {},
    auditMiddleware: () => () => {}, ACTIONS: {}, router: { post(_path, ...callbacks) { handler = callbacks.at(-1); } },
  });
  return { events, async request(ids = [], extra = {}) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { id: 'p' }, body: { enabledModelIds: ids, ...extra } }, res);
    return res;
  } };
}
async function waitForProviderLock(pool) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if ((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%providers WHERE id = $1 FOR UPDATE%' ")).rows[0].n > 0) return;
  }
  assert.fail('expected real provider lock wait');
}
test('供应商同步原子提交、并发和隔离清理', async t => {
  const cluster = createIsolatedPostgres('provider-sync');
  const pid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  const pool = new Pool({ ...cluster.connection, max: 8, options: '-c statement_timeout=8000 -c idle_in_transaction_session_timeout=10000' });
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE providers(id text PRIMARY KEY,name text,base_url text,models_url text,api_key text,api_keys jsonb,format text,enabled boolean,created_by int);
      CREATE TABLE models(id text PRIMARY KEY,name text,provider text REFERENCES providers(id),upstream_model_id text,enabled boolean);
      CREATE TABLE teams(id int PRIMARY KEY,is_frontier boolean);
      CREATE TABLE team_models(team_id int REFERENCES teams(id),model_id text REFERENCES models(id),enabled boolean,UNIQUE(team_id,model_id));
      CREATE TABLE api_keys(id int PRIMARY KEY,current_model_id text,fusion_judge_model_id text,fusion_outer_model_id text,fusion_panel_models jsonb);
      CREATE TABLE api_key_models(id int,api_key_id int REFERENCES api_keys(id),model_id text,sort_order int);
      CREATE TABLE api_key_harness_models(api_key_id int REFERENCES api_keys(id),model_id text);
      INSERT INTO providers VALUES('p','synthetic','https://example.test',NULL,'synthetic-secret',NULL,'openai',true,NULL);
      INSERT INTO teams VALUES(1,true);`);
    const reset = async () => {
      await pool.query(`DELETE FROM team_models; DELETE FROM api_key_harness_models; DELETE FROM api_key_models; DELETE FROM api_keys; DELETE FROM models;
        UPDATE providers SET base_url='https://example.test';
        INSERT INTO models VALUES('m1','old','p','old',true),('m2','other','p','other',true);
        INSERT INTO team_models VALUES(1,'m1',true),(1,'m2',true);
        INSERT INTO api_keys VALUES(1,'m1','m1','m1','["m1","m2"]');
        INSERT INTO api_key_models VALUES(1,1,'m1',0),(2,1,'m2',1);
        INSERT INTO api_key_harness_models VALUES(1,'m1');`);
    };
    const snapshot = async () => {
      const state = {};
      for (const [table, order] of [['models','id'],['team_models','team_id,model_id'],['api_keys','id'],['api_key_models','id'],['api_key_harness_models','api_key_id,model_id']]) {
        state[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
      }
      return state;
    };
    for (const [label, fail] of [
      ['禁用模型最终更新', sql => sql.startsWith('UPDATE models SET enabled = FALSE')],
      ['Harness清理', sql => sql.startsWith('DELETE FROM api_key_harness_models')],
      ['前沿Team自动授权', sql => sql.includes('INSERT INTO team_models')],
    ]) {
      await t.test(label + '失败完整回滚模型及全部绑定，无缓存失效', async () => {
        await reset(); const previous = await snapshot();
        const f = fixture(pool, { before: async sql => { if (fail(sql.trim())) throw new Error('synthetic failure'); } });
        assert.equal((await f.request(['new'])).statusCode, 500);
        assert.deepEqual(await snapshot(), previous);
        assert(!f.events.includes('commit')); assert(!f.events.includes('invalidate'));
      });
    }
    await t.test('成功同步完整清理Key/Fusion并在提交后失效缓存', async () => {
      await reset(); let invalidated;
      const f = fixture(pool, { invalidate: ids => { invalidated = ids; } });
      const result = await f.request(['other', 'new']);
      assert.equal(result.statusCode, 200); assert.equal(result.body.added, 1); assert.equal(result.body.disabled, 1);
      assert.deepEqual(invalidated, [1]);
      const key = (await pool.query('SELECT * FROM api_keys')).rows[0];
      assert.deepEqual(key, { id: 1, current_model_id: 'm2', fusion_judge_model_id: null, fusion_outer_model_id: null, fusion_panel_models: ['m2'] });
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM api_key_harness_models')).rows[0].n, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM team_models WHERE model_id='m1'")).rows[0].n, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM team_models tm JOIN models m ON m.id=tm.model_id WHERE m.upstream_model_id='new'")).rows[0].n, 1);
    });
    await t.test('上游失败/畸形/选择已失效及输入非法均不进入事务', async () => {
      await reset(); const previous = await snapshot();
      for (const upstream of [{ ok: false }, { ok: true, models: [{ id: {} }] }, { ok: true, models: [] }]) {
        const f = fixture(pool, { fetch: async () => upstream });
        assert([409,502].includes((await f.request(['new'])).statusCode));
        assert(!f.events.includes('connect')); assert.deepEqual(await snapshot(), previous);
      }
      for (const ids of [[null], [true], [''], ['x'.repeat(101)]]) {
        const f = fixture(pool); assert.equal((await f.request(ids)).statusCode, 400); assert.deepEqual(f.events, []);
      }
    });
    await t.test('取上游期间供应商配置变更返回409不写模型', async () => {
      await reset(); const previous = await snapshot();
      const f = fixture(pool, { fetch: async () => {
        await pool.query("UPDATE providers SET base_url='https://changed.example.test'");
        return { ok: true, models: [{ id: 'new' }] };
      } });
      assert.equal((await f.request(['new'])).statusCode, 409);
      assert.deepEqual(await snapshot(), previous);
      assert(!f.events.includes('commit'));
    });
    await t.test('两次同步真实等待供应商锁且同一上游只创建一次', async () => {
      await reset(); const barrier = gate(); let paused = false;
      const a = fixture(pool, { before: async sql => {
        if (!paused && sql.includes('SELECT id, upstream_model_id')) { paused = true; await barrier.pause(); }
      } });
      const first = a.request(['new']);
      await barrier.reached;
      const second = fixture(pool).request(['new']);
      try { await waitForProviderLock(pool); } finally { barrier.release(); }
      const results = await Promise.all([first, second]);
      assert(results.every(result => result.statusCode === 200));
      assert.equal(results.reduce((n, result) => n + result.body.added, 0), 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM models WHERE upstream_model_id='new'")).rows[0].n, 1);
    });
    await t.test('addOnly保留未选旧模型及绑定，歧义历史拒绝而不猜', async () => {
      await reset();
      assert.equal((await fixture(pool).request(['new'], { addOnly: true })).statusCode, 200);
      assert.equal((await pool.query("SELECT enabled FROM models WHERE id='m1'")).rows[0].enabled, true);
      assert.equal((await pool.query('SELECT current_model_id FROM api_keys')).rows[0].current_model_id, 'm1');
      await pool.query("INSERT INTO models VALUES('duplicate','old duplicate','p','old',true)");
      const previous = await snapshot();
      assert.equal((await fixture(pool).request(['other'])).statusCode, 409);
      assert.deepEqual(await snapshot(), previous);
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
