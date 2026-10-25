'use strict';

// Callers own a transaction and lock the destination Team before the user.
// A pool would auto-commit each statement and can split the two projections.
async function setUserTeam(client, userId, teamId) {
  if (!client || typeof client.release !== 'function') throw new TypeError('setUserTeam requires a checked-out transactional client');
  const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!user.rows.length) throw Object.assign(new Error('用户不存在'), { status: 404 });
  await client.query('DELETE FROM user_teams WHERE user_id = $1', [userId]);
  if (teamId != null && teamId !== '') {
    await client.query(
      'INSERT INTO user_teams (user_id, team_id) VALUES ($1, $2)',
      [userId, teamId]
    );
  }
  await client.query('UPDATE users SET team_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [teamId || null, userId]);
}

// Used for a newly registered Feishu user. Assignment is atomic and does not
// overwrite an administrator's assignment made while registration was running.
async function assignInitialUserTeam(pool, userId, username) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const defaultTeam = await client.query('SELECT id FROM teams WHERE is_default = TRUE ORDER BY id LIMIT 1 FOR SHARE');
    const user = await client.query('SELECT id, team_id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!user.rows.length) throw Object.assign(new Error('用户不存在'), { status: 404 });
    const membership = await client.query('SELECT team_id FROM user_teams WHERE user_id = $1', [userId]);
    if (user.rows[0].team_id != null || membership.rows.length) {
      await client.query('COMMIT');
      return;
    }
    let teamId = defaultTeam.rows[0]?.id;
    if (teamId == null) {
      const personal = await client.query(
        'INSERT INTO teams (name, description, is_personal) VALUES ($1, $2, TRUE) RETURNING id',
        [`${username} 的个人账户`, '个人账户，系统自动创建']
      );
      teamId = personal.rows[0].id;
    }
    await setUserTeam(client, userId, teamId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { setUserTeam, assignInitialUserTeam };
