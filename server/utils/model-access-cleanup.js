// 清理授权绑定但保留 Team 映射，重新启用时不恢复 Key 的旧绑定。
async function clearDisabledModelBindings(db, modelIds, beforeCleanup) {
  if (!modelIds.length) return [];
  const keys = await db.query(`SELECT id FROM api_keys WHERE
    current_model_id = ANY($1::text[]) OR fusion_judge_model_id = ANY($1::text[])
    OR fusion_outer_model_id = ANY($1::text[])
    OR EXISTS (SELECT 1 FROM api_key_models x WHERE x.api_key_id = api_keys.id AND x.model_id = ANY($1::text[]))
    OR EXISTS (SELECT 1 FROM api_key_harness_models x WHERE x.api_key_id = api_keys.id AND x.model_id = ANY($1::text[]))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(fusion_panel_models, '[]'::jsonb)) e WHERE e = ANY($1::text[]))`, [modelIds]);
  if (beforeCleanup) beforeCleanup(keys.rows.map(row => row.id));
  await db.query('DELETE FROM api_key_models WHERE model_id = ANY($1::text[])', [modelIds]);
  await db.query('DELETE FROM api_key_harness_models WHERE model_id = ANY($1::text[])', [modelIds]);
  await db.query(`UPDATE api_keys ak SET
    current_model_id = CASE WHEN current_model_id = ANY($1::text[]) THEN
      (SELECT model_id FROM api_key_models WHERE api_key_id = ak.id ORDER BY sort_order, id LIMIT 1) ELSE current_model_id END,
    fusion_judge_model_id = CASE WHEN fusion_judge_model_id = ANY($1::text[]) THEN NULL ELSE fusion_judge_model_id END,
    fusion_outer_model_id = CASE WHEN fusion_outer_model_id = ANY($1::text[]) THEN NULL ELSE fusion_outer_model_id END,
    fusion_panel_models = COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements_text(COALESCE(fusion_panel_models, '[]'::jsonb)) e WHERE NOT (e = ANY($1::text[]))), '[]'::jsonb)
    WHERE id = ANY($2::int[])`, [modelIds, keys.rows.map(row => row.id)]);
  return keys.rows.map(row => row.id);
}

function invalidateModelKeyCaches(keyIds) {
  const { invalidateApiKeyCacheByKeyId } = require('../routes/api');
  for (const id of keyIds) invalidateApiKeyCacheByKeyId(id);
}

module.exports = { clearDisabledModelBindings, invalidateModelKeyCaches };
