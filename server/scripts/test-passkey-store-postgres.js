'use strict';

const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');
const { withLockedPasskeys } = require('../utils/passkey-store');

(async () => {
  const cluster = createIsolatedPostgres('passkey');
  const pool = new Pool({ ...cluster.connection, max: 4 });
  try {
    await cluster.assertIsolation(pool);
    await pool.query("CREATE TABLE users(id INTEGER PRIMARY KEY, passkeys JSONB DEFAULT '[]'::jsonb)");
    const credential = { credentialID: 'revoked', credentialPublicKey: 'a2V5', counter: 0 };
    await pool.query('INSERT INTO users(id,passkeys) VALUES(1,$1),(2,$1)', [JSON.stringify([credential])]);

    // Pause a deletion while a login is waiting on its row. The login must read
    // the committed deletion rather than write a stale array back over it.
    let deleted;
    const deletionStarted = new Promise(resolve => { deleted = resolve; });
    let releaseDelete;
    const holdDelete = new Promise(resolve => { releaseDelete = resolve; });
    const deleting = withLockedPasskeys(pool, 1, async (_user, keys) => { keys.splice(0, 1); deleted(); await holdDelete; });
    await deletionStarted;
    let sawDeleted = false;
    const loggingIn = withLockedPasskeys(pool, 1, (_user, keys) => {
      sawDeleted = keys.length === 0;
      assert.equal(keys.some(key => key.credentialID === 'revoked'), false);
      throw Object.assign(new Error('revoked'), { code: 'REVOKED' });
    });
    try {
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM users WHERE id = $1%'", [cluster.connection.application_name]);
        if (result.rows[0].n > 0) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(blocked, 'login actually waits for the deletion row lock');
    } finally { releaseDelete(); }
    await deleting;
    await assert.rejects(loggingIn, { code: 'REVOKED' });
    assert(sawDeleted);
    assert.deepEqual((await pool.query('SELECT passkeys FROM users WHERE id=1')).rows[0].passkeys, []);

    // Concurrent registration of the same credential to two users has one
    // winner even though the credential lives inside a JSONB array.
    const newCredential = { credentialID: 'unique', credentialPublicKey: 'cGs', counter: 0 };
    const results = await Promise.allSettled([1, 2].map(id => withLockedPasskeys(pool, id, (_user, keys) => { keys.push(newCredential); }, 'unique')));
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(results.find(item => item.status === 'rejected').reason.status, 409);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM users,
      LATERAL jsonb_array_elements(passkeys) pk WHERE pk->>'credentialID'='unique'`)).rows[0].n, 1);

    // Distinct registrations on one user preserve both credentials; a failing
    // mutation rolls back without poisoning the pooled connection.
    await Promise.all(['a', 'b'].map(id => withLockedPasskeys(pool, 1, (_user, keys) => { keys.push({ ...newCredential, credentialID: id }); }, id)));
    let keys = (await pool.query('SELECT passkeys FROM users WHERE id=1')).rows[0].passkeys;
    assert(keys.some(item => item.credentialID === 'a') && keys.some(item => item.credentialID === 'b'));
    const before = JSON.stringify(keys);
    await assert.rejects(withLockedPasskeys(pool, 1, (_user, current) => { current.length = 0; throw new Error('rollback'); }), /rollback/);
    keys = (await pool.query('SELECT passkeys FROM users WHERE id=1')).rows[0].passkeys;
    assert.equal(JSON.stringify(keys), before);
    await assert.rejects(withLockedPasskeys(pool, 99, () => {}), { status: 404 });
    console.log('Isolated PostgreSQL PassKey revocation, cross-account uniqueness, concurrent registration and rollback passed.');
  } finally { await pool.end(); cluster.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
