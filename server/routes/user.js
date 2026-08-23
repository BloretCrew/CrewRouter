const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const Logger = require('../logger');
const config = require('../config-loader');
const { fetchProvidersIndex, lookupProvider } = require('../provider-lookup');
const { invalidateApiKeyCacheByKeyId } = require('./api');
const { shanghaiDateRange, formatShanghaiDateTime } = require('../utils/timezone');
const { buildUserUsageLogsFilter, MODEL_NAME_SELECT } = require('../utils/usage-logs-filter');
const { ACTIONS, logAction, auditMiddleware } = require('../utils/audit-log');
const {
  HARNESS_SOURCES,
  isHarnessSource,
  sourceLabel,
} = require('../utils/request-source');

// Co-Key 权限：api_keys.user_id 始终是发起者和计费归属；成员仅共享管理权限。
async function getApiKeyAccess(db, apiKeyId, userId) {
  const result = await db.query(
    `SELECT ak.id, ak.user_id AS owner_user_id,
            (ak.user_id = $2) AS is_owner,
            (ak.user_id = $2 OR EXISTS (
              SELECT 1 FROM api_key_members akmem
              WHERE akmem.api_key_id = ak.id AND akmem.user_id = $2
            )) AS can_manage
     FROM api_keys ak
     WHERE ak.id = $1`,
    [apiKeyId, userId]
  );
  const access = result.rows[0];
  return access?.can_manage ? access : null;
}

async function getOwnedApiKey(db, apiKeyId, userId) {
  const access = await getApiKeyAccess(db, apiKeyId, userId);
  return access?.is_owner ? access : null;
}

// 跟踪报告：按用户隔离，报告永久保留；详情首次打开时标记已查看。
router.get('/trace-sessions', requireAuth, async (req, res) => {
  try {
    const unviewed = String(req.query.unviewed || '') === '1';
    const r = await pool.query(`SELECT ts.*, ak.name AS api_key_name FROM trace_sessions ts LEFT JOIN api_keys ak ON ak.id = ts.api_key_id WHERE ts.user_id = $1 AND ts.status = 'completed' ${unviewed ? 'AND ts.viewed_at IS NULL' : ''} ORDER BY ts.started_at DESC LIMIT 100`, [req.session.user.id]);
    res.json(r.rows);
  } catch (e) { Logger.error('[跟踪报告列表] 错误:', e); res.status(500).json({ error: '服务器错误' }); }
});

router.get('/trace-sessions/:publicId', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`UPDATE trace_sessions SET viewed_at = COALESCE(viewed_at, CURRENT_TIMESTAMP) WHERE public_id = $1 AND user_id = $2 RETURNING *`, [req.params.publicId, req.session.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: '报告不存在' });
    const events = await pool.query('SELECT * FROM trace_events WHERE session_id = $1 ORDER BY created_at, id', [r.rows[0].id]);
    res.json({ session: r.rows[0], events: events.rows });
  } catch (e) { Logger.error('[跟踪报告详情] 错误:', e); res.status(500).json({ error: '服务器错误' }); }
});

router.get('/trace-sessions/:publicId/export', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM trace_sessions WHERE public_id = $1 AND user_id = $2', [req.params.publicId, req.session.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: '报告不存在' });
    const events = await pool.query('SELECT * FROM trace_events WHERE session_id = $1 ORDER BY created_at, id', [r.rows[0].id]);
    const format = String(req.query.format || 'json').toLowerCase();
    if (format !== 'csv') return res.json({ session: r.rows[0], events: events.rows });
    const columns = ['id','created_at','ok','http_status','error','request_type','request_source','model_id','provider_id','tokens_used','prompt_tokens','completion_tokens','cached_tokens','weighted_tokens','cost','latency_ms','messages','response','reasoning_content','request_params','finish_reason'];
    const quote = value => `"${String(value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : value)).replace(/"/g, '""')}"`;
    const csv = [columns.join(','), ...events.rows.map(row => columns.map(c => quote(row[c])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trace-${req.params.publicId}.csv"`);
    res.send(`\ufeff${csv}`);
  } catch (e) { Logger.error('[跟踪报告下载] 错误:', e); res.status(500).json({ error: '服务器错误' }); }
});

// 模型调用可用率（平台全局，近 N 天日聚合）
router.get('/models/uptime', requireAuth, async (req, res) => {
  try {
    const { getModelUptime, DEFAULT_DAYS } = require('../utils/model-uptime');
    const ids = String(req.query.ids || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    const days = parseInt(req.query.days, 10) || DEFAULT_DAYS;
    const data = await getModelUptime(ids, days);
    res.json(data);
  } catch (error) {
    Logger.error('[模型 uptime 批量] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.get('/models/:id/uptime', requireAuth, async (req, res) => {
  try {
    const { getModelUptimeDetail, DEFAULT_DAYS } = require('../utils/model-uptime');
    const days = parseInt(req.query.days, 10) || DEFAULT_DAYS;
    const data = await getModelUptimeDetail(req.params.id, days);
    res.json(data);
  } catch (error) {
    Logger.error('[模型 uptime 详情] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用户模型列表
router.get('/models', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.id, COALESCE(NULLIF(m.upstream_model_id, ''), m.id) AS upstream_model_id, m.name, m.alias, m.series, m.description, m.enabled,
        m.input_price_per_1k_tokens, m.output_price_per_1k_tokens, m.cached_output_price_per_1k_tokens,
        m.reference_input_price_per_1k_tokens, m.reference_output_price_per_1k_tokens, m.reference_cached_output_price_per_1k_tokens,
        m.rate_limit_rpm, m.rate_limit_tpm, m.icon_url, m.billing_mode, m.model_multiplier, m.completion_multiplier,
        m.thinking_model_id, m.non_thinking_model_id, m.created_at, m.created_by, m.provider,
        p.name AS provider_name,
        s.icon_url AS series_icon_url
       FROM models m
       LEFT JOIN providers p ON m.provider = p.id
       LEFT JOIN series s ON m.series = s.name
       WHERE m.enabled = TRUE
       ORDER BY CASE WHEN m.series = '' THEN 1 ELSE 0 END, m.series, m.name`
    );
    res.json(result.rows);
  } catch (error) {
    // 降级查询：如果某些列不存在，使用基础列
    try {
      const fallback = await pool.query(
        `SELECT m.id, COALESCE(NULLIF(m.upstream_model_id, ''), m.id) AS upstream_model_id, m.name, m.alias, m.series, m.description, m.enabled,
          m.input_price_per_1k_tokens, m.output_price_per_1k_tokens, m.cached_output_price_per_1k_tokens,
          m.rate_limit_rpm, m.rate_limit_tpm, m.icon_url, m.billing_mode, m.model_multiplier, m.completion_multiplier,
          m.created_at, m.created_by, m.provider,
          p.name AS provider_name,
          s.icon_url AS series_icon_url
         FROM models m
         LEFT JOIN providers p ON m.provider = p.id
         LEFT JOIN series s ON m.series = s.name
         WHERE m.enabled = TRUE
         ORDER BY CASE WHEN m.series = '' THEN 1 ELSE 0 END, m.series, m.name`
      );
      res.json(fallback.rows);
    } catch (fallbackError) {
      Logger.error('[获取模型列表] 错误:', fallbackError);
      res.status(500).json({ error: '服务器错误' });
    }
  }
});

// 获取用户API密钥（含用量统计）
router.get('/api-keys', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        ak.id,
        ak.name,
        ak.key_prefix,
        ak.key_value,
        ak.custom_model_name,
        ak.current_model_id,
        ak.is_system,
        ak.created_at,
        ak.last_used_at,
        ak.expires_at,
        ak.signature_enabled,
        ak.signature_template,
        ak.quota_warning_enabled,
        ak.swallow_images,
        ak.crewrouter_commands,
        ak.enabled,
        ak.schedule_enabled,
        ak.schedule_on_time,
        ak.schedule_off_time,
        ak.schedule_days,
        ak.schedule_timezone,
        m.name AS current_model_name,
        p.name AS current_model_provider_name,
        mtr.ok AS current_model_test_ok,
        mtr.latency_ms AS current_model_test_latency_ms,
        mtr.tokens_per_second AS current_model_test_tokens_per_second,
        mtr.tested_at AS current_model_test_tested_at,
        COALESCE(usage_agg.total_tokens, 0) AS total_tokens,
        COALESCE(usage_agg.total_cost, 0) AS total_cost,
        COALESCE(usage_agg.total_requests, 0) AS total_requests,
        COALESCE(tag_agg.tags, '[]'::jsonb) AS tags,
        COALESCE(queue_agg.model_queue, '[]'::jsonb) AS model_queue,
        COALESCE(harness_agg.harness_models, '[]'::jsonb) AS harness_models,
        jsonb_build_object('id', owner.id, 'username', owner.username, 'email', owner.email) AS owner,
        COALESCE(member_agg.members, '[]'::jsonb) AS members,
        COALESCE(member_agg.member_count, 0) AS member_count,
        (ak.user_id = $1) AS is_owner,
        (ak.user_id <> $1) AS is_co_key,
        CASE
          WHEN ak.user_id <> $1 OR COALESCE(member_agg.member_count, 0) > 0 THEN 'co_key'
          ELSE 'normal'
        END AS key_type,
        CASE
          WHEN ak.user_id = $1 AND COALESCE(member_agg.member_count, 0) > 0 THEN 'owner'
          WHEN ak.user_id <> $1 THEN 'member'
          ELSE NULL
        END AS co_key_role
      FROM api_keys ak
      JOIN users owner ON owner.id = ak.user_id
      LEFT JOIN api_key_user_orders uko ON uko.api_key_id = ak.id AND uko.user_id = $1
      LEFT JOIN models m ON ak.current_model_id = m.id
      LEFT JOIN providers p ON m.provider = p.id
      LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
      LEFT JOIN (
        SELECT
          api_key_id,
          SUM(tokens_used) AS total_tokens,
          SUM(cost) AS total_cost,
          COUNT(*) AS total_requests
        FROM usage_records
        GROUP BY api_key_id
      ) usage_agg ON ak.id = usage_agg.api_key_id
      LEFT JOIN (
        SELECT akm.api_key_id,
               jsonb_agg(
                 jsonb_build_object(
                   'model_id', akm.model_id,
                   'name', qm.name,
                   'sort_order', akm.sort_order
                 ) ORDER BY akm.sort_order ASC, akm.id ASC
               ) AS model_queue
        FROM api_key_models akm
        LEFT JOIN models qm ON qm.id = akm.model_id
        WHERE akm.enabled IS DISTINCT FROM FALSE
        GROUP BY akm.api_key_id
      ) queue_agg ON queue_agg.api_key_id = ak.id
      LEFT JOIN (
        SELECT akhm.api_key_id,
               jsonb_agg(
                 jsonb_build_object(
                   'harness', akhm.harness,
                   'model_id', akhm.model_id,
                   'name', hm.name,
                   'provider_name', hp.name
                 ) ORDER BY akhm.harness ASC
               ) AS harness_models
        FROM api_key_harness_models akhm
        LEFT JOIN models hm ON hm.id = akhm.model_id
        LEFT JOIN providers hp ON hm.provider = hp.id
        GROUP BY akhm.api_key_id
      ) harness_agg ON harness_agg.api_key_id = ak.id
      LEFT JOIN (
        SELECT akt.api_key_id,
               jsonb_agg(jsonb_build_object('id', kt.id, 'name', kt.name, 'color', kt.color) ORDER BY kt.sort_order) AS tags
        FROM api_key_tags akt
        JOIN key_tags kt ON akt.tag_id = kt.id
        GROUP BY akt.api_key_id
      ) tag_agg ON ak.id = tag_agg.api_key_id
      LEFT JOIN (
        SELECT akmem.api_key_id,
               COUNT(*)::int AS member_count,
               jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'email', u.email)
                         ORDER BY akmem.created_at, u.id) AS members
        FROM api_key_members akmem
        JOIN users u ON u.id = akmem.user_id
        GROUP BY akmem.api_key_id
      ) member_agg ON member_agg.api_key_id = ak.id
      WHERE ak.user_id = $1
         OR EXISTS (SELECT 1 FROM api_key_members mine WHERE mine.api_key_id = ak.id AND mine.user_id = $1)
      ORDER BY COALESCE(uko.sort_order, 2147483647) ASC, ak.created_at DESC
    `, [req.session.user.id]);
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取API密钥] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 拖拽排序：保存当前用户视角的 API Key 顺序（每用户独立，Co-Key 顺序不共享）
router.put('/api-keys/reorder', requireAuth, auditMiddleware(ACTIONS.API_KEY_UPDATE, {
  resourceType: 'api_key',
  descriptionFrom: () => `拖拽调整 API Key 排序`,
  detailsFrom: (req) => ({ ordered_ids: req.body?.orderedIds }),
}), async (req, res) => {
  const client = await pool.connect();
  try {
    const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds.map(Number).filter(Number.isFinite) : [];
    if (!orderedIds.length) {
      return res.status(400).json({ error: '请提供 Key 顺序' });
    }
    const userId = req.session.user.id;
    await client.query('BEGIN');
    // 当前用户可见的全部 Key（自有 + Co-Key 成员）
    const visible = await client.query(`
      SELECT ak.id FROM api_keys ak
      WHERE ak.user_id = $1
         OR EXISTS (SELECT 1 FROM api_key_members m WHERE m.api_key_id = ak.id AND m.user_id = $1)
    `, [userId]);
    const visibleSet = new Set(visible.rows.map(r => r.id));
    let order = 0;
    for (const id of orderedIds) {
      if (!visibleSet.has(id)) continue;
      await client.query(`
        INSERT INTO api_key_user_orders (user_id, api_key_id, sort_order, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, api_key_id)
        DO UPDATE SET sort_order = EXCLUDED.sort_order, updated_at = CURRENT_TIMESTAMP
      `, [userId, id, order++]);
    }
    // 未出现在列表中的可见 Key 追加到末尾
    const listed = new Set(orderedIds.filter(id => visibleSet.has(id)));
    for (const id of visibleSet) {
      if (!listed.has(id)) {
        await client.query(`
          INSERT INTO api_key_user_orders (user_id, api_key_id, sort_order, updated_at)
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id, api_key_id)
          DO UPDATE SET sort_order = EXCLUDED.sort_order, updated_at = CURRENT_TIMESTAMP
        `, [userId, id, order++]);
      }
    }
    await client.query('COMMIT');
    Logger.info(`[API Key 排序] 用户 ${req.session.user.username} 更新了 ${order} 个 Key 的个人顺序`);
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    Logger.error('[API Key 排序] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  } finally {
    client.release();
  }
});

// 创建API密钥（无需审批，自动发放）
router.post('/api-keys', requireAuth, auditMiddleware(ACTIONS.API_KEY_CREATE, {
  resourceType: 'api_key',
  resourceIdFrom: (req, res) => res._logBody?.id,
  descriptionFrom: (req, res) => `创建 API Key「${req.body?.name || 'API Key'}」`,
}), async (req, res) => {
  const { name, expiresIn, customModelName } = req.body;

  try {
    const crypto = require('crypto');
    const hash = crypto.randomBytes(24).toString('hex');
    const rawKey = `sk-${hash}`;
    const keyPrefix = rawKey.substring(0, 12);
    const keyHash = require('bcryptjs').hashSync(rawKey, 10);

    let expiresAt = null;
    if (expiresIn) {
      expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + parseInt(expiresIn));
    }

    const result = await pool.query(
      'INSERT INTO api_keys (user_id, key_value, key_hash, key_prefix, name, expires_at, custom_model_name, quota_warning_enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE) RETURNING id, name, key_prefix, custom_model_name, created_at, expires_at',
      [req.session.user.id, rawKey, keyHash, keyPrefix, name || 'API Key', expiresAt, customModelName || 'claude-fable-5']
    );

    // 插件 apikey:created 钩子：创建后回调（异步、错误隔离）
    try {
      const pluginHooks = require('../plugins/hooks');
      if (pluginHooks.hasSubscribers('apikey:created')) {
        await pluginHooks.apply('apikey:created', {}, {
          keyId: result.rows[0].id,
          keyPrefix: result.rows[0].key_prefix,
          userId: req.session.user.id,
          username: req.session.user.username,
          name: name || 'API Key',
        });
      }
    } catch (err) {
      Logger.warn(`[apikey:created] 钩子异常: ${err.message}`);
    }

    res.json({ ...result.rows[0], key: rawKey });
  } catch (error) {
    Logger.error('[创建API密钥] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// Co-Key 成员管理：仅发起者可添加和移除成员。
router.get('/api-keys/:id/members', requireAuth, async (req, res) => {
  try {
    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, akmem.created_at
       FROM api_key_members akmem
       JOIN users u ON u.id = akmem.user_id
       WHERE akmem.api_key_id = $1
       ORDER BY akmem.created_at, u.id`,
      [req.params.id]
    );
    res.json({ is_owner: access.is_owner, members: result.rows });
  } catch (error) {
    Logger.error('[获取 Co-Key 成员] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.post('/api-keys/:id/members', requireAuth, auditMiddleware(ACTIONS.COKEY_MEMBER_ADD, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req, res) => `添加共同成员「${res._logBody?.username || req.body?.identity}」`,
  detailsFrom: (req, res) => ({ identity: req.body?.identity, member_id: res._logBody?.id, member: res._logBody?.username }),
}), async (req, res) => {
  const identity = String(req.body?.identity || '').trim().toLowerCase();
  if (!identity) return res.status(400).json({ error: '请输入完整用户名或邮箱' });
  try {
    const access = await getOwnedApiKey(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(403).json({ error: '仅发起者可管理成员' });
    const userResult = await pool.query(
      `SELECT id, username, email FROM users
       WHERE LOWER(username) = $1 OR LOWER(email) = $1
       LIMIT 1`,
      [identity]
    );
    const member = userResult.rows[0];
    if (!member) return res.status(404).json({ error: '用户不存在，请输入完整用户名或邮箱' });
    if (Number(member.id) === Number(access.owner_user_id)) {
      return res.status(400).json({ error: '发起者无需添加为共同成员' });
    }
    const inserted = await pool.query(
      `INSERT INTO api_key_members (api_key_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING created_at`,
      [req.params.id, member.id]
    );
    if (inserted.rowCount === 0) return res.status(409).json({ error: '该用户已是共同成员' });
    res.status(201).json({ ...member, created_at: inserted.rows[0].created_at });
  } catch (error) {
    Logger.error('[添加 Co-Key 成员] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.delete('/api-keys/:id/members/:userId(\\d+)', requireAuth, auditMiddleware(ACTIONS.COKEY_MEMBER_REMOVE, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `移除共同成员 #${req.params.userId}`,
  detailsFrom: (req) => ({ member_user_id: req.params.userId }),
}), async (req, res) => {
  try {
    const access = await getOwnedApiKey(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(403).json({ error: '仅发起者可管理成员' });
    const result = await pool.query(
      'DELETE FROM api_key_members WHERE api_key_id = $1 AND user_id = $2 RETURNING user_id',
      [req.params.id, req.params.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: '共同成员不存在' });
    res.json({ success: true });
  } catch (error) {
    Logger.error('[移除 Co-Key 成员] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 共同成员主动退出 Co-Key。身份固定取当前 session，不能代替其他成员退出。
router.delete('/api-keys/:id/members/me', requireAuth, auditMiddleware(ACTIONS.COKEY_MEMBER_LEAVE, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `退出 Co-Key #${req.params.id}`,
  detailsFrom: (req) => ({ member_user_id: req.session?.user?.id }),
}), async (req, res) => {
  try {
    const keyResult = await pool.query(
      'SELECT id, user_id FROM api_keys WHERE id = $1',
      [req.params.id]
    );
    const key = keyResult.rows[0];
    if (!key) return res.status(404).json({ error: '密钥不存在' });
    if (Number(key.user_id) === Number(req.session.user.id)) {
      return res.status(403).json({ error: '发起者不能退出自己的密钥，请使用成员管理或删除密钥' });
    }

    const result = await pool.query(
      'DELETE FROM api_key_members WHERE api_key_id = $1 AND user_id = $2 RETURNING api_key_id',
      [req.params.id, req.session.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: '您不是该 Co-Key 的共同成员' });
    res.json({ success: true, api_key_id: result.rows[0].api_key_id });
  } catch (error) {
    Logger.error('[退出 Co-Key] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除API密钥（仅发起者，无系统保留限制，删光亦可）
router.delete('/api-keys/:id', requireAuth, auditMiddleware(ACTIONS.API_KEY_DELETE, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `删除 API Key #${req.params.id}`,
}), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      'SELECT id FROM api_keys WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [req.params.id, req.session.user.id]
    );
    if (owned.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '密钥不存在或无权删除' });
    }
    // 历史库可能仍是 RESTRICT 外键：先断开用量关联，再删密钥
    await client.query('UPDATE usage_records SET api_key_id = NULL WHERE api_key_id = $1', [req.params.id]);
    await client.query('DELETE FROM api_keys WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    Logger.error('[删除API密钥] 错误:', error);
    res.status(500).json({ error: '删除失败：存在关联数据，请稍后重试' });
  } finally {
    client.release();
  }
});

// 更新API密钥设置（显示名称、虚拟模型名称等）
router.put('/api-keys/:id', requireAuth, auditMiddleware(ACTIONS.API_KEY_UPDATE, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新 API Key #${req.params.id} 设置`,
  detailsFrom: (req) => ({ name: req.body?.name, custom_model_name: req.body?.customModelName }),
}), async (req, res) => {
  const { customModelName, name } = req.body || {};
  try {
    const sets = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) {
      const trimmed = String(name ?? '').trim();
      if (!trimmed) {
        return res.status(400).json({ error: '名称不能为空' });
      }
      if (trimmed.length > 100) {
        return res.status(400).json({ error: '名称过长（最多 100 字）' });
      }
      sets.push(`name = $${idx++}`);
      params.push(trimmed);
    }
    if (customModelName !== undefined) {
      sets.push(`custom_model_name = $${idx++}`);
      params.push(customModelName || 'claude-fable-5');
    }
    if (!sets.length) {
      return res.status(400).json({ error: '无更新字段' });
    }

    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });
    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE api_keys SET ${sets.join(', ')}
       WHERE id = $${idx}
       RETURNING id, name, key_prefix, custom_model_name`,
      params
    );
    // 名称可能进入签名等缓存字段
    invalidateApiKeyCacheByKeyId(parseInt(req.params.id, 10));
    res.json(result.rows[0]);
  } catch (error) {
    Logger.error('[更新API密钥] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取单个API密钥的详细用量
router.get('/api-keys/:id/usage', requireAuth, async (req, res) => {
  try {
    const keyAccess = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!keyAccess) return res.status(404).json({ error: '密钥不存在' });

    const result = await pool.query(`
      SELECT
        DATE(ur.created_at) AS date,
        ur.model_id,
        m.name as model_name,
        SUM(ur.tokens_used) AS tokens,
        SUM(ur.cost) AS cost,
        COUNT(*) AS requests
      FROM usage_records ur
      LEFT JOIN models m ON ur.model_id = m.id
      WHERE ur.api_key_id = $1
      GROUP BY DATE(ur.created_at), ur.model_id, m.name
      ORDER BY date DESC
      LIMIT 100
    `, [req.params.id]);
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取密钥用量] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

const MAX_MODEL_QUEUE_SIZE = 10;

// 获取 API Key 可用的模型列表（基于用户所在 Team）+ 有序队列
router.get('/api-keys/:id/models', requireAuth, async (req, res) => {
  try {
    const keyAccess = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!keyAccess) return res.status(404).json({ error: '密钥不存在' });

    const apiKeyId = parseInt(req.params.id, 10);

    // 有序队列
    const queueResult = await pool.query(
      `SELECT akm.model_id, akm.sort_order, m.name, m.provider, m.series, m.icon_url
       FROM api_key_models akm
       LEFT JOIN models m ON m.id = akm.model_id
       WHERE akm.api_key_id = $1 AND akm.enabled IS DISTINCT FROM FALSE
       ORDER BY akm.sort_order ASC, akm.id ASC`,
      [apiKeyId]
    );
    const queue = queueResult.rows.map((row, idx) => ({
      model_id: row.model_id,
      id: row.model_id,
      name: row.name || row.model_id,
      provider: row.provider,
      series: row.series,
      icon_url: row.icon_url,
      sort_order: row.sort_order != null ? row.sort_order : idx
    }));

    // Co-Key 始终按发起者所在 Team 决定可用模型，避免成员改变计费归属权限。
    const userTeamsResult = await pool.query(
      'SELECT team_id FROM user_teams WHERE user_id = $1',
      [keyAccess.owner_user_id]
    );
    const teamIds = userTeamsResult.rows.map(r => r.team_id);

    if (teamIds.length === 0) {
      return res.json({ models: [], queue });
    }

    // 获取所有 Team 可用的模型（去重），并标记当前 Key 队列中的模型
    const placeholders = teamIds.map((_, i) => `$${i + 2}`).join(', ');
    const result = await pool.query(`
      SELECT DISTINCT m.id, m.name, m.provider, m.series, m.description, m.enabled, m.icon_url,
             m.input_price_per_1k_tokens, m.output_price_per_1k_tokens,
             COALESCE(akm.model_id IS NOT NULL, FALSE) AS assigned,
             akm.sort_order
      FROM team_models tm
      JOIN models m ON tm.model_id = m.id
      LEFT JOIN api_key_models akm ON akm.model_id = m.id AND akm.api_key_id = $1
      WHERE tm.team_id IN (${placeholders}) AND tm.enabled = TRUE AND m.enabled = TRUE
      ORDER BY m.provider, m.name
    `, [apiKeyId, ...teamIds]);

    res.json({ models: result.rows, queue });
  } catch (error) {
    Logger.error('[获取密钥模型列表] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新 API Key 模型队列（有序；兼容旧单选 modelId）
router.put('/api-keys/:id/models', requireAuth, auditMiddleware(ACTIONS.API_KEY_MODELS, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req, res) => `更新 API Key #${req.params.id} 模型队列`,
  detailsFrom: (req, res) => ({ model_ids: req.body?.modelIds || (req.body?.modelId ? [req.body.modelId] : []) }),
}), async (req, res) => {
  const { modelId, modelIds } = req.body;
  try {
    const keyAccess = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!keyAccess) return res.status(404).json({ error: '密钥不存在' });

    // 归一化为有序 modelIds
    let orderedIds = [];
    if (Array.isArray(modelIds)) {
      orderedIds = modelIds.map(id => String(id || '').trim()).filter(Boolean);
    } else if (modelId) {
      orderedIds = [String(modelId).trim()].filter(Boolean);
    }

    // 去重，保留首次出现顺序
    const seen = new Set();
    orderedIds = orderedIds.filter(id => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    if (orderedIds.length > MAX_MODEL_QUEUE_SIZE) {
      return res.status(400).json({ error: `模型队列最多 ${MAX_MODEL_QUEUE_SIZE} 个` });
    }

    // 校验每个模型存在、供应商启用，且属于发起者可用的 Team。
    for (const mid of orderedIds) {
      const modelCheck = await pool.query(
        `SELECT m.id, p.enabled AS provider_enabled,
                EXISTS (
                  SELECT 1 FROM team_models tm
                  JOIN user_teams ut ON ut.team_id = tm.team_id
                  WHERE tm.model_id = m.id AND tm.enabled = TRUE AND ut.user_id = $2
                ) AS owner_can_use
         FROM models m JOIN providers p ON m.provider = p.id
         WHERE m.id = $1`,
        [mid, keyAccess.owner_user_id]
      );
      if (modelCheck.rows.length === 0) {
        return res.status(404).json({ error: `模型不存在: ${mid}` });
      }
      if (modelCheck.rows[0].provider_enabled === false) {
        return res.status(400).json({ error: `该供应商已禁用，无法选择模型: ${mid}` });
      }
      if (!modelCheck.rows[0].owner_can_use) {
        return res.status(403).json({ error: `发起者无权使用该模型: ${mid}` });
      }
    }

    const apiKeyId = parseInt(req.params.id, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM api_key_models WHERE api_key_id = $1', [apiKeyId]);
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          'INSERT INTO api_key_models (api_key_id, model_id, sort_order) VALUES ($1, $2, $3)',
          [apiKeyId, orderedIds[i], i]
        );
      }
      await client.query(
        'UPDATE api_keys SET current_model_id = $1 WHERE id = $2',
        [orderedIds[0] || null, apiKeyId]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // 立即失效 API Key 缓存，使新队列即时生效
    invalidateApiKeyCacheByKeyId(apiKeyId);

    res.json({ success: true, modelIds: orderedIds, current_model_id: orderedIds[0] || null });
  } catch (error) {
    Logger.error('[更新密钥模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

/** 校验模型是否可被 Key 发起者使用（与默认模型队列一致） */
async function assertOwnerCanUseModel(modelId, ownerUserId) {
  const modelCheck = await pool.query(
    `SELECT m.id, m.name, p.enabled AS provider_enabled, p.name AS provider_name,
            EXISTS (
              SELECT 1 FROM team_models tm
              JOIN user_teams ut ON ut.team_id = tm.team_id
              WHERE tm.model_id = m.id AND tm.enabled = TRUE AND ut.user_id = $2
            ) AS owner_can_use
     FROM models m JOIN providers p ON m.provider = p.id
     WHERE m.id = $1`,
    [modelId, ownerUserId]
  );
  if (modelCheck.rows.length === 0) {
    return { error: `模型不存在: ${modelId}`, status: 404 };
  }
  if (modelCheck.rows[0].provider_enabled === false) {
    return { error: `该供应商已禁用，无法选择模型: ${modelId}`, status: 400 };
  }
  if (!modelCheck.rows[0].owner_can_use) {
    return { error: `发起者无权使用该模型: ${modelId}`, status: 403 };
  }
  return { row: modelCheck.rows[0] };
}

// 获取 API Key 的 Harness 单独绑定
router.get('/api-keys/:id/harness-models', requireAuth, async (req, res) => {
  try {
    const keyAccess = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!keyAccess) return res.status(404).json({ error: '密钥不存在' });

    const result = await pool.query(
      `SELECT akhm.harness, akhm.model_id, m.name, p.name AS provider_name
       FROM api_key_harness_models akhm
       LEFT JOIN models m ON m.id = akhm.model_id
       LEFT JOIN providers p ON m.provider = p.id
       WHERE akhm.api_key_id = $1
       ORDER BY akhm.harness ASC`,
      [req.params.id]
    );

    res.json({
      harness_models: result.rows.map(r => ({
        harness: r.harness,
        model_id: r.model_id,
        name: r.name || r.model_id,
        provider_name: r.provider_name || '',
        label: sourceLabel(r.harness),
      })),
      available_harnesses: HARNESS_SOURCES.map(h => ({ id: h, label: sourceLabel(h) })),
    });
  } catch (error) {
    Logger.error('[获取密钥 Harness 绑定] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 设置 / 清除 API Key 对某个 Harness 的模型绑定
router.put('/api-keys/:id/harness-models', requireAuth, auditMiddleware(ACTIONS.API_KEY_MODELS, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => {
    const h = req.body?.harness || '';
    const mid = req.body?.modelId;
    if (mid == null || mid === '') {
      return `清除 API Key #${req.params.id} 的 ${h || 'harness'} 模型绑定`;
    }
    return `为 API Key #${req.params.id} 绑定 ${h} → ${mid}`;
  },
  detailsFrom: (req) => ({ harness: req.body?.harness, model_id: req.body?.modelId ?? null }),
}), async (req, res) => {
  try {
    const keyAccess = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!keyAccess) return res.status(404).json({ error: '密钥不存在' });

    const harness = String(req.body?.harness || '').trim().toLowerCase();
    if (!isHarnessSource(harness) || harness === 'unknown') {
      return res.status(400).json({
        error: `无效的 harness，可选: ${HARNESS_SOURCES.join(', ')}`,
      });
    }

    const apiKeyId = parseInt(req.params.id, 10);
    const rawModelId = req.body?.modelId;
    const clear = rawModelId == null || rawModelId === '';

    if (clear) {
      await pool.query(
        'DELETE FROM api_key_harness_models WHERE api_key_id = $1 AND harness = $2',
        [apiKeyId, harness]
      );
      invalidateApiKeyCacheByKeyId(apiKeyId);
      return res.json({
        success: true,
        harness,
        model_id: null,
        cleared: true,
      });
    }

    const modelId = String(rawModelId).trim();
    const check = await assertOwnerCanUseModel(modelId, keyAccess.owner_user_id);
    if (check.error) {
      return res.status(check.status).json({ error: check.error });
    }

    await pool.query(
      `INSERT INTO api_key_harness_models (api_key_id, harness, model_id, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (api_key_id, harness)
       DO UPDATE SET model_id = EXCLUDED.model_id, updated_at = CURRENT_TIMESTAMP`,
      [apiKeyId, harness, modelId]
    );

    invalidateApiKeyCacheByKeyId(apiKeyId);
    res.json({
      success: true,
      harness,
      model_id: modelId,
      name: check.row.name || modelId,
      provider_name: check.row.provider_name || '',
      label: sourceLabel(harness),
      cleared: false,
    });
  } catch (error) {
    Logger.error('[更新密钥 Harness 绑定] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取 API Key 的 Fusion 配置
router.get('/api-keys/:id/fusion-config', requireAuth, async (req, res) => {
  try {
    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });
    const keyResult = await pool.query(
      'SELECT fusion_panel_models, fusion_judge_model_id, fusion_outer_model_id, fusion_enabled FROM api_keys WHERE id = $1',
      [req.params.id]
    );
    if (keyResult.rows.length === 0) {
      return res.status(404).json({ error: '密钥不存在' });
    }

    const key = keyResult.rows[0];
    res.json({
      panel_models: key.fusion_panel_models || [],
      judge_model_id: key.fusion_judge_model_id || '',
      outer_model_id: key.fusion_outer_model_id || '',
      fusion_enabled: key.fusion_enabled !== false
    });
  } catch (error) {
    Logger.error('[获取Fusion配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新 API Key 的 Fusion 配置
router.put('/api-keys/:id/fusion-config', requireAuth, auditMiddleware(ACTIONS.API_KEY_FUSION, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新 API Key #${req.params.id} Fusion 配置`,
  detailsFrom: (req) => ({
    panel_models: req.body?.panel_models,
    judge_model_id: req.body?.judge_model_id,
    outer_model_id: req.body?.outer_model_id,
    fusion_enabled: req.body?.fusion_enabled,
  }),
}), async (req, res) => {
  try {
    const { panel_models, judge_model_id, outer_model_id, fusion_enabled } = req.body;

    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });

    if (!Array.isArray(panel_models)) {
      return res.status(400).json({ error: 'panel_models 必须为数组' });
    }
    const normalizedPanelModels = [...new Set(panel_models.map(id => String(id || '').trim()).filter(Boolean))];
    if (normalizedPanelModels.length > 10) {
      return res.status(400).json({ error: 'Fusion Panel 模型最多 10 个' });
    }
    const normalizedJudgeModel = String(judge_model_id || '').trim();
    const normalizedOuterModel = String(outer_model_id || '').trim();
    const fusionModelIds = [...new Set([...normalizedPanelModels, normalizedJudgeModel, normalizedOuterModel].filter(Boolean))];
    if (fusionModelIds.length > 0) {
      const allowedModels = await pool.query(
        `SELECT DISTINCT m.id
         FROM models m
         JOIN providers p ON p.id = m.provider AND p.enabled = TRUE
         JOIN team_models tm ON tm.model_id = m.id AND tm.enabled = TRUE
         JOIN user_teams ut ON ut.team_id = tm.team_id
         WHERE m.id = ANY($1::text[]) AND m.enabled = TRUE AND ut.user_id = $2`,
        [fusionModelIds, access.owner_user_id]
      );
      const allowedIds = new Set(allowedModels.rows.map(row => String(row.id)));
      const forbiddenId = fusionModelIds.find(id => !allowedIds.has(id));
      if (forbiddenId) {
        return res.status(403).json({ error: `发起者无权使用该 Fusion 模型: ${forbiddenId}` });
      }
    }

    await pool.query(
      `UPDATE api_keys SET fusion_panel_models = $1, fusion_judge_model_id = $2, fusion_outer_model_id = $3, fusion_enabled = $4 WHERE id = $5`,
      [JSON.stringify(normalizedPanelModels), normalizedJudgeModel, normalizedOuterModel, fusion_enabled !== false, req.params.id]
    );

    invalidateApiKeyCacheByKeyId(parseInt(req.params.id));
    Logger.info(`[Fusion] 更新 API Key ${req.params.id} 的 Fusion 配置: enabled=${fusion_enabled !== false}, panel=${normalizedPanelModels.length}, judge=${normalizedJudgeModel}, outer=${normalizedOuterModel}`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[更新Fusion配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取 API Key 的签名配置
router.get('/api-keys/:id/quota-warning', requireAuth, async (req, res) => {
  try {
    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });
    const result = await pool.query('SELECT quota_warning_enabled FROM api_keys WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '密钥不存在' });
    res.json({ quota_warning_enabled: result.rows[0].quota_warning_enabled === true });
  } catch (error) {
    Logger.error('[获取额度预警配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.put('/api-keys/:id/quota-warning', requireAuth, auditMiddleware(ACTIONS.API_KEY_UPDATE, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `${req.body?.quota_warning_enabled ? '启用' : '关闭'} API Key #${req.params.id} 额度预警`
}), async (req, res) => {
  try {
    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });
    const result = await pool.query(
      'UPDATE api_keys SET quota_warning_enabled = $1 WHERE id = $2 RETURNING id, quota_warning_enabled',
      [req.body?.quota_warning_enabled === true, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '密钥不存在' });
    invalidateApiKeyCacheByKeyId(parseInt(req.params.id, 10));
    res.json({ success: true, quota_warning_enabled: result.rows[0].quota_warning_enabled });
  } catch (error) {
    Logger.error('[更新额度预警配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.get('/api-keys/:id/signature', requireAuth, async (req, res) => {
  try {
    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });
    const keyResult = await pool.query(
      `SELECT ak.signature_enabled, ak.signature_template,
              owner.api_signature_enabled AS owner_signature_enabled,
              owner.api_signature_template AS owner_signature_template
       FROM api_keys ak
       JOIN users owner ON owner.id = ak.user_id
       WHERE ak.id = $1`,
      [req.params.id]
    );
    if (keyResult.rows.length === 0) {
      return res.status(404).json({ error: '密钥不存在' });
    }

    const key = keyResult.rows[0];
    res.json({
      key_signature_enabled: key.signature_enabled,
      key_signature_template: key.signature_template,
      user_signature_enabled: key.owner_signature_enabled,
      user_signature_template: key.owner_signature_template
    });
  } catch (error) {
    Logger.error('[获取签名配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新 API Key 的签名配置
router.put('/api-keys/:id/signature', requireAuth, auditMiddleware(ACTIONS.API_KEY_SIGNATURE, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新 API Key #${req.params.id} 签名配置`,
  detailsFrom: (req) => ({ signature_enabled: req.body?.signature_enabled }),
}), async (req, res) => {
  try {
    const { signature_enabled, signature_template } = req.body;

    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });
    const keyResult = await pool.query(
      'SELECT id FROM api_keys WHERE id = $1',
      [req.params.id]
    );
    if (keyResult.rows.length === 0) {
      return res.status(404).json({ error: '密钥不存在' });
    }

    await pool.query(
      `UPDATE api_keys SET signature_enabled = $1, signature_template = $2 WHERE id = $3`,
      [signature_enabled, signature_template || null, req.params.id]
    );

    // 失效缓存，使签名配置立即生效
    invalidateApiKeyCacheByKeyId(parseInt(req.params.id));

    Logger.info(`[签名] 更新 API Key ${req.params.id} 的签名配置: enabled=${signature_enabled}, template=${signature_template ? '有' : '无'}`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[更新签名配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 切换 API Key 启用/禁用状态
router.put('/api-keys/:id/enabled', requireAuth, auditMiddleware(ACTIONS.API_KEY_TOGGLE, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `${req.body?.enabled ? '启用' : '禁用'} API Key #${req.params.id}`,
  detailsFrom: (req) => ({ enabled: !!req.body?.enabled }),
}), async (req, res) => {
  const { enabled } = req.body;
  try {
    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });
    const result = await pool.query(
      'UPDATE api_keys SET enabled = $1 WHERE id = $2 RETURNING id, enabled',
      [!!enabled, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '密钥不存在' });
    }
    invalidateApiKeyCacheByKeyId(parseInt(req.params.id));
    res.json({ success: true, enabled: result.rows[0].enabled });
  } catch (error) {
    Logger.error('[更新密钥启用状态] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 切换 API Key 吞图（不转发客户端图片到上游）
router.put('/api-keys/:id/swallow-images', requireAuth, auditMiddleware(ACTIONS.API_KEY_SWALLOW_IMAGES, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `${req.body?.swallow_images ? '启用' : '禁用'} API Key #${req.params.id} 吞图`,
  detailsFrom: (req) => ({ swallow_images: !!req.body?.swallow_images }),
}), async (req, res) => {
  const { swallow_images } = req.body || {};
  try {
    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });
    const result = await pool.query(
      'UPDATE api_keys SET swallow_images = $1 WHERE id = $2 RETURNING id, swallow_images',
      [!!swallow_images, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '密钥不存在' });
    }
    invalidateApiKeyCacheByKeyId(parseInt(req.params.id, 10));
    Logger.info(`[吞图] 更新 API Key ${req.params.id}: swallow_images=${!!swallow_images}`);
    res.json({ success: true, swallow_images: result.rows[0].swallow_images });
  } catch (error) {
    Logger.error('[更新密钥吞图状态] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.put('/api-keys/:id/crewrouter-commands', requireAuth, auditMiddleware(ACTIONS.API_KEY_CREWROUTER_COMMANDS, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `${req.body?.crewrouter_commands ? '允许' : '禁止'} API Key #${req.params.id} 使用 @CrewRouter 指令`,
  detailsFrom: (req) => ({ crewrouter_commands: !!req.body?.crewrouter_commands }),
}), async (req, res) => {
  const { crewrouter_commands } = req.body || {};
  try {
    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });
    const result = await pool.query(
      'UPDATE api_keys SET crewrouter_commands = $1 WHERE id = $2 RETURNING id, crewrouter_commands',
      [!!crewrouter_commands, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '密钥不存在' });
    }
    invalidateApiKeyCacheByKeyId(parseInt(req.params.id, 10));
    Logger.info(`[CrewRouter指令] 更新 API Key ${req.params.id}: crewrouter_commands=${!!crewrouter_commands}`);
    res.json({ success: true, crewrouter_commands: result.rows[0].crewrouter_commands });
  } catch (error) {
    Logger.error('[更新密钥 CrewRouter 指令开关] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取 API Key 定时配置
router.get('/api-keys/:id/schedule', requireAuth, async (req, res) => {
  try {
    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });
    const result = await pool.query(
      `SELECT schedule_enabled, schedule_on_time, schedule_off_time, schedule_days, schedule_timezone
       FROM api_keys WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '密钥不存在' });
    }
    const s = result.rows[0];
    res.json({
      schedule_enabled: s.schedule_enabled || false,
      schedule_on_time: s.schedule_on_time || null,
      schedule_off_time: s.schedule_off_time || null,
      schedule_days: s.schedule_days || [0, 1, 2, 3, 4, 5, 6],
      schedule_timezone: s.schedule_timezone || 'Asia/Shanghai'
    });
  } catch (error) {
    Logger.error('[获取密钥调度] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新 API Key 定时配置
router.put('/api-keys/:id/schedule', requireAuth, auditMiddleware(ACTIONS.API_KEY_SCHEDULE, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新 API Key #${req.params.id} 定时配置`,
  detailsFrom: (req) => ({
    schedule_enabled: req.body?.schedule_enabled,
    schedule_on_time: req.body?.schedule_on_time,
    schedule_off_time: req.body?.schedule_off_time,
  }),
}), async (req, res) => {
  const { schedule_enabled, schedule_on_time, schedule_off_time, schedule_days, schedule_timezone } = req.body;
  try {
    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });

    if (schedule_enabled && (!schedule_on_time || !schedule_off_time)) {
      return res.status(400).json({ error: '启用调度时必须设置开启和关闭时间' });
    }

    await pool.query(
      `UPDATE api_keys SET
        schedule_enabled = $1,
        schedule_on_time = $2,
        schedule_off_time = $3,
        schedule_days = $4,
        schedule_timezone = $5
       WHERE id = $6`,
      [
        !!schedule_enabled,
        schedule_on_time || null,
        schedule_off_time || null,
        schedule_days || [0, 1, 2, 3, 4, 5, 6],
        schedule_timezone || 'Asia/Shanghai',
        req.params.id
      ]
    );

    invalidateApiKeyCacheByKeyId(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    Logger.error('[更新密钥调度] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 生成 Claude Code 配置
router.get('/api-keys/:id/config', requireAuth, async (req, res) => {
  try {
    const access = await getApiKeyAccess(pool, req.params.id, req.session.user.id);
    if (!access) return res.status(404).json({ error: '密钥不存在' });
    const keyResult = await pool.query(
      'SELECT key_value, current_model_id FROM api_keys WHERE id = $1',
      [req.params.id]
    );
    if (keyResult.rows.length === 0) {
      return res.status(404).json({ error: '密钥不存在' });
    }

    const { key_value } = keyResult.rows[0];

    // 构建服务器 URL
    const host = config.app?.host;
    const baseUrl = (host === 'localhost' || !host)
      ? `http://localhost:${config.app?.port || 20003}`
      : `https://${host}`;

    // Claude Code 固定使用 claude-fable-5 作为模型名，服务器端根据 Key 的 current_model_id 做路由
    const modelName = 'claude-fable-5';

    const claudeConfig = {
      env: {
        ANTHROPIC_MODEL: modelName,
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: modelName,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: modelName,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_DEFAULT_SONNET_MODEL: modelName,
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: modelName,
        ANTHROPIC_DEFAULT_OPUS_MODEL: modelName,
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: modelName,
        ANTHROPIC_DEFAULT_FABLE_MODEL: modelName,
        ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: modelName,
        ANTHROPIC_AUTH_TOKEN: key_value,
        DISABLE_INSTALLATION_CHECKS: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0'
      },
      attribution: { commit: '', pr: '' },
      model: 'opus[1m]',
      effortLevel: 'xhigh',
      autoUpdatesChannel: 'latest'
    };

    res.json(claudeConfig);
  } catch (error) {
    Logger.error('[生成Claude配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用户总使用统计
router.get('/usage', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        DATE(created_at) as date,
        SUM(tokens_used) as total_tokens,
        SUM(cost) as total_cost,
        COUNT(*) as total_requests
      FROM usage_records
      WHERE user_id = $1
      GROUP BY DATE(created_at)
      ORDER BY date DESC
      LIMIT 30
    `, [req.session.user.id]);
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取使用统计] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用户详细统计数据（支持时间段筛选）
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const startDate = req.query.start;
    const endDate = req.query.end;
    const filterModel = req.query.model_id || '';
    const filterProvider = req.query.provider_id || '';
    const filterTeam = req.query.team_id || '';
    const { normalizeRequestSource } = require('../utils/usage-logs-filter');
    const filterSource = normalizeRequestSource(req.query.request_source);

    let dateFilter = '';
    const params = [userId];
    let paramIdx = 2;

    let start_date, end_date;
    if (startDate && endDate) {
      start_date = startDate;
      end_date = endDate;
    } else {
      // 业务日历日统一为 Asia/Shanghai（会话时区已对齐，墙钟即上海时间）
      const range = shanghaiDateRange(days);
      start_date = range.start;
      end_date = range.end;
    }
    dateFilter = `AND ur.created_at >= $${paramIdx}::date AND ur.created_at < ($${paramIdx + 1}::date + INTERVAL '1 day')`;
    params.push(start_date, end_date);
    paramIdx += 2;

    // 额外筛选条件
    let extraFilter = '';
    if (filterModel) {
      extraFilter += ` AND ur.model_id = $${paramIdx}`;
      params.push(filterModel);
      paramIdx++;
    }
    if (filterProvider) {
      extraFilter += ` AND ur.provider_id = $${paramIdx}`;
      params.push(filterProvider);
      paramIdx++;
    }
    if (filterTeam) {
      extraFilter += ` AND ur.model_id IN (SELECT model_id FROM team_models WHERE team_id = $${paramIdx})`;
      params.push(filterTeam);
      paramIdx++;
    }
    if (filterSource) {
      extraFilter += ` AND COALESCE(ur.request_source, 'unknown') = $${paramIdx}`;
      params.push(filterSource);
      paramIdx++;
    }

    // 简化版日期筛选（用于不 JOIN api_keys 的查询）
    const dateFilterSimple = dateFilter.replace(/ur\./g, '');

    // created_at 为上海墙钟（会话 TimeZone=Asia/Shanghai），直接按日期/小时聚合
    const dailyQuery = pool.query(`
      SELECT
        to_char(created_at, 'YYYY-MM-DD') as date,
        COUNT(*) as requests,
        SUM(tokens_used) as tokens,
        SUM(prompt_tokens) as prompt_tokens,
        SUM(completion_tokens) as completion_tokens,
        SUM(cached_tokens) as cached_tokens,
        SUM(cost) as cost,
        AVG(latency_ms) as avg_latency
      FROM usage_records ur
      WHERE ur.user_id = $1 ${dateFilter} ${extraFilter}
      GROUP BY to_char(created_at, 'YYYY-MM-DD')
      ORDER BY date ASC
    `, params);

    const modelQuery = pool.query(`
      SELECT
        ur.model_id,
        m.name as model_name,
        COUNT(*) as requests,
        SUM(ur.tokens_used) as tokens,
        SUM(ur.prompt_tokens) as prompt_tokens,
        SUM(ur.completion_tokens) as completion_tokens,
        SUM(ur.cached_tokens) as cached_tokens,
        SUM(ur.cost) as cost,
        AVG(ur.latency_ms) as avg_latency
      FROM usage_records ur
      LEFT JOIN models m ON ur.model_id = m.id
      WHERE ur.user_id = $1 ${dateFilter} ${extraFilter}
      GROUP BY ur.model_id, m.name
      ORDER BY requests DESC
    `, params);

    const hourlyQuery = pool.query(`
      SELECT
        EXTRACT(HOUR FROM created_at)::int as hour,
        COUNT(*) as requests,
        SUM(tokens_used) as tokens,
        SUM(cached_tokens) as cached_tokens,
        SUM(cost) as cost
      FROM usage_records ur
      WHERE ur.user_id = $1 ${dateFilter} ${extraFilter}
      GROUP BY EXTRACT(HOUR FROM created_at)
      ORDER BY hour ASC
    `, params);

    const apiKeyQuery = pool.query(`
      SELECT
        ak.id as key_id,
        ak.name as key_name,
        ak.key_prefix,
        COUNT(ur.id) as requests,
        SUM(ur.tokens_used) as tokens,
        SUM(ur.cached_tokens) as cached_tokens,
        SUM(ur.cost) as cost
      FROM usage_records ur
      JOIN api_keys ak ON ur.api_key_id = ak.id
      WHERE ur.user_id = $1 ${dateFilter} ${extraFilter}
      GROUP BY ak.id, ak.name, ak.key_prefix
      ORDER BY requests DESC
    `, params);

    const summaryQuery = pool.query(`
      SELECT
        COUNT(*) as total_requests,
        SUM(tokens_used) as total_tokens,
        SUM(prompt_tokens) as total_prompt_tokens,
        SUM(completion_tokens) as total_completion_tokens,
        SUM(cached_tokens) as total_cached_tokens,
        SUM(cost) as total_cost,
        AVG(latency_ms) as avg_latency,
        MIN(created_at) as first_request,
        MAX(created_at) as last_request
      FROM usage_records ur
      WHERE ur.user_id = $1 ${dateFilter} ${extraFilter}
    `, params);

    const sourceQuery = pool.query(`
      SELECT
        COALESCE(NULLIF(ur.request_source, ''), 'unknown') as request_source,
        COUNT(*) as requests,
        SUM(ur.tokens_used) as tokens,
        SUM(ur.prompt_tokens) as prompt_tokens,
        SUM(ur.completion_tokens) as completion_tokens,
        SUM(ur.cached_tokens) as cached_tokens,
        SUM(ur.cost) as cost,
        AVG(ur.latency_ms) as avg_latency
      FROM usage_records ur
      WHERE ur.user_id = $1 ${dateFilter} ${extraFilter}
      GROUP BY COALESCE(NULLIF(ur.request_source, ''), 'unknown')
      ORDER BY requests DESC
    `, params);

    const dailyBySourceQuery = pool.query(`
      SELECT
        to_char(ur.created_at, 'YYYY-MM-DD') as date,
        COALESCE(NULLIF(ur.request_source, ''), 'unknown') as request_source,
        COUNT(*) as requests,
        SUM(ur.tokens_used) as tokens,
        SUM(ur.cost) as cost
      FROM usage_records ur
      WHERE ur.user_id = $1 ${dateFilter} ${extraFilter}
      GROUP BY to_char(ur.created_at, 'YYYY-MM-DD'), COALESCE(NULLIF(ur.request_source, ''), 'unknown')
      ORDER BY date ASC, requests DESC
    `, params);

    const sourceModelQuery = pool.query(`
      SELECT
        COALESCE(NULLIF(ur.request_source, ''), 'unknown') as request_source,
        ur.model_id,
        m.name as model_name,
        COUNT(*) as requests,
        SUM(ur.tokens_used) as tokens,
        SUM(ur.cost) as cost
      FROM usage_records ur
      LEFT JOIN models m ON ur.model_id = m.id
      WHERE ur.user_id = $1 ${dateFilter} ${extraFilter}
      GROUP BY COALESCE(NULLIF(ur.request_source, ''), 'unknown'), ur.model_id, m.name
      ORDER BY requests DESC
      LIMIT 80
    `, params);

    // 插件维度：stats:record 写入的 plugin_meta 中，约定包含 name 的维度键按
    // `plugin:xxx` 或 `dim:xxx` 形式聚合（扩展统计维度展示）
    const pluginQuery = pool.query(`
      SELECT
        (jsonb_each_text(COALESCE(ur.plugin_meta, '{}'::jsonb))).key as plugin_dim,
        COUNT(*) as requests,
        SUM(ur.tokens_used) as tokens,
        SUM(ur.cost) as cost
      FROM usage_records ur
      WHERE ur.user_id = $1 ${dateFilter} ${extraFilter}
        AND ur.plugin_meta IS NOT NULL
      GROUP BY (jsonb_each_text(COALESCE(ur.plugin_meta, '{}'::jsonb))).key
      ORDER BY requests DESC
      LIMIT 50
    `, params);

    const [dailyResult, modelResult, hourlyResult, apiKeyResult, summaryResult, sourceResult, dailyBySourceResult, sourceModelResult, pluginResult] = await Promise.all([
      dailyQuery, modelQuery, hourlyQuery, apiKeyQuery, summaryQuery, sourceQuery, dailyBySourceQuery, sourceModelQuery, pluginQuery
    ]);

    const { buildSourceStats } = require('../utils/source-stats');
    const { bySource, sourceSummary } = buildSourceStats(sourceResult.rows);
    const summary = summaryResult.rows[0] || {};
    summary.known_requests = sourceSummary.known_requests;
    summary.unknown_requests = sourceSummary.unknown_requests;
    summary.identified_rate = sourceSummary.identified_rate;
    summary.active_sources = sourceSummary.active_sources;

    res.json({
      daily: dailyResult.rows,
      byModel: modelResult.rows,
      hourly: hourlyResult.rows,
      byApiKey: apiKeyResult.rows,
      bySource,
      dailyBySource: dailyBySourceResult.rows,
      bySourceModel: sourceModelResult.rows,
      byPlugin: pluginResult.rows,
      sourceSummary,
      summary
    });
  } catch (error) {
    Logger.error('[获取用户统计] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 面向普通用户的项目工作统计：只查询后台已经持久化的分析结果。
router.get('/project-stats', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const params = [userId];
    let idx = 2;
    let dateWhere = '';
    if (req.query.start && req.query.end) {
      dateWhere = `AND uma.created_at >= $${idx}::date AND uma.created_at < ($${idx + 1}::date + INTERVAL '1 day')`;
      params.push(req.query.start, req.query.end);
      idx += 2;
    } else {
      dateWhere = `AND uma.created_at >= NOW() - ($${idx++}::int * INTERVAL '1 day')`;
      params.push(days);
    }
    const source = String(req.query.request_source || '').trim().toLowerCase();
    const sourceWhere = source ? `AND uma.request_source = $${idx++}` : '';
    if (source) params.push(source);

    const base = `FROM usage_message_analysis uma
      WHERE uma.user_id = $1 ${dateWhere} ${sourceWhere}
        AND NULLIF(TRIM(uma.workspace_path), '') IS NOT NULL`;
    const filteredCte = `WITH filtered AS (SELECT uma.* ${base})`;
    const [summaryResult, projectResult, dailyResult] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS requests,
                         COALESCE(SUM(uma.tokens_used), 0)::bigint AS tokens,
                         COALESCE(SUM(uma.cost), 0)::numeric AS cost,
                         COUNT(DISTINCT uma.workspace_path)::int AS projects,
                         COUNT(DISTINCT DATE(uma.created_at))::int AS active_days,
                         MIN(uma.created_at) AS first_activity,
                         MAX(uma.created_at) AS last_activity ${base}`, params),
      pool.query(`${filteredCte}, source_counts AS (
                    SELECT workspace_path, request_source, COUNT(*)::int AS source_count
                    FROM filtered GROUP BY workspace_path, request_source
                  )
                  SELECT f.workspace_path,
                         COUNT(*)::int AS requests,
                         COALESCE(SUM(f.tokens_used), 0)::bigint AS tokens,
                         COALESCE(SUM(f.cost), 0)::numeric AS cost,
                         COUNT(DISTINCT DATE(f.created_at))::int AS active_days,
                         MIN(f.created_at) AS first_activity,
                         MAX(f.created_at) AS last_activity,
                         ROUND(AVG(f.total_characters))::int AS avg_characters,
                         COALESCE((SELECT jsonb_object_agg(sc.request_source, sc.source_count) FROM source_counts sc WHERE sc.workspace_path = f.workspace_path), '{}'::jsonb) AS sources
                  FROM filtered f
                  GROUP BY f.workspace_path
                  ORDER BY requests DESC, last_activity DESC
                  LIMIT 100`, params),
      pool.query(`SELECT DATE(uma.created_at)::text AS date,
                         COUNT(*)::int AS requests,
                         COALESCE(SUM(uma.tokens_used), 0)::bigint AS tokens,
                         COALESCE(SUM(uma.cost), 0)::numeric AS cost,
                         COUNT(DISTINCT uma.workspace_path)::int AS projects
                  ${base}
                  GROUP BY DATE(uma.created_at)
                  ORDER BY date ASC`, params)
    ]);
    const status = await require('../utils/message-analysis-store').getMessageAnalysisStatus(userId);
    res.json({ summary: { ...(summaryResult.rows[0] || {}), analysis_status: status }, projects: projectResult.rows, daily: dailyResult.rows });
  } catch (error) {
    Logger.error('[获取用户项目工作统计] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 消息结构聚合统计：限定当前用户，只读取后台持久化的分析标记。
router.get('/message-stats', requireAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const params = [req.session.user.id];
    const where = ['user_id = $1'];
    let idx = 2;
    if (req.query.start && req.query.end) {
      where.push(`created_at >= $${idx++}::date AND created_at < ($${idx++}::date + INTERVAL '1 day')`);
      params.push(req.query.start, req.query.end);
    } else {
      where.push(`created_at >= NOW() - ($${idx++}::int * INTERVAL '1 day')`);
      params.push(days);
    }
    const source = String(req.query.request_source || '').trim().toLowerCase();
    if (source) { where.push(`request_source = $${idx++}`); params.push(source); }
    if (req.query.workspace_path) { where.push(`workspace_path = $${idx++}`); params.push(String(req.query.workspace_path)); }
    if (req.query.block) {
      const block = String(req.query.block).replace(/[^a-z0-9_-]/gi, '');
      if (block) { where.push(`COALESCE((block_counts ->> $${idx++})::int, 0) > 0`); params.push(block); }
    }
    const result = await pool.query(`
      SELECT created_at, request_source, workspace_path, message_count, total_characters,
             total_lines, metadata_message_count, has_workspace_path, has_git_status,
             has_project_layout, has_environment_context, block_counts, observed_fields,
             "values", tokens_used, cost
      FROM usage_message_analysis
      WHERE ${where.join(' AND ')}
      ORDER BY created_at ASC
    `, params);
    const { aggregateMessageStats } = require('../utils/message-analysis');
    const { getMessageAnalysisStatus } = require('../utils/message-analysis-store');
    const stats = aggregateMessageStats(result.rows.map(row => ({ ...row, analysis: row })));
    const status = await getMessageAnalysisStatus(req.session.user.id);
    stats.summary.sampled = false;
    stats.summary.sample_size = result.rows.length;
    stats.summary.analysis_status = status;
    res.json(stats);
  } catch (error) {
    Logger.error('[用户消息结构统计] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用户余额
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT balance, group_id, rate_limit_rpm, rate_limit_tpm FROM users WHERE id = $1',
      [req.session.user.id]
    );
    const row = result.rows[0] || {};
    // 计算可退款余额：扣除手续费后的实际可退款金额
    const refundResult = await pool.query(
      `SELECT COALESCE(SUM(amount / (1 + fee_rate)), 0) AS net_refundable
       FROM user_code_balances
       WHERE user_id = $1 AND amount > 0`,
      [req.session.user.id]
    );

    // 获取用户组信息和规则
    let group = null;
    if (row.group_id) {
      const groupResult = await pool.query(
        'SELECT id, name, description FROM user_groups WHERE id = $1',
        [row.group_id]
      );
      if (groupResult.rows.length > 0) {
        const rulesResult = await pool.query(
          'SELECT rule_type, rule_value, duration_hours, description FROM user_group_rules WHERE group_id = $1 ORDER BY rule_type',
          [row.group_id]
        );

        // 计算每个规则的当前用量
        const rulesWithUsage = await Promise.all(rulesResult.rows.map(async (rule) => {
          let current = 0;
          try {
            const hours = rule.duration_hours || 24;
            if (rule.rule_type === 'requests') {
              const r = await pool.query(
                `SELECT COUNT(*)::int AS cnt FROM usage_records WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour' * $2`,
                [req.session.user.id, hours]
              );
              current = r.rows[0]?.cnt || 0;
            } else if (rule.rule_type === 'tokens') {
              const r = await pool.query(
                `SELECT COALESCE(SUM(weighted_tokens), 0)::bigint AS cnt FROM usage_records WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour' * $2`,
                [req.session.user.id, hours]
              );
              current = parseInt(r.rows[0]?.cnt || 0);
            }
          } catch (e) {
            Logger.warn(`[用量查询] ${rule.rule_type} 失败: ${e.message}`);
          }
          return { ...rule, current };
        }));

        group = {
          ...groupResult.rows[0],
          rules: rulesWithUsage
        };
      }
    }

    res.json({
      balance: parseFloat(row.balance || 0),
      refund_balance: parseFloat(refundResult.rows[0]?.net_refundable || 0),
      rate_limit_rpm: row.rate_limit_rpm || 0,
      rate_limit_tpm: parseInt(row.rate_limit_tpm || 0),
      group
    });
  } catch (error) {
    Logger.error('[获取余额] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// cc-switch 用量查询（支持 API Key Bearer 认证）
router.post('/usage', async (req, res) => {
  try {
    // 从 Bearer token 提取 API Key
    let apiKey = req.headers['x-api-key'] || req.query?.api_key;
    if (!apiKey && req.headers.authorization?.startsWith('Bearer ')) {
      apiKey = req.headers.authorization.slice(7);
    }
    if (!apiKey) {
      return res.status(401).json({ error: 'Missing API key' });
    }

    // 查找用户
    const keyResult = await pool.query(
      `SELECT u.id, u.username, u.balance, u.group_id
       FROM api_keys ak JOIN users u ON ak.user_id = u.id
       WHERE ak.key_value = $1`,
      [apiKey]
    );
    if (keyResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    const user = keyResult.rows[0];

    // 获取用户组规则和当前用量
    let groupInfo = null;
    if (user.group_id) {
      const groupResult = await pool.query(
        'SELECT id, name, description FROM user_groups WHERE id = $1',
        [user.group_id]
      );
      if (groupResult.rows.length > 0) {
        const rulesResult = await pool.query(
          'SELECT rule_type, rule_value, duration_hours FROM user_group_rules WHERE group_id = $1',
          [user.group_id]
        );

        const rules = await Promise.all(rulesResult.rows.map(async (rule) => {
          const hours = rule.duration_hours || 24;
          let used = 0;
          try {
            if (rule.rule_type === 'requests') {
              const r = await pool.query(
                'SELECT COUNT(*)::int AS cnt FROM usage_records WHERE user_id = $1 AND created_at > NOW() - INTERVAL \'1 hour\' * $2',
                [user.id, hours]
              );
              used = r.rows[0]?.cnt || 0;
            } else if (rule.rule_type === 'tokens') {
              const r = await pool.query(
                'SELECT COALESCE(SUM(tokens_used), 0)::bigint AS cnt FROM usage_records WHERE user_id = $1 AND created_at > NOW() - INTERVAL \'1 hour\' * $2',
                [user.id, hours]
              );
              used = parseInt(r.rows[0]?.cnt || 0);
            }
          } catch (e) { /* ignore */ }

          const label = hours >= 24 ? `${hours / 24}天` : `${hours}小时`;
          return {
            type: rule.rule_type,
            limit: parseInt(rule.rule_value),
            used,
            remaining: Math.max(0, parseInt(rule.rule_value) - used),
            window: label
          };
        }));

        groupInfo = { name: groupResult.rows[0].name, rules };
      }
    }

    // 总使用统计
    const usageResult = await pool.query(
      `SELECT
        COALESCE(SUM(tokens_used), 0)::bigint AS total_tokens,
        COALESCE(SUM(cost), 0)::numeric AS total_cost,
        COUNT(*)::int AS total_requests
       FROM usage_records WHERE user_id = $1`,
      [user.id]
    );
    const usage = usageResult.rows[0];

    res.json({
      username: user.username,
      balance: parseFloat(user.balance || 0),
      total_requests: usage.total_requests,
      total_tokens: parseInt(usage.total_tokens),
      total_cost: parseFloat(usage.total_cost),
      group: groupInfo
    });
  } catch (error) {
    Logger.error('[cc-switch用量查询] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用户可退款兑换码余额明细
router.get('/code-balances', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ucb.amount, ucb.fee_rate, rc.code, rc.amount AS code_amount,
              ucb.amount / (1 + ucb.fee_rate) AS net_amount
       FROM user_code_balances ucb
       JOIN redemption_codes rc ON rc.id = ucb.code_id
       WHERE ucb.user_id = $1 AND ucb.amount > 0
       ORDER BY ucb.fee_rate DESC`,
      [req.session.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取兑换码余额明细] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取商品列表（仅上架商品）
router.get('/products', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, description, image_url, link, sort_order FROM products WHERE is_active = true ORDER BY sort_order ASC, created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取商品列表] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 上传头像（代理到图床）
router.post('/avatar', requireAuth, auditMiddleware(ACTIONS.USER_AVATAR, {
  resourceType: 'user',
  descriptionFrom: (req) => '更新头像',
}), async (req, res) => {
  try {
    const http = require('http');
    const https = require('https');
    const { IncomingForm } = require('formidable');

    const form = new IncomingForm({
      maxFileSize: 5 * 1024 * 1024,
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);
    const imageFile = files.image?.[0];
    if (!imageFile) {
      return res.status(400).json({ error: '未选择图片' });
    }

    const fs = require('fs');
    const fileData = fs.readFileSync(imageFile.filepath);

    const boundary = '----FormBoundary' + Date.now().toString(16);
    const fileName = imageFile.originalFilename || 'avatar.jpg';
    const fileType = imageFile.mimetype || 'image/jpeg';

    let body = '';
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="image"; filename="${fileName}"\r\n`;
    body += `Content-Type: ${fileType}\r\n\r\n`;

    const bodyEnd = `\r\n--${boundary}--\r\n`;

    const bodyStart = Buffer.from(body, 'utf-8');
    const bodyEndBuf = Buffer.from(bodyEnd, 'utf-8');
    const fullBody = Buffer.concat([bodyStart, fileData, bodyEndBuf]);

    const options = {
      hostname: 'img.bloret.net',
      port: 80,
      path: '/api/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length,
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', (chunk) => { data += chunk; });
      proxyRes.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.success && result.data?.url) {
            const avatarUrl = `https://img.bloret.net${result.data.url}`;
            pool.query(
              'UPDATE users SET avatar = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
              [req.session.user.id, avatarUrl]
            ).then(() => {
              req.session.user.avatar = avatarUrl;
              res.json({ success: true, url: avatarUrl });
            }).catch(() => {
              res.json({ success: true, url: avatarUrl });
            });
          } else {
            res.status(500).json({ error: result.message || '上传失败' });
          }
        } catch (e) {
          res.status(500).json({ error: '上传响应解析失败' });
        }
      });
    });

    proxyReq.on('error', (err) => {
      Logger.error('[上传头像] 代理请求失败:', err);
      res.status(500).json({ error: '上传服务不可用' });
    });

    proxyReq.write(fullBody);
    proxyReq.end();
  } catch (error) {
    Logger.error('[上传头像] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新用户设置
router.put('/settings', requireAuth, auditMiddleware(ACTIONS.USER_SETTINGS, {
  resourceType: 'user',
  descriptionFrom: (req) => '更新用户设置',
  detailsFrom: (req) => ({ email: req.body?.email, api_signature_enabled: req.body?.api_signature_enabled }),
}), async (req, res) => {
  const { email, avatar, api_signature_enabled, api_signature_template } = req.body;

  try {
    // 邮箱统一转小写
    const normalizedEmail = email ? email.toLowerCase().trim() : email;

    // Build dynamic UPDATE — only set fields that were provided
    const sets = [];
    const params = [req.session.user.id];
    let idx = 2;

    if (email !== undefined) {
      sets.push(`email = $${idx++}`);
      params.push(normalizedEmail);
    }
    if (avatar !== undefined) {
      sets.push(`avatar = $${idx++}`);
      params.push(avatar);
    }
    if (api_signature_enabled !== undefined) {
      sets.push(`api_signature_enabled = $${idx++}`);
      params.push(!!api_signature_enabled);
    }
    if (api_signature_template !== undefined) {
      sets.push(`api_signature_template = $${idx++}`);
      params.push(api_signature_template);
    }

    if (sets.length === 0) {
      return res.json({ success: true });
    }

    sets.push('updated_at = CURRENT_TIMESTAMP');
    await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1`,
      params
    );

    if (email !== undefined) req.session.user.email = normalizedEmail;
    if (avatar !== undefined) req.session.user.avatar = avatar;
    if (api_signature_enabled !== undefined) req.session.user.api_signature_enabled = !!api_signature_enabled;
    if (api_signature_template !== undefined) req.session.user.api_signature_template = api_signature_template;

    res.json({ success: true });
  } catch (error) {
    Logger.error('[更新用户设置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ========== 兑换码 ==========

// 使用兑换码
router.post('/redeem', requireAuth, auditMiddleware(ACTIONS.USER_REDEEM, {
  resourceType: 'user',
  descriptionFrom: (req) => `兑换码「${String(req.body?.code || '').slice(0, 8)}…」`,
  detailsFrom: (req) => ({ code: req.body?.code }),
}), async (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: '请输入兑换码' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 查找兑换码并加行锁
    const result = await client.query(
      'SELECT * FROM redemption_codes WHERE code = $1 FOR UPDATE',
      [code.trim().toUpperCase()]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '兑换码不存在' });
    }

    const rc = result.rows[0];

    // 检查是否过期
    if (rc.expires_at && new Date(rc.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '兑换码已过期' });
    }

    // 检查使用次数
    if (rc.max_uses > 0 && rc.used_count >= rc.max_uses) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '兑换码使用次数已达上限' });
    }

    // 检查该用户是否已兑换过此码
    const usedCheck = await client.query(
      'SELECT 1 FROM redemption_code_uses WHERE code_id = $1 AND user_id = $2',
      [rc.id, req.session.user.id]
    );
    if (usedCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '您已使用过此兑换码' });
    }

    // 根据是否可退款，分入不同余额
    if (rc.refundable) {
      // 记录该兑换码的余额明细
      await client.query(
        `INSERT INTO user_code_balances (user_id, code_id, amount, fee_rate)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, code_id) DO UPDATE SET
           amount = user_code_balances.amount + EXCLUDED.amount,
           updated_at = CURRENT_TIMESTAMP`,
        [req.session.user.id, rc.id, rc.amount, rc.fee_rate || 0]
      );
      // 同步 users.refund_balance
      const refundSum = await client.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM user_code_balances WHERE user_id = $1',
        [req.session.user.id]
      );
      await client.query(
        'UPDATE users SET refund_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [parseFloat(refundSum.rows[0].total), req.session.user.id]
      );
    } else {
      await client.query(
        'UPDATE users SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [rc.amount, req.session.user.id]
      );
    }

    // 增加已使用次数
    await client.query(
      'UPDATE redemption_codes SET used_count = used_count + 1 WHERE id = $1',
      [rc.id]
    );

    // 记录该用户已使用此码
    await client.query(
      'INSERT INTO redemption_code_uses (code_id, user_id) VALUES ($1, $2)',
      [rc.id, req.session.user.id]
    );

    await client.query('COMMIT');

    // 获取新余额
    const balanceResult = await pool.query('SELECT balance, refund_balance FROM users WHERE id = $1', [req.session.user.id]);
    const newBalance = parseFloat(balanceResult.rows[0]?.balance || 0);
    const newRefundBalance = parseFloat(balanceResult.rows[0]?.refund_balance || 0);

    // 同步 session
    req.session.user.balance = newBalance;
    req.session.user.refund_balance = newRefundBalance;

    Logger.info(`[兑换码] 用户 ${req.session.user.username} 使用了兑换码 ${rc.code}，面额 ¥${rc.amount}${rc.refundable ? ' (可退款)' : ''}`);
    res.json({
      success: true,
      amount: parseFloat(rc.amount),
      balance: newBalance,
      refund_balance: newRefundBalance,
      refundable: rc.refundable
    });
  } catch (error) {
    await client.query('ROLLBACK');
    Logger.error('[使用兑换码] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  } finally {
    client.release();
  }
});

// 获取文档内容（公开接口）
router.get('/docs-content', async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'docs_content'");
    if (result.rows.length > 0) {
      const content = result.rows[0].value;
      res.json(typeof content === 'string' ? JSON.parse(content) : content);
    } else {
      res.json({});
    }
  } catch (error) {
    Logger.error('[获取文档内容] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== CrewRouter 模型库 ====================

function hasDuplicateIds(ids) {
  return new Set(ids.map(id => String(id))).size !== ids.length;
}

async function ensureUserTeamAccess(userId, teamId) {
  const membership = await pool.query(
    'SELECT 1 FROM user_teams WHERE team_id = $1 AND user_id = $2',
    [teamId, userId]
  );
  return membership.rows.length > 0;
}

async function validateProviderOrder(userId, teamId, providerIds) {
  if (!await ensureUserTeamAccess(userId, teamId)) return false;
  const result = await pool.query(`
    SELECT DISTINCT p.id
    FROM team_models tm
    JOIN models m ON tm.model_id = m.id
    JOIN providers p ON m.provider = p.id
    WHERE tm.team_id = $1 AND tm.enabled = TRUE AND m.enabled = TRUE
      AND p.id = ANY($2::VARCHAR[])
  `, [teamId, providerIds]);
  return result.rows.length === providerIds.length;
}

async function validateModelOrder(userId, teamId, providerId, modelIds) {
  if (!await ensureUserTeamAccess(userId, teamId)) return false;
  const result = await pool.query(`
    SELECT m.id
    FROM team_models tm
    JOIN models m ON tm.model_id = m.id
    WHERE tm.team_id = $1 AND m.provider = $2
      AND tm.enabled = TRUE AND m.enabled = TRUE
      AND m.id = ANY($3::VARCHAR[])
  `, [teamId, providerId, modelIds]);
  return result.rows.length === modelIds.length;
}

async function replaceLibraryOrder(client, userId, scope, { teamId, providerId, orderedIds }) {
  if (scope === 'team') {
    await client.query('DELETE FROM user_model_library_team_orders WHERE user_id = $1', [userId]);
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        `INSERT INTO user_model_library_team_orders (user_id, team_id, sort_order, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [userId, orderedIds[i], i]
      );
    }
    return;
  }

  if (scope === 'provider') {
    await client.query(
      'DELETE FROM user_model_library_provider_orders WHERE user_id = $1 AND team_id = $2',
      [userId, teamId]
    );
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        `INSERT INTO user_model_library_provider_orders (user_id, team_id, provider_id, sort_order, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
        [userId, teamId, orderedIds[i], i]
      );
    }
    return;
  }

  if (scope === 'model') {
    await client.query(
      'DELETE FROM user_model_library_model_orders WHERE user_id = $1 AND team_id = $2 AND provider_id = $3',
      [userId, teamId, providerId]
    );
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        `INSERT INTO user_model_library_model_orders (user_id, team_id, provider_id, model_id, sort_order, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [userId, teamId, providerId, orderedIds[i], i]
      );
    }
  }
}

// 获取当前用户的模型库（根据 user_teams 查询，按 Team 分组）
router.get('/model-library', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    // 获取用户所在的所有 Team
    const userTeamsResult = await pool.query(
      `SELECT t.id, t.name, t.description, t.is_personal, t.is_default,
              uto.sort_order AS custom_sort_order
       FROM teams t
       JOIN user_teams ut ON t.id = ut.team_id
       LEFT JOIN user_model_library_team_orders uto
         ON uto.user_id = $1 AND uto.team_id = t.id
       WHERE ut.user_id = $1
       ORDER BY (uto.sort_order IS NULL) ASC, uto.sort_order ASC, t.is_personal DESC, t.name ASC`,
      [userId]
    );
    const teams = userTeamsResult.rows;

    if (teams.length === 0) {
      return res.json({ teams: [], starred_models: [] });
    }

    // 获取每个 Team 的供应商列表（不含模型明细，模型在展开供应商时按需加载）
    const teamsWithModels = [];
    for (const team of teams) {
      const providersResult = await pool.query(`
        SELECT p.id AS provider_id, p.name AS provider_name, p.notes AS provider_notes,
               p.enabled AS provider_enabled,
               COUNT(tm.model_id) AS model_count,
               COUNT(tm.model_id) FILTER (WHERE umh.model_id IS NULL) AS visible_model_count,
               COUNT(tm.model_id) FILTER (WHERE umh.model_id IS NOT NULL) AS hidden_model_count,
               COUNT(DISTINCT m.series) FILTER (WHERE m.series IS NOT NULL AND m.series <> '') AS series_count,
               COUNT(mtr.model_id) AS test_tested_count,
               COUNT(mtr.model_id) FILTER (WHERE mtr.ok IS TRUE) AS test_success_count,
               COUNT(mtr.model_id) FILTER (WHERE mtr.ok IS FALSE) AS test_failed_count,
               ROUND(AVG(mtr.latency_ms) FILTER (WHERE mtr.ok IS TRUE AND mtr.latency_ms IS NOT NULL)) AS test_avg_latency_ms,
               ROUND(AVG(mtr.tokens_per_second) FILTER (WHERE mtr.ok IS TRUE AND mtr.tokens_per_second IS NOT NULL), 1) AS test_avg_tokens_per_second,
               MAX(mtr.tested_at) AS test_latest_tested_at,
               upo.sort_order AS custom_sort_order,
               (uhp.provider_id IS NOT NULL) AS is_hidden
        FROM team_models tm
        JOIN models m ON tm.model_id = m.id
        JOIN providers p ON m.provider = p.id
        LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
        LEFT JOIN user_model_library_provider_orders upo
          ON upo.user_id = $2 AND upo.team_id = $1 AND upo.provider_id = p.id
        LEFT JOIN user_model_library_hidden_providers uhp
          ON uhp.user_id = $2 AND uhp.team_id = $1 AND uhp.provider_id = p.id
        LEFT JOIN user_model_library_hidden_models umh
          ON umh.user_id = $2 AND umh.team_id = $1 AND umh.provider_id = p.id AND umh.model_id = m.id
        WHERE tm.team_id = $1 AND tm.enabled = TRUE AND m.enabled = TRUE
        GROUP BY p.id, p.name, p.notes, p.enabled, upo.sort_order, uhp.provider_id
        ORDER BY (upo.sort_order IS NULL) ASC, upo.sort_order ASC, p.name ASC
      `, [team.id, userId]);

      teamsWithModels.push({
        team_id: team.id,
        team_name: team.name,
        team_description: team.description,
        is_personal: team.is_personal || false,
        is_default: team.is_default || false,
        custom_order: team.custom_sort_order != null,
        providers: providersResult.rows.map(row => {
          const total = parseInt(row.model_count, 10) || 0;
          const visibleTotal = parseInt(row.visible_model_count, 10) || 0;
          const hiddenTotal = parseInt(row.hidden_model_count, 10) || 0;
          const tested = parseInt(row.test_tested_count, 10) || 0;
          const success = parseInt(row.test_success_count, 10) || 0;
          const failed = parseInt(row.test_failed_count, 10) || 0;
          return {
            provider_id: row.provider_id,
            provider_name: row.provider_name,
            provider_notes: row.provider_notes || '',
            provider_enabled: row.provider_enabled,
            is_hidden: !!row.is_hidden,
            model_count: total,
            visible_model_count: visibleTotal,
            hidden_model_count: hiddenTotal,
            series_count: parseInt(row.series_count, 10) || 0,
            custom_order: row.custom_sort_order != null,
            test_summary: {
              total,
              tested,
              success,
              failed,
              untested: Math.max(total - tested, 0),
              avg_latency_ms: row.test_avg_latency_ms != null ? parseInt(row.test_avg_latency_ms, 10) : null,
              avg_tokens_per_second: row.test_avg_tokens_per_second != null ? parseFloat(row.test_avg_tokens_per_second) : null,
              latest_tested_at: row.test_latest_tested_at || null
            },
            models: [],
            models_loaded: false
          };
        })
      });
    }

    // 批量查询供应商标签并附加到 provider 对象
    try {
      const allProviderIds = teamsWithModels.flatMap(t => t.providers.map(p => p.provider_id));
      if (allProviderIds.length > 0) {
        const tagsResult = await pool.query(`
          SELECT pta.provider_id, pt.id, pt.name, pt.color
          FROM provider_tag_assignments pta
          JOIN provider_tags pt ON pta.tag_id = pt.id
          WHERE pta.provider_id = ANY($1)
        `, [allProviderIds]);
        const tagMap = {};
        for (const row of tagsResult.rows) {
          if (!tagMap[row.provider_id]) tagMap[row.provider_id] = [];
          tagMap[row.provider_id].push({ id: row.id, name: row.name, color: row.color });
        }
        for (const team of teamsWithModels) {
          for (const provider of team.providers) {
            provider.tags = tagMap[provider.provider_id] || [];
          }
        }
      }
    } catch (_) { /* 供应商标签表可能尚未创建 */ }

    // 聚合可用系列（供筛选下拉，无需展开供应商）
    let availableSeries = [];
    let totalModels = 0;
    try {
      const metaResult = await pool.query(`
        SELECT
          COUNT(*)::int AS total_models,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT m.series), NULL) AS series_list
        FROM team_models tm
        JOIN models m ON tm.model_id = m.id
        JOIN user_teams ut ON ut.team_id = tm.team_id
        WHERE ut.user_id = $1 AND tm.enabled = TRUE AND m.enabled = TRUE
          AND m.series IS NOT NULL AND m.series <> ''
      `, [userId]);
      const countOnly = await pool.query(`
        SELECT COUNT(*)::int AS total_models
        FROM team_models tm
        JOIN models m ON tm.model_id = m.id
        JOIN user_teams ut ON ut.team_id = tm.team_id
        WHERE ut.user_id = $1 AND tm.enabled = TRUE AND m.enabled = TRUE
      `, [userId]);
      totalModels = countOnly.rows[0]?.total_models || 0;
      const seriesRaw = metaResult.rows[0]?.series_list || [];
      availableSeries = (Array.isArray(seriesRaw) ? seriesRaw : [])
        .filter(s => s && String(s).trim())
        .map(s => String(s))
        .sort((a, b) => a.localeCompare(b));
    } catch (_) { /* 聚合失败不影响主体 */ }

    let starredModels = [];
    try {
      const starredResult = await pool.query(`
        SELECT m.id AS model_id, m.name, m.alias, m.provider, m.series, m.description,
               m.input_price_per_1k_tokens, m.output_price_per_1k_tokens, m.cached_output_price_per_1k_tokens,
               m.reference_input_price_per_1k_tokens, m.reference_output_price_per_1k_tokens,
               m.rate_limit_rpm, m.rate_limit_tpm, m.icon_url, m.created_by, m.enabled,
               m.billing_mode, m.model_multiplier, m.completion_multiplier,
               m.thinking_model_id, m.non_thinking_model_id,
               p.name AS provider_name, p.notes AS provider_notes, p.enabled AS provider_enabled,
               s.icon_url AS series_icon_url,
               COALESCE(NULLIF(m.upstream_model_id, ''), m.id) AS upstream_model_id,
               t.id AS team_id, t.name AS team_name, t.is_personal, t.is_default,
               mtr.ok AS test_ok, mtr.latency_ms AS test_latency_ms,
               mtr.tokens_per_second AS test_tokens_per_second,
               mtr.total_tokens AS test_total_tokens, mtr.error AS test_error,
               mtr.tested_at AS test_tested_at,
               (umh.model_id IS NOT NULL) AS is_hidden,
               ums.created_at AS starred_at
        FROM user_model_library_starred_models ums
        JOIN team_models tm ON tm.team_id = ums.team_id AND tm.model_id = ums.model_id AND tm.enabled = TRUE
        JOIN models m ON m.id = ums.model_id AND m.enabled = TRUE AND m.provider = ums.provider_id
        JOIN providers p ON p.id = ums.provider_id
        JOIN teams t ON t.id = ums.team_id
        JOIN user_teams ut ON ut.team_id = t.id AND ut.user_id = ums.user_id
        LEFT JOIN series s ON m.series = s.name
        LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
        LEFT JOIN user_model_library_hidden_models umh
          ON umh.user_id = ums.user_id AND umh.team_id = ums.team_id
         AND umh.provider_id = ums.provider_id AND umh.model_id = ums.model_id
        WHERE ums.user_id = $1
        ORDER BY ums.created_at DESC, m.name ASC
      `, [userId]);
      starredModels = starredResult.rows.map(row => ({
        model_id: row.model_id,
        name: row.name,
        alias: row.alias,
        series: row.series,
        description: row.description,
        input_price_per_1k_tokens: row.input_price_per_1k_tokens,
        output_price_per_1k_tokens: row.output_price_per_1k_tokens,
        cached_output_price_per_1k_tokens: row.cached_output_price_per_1k_tokens,
        reference_input_price_per_1k_tokens: row.reference_input_price_per_1k_tokens,
        reference_output_price_per_1k_tokens: row.reference_output_price_per_1k_tokens,
        rate_limit_rpm: row.rate_limit_rpm,
        rate_limit_tpm: row.rate_limit_tpm,
        icon_url: row.icon_url,
        series_icon_url: row.series_icon_url,
        created_by: row.created_by,
        enabled: row.enabled,
        billing_mode: row.billing_mode,
        model_multiplier: row.model_multiplier,
        completion_multiplier: row.completion_multiplier,
        thinking_model_id: row.thinking_model_id,
        non_thinking_model_id: row.non_thinking_model_id,
        upstream_model_id: row.upstream_model_id,
        provider_id: row.provider,
        provider_name: row.provider_name,
        provider_notes: row.provider_notes || '',
        provider_enabled: row.provider_enabled,
        team_id: row.team_id,
        team_name: row.team_name,
        is_personal: row.is_personal || false,
        is_default: row.is_default || false,
        is_hidden: !!row.is_hidden,
        is_starred: true,
        starred_at: row.starred_at,
        test_ok: row.test_ok,
        test_latency_ms: row.test_latency_ms,
        test_tokens_per_second: row.test_tokens_per_second,
        test_total_tokens: row.test_total_tokens,
        test_error: row.test_error,
        test_tested_at: row.test_tested_at
      }));
    } catch (e) {
      Logger.warn(`[获取模型库星标] 跳过: ${e.message}`);
    }

    res.json({
      teams: teamsWithModels,
      starred_models: starredModels,
      available_series: availableSeries,
      total_models: totalModels
    });
  } catch (error) {
    Logger.error('[获取模型库] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 全局搜索用户可见模型（避免前端为搜索展开全部供应商）
router.get('/model-library/search', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const requestedLimit = parseInt(req.query.limit || '30', 10) || 30;
    const limit = Math.min(Math.max(requestedLimit, 1), 50);
    const offset = (page - 1) * limit;
    const search = String(req.query.q || req.query.search || '').trim();
    const provider = String(req.query.provider || 'all');
    const series = String(req.query.series || 'all');
    const testFilter = String(req.query.test || 'all');
    const tagFilter = String(req.query.tag || 'all');
    const sort = String(req.query.sort || 'default');
    const includeHidden = req.query.include_hidden === '1' || req.query.include_hidden === 'true';

    const queryParams = [userId];
    const whereClauses = [
      'ut.user_id = $1',
      'tm.enabled = TRUE',
      'm.enabled = TRUE'
    ];

    if (!includeHidden) {
      whereClauses.push(`NOT EXISTS (
        SELECT 1 FROM user_model_library_hidden_models umh
        WHERE umh.user_id = $1 AND umh.team_id = tm.team_id
          AND umh.provider_id = m.provider AND umh.model_id = m.id
      )`);
      whereClauses.push(`NOT EXISTS (
        SELECT 1 FROM user_model_library_hidden_providers uhp
        WHERE uhp.user_id = $1 AND uhp.team_id = tm.team_id
          AND uhp.provider_id = m.provider
      )`);
    }

    if (search) {
      queryParams.push(`%${search}%`);
      const i = queryParams.length;
      whereClauses.push(`(
        m.name ILIKE $${i}
        OR COALESCE(m.description, '') ILIKE $${i}
        OR COALESCE(m.alias, '') ILIKE $${i}
        OR COALESCE(m.series, '') ILIKE $${i}
        OR COALESCE(m.upstream_model_id, '') ILIKE $${i}
        OR COALESCE(p.name, '') ILIKE $${i}
        OR COALESCE(t.name, '') ILIKE $${i}
      )`);
    }

    if (provider && provider !== 'all') {
      queryParams.push(provider);
      whereClauses.push(`p.name = $${queryParams.length}`);
    }

    if (series && series !== 'all') {
      queryParams.push(series);
      whereClauses.push(`m.series = $${queryParams.length}`);
    }

    if (testFilter === 'pass') {
      whereClauses.push('mtr.ok IS TRUE');
    } else if (testFilter === 'fail') {
      whereClauses.push('mtr.ok IS FALSE');
    } else if (testFilter === 'untested') {
      whereClauses.push('mtr.ok IS NULL');
    }

    if (tagFilter && tagFilter !== 'all') {
      const tagId = parseInt(String(tagFilter).replace(/^tag:/, ''), 10);
      if (Number.isInteger(tagId)) {
        queryParams.push(tagId);
        whereClauses.push(`EXISTS (
          SELECT 1 FROM provider_tag_assignments pta
          WHERE pta.provider_id = p.id AND pta.tag_id = $${queryParams.length}
        )`);
      }
    }

    const orderByMap = {
      default: 't.is_personal DESC, t.name ASC, p.name ASC, m.name ASC',
      price_asc: 'm.input_price_per_1k_tokens ASC NULLS LAST, m.name ASC',
      price_desc: 'm.input_price_per_1k_tokens DESC NULLS LAST, m.name ASC',
      name_asc: 'm.name ASC',
      name_desc: 'm.name DESC',
      test_latency_asc: 'CASE WHEN mtr.ok IS TRUE THEN 0 ELSE 1 END ASC, mtr.latency_ms ASC NULLS LAST, m.name ASC',
      test_latency_desc: 'CASE WHEN mtr.ok IS TRUE THEN 0 ELSE 1 END ASC, mtr.latency_ms DESC NULLS LAST, m.name ASC',
      test_tps_desc: 'CASE WHEN mtr.ok IS TRUE THEN 0 ELSE 1 END ASC, mtr.tokens_per_second DESC NULLS LAST, m.name ASC'
    };
    const orderBy = orderByMap[sort] || orderByMap.default;
    const whereSql = whereClauses.join(' AND ');

    const countResult = await pool.query(`
      SELECT COUNT(*) AS total
      FROM team_models tm
      JOIN models m ON tm.model_id = m.id
      JOIN providers p ON m.provider = p.id
      JOIN teams t ON t.id = tm.team_id
      JOIN user_teams ut ON ut.team_id = t.id
      LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
      WHERE ${whereSql}
    `, queryParams);

    const total = parseInt(countResult.rows[0]?.total, 10) || 0;
    const dataParams = [...queryParams, limit, offset];
    const limitParam = queryParams.length + 1;
    const offsetParam = queryParams.length + 2;

    const modelsResult = await pool.query(`
      SELECT m.id AS model_id, m.name, m.alias, m.provider, m.series, m.description,
             m.input_price_per_1k_tokens, m.output_price_per_1k_tokens, m.cached_output_price_per_1k_tokens,
             m.reference_input_price_per_1k_tokens, m.reference_output_price_per_1k_tokens,
             m.rate_limit_rpm, m.rate_limit_tpm, m.icon_url, m.created_by, m.enabled,
             m.billing_mode, m.model_multiplier, m.completion_multiplier,
             m.thinking_model_id, m.non_thinking_model_id,
             p.name AS provider_name, p.notes AS provider_notes, p.enabled AS provider_enabled,
             s.icon_url AS series_icon_url,
             COALESCE(NULLIF(m.upstream_model_id, ''), m.id) AS upstream_model_id,
             t.id AS team_id, t.name AS team_name, t.is_personal, t.is_default,
             mtr.ok AS test_ok, mtr.latency_ms AS test_latency_ms,
             mtr.tokens_per_second AS test_tokens_per_second,
             mtr.total_tokens AS test_total_tokens, mtr.error AS test_error,
             mtr.tested_at AS test_tested_at,
             (umh.model_id IS NOT NULL) AS is_hidden,
             (ums.model_id IS NOT NULL) AS is_starred
      FROM team_models tm
      JOIN models m ON tm.model_id = m.id
      JOIN providers p ON m.provider = p.id
      JOIN teams t ON t.id = tm.team_id
      JOIN user_teams ut ON ut.team_id = t.id
      LEFT JOIN series s ON m.series = s.name
      LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
      LEFT JOIN user_model_library_hidden_models umh
        ON umh.user_id = $1
       AND umh.team_id = tm.team_id
       AND umh.provider_id = m.provider
       AND umh.model_id = m.id
      LEFT JOIN user_model_library_starred_models ums
        ON ums.user_id = $1
       AND ums.team_id = tm.team_id
       AND ums.provider_id = m.provider
       AND ums.model_id = m.id
      WHERE ${whereSql}
      ORDER BY ${orderBy}
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `, dataParams);

    const models = modelsResult.rows.map(row => ({
      model_id: row.model_id,
      name: row.name,
      alias: row.alias,
      series: row.series,
      description: row.description,
      input_price_per_1k_tokens: row.input_price_per_1k_tokens,
      output_price_per_1k_tokens: row.output_price_per_1k_tokens,
      cached_output_price_per_1k_tokens: row.cached_output_price_per_1k_tokens,
      reference_input_price_per_1k_tokens: row.reference_input_price_per_1k_tokens,
      reference_output_price_per_1k_tokens: row.reference_output_price_per_1k_tokens,
      rate_limit_rpm: row.rate_limit_rpm,
      rate_limit_tpm: row.rate_limit_tpm,
      icon_url: row.icon_url,
      series_icon_url: row.series_icon_url,
      created_by: row.created_by,
      enabled: row.enabled,
      billing_mode: row.billing_mode,
      model_multiplier: row.model_multiplier,
      completion_multiplier: row.completion_multiplier,
      thinking_model_id: row.thinking_model_id,
      non_thinking_model_id: row.non_thinking_model_id,
      upstream_model_id: row.upstream_model_id,
      provider_id: row.provider,
      provider_name: row.provider_name,
      provider_notes: row.provider_notes || '',
      provider_enabled: row.provider_enabled,
      team_id: row.team_id,
      team_name: row.team_name,
      is_personal: row.is_personal || false,
      is_default: row.is_default || false,
      is_hidden: !!row.is_hidden,
      is_starred: !!row.is_starred,
      test_ok: row.test_ok,
      test_latency_ms: row.test_latency_ms,
      test_tokens_per_second: row.test_tokens_per_second,
      test_total_tokens: row.test_total_tokens,
      test_error: row.test_error,
      test_tested_at: row.test_tested_at
    }));

    res.json({
      models,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit) || 1,
        has_prev: page > 1,
        has_next: offset + models.length < total
      }
    });
  } catch (error) {
    Logger.error('[模型库全局搜索] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取供应商标签列表（所有登录用户可读）
router.get('/provider-tags', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, color, sort_order FROM provider_tags ORDER BY sort_order ASC, id ASC');
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取供应商标签] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取指定 Team 下某个供应商的模型明细（按需加载，模型库展开供应商时调用）
router.get('/team/:teamId/provider/:providerId/models', requireAuth, async (req, res) => {
  try {
    const { teamId, providerId } = req.params;
    const userId = req.session.user.id;
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const requestedLimit = parseInt(req.query.limit || '50', 10) || 50;
    const limit = Math.min(Math.max(requestedLimit, 1), 50);
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const series = String(req.query.series || 'all');
    const testFilter = String(req.query.test || 'all');
    const sort = String(req.query.sort || 'default');
    // include_hidden=1 时包含已隐藏模型（用于“显示已隐藏”模式）
    const includeHidden = req.query.include_hidden === '1' || req.query.include_hidden === 'true';

    // 权限校验：用户必须属于该 Team
    const membership = await pool.query(
      'SELECT 1 FROM user_teams WHERE team_id = $1 AND user_id = $2',
      [teamId, userId]
    );
    if (membership.rows.length === 0) {
      return res.status(403).json({ error: '无权访问该 Team' });
    }

    const queryParams = [teamId, providerId, userId];
    const whereClauses = [
      'tm.team_id = $1',
      'm.provider = $2',
      'tm.enabled = TRUE',
      'm.enabled = TRUE'
    ];

    if (!includeHidden) {
      whereClauses.push(`NOT EXISTS (
        SELECT 1 FROM user_model_library_hidden_models umh
        WHERE umh.user_id = $3 AND umh.team_id = tm.team_id
          AND umh.provider_id = m.provider AND umh.model_id = m.id
      )`);
    }

    if (search) {
      queryParams.push(`%${search}%`);
      const paramIndex = queryParams.length;
      whereClauses.push(`(
        m.name ILIKE $${paramIndex}
        OR COALESCE(m.description, '') ILIKE $${paramIndex}
        OR COALESCE(m.alias, '') ILIKE $${paramIndex}
        OR COALESCE(m.series, '') ILIKE $${paramIndex}
        OR COALESCE(m.upstream_model_id, '') ILIKE $${paramIndex}
      )`);
    }

    if (series && series !== 'all') {
      queryParams.push(series);
      whereClauses.push(`m.series = $${queryParams.length}`);
    }

    if (testFilter === 'pass') {
      whereClauses.push('mtr.ok IS TRUE');
    } else if (testFilter === 'fail') {
      whereClauses.push('mtr.ok IS FALSE');
    } else if (testFilter === 'untested') {
      whereClauses.push('mtr.ok IS NULL');
    }

    const orderByMap = {
      default: '(umo.sort_order IS NULL) ASC, umo.sort_order ASC, m.name ASC',
      price_asc: 'm.input_price_per_1k_tokens ASC NULLS LAST, m.name ASC',
      price_desc: 'm.input_price_per_1k_tokens DESC NULLS LAST, m.name ASC',
      name_asc: 'm.name ASC',
      name_desc: 'm.name DESC',
      test_latency_asc: 'CASE WHEN mtr.ok IS TRUE THEN 0 ELSE 1 END ASC, mtr.latency_ms ASC NULLS LAST, m.name ASC',
      test_latency_desc: 'CASE WHEN mtr.ok IS TRUE THEN 0 ELSE 1 END ASC, mtr.latency_ms DESC NULLS LAST, m.name ASC',
      test_tps_desc: 'CASE WHEN mtr.ok IS TRUE THEN 0 ELSE 1 END ASC, mtr.tokens_per_second DESC NULLS LAST, m.name ASC'
    };
    const orderBy = orderByMap[sort] || orderByMap.default;
    const whereSql = whereClauses.join(' AND ');

    const countResult = await pool.query(`
      SELECT COUNT(*) AS total
      FROM team_models tm
      JOIN models m ON tm.model_id = m.id
      LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
      WHERE ${whereSql}
    `, queryParams);

    const total = parseInt(countResult.rows[0]?.total, 10) || 0;

    const dataParams = [...queryParams, limit, offset];
    const limitParam = queryParams.length + 1;
    const offsetParam = queryParams.length + 2;
    const modelsResult = await pool.query(`
      SELECT m.id AS model_id, m.name, m.alias, m.provider, m.series, m.description,
             m.input_price_per_1k_tokens, m.output_price_per_1k_tokens, m.cached_output_price_per_1k_tokens,
             m.reference_input_price_per_1k_tokens, m.reference_output_price_per_1k_tokens,
             m.rate_limit_rpm, m.rate_limit_tpm, m.icon_url, m.created_by, m.enabled,
             m.billing_mode, m.model_multiplier, m.completion_multiplier,
             m.thinking_model_id, m.non_thinking_model_id,
             p.name AS provider_name, p.notes AS provider_notes, p.enabled AS provider_enabled,
             s.icon_url AS series_icon_url,
             COALESCE(NULLIF(m.upstream_model_id, ''), m.id) AS upstream_model_id,
             mtr.ok AS test_ok, mtr.latency_ms AS test_latency_ms,
             mtr.tokens_per_second AS test_tokens_per_second,
             mtr.total_tokens AS test_total_tokens, mtr.error AS test_error,
             mtr.tested_at AS test_tested_at,
             umo.sort_order AS custom_sort_order,
             (umh.model_id IS NOT NULL) AS is_hidden,
             (ums.model_id IS NOT NULL) AS is_starred
      FROM team_models tm
      JOIN models m ON tm.model_id = m.id
      JOIN providers p ON m.provider = p.id
      LEFT JOIN series s ON m.series = s.name
      LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
      LEFT JOIN user_model_library_model_orders umo
        ON umo.user_id = $3
       AND umo.team_id = tm.team_id
       AND umo.provider_id = m.provider
       AND umo.model_id = m.id
      LEFT JOIN user_model_library_hidden_models umh
        ON umh.user_id = $3
       AND umh.team_id = tm.team_id
       AND umh.provider_id = m.provider
       AND umh.model_id = m.id
      LEFT JOIN user_model_library_starred_models ums
        ON ums.user_id = $3
       AND ums.team_id = tm.team_id
       AND ums.provider_id = m.provider
       AND ums.model_id = m.id
      WHERE ${whereSql}
      ORDER BY ${orderBy}
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `, dataParams);

    const models = modelsResult.rows.map(row => ({
      model_id: row.model_id,
      name: row.name,
      alias: row.alias,
      series: row.series,
      description: row.description,
      input_price_per_1k_tokens: row.input_price_per_1k_tokens,
      output_price_per_1k_tokens: row.output_price_per_1k_tokens,
      cached_output_price_per_1k_tokens: row.cached_output_price_per_1k_tokens,
      reference_input_price_per_1k_tokens: row.reference_input_price_per_1k_tokens,
      reference_output_price_per_1k_tokens: row.reference_output_price_per_1k_tokens,
      rate_limit_rpm: row.rate_limit_rpm,
      rate_limit_tpm: row.rate_limit_tpm,
      icon_url: row.icon_url,
      series_icon_url: row.series_icon_url,
      created_by: row.created_by,
      enabled: row.enabled,
      billing_mode: row.billing_mode,
      model_multiplier: row.model_multiplier,
      completion_multiplier: row.completion_multiplier,
      thinking_model_id: row.thinking_model_id,
      non_thinking_model_id: row.non_thinking_model_id,
      upstream_model_id: row.upstream_model_id,
      provider_id: row.provider,
      provider_name: row.provider_name,
      custom_order: row.custom_sort_order != null,
      is_hidden: !!row.is_hidden,
      is_starred: !!row.is_starred,
      test_ok: row.test_ok,
      test_latency_ms: row.test_latency_ms,
      test_tokens_per_second: row.test_tokens_per_second,
      test_total_tokens: row.test_total_tokens,
      test_error: row.test_error,
      test_tested_at: row.test_tested_at
    }));

    res.json({
      team_id: teamId,
      provider_id: providerId,
      provider_name: modelsResult.rows[0]?.provider_name || '',
      models,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit) || 1,
        has_prev: page > 1,
        has_next: offset + models.length < total
      }
    });
  } catch (error) {
    Logger.error('[获取供应商模型明细] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 保存模型库自定义排序
router.put('/model-library/order', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { scope, teamId, providerId, orderedIds } = req.body || {};

  if (!['team', 'provider', 'model'].includes(scope)) {
    return res.status(400).json({ error: '无效的排序范围' });
  }
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return res.status(400).json({ error: '请提供 orderedIds 数组' });
  }
  if (hasDuplicateIds(orderedIds)) {
    return res.status(400).json({ error: 'orderedIds 不能包含重复项' });
  }

  try {
    let normalizedIds = orderedIds;
    let allowed = false;

    if (scope === 'team') {
      normalizedIds = orderedIds.map(id => parseInt(id, 10)).filter(id => Number.isInteger(id));
      if (normalizedIds.length !== orderedIds.length) {
        return res.status(400).json({ error: 'Team ID 无效' });
      }
      const access = await pool.query(
        'SELECT team_id FROM user_teams WHERE user_id = $1 AND team_id = ANY($2::INT[])',
        [userId, normalizedIds]
      );
      allowed = access.rows.length === normalizedIds.length;
    } else if (scope === 'provider') {
      if (!teamId) return res.status(400).json({ error: '请提供 teamId' });
      normalizedIds = orderedIds.map(id => String(id));
      allowed = await validateProviderOrder(userId, teamId, normalizedIds);
    } else if (scope === 'model') {
      if (!teamId || !providerId) return res.status(400).json({ error: '请提供 teamId 和 providerId' });
      normalizedIds = orderedIds.map(id => String(id));
      allowed = await validateModelOrder(userId, teamId, providerId, normalizedIds);
    }

    if (!allowed) {
      return res.status(403).json({ error: '无权调整该排序或包含无效项目' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await replaceLibraryOrder(client, userId, scope, {
        teamId,
        providerId,
        orderedIds: normalizedIds
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    res.json({ success: true });
  } catch (error) {
    Logger.error('[保存模型库排序] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

/**
 * 一键按模型测试结果写入自定义排序
 * sort: test_latency_asc | test_latency_desc | test_tps_desc
 * 会更新：各 Team 内供应商顺序 + 各供应商内模型顺序
 */
router.put('/model-library/order/by-test', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const sort = String((req.body && req.body.sort) || 'test_latency_asc');
  const allowedSorts = new Set(['test_latency_asc', 'test_latency_desc', 'test_tps_desc']);
  if (!allowedSorts.has(sort)) {
    return res.status(400).json({ error: '无效的测试排序方式' });
  }

  const modelOrderByMap = {
    test_latency_asc: `CASE WHEN mtr.ok IS TRUE THEN 0 ELSE 1 END ASC,
                       CASE WHEN mtr.ok IS TRUE THEN mtr.latency_ms ELSE NULL END ASC NULLS LAST,
                       m.name ASC`,
    test_latency_desc: `CASE WHEN mtr.ok IS TRUE THEN 0 ELSE 1 END ASC,
                        CASE WHEN mtr.ok IS TRUE THEN mtr.latency_ms ELSE NULL END DESC NULLS LAST,
                        m.name ASC`,
    test_tps_desc: `CASE WHEN mtr.ok IS TRUE THEN 0 ELSE 1 END ASC,
                    CASE WHEN mtr.ok IS TRUE THEN mtr.tokens_per_second ELSE NULL END DESC NULLS LAST,
                    m.name ASC`
  };
  const modelOrderBy = modelOrderByMap[sort];

  try {
    const teamsResult = await pool.query(
      'SELECT team_id FROM user_teams WHERE user_id = $1',
      [userId]
    );
    const teamIds = teamsResult.rows.map(r => r.team_id);
    if (teamIds.length === 0) {
      return res.json({ success: true, teams: 0, providers: 0, models: 0 });
    }

    const client = await pool.connect();
    let providerCount = 0;
    let modelCount = 0;
    try {
      await client.query('BEGIN');

      for (const teamId of teamIds) {
        // 供应商：按测试聚合指标排序（有通过结果优先，未测/失败靠后）
        const providersResult = await client.query(`
          SELECT p.id AS provider_id,
                 p.name AS provider_name,
                 COUNT(mtr.model_id) FILTER (WHERE mtr.ok IS TRUE) AS success_count,
                 MIN(mtr.latency_ms) FILTER (WHERE mtr.ok IS TRUE AND mtr.latency_ms IS NOT NULL) AS best_latency_ms,
                 MAX(mtr.tokens_per_second) FILTER (WHERE mtr.ok IS TRUE AND mtr.tokens_per_second IS NOT NULL) AS best_tps
          FROM team_models tm
          JOIN models m ON tm.model_id = m.id
          JOIN providers p ON m.provider = p.id
          LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
          WHERE tm.team_id = $1 AND tm.enabled = TRUE AND m.enabled = TRUE
          GROUP BY p.id, p.name
        `, [teamId]);

        const providerRows = [...providersResult.rows].sort((a, b) => {
          const aOk = Number(a.success_count) > 0;
          const bOk = Number(b.success_count) > 0;
          if (aOk !== bOk) return aOk ? -1 : 1;
          if (!aOk && !bOk) {
            return String(a.provider_name || '').localeCompare(String(b.provider_name || ''));
          }
          if (sort === 'test_tps_desc') {
            const aTps = a.best_tps != null ? Number(a.best_tps) : -Infinity;
            const bTps = b.best_tps != null ? Number(b.best_tps) : -Infinity;
            if (aTps !== bTps) return bTps - aTps;
          } else {
            const aLat = a.best_latency_ms != null ? Number(a.best_latency_ms) : Infinity;
            const bLat = b.best_latency_ms != null ? Number(b.best_latency_ms) : Infinity;
            if (aLat !== bLat) {
              return sort === 'test_latency_desc' ? bLat - aLat : aLat - bLat;
            }
          }
          return String(a.provider_name || '').localeCompare(String(b.provider_name || ''));
        });

        const providerIds = providerRows.map(r => r.provider_id);
        if (providerIds.length > 0) {
          await replaceLibraryOrder(client, userId, 'provider', {
            teamId,
            orderedIds: providerIds
          });
          providerCount += providerIds.length;
        }

        for (const providerId of providerIds) {
          const modelsResult = await client.query(`
            SELECT m.id AS model_id
            FROM team_models tm
            JOIN models m ON tm.model_id = m.id
            LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
            WHERE tm.team_id = $1 AND m.provider = $2
              AND tm.enabled = TRUE AND m.enabled = TRUE
            ORDER BY ${modelOrderBy}
          `, [teamId, providerId]);

          const modelIds = modelsResult.rows.map(r => r.model_id);
          if (modelIds.length > 0) {
            await replaceLibraryOrder(client, userId, 'model', {
              teamId,
              providerId,
              orderedIds: modelIds
            });
            modelCount += modelIds.length;
          }
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    res.json({
      success: true,
      sort,
      teams: teamIds.length,
      providers: providerCount,
      models: modelCount
    });
  } catch (error) {
    Logger.error('[按测试结果排序模型库] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 重置模型库自定义排序
router.delete('/model-library/order', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { scope = 'all', teamId, providerId } = req.query || {};

  if (!['all', 'team', 'provider', 'model'].includes(scope)) {
    return res.status(400).json({ error: '无效的排序范围' });
  }

  try {
    if ((scope === 'provider' || scope === 'model') && !teamId) {
      return res.status(400).json({ error: '请提供 teamId' });
    }
    if (scope === 'model' && !providerId) {
      return res.status(400).json({ error: '请提供 providerId' });
    }
    if ((scope === 'provider' || scope === 'model') && !await ensureUserTeamAccess(userId, teamId)) {
      return res.status(403).json({ error: '无权访问该 Team' });
    }

    if (scope === 'all') {
      await pool.query('DELETE FROM user_model_library_team_orders WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM user_model_library_provider_orders WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM user_model_library_model_orders WHERE user_id = $1', [userId]);
    } else if (scope === 'team') {
      await pool.query('DELETE FROM user_model_library_team_orders WHERE user_id = $1', [userId]);
    } else if (scope === 'provider') {
      await pool.query('DELETE FROM user_model_library_provider_orders WHERE user_id = $1 AND team_id = $2', [userId, teamId]);
    } else if (scope === 'model') {
      await pool.query(
        'DELETE FROM user_model_library_model_orders WHERE user_id = $1 AND team_id = $2 AND provider_id = $3',
        [userId, teamId, providerId]
      );
    }

    res.json({ success: true });
  } catch (error) {
    Logger.error('[重置模型库排序] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 校验用户是否有权访问指定 Team 下的供应商
async function validateLibraryProviderAccess(userId, teamId, providerId) {
  if (!await ensureUserTeamAccess(userId, teamId)) return false;
  const result = await pool.query(`
    SELECT 1
    FROM team_models tm
    JOIN models m ON tm.model_id = m.id
    WHERE tm.team_id = $1 AND m.provider = $2
      AND tm.enabled = TRUE AND m.enabled = TRUE
    LIMIT 1
  `, [teamId, providerId]);
  return result.rows.length > 0;
}

// 校验用户是否有权访问指定 Team 下的模型
async function validateLibraryModelAccess(userId, teamId, providerId, modelId) {
  if (!await ensureUserTeamAccess(userId, teamId)) return false;
  const result = await pool.query(`
    SELECT 1
    FROM team_models tm
    JOIN models m ON tm.model_id = m.id
    WHERE tm.team_id = $1 AND m.provider = $2 AND m.id = $3
      AND tm.enabled = TRUE AND m.enabled = TRUE
    LIMIT 1
  `, [teamId, providerId, modelId]);
  return result.rows.length > 0;
}

// 设置/取消模型库隐藏（供应商或模型）
router.put('/model-library/hidden', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { scope, teamId, providerId, modelId, hidden } = req.body || {};

  if (!['provider', 'model'].includes(scope)) {
    return res.status(400).json({ error: '无效的隐藏范围，仅支持 provider / model' });
  }
  if (teamId == null || teamId === '' || !providerId) {
    return res.status(400).json({ error: '请提供 teamId 和 providerId' });
  }
  if (scope === 'model' && !modelId) {
    return res.status(400).json({ error: '请提供 modelId' });
  }
  if (typeof hidden !== 'boolean') {
    return res.status(400).json({ error: '请提供 hidden 布尔值' });
  }

  try {
    const teamIdNum = parseInt(teamId, 10);
    if (!Number.isInteger(teamIdNum)) {
      return res.status(400).json({ error: 'Team ID 无效' });
    }
    const providerIdStr = String(providerId);
    const modelIdStr = modelId != null ? String(modelId) : null;

    if (scope === 'provider') {
      const allowed = await validateLibraryProviderAccess(userId, teamIdNum, providerIdStr);
      if (!allowed) return res.status(403).json({ error: '无权操作该供应商' });

      if (hidden) {
        await pool.query(`
          INSERT INTO user_model_library_hidden_providers (user_id, team_id, provider_id, created_at)
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id, team_id, provider_id) DO NOTHING
        `, [userId, teamIdNum, providerIdStr]);
      } else {
        await pool.query(
          'DELETE FROM user_model_library_hidden_providers WHERE user_id = $1 AND team_id = $2 AND provider_id = $3',
          [userId, teamIdNum, providerIdStr]
        );
      }
    } else {
      const allowed = await validateLibraryModelAccess(userId, teamIdNum, providerIdStr, modelIdStr);
      if (!allowed) return res.status(403).json({ error: '无权操作该模型' });

      if (hidden) {
        await pool.query(`
          INSERT INTO user_model_library_hidden_models (user_id, team_id, provider_id, model_id, created_at)
          VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id, team_id, provider_id, model_id) DO NOTHING
        `, [userId, teamIdNum, providerIdStr, modelIdStr]);
      } else {
        await pool.query(
          'DELETE FROM user_model_library_hidden_models WHERE user_id = $1 AND team_id = $2 AND provider_id = $3 AND model_id = $4',
          [userId, teamIdNum, providerIdStr, modelIdStr]
        );
      }
    }

    res.json({ success: true, scope, teamId: teamIdNum, providerId: providerIdStr, modelId: modelIdStr, hidden });
  } catch (error) {
    Logger.error('[设置模型库隐藏] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 清除模型库隐藏偏好
router.delete('/model-library/hidden', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { scope = 'all', teamId, providerId } = req.query || {};

  if (!['all', 'provider', 'model'].includes(scope)) {
    return res.status(400).json({ error: '无效的范围' });
  }

  try {
    if (scope === 'all') {
      await pool.query('DELETE FROM user_model_library_hidden_providers WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM user_model_library_hidden_models WHERE user_id = $1', [userId]);
    } else if (scope === 'provider') {
      if (teamId) {
        await pool.query(
          'DELETE FROM user_model_library_hidden_providers WHERE user_id = $1 AND team_id = $2',
          [userId, parseInt(teamId, 10)]
        );
      } else {
        await pool.query('DELETE FROM user_model_library_hidden_providers WHERE user_id = $1', [userId]);
      }
    } else if (scope === 'model') {
      if (teamId && providerId) {
        await pool.query(
          'DELETE FROM user_model_library_hidden_models WHERE user_id = $1 AND team_id = $2 AND provider_id = $3',
          [userId, parseInt(teamId, 10), String(providerId)]
        );
      } else if (teamId) {
        await pool.query(
          'DELETE FROM user_model_library_hidden_models WHERE user_id = $1 AND team_id = $2',
          [userId, parseInt(teamId, 10)]
        );
      } else {
        await pool.query('DELETE FROM user_model_library_hidden_models WHERE user_id = $1', [userId]);
      }
    }

    res.json({ success: true });
  } catch (error) {
    Logger.error('[清除模型库隐藏] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 设置/取消模型库星标
router.put('/model-library/star', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { teamId, providerId, modelId, starred } = req.body || {};

  if (teamId == null || teamId === '' || !providerId || !modelId) {
    return res.status(400).json({ error: '请提供 teamId、providerId 和 modelId' });
  }
  if (typeof starred !== 'boolean') {
    return res.status(400).json({ error: '请提供 starred 布尔值' });
  }

  try {
    const teamIdNum = parseInt(teamId, 10);
    if (!Number.isInteger(teamIdNum)) {
      return res.status(400).json({ error: 'Team ID 无效' });
    }
    const providerIdStr = String(providerId);
    const modelIdStr = String(modelId);

    const allowed = await validateLibraryModelAccess(userId, teamIdNum, providerIdStr, modelIdStr);
    if (!allowed) return res.status(403).json({ error: '无权操作该模型' });

    if (starred) {
      await pool.query(`
        INSERT INTO user_model_library_starred_models (user_id, team_id, provider_id, model_id, created_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, team_id, provider_id, model_id) DO NOTHING
      `, [userId, teamIdNum, providerIdStr, modelIdStr]);
    } else {
      await pool.query(
        'DELETE FROM user_model_library_starred_models WHERE user_id = $1 AND team_id = $2 AND provider_id = $3 AND model_id = $4',
        [userId, teamIdNum, providerIdStr, modelIdStr]
      );
    }

    res.json({ success: true, teamId: teamIdNum, providerId: providerIdStr, modelId: modelIdStr, starred });
  } catch (error) {
    Logger.error('[设置模型库星标] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取单个模型信息（模型库按需加载场景下，编辑/发布未展开加载的模型时调用）
router.get('/models/:id/info', requireAuth, async (req, res) => {
  try {
    const modelId = req.params.id;
    const userId = req.session.user.id;

    // 权限校验：该模型必须属于用户所在某个 Team 的供应商，且 team_models 关联启用
    const accessResult = await pool.query(`
      SELECT 1
      FROM team_models tm
      JOIN user_teams ut ON ut.team_id = tm.team_id
      JOIN models m ON m.id = tm.model_id
      WHERE tm.model_id = $1 AND tm.enabled = TRUE AND m.enabled = TRUE AND ut.user_id = $2
      LIMIT 1
    `, [modelId, userId]);
    if (accessResult.rows.length === 0) {
      return res.status(403).json({ error: '无权访问该模型' });
    }

    const result = await pool.query(`
      SELECT m.id AS model_id, m.name, m.alias, m.provider, m.series, m.description,
             m.input_price_per_1k_tokens, m.output_price_per_1k_tokens, m.cached_output_price_per_1k_tokens,
             m.reference_input_price_per_1k_tokens, m.reference_output_price_per_1k_tokens,
             m.rate_limit_rpm, m.rate_limit_tpm, m.icon_url, m.created_by, m.enabled,
             m.billing_mode, m.model_multiplier, m.completion_multiplier,
             m.thinking_model_id, m.non_thinking_model_id,
             p.name AS provider_name, p.notes AS provider_notes, p.enabled AS provider_enabled,
             s.icon_url AS series_icon_url,
             COALESCE(NULLIF(m.upstream_model_id, ''), m.id) AS upstream_model_id,
             mtr.ok AS test_ok, mtr.latency_ms AS test_latency_ms,
             mtr.tokens_per_second AS test_tokens_per_second,
             mtr.total_tokens AS test_total_tokens, mtr.error AS test_error,
             mtr.tested_at AS test_tested_at
      FROM models m
      JOIN providers p ON m.provider = p.id
      LEFT JOIN series s ON m.series = s.name
      LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
      WHERE m.id = $1
    `, [modelId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '模型不存在' });
    }

    const row = result.rows[0];
    res.json({
      model_id: row.model_id,
      name: row.name,
      alias: row.alias,
      series: row.series,
      description: row.description,
      input_price_per_1k_tokens: row.input_price_per_1k_tokens,
      output_price_per_1k_tokens: row.output_price_per_1k_tokens,
      cached_output_price_per_1k_tokens: row.cached_output_price_per_1k_tokens,
      reference_input_price_per_1k_tokens: row.reference_input_price_per_1k_tokens,
      reference_output_price_per_1k_tokens: row.reference_output_price_per_1k_tokens,
      rate_limit_rpm: row.rate_limit_rpm,
      rate_limit_tpm: row.rate_limit_tpm,
      icon_url: row.icon_url,
      series_icon_url: row.series_icon_url,
      created_by: row.created_by,
      enabled: row.enabled,
      billing_mode: row.billing_mode,
      model_multiplier: row.model_multiplier,
      completion_multiplier: row.completion_multiplier,
      thinking_model_id: row.thinking_model_id,
      non_thinking_model_id: row.non_thinking_model_id,
      upstream_model_id: row.upstream_model_id,
      provider_id: row.provider,
      provider_name: row.provider_name,
      test_ok: row.test_ok,
      test_latency_ms: row.test_latency_ms,
      test_tokens_per_second: row.test_tokens_per_second,
      test_total_tokens: row.test_total_tokens,
      test_error: row.test_error,
      test_tested_at: row.test_tested_at
    });
  } catch (error) {
    Logger.error('[获取模型信息] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用户可访问的供应商额度（按 Team 关联过滤，仅返回 quota_enabled 的供应商）
// 只读上次刷新（定时自动刷新 / 手动刷新）保存的缓存，不实时调用上游。
router.get('/providers/quota', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const providersResult = await pool.query(`
      SELECT DISTINCT p.id, p.name, p.quota_last_ok, p.quota_last_result, p.quota_last_error, p.quota_last_checked_at
      FROM providers p
      JOIN models m ON m.provider = p.id
      JOIN team_models tm ON tm.model_id = m.id
      JOIN user_teams ut ON ut.team_id = tm.team_id
      WHERE ut.user_id = $1 AND p.quota_enabled = TRUE AND p.enabled = TRUE
      ORDER BY p.name
    `, [userId]);

    const results = [];
    for (const provider of providersResult.rows) {
      if (provider.quota_last_ok && provider.quota_last_result) {
        results.push({
          id: provider.id,
          name: provider.name,
          quota: provider.quota_last_result,
          cached: true,
          checked_at: provider.quota_last_checked_at
        });
      } else {
        results.push({
          id: provider.id,
          name: provider.name,
          error: provider.quota_last_error || '尚未刷新额度',
          cached: true,
          checked_at: provider.quota_last_checked_at
        });
      }
    }

    res.json({ providers: results });
  } catch (error) {
    Logger.error('[获取供应商额度] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 手动刷新供应商额度：实时调用上游，保存快照并返回最新结果
router.post('/providers/quota/refresh', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const providersResult = await pool.query(`
      SELECT DISTINCT p.*
      FROM providers p
      JOIN models m ON m.provider = p.id
      JOIN team_models tm ON tm.model_id = m.id
      JOIN user_teams ut ON ut.team_id = tm.team_id
      WHERE ut.user_id = $1 AND p.quota_enabled = TRUE AND p.enabled = TRUE
      ORDER BY p.name
    `, [userId]);

    const results = [];
    for (const provider of providersResult.rows) {
      try {
        const result = await queryProviderQuota(provider);
        await saveQuotaSnapshot(provider.id, result);
        if (result.ok) {
          results.push({
            id: provider.id,
            name: provider.name,
            quota: result.quota,
            cached: false,
            checked_at: new Date()
          });
        } else {
          results.push({
            id: provider.id,
            name: provider.name,
            error: result.error || '查询失败',
            cached: false,
            checked_at: new Date()
          });
        }
      } catch (e) {
        Logger.warn(`[用户额度刷新] ${provider.id} 失败: ${e.message}`);
        results.push({
          id: provider.id,
          name: provider.name,
          error: e.message,
          cached: false
        });
      }
    }

    res.json({ providers: results });
  } catch (error) {
    Logger.error('[刷新供应商额度] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

const { queryProviderQuota, saveQuotaSnapshot } = require('../utils/provider-quota');

// 获取当前选择的模型
router.get('/current-model', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT current_model_id FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.session.user.id]
    );
    const currentModelId = result.rows[0]?.current_model_id || null;

    if (!currentModelId) {
      return res.json({ currentModel: null });
    }

    // 获取模型详情
    const modelResult = await pool.query(
      'SELECT id, name, provider, series, description FROM models WHERE id = $1',
      [currentModelId]
    );
    res.json({ currentModel: modelResult.rows[0] || null });
  } catch (error) {
    Logger.error('[获取当前模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 设置当前选择的模型
router.put('/current-model', requireAuth, auditMiddleware(ACTIONS.API_KEY_UPDATE, {
  resourceType: 'api_key',
  descriptionFrom: (req) => `切换当前模型为 ${req.body?.modelId || '-'}`,
  detailsFrom: (req) => ({ model_id: req.body?.modelId }),
}), async (req, res) => {
  const { modelId } = req.body;
  if (!modelId) {
    return res.status(400).json({ error: '请提供模型 ID' });
  }

  try {
    // 验证模型存在且启用，且供应商已启用
    const modelCheck = await pool.query(
      `SELECT m.id, m.name, p.enabled AS provider_enabled
       FROM models m JOIN providers p ON m.provider = p.id
       WHERE m.id = $1 AND m.enabled = TRUE`,
      [modelId]
    );
    if (modelCheck.rows.length === 0) {
      return res.status(400).json({ error: '模型不存在或未启用' });
    }
    if (modelCheck.rows[0].provider_enabled === false) {
      return res.status(400).json({ error: '该供应商已禁用，无法选择此模型' });
    }

    // 验证用户的 Team 有权使用该模型
    const userResult = await pool.query('SELECT team_id FROM users WHERE id = $1', [req.session.user.id]);
    const teamId = userResult.rows[0]?.team_id;

    if (teamId) {
      const tmCheck = await pool.query(
        'SELECT 1 FROM team_models WHERE team_id = $1 AND model_id = $2 AND enabled = TRUE',
        [teamId, modelId]
      );
      if (tmCheck.rows.length === 0) {
        return res.status(403).json({ error: '您的 Team 无权使用该模型' });
      }
    }

    // 更新所有该用户的 API Key 的 current_model_id
    await pool.query(
      'UPDATE api_keys SET current_model_id = $1 WHERE user_id = $2',
      [modelId, req.session.user.id]
    );

    res.json({ success: true, model: modelCheck.rows[0] });
  } catch (error) {
    Logger.error('[设置当前模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取可用供应商列表（供用户添加模型时选择）
router.get('/providers', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, format FROM providers WHERE enabled = TRUE ORDER BY name`
    );
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取供应商列表] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取 models.dev 供应商索引（用于向导式添加）
router.get('/providers/lookup-index', requireAuth, async (req, res) => {
  try {
    const index = await fetchProvidersIndex();
    const providers = Object.entries(index).map(([id, entry]) => ({
      id: entry.id,
      name: entry.name,
      base_url: entry.api || '',
      doc: entry.doc || ''
    })).sort((a, b) => a.name.localeCompare(b.name));
    res.json(providers);
  } catch (error) {
    Logger.error('[获取供应商索引] 错误:', error);
    res.status(500).json({ error: '获取供应商列表失败' });
  }
});

// 查询单个供应商信息
router.get('/providers/lookup/:name', requireAuth, async (req, res) => {
  try {
    const info = await lookupProvider(req.params.name);
    if (!info) {
      return res.status(404).json({ error: '未找到该供应商' });
    }
    res.json(info);
  } catch (error) {
    Logger.error('[查询供应商] 错误:', error);
    res.status(500).json({ error: '查询失败' });
  }
});

// 用户添加供应商
router.post('/providers', requireAuth, auditMiddleware(ACTIONS.USER_PROVIDER_CREATE, {
  resourceType: 'provider',
  resourceIdFrom: (req, res) => res._logBody?.id,
  descriptionFrom: (req) => `创建供应商「${req.body?.name || '-'}」`,
}), async (req, res) => {
  const { name, base_url, api_key, format, models_url, notes } = req.body;

  if (!name || !base_url) {
    return res.status(400).json({ error: '请填写供应商名称和 Base URL' });
  }

  try {
    // 生成供应商 ID
    const providerId = `user_${req.session.user.id}_${Date.now()}`;

    // 检查 providers 表有哪些列
    const colCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers'"
    );
    const colNames = colCheck.rows.map(r => r.column_name);

    // 动态构建 INSERT 语句
    const insertCols = ['id', 'name', 'base_url', 'api_key', 'format', 'enabled'];
    const insertValues = [providerId, name, base_url.replace(/\/+$/, ''), api_key, format || 'openai', true];

    if (colNames.includes('models_url')) {
      insertCols.push('models_url');
      insertValues.push(models_url || '');
    }
    if (colNames.includes('notes')) {
      insertCols.push('notes');
      insertValues.push(notes || '');
    }
    if (colNames.includes('created_by')) {
      insertCols.push('created_by');
      insertValues.push(req.session.user.id);
    }

    const placeholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');
    await pool.query(
      `INSERT INTO providers (${insertCols.join(', ')}) VALUES (${placeholders})`,
      insertValues
    );

    // 尝试获取模型列表并自动添加
    try {
      const modelsEndpoint = models_url || (format === 'anthropic' ? '/v1/models' : '/v1/models');
      const modelsRes = await fetch(`${base_url.replace(/\/+$/, '')}${modelsEndpoint}`, {
        headers: { 'Authorization': `Bearer ${api_key}` }
      });

      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const models = modelsData.data || modelsData.models || [];

        // 获取用户的个人 Team
        const personalTeam = await getUserPersonalTeam(req.session.user.id);

        // 检查 models 表有哪些列
        const modelColCheck = await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'models'"
        );
        const modelColNames = modelColCheck.rows.map(r => r.column_name);

        for (const model of models.slice(0, 50)) { // 限制最多添加50个模型
          const modelId = `${providerId}_${model.id}`;
          const upstreamModelId = model.id;

          // 检查模型是否已存在
          const existing = await pool.query('SELECT id FROM models WHERE id = $1', [modelId]);
          if (existing.rows.length > 0) continue;

          // 动态构建模型 INSERT 语句
          const modelInsertCols = ['id', 'name', 'provider', 'upstream_model_id', 'enabled'];
          const modelInsertValues = [modelId, model.id, providerId, upstreamModelId, true];

          if (modelColNames.includes('created_by')) {
            modelInsertCols.push('created_by');
            modelInsertValues.push(req.session.user.id);
          }

          const modelPlaceholders = modelInsertValues.map((_, i) => `$${i + 1}`).join(', ');
          await pool.query(
            `INSERT INTO models (${modelInsertCols.join(', ')}) VALUES (${modelPlaceholders})`,
            modelInsertValues
          );

          // 如果有个人 Team，添加到 Team
          if (personalTeam) {
            await pool.query(
              'INSERT INTO team_models (team_id, model_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [personalTeam.id, modelId]
            );
          }
        }

        Logger.info(`[用户添加供应商] 用户 ${req.session.user.username} 添加了供应商 ${providerId}，自动导入了 ${Math.min(models.length, 50)} 个模型`);
      }
    } catch (modelErr) {
      Logger.warn(`[用户添加供应商] 获取模型列表失败:`, modelErr.message);
    }

    res.json({ success: true, provider_id: providerId });
  } catch (error) {
    Logger.error('[用户添加供应商] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 用户获取自己的供应商列表
router.get('/my-providers', requireAuth, async (req, res) => {
  try {
    // 检查 providers 表是否有 created_by 列
    const colCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'created_by'"
    );
    const hasCreatedBy = colCheck.rows.length > 0;

    let result;
    if (hasCreatedBy) {
      result = await pool.query(
        `SELECT id, name, base_url, format, enabled, created_at
         FROM providers
         WHERE created_by = $1
         ORDER BY created_at DESC`,
        [req.session.user.id]
      );
    } else {
      // 如果没有 created_by 列，返回空
      result = { rows: [] };
    }

    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取用户供应商列表] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 用户检测供应商连通性（自己的供应商 + 有权限访问的全局供应商）
router.get('/providers/:id/ping', requireAuth, async (req, res) => {
  try {
    const providerResult = await pool.query('SELECT id, name, base_url, api_key, created_by, enabled FROM providers WHERE id = $1', [req.params.id]);
    if (providerResult.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }
    const provider = providerResult.rows[0];

    // 检查权限：自己的供应商 或 全局已启用的供应商
    const isOwner = provider.created_by === req.session.user.id;
    const isGlobalEnabled = !provider.created_by && provider.enabled;
    if (!isOwner && !isGlobalEnabled) {
      return res.status(403).json({ error: '无权检测此供应商' });
    }

    const baseUrl = provider.base_url?.replace(/\/+$/, '');
    if (!baseUrl) {
      return res.json({ ok: false, latency_ms: null, error: '未配置 Base URL' });
    }

    const headers = { 'Content-Type': 'application/json' };
    if (provider.api_key) {
      headers['Authorization'] = `Bearer ${provider.api_key}`;
    }

    const candidates = [];
    if (/\/v1\/?$/.test(baseUrl)) {
      candidates.push(`${baseUrl}/models`);
    } else {
      candidates.push(`${baseUrl}/v1/models`);
      candidates.push(`${baseUrl}/models`);
    }

    for (const url of candidates) {
      const start = Date.now();
      try {
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
        const latency = Date.now() - start;
        if (resp.ok) return res.json({ ok: true, latency_ms: latency, url });
        if (resp.status === 401 || resp.status === 403) {
          return res.json({ ok: true, latency_ms: latency, url, note: `HTTP ${resp.status} (鉴权)` });
        }
      } catch (e) { /* try next */ }
    }

    const start = Date.now();
    try {
      const resp = await fetch(baseUrl, { headers, signal: AbortSignal.timeout(5000), redirect: 'follow' });
      const latency = Date.now() - start;
      return res.json({ ok: true, latency_ms: latency, url: baseUrl, note: `HTTP ${resp.status}` });
    } catch (e) {
      const latency = Date.now() - start;
      return res.json({ ok: false, latency_ms: latency, error: e.message || '连接失败' });
    }
  } catch (error) {
    Logger.error('[用户检测连通性] 错误:', error);
    res.status(500).json({ ok: false, latency_ms: null, error: error.message });
  }
});

// 用户编辑自己的供应商
router.put('/providers/:id', requireAuth, auditMiddleware(ACTIONS.USER_PROVIDER_UPDATE, {
  resourceType: 'provider',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新供应商 #${req.params.id}`,
}), async (req, res) => {
  const providerId = req.params.id;
  const { name, base_url, api_key, format } = req.body;

  try {
    // 检查是否是用户自己的供应商
    const colCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'created_by'"
    );
    const hasCreatedBy = colCheck.rows.length > 0;

    if (hasCreatedBy) {
      const check = await pool.query(
        'SELECT id FROM providers WHERE id = $1 AND created_by = $2',
        [providerId, req.session.user.id]
      );
      if (check.rows.length === 0) {
        return res.status(403).json({ error: '您无权编辑此供应商' });
      }
    } else {
      return res.status(403).json({ error: '不支持此操作' });
    }

    // 更新供应商
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (base_url) {
      updates.push(`base_url = $${paramIndex++}`);
      values.push(base_url.replace(/\/+$/, ''));
    }
    if (api_key) {
      updates.push(`api_key = $${paramIndex++}`);
      values.push(api_key);
    }
    if (format) {
      updates.push(`format = $${paramIndex++}`);
      values.push(format);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: '没有要更新的内容' });
    }

    values.push(providerId);
    await pool.query(
      `UPDATE providers SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    res.json({ success: true });
  } catch (error) {
    Logger.error('[用户编辑供应商] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 用户删除自己的供应商
router.delete('/providers/:id', requireAuth, auditMiddleware(ACTIONS.USER_PROVIDER_DELETE, {
  resourceType: 'provider',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `删除供应商 #${req.params.id}`,
}), async (req, res) => {
  const providerId = req.params.id;

  try {
    // 检查是否是用户自己的供应商
    const colCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'created_by'"
    );
    const hasCreatedBy = colCheck.rows.length > 0;

    if (hasCreatedBy) {
      const check = await pool.query(
        'SELECT id FROM providers WHERE id = $1 AND created_by = $2',
        [providerId, req.session.user.id]
      );
      if (check.rows.length === 0) {
        return res.status(403).json({ error: '您无权删除此供应商' });
      }
    } else {
      return res.status(403).json({ error: '不支持此操作' });
    }

    // 删除供应商关联的模型
    await pool.query(
      'DELETE FROM models WHERE provider = $1',
      [providerId]
    );

    // 删除供应商
    await pool.query('DELETE FROM providers WHERE id = $1', [providerId]);

    Logger.info(`[用户删除供应商] 用户 ${req.session.user.username} 删除了供应商 ${providerId}`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[用户删除供应商] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 用户刷新供应商模型列表
router.post('/providers/:id/refresh-models', requireAuth, async (req, res) => {
  const providerId = req.params.id;

  try {
    // 检查是否是用户自己的供应商
    const colCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'created_by'"
    );
    const hasCreatedBy = colCheck.rows.length > 0;

    let provider;
    if (hasCreatedBy) {
      const result = await pool.query(
        'SELECT * FROM providers WHERE id = $1 AND created_by = $2',
        [providerId, req.session.user.id]
      );
      if (result.rows.length === 0) {
        return res.status(403).json({ error: '您无权操作此供应商' });
      }
      provider = result.rows[0];
    } else {
      return res.status(403).json({ error: '不支持此操作' });
    }

    // 获取模型列表 - 尝试多个地址
    const baseUrl = provider.base_url?.replace(/\/+$/, '');
    const customModelsUrl = provider.models_url?.replace(/\/+$/, '') || '';
    const apiKey = provider.api_key || '';

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // 构建候选 URL 列表
    const candidateUrls = [];
    if (customModelsUrl) {
      candidateUrls.push(customModelsUrl.startsWith('http') ? customModelsUrl : `${baseUrl}${customModelsUrl.startsWith('/') ? '' : '/'}${customModelsUrl}`);
    }

    // 从 base_url 推断 API 根路径
    const cleanBaseUrl = baseUrl
      .replace(/\/(chat\/completions|completions|messages|responses|embeddings)\/?$/, '')
      .replace(/\/+$/, '');

    // 自动推断路径
    if (/\/v1\/?$/.test(cleanBaseUrl)) {
      candidateUrls.push(`${cleanBaseUrl}/models`);
    } else {
      candidateUrls.push(`${cleanBaseUrl}/v1/models`);
      candidateUrls.push(`${cleanBaseUrl}/models`);
    }

    // 去重
    const uniqueUrls = [...new Set(candidateUrls)];

    let modelsData = null;
    let successUrl = null;

    for (const modelsUrl of uniqueUrls) {
      Logger.info(`[用户刷新模型] 尝试: ${modelsUrl}`);
      try {
        const response = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(15000) });
        if (!response.ok) continue;

        const data = await response.json();
        const models = data.data || data.models || [];
        if (models.length > 0) {
          modelsData = data;
          successUrl = modelsUrl;
          break;
        }
      } catch (e) {
        Logger.warn(`[用户刷新模型] ${modelsUrl} 失败: ${e.message}`);
      }
    }

    if (!modelsData) {
      Logger.error(`[用户刷新模型] 所有候选地址都失败`);
      return res.status(400).json({ error: '获取模型列表失败，请检查 Base URL 或手动设置模型列表地址' });
    }

    Logger.info(`[用户刷新模型] 成功获取模型列表: ${successUrl}`);

    const models = modelsData.data || modelsData.models || [];

    // 获取用户的个人 Team
    const personalTeam = await getUserPersonalTeam(req.session.user.id);

    // 检查 models 表有哪些列
    const modelColCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'models'"
    );
    const modelColNames = modelColCheck.rows.map(r => r.column_name);

    let addedCount = 0;
    for (const model of models.slice(0, 100)) { // 限制最多添加100个模型
      const modelId = `${providerId}_${model.id}`;
      const upstreamModelId = model.id;

      // 检查模型是否已存在
      const existing = await pool.query('SELECT id FROM models WHERE id = $1', [modelId]);
      if (existing.rows.length > 0) continue;

      // 动态构建模型 INSERT 语句
      const modelInsertCols = ['id', 'name', 'provider', 'upstream_model_id', 'enabled'];
      const modelInsertValues = [modelId, model.id, providerId, upstreamModelId, true];

      if (modelColNames.includes('created_by')) {
        modelInsertCols.push('created_by');
        modelInsertValues.push(req.session.user.id);
      }

      const modelPlaceholders = modelInsertValues.map((_, i) => `$${i + 1}`).join(', ');
      await pool.query(
        `INSERT INTO models (${modelInsertCols.join(', ')}) VALUES (${modelPlaceholders})`,
        modelInsertValues
      );

      // 如果有个人 Team，添加到 Team
      if (personalTeam) {
        await pool.query(
          'INSERT INTO team_models (team_id, model_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [personalTeam.id, modelId]
        );
      }

      addedCount++;
    }

    Logger.info(`[用户刷新模型] 用户 ${req.session.user.username} 刷新了供应商 ${providerId}，新增 ${addedCount} 个模型`);
    res.json({ success: true, added: addedCount, total: models.length });
  } catch (error) {
    Logger.error('[用户刷新模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用户供应商的模型列表
router.get('/providers/:id/models', requireAuth, async (req, res) => {
  const providerId = req.params.id;

  try {
    // 检查是否是用户自己的供应商
    const colCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'created_by'"
    );
    const hasCreatedBy = colCheck.rows.length > 0;

    if (hasCreatedBy) {
      const check = await pool.query(
        'SELECT id FROM providers WHERE id = $1 AND created_by = $2',
        [providerId, req.session.user.id]
      );
      if (check.rows.length === 0) {
        return res.status(403).json({ error: '您无权访问此供应商' });
      }
    } else {
      return res.status(403).json({ error: '不支持此操作' });
    }

    // 获取该供应商下的模型
    const result = await pool.query(
      `SELECT id, name, upstream_model_id, alias, series, description, enabled,
              input_price_per_1k_tokens, output_price_per_1k_tokens
       FROM models
       WHERE provider = $1
       ORDER BY name`,
      [providerId]
    );

    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取供应商模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除供应商模型
router.delete('/providers/:providerId/models/:modelId', requireAuth, async (req, res) => {
  const { providerId, modelId } = req.params;

  try {
    // 检查是否是用户自己的供应商
    const colCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'created_by'"
    );
    const hasCreatedBy = colCheck.rows.length > 0;

    if (hasCreatedBy) {
      const check = await pool.query(
        'SELECT id FROM providers WHERE id = $1 AND created_by = $2',
        [providerId, req.session.user.id]
      );
      if (check.rows.length === 0) {
        return res.status(403).json({ error: '您无权操作此供应商' });
      }
    } else {
      return res.status(403).json({ error: '不支持此操作' });
    }

    // 删除模型
    await pool.query('DELETE FROM models WHERE id = $1 AND provider = $2', [modelId, providerId]);

    res.json({ success: true });
  } catch (error) {
    Logger.error('[删除供应商模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量删除供应商模型
router.post('/providers/:providerId/models/batch-delete', requireAuth, async (req, res) => {
  const { providerId } = req.params;
  const { modelIds } = req.body;

  if (!modelIds || !Array.isArray(modelIds) || modelIds.length === 0) {
    return res.status(400).json({ error: '请选择要删除的模型' });
  }

  try {
    // 检查是否是用户自己的供应商
    const colCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'created_by'"
    );
    const hasCreatedBy = colCheck.rows.length > 0;

    if (hasCreatedBy) {
      const check = await pool.query(
        'SELECT id FROM providers WHERE id = $1 AND created_by = $2',
        [providerId, req.session.user.id]
      );
      if (check.rows.length === 0) {
        return res.status(403).json({ error: '您无权操作此供应商' });
      }
    } else {
      return res.status(403).json({ error: '不支持此操作' });
    }

    // 批量删除模型
    const placeholders = modelIds.map((_, i) => `$${i + 2}`).join(', ');
    await pool.query(
      `DELETE FROM models WHERE provider = $1 AND id IN (${placeholders})`,
      [providerId, ...modelIds]
    );

    res.json({ success: true, deleted: modelIds.length });
  } catch (error) {
    Logger.error('[批量删除供应商模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量更新供应商模型
router.post('/providers/:providerId/models/batch-update', requireAuth, async (req, res) => {
  const { providerId } = req.params;
  const { modelIds, updates } = req.body;

  if (!modelIds || !Array.isArray(modelIds) || modelIds.length === 0) {
    return res.status(400).json({ error: '请选择要更新的模型' });
  }

  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: '请提供更新内容' });
  }

  try {
    // 检查是否是用户自己的供应商
    const colCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'created_by'"
    );
    const hasCreatedBy = colCheck.rows.length > 0;

    if (hasCreatedBy) {
      const check = await pool.query(
        'SELECT id FROM providers WHERE id = $1 AND created_by = $2',
        [providerId, req.session.user.id]
      );
      if (check.rows.length === 0) {
        return res.status(403).json({ error: '您无权操作此供应商' });
      }
    } else {
      return res.status(403).json({ error: '不支持此操作' });
    }

    // 构建更新语句
    const allowedFields = ['enabled', 'input_price_per_1k_tokens', 'output_price_per_1k_tokens', 'cached_output_price_per_1k_tokens', 'series', 'description', 'alias'];
    const updateClauses = [];
    const values = [providerId];
    let paramIndex = 2;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        updateClauses.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    if (updateClauses.length === 0) {
      return res.status(400).json({ error: '没有有效的更新内容' });
    }

    // 批量更新
    const placeholders = modelIds.map((_, i) => `$${paramIndex + i}`).join(', ');
    const query = `
      UPDATE models
      SET ${updateClauses.join(', ')}
      WHERE provider = $1 AND id IN (${placeholders})
    `;

    const result = await pool.query(query, [...values, ...modelIds]);

    Logger.info(`[批量更新模型] 用户 ${req.session.user.username} 更新了 ${result.rowCount} 个模型`);
    res.json({ success: true, updated: result.rowCount });
  } catch (error) {
    Logger.error('[批量更新模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 辅助：获取用户的个人 Team
async function getUserPersonalTeam(userId) {
  const result = await pool.query(
    `SELECT t.id FROM teams t
     JOIN user_teams ut ON t.id = ut.team_id
     WHERE ut.user_id = $1 AND t.is_personal = TRUE
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

// 辅助：检查用户是否拥有某个模型（created_by 匹配且在个人 Team 中）
async function checkModelOwnership(userId, modelId) {
  const modelResult = await pool.query(
    'SELECT id, created_by FROM models WHERE id = $1',
    [modelId]
  );
  if (modelResult.rows.length === 0) return { error: '模型不存在', status: 404 };
  const model = modelResult.rows[0];
  if (model.created_by !== userId) return { error: '您无权管理此模型', status: 403 };

  const personalTeam = await getUserPersonalTeam(userId);
  if (!personalTeam) return { error: '未找到个人 Team', status: 404 };

  const tmResult = await pool.query(
    'SELECT id FROM team_models WHERE team_id = $1 AND model_id = $2',
    [personalTeam.id, modelId]
  );
  if (tmResult.rows.length === 0) return { error: '此模型不在您的个人 Team 中', status: 403 };

  return { model, personalTeam };
}

// 用户添加模型到个人 Team
router.post('/models', requireAuth, async (req, res) => {
  const { id, provider, series, description, input_price_per_1k_tokens, output_price_per_1k_tokens, cached_output_price_per_1k_tokens, reference_input_price_per_1k_tokens, reference_output_price_per_1k_tokens, rate_limit_rpm, rate_limit_tpm, icon_url, alias, completion_ratio, image_ratio, audio_ratio, model_price, billing_mode, model_multiplier, completion_multiplier, upstream_model_id, thinking_model_id, non_thinking_model_id, enabled } = req.body;

  if (!provider) {
    return res.status(400).json({ error: '供应商不能为空' });
  }

  try {
    // 获取用户的个人 Team
    const personalTeam = await getUserPersonalTeam(req.session.user.id);
    if (!personalTeam) {
      return res.status(404).json({ error: '未找到个人 Team，请联系管理员' });
    }

    // 自动生成模型ID
    const modelId = id || `model_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const upstreamModelId = upstream_model_id || modelId;
    const name = alias || upstreamModelId;

    // 检查模型 ID 是否已存在
    const existing = await pool.query('SELECT id FROM models WHERE id = $1', [modelId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: '模型 ID 已存在' });
    }

    // 创建模型
    await pool.query(`
      INSERT INTO models (id, name, provider, series, description, enabled,
        input_price_per_1k_tokens, output_price_per_1k_tokens, cached_output_price_per_1k_tokens,
        reference_input_price_per_1k_tokens, reference_output_price_per_1k_tokens,
        rate_limit_rpm, rate_limit_tpm, icon_url, alias,
        completion_ratio, image_ratio, audio_ratio, model_price, billing_mode,
        model_multiplier, completion_multiplier, upstream_model_id, thinking_model_id, non_thinking_model_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
    `, [modelId, name, provider, series || '', description || '', enabled !== false,
      input_price_per_1k_tokens || 0, output_price_per_1k_tokens || 0, cached_output_price_per_1k_tokens || 0,
      reference_input_price_per_1k_tokens || 0, reference_output_price_per_1k_tokens || 0,
      rate_limit_rpm || 0, rate_limit_tpm || 0, icon_url || '', alias || '',
      completion_ratio || 1.0, image_ratio || 0.0, audio_ratio || 0.0,
      model_price || 0, billing_mode || 'ratio',
      model_multiplier || 1.0, completion_multiplier || 1.0,
      upstreamModelId, thinking_model_id || '', non_thinking_model_id || '',
      req.session.user.id]);

    // 添加到个人 Team
    await pool.query(
      'INSERT INTO team_models (team_id, model_id) VALUES ($1, $2) ON CONFLICT (team_id, model_id) DO NOTHING',
      [personalTeam.id, modelId]
    );

    Logger.info(`[用户添加模型] 用户 ${req.session.user.username} 添加了模型 ${modelId}`);
    res.json({ success: true, model_id: modelId });
  } catch (error) {
    Logger.error('[用户添加模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 用户编辑自己的模型
router.put('/models/:id', requireAuth, auditMiddleware(ACTIONS.USER_MODEL_UPDATE, {
  resourceType: 'model',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新模型 #${req.params.id}`,
}), async (req, res) => {
  const modelId = req.params.id;
  const { series, description, input_price_per_1k_tokens, output_price_per_1k_tokens, cached_output_price_per_1k_tokens, reference_input_price_per_1k_tokens, reference_output_price_per_1k_tokens, rate_limit_rpm, rate_limit_tpm, icon_url, alias, completion_ratio, image_ratio, audio_ratio, model_price, billing_mode, model_multiplier, completion_multiplier, upstream_model_id, thinking_model_id, non_thinking_model_id, enabled } = req.body;

  try {
    const ownership = await checkModelOwnership(req.session.user.id, modelId);
    if (ownership.error) {
      return res.status(ownership.status).json({ error: ownership.error });
    }

    const upstreamModelId = upstream_model_id || modelId;
    const name = alias || upstreamModelId;

    await pool.query(`
      UPDATE models SET
        name = $2, series = $3, description = $4, enabled = $5,
        input_price_per_1k_tokens = $6, output_price_per_1k_tokens = $7, cached_output_price_per_1k_tokens = $8,
        reference_input_price_per_1k_tokens = $9, reference_output_price_per_1k_tokens = $10,
        rate_limit_rpm = $11, rate_limit_tpm = $12, icon_url = $13, alias = $14,
        completion_ratio = $15, image_ratio = $16, audio_ratio = $17,
        model_price = $18, billing_mode = $19,
        model_multiplier = $20, completion_multiplier = $21, upstream_model_id = $22,
        thinking_model_id = $23, non_thinking_model_id = $24
      WHERE id = $1
    `, [modelId, name, series || '', description || '', enabled !== false,
      input_price_per_1k_tokens || 0, output_price_per_1k_tokens || 0, cached_output_price_per_1k_tokens || 0,
      reference_input_price_per_1k_tokens || 0, reference_output_price_per_1k_tokens || 0,
      rate_limit_rpm || 0, rate_limit_tpm || 0, icon_url || '', alias || '',
      completion_ratio || 1.0, image_ratio || 0.0, audio_ratio || 0.0,
      model_price || 0, billing_mode || 'ratio',
      model_multiplier || 1.0, completion_multiplier || 1.0,
      upstreamModelId, thinking_model_id || '', non_thinking_model_id || '']);

    Logger.info(`[用户编辑模型] 用户 ${req.session.user.username} 编辑了模型 ${modelId}`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[用户编辑模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 用户删除自己的模型
router.delete('/models/:id', requireAuth, auditMiddleware(ACTIONS.USER_MODEL_DELETE, {
  resourceType: 'model',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `删除模型 #${req.params.id}`,
}), async (req, res) => {
  const modelId = req.params.id;

  try {
    const ownership = await checkModelOwnership(req.session.user.id, modelId);
    if (ownership.error) {
      return res.status(ownership.status).json({ error: ownership.error });
    }

    // 删除模型（CASCADE 会自动清理 team_models 和 api_key_models）
    await pool.query('DELETE FROM models WHERE id = $1', [modelId]);

    Logger.info(`[用户删除模型] 用户 ${req.session.user.username} 删除了模型 ${modelId}`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[用户删除模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 用户发布模型到默认 Team（放弃管理权）
router.post('/models/:id/publish', requireAuth, auditMiddleware(ACTIONS.USER_MODEL_PUBLISH, {
  resourceType: 'model',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `发布模型 #${req.params.id}`,
}), async (req, res) => {
  const modelId = req.params.id;

  try {
    const ownership = await checkModelOwnership(req.session.user.id, modelId);
    if (ownership.error) {
      return res.status(ownership.status).json({ error: ownership.error });
    }

    // 获取默认 Team
    const defaultTeamResult = await pool.query(
      'SELECT id FROM teams WHERE is_default = TRUE LIMIT 1'
    );
    if (defaultTeamResult.rows.length === 0) {
      return res.status(404).json({ error: '未找到默认 Team，请联系管理员' });
    }
    const defaultTeamId = defaultTeamResult.rows[0].id;

    // 添加到默认 Team
    await pool.query(
      'INSERT INTO team_models (team_id, model_id) VALUES ($1, $2) ON CONFLICT (team_id, model_id) DO NOTHING',
      [defaultTeamId, modelId]
    );

    // 从个人 Team 移除
    await pool.query(
      'DELETE FROM team_models WHERE team_id = $1 AND model_id = $2',
      [ownership.personalTeam.id, modelId]
    );

    // 清除 created_by（失去管理权）
    await pool.query(
      'UPDATE models SET created_by = NULL WHERE id = $1',
      [modelId]
    );

    Logger.info(`[发布模型] 用户 ${req.session.user.username} 发布了模型 ${modelId} 到默认 Team`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[发布模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== 个人 Team 模型批量管理 ====================

// 获取用户个人 Team 的所有模型
router.get('/my-team-models', requireAuth, async (req, res) => {
  try {
    const personalTeam = await getUserPersonalTeam(req.session.user.id);
    if (!personalTeam) {
      return res.json([]);
    }

    const result = await pool.query(`
      SELECT m.id, m.name, m.alias, m.provider, m.series, m.description, m.enabled,
             m.input_price_per_1k_tokens, m.output_price_per_1k_tokens,
             m.cached_output_price_per_1k_tokens,
             m.reference_input_price_per_1k_tokens, m.reference_output_price_per_1k_tokens,
             m.rate_limit_rpm, m.rate_limit_tpm, m.icon_url, m.created_by,
             m.billing_mode, m.model_multiplier, m.completion_multiplier,
             m.upstream_model_id, m.thinking_model_id, m.non_thinking_model_id,
             p.name AS provider_name,
             COALESCE(NULLIF(m.upstream_model_id, ''), m.id) AS display_upstream_id
      FROM team_models tm
      JOIN models m ON tm.model_id = m.id
      LEFT JOIN providers p ON m.provider = p.id
      WHERE tm.team_id = $1
      ORDER BY m.provider, m.name
    `, [personalTeam.id]);

    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取个人Team模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 个人 Team 模型批量删除
router.post('/my-team-models/batch-delete', requireAuth, async (req, res) => {
  const { modelIds } = req.body;
  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    return res.status(400).json({ error: '请提供模型 ID 列表' });
  }

  try {
    const userId = req.session.user.id;
    let deleted = 0;

    for (const modelId of modelIds) {
      const ownership = await checkModelOwnership(userId, modelId);
      if (ownership.error) continue;

      await pool.query('DELETE FROM models WHERE id = $1', [modelId]);
      deleted++;
    }

    Logger.info(`[批量删除个人模型] 用户 ${req.session.user.username} 删除了 ${deleted} 个模型`);
    res.json({ success: true, deleted });
  } catch (error) {
    Logger.error('[批量删除个人模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 个人 Team 模型批量更新
router.post('/my-team-models/batch-update', requireAuth, async (req, res) => {
  const { modelIds, updates } = req.body;
  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    return res.status(400).json({ error: '请提供模型 ID 列表' });
  }
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: '请提供更新字段' });
  }

  try {
    const userId = req.session.user.id;
    const allowedFields = ['enabled', 'series', 'description', 'alias',
      'input_price_per_1k_tokens', 'output_price_per_1k_tokens',
      'cached_output_price_per_1k_tokens',
      'reference_input_price_per_1k_tokens', 'reference_output_price_per_1k_tokens',
      'rate_limit_rpm', 'rate_limit_tpm', 'icon_url',
      'completion_ratio', 'image_ratio', 'audio_ratio',
      'model_price', 'billing_mode', 'model_multiplier', 'completion_multiplier',
      'upstream_model_id', 'thinking_model_id', 'non_thinking_model_id'];

    const setClauses = [];
    const values = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClauses.push(`${key} = $${paramIdx}`);
        values.push(value);
        paramIdx++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: '无有效更新字段' });
    }

    let updated = 0;
    for (const modelId of modelIds) {
      const ownership = await checkModelOwnership(userId, modelId);
      if (ownership.error) continue;

      const placeholders = values.map((_, i) => `$${paramIdx + i}`);
      const query = `UPDATE models SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`;
      const result = await pool.query(query, [...values, modelId]);
      updated += result.rowCount;
    }

    Logger.info(`[批量更新个人模型] 用户 ${req.session.user.username} 更新了 ${updated} 个模型`);
    res.json({ success: true, updated });
  } catch (error) {
    Logger.error('[批量更新个人模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 用户调用记录过滤：见 utils/usage-logs-filter

function csvEscapeUser(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.get('/usage-logs', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const { where, params, idx: startIdx, fromSql } = buildUserUsageLogsFilter(userId, req.query);
    let idx = startIdx;

    const countResult = await pool.query(
      `SELECT COUNT(*) ${fromSql} ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const dataParams = [...params, limit, offset];
    const result = await pool.query(`
      SELECT
        u.id,
        u.user_id,
        u.model_id,
        u.api_key_id,
        u.tokens_used,
        u.prompt_tokens,
        u.completion_tokens,
        u.cached_tokens,
        u.provider_id,
        u.request_type,
        COALESCE(u.request_source, 'unknown') as request_source,
        u.user_agent,
        u.latency_ms,
        u.ip_address,
        u.cost,
        u.created_at,
        ak.key_prefix,
        ak.name as key_name,
        m.series,
        COALESCE(
          m.name,
          CASE WHEN u.request_type = 'fusion' THEN 'Fusion' ELSE NULL END,
          u.model_id
        ) as model_name,
        m.upstream_model_id,
        p.name as provider_name
      ${fromSql}
      ${where}
      ORDER BY u.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, dataParams);

    res.json({ total, page, logs: result.rows });
  } catch (error) {
    Logger.error('[用户调用记录] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 导出当前用户调用记录（CSV，最多 5 万条）
router.get('/usage-logs/export', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const maxRows = Math.min(parseInt(req.query.limit) || 50000, 50000);
    const { where, params, idx: startIdx, fromSql } = buildUserUsageLogsFilter(userId, req.query);
    let idx = startIdx;

    const result = await pool.query(`
      SELECT
        u.created_at,
        COALESCE(
          m.name,
          CASE WHEN u.request_type = 'fusion' THEN 'Fusion' ELSE NULL END,
          u.model_id
        ) as model_name,
        m.upstream_model_id,
        m.series,
        p.name as provider_name,
        ak.key_prefix,
        ak.name as key_name,
        u.request_type,
        COALESCE(u.request_source, 'unknown') as request_source,
        u.tokens_used,
        u.prompt_tokens,
        u.completion_tokens,
        u.cached_tokens,
        u.cost,
        u.latency_ms,
        u.ip_address
      ${fromSql}
      ${where}
      ORDER BY u.created_at DESC
      LIMIT $${idx++}
    `, [...params, maxRows]);

    const { sourceLabel } = require('../utils/request-source');
    const header = [
      '时间', '模型', '上游模型ID', '系列', '供应商',
      'Key前缀', 'Key名称', '请求类型', '客户端', '总Token', '输入Token', '输出Token',
      '缓存Token', '积分', '延迟ms', 'IP'
    ];

    const lines = [header.map(csvEscapeUser).join(',')];
    for (const row of result.rows) {
      const created = formatShanghaiDateTime(row.created_at);
      lines.push([
        created,
        row.model_name || '',
        row.upstream_model_id || '',
        row.series || '',
        row.provider_name || '',
        row.key_prefix || '',
        row.key_name || '',
        row.request_type || '',
        sourceLabel(row.request_source),
        row.tokens_used || 0,
        row.prompt_tokens || 0,
        row.completion_tokens || 0,
        row.cached_tokens || 0,
        row.cost != null ? row.cost : '',
        row.latency_ms != null ? row.latency_ms : '',
        row.ip_address || ''
      ].map(csvEscapeUser).join(','));
    }

    const stamp = formatShanghaiDateTime(new Date()).replace(/[: ]/g, '-');
    const bom = '\uFEFF';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="my-usage-logs-${stamp}.csv"`);
    res.send(bom + lines.join('\n'));
    Logger.info(`[用量导出] user=${userId} 导出 ${result.rows.length} 条`);
  } catch (error) {
    Logger.error('[用户导出调用记录] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取当前用户单条调用记录详情（含 messages / response 大字段，仅限本人，须在 /export 之后注册）
router.get('/usage-logs/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的 ID' });

    const { fromSql } = buildUserUsageLogsFilter(userId, req.query);
    const result = await pool.query(`
      SELECT
        u.id,
        u.user_id,
        u.model_id,
        u.api_key_id,
        u.tokens_used,
        u.prompt_tokens,
        u.completion_tokens,
        u.cached_tokens,
        u.provider_id,
        u.request_type,
        COALESCE(u.request_source, 'unknown') as request_source,
        u.user_agent,
        u.latency_ms,
        u.ip_address,
        u.messages,
        u.response,
        u.cost,
        u.created_at,
        ak.key_prefix,
        ak.name as key_name,
        m.series,
        COALESCE(
          m.name,
          CASE WHEN u.request_type = 'fusion' THEN 'Fusion' ELSE NULL END,
          u.model_id
        ) as model_name,
        m.upstream_model_id,
        p.name as provider_name
      ${fromSql}
      WHERE u.id = $1
    `, [id]);

    if (!result.rows.length) return res.status(404).json({ error: '记录不存在' });
    res.json({ log: result.rows[0] });
  } catch (error) {
    Logger.error('[用户调用详情] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取统计筛选选项（用户用过的模型、供应商、所属 Team）
router.get('/stats/filters', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const [modelsRes, providersRes, teamsRes, sourcesRes] = await Promise.all([
      // 用户用过的模型（去重，取最新名称）
      pool.query(`
        SELECT DISTINCT ur.model_id, COALESCE(m.name, ur.model_id) AS name
        FROM usage_records ur
        LEFT JOIN models m ON ur.model_id = m.id
        WHERE ur.user_id = $1 AND ur.model_id IS NOT NULL
        ORDER BY name
      `, [userId]),
      // 用户用过的供应商
      pool.query(`
        SELECT DISTINCT ur.provider_id, COALESCE(p.name, ur.provider_id) AS name
        FROM usage_records ur
        LEFT JOIN providers p ON ur.provider_id = p.id
        WHERE ur.user_id = $1 AND ur.provider_id IS NOT NULL
        ORDER BY name
      `, [userId]),
      // 用户所属的 Team
      pool.query(`
        SELECT t.id, t.name
        FROM teams t
        JOIN user_teams ut ON t.id = ut.team_id
        WHERE ut.user_id = $1
        ORDER BY t.name
      `, [userId]),
      pool.query(`
        SELECT DISTINCT COALESCE(NULLIF(ur.request_source, ''), 'unknown') AS id
        FROM usage_records ur
        WHERE ur.user_id = $1
        ORDER BY id
      `, [userId])
    ]);

    const { sourceLabel, REQUEST_SOURCES } = require('../utils/request-source');
    const sources = (sourcesRes.rows || []).map((r) => ({
      id: r.id,
      name: sourceLabel(r.id)
    }));
    // 始终提供四工具 + 未知选项，便于筛选未出现过的客户端
    const known = new Set(sources.map((s) => s.id));
    for (const id of Object.values(REQUEST_SOURCES)) {
      if (!known.has(id)) sources.push({ id, name: sourceLabel(id) });
    }

    res.json({
      sources,
      models: modelsRes.rows,
      providers: providersRes.rows,
      teams: teamsRes.rows
    });
  } catch (error) {
    Logger.error('[获取统计筛选选项] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 排行榜
router.get('/leaderboard', requireAuth, async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days) || 30);
    const sort = req.query.sort || 'tokens';
    const currentUserId = req.session.user.id;

    // 白名单验证排序字段，防 SQL 注入
    const sortMap = {
      'tokens': { sql: 'total_tokens', dir: 'DESC' },
      'requests': { sql: 'total_requests', dir: 'DESC' },
      'points': { sql: 'total_points', dir: 'DESC' },
      'balance': { sql: 'balance', dir: 'DESC' },
      'cache': { sql: 'total_tokens', dir: 'DESC' }
    };
    const sortDef = sortMap[sort] || sortMap['tokens'];

    // 1. 从 quota_data 获取主排行数据（已按小时聚合，性能好）
    const mainQuery = `
      SELECT
        u.id AS user_id,
        u.username,
        u.avatar,
        COALESCE(SUM(qd.count), 0)::BIGINT AS total_requests,
        COALESCE(SUM(qd.weighted_tokens), 0)::BIGINT AS total_tokens,
        COALESCE(SUM(qd.quota), 0)::DECIMAL(10,4) AS total_points,
        COALESCE(u.balance, 0) + COALESCE(u.refund_balance, 0) AS balance
      FROM users u
      LEFT JOIN quota_data qd ON qd.user_id = u.id
        AND qd.created_at >= NOW() - $1::INTERVAL
      GROUP BY u.id, u.username, u.avatar, u.balance, u.refund_balance
      HAVING COALESCE(SUM(qd.count), 0) > 0
      ORDER BY ${sortDef.sql} ${sortDef.dir} NULLS LAST
      LIMIT 100
    `;

    const mainResult = await pool.query(mainQuery, [`${days} days`]);
    const users = mainResult.rows;

    if (users.length === 0) {
      return res.json({ leaderboard: [], totalUsers: 0, currentUserRank: 0 });
    }

    // 2. 从 usage_records 获取缓存命中率（只查排行榜中的用户）
    const userIds = users.map(u => u.user_id);
    const cacheResult = await pool.query(`
      SELECT
        user_id,
        COALESCE(SUM(prompt_tokens), 0)::BIGINT AS total_prompt,
        COALESCE(SUM(cached_tokens), 0)::BIGINT AS total_cached
      FROM usage_records
      WHERE created_at >= NOW() - $1::INTERVAL
        AND user_id = ANY($2::INT[])
      GROUP BY user_id
    `, [`${days} days`, userIds]);

    const cacheMap = Object.fromEntries(
      cacheResult.rows.map(r => [r.user_id, {
        total_prompt: parseInt(r.total_prompt) || 0,
        total_cached: parseInt(r.total_cached) || 0
      }])
    );

    // 3. 合并数据并计算缓存命中率
    let leaderboard = users.map(u => {
      const cache = cacheMap[u.user_id] || { total_prompt: 0, total_cached: 0 };
      const cacheHitRate = cache.total_prompt > 0
        ? parseFloat(((cache.total_cached / cache.total_prompt) * 100).toFixed(2))
        : 0;
      return {
        userId: u.user_id,
        username: u.username,
        avatar: u.avatar,
        totalRequests: parseInt(u.total_requests) || 0,
        totalTokens: parseInt(u.total_tokens) || 0,
        totalPoints: parseFloat(u.total_points) || 0,
        totalPrompt: cache.total_prompt,
        totalCached: cache.total_cached,
        cacheHitRate,
        balance: parseFloat(u.balance) || 0
      };
    });

    // 缓存命中率排序需要在 JS 回排（SQL 中未直接计算）
    if (sort === 'cache') {
      leaderboard.sort((a, b) => b.cacheHitRate - a.cacheHitRate);
    }

    // 4. 计算排名并标记当前用户
    let currentUserRank = 0;
    leaderboard.forEach((u, idx) => {
      u.rank = idx + 1;
      u.isCurrentUser = u.userId === currentUserId;
      if (u.userId === currentUserId) {
        currentUserRank = u.rank;
      }
    });

    res.json({
      leaderboard,
      totalUsers: leaderboard.length,
      currentUserRank
    });
  } catch (error) {
    Logger.error('[获取排行榜] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 模型测试：测试单个模型
router.post('/models/:id/test', requireAuth, async (req, res) => {
  try {
    const { testModel } = require('../utils/model-test');
    const result = await testModel(req.params.id, req.session.user.id);
    res.json(result);
  } catch (error) {
    Logger.error('[模型测试] 错误:', error);
    res.status(500).json({ ok: false, error: '服务器错误' });
  }
});

// 模型测试：批量测试
router.post('/models/test-batch', requireAuth, async (req, res) => {
  try {
    const { testModelsBatch } = require('../utils/model-test');
    const { modelIds } = req.body;
    if (!Array.isArray(modelIds) || modelIds.length === 0) {
      return res.status(400).json({ ok: false, error: '请提供 modelIds 数组' });
    }
    const results = await testModelsBatch(modelIds, req.session.user.id);
    res.json({ results });
  } catch (error) {
    Logger.error('[模型批量测试] 错误:', error);
    res.status(500).json({ ok: false, error: '服务器错误' });
  }
});

// ========== API Key 标签系统 ==========

// 获取所有标签
router.get('/key-tags', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, color, sort_order, created_at
      FROM key_tags
      WHERE user_id = $1
      ORDER BY sort_order ASC, id ASC
    `, [req.session.user.id]);
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取标签] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建标签
router.post('/key-tags', requireAuth, async (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '标签名不能为空' });
  try {
    // 自动分配 sort_order
    const maxResult = await pool.query(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM key_tags WHERE user_id = $1`,
      [req.session.user.id]
    );
    const sortOrder = maxResult.rows[0].next_order;
    const result = await pool.query(`
      INSERT INTO key_tags (user_id, name, color, sort_order)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, color, sort_order, created_at
    `, [req.session.user.id, name.trim(), color || '#3b82f6', sortOrder]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') { // unique violation
      return res.status(409).json({ error: '标签名已存在' });
    }
    Logger.error('[创建标签] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新标签
router.put('/key-tags/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { name, color } = req.body;
  try {
    const result = await pool.query(`
      UPDATE key_tags SET name = COALESCE($1, name), color = COALESCE($2, color)
      WHERE id = $3 AND user_id = $4
      RETURNING id, name, color, sort_order, created_at
    `, [name ? name.trim() : null, color, id, req.session.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '标签不存在' });
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: '标签名已存在' });
    Logger.error('[更新标签] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除标签
router.delete('/key-tags/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM key_tags WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.session.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '标签不存在' });
    res.json({ success: true });
  } catch (error) {
    Logger.error('[删除标签] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 标签排序
router.put('/key-tags/reorder', requireAuth, async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return res.status(400).json({ error: 'orderedIds 数组不能为空' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      const r = await client.query(
        `UPDATE key_tags SET sort_order = $1 WHERE id = $2 AND user_id = $3`,
        [i, orderedIds[i], req.session.user.id]
      );
      if (r.rowCount === 0) {
        throw { status: 404, message: `标签 ${orderedIds[i]} 不存在` };
      }
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.status) return res.status(error.status).json({ error: error.message });
    Logger.error('[标签排序] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  } finally {
    client.release();
  }
});

// 设置指定 API Key 的标签
router.put('/api-keys/:id/tags', requireAuth, auditMiddleware(ACTIONS.API_KEY_TAGS, {
  resourceType: 'api_key',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新 API Key #${req.params.id} 标签`,
  detailsFrom: (req) => ({ tag_ids: req.body?.tagIds }),
}), async (req, res) => {
  const { id } = req.params;
  const { tagIds } = req.body;
  if (!Array.isArray(tagIds)) return res.status(400).json({ error: 'tagIds 必须为数组' });

  const client = await pool.connect();
  try {
    // 标签属于发起者的个人分类体系，仅发起者可修改，成员只读。
    const keyAccess = await getOwnedApiKey(client, id, req.session.user.id);
    if (!keyAccess) return res.status(403).json({ error: '仅发起者可管理密钥标签' });

    // 校验所有标签归属发起者
    if (tagIds.length > 0) {
      const tagCheck = await client.query(
        `SELECT id FROM key_tags WHERE id = ANY($1) AND user_id = $2`,
        [tagIds, req.session.user.id]
      );
      if (tagCheck.rows.length !== tagIds.length) {
        return res.status(400).json({ error: '部分标签不存在或无权访问' });
      }
    }

    await client.query('BEGIN');
    await client.query(`DELETE FROM api_key_tags WHERE api_key_id = $1`, [id]);
    for (const tagId of tagIds) {
      await client.query(
        `INSERT INTO api_key_tags (api_key_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, tagId]
      );
    }
    await client.query('COMMIT');

    // 返回更新后的标签
    const tagsResult = await client.query(`
      SELECT kt.id, kt.name, kt.color
      FROM api_key_tags akt
      JOIN key_tags kt ON akt.tag_id = kt.id
      WHERE akt.api_key_id = $1
      ORDER BY kt.sort_order
    `, [id]);
    res.json({ tags: tagsResult.rows });
  } catch (error) {
    await client.query('ROLLBACK');
    Logger.error('[设置标签] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  } finally {
    client.release();
  }
});

// ========== 操作日志查询 ==========
router.get('/audit-logs', requireAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const action = (req.query.action || '').trim();
    const resourceType = (req.query.resource_type || '').trim();

    const whereParts = ['user_id = $1'];
    const params = [req.session.user.id];
    let idx = 2;
    if (action) { whereParts.push(`action = $${idx++}`); params.push(action); }
    if (resourceType) { whereParts.push(`resource_type = $${idx++}`); params.push(resourceType); }
    const where = whereParts.join(' AND ');

    const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM operation_logs WHERE ${where}`, params);
    const total = countResult.rows[0].count;

    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT id, action, resource_type, resource_id, description, details,
              ip_address, status, duration_ms, created_at
       FROM operation_logs
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      listParams
    );

    res.json({ items: result.rows, total, page, limit });
  } catch (error) {
    Logger.error('[操作日志查询] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
