const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Logger = require('../logger');
const { invalidateApiKeyCacheByKeyId } = require('./api');
const { ACTIONS, auditMiddleware } = require('../utils/audit-log');

// ==================== Team CRUD ====================

// 获取所有 Team（含成员数）
router.get('/teams', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, COALESCE(member_count.count, 0) AS member_count
      FROM teams t
      LEFT JOIN (
        SELECT team_id, COUNT(*) AS count
        FROM user_teams
        GROUP BY team_id
      ) member_count ON t.id = member_count.team_id
      ORDER BY t.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取Team列表] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建 Team
router.post('/teams', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_TEAM_CREATE, {
  resourceType: 'team',
  resourceIdFrom: (req, res) => res._logBody?.id,
  descriptionFrom: (req) => `创建 Team「${req.body?.name || '-'}」`,
}), async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Team 名称不能为空' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO teams (name, description) VALUES ($1, $2) RETURNING *',
      [name.trim(), description || '']
    );
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Team 名称已存在' });
    }
    Logger.error('[创建Team] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新 Team
router.put('/teams/:id', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_TEAM_UPDATE, {
  resourceType: 'team',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新 Team #${req.params.id}`,
}), async (req, res) => {
  const { name, description, is_default, is_frontier } = req.body;
  try {
    // 如果设置为默认 Team，先取消其他默认
    if (is_default === true) {
      await pool.query('UPDATE teams SET is_default = FALSE WHERE is_default = TRUE');
    }

    const result = await pool.query(
      `UPDATE teams SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        is_default = COALESCE($3, is_default),
        is_frontier = COALESCE($4, is_frontier),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 RETURNING *`,
      [name, description, is_default !== undefined ? is_default : null, is_frontier !== undefined ? is_frontier : null, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team 不存在' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Team 名称已存在' });
    }
    Logger.error('[更新Team] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 设置前沿 Team（新模型自动添加）
router.put('/teams/:id/set-frontier', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE teams SET is_frontier = FALSE WHERE is_frontier = TRUE');
    const result = await pool.query(
      'UPDATE teams SET is_frontier = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team 不存在' });
    }
    Logger.info(`[Team] 已将 "${result.rows[0].name}" 设为前沿 Team`);
    res.json(result.rows[0]);
  } catch (error) {
    Logger.error('[设置前沿Team] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除 Team
router.delete('/teams/:id', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_TEAM_DELETE, {
  resourceType: 'team',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `删除 Team #${req.params.id}`,
}), async (req, res) => {
  try {
    // 检查是否为个人账户 Team
    const teamCheck = await pool.query('SELECT is_personal FROM teams WHERE id = $1', [req.params.id]);
    if (teamCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Team 不存在' });
    }
    if (teamCheck.rows[0].is_personal) {
      return res.status(403).json({ error: '个人账户 Team 不可删除' });
    }
    // 先将该 Team 的用户 team_id 置空
    await pool.query('UPDATE users SET team_id = NULL WHERE team_id = $1', [req.params.id]);
    await pool.query('DELETE FROM teams WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[删除Team] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== Team 成员管理 ====================

// 获取 Team 成员
router.get('/teams/:id/members', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.avatar, u.created_at
       FROM users u
       JOIN user_teams ut ON u.id = ut.user_id
       WHERE ut.team_id = $1
       ORDER BY u.username`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取Team成员] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 添加成员到 Team（批量插入 user_teams）
router.post('/teams/:id/members', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_TEAM_MEMBER, {
  resourceType: 'team',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `添加 Team #${req.params.id} 成员`,
  detailsFrom: (req) => ({ user_ids: req.body?.userIds || req.body?.userId }),
}), async (req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: '请提供用户 ID 列表' });
  }
  try {
    // 验证 Team 存在
    const teamCheck = await pool.query('SELECT id, is_personal FROM teams WHERE id = $1', [req.params.id]);
    if (teamCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Team 不存在' });
    }
    if (teamCheck.rows[0].is_personal) {
      return res.status(403).json({ error: '个人账户 Team 不可添加成员' });
    }
    const teamId = parseInt(req.params.id);

    // 批量插入（忽略冲突）
    let added = 0;
    for (const userId of userIds) {
      const result = await pool.query(
        'INSERT INTO user_teams (user_id, team_id) VALUES ($1, $2) ON CONFLICT (user_id, team_id) DO NOTHING',
        [userId, teamId]
      );
      added += result.rowCount;
    }

    // users.team_id 仅作兼容投影；批量成员均同步到有效主 Team。
    await pool.query(
      'UPDATE users SET team_id = $1 WHERE id = ANY($2::int[]) AND team_id IS NULL',
      [teamId, userIds.map(id => parseInt(id, 10)).filter(Number.isInteger)]
    );

    res.json({ success: true, added });
  } catch (error) {
    Logger.error('[添加Team成员] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 移除 Team 成员
router.delete('/teams/:id/members/:userId', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_TEAM_MEMBER, {
  resourceType: 'team',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `移除 Team #${req.params.id} 成员 #${req.params.userId}`,
  detailsFrom: (req) => ({ removed_user_id: req.params.userId }),
}), async (req, res) => {
  try {
    // 检查是否为个人账户 Team
    const teamCheck = await pool.query('SELECT is_personal FROM teams WHERE id = $1', [req.params.id]);
    if (teamCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Team 不存在' });
    }
    if (teamCheck.rows[0].is_personal) {
      return res.status(403).json({ error: '个人账户 Team 不可移除成员' });
    }
    const userId = parseInt(req.params.userId, 10);
    const teamId = parseInt(req.params.id, 10);
    await pool.query('DELETE FROM user_teams WHERE user_id = $1 AND team_id = $2', [userId, teamId]);
    await pool.query(
      `UPDATE users u SET team_id = COALESCE((SELECT ut.team_id FROM user_teams ut WHERE ut.user_id = u.id ORDER BY ut.created_at ASC LIMIT 1), NULL)
       WHERE u.id = $1 AND u.team_id = $2`,
      [userId, teamId]
    );
    res.json({ success: true });
  } catch (error) {
    Logger.error('[移除Team成员] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== Team 模型配置 ====================

// 获取 Team 模型列表：展示供应商管理中全部已启用模型，附带本 Team 启用状态
router.get('/teams/:id/models', requireAuth, requireAdmin, async (req, res) => {
  try {
    const teamCheck = await pool.query('SELECT id FROM teams WHERE id = $1', [req.params.id]);
    if (teamCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Team 不存在' });
    }
    const result = await pool.query(`
      SELECT tm.id AS mapping_id,
             COALESCE(tm.enabled, FALSE) AS enabled,
             m.id AS model_id, m.name, m.provider, m.series, m.description,
             m.input_price_per_1k_tokens, m.output_price_per_1k_tokens, m.icon_url,
             m.upstream_model_id, m.alias, m.model_multiplier,
             mtr.ok AS test_ok, mtr.latency_ms AS test_latency_ms,
             mtr.tokens_per_second AS test_tokens_per_second,
             mtr.error AS test_error, mtr.tested_at AS test_tested_at,
             p.id AS provider_id, p.name AS provider_name, p.enabled AS provider_enabled
      FROM models m
      LEFT JOIN team_models tm ON tm.model_id = m.id AND tm.team_id = $1
      LEFT JOIN providers p ON m.provider = p.id
      LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
      WHERE m.enabled = TRUE
      ORDER BY COALESCE(p.name, m.provider), COALESCE(NULLIF(m.upstream_model_id, ''), m.name, m.id)
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取Team模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 为 Team 启用模型
router.post('/teams/:id/models', requireAuth, requireAdmin, async (req, res) => {
  const { modelIds } = req.body;
  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    return res.status(400).json({ error: '请提供模型 ID 列表' });
  }
  try {
    // 验证 Team 存在
    const teamCheck = await pool.query('SELECT id FROM teams WHERE id = $1', [req.params.id]);
    if (teamCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Team 不存在' });
    }
    // 批量插入（忽略冲突）
    let added = 0;
    for (const modelId of modelIds) {
      const result = await pool.query(
        'INSERT INTO team_models (team_id, model_id) VALUES ($1, $2) ON CONFLICT (team_id, model_id) DO NOTHING',
        [req.params.id, modelId]
      );
      added += result.rowCount;
    }
    res.json({ success: true, added });
  } catch (error) {
    Logger.error('[添加Team模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 切换 Team 模型启用状态（无映射时自动创建）
router.put('/teams/:id/models/:modelId', requireAuth, requireAdmin, async (req, res) => {
  const { enabled } = req.body;
  try {
    const teamId = req.params.id;
    const modelId = req.params.modelId;
    const nextEnabled = enabled !== false;

    const teamCheck = await pool.query('SELECT id FROM teams WHERE id = $1', [teamId]);
    if (teamCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Team 不存在' });
    }
    const modelCheck = await pool.query(
      'SELECT id FROM models WHERE id = $1 AND enabled = TRUE',
      [modelId]
    );
    if (modelCheck.rows.length === 0) {
      return res.status(404).json({ error: '模型不存在或未在模型管理中启用' });
    }

    const result = await pool.query(
      `INSERT INTO team_models (team_id, model_id, enabled)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id, model_id) DO UPDATE SET enabled = EXCLUDED.enabled
       RETURNING *`,
      [teamId, modelId, nextEnabled]
    );

    // 禁用时：清空仍绑定该模型且已无其它 Team 可用的 Key
    let cleared = 0;
    if (!nextEnabled) {
      const clearRes = await clearApiKeysForUnavailableTeamModel(teamId, modelId);
      cleared = clearRes.cleared || 0;
    }
    res.json({ ...result.rows[0], cleared_keys: cleared });
  } catch (error) {
    Logger.error('[更新Team模型状态] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

/**
 * 批量启用/禁用 Team 模型
 * body:
 *   enabled: boolean（必填）
 *   modelIds?: string[]          显式模型 ID 列表
 *   provider?: string            供应商 id / provider key，一键操作该供应商下全部已启用模型
 *   namePattern?: string         按名称模糊匹配（upstream_model_id / name / alias / series）
 * 至少提供 modelIds / provider / namePattern 之一；可组合（交集）。
 */
router.post('/teams/:id/models/batch', requireAuth, requireAdmin, async (req, res) => {
  const { enabled, modelIds, provider, namePattern } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '请提供 enabled 布尔值' });
  }
  const hasModelIds = Array.isArray(modelIds) && modelIds.length > 0;
  const providerKey = (provider != null && String(provider).trim()) ? String(provider).trim() : '';
  const nameQ = (namePattern != null && String(namePattern).trim()) ? String(namePattern).trim() : '';
  if (!hasModelIds && !providerKey && !nameQ) {
    return res.status(400).json({ error: '请提供 modelIds、provider 或 namePattern 之一' });
  }

  try {
    const teamId = req.params.id;
    const teamCheck = await pool.query('SELECT id FROM teams WHERE id = $1', [teamId]);
    if (teamCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Team 不存在' });
    }

    const params = [];
    const where = ['m.enabled = TRUE'];
    if (hasModelIds) {
      params.push(modelIds.map(String));
      where.push(`m.id = ANY($${params.length}::text[])`);
    }
    if (providerKey) {
      params.push(providerKey);
      // 匹配 provider UUID 或供应商名称
      where.push(`(m.provider = $${params.length} OR p.id::text = $${params.length} OR p.name = $${params.length})`);
    }
    if (nameQ) {
      params.push(`%${nameQ}%`);
      where.push(`(
        m.upstream_model_id ILIKE $${params.length}
        OR m.name ILIKE $${params.length}
        OR m.alias ILIKE $${params.length}
        OR m.series ILIKE $${params.length}
      )`);
    }

    const modelsRes = await pool.query(
      `SELECT m.id
       FROM models m
       LEFT JOIN providers p ON m.provider = p.id
       WHERE ${where.join(' AND ')}`,
      params
    );
    const targetIds = modelsRes.rows.map(r => r.id);
    if (targetIds.length === 0) {
      return res.json({ success: true, updated: 0, cleared_keys: 0, modelIds: [] });
    }

    // 批量 upsert
    await pool.query(
      `INSERT INTO team_models (team_id, model_id, enabled)
       SELECT $1, x.model_id, $2
       FROM unnest($3::text[]) AS x(model_id)
       ON CONFLICT (team_id, model_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [teamId, enabled, targetIds]
    );

    let cleared = 0;
    if (!enabled) {
      for (const mid of targetIds) {
        const clearRes = await clearApiKeysForUnavailableTeamModel(teamId, mid);
        cleared += clearRes.cleared || 0;
      }
    }

    Logger.info(`[Team模型批量] team=${teamId} enabled=${enabled} count=${targetIds.length} cleared_keys=${cleared}`);
    res.json({ success: true, updated: targetIds.length, cleared_keys: cleared, modelIds: targetIds });
  } catch (error) {
    Logger.error('[批量更新Team模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 移除 Team 模型
router.delete('/teams/:id/models/:modelId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const teamId = req.params.id;
    const modelId = req.params.modelId;
    const delRes = await pool.query(
      'DELETE FROM team_models WHERE team_id = $1 AND model_id = $2 RETURNING *',
      [teamId, modelId]
    );
    // 移除后：清空已无法通过其它 Team 使用该模型的 Key 绑定
    let cleared = 0;
    if (delRes.rowCount > 0) {
      const clearRes = await clearApiKeysForUnavailableTeamModel(teamId, modelId);
      cleared = clearRes.cleared || 0;
    }
    res.json({ success: true, cleared_keys: cleared });
  } catch (error) {
    Logger.error('[移除Team模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});


/**
 * Team 模型被禁用/移除后：
 * 若该模型对该 Key 所属用户已不再通过任何 Team 可用，
 * 则清空 Key 的 current_model_id / api_key_models / fusion 绑定，
 * 与供应商管理页禁用模型时的 Key 清理效果一致。
 */
async function clearApiKeysForUnavailableTeamModel(teamId, modelId) {
  if (!teamId || !modelId) return { cleared: 0 };

  // 找出：属于该 Team、且当前绑定了该模型的 Key
  const keyIdsRes = await pool.query(
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
  const stillAvailable = await pool.query(
    `SELECT DISTINCT ut.user_id
     FROM user_teams ut
     JOIN team_models tm ON tm.team_id = ut.team_id
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

  await pool.query(
    'DELETE FROM api_key_models WHERE api_key_id = ANY($1) AND model_id = $2',
    [uniqueKeyIds, modelId]
  );
  await pool.query(
    'DELETE FROM api_key_harness_models WHERE api_key_id = ANY($1) AND model_id = $2',
    [uniqueKeyIds, modelId]
  ).catch(() => {});
  // 若删掉的是首选，提升队列中下一个；队列空则置 NULL
  await pool.query(
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
  await pool.query(
    `UPDATE api_keys SET fusion_judge_model_id = NULL
     WHERE id = ANY($1) AND fusion_judge_model_id = $2`,
    [uniqueKeyIds, modelId]
  );
  await pool.query(
    `UPDATE api_keys SET fusion_outer_model_id = NULL
     WHERE id = ANY($1) AND fusion_outer_model_id = $2`,
    [uniqueKeyIds, modelId]
  );
  await pool.query(
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

  for (const keyId of uniqueKeyIds) {
    try { invalidateApiKeyCacheByKeyId(keyId); } catch (_) { /* ignore */ }
  }

  Logger.info(`[Team模型] team=${teamId} model=${modelId} 已清理 ${uniqueKeyIds.length} 个 Key 绑定`);
  return { cleared: uniqueKeyIds.length };
}

module.exports = router;
