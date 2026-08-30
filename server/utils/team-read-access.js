'use strict';

/**
 * Build the canonical read predicate for a user's Team-scoped data.
 */
function buildTeamReadPredicate(userId, { teamAlias = 't', membershipAlias = 'ut', paramIndex = 1 } = {}) {
  if (!Number.isInteger(Number(userId)) || Number(userId) <= 0) throw new TypeError('userId must be a positive integer');
  const userParam = `$${paramIndex}`;
  return {
    sql: `EXISTS (SELECT 1 FROM user_teams ${membershipAlias} WHERE ${membershipAlias}.team_id = ${teamAlias}.id AND ${membershipAlias}.user_id = ${userParam})`,
    params: [Number(userId)],
  };
}

function buildTeamReadQuery(userId, sql, options = {}) {
  const predicate = buildTeamReadPredicate(userId, options);
  return { sql: `${sql} WHERE ${predicate.sql}`, params: predicate.params };
}

module.exports = { buildTeamReadPredicate, buildTeamReadQuery };
