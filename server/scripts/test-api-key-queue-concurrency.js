'use strict';

// Only real route/helper source and a newly initialized Unix-only test cluster.
// Application config, database singleton, logger, plugins and upstreams never load.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const source = fs.readFileSync(path.join(__dirname, '../routes/user.js'), 'utf8');
const noop = () => {};
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function routes(pool, { baseline = false, invalidate = noop } = {}) {
  let code = source.slice(source.indexOf('async function getApiKeyAccess'), source.indexOf('// 生成 Claude Code 配置'));
  code += source.slice(source.indexOf("router.put('/api-keys/:id/tags'"), source.indexOf('// ========== 操作日志查询'));
  if (baseline) code = code.replace("    await client.query('SELECT id FROM api_keys WHERE id = $1 FOR UPDATE', [req.params.id]);", '');
  const handlers = new Map();
  const router = {};
  for (const method of ['get', 'put', 'post', 'delete']) router[method] = (route, ...callbacks) => handlers.set(`${method} ${route}`, callbacks.at(-1));
  const context = { pool, router, ACTIONS: {}, requireAuth: noop, auditMiddleware: noop,
    HARNESS_SOURCES: ['codex'], isHarnessSource: h => h === 'codex', sourceLabel: h => h,
    invalidateApiKeyCacheByKeyId: invalidate, Logger: { info: noop, warn: noop, error: noop } };
  vm.runInNewContext(code, context);
  return async (method, route, body = {}, user = 1, params = {}) => {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
    const handler = handlers.get(`${method} ${route}`);
    assert(handler, `${method} ${route}`);
    await handler({ params: { id: '1', userId: '2', ...params }, session: { user: { id: user } }, body }, res);
    return res;
  };
}
async function lockWaiting(pool, cluster) {
  for (let i = 0; i < 200; i++) {
    if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [cluster.connection.application_name])).rowCount) return true;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return false;
}
async function main() {
  const cluster = createIsolatedPostgres('key-queue');
  const postmasterPid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  assert(Number.isInteger(postmasterPid) && postmasterPid > 0);
  const pool = new Pool({ ...cluster.connection, max: 8, options: '-c statement_timeout=6000 -c idle_in_transaction_session_timeout=8000' });
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`CREATE TABLE api_keys (id integer PRIMARY KEY, user_id integer, current_model_id varchar(100), name text DEFAULT 'fixture', key_prefix text, custom_model_name text,
      fusion_panel_models jsonb, fusion_judge_model_id text, fusion_outer_model_id text, fusion_enabled boolean, fusion_synthesis_prompt_enabled boolean,
      quota_warning_enabled boolean, signature_enabled boolean, signature_template text, enabled boolean, swallow_images boolean, crewrouter_commands boolean,
      schedule_enabled boolean, schedule_on_time text, schedule_off_time text, schedule_days integer[], schedule_timezone text);
      CREATE TABLE users(id integer PRIMARY KEY, username text, email text);
      CREATE TABLE models (id varchar(100) PRIMARY KEY, provider integer, name text, enabled boolean DEFAULT true);
      CREATE TABLE providers (id integer PRIMARY KEY, enabled boolean, name text);
      CREATE TABLE team_models (team_id integer, model_id varchar(100), enabled boolean);
      CREATE TABLE user_teams (team_id integer, user_id integer);
      CREATE TABLE api_key_members (api_key_id integer REFERENCES api_keys(id) ON DELETE CASCADE, user_id integer, created_at timestamptz DEFAULT now(), UNIQUE(api_key_id,user_id));
      CREATE TABLE api_key_harness_models (api_key_id integer REFERENCES api_keys(id) ON DELETE CASCADE, harness text, model_id varchar(100) REFERENCES models(id), updated_at timestamptz, UNIQUE(api_key_id,harness));
      CREATE TABLE key_tags(id integer PRIMARY KEY, user_id integer, name text, color text, sort_order integer);
      CREATE TABLE api_key_tags(api_key_id integer REFERENCES api_keys(id) ON DELETE CASCADE, tag_id integer REFERENCES key_tags(id), UNIQUE(api_key_id,tag_id));
      CREATE TABLE usage_records(id integer PRIMARY KEY, api_key_id integer REFERENCES api_keys(id));
      INSERT INTO api_keys(id,user_id) VALUES (1,1); INSERT INTO providers VALUES(1,true,'fixture');
      INSERT INTO users VALUES(1,'owner','owner@fixture.invalid'),(2,'member','member@fixture.invalid');
      INSERT INTO models(id,provider,name) VALUES('a',1,'a'),('b',1,'b'); INSERT INTO team_models VALUES(1,'a',true),(1,'b',true);
      INSERT INTO user_teams VALUES(1,1); INSERT INTO api_key_members(api_key_id,user_id) VALUES(1,2);
      INSERT INTO key_tags VALUES(1,1,'tag','blue',0),(2,2,'foreign','red',0);`);
    const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    await pool.query(index.match(/CREATE TABLE IF NOT EXISTS api_key_models \([\s\S]*?\n      \)/)[0]);
    assert((await pool.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='api_key_models'::regclass")).rows.some(r => r.def === 'UNIQUE (api_key_id, model_id)'));

    for (const baseline of [true, false]) {
      await pool.query('DELETE FROM api_key_models');
      const firstDeleted = deferred(), releaseFirst = deferred(), secondReached = deferred();
      let connections = 0;
      const wrapped = { async connect() {
        const client = await pool.connect();
        const ordinal = ++connections;
        return { release: () => client.release(), async query(sql, params) {
          if (ordinal === 2 && /SELECT id FROM api_keys.*FOR UPDATE/.test(sql)) secondReached.resolve();
          const result = await client.query(sql, params);
          if (/DELETE FROM api_key_models/.test(sql)) {
            if (ordinal === 1) { firstDeleted.resolve(); await releaseFirst.promise; }
            else secondReached.resolve();
          }
          return result;
        } };
      } };
      const run = routes(wrapped, { baseline });
      const first = run('put', '/api-keys/:id/models', { modelIds: ['a'] });
      let second;
      let waiting;
      try {
        await Promise.race([firstDeleted.promise, first.then(result => { throw new Error(`writer failed before barrier: ${JSON.stringify(result.body)}`); })]);
        second = run('put', '/api-keys/:id/models', { modelIds: ['b'] });
        await Promise.race([secondReached.promise, second.then(result => { throw new Error(`second writer failed before barrier: ${JSON.stringify(result.body)}`); })]);
        waiting = baseline || await lockWaiting(pool, cluster);
      } finally { releaseFirst.resolve(); }
      assert.deepEqual((await Promise.all([first, second])).map(r => r.statusCode), [200, 200]);
      assert(waiting, 'replacement waits for a real PostgreSQL parent lock');
      assert.deepEqual((await pool.query('SELECT model_id FROM api_key_models ORDER BY model_id')).rows.map(r => r.model_id), baseline ? ['a', 'b'] : ['b']);
      const current = (await pool.query('SELECT current_model_id FROM api_keys')).rows[0].current_model_id;
      if (baseline) assert(['a', 'b'].includes(current));
      else assert.equal(current, 'b');
    }

    const run = routes(pool);
    const shared = [
      ['/api-keys/:id', { name: 'updated', customModelName: 'virtual' }],
      ['/api-keys/:id/models', { modelIds: ['b'] }],
      ['/api-keys/:id/harness-models', { harness: 'codex', modelId: 'b' }],
      ['/api-keys/:id/fusion-config', { panel_models: ['b'] }],
      ['/api-keys/:id/quota-warning', { quota_warning_enabled: true }],
      ['/api-keys/:id/signature', { signature_enabled: true, signature_template: 'fixture' }],
      ['/api-keys/:id/enabled', { enabled: true }],
      ['/api-keys/:id/swallow-images', { swallow_images: true }],
      ['/api-keys/:id/crewrouter-commands', { crewrouter_commands: true }],
      ['/api-keys/:id/schedule', { schedule_enabled: false }],
    ];
    for (const [route, body] of shared) {
      await pool.query('INSERT INTO api_key_members(api_key_id,user_id) VALUES(1,2) ON CONFLICT DO NOTHING');
      const accepted = await run('put', route, body, 2);
      assert.equal(accepted.statusCode, 200, `${route}: ${JSON.stringify(accepted.body)}`);
      const before = JSON.stringify((await pool.query('SELECT * FROM api_keys')).rows);
      const client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT id FROM api_keys WHERE id=1 FOR UPDATE');
      const pending = run('put', route, body, 2);
      let waiting;
      try {
        waiting = await lockWaiting(pool, cluster);
        await client.query('DELETE FROM api_key_members WHERE api_key_id=1 AND user_id=2');
        await client.query('COMMIT');
      } finally { await client.query('ROLLBACK'); client.release(); }
      assert.equal((await pending).statusCode, 404, `${route} revoked member`);
      assert(waiting, `${route} shares the key lock`);
      assert.equal(JSON.stringify((await pool.query('SELECT * FROM api_keys')).rows), before);
    }

    // Owner-only boundaries and self-leave preserve their distinct permissions.
    await pool.query('INSERT INTO api_key_members(api_key_id,user_id) VALUES(1,2)');
    const removeRoute = '/api-keys/:id/members/:userId(\\d+)';
    for (const [method, route, body] of [['post','/api-keys/:id/members',{identity:'member'}],['delete',removeRoute,{}],['put','/api-keys/:id/tags',{tagIds:[1]}],['delete','/api-keys/:id',{}]]) {
      assert.equal((await run(method,route,body,2)).statusCode, route === '/api-keys/:id' ? 404 : 403);
    }
    assert.equal((await run('delete','/api-keys/:id/members/me',{},1)).statusCode,403);
    assert.equal((await run('put','/api-keys/:id/tags',{tagIds:[2]},1)).statusCode,400);
    assert.equal((await run('put','/api-keys/:id/tags',{tagIds:[1]},1)).statusCode,200);

    for (const [route,user] of [[removeRoute,1],['/api-keys/:id/members/me',2]]) {
      await pool.query('INSERT INTO api_key_members(api_key_id,user_id) VALUES(1,2) ON CONFLICT DO NOTHING');
      const client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT id FROM api_keys WHERE id=1 FOR UPDATE');
      const pending = run('delete',route,{},user);
      let waiting;
      try { waiting = await lockWaiting(pool,cluster); await client.query('COMMIT'); }
      finally { await client.query('ROLLBACK'); client.release(); }
      assert.equal((await pending).statusCode,200);
      assert(waiting,'revocation waits for active settings writer');
    }

    assert.equal((await run('post','/api-keys/:id/members',{identity:'member'},1)).statusCode,201);
    assert.equal((await run('post','/api-keys/:id/members',{identity:'member'},1)).statusCode,409);

    // Mid-replacement failures cannot partially erase bindings or update current_model_id.
    await pool.query(`CREATE FUNCTION reject_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.model_id='a' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_mapping BEFORE INSERT ON api_key_models FOR EACH ROW EXECUTE FUNCTION reject_mapping();`);
    assert.equal((await run('put','/api-keys/:id/models',{modelIds:['a']},1)).statusCode,500);
    assert.deepEqual((await pool.query('SELECT model_id FROM api_key_models')).rows.map(r=>r.model_id),['b']);
    assert.equal((await pool.query('SELECT current_model_id FROM api_keys')).rows[0].current_model_id,'b');
    await pool.query('DROP TRIGGER reject_mapping ON api_key_models');

    // Cache failure after COMMIT must not turn a successful database write into HTTP 500.
    const invalidations = [];
    const cacheFailure = routes(pool,{ invalidate(id) { invalidations.push(id); throw new Error('fixture cache failure'); } });
    assert.equal((await cacheFailure('put','/api-keys/:id',{name:'committed'},1)).statusCode,200);
    assert.deepEqual(invalidations,[1]);
    assert.equal((await pool.query('SELECT name FROM api_keys')).rows[0].name,'committed');
    assert.equal((await run('delete','/api-keys/:id',{},1)).statusCode,200);
    assert.equal((await run('put','/api-keys/:id/enabled',{enabled:true},1)).statusCode,404);
    assert.equal((await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND state LIKE 'idle in transaction%'", [cluster.connection.application_name])).rowCount, 0, 'all transaction clients must finish before cleanup');
    console.log('API Key writes: baseline queue corruption reproduced; all shared writes, owner boundaries, revocation locks, rollback and cache-failure handling passed');
  } finally {
    await pool.end();
    cluster.stop();
    assert.throws(() => process.kill(postmasterPid, 0), error => error.code === 'ESRCH', 'temporary PostgreSQL process must exit');
    assert.equal(fs.existsSync(cluster.dataDir), false, 'temporary database directory must be removed');
    assert.equal(fs.existsSync(cluster.socketDir), false, 'temporary socket directory must be removed');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
