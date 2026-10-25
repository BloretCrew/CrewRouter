const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireTeamEdition } = require('../utils/instance-edition');
const requireTeamAdminEdition = requireTeamEdition(() => require('../utils/instance-edition').loadPersistedEdition(pool));
const Logger = require('../logger');
const { invalidateApiKeyCacheByKeyId } = require('./api');
const { ACTIONS, auditMiddleware } = require('../utils/audit-log');
const { createTeamModelTransaction, clearApiKeysForUnavailableTeamModel } = require('../utils/team-model-access');
const teamModelTransaction = createTeamModelTransaction({ pool, invalidateApiKeyCacheByKeyId });

// Team surfaces are unavailable in Personal Edition. Existing auth and admin checks remain intact.
router.use(requireTeamAdminEdition);

// ==================== Team CRUD ====================

// 获取所有 Team（含成员数）
router.get('/teams', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, COALESCE(member_count.count, 0) AS member_count,
             jsonb_array_length(COALESCE(t.quota_rules, '[]'::jsonb)) AS rule_count
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
      'INSERT INTO teams (name, description, quota_rules) VALUES ($1, $2, $3::jsonb) RETURNING *',
      [name.trim(), description || '', '[]']
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
  const { name, description, is_default, is_frontier, hide_provider_quota } = req.body;
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 100)) {
    return res.status(400).json({ error: 'Team 名称需为 1 至 100 个字符' });
  }
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
        hide_provider_quota = COALESCE($5, hide_provider_quota),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 RETURNING *`,
      [name === undefined ? null : name.trim(), description, is_default !== undefined ? is_default : null, is_frontier !== undefined ? is_frontier : null, hide_provider_quota !== undefined ? hide_provider_quota : null, req.params.id]
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
  let client;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    inTransaction = true;
    // 与成员添加共用 Team 行锁，避免删除与新成员写入竞态。
    const teamCheck = await client.query('SELECT id, is_personal FROM teams WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (teamCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(404).json({ error: 'Team 不存在' });
    }
    if (teamCheck.rows[0].is_personal) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(403).json({ error: '个人账户 Team 不可删除' });
    }

    const assigned = await client.query(`
      SELECT
        (SELECT count(*)::int FROM user_teams WHERE team_id = $1) AS membership_count,
        (SELECT count(*)::int FROM users WHERE team_id = $1) AS primary_user_count
    `, [req.params.id]);
    const { membership_count: membershipCount, primary_user_count: primaryUserCount } = assigned.rows[0];
    if (membershipCount > 0 || primaryUserCount > 0) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(409).json({ error: '该 Team 仍有关联用户，请先将成员重新分配后再删除' });
    }

    await client.query('DELETE FROM user_group_team_map WHERE team_id = $1', [req.params.id]);
    const deleted = await client.query('DELETE FROM teams WHERE id = $1 RETURNING id', [req.params.id]);
    if (!deleted.rowCount) throw new Error('删除 Team 时记录已发生变化');
    await client.query('COMMIT');
    inTransaction = false;
    res.json({ success: true });
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    Logger.error('[删除Team] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  } finally {
    client?.release();
  }
});

// ==================== Team 成员管理 ====================

// 获取 Team 成员
router.get('/teams/:id/members', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.avatar, u.created_at
       FROM users u
       WHERE u.team_id = $1
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
    const teamId = parseInt(req.params.id, 10);
    const normalizedUserIds = [...new Set(userIds.map(id => parseInt(id, 10)).filter(Number.isInteger))];
    if (!normalizedUserIds.length) return res.status(400).json({ error: '请提供有效用户 ID' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockedTeam = await client.query('SELECT id, is_personal FROM teams WHERE id = $1 FOR UPDATE', [teamId]);
      if (!lockedTeam.rows.length) throw Object.assign(new Error('Team 不存在'), { status: 404 });
      if (lockedTeam.rows[0].is_personal) throw Object.assign(new Error('个人账户 Team 不可添加成员'), { status: 403 });
      normalizedUserIds.sort((a, b) => a - b);
      const existingUsers = await client.query('SELECT id FROM users WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [normalizedUserIds]);
      if (existingUsers.rows.length !== normalizedUserIds.length) throw Object.assign(new Error('用户不存在'), { status: 400 });
      for (const userId of normalizedUserIds) {
        await require('../utils/team-membership').setUserTeam(client, userId, teamId);
      }
      const result = { rowCount: normalizedUserIds.length };
      await client.query('COMMIT');
      const { invalidateUserApiKeyCache } = require('./api');
      for (const userId of normalizedUserIds) invalidateUserApiKeyCache(userId);
      res.json({ success: true, added: result.rowCount });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (error.status) return res.status(error.status).json({ error: error.message });
      throw error;
    } finally { client.release(); }
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockedTeam = await client.query('SELECT id, is_personal FROM teams WHERE id = $1 FOR UPDATE', [teamId]);
      if (!lockedTeam.rows.length) throw Object.assign(new Error('Team 不存在'), { status: 404 });
      if (lockedTeam.rows[0].is_personal) throw Object.assign(new Error('个人账户 Team 不可移除成员'), { status: 403 });
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const membership = await client.query('SELECT 1 FROM user_teams WHERE user_id = $1 AND team_id = $2', [userId, teamId]);
      if (membership.rows.length) await require('../utils/team-membership').setUserTeam(client, userId, null);
      await client.query('COMMIT');
      require('./api').invalidateUserApiKeyCache(userId);
      res.json({ success: true });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    Logger.error('[移除Team成员] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== Team 限额规则 ====================

router.get('/teams/:id/rules', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT quota_rules FROM teams WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Team 不存在' });
    let rules = result.rows[0].quota_rules || [];
    if (typeof rules === 'string') rules = JSON.parse(rules || '[]');
    res.json(Array.isArray(rules) ? rules : []);
  } catch (error) {
    Logger.error('[获取Team规则] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.post('/teams/:id/rules', requireAuth, requireAdmin, async (req, res) => {
  const { rule_type, rule_value, duration_hours, description } = req.body;
  if (!['requests', 'tokens'].includes(rule_type) || !Number.isFinite(Number(rule_value)) || Number(rule_value) <= 0 || !Number.isFinite(Number(duration_hours)) || Number(duration_hours) <= 0) {
    return res.status(400).json({ error: '请输入有效的规则类型、限额和时间窗口' });
  }
  try {
    const rule = { id: `team-rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, rule_type, rule_value: Number(rule_value), duration_hours: Number(duration_hours), description: description || '' };
    const result = await pool.query(
      `UPDATE teams SET quota_rules = COALESCE(quota_rules, '[]'::jsonb) || $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING quota_rules`,
      [JSON.stringify([rule]), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Team 不存在' });
    res.json(rule);
  } catch (error) {
    Logger.error('[添加Team规则] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.delete('/teams/:id/rules/:ruleId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE teams SET quota_rules = COALESCE((SELECT jsonb_agg(rule) FROM jsonb_array_elements(COALESCE(quota_rules, '[]'::jsonb)) rule WHERE rule->>'id' <> $1), '[]'::jsonb), updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id`,
      [req.params.ruleId, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Team 不存在' });
    res.json({ success: true });
  } catch (error) {
    Logger.error('[删除Team规则] 错误:', error);
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
      WHERE m.enabled = TRUE AND p.created_by IS NULL
      ORDER BY COALESCE(p.name, m.provider), COALESCE(NULLIF(m.upstream_model_id, ''), m.name, m.id)
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取Team模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 为 Team 启用模型
router.post('/teams/:id/models', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_TEAM_MODEL, {
  resourceType: 'team',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新 Team #${req.params.id} 模型授权`,
  detailsFrom: (req) => ({ enabled: req.body?.enabled, model_id: req.params.modelId, model_ids: req.body?.modelIds, provider: req.body?.provider }),
}), async (req, res) => {
  const { modelIds } = req.body || {};
  if (!Array.isArray(modelIds) || modelIds.length === 0 || modelIds.some(id => typeof id !== 'string' || !id.trim())) {
    return res.status(400).json({ error: '请提供模型 ID 列表' });
  }
  try {
    const payload = await teamModelTransaction(req.params.id, async (client) => {
      // 验证 Team 存在
      const teamCheck = await client.query('SELECT id FROM teams WHERE id = $1', [req.params.id]);
      if (teamCheck.rows.length === 0) {
        throw Object.assign(new Error('Team 不存在'), { status: 404 });
      }
      const allowed = await client.query(`SELECT m.id FROM models m JOIN providers p ON p.id = m.provider
        WHERE m.id = ANY($1::text[]) AND m.enabled = TRUE AND p.created_by IS NULL`, [modelIds]);
      if (allowed.rows.length !== new Set(modelIds).size) {
        throw Object.assign(new Error('模型不存在、未启用或属于用户私有供应商'), { status: 403 });
      }
      // 批量插入（忽略冲突）
      let added = 0;
      for (const modelId of modelIds) {
        const result = await client.query(
          'INSERT INTO team_models (team_id, model_id) VALUES ($1, $2) ON CONFLICT (team_id, model_id) DO NOTHING',
          [req.params.id, modelId]
        );
        added += result.rowCount;
      }

      return { success: true, added };
    });
    res.json(payload);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    Logger.error('[添加Team模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 切换 Team 模型启用状态（无映射时自动创建）
router.put('/teams/:id/models/:modelId', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_TEAM_MODEL, {
  resourceType: 'team',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新 Team #${req.params.id} 模型授权`,
  detailsFrom: (req) => ({ enabled: req.body?.enabled, model_id: req.params.modelId, model_ids: req.body?.modelIds, provider: req.body?.provider }),
}), async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: '请提供 enabled 布尔值' });
  try {
    const payload = await teamModelTransaction(req.params.id, async (client) => {
      const teamId = req.params.id;
      const modelId = req.params.modelId;
      const nextEnabled = enabled;

      const teamCheck = await client.query('SELECT id FROM teams WHERE id = $1', [teamId]);
      if (teamCheck.rows.length === 0) {
        throw Object.assign(new Error('Team 不存在'), { status: 404 });
      }
      const modelCheck = await client.query(
        `SELECT m.id FROM models m JOIN providers p ON p.id = m.provider
         WHERE m.id = $1 AND p.created_by IS NULL AND ($2::boolean = FALSE OR m.enabled = TRUE)`,
        [modelId, nextEnabled]
      );
      if (modelCheck.rows.length === 0) {
        throw Object.assign(new Error('模型不存在或未在模型管理中启用'), { status: 404 });
      }

      const result = await client.query(
        `INSERT INTO team_models (team_id, model_id, enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (team_id, model_id) DO UPDATE SET enabled = EXCLUDED.enabled
         RETURNING *`,
        [teamId, modelId, nextEnabled]
      );


      // 禁用时：清空仍绑定该模型且已无其它 Team 可用的 Key
      let cleared = 0;
      if (!nextEnabled) {
        const clearRes = await clearApiKeysForUnavailableTeamModel(client, teamId, modelId);
        cleared = clearRes.cleared || 0;
      }
      return { ...result.rows[0], cleared_keys: cleared };
    });
    res.json(payload);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
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
router.post('/teams/:id/models/batch', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_TEAM_MODEL, {
  resourceType: 'team',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新 Team #${req.params.id} 模型授权`,
  detailsFrom: (req) => ({ enabled: req.body?.enabled, model_id: req.params.modelId, model_ids: req.body?.modelIds, provider: req.body?.provider }),
}), async (req, res) => {
  const { enabled, modelIds, provider, namePattern } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: '请提供 enabled 布尔值' });
  }
  if (modelIds !== undefined && (!Array.isArray(modelIds) || modelIds.some(id => typeof id !== 'string' || !id.trim()))) {
    return res.status(400).json({ error: 'modelIds 必须是模型 ID 列表' });
  }
  const hasModelIds = Array.isArray(modelIds) && modelIds.length > 0;
  const providerKey = (provider != null && String(provider).trim()) ? String(provider).trim() : '';
  const nameQ = (namePattern != null && String(namePattern).trim()) ? String(namePattern).trim() : '';
  if (!hasModelIds && !providerKey && !nameQ) {
    return res.status(400).json({ error: '请提供 modelIds、provider 或 namePattern 之一' });
  }

  try {
    const payload = await teamModelTransaction(req.params.id, async (client) => {
      const teamId = req.params.id;
      const teamCheck = await client.query('SELECT id FROM teams WHERE id = $1', [teamId]);
      if (teamCheck.rows.length === 0) {
        throw Object.assign(new Error('Team 不存在'), { status: 404 });
      }

      const params = [];
      const where = ['p.created_by IS NULL'];
      if (enabled) where.push('m.enabled = TRUE');
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

      const modelsRes = await client.query(
        `SELECT m.id
         FROM models m
         LEFT JOIN providers p ON m.provider = p.id
         WHERE ${where.join(' AND ')}`,
        params
      );
      const targetIds = modelsRes.rows.map(r => r.id);
      if (targetIds.length === 0) {
        return { success: true, updated: 0, cleared_keys: 0, modelIds: [] };
      }

      // 批量 upsert
      await client.query(
        `INSERT INTO team_models (team_id, model_id, enabled)
         SELECT $1, x.model_id, $2
         FROM unnest($3::text[]) AS x(model_id)
         ON CONFLICT (team_id, model_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
        [teamId, enabled, targetIds]
      );

      let cleared = 0;
      if (!enabled) {
        for (const mid of targetIds) {
          const clearRes = await clearApiKeysForUnavailableTeamModel(client, teamId, mid);
          cleared += clearRes.cleared || 0;
        }
      }

      Logger.info(`[Team模型批量] team=${teamId} enabled=${enabled} count=${targetIds.length} cleared_keys=${cleared}`);
      return { success: true, updated: targetIds.length, cleared_keys: cleared, modelIds: targetIds };
    });
    res.json(payload);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    Logger.error('[批量更新Team模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 移除 Team 模型
router.delete('/teams/:id/models/:modelId', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_TEAM_MODEL, {
  resourceType: 'team',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新 Team #${req.params.id} 模型授权`,
  detailsFrom: (req) => ({ enabled: req.body?.enabled, model_id: req.params.modelId, model_ids: req.body?.modelIds, provider: req.body?.provider }),
}), async (req, res) => {
  try {
    const payload = await teamModelTransaction(req.params.id, async (client) => {
      const teamId = req.params.id;
      const modelId = req.params.modelId;
      const delRes = await client.query(
        'DELETE FROM team_models WHERE team_id = $1 AND model_id = $2 RETURNING *',
        [teamId, modelId]
      );

      // 移除后：清空已无法通过其它 Team 使用该模型的 Key 绑定
      let cleared = 0;
      if (delRes.rowCount > 0) {
        const clearRes = await clearApiKeysForUnavailableTeamModel(client, teamId, modelId);
        cleared = clearRes.cleared || 0;
      }
      return { success: true, cleared_keys: cleared };
    });
    res.json(payload);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    Logger.error('[移除Team模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});


module.exports = router;
