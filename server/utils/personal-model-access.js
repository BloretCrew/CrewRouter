'use strict';

const config = require('../config-loader');
const { loadPersistedEdition, normalizeEdition } = require('./instance-edition');

async function addModelsToPersonalTeams(db, modelIds) {
  const ids = Array.isArray(modelIds)
    ? [...new Set(modelIds.filter(Boolean).map(String))]
    : (modelIds ? [String(modelIds)] : []);
  if (ids.length === 0) return 0;

  const persisted = await loadPersistedEdition(db);
  const personal = persisted
    ? persisted === 'personal'
    : normalizeEdition(config.edition) === 'personal' || config.personal === true;
  if (!personal) return 0;

  // Login creates personal teams; orphan teams must not receive model access.
  const result = await db.query(
    `INSERT INTO team_models (team_id, model_id, enabled)
     SELECT t.id, m.id, TRUE
     FROM teams t
     CROSS JOIN models m
     JOIN providers p ON p.id = m.provider AND p.enabled = TRUE
     WHERE t.is_personal = TRUE
       AND m.id = ANY($1::text[]) AND m.enabled = TRUE
       AND EXISTS (
         SELECT 1 FROM user_teams ut
         JOIN users u ON u.id = ut.user_id
         WHERE ut.team_id = t.id
       )
     ON CONFLICT (team_id, model_id) DO NOTHING`,
    [ids]
  );
  return result.rowCount || 0;
}

module.exports = { addModelsToPersonalTeams };
