'use strict';

function chooseTeamForUser({ groupTeamId, legacyTeamId, memberships = [] }) {
  if (groupTeamId) return groupTeamId;
  if (legacyTeamId) return legacyTeamId;
  const sorted = [...memberships].sort((a, b) => {
    const at = new Date(a.created_at || 0).getTime();
    const bt = new Date(b.created_at || 0).getTime();
    return at - bt || Number(a.team_id) - Number(b.team_id);
  });
  return sorted[0]?.team_id || null;
}

function normalizeTeamRules(rules) {
  if (Array.isArray(rules)) return rules;
  if (typeof rules === 'string') {
    try {
      const parsed = JSON.parse(rules);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }
  return [];
}

module.exports = { chooseTeamForUser, normalizeTeamRules };
