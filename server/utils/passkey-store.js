'use strict';

// All PassKey mutations lock the latest user row, so counter writes cannot
// restore a credential deleted by another request or overwrite a registration.
async function withLockedPasskeys(pool, userId, mutate, credentialId = null) {
  const { normalizePasskeys } = require('./PassKey');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    if (credentialId) {
      // JSONB has no cross-row uniqueness constraint. Registrations of the same
      // credential serialize across accounts before checking for duplicates.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('crewrouter-passkey'), hashtext($1))", [credentialId]);
    }
    const found = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = found.rows[0];
    if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
    if (credentialId) {
      const duplicate = await client.query(`SELECT id FROM users WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(passkeys, '[]'::jsonb)) pk
        WHERE pk->>'credentialID' = $1) LIMIT 1`, [credentialId]);
      if (duplicate.rows.length) throw Object.assign(new Error('该通行密钥已注册'), { status: 409 });
    }
    const passkeys = normalizePasskeys(user.passkeys);
    const result = await mutate(user, passkeys);
    await client.query('UPDATE users SET passkeys = $1::jsonb WHERE id = $2', [JSON.stringify(passkeys), userId]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { withLockedPasskeys };
