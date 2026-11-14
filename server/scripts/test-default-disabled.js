'use strict';

// Run extracted application SQL and prompt handlers only in a disposable cluster.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { Pool } = require('pg');
const { createIsolatedPostgresFixture } = require('./test-support/isolated-postgres');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const startup = read('index.js');
const init = read('scripts/init-db.js');
const Logger = { info() {}, warn() {}, error() {} };

function migration(name, pool) {
  const start = startup.indexOf(`async function ${name}()`);
  const end = startup.indexOf('\n}', start);
  assert(start >= 0 && end > start, name);
  return vm.runInNewContext(`(${startup.slice(start, end + 2)})`, { pool, Logger })();
}

function createTable(source, table) {
  const match = source.match(new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\n      \\)'));
  assert(match, table);
  return match[0];
}

function promptModule(pool) {
  const module = { exports: {} };
  vm.runInNewContext(read('utils/inject-prompt.js'), { module, Buffer, Date, require(id) {
    if (id === '../logger') return Logger;
    assert.equal(id, '../models/database');
    return { pool };
  } });
  return module.exports;
}

function promptRoutes(pool) {
  const routes = new Map();
  const router = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    router[method] = (route, ...handlers) => routes.set(`${method} ${route}`, handlers.at(-1));
  }
  const dependencies = { express: { Router: () => router }, '../models/database': { pool },
    '../logger': Logger, '../middleware/auth': { requireAuth() {} },
    './api': { invalidateUserApiKeyCache() {} } };
  vm.runInNewContext(read('routes/inject-prompts.js'), { Buffer, module: { exports: {} }, require(id) {
    assert(Object.hasOwn(dependencies, id), id);
    return dependencies[id];
  } });
  return async (method, route, body, id) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await routes.get(`${method} ${route}`)({ authUser: { id: 1 }, params: { id }, body }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    return res.body.item;
  };
}

test('fresh database, every key creation entry and prompt creation default to disabled', async t => {
  const cluster = createIsolatedPostgresFixture(t, 'default-disabled');
  const pool = cluster.track(new Pool(cluster.connection));
  await cluster.assertIsolation(pool);
  await pool.query(createTable(init, 'users'));
  await pool.query("INSERT INTO users(username,email,password_hash) VALUES ('fixture','fixture@example.test','not-a-password')");
  assert.equal((await pool.query('SELECT api_signature_enabled FROM users')).rows[0].api_signature_enabled, false);
  await pool.query(createTable(init, 'api_keys'));
  await migration('ensureInjectPromptsTable', pool);
  await pool.query("INSERT INTO api_keys(user_id,key_hash) VALUES (1,'omitted')");
  const flags = row => [row.quota_warning_enabled, row.crewrouter_commands];
  assert.deepEqual(flags((await pool.query('SELECT * FROM api_keys')).rows[0]), [false, false]);

  for (const file of ['user.js', 'setup.js', 'passport-auth.js', 'feishu.js']) {
    const statements = [...read(`routes/${file}`).matchAll(/`(INSERT INTO api_keys[\s\S]*?)`/g)];
    assert.equal(statements.length, 1, `${file}: cover each creation statement`);
    const sql = statements[0][1];
    const args = file === 'user.js'
      ? [1, file, `sk-${file}`, 'prefix', 'fixture', null, 'model', '[]']
      : [1, file, `sk-${file}`, 'prefix', '[]'];
    await pool.query(sql, args);
    const row = (await pool.query('SELECT * FROM api_keys WHERE key_hash=$1', [file])).rows[0];
    assert.deepEqual(flags(row), [false, false], file);
  }
  const prompts = promptModule(pool);
  await prompts.seedDefaultPrompt(1);
  const seeded = (await pool.query('SELECT * FROM inject_prompts')).rows[0];
  assert.equal(seeded.name, '忽略 @CrewRouter');
  assert.equal(seeded.enabled, false);
  assert.equal(await prompts.buildInjectedPrompt(1, 1), null);
  const request = promptRoutes(pool);
  for (const enabled of [undefined, false, true]) {
    const item = await request('post', '/inject-prompts', { name: 'fixture', content: 'explicit-note', ...(enabled === undefined ? {} : { enabled }) });
    assert.equal(item.enabled, enabled === true);
    if (enabled === true) {
      const updated = await request('put', '/inject-prompts/:id(\\d+)', { name: 'renamed' }, String(item.id));
      assert.equal(updated.enabled, true, 'partial updates retain explicit choice');
    }
  }
  assert.match(await prompts.buildInjectedPrompt(1, 1), /explicit-note/);
  await prompts.seedDefaultPrompt(1);
  assert.equal((await pool.query('SELECT enabled FROM inject_prompts WHERE id=$1', [seeded.id])).rows[0].enabled, false);
});

test('startup and initialization change old defaults without rewriting existing choices', async t => {
  const cluster = createIsolatedPostgresFixture(t, 'disabled-upgrade');
  const pool = cluster.track(new Pool(cluster.connection));
  await cluster.assertIsolation(pool);
  await pool.query(`CREATE TABLE users(id SERIAL PRIMARY KEY, api_signature_enabled BOOLEAN DEFAULT TRUE);
    INSERT INTO users(api_signature_enabled) VALUES(TRUE),(FALSE),(NULL);
    CREATE TABLE api_keys(id SERIAL PRIMARY KEY, quota_warning_enabled BOOLEAN DEFAULT TRUE, crewrouter_commands BOOLEAN DEFAULT TRUE);
    INSERT INTO api_keys(quota_warning_enabled,crewrouter_commands) VALUES(TRUE,TRUE),(FALSE,FALSE),(NULL,NULL)`);
  await migration('ensureInjectPromptsTable', pool);
  await pool.query('ALTER TABLE inject_prompts ALTER COLUMN enabled SET DEFAULT TRUE');
  await pool.query("INSERT INTO inject_prompts(user_id,name,content,enabled) VALUES (1,'on','on',TRUE),(2,'off','off',FALSE)");
  const before = async () => ({ users: (await pool.query('SELECT * FROM users ORDER BY id')).rows,
    keys: (await pool.query('SELECT * FROM api_keys ORDER BY id')).rows,
    prompts: (await pool.query('SELECT * FROM inject_prompts ORDER BY id')).rows });
  await migration('ensureApiKeySignatureColumns', pool);
  const snapshot = await before();
  for (let i = 0; i < 2; i++) {
    for (const name of ['ensureApiSignatureColumns', 'ensureApiKeySignatureColumns', 'ensureApiKeyCrewRouterCommands', 'ensureInjectPromptsTable']) {
      await migration(name, pool);
    }
  }
  // The first signature migration adds a template column; ignore only that schema addition.
  snapshot.users.forEach(row => { row.api_signature_template = ''; });
  assert.deepEqual(await before(), snapshot, 'startup must not rewrite true, false, or NULL choices');
  assert(!startup.includes('migration_enable_quota_warning_for_all_api_keys_v1'));
  assert(!/UPDATE api_keys SET quota_warning_enabled = TRUE/.test(startup));
  for (const column of ['quota_warning_enabled', 'crewrouter_commands']) {
    const statement = init.match(new RegExp("'ALTER TABLE api_keys ALTER COLUMN " + column + " SET DEFAULT FALSE'"));
    assert(statement, `init-db upgrades ${column}`);
    await pool.query(`ALTER TABLE api_keys ALTER COLUMN ${column} SET DEFAULT TRUE`);
    await pool.query(statement[0].slice(1, -1));
  }
  await pool.query('INSERT INTO users DEFAULT VALUES; INSERT INTO api_keys DEFAULT VALUES');
  await pool.query("INSERT INTO inject_prompts(user_id,name,content) VALUES (4,'default','default')");
  assert.equal((await pool.query('SELECT api_signature_enabled FROM users WHERE id=4')).rows[0].api_signature_enabled, false);
  assert.equal((await pool.query('SELECT api_signature_template FROM users WHERE id=4')).rows[0].api_signature_template, '');
  const key = (await pool.query('SELECT * FROM api_keys WHERE id=4')).rows[0];
  assert.equal(key.quota_warning_enabled, false);
  assert.equal(key.crewrouter_commands, false);
  assert.equal((await pool.query('SELECT enabled FROM inject_prompts WHERE user_id=4')).rows[0].enabled, false);
});
