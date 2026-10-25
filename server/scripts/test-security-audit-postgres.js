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
  oauthTokens: ['oauth_tokens'], oauthCodes: ['oauth_auth_codes'], authInvites: ['auth_invites'],
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
    await client.query(`CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, email TEXT, is_admin BOOLEAN DEFAULT FALSE, github_id TEXT, feishu_open_id TEXT, passport_username TEXT, passkeys JSONB DEFAULT '[]'::jsonb, two_factor_enabled BOOLEAN DEFAULT FALSE, temp_totp_secret JSONB); CREATE TABLE models(id VARCHAR(100) PRIMARY KEY); CREATE TABLE api_keys(id INTEGER PRIMARY KEY,user_id INTEGER,current_model_id TEXT)`);
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
    await client.query('CREATE TABLE teams(id INTEGER PRIMARY KEY)');
    const oauthSchema = read('../routes/oauth.js');
    for (const name of ['oauth_tokens', 'oauth_auth_codes']) {
      const ddl = oauthSchema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n    \\)`));
      assert(ddl, name); await client.query(ddl[0]);
    }
    const inviteDdl = schema.match(/CREATE TABLE IF NOT EXISTS auth_invites \([\s\S]*?\n    \)/);
    assert(inviteDdl); await client.query(inviteDdl[0]);
    await client.query('ALTER TABLE auth_invites ADD COLUMN max_uses INTEGER DEFAULT 1, ADD COLUMN used_count INTEGER DEFAULT 0, ADD COLUMN team_id INTEGER');
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
    for (const values of ['apiKeyQueues','apiKeyHarness','promptRecords','promptBindings'].map(name => bad[name])) for (const [key, value] of Object.entries(values)) {
      if (!['total','tableMissing','missingTables'].includes(key)) assert(value > 0, key);
    }
    // Exercise the new grant aggregates with real table definitions, including
    // orphaned owners, cross-account keys, active and expired/revoked grants.
    await client.query(`INSERT INTO oauth_tokens(token_hash,user_id,api_key_id,client_id,scope,kind,expires_at,revoked) VALUES
      ('access',1,1,'c','gateway:invoke','access',now()+interval '1 hour',FALSE),
      ('refresh',1,1,'c','gateway:invoke','refresh',now()+interval '1 hour',FALSE),
      ('revoked',1,1,'c','gateway:invoke','access',now()+interval '1 hour',TRUE),
      ('expired',1,1,'c','gateway:invoke','access',now()-interval '1 hour',FALSE),
      ('orphan',99,99,'c','gateway:invoke','access',now()-interval '1 hour',FALSE),
      ('cross',2,1,'c','gateway:invoke','access',now()-interval '1 hour',FALSE);
      INSERT INTO oauth_auth_codes VALUES('code','c',1,1,'gateway:invoke','challenge',now()+interval '1 hour',FALSE),
        ('bad','c',2,1,'gateway:invoke','challenge',now()-interval '1 hour',FALSE),
        ('orphan','c',99,99,'gateway:invoke','challenge',now()-interval '1 hour',FALSE);
      INSERT INTO auth_invites(token_hash,created_by,expires_at,max_uses,used_count,team_id)
        VALUES('invite',1,now()+interval '1 hour',1,0,99)`);
    const grants = await snapshot();
    assert.equal(grants.oauthTokens.activeAccessTokens, 1);
    assert.equal(grants.oauthTokens.activeRefreshTokens, 1);
    assert.equal(grants.oauthTokens.orphanPrincipals, 1);
    assert.equal(grants.oauthTokens.ownerMismatches, 1);
    assert.equal(grants.oauthCodes.activeCodes, 1);
    assert.equal(grants.oauthCodes.orphanPrincipals, 1);
    assert.equal(grants.oauthCodes.ownerMismatches, 1);
    assert.equal(grants.authInvites.activeInvites, 1);
    assert.equal(grants.authInvites.orphanTeams, 1);
    // Credential aggregates never return raw IDs, public keys or TOTP secrets.
    const identitySql = source.match(/report\.checks\.identities = \(await client\.query\(`([\s\S]*?)`\)\)\.rows\[0\];/)[1];
    await client.query(`UPDATE users SET username='user-'||id,email='user-'||id||'@test.invalid';
      UPDATE users SET passkeys='[{"credentialID":"hidden-id","credentialPublicKey":"hidden-key"}]',
        is_admin=TRUE,two_factor_enabled=TRUE,temp_totp_secret='{"base32":"hidden-secret"}' WHERE id=1;
      UPDATE users SET passkeys='[{"credentialID":"hidden-id","credentialPublicKey":"hidden-key"}]' WHERE id=2`);
    const identity = (await client.query(identitySql)).rows[0];
    assert.equal(identity.usersWithPasskeys, 2); assert.equal(identity.adminsWithPasskeys, 1);
    assert.equal(identity.twoFactorEnabledAdmins, 1); assert.equal(identity.temporaryTotpSecrets, 1);
    assert.equal(identity.duplicateCredentialIds, 1); assert.equal(identity.malformedPasskeys, 0);
    assert(!JSON.stringify(identity).includes('hidden-'));
    await client.query(`UPDATE users SET passkeys='{}' WHERE id=1; UPDATE users SET passkeys='[{}]' WHERE id=2`);
    assert.equal((await client.query(identitySql)).rows[0].malformedPasskeys, 2);
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
