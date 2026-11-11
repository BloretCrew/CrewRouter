'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { Pool } = require('pg');
const { createIsolatedPostgresFixture } = require('./test-support/isolated-postgres');
const source = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
function declaration(name, prefix) {
  const start = source.indexOf(`${prefix} ${name}`);
  const end = source.indexOf('\n}', start);
  assert(start >= 0 && end > start, name);
  return source.slice(start, end + 2);
}
function worker(pool) {
  const context = vm.createContext({ pool, Date, Map, Set,
    getAuthorizedModelIds: async () => new Set(), invalidateApiKeyCacheByKeyId() {} });
  vm.runInContext(declaration('ApiKeyLifecycleError', 'class') + '\n'
    + declaration('refreshApiUserModelAuthorization', 'async function')
    + '\nthis.refresh = refreshApiUserModelAuthorization;', context);
  // Independent worker caches intentionally remain warm across database writes.
  const cached = { keyId: 11, userId: 7, signatureEnabled: true, signatureTemplate: 'stale' };
  return { cached, request: () => context.refresh(cached) };
}

test('independent warm workers refresh inherited and explicit signature policy after committed writes', async t => {
  const cluster = createIsolatedPostgresFixture(t, 'signature-workers');
  const pool = cluster.track(new Pool(cluster.connection));
  await cluster.assertIsolation(pool);
  await pool.query(`CREATE TABLE users(id INTEGER PRIMARY KEY, api_signature_enabled BOOLEAN, api_signature_template TEXT);
    CREATE TABLE api_keys(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), current_model_id TEXT,
      fusion_panel_models JSONB, fusion_judge_model_id TEXT, fusion_outer_model_id TEXT,
      enabled BOOLEAN, expires_at TIMESTAMPTZ, signature_enabled BOOLEAN, signature_template TEXT);
    CREATE TABLE api_key_models(id SERIAL PRIMARY KEY,api_key_id INTEGER,model_id TEXT,enabled BOOLEAN,sort_order INTEGER);
    CREATE TABLE api_key_harness_models(api_key_id INTEGER,harness TEXT,model_id TEXT);
    INSERT INTO users VALUES(7,TRUE,'user-template');
    INSERT INTO api_keys(id,user_id,enabled) VALUES(11,7,TRUE)`);
  const workers = [worker(pool), worker(pool)];
  async function expect(enabled, template, explicit = null) {
    for (const w of workers) {
      const current = await w.request();
      assert.equal(current.signatureEnabled, enabled);
      assert.equal(current.signatureTemplate, template);
      assert.equal(current.keySignatureEnabled, explicit);
    }
  }
  await expect(true, 'user-template');
  await pool.query('UPDATE users SET api_signature_enabled=FALSE WHERE id=7');
  await expect(false, 'user-template');
  await pool.query("UPDATE users SET api_signature_enabled=TRUE,api_signature_template='updated' WHERE id=7");
  await expect(true, 'updated');
  await pool.query("UPDATE api_keys SET signature_enabled=FALSE,signature_template='key-template' WHERE id=11");
  await expect(false, 'key-template', false);
  await pool.query('UPDATE api_keys SET signature_enabled=TRUE WHERE id=11; UPDATE users SET api_signature_enabled=FALSE WHERE id=7');
  await expect(true, 'key-template', true);
  await pool.query('UPDATE api_keys SET signature_enabled=NULL,signature_template=NULL WHERE id=11');
  await expect(false, 'updated');
  const inFlight = { ...await workers[0].request() };
  await pool.query("UPDATE users SET api_signature_enabled=TRUE,api_signature_template='next-request' WHERE id=7");
  assert.equal(inFlight.signatureEnabled, false, 'already authorized requests retain their snapshot');
  await expect(true, 'next-request');
  await pool.query('DROP TABLE users CASCADE');
  await assert.rejects(workers[0].request(), /users/);
});
