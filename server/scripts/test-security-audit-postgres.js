'use strict';

// No deployment config or inherited database URL is accepted by this regression.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Client } = require('pg');
const { HARNESS_SOURCES } = require('../utils/request-source');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const source = read('security-audit.js');
const tables = {
  apiKeyQueues: ['api_key_models'], apiKeyHarness: ['api_key_harness_models'],
  promptRecords: ['inject_prompts'], promptBindings: ['inject_prompts', 'inject_prompt_key_bindings'],
};
// Run the repository's exact aggregation block, without loading application startup.
const block = source.slice(source.indexOf('    for (const [section, tables] of Object.entries(NEW_CHECK_TABLES))'), source.indexOf("    activeCheck = 'catalog';"));
const runAggregates = vm.runInNewContext(`(async function(client, missing) {
  const report = { checks: {} }; const schemaShape = { optionalMissing: missing }; let activeCheck;
  ${block}
  return report.checks;
})`, { NEW_CHECK_TABLES: tables, HARNESS_SOURCES });

(async () => {
  const cluster = createIsolatedPostgres('audit');
  const client = new Client(cluster.connection);
  const pid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
  try {
    await client.connect();
    await cluster.assertIsolation(client);
    await client.query('CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE models(id VARCHAR(100) PRIMARY KEY); CREATE TABLE api_keys(id INTEGER PRIMARY KEY,user_id INTEGER,current_model_id TEXT)');
    const schema = read('../index.js');
    for (const name of ['api_key_models', 'api_key_harness_models', 'inject_prompts', 'inject_prompt_key_bindings']) {
      const ddl = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n      \\)`));
      assert(ddl, name); await client.query(ddl[0]);
    }
    await client.query(`INSERT INTO users VALUES(1),(2); INSERT INTO models VALUES('m'),('other');
      INSERT INTO api_keys VALUES(1,1,'other'),(2,2,NULL);
      INSERT INTO api_key_models(api_key_id,model_id) VALUES(1,'m'),(1,'other');
      INSERT INTO api_key_harness_models(api_key_id,harness,model_id) VALUES(1,'codex','m');
      INSERT INTO inject_prompts(user_id,name,content) VALUES(1,'default','same'),(1,'default','same');
      INSERT INTO inject_prompt_key_bindings VALUES(1,1)`);
    // Legacy null owner and current model outside queue are allowed; equal ordering is allowed.
    await client.query(`ALTER TABLE inject_prompts ALTER COLUMN user_id DROP NOT NULL;
      INSERT INTO inject_prompts(user_id,name,content) VALUES(NULL,'legacy','legacy');
      INSERT INTO inject_prompt_key_bindings VALUES(3,2);
      DELETE FROM api_key_models WHERE model_id='other'`);
    async function snapshot(missing = []) {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        assert.equal((await client.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0].mode, 'on');
        await assert.rejects(client.query('DELETE FROM users'), { code: '25006' });
        // A rejected write aborts the transaction; start a fresh read-only snapshot.
        await client.query('ROLLBACK');
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return await runAggregates(client, missing);
      } finally { await client.query('ROLLBACK'); }
    }
    const clean = await snapshot();
    for (const values of Object.values(clean)) for (const [key, value] of Object.entries(values)) {
      if (!['total','tableMissing','missingTables'].includes(key)) assert.equal(value, 0, key);
    }
    assert.equal(clean.promptRecords.total, 3);
    // Corrupted legacy shapes can lack constraints; audits must still count broken references.
    for (const table of ['api_key_models','api_key_harness_models','inject_prompts','inject_prompt_key_bindings']) {
      const constraints = await client.query('SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN (\'f\',\'u\',\'p\')', [table]);
      for (const { conname } of constraints.rows) await client.query(`ALTER TABLE ${table} DROP CONSTRAINT "${conname.replaceAll('"','""')}" CASCADE`);
    }
    await client.query(`INSERT INTO api_key_models(api_key_id,model_id) VALUES(99,'missing'),(1,'m');
      INSERT INTO api_key_harness_models(api_key_id,harness,model_id) VALUES(99,'invalid','missing'),(1,'codex','m');
      INSERT INTO inject_prompts(user_id,name,content) VALUES(99,'orphan','x');
      INSERT INTO inject_prompt_key_bindings VALUES(99,99),(1,2),(1,1)`);
    const bad = await snapshot();
    for (const values of Object.values(bad)) for (const [key, value] of Object.entries(values)) {
      if (!['total','tableMissing','missingTables'].includes(key)) assert(value > 0, key);
    }
    await client.query('DROP TABLE inject_prompts');
    const missing = await snapshot(['inject_prompts']);
    assert.equal(missing.promptBindings.tableMissing, true);
    assert.equal(missing.promptBindings.missingTables[0], 'inject_prompts');
    console.log('Isolated PostgreSQL audit aggregates, repository DDL, corruption and legacy boundaries passed.');
  } finally {
    await client.end(); cluster.stop();
    assert.equal(fs.existsSync(cluster.dataDir), false);
    assert.equal(fs.existsSync(cluster.socketDir), false);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
