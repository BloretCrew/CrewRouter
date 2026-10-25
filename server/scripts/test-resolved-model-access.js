'use strict';

// Only synthetic catalog rows in an isolated Unix-socket PostgreSQL cluster.
// Extract the real gateway/Fusion access functions without application startup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const access = require('../utils/resolved-model-access');

function loadAccessFunctions(pool) {
  const api = fs.readFileSync(path.resolve(__dirname, '../routes/api.js'), 'utf8');
  const fusion = fs.readFileSync(path.resolve(__dirname, '../fusion/index.js'), 'utf8');
  const context = { pool, Logger: { error() {} }, require(id) {
    assert.equal(id, '../utils/resolved-model-access');
    return access;
  } };
  const source = api.slice(api.indexOf('async function getAuthorizedModelIds('), api.indexOf('\n}\n', api.indexOf('async function getAuthorizedModelIds(')) + 3)
    + api.slice(api.indexOf('async function getModelConfig('), api.indexOf('// 用量落库前的统计元数据'));
  vm.runInNewContext(source, context);
  const apiAccess = { authorize: context.getAuthorizedModelIds, resolve: context.getModelConfig };
  vm.runInNewContext(fusion.slice(fusion.indexOf('async function getModelConfig('), fusion.indexOf('async function getProviderForRequest(')), context);
  return { api: apiAccess, fusion: { authorize: context.assertModelAccessForUser, resolve: context.getModelConfig }, source: { api, fusion } };
}

async function main() {
  const cluster = createIsolatedPostgres('resolved-model');
  const pool = new Pool({ ...cluster.connection, max: 4 });
  try {
    await cluster.assertIsolation(pool);
    await pool.query(`
      CREATE TABLE providers(id text PRIMARY KEY, enabled boolean);
      CREATE TABLE models(id text PRIMARY KEY, alias text, upstream_model_id text, provider text REFERENCES providers(id), enabled boolean);
      CREATE TABLE team_models(team_id int, model_id text REFERENCES models(id), enabled boolean);
      CREATE TABLE user_teams(user_id int, team_id int);
      INSERT INTO providers VALUES('public',true),('restricted',true),('disabled',false);
      INSERT INTO models VALUES
        ('allowed','blocked','public-upstream','public',true),
        ('blocked','','restricted-upstream','restricted',true),
        ('legal','legal-alias','legal-upstream','public',true),
        ('a-restricted','duplicate-alias','duplicate-upstream','restricted',true),
        ('z-allowed','duplicate-alias','duplicate-upstream','public',true),
        ('offline','offline-alias','offline-upstream','disabled',true);
      INSERT INTO team_models VALUES(1,'allowed',true),(1,'legal',true),(1,'z-allowed',true),(1,'offline',true),
        (2,'blocked',true),(2,'a-restricted',true);
      INSERT INTO user_teams VALUES(7,1),(8,2);
    `);
    const fixtures = loadAccessFunctions(pool);
    for (const userId of [undefined, null, '', 0]) {
      await assert.rejects(fixtures.fusion.authorize(['legal'], userId), error => error.code === 'model_access_denied');
      await assert.rejects(fixtures.fusion.authorize([], userId), error => error.code === 'model_access_denied');
    }
    console.log('PASS Fusion rejects missing identities even with an empty model list');
    for (const [name, boundary] of Object.entries({ api: fixtures.api, fusion: fixtures.fusion })) {
      const denied = async input => {
        if (name === 'api') assert.equal((await boundary.authorize(7, [input])).has(input), false);
        else await assert.rejects(boundary.authorize([input], 7), error => error.code === 'model_access_denied');
        assert.equal(await boundary.resolve(input, 7), null);
      };
      await denied('blocked');
      await denied('duplicate-alias');
      await denied('offline-alias');
      assert.equal((await boundary.resolve('legal-alias', 7)).id, 'legal');
      assert.equal((await boundary.resolve('legal', 7)).id, 'legal');
      assert.equal((await boundary.resolve('blocked', 8)).id, 'blocked');
      assert.equal(await boundary.resolve('missing', 7), null);
      assert.equal(await boundary.resolve('legal', null), null);
      console.log(`PASS ${name}: exact ID collisions, duplicate aliases, foreign Teams and disabled providers fail closed; legitimate aliases work`);
    }
    await assert.rejects(fixtures.fusion.authorize(['duplicate-upstream'], 7), error => error.code === 'model_access_denied');
    assert.equal(await fixtures.fusion.resolve('duplicate-upstream', 7), null);
    assert.equal((await fixtures.fusion.resolve('legal-upstream', 7)).id, 'legal');
    assert((await fixtures.api.authorize(7, ['legal-upstream'])).has('legal-upstream'), 'shared preflight preserves Fusion upstream bindings');
    assert.equal(await fixtures.api.resolve('legal-upstream', 7), null, 'ordinary API keeps its existing id/alias contract');
    console.log('PASS Fusion upstream-name fallback checks the exact resolved local model');

    // Authorization succeeded before a catalog edit; execution must resolve and
    // authorize the new row rather than trust the earlier allowed input string.
    assert((await fixtures.api.authorize(7, ['legal-alias'])).has('legal-alias'));
    await pool.query("UPDATE models SET alias='' WHERE id='legal'; UPDATE models SET alias='legal-alias' WHERE id='blocked'");
    assert.equal(await fixtures.api.resolve('legal-alias', 7), null);
    assert.equal(await fixtures.fusion.resolve('legal-alias', 7), null);
    console.log('PASS changing an alias after preflight cannot switch execution to an unauthorized model');

    // Even if the alias changes during the final permission lookup, the returned
    // object remains the row that was actually checked, with no second resolution.
    await pool.query("UPDATE models SET alias='' WHERE id='blocked'; UPDATE models SET alias='legal-alias' WHERE id='legal'");
    let switched = false;
    const changingCatalog = { async query(sql, args) {
      if (!switched && sql.startsWith('SELECT m.id FROM models m')) {
        switched = true;
        await pool.query("UPDATE models SET alias='' WHERE id='legal'; UPDATE models SET alias='legal-alias' WHERE id='blocked'");
      }
      return pool.query(sql, args);
    } };
    assert.equal((await access.resolveAuthorizedModelConfig(changingCatalog, 7, 'legal-alias')).id, 'legal');
    console.log('PASS the final permission check returns the same concrete model object');

    // Verify every actual gateway model execution and Fusion streaming synthesis
    // uses the scoped resolver; metadata-only billing lookups are intentionally separate.
    assert.equal((fixtures.source.api.match(/getModelConfig\(queueModelId, req\.apiUser\.userId\)/g) || []).length, 3);
    const processSource = fixtures.source.fusion.slice(fixtures.source.fusion.indexOf('async function processFusion('));
    assert(processSource.indexOf('await assertModelAccessForUser([], requestUserId)') < processSource.indexOf('await getFusionConfig('));
    assert.match(fixtures.source.fusion, /getModelConfig\(modelId, options\.requestUserId \?\? null\)/);
    assert.match(fixtures.source.fusion, /getModelConfig: modelId => getModelConfig\(modelId, requestUserId \?\? null\)/);
    assert.match(fixtures.source.fusion, /getModelConfig\(fusionConfig\.outer_model_id, requestUserId \?\? null\)/);
    assert.match(fixtures.source.fusion, /return callModel\(modelId, messages, \{ \.\.\.callOptions, requestContext, signal, requestUserId \}\)/);
    console.log('PASS OpenAI, Anthropic, Responses and both Fusion execution modes use scoped resolution');
  } finally {
    await pool.end();
    const pid = Number(fs.readFileSync(path.join(cluster.dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]);
    cluster.stop();
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    assert.equal(fs.existsSync(cluster.dataDir), false);
    assert.equal(fs.existsSync(cluster.socketDir), false);
    console.log('PASS temporary database PID, data directory and socket directory are gone');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
