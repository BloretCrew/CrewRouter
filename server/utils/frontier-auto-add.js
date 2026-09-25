'use strict';

async function addModelsToFrontierTeams(db, modelIds) {
  const ids = Array.isArray(modelIds)
    ? [...new Set(modelIds.filter(Boolean).map(String))]
    : (modelIds ? [String(modelIds)] : []);
  if (ids.length === 0) return 0;

  const frontier = await db.query('SELECT id FROM teams WHERE is_frontier = TRUE');
  if (frontier.rows.length === 0) return 0;

  let added = 0;
  for (const team of frontier.rows) {
    const result = await db.query(
      `INSERT INTO team_models (team_id, model_id, enabled)
       SELECT $1, x.model_id, TRUE
       FROM unnest($2::text[]) AS x(model_id)
       ON CONFLICT (team_id, model_id) DO NOTHING`,
      [team.id, ids]
    );
    added += result.rowCount || 0;
  }
  return added;
}

module.exports = { addModelsToFrontierTeams };
