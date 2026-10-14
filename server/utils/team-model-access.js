// 依赖注入避免测试加载数据库和代理路由。
function createTeamModelTransaction({ pool, invalidateApiKeyCacheByKeyId }) {
  return async function teamModelTransaction(teamId, work) {
    const client = await pool.connect();
    let payload;
    let keyIds = [];
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM teams WHERE id = $1 FOR UPDATE', [teamId]);
      const keys = await client.query(`SELECT DISTINCT ak.id FROM api_keys ak
        JOIN user_teams ut ON ut.user_id = ak.user_id WHERE ut.team_id = $1`, [teamId]);
      keyIds = keys.rows.map(row => row.id);
      if (keyIds.length) await client.query('SELECT id FROM api_keys WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [keyIds]);
      payload = await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    for (const id of keyIds) invalidateApiKeyCacheByKeyId(id);
    return payload;
  };
}

async function clearApiKeysForUnavailableTeamModel(client, teamId, modelId) {
  if (!teamId || !modelId) return { cleared: 0 };

  // 找出：属于该 Team、且当前绑定了该模型的 Key
  const keyIdsRes = await client.query(
    `SELECT DISTINCT ak.id, ak.user_id
     FROM api_keys ak
     JOIN user_teams ut ON ut.user_id = ak.user_id
     WHERE ut.team_id = $1
       AND (
         ak.current_model_id = $2
         OR EXISTS (
           SELECT 1 FROM api_key_models akm
           WHERE akm.api_key_id = ak.id AND akm.model_id = $2
         )
         OR EXISTS (SELECT 1 FROM api_key_harness_models ahm WHERE ahm.api_key_id = ak.id AND ahm.model_id = $2)
         OR ak.fusion_judge_model_id = $2
         OR ak.fusion_outer_model_id = $2
         OR (
           ak.fusion_panel_models IS NOT NULL
           AND ak.fusion_panel_models <> '[]'::jsonb
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(ak.fusion_panel_models) e
             WHERE e = $2
           )
         )
       )`,
    [teamId, modelId]
  );

  if (!keyIdsRes.rows.length) return { cleared: 0 };

  const candidateUserIds = [...new Set(keyIdsRes.rows.map(r => r.user_id))];

  // 若用户还在任意 Team 中拥有该模型（且启用），则保留绑定
  // 注意：调用方已先禁用/删除本 Team 映射，因此这里查到的是「其它仍可用」的路径
  const stillAvailable = await client.query(
    `SELECT DISTINCT ut.user_id
     FROM user_teams ut
     JOIN team_models tm ON tm.team_id = ut.team_id
     JOIN models m ON m.id = tm.model_id AND m.enabled = TRUE
     JOIN providers p ON p.id = m.provider AND p.enabled = TRUE
     WHERE ut.user_id = ANY($1::int[])
       AND tm.model_id = $2
       AND tm.enabled = TRUE`,
    [candidateUserIds, modelId]
  );
  const keepUserIds = new Set(stillAvailable.rows.map(r => r.user_id));

  const uniqueKeyIds = [...new Set(
    keyIdsRes.rows
      .filter(r => !keepUserIds.has(r.user_id))
      .map(r => r.id)
  )];
  if (!uniqueKeyIds.length) return { cleared: 0 };

  await client.query(
    'DELETE FROM api_key_models WHERE api_key_id = ANY($1) AND model_id = $2',
    [uniqueKeyIds, modelId]
  );
  await client.query(
    'DELETE FROM api_key_harness_models WHERE api_key_id = ANY($1) AND model_id = $2',
    [uniqueKeyIds, modelId]
  );
  // 若删掉的是首选，提升队列中下一个；队列空则置 NULL
  await client.query(
    `UPDATE api_keys ak
     SET current_model_id = (
       SELECT akm.model_id FROM api_key_models akm
       WHERE akm.api_key_id = ak.id
       ORDER BY akm.sort_order ASC, akm.id ASC
       LIMIT 1
     )
     WHERE ak.id = ANY($1) AND (ak.current_model_id = $2 OR ak.current_model_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM api_key_models x WHERE x.api_key_id = ak.id AND x.model_id = ak.current_model_id
       ))`,
    [uniqueKeyIds, modelId]
  );
  await client.query(
    `UPDATE api_keys SET fusion_judge_model_id = NULL
     WHERE id = ANY($1) AND fusion_judge_model_id = $2`,
    [uniqueKeyIds, modelId]
  );
  await client.query(
    `UPDATE api_keys SET fusion_outer_model_id = NULL
     WHERE id = ANY($1) AND fusion_outer_model_id = $2`,
    [uniqueKeyIds, modelId]
  );
  await client.query(
    `UPDATE api_keys
     SET fusion_panel_models = COALESCE((
       SELECT jsonb_agg(elem)
       FROM jsonb_array_elements_text(COALESCE(fusion_panel_models, '[]'::jsonb)) AS elem
       WHERE elem <> $2
     ), '[]'::jsonb)
     WHERE id = ANY($1)
       AND fusion_panel_models IS NOT NULL
       AND fusion_panel_models <> '[]'::jsonb
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(fusion_panel_models) e
         WHERE e = $2
       )`,
    [uniqueKeyIds, modelId]
  );

  return { cleared: uniqueKeyIds.length };
}

module.exports = { createTeamModelTransaction, clearApiKeysForUnavailableTeamModel };
