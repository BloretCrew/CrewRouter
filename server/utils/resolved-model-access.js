'use strict';

// Resolve globally first, then authorize that exact local row. Searching only
// authorized aliases can borrow access from a different model with the same name.
async function resolveModelConfig(db, input, { allowUpstream = false } = {}) {
  const id = String(input || '').trim();
  if (!id) return null;
  const exact = await db.query('SELECT * FROM models WHERE id = $1 AND enabled = TRUE', [id]);
  if (exact.rows[0]) return exact.rows[0];
  const alias = await db.query("SELECT * FROM models WHERE alias = $1 AND alias != '' AND enabled = TRUE ORDER BY id LIMIT 1", [id]);
  if (alias.rows[0]) return alias.rows[0];
  if (!allowUpstream) return null;
  const upstream = await db.query('SELECT * FROM models WHERE upstream_model_id = $1 AND enabled = TRUE ORDER BY id LIMIT 1', [id]);
  return upstream.rows[0] || null;
}

async function getAuthorizedModelInputs(db, userId, modelIds, options) {
  const inputs = [...new Set((modelIds || []).map(id => String(id || '').trim()).filter(Boolean))];
  const resolved = await Promise.all(inputs.map(async input => [input, await resolveModelConfig(db, input, options)]));
  const localIds = [...new Set(resolved.map(([, model]) => model?.id).filter(Boolean))];
  if (!localIds.length || !userId) return new Set();
  const result = await db.query(
    `SELECT DISTINCT m.id
       FROM models m
       JOIN providers p ON p.id = m.provider AND p.enabled = TRUE
       JOIN team_models tm ON tm.model_id = m.id AND tm.enabled = TRUE
       JOIN user_teams ut ON ut.team_id = tm.team_id AND ut.user_id = $2
      WHERE m.id = ANY($1::text[]) AND m.enabled = TRUE`,
    [localIds, userId]
  );
  const authorizedLocalIds = new Set(result.rows.map(row => row.id));
  return new Set(resolved.filter(([, model]) => model && authorizedLocalIds.has(model.id)).map(([input]) => input));
}

async function resolveAuthorizedModelConfig(db, userId, input, options) {
  const model = await resolveModelConfig(db, input, options);
  if (!model || !userId) return null;
  const access = await db.query(
    `SELECT m.id FROM models m
       JOIN providers p ON p.id = m.provider AND p.enabled = TRUE
       JOIN team_models tm ON tm.model_id = m.id AND tm.enabled = TRUE
       JOIN user_teams ut ON ut.team_id = tm.team_id AND ut.user_id = $2
      WHERE m.id = $1 AND m.enabled = TRUE LIMIT 1`,
    [model.id, userId]
  );
  // Return the very same resolved object, never resolve the alias a second time.
  return access.rows.length ? model : null;
}

module.exports = { resolveModelConfig, getAuthorizedModelInputs, resolveAuthorizedModelConfig };
