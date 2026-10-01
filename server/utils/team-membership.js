'use strict';

async function setUserTeam(client, userId, teamId) {
  await client.query('DELETE FROM user_teams WHERE user_id = $1', [userId]);
  if (teamId != null && teamId !== '') {
    await client.query(
      'INSERT INTO user_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET team_id = EXCLUDED.team_id',
      [userId, teamId]
    );
  }
  await client.query('UPDATE users SET team_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [teamId || null, userId]);
}

module.exports = { setUserTeam };
