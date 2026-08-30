const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../models/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const config = require('../config-loader');
const Logger = require('../logger');
const { markCompactionBoundaries } = require('../utils/cache-hit-anomaly');
const { lookupProvider, searchProviders, fetchProvidersIndex } = require('../provider-lookup');
const keyRefresher = require('../key-refresher');
const proxyPool = require('../proxy-pool');
const { validateUrl, upstreamUrl } = require('../utils/url-validator');
const {
  getFeishuConfig,
  saveFeishuConfig,
  toPublicAdminView,
  MASKED_SECRET,
} = require('../utils/feishu-config');
const { formatShanghaiDateTime } = require('../utils/timezone');
const { buildUsageLogsFilter, MODEL_NAME_SELECT } = require('../utils/usage-logs-filter');
const { aggregateMessageStats, analyzeMessages } = require('../utils/message-analysis');
const { getMessageAnalysisStatus } = require('../utils/message-analysis-store');
const { ACTIONS, logAction, auditMiddleware } = require('../utils/audit-log');
const { normalizeEmail } = require('../utils/user-identity');
const {
  normalizeProviderKeyEntries,
  getPrimaryApiKey,
  getApiKeySelectMode,
  normalizeKeysInput,
  toStorageFields,
  countProviderApiKeys
} = require('../utils/provider-keys');
const { parseGrokAuthConfig } = require('../utils/grok-usage');
const { normalizeTestUserAgent } = require('../utils/model-test');
const { encryptSecret, decryptSecret } = require('../utils/secret-crypto');
const { addModelsToFrontierTeams: addModelsToFrontierTeamsIfEnabled } = require('../utils/frontier-auto-add');
const { getRetentionConfig, invalidateRetentionConfigCache } = require('../utils/usage-agg');
const { runCompressOnce } = require('../utils/usage-compress');
const { runPurgeOnce } = require('../utils/usage-purge');
const retentionRunner = require('../utils/retention-runner');
const {
  generateDefaultQuotaScript,
  queryProviderQuota,
  saveQuotaSnapshot,
  normalizeQuotaScheduleInterval
} = require('../utils/provider-quota');

/**
 * 按系统开关将模型挂载到所有前沿 Team；仅补缺失映射。
 * @param {string|string[]} modelIds
 * @returns {Promise<number>} 新插入的映射行数
 */
async function addModelsToFrontierTeams(modelIds) {
  const added = await addModelsToFrontierTeamsIfEnabled(pool, modelIds);
  if (added > 0) Logger.info(`[前沿Team] 自动新增 ${added} 条模型映射`);
  return added;
}

// 获取所有用户列表（支持可选分页：?page=&limit=&q=）
router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const baseFrom = `
       FROM users u
       LEFT JOIN teams t ON u.team_id = t.id
       LEFT JOIN user_groups ug ON u.group_id = ug.id`;
    const selectCols = `
       SELECT u.id, u.username, u.email, u.email_verified, u.avatar, u.balance, u.refund_balance,
              u.is_admin, u.tags, u.rate_limit_rpm, u.rate_limit_tpm, u.created_at,
              u.team_id, t.name AS team_name,
              u.group_id, ug.name AS group_name`;

    // 无 page 参数时保持旧行为（全量数组），兼容成员选择等场景
    if (req.query.page === undefined) {
      const result = await pool.query(`${selectCols} ${baseFrom} ORDER BY u.created_at DESC`);
      return res.json(result.rows);
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const q = (req.query.q || '').trim();

    let where = '';
    const params = [];
    if (q) {
      where = ` WHERE (u.username ILIKE $1 OR u.email ILIKE $1)`;
      params.push(`%${q}%`);
    }

    const countResult = await pool.query(`SELECT COUNT(*)::int AS count ${baseFrom} ${where}`, params);
    const total = countResult.rows[0].count;

    const statsResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE u.is_admin)::int AS admin_count,
         COUNT(*) FILTER (WHERE u.email_verified)::int AS verified_count,
         COALESCE(SUM(u.balance), 0)::float AS total_balance
       ${baseFrom} ${where}`,
      params
    );

    const listParams = [...params, limit, offset];
    const limIdx = params.length + 1;
    const offIdx = params.length + 2;
    const result = await pool.query(
      `${selectCols} ${baseFrom} ${where} ORDER BY u.created_at DESC LIMIT $${limIdx} OFFSET $${offIdx}`,
      listParams
    );

    const s = statsResult.rows[0] || {};
    res.json({
      items: result.rows,
      total,
      page,
      limit,
      stats: {
        adminCount: s.admin_count || 0,
        verifiedCount: s.verified_count || 0,
        totalBalance: parseFloat(s.total_balance || 0)
      }
    });
  } catch (error) {
    Logger.error('[获取用户列表] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新用户状态（仅更新请求体中显式提供的字段，避免部分更新覆盖 is_admin 等关键属性）
router.put('/users/:id', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_USER_UPDATE, {
  resourceType: 'user',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `更新用户 #${req.params.id}`,
  detailsFrom: (req) => ({ username: req.body?.username, is_admin: req.body?.is_admin, balance: req.body?.balance, team_id: req.body?.team_id, group_id: req.body?.group_id }),
}), async (req, res) => {
  const { email, email_verified, isAdmin, balance, refundBalance, group_id, tags, rate_limit_rpm, rate_limit_tpm, team_id } = req.body;
  const userId = req.params.id;

  if (balance !== undefined && (typeof balance !== 'number' || isNaN(balance) || balance < 0 || balance >= 1000000)) {
    return res.status(400).json({ error: '余额必须是 0 到 999999.9999 之间的数字' });
  }
  if (refundBalance !== undefined && (typeof refundBalance !== 'number' || !Number.isFinite(refundBalance) || refundBalance < 0 || refundBalance >= 1000000)) {
    return res.status(400).json({ error: '可退款余额必须是 0 到 999999.9999 之间的数字' });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const target = await client.query('SELECT id, is_admin FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (target.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: '用户不存在' });
      }
      let normalizedEmail;
      if (email !== undefined) {
        try { normalizedEmail = normalizeEmail(email); } catch (error) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: error.message });
        }
      }
      if (normalizedEmail) {
        const existingUser = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2', [normalizedEmail, userId]);
        if (existingUser.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: '该邮箱已被其他用户使用' });
        }
      }
    const sets = [];
    const params = [userId];
    let idx = 2;

    if (email !== undefined) {
      sets.push(`email = $${idx++}`);
      params.push(normalizedEmail);
    }
    if (email_verified !== undefined) {
      sets.push(`email_verified = $${idx++}`);
      params.push(!!email_verified);
    }
    if (isAdmin !== undefined) {
      // 取消管理员前，确保系统至少保留一名管理员
      if (!isAdmin) {
        const target = await client.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
        if (target.rows.length === 0) {
          return res.status(404).json({ error: '用户不存在' });
        }
        if (target.rows[0].is_admin) {
          const adminCount = await client.query(
            'SELECT COUNT(*)::int AS count FROM users WHERE is_admin = TRUE AND id != $1',
            [userId]
          );
          if ((adminCount.rows[0].count || 0) === 0) {
            return res.status(400).json({ error: '系统至少需要保留一名管理员，无法取消该用户的管理员权限' });
          }
        }
      }
      sets.push(`is_admin = $${idx++}`);
      params.push(!!isAdmin);
    }
    if (balance !== undefined) {
      sets.push(`balance = $${idx++}`);
      params.push(balance);
    }
    if (refundBalance !== undefined) {
      sets.push(`refund_balance = $${idx++}`);
      params.push(refundBalance);
    }
    if (group_id !== undefined) {
      sets.push(`group_id = $${idx++}`);
      params.push(group_id === null || group_id === '' ? null : group_id);
    }
    if (tags !== undefined) {
      sets.push(`tags = $${idx++}`);
      params.push(Array.isArray(tags) ? tags : []);
    }
    if (rate_limit_rpm !== undefined) {
      sets.push(`rate_limit_rpm = $${idx++}`);
      params.push(rate_limit_rpm || 0);
    }
    if (rate_limit_tpm !== undefined) {
      sets.push(`rate_limit_tpm = $${idx++}`);
      params.push(rate_limit_tpm || 0);
    }
    if (team_id !== undefined) {
      sets.push(`team_id = $${idx++}`);
      params.push(team_id === null || team_id === '' ? null : team_id);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: '未提供任何可更新字段' });
    }

    sets.push('updated_at = CURRENT_TIMESTAMP');
    const result = await client.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1`,
      params
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '用户不存在' });
    }
    await client.query('COMMIT');
    res.json({ success: true });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: '邮箱或用户标识已被其他用户使用' });
    Logger.error('[更新用户状态] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 管理员退款：从用户可退款余额中扣除（按手续费从高到低）
router.post('/users/:id/refund', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_USER_REFUND, {
  resourceType: 'user',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `退款用户 #${req.params.id}`,
  detailsFrom: (req) => ({ refund_amount: req.body?.refundAmount }),
}), async (req, res) => {
  const { refundAmount } = req.body;
  const userId = req.params.id;

  if (typeof refundAmount !== 'number' || isNaN(refundAmount) || refundAmount <= 0) {
    return res.status(400).json({ error: '退款金额必须大于 0' });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 获取用户当前可退款余额
      const userResult = await client.query('SELECT refund_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: '用户不存在' });
      }

      const userRefundBalance = parseFloat(userResult.rows[0].refund_balance || 0);
      if (refundAmount > userRefundBalance) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `退款金额不能超过可退款余额 ¥${userRefundBalance.toFixed(4)}` });
      }

      await client.query('UPDATE users SET refund_balance = refund_balance - $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [userId, refundAmount]);
      await client.query('COMMIT');
      Logger.info(`[退款] 管理员退款: userId=${userId}, amount=${refundAmount}`);
      res.json({ success: true, newRefundBalance: userRefundBalance - refundAmount });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    Logger.error('[退款] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用户兑换码余额明细
router.get('/users/:id/code-balances', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT cb.*, rc.code FROM code_balances cb 
       LEFT JOIN redemption_codes rc ON cb.redemption_code_id = rc.id 
       WHERE cb.user_id = $1 AND cb.remaining_amount > 0 
       ORDER BY cb.created_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取兑换码余额] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取所有模型列表
router.get('/models', requireAuth, requireAdmin, async (req, res) => {
  try {
    const baseFrom = `
      FROM models m
      LEFT JOIN providers p ON m.provider = p.id
      LEFT JOIN model_test_results mtr ON mtr.model_id = m.id`;
    const selectCols = `
      SELECT m.*, p.name AS provider_name,
             COALESCE(p.test_user_agent, '') AS provider_test_user_agent,
             mtr.ok AS test_ok, mtr.latency_ms AS test_latency_ms,
             mtr.tokens_per_second AS test_tokens_per_second,
             mtr.total_tokens AS test_total_tokens, mtr.error AS test_error,
             mtr.tested_at AS test_tested_at`;

    if (req.query.page === undefined) {
      const result = await pool.query(`${selectCols} ${baseFrom} ORDER BY m.provider, m.name`);
      return res.json(result.rows);
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const q = (req.query.q || '').trim();
    const provider = (req.query.provider || '').trim();
    const enabled = req.query.enabled; // 'true' | 'false' | undefined
    const series = (req.query.series || '').trim();
    const test = (req.query.test || '').trim(); // pass | fail | untested

    const whereParts = [];
    const params = [];
    let idx = 1;
    if (q) {
      whereParts.push(`(m.id ILIKE $${idx} OR m.name ILIKE $${idx} OR COALESCE(m.upstream_model_id,'') ILIKE $${idx} OR COALESCE(m.alias,'') ILIKE $${idx} OR COALESCE(m.series,'') ILIKE $${idx} OR COALESCE(m.description,'') ILIKE $${idx})`);
      params.push(`%${q}%`);
      idx++;
    }
    if (provider) {
      whereParts.push(`m.provider = $${idx++}`);
      params.push(provider);
    }
    if (enabled === 'true') {
      whereParts.push('m.enabled = TRUE');
    } else if (enabled === 'false') {
      whereParts.push('m.enabled = FALSE');
    }
    if (series) {
      whereParts.push(`m.series = $${idx++}`);
      params.push(series);
    }
    if (test === 'pass') {
      whereParts.push('mtr.ok IS TRUE');
    } else if (test === 'fail') {
      whereParts.push('mtr.ok IS FALSE');
    } else if (test === 'untested') {
      whereParts.push('mtr.ok IS NULL');
    }
    const where = whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : '';

    const countResult = await pool.query(`SELECT COUNT(*)::int AS count ${baseFrom} ${where}`, params);
    const total = countResult.rows[0].count;

    // 统计卡片基于筛选后的全集
    const statsResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE m.enabled)::int AS enabled_count,
         COUNT(DISTINCT m.provider)::int AS provider_count,
         COALESCE(AVG(m.input_price_per_1k_tokens), 0)::float AS avg_input_price
       ${baseFrom} ${where}`,
      params
    );

    // 供应商筛选项（不应用 provider 过滤，但应用搜索/状态/系列/测试，便于下拉完整）
    const providerFilterParts = [];
    const providerFilterParams = [];
    let pIdx = 1;
    if (q) {
      providerFilterParts.push(`(m.id ILIKE $${pIdx} OR m.name ILIKE $${pIdx} OR COALESCE(m.upstream_model_id,'') ILIKE $${pIdx} OR COALESCE(m.alias,'') ILIKE $${pIdx} OR COALESCE(m.series,'') ILIKE $${pIdx} OR COALESCE(m.description,'') ILIKE $${pIdx})`);
      providerFilterParams.push(`%${q}%`);
      pIdx++;
    }
    if (enabled === 'true') providerFilterParts.push('m.enabled = TRUE');
    else if (enabled === 'false') providerFilterParts.push('m.enabled = FALSE');
    if (series) {
      providerFilterParts.push(`m.series = $${pIdx++}`);
      providerFilterParams.push(series);
    }
    if (test === 'pass') providerFilterParts.push('mtr.ok IS TRUE');
    else if (test === 'fail') providerFilterParts.push('mtr.ok IS FALSE');
    else if (test === 'untested') providerFilterParts.push('mtr.ok IS NULL');
    const providerWhere = providerFilterParts.length ? ` WHERE ${providerFilterParts.join(' AND ')}` : '';
    // 供应商列表带模型数（展开懒加载用；不应用 provider 过滤）
    const providersResult = await pool.query(
      `SELECT m.provider,
              p.name AS provider_name,
              COUNT(*)::int AS model_count,
              COUNT(*) FILTER (WHERE m.enabled)::int AS enabled_count
       FROM models m
       LEFT JOIN providers p ON m.provider = p.id
       LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
       ${providerWhere}
       GROUP BY m.provider, p.name
       ORDER BY p.name NULLS LAST, m.provider`,
      providerFilterParams
    );

    // 系列筛选项（不应用 series 过滤）
    const seriesFilterParts = [];
    const seriesFilterParams = [];
    let sIdx = 1;
    if (q) {
      seriesFilterParts.push(`(m.id ILIKE $${sIdx} OR m.name ILIKE $${sIdx} OR COALESCE(m.upstream_model_id,'') ILIKE $${sIdx} OR COALESCE(m.alias,'') ILIKE $${sIdx} OR COALESCE(m.series,'') ILIKE $${sIdx} OR COALESCE(m.description,'') ILIKE $${sIdx})`);
      seriesFilterParams.push(`%${q}%`);
      sIdx++;
    }
    if (provider) {
      seriesFilterParts.push(`m.provider = $${sIdx++}`);
      seriesFilterParams.push(provider);
    }
    if (enabled === 'true') seriesFilterParts.push('m.enabled = TRUE');
    else if (enabled === 'false') seriesFilterParts.push('m.enabled = FALSE');
    if (test === 'pass') seriesFilterParts.push('mtr.ok IS TRUE');
    else if (test === 'fail') seriesFilterParts.push('mtr.ok IS FALSE');
    else if (test === 'untested') seriesFilterParts.push('mtr.ok IS NULL');
    seriesFilterParts.push(`COALESCE(m.series, '') <> ''`);
    const seriesWhere = ` WHERE ${seriesFilterParts.join(' AND ')}`;
    const seriesResult = await pool.query(
      `SELECT DISTINCT m.series
       FROM models m
       LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
       ${seriesWhere}
       ORDER BY m.series`,
      seriesFilterParams
    );

    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `${selectCols} ${baseFrom} ${where} ORDER BY COALESCE(p.name, m.provider), COALESCE(NULLIF(m.upstream_model_id, ''), m.name, m.id) LIMIT $${idx++} OFFSET $${idx++}`,
      listParams
    );

    const s = statsResult.rows[0] || {};
    res.json({
      items: result.rows,
      total,
      page,
      limit,
      stats: {
        enabledCount: s.enabled_count || 0,
        providerCount: s.provider_count || 0,
        avgInputPrice: parseFloat(s.avg_input_price || 0)
      },
      providers: providersResult.rows.map(r => ({
        id: r.provider,
        name: r.provider_name || r.provider,
        model_count: r.model_count || 0,
        enabled_count: r.enabled_count || 0
      })),
      series: seriesResult.rows.map(r => r.series).filter(Boolean)
    });
  } catch (error) {
    Logger.error('[获取模型列表] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建/更新模型
router.post('/models', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_MODEL_CREATE, {
  resourceType: 'model',
  resourceIdFrom: (req, res) => res._logBody?.id,
  descriptionFrom: (req) => `创建模型「${req.body?.name || req.body?.id || '-'}」`,
}), async (req, res) => {
  const { id, provider, series, description, enabled, input_price_per_1k_tokens, output_price_per_1k_tokens, cached_output_price_per_1k_tokens, reference_input_price_per_1k_tokens, reference_output_price_per_1k_tokens, reference_cached_output_price_per_1k_tokens, rate_limit_rpm, rate_limit_tpm, icon_url, alias,
    completion_ratio, image_ratio, audio_ratio, model_price, billing_mode, thinking_model_id, non_thinking_model_id,
    model_multiplier, completion_multiplier, forward_reasoning_effort } = req.body;
  if (!provider) {
    return res.status(400).json({ error: '提供商不能为空' });
  }
  // 有 id → 更新已有模型；无 id → 生成 UUID 创建新模型
  const modelId = id || crypto.randomUUID();
  const upstreamModelId = req.body.upstream_model_id || modelId;
  const name = alias || upstreamModelId;
  try {
    await pool.query(`
      INSERT INTO models (id, name, provider, series, description, enabled, input_price_per_1k_tokens, output_price_per_1k_tokens, cached_output_price_per_1k_tokens, reference_input_price_per_1k_tokens, reference_output_price_per_1k_tokens, reference_cached_output_price_per_1k_tokens, rate_limit_rpm, rate_limit_tpm, icon_url, alias,
        completion_ratio, image_ratio, audio_ratio, model_price, billing_mode, thinking_model_id, non_thinking_model_id,
        model_multiplier, completion_multiplier, upstream_model_id, forward_reasoning_effort)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        provider = EXCLUDED.provider,
        series = EXCLUDED.series,
        description = EXCLUDED.description,
        enabled = EXCLUDED.enabled,
        input_price_per_1k_tokens = EXCLUDED.input_price_per_1k_tokens,
        output_price_per_1k_tokens = EXCLUDED.output_price_per_1k_tokens,
        cached_output_price_per_1k_tokens = EXCLUDED.cached_output_price_per_1k_tokens,
        reference_input_price_per_1k_tokens = EXCLUDED.reference_input_price_per_1k_tokens,
        reference_output_price_per_1k_tokens = EXCLUDED.reference_output_price_per_1k_tokens,
        reference_cached_output_price_per_1k_tokens = EXCLUDED.reference_cached_output_price_per_1k_tokens,
        rate_limit_rpm = EXCLUDED.rate_limit_rpm,
        rate_limit_tpm = EXCLUDED.rate_limit_tpm,
        icon_url = EXCLUDED.icon_url,
        alias = EXCLUDED.alias,
        completion_ratio = EXCLUDED.completion_ratio,
        image_ratio = EXCLUDED.image_ratio,
        audio_ratio = EXCLUDED.audio_ratio,
        model_price = EXCLUDED.model_price,
        billing_mode = EXCLUDED.billing_mode,
        thinking_model_id = EXCLUDED.thinking_model_id,
        non_thinking_model_id = EXCLUDED.non_thinking_model_id,
        model_multiplier = EXCLUDED.model_multiplier,
        completion_multiplier = EXCLUDED.completion_multiplier,
        upstream_model_id = EXCLUDED.upstream_model_id,
        forward_reasoning_effort = EXCLUDED.forward_reasoning_effort
    `, [modelId, name, provider, series || '', description, enabled, input_price_per_1k_tokens || 0, output_price_per_1k_tokens || 0, cached_output_price_per_1k_tokens || 0, reference_input_price_per_1k_tokens || 0, reference_output_price_per_1k_tokens || 0, reference_cached_output_price_per_1k_tokens || 0, rate_limit_rpm || 0, rate_limit_tpm || 0, icon_url || '', alias || '',
      completion_ratio || 1.0, image_ratio || 0.0, audio_ratio || 0.0, model_price || 0, billing_mode || 'ratio', thinking_model_id || '', non_thinking_model_id || '',
      model_multiplier || 1.0, completion_multiplier || 1.0, upstreamModelId, forward_reasoning_effort === true]);

    // 新模型（或重新保存且系统启用）自动挂载到前沿 Team
    if (enabled !== false) {
      try {
        await addModelsToFrontierTeams(modelId);
      } catch (e) {
        Logger.warn('[创建模型] 自动添加到前沿Team失败:', e.message);
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'test_user_agent') && provider) {
      try {
        await pool.query(
          `ALTER TABLE providers ADD COLUMN IF NOT EXISTS test_user_agent TEXT DEFAULT ''`
        );
        await pool.query(
          `UPDATE providers SET test_user_agent = $1 WHERE id = $2`,
          [normalizeTestUserAgent(req.body.test_user_agent), provider]
        );
      } catch (e) {
        Logger.warn(`[创建/更新模型] 保存供应商测试 UA 失败: ${e.message}`);
      }
    }

    res.json({ success: true });
  } catch (error) {
    Logger.error('[创建/更新模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除模型（清理 Key/Team/Fusion 等关联后再删）
router.delete('/models/:id', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_MODEL_DELETE, {
  resourceType: 'model',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `删除模型 #${req.params.id}`,
}), async (req, res) => {
  try {
    const id = req.params.id;
    const exists = await pool.query('SELECT id FROM models WHERE id = $1', [id]);
    if (exists.rows.length === 0) {
      return res.status(404).json({ error: '模型不存在' });
    }
    await purgeModelsCompletely(pool, [id]);
    Logger.info(`[模型] 已删除模型 ${id}`);
    res.json({ success: true, deleted: 1 });
  } catch (error) {
    Logger.error('[删除模型] 错误:', error);
    res.status(500).json({ error: '删除失败: ' + (error.message || '服务器错误') });
  }
});

// 批量删除模型
router.post('/models/batch-delete', requireAuth, requireAdmin, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要删除的模型' });
  }
  try {
    const uniqueIds = [...new Set(ids.map(String).filter(Boolean))];
    await purgeModelsCompletely(pool, uniqueIds);
    Logger.info(`[模型] 批量删除了 ${uniqueIds.length} 个模型`);
    res.json({ success: true, deleted: uniqueIds.length });
  } catch (error) {
    Logger.error('[批量删除模型] 错误:', error);
    res.status(500).json({ error: '批量删除失败: ' + (error.message || '服务器错误') });
  }
});

// 批量启用/禁用模型
router.post('/models/batch-update', requireAuth, requireAdmin, async (req, res) => {
  const { ids, enabled } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择模型' });
  }
  try {
    await pool.query('UPDATE models SET enabled = $1 WHERE id = ANY($2)', [enabled, ids]);
    if (enabled === true) {
      try {
        await addModelsToFrontierTeams(ids);
      } catch (e) {
        Logger.warn('[批量启用模型] 自动添加到前沿Team失败:', e.message);
      }
    }
    Logger.info(`[模型] 批量${enabled ? '启用' : '禁用'}了 ${ids.length} 个模型`);
    res.json({ success: true, updated: ids.length });
  } catch (error) {
    Logger.error('[批量更新模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量添加模型（从供应商拉取）
router.post('/models/batch-add', requireAuth, requireAdmin, async (req, res) => {
  const { models: modelIds, provider } = req.body;
  if (!Array.isArray(modelIds) || modelIds.length === 0) {
    return res.status(400).json({ error: '请选择模型' });
  }
  try {
    let added = 0;
    const newModelUuids = [];
    for (const modelId of modelIds) {
      // 同一供应商下同名模型不重复添加
      const existing = await pool.query(
        'SELECT id FROM models WHERE upstream_model_id = $1 AND provider = $2',
        [modelId, provider]
      );
      if (existing.rows.length > 0) continue;

      const uuid = crypto.randomUUID();
      await pool.query(
        `INSERT INTO models (id, name, provider, enabled, upstream_model_id)
         VALUES ($1, $2, $3, TRUE, $4)`,
        [uuid, modelId, provider, modelId]
      );
      newModelUuids.push(uuid);
      added++;
    }
    // 新模型自动启用到前沿 Team
    if (newModelUuids.length > 0) {
      try {
        await addModelsToFrontierTeams(newModelUuids);
      } catch (e) {
        Logger.warn('[批量添加模型] 自动添加到前沿Team失败:', e.message);
      }
    }
    Logger.info(`[模型] 批量添加了 ${added} 个模型`);
    res.json({ success: true, added });
  } catch (error) {
    Logger.error('[批量添加模型] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量设置固定价格
router.post('/models/batch-update-prices', requireAuth, requireAdmin, async (req, res) => {
  const { ids, mode, percentage, input_price, output_price, cached_output_price } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择模型' });
  }
  try {
    if (mode === 'multiply') {
      const factor = 1 + (percentage / 100);
      await pool.query(
        `UPDATE models SET
          input_price_per_1k_tokens = input_price_per_1k_tokens * $1,
          output_price_per_1k_tokens = output_price_per_1k_tokens * $1,
          cached_output_price_per_1k_tokens = cached_output_price_per_1k_tokens * $1
         WHERE id = ANY($2)`,
        [factor, ids]
      );
    } else {
      await pool.query(
        `UPDATE models SET
          input_price_per_1k_tokens = $1,
          output_price_per_1k_tokens = $2,
          cached_output_price_per_1k_tokens = $3
         WHERE id = ANY($4)`,
        [input_price, output_price, cached_output_price, ids]
      );
    }
    Logger.info(`[模型] 批量更新了 ${ids.length} 个模型的价格`);
    res.json({ success: true, updated: ids.length });
  } catch (error) {
    Logger.error('[批量更新价格] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// JSON 批量定价
router.post('/models/batch-set-prices', requireAuth, requireAdmin, async (req, res) => {
  const { prices } = req.body;
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) {
    return res.status(400).json({ error: '参数格式错误' });
  }
  try {
    let updated = 0;
    const notFound = [];
    for (const [modelId, p] of Object.entries(prices)) {
      const input = p.in ?? p.input ?? p.input_price_per_1k_tokens;
      const output = p.out ?? p.output ?? p.output_price_per_1k_tokens;
      const cachedOutput = p.cached ?? p.cached_output ?? p.cached_output_price_per_1k_tokens;
      if (input === undefined && output === undefined && cachedOutput === undefined) continue;
      const result = await pool.query(
        `UPDATE models SET
          input_price_per_1k_tokens = COALESCE($1, input_price_per_1k_tokens),
          output_price_per_1k_tokens = COALESCE($2, output_price_per_1k_tokens),
          cached_output_price_per_1k_tokens = COALESCE($3, cached_output_price_per_1k_tokens)
         WHERE id = $4`,
        [input ?? null, output ?? null, cachedOutput ?? null, modelId]
      );
      if (result.rowCount > 0) {
        updated++;
      } else {
        notFound.push(modelId);
      }
    }
    Logger.info(`[模型] JSON批量定价: 更新 ${updated} 个, 未找到 ${notFound.length} 个`);
    res.json({ success: true, updated, notFound });
  } catch (error) {
    Logger.error('[JSON批量定价] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// JSON 批量定参考价
router.post('/models/batch-set-reference-prices', requireAuth, requireAdmin, async (req, res) => {
  const { prices } = req.body;
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) {
    return res.status(400).json({ error: '参数格式错误' });
  }
  try {
    let updated = 0;
    const notFound = [];
    for (const [modelId, p] of Object.entries(prices)) {
      const input = p.in ?? p.input ?? p.reference_input_price_per_1k_tokens;
      const output = p.out ?? p.output ?? p.reference_output_price_per_1k_tokens;
      if (input === undefined && output === undefined) continue;
      const result = await pool.query(
        `UPDATE models SET
          reference_input_price_per_1k_tokens = COALESCE($1, reference_input_price_per_1k_tokens),
          reference_output_price_per_1k_tokens = COALESCE($2, reference_output_price_per_1k_tokens)
         WHERE id = $3`,
        [input ?? null, output ?? null, modelId]
      );
      if (result.rowCount > 0) {
        updated++;
      } else {
        notFound.push(modelId);
      }
    }
    Logger.info(`[模型] JSON批量定参考价: 更新 ${updated} 个, 未找到 ${notFound.length} 个`);
    res.json({ success: true, updated, notFound });
  } catch (error) {
    Logger.error('[JSON批量定参考价] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量更新速率限制
router.post('/models/batch-update-ratelimit', requireAuth, requireAdmin, async (req, res) => {
  const { ids, rate_limit_rpm, rate_limit_tpm } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择模型' });
  }
  try {
    await pool.query(
      `UPDATE models SET rate_limit_rpm = $1, rate_limit_tpm = $2 WHERE id = ANY($3)`,
      [rate_limit_rpm || 0, rate_limit_tpm || 0, ids]
    );
    Logger.info(`[模型] 批量设置了 ${ids.length} 个模型的速率限制`);
    res.json({ success: true, updated: ids.length });
  } catch (error) {
    Logger.error('[批量设置速率限制] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量更新描述
router.post('/models/batch-update-description', requireAuth, requireAdmin, async (req, res) => {
  const { ids, description, mode } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择模型' });
  }
  try {
    if (mode === 'append') {
      await pool.query(
        `UPDATE models SET description = COALESCE(description, '') || $1 WHERE id = ANY($2)`,
        [description, ids]
      );
    } else if (mode === 'prepend') {
      await pool.query(
        `UPDATE models SET description = $1 || COALESCE(description, '') WHERE id = ANY($2)`,
        [description, ids]
      );
    } else {
      await pool.query(
        `UPDATE models SET description = $1 WHERE id = ANY($2)`,
        [description, ids]
      );
    }
    Logger.info(`[模型] 批量更新了 ${ids.length} 个模型的描述`);
    res.json({ success: true, updated: ids.length });
  } catch (error) {
    Logger.error('[批量更新描述] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量更新系列
router.post('/models/batch-update-series', requireAuth, requireAdmin, async (req, res) => {
  const { ids, series } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择模型' });
  }
  try {
    await pool.query(
      `UPDATE models SET series = $1 WHERE id = ANY($2)`,
      [series || '', ids]
    );
    Logger.info(`[模型] 批量设置了 ${ids.length} 个模型的系列`);
    res.json({ success: true, updated: ids.length });
  } catch (error) {
    Logger.error('[批量设置系列] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取所有系列图标
router.get('/series-icons', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM series ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取系列图标] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 设置系列图标
router.post('/series-icons', requireAuth, requireAdmin, async (req, res) => {
  const { name, icon_url } = req.body;
  if (!name) return res.status(400).json({ error: '系列名称不能为空' });
  try {
    await pool.query(
      `INSERT INTO series (name, icon_url) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET icon_url = $2`,
      [name, icon_url || '']
    );
    Logger.info(`[系列图标] 设置: ${name}`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[设置系列图标] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除系列图标
router.delete('/series-icons/:name', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM series WHERE name = $1', [req.params.name]);
    Logger.info(`[系列图标] 删除: ${req.params.name}`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[删除系列图标] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量将缓存输出价格设置为输出价格
router.post('/models/batch-sync-cached-price', requireAuth, requireAdmin, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择模型' });
  }
  try {
    await pool.query(
      `UPDATE models SET cached_output_price_per_1k_tokens = output_price_per_1k_tokens WHERE id = ANY($1)`,
      [ids]
    );
    Logger.info(`[模型] 批量同步了 ${ids.length} 个模型的缓存价格为输出价格`);
    res.json({ success: true, updated: ids.length });
  } catch (error) {
    Logger.error('[批量同步缓存价格] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// JSON 批量设置参考价
router.post('/models/batch-set-reference-prices', requireAuth, requireAdmin, async (req, res) => {
  const { prices } = req.body;
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) {
    return res.status(400).json({ error: '参数格式错误' });
  }
  try {
    let updated = 0;
    const notFound = [];
    for (const [modelId, p] of Object.entries(prices)) {
      const refInput = p.ref_in ?? p.ref_input ?? p.reference_input_price_per_1k_tokens;
      const refOutput = p.ref_out ?? p.ref_output ?? p.reference_output_price_per_1k_tokens;
      const refCachedOutput = p.ref_cached ?? p.ref_cached_output ?? p.reference_cached_output_price_per_1k_tokens;
      if (refInput === undefined && refOutput === undefined && refCachedOutput === undefined) continue;
      const result = await pool.query(
        `UPDATE models SET
          reference_input_price_per_1k_tokens = COALESCE($1, reference_input_price_per_1k_tokens),
          reference_output_price_per_1k_tokens = COALESCE($2, reference_output_price_per_1k_tokens),
          reference_cached_output_price_per_1k_tokens = COALESCE($3, reference_cached_output_price_per_1k_tokens)
         WHERE id = $4`,
        [refInput ?? null, refOutput ?? null, refCachedOutput ?? null, modelId]
      );
      if (result.rowCount > 0) {
        updated++;
      } else {
        notFound.push(modelId);
      }
    }
    Logger.info(`[模型] JSON批量设置参考价: 更新 ${updated} 个, 未找到 ${notFound.length} 个`);
    res.json({ success: true, updated, notFound });
  } catch (error) {
    Logger.error('[JSON批量设置参考价] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 按参考价百分比批量设置价格（预览模式）
router.post('/models/batch-adjust-by-reference-preview', requireAuth, requireAdmin, async (req, res) => {
  const { ids, input_pct, output_pct, cached_output_pct } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择模型' });
  }
  try {
    const result = await pool.query(
      `SELECT id, name,
        input_price_per_1k_tokens, output_price_per_1k_tokens, cached_output_price_per_1k_tokens,
        reference_input_price_per_1k_tokens, reference_output_price_per_1k_tokens, reference_cached_output_price_per_1k_tokens
       FROM models WHERE id = ANY($1)`,
      [ids]
    );
    const preview = result.rows.map(m => ({
      id: m.id,
      name: m.name,
      current_input: parseFloat(m.input_price_per_1k_tokens || 0),
      current_output: parseFloat(m.output_price_per_1k_tokens || 0),
      current_cached_output: parseFloat(m.cached_output_price_per_1k_tokens || 0),
      ref_input: parseFloat(m.reference_input_price_per_1k_tokens || 0),
      ref_output: parseFloat(m.reference_output_price_per_1k_tokens || 0),
      ref_cached_output: parseFloat(m.reference_cached_output_price_per_1k_tokens || 0),
      new_input: input_pct != null ? parseFloat((parseFloat(m.reference_input_price_per_1k_tokens || 0) * input_pct / 100).toFixed(6)) : null,
      new_output: output_pct != null ? parseFloat((parseFloat(m.reference_output_price_per_1k_tokens || 0) * output_pct / 100).toFixed(6)) : null,
      new_cached_output: cached_output_pct != null ? parseFloat((parseFloat(m.reference_cached_output_price_per_1k_tokens || 0) * cached_output_pct / 100).toFixed(6)) : null,
    }));
    res.json({ preview });
  } catch (error) {
    Logger.error('[按参考价预览] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 按参考价百分比批量设置价格（执行）
router.post('/models/batch-adjust-by-reference', requireAuth, requireAdmin, async (req, res) => {
  const { ids, input_pct, output_pct, cached_output_pct } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择模型' });
  }
  try {
    const sets = [];
    const params = [ids];
    let idx = 2;
    if (input_pct != null) {
      sets.push(`input_price_per_1k_tokens = reference_input_price_per_1k_tokens * $${idx++} / 100`);
      params.push(input_pct);
    }
    if (output_pct != null) {
      sets.push(`output_price_per_1k_tokens = reference_output_price_per_1k_tokens * $${idx++} / 100`);
      params.push(output_pct);
    }
    if (cached_output_pct != null) {
      sets.push(`cached_output_price_per_1k_tokens = reference_cached_output_price_per_1k_tokens * $${idx++} / 100`);
      params.push(cached_output_pct);
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: '请至少设置一个百分比' });
    }
    await pool.query(
      `UPDATE models SET ${sets.join(', ')} WHERE id = ANY($1)`,
      params
    );
    Logger.info(`[模型] 按参考价百分比批量设置了 ${ids.length} 个模型的价格`);
    res.json({ success: true, updated: ids.length });
  } catch (error) {
    Logger.error('[按参考价百分比设置价格] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 多维统计筛选选项
router.get('/stats/multi/filters', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [users, teams, groups, models, providers, sources, projects] = await Promise.all([
      pool.query('SELECT id, username AS name FROM users ORDER BY username'),
      pool.query('SELECT id, name FROM teams ORDER BY name'),
      pool.query('SELECT id, name FROM user_groups ORDER BY name'),
      pool.query('SELECT id, name FROM models ORDER BY name'),
      pool.query('SELECT id, name FROM providers ORDER BY name'),
      pool.query("SELECT DISTINCT COALESCE(NULLIF(request_source, ''), 'unknown') AS id FROM usage_records ORDER BY id"),
      pool.query("SELECT DISTINCT workspace_path AS id, workspace_path AS name FROM usage_message_analysis WHERE NULLIF(TRIM(workspace_path), '') IS NOT NULL ORDER BY name LIMIT 500")
    ]);
    const { sourceLabel } = require('../utils/request-source');
    res.json({
      users: users.rows,
      teams: teams.rows,
      groups: groups.rows,
      models: models.rows,
      providers: providers.rows,
      sources: sources.rows.map(row => ({ id: row.id, name: sourceLabel(row.id) })),
      projects: projects.rows
    });
  } catch (error) {
    Logger.error('[获取多维统计筛选选项] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 多维关联统计：统一返回组织、项目、客户端、模型和供应商之间的组合数据
router.get('/stats/multi', requireAuth, requireAdmin, async (req, res) => {
  try {
    const params = [];
    const conditions = [];
    let idx = 1;
    if (req.query.start && req.query.end) {
      conditions.push(`u.created_at >= $${idx++}::date AND u.created_at < ($${idx++}::date + INTERVAL '1 day')`);
      params.push(req.query.start, req.query.end);
    } else {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
      conditions.push(`u.created_at >= NOW() - ($${idx++}::int * INTERVAL '1 day')`);
      params.push(days);
    }
    const addFilter = (value, sql) => {
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        conditions.push(sql.replace('?', `$${idx++}`));
        params.push(String(value));
      }
    };
    addFilter(req.query.user_id, 'u.user_id = ?::int');
    addFilter(req.query.team_id, 'usr.team_id = ?::int');
    addFilter(req.query.group_id, 'usr.group_id = ?::int');
    addFilter(req.query.model_id, 'u.model_id = ?');
    addFilter(req.query.provider_id, 'u.provider_id = ?');
    addFilter(req.query.request_source, "COALESCE(NULLIF(u.request_source, ''), 'unknown') = ?");
    addFilter(req.query.workspace_path, "COALESCE(NULLIF(TRIM(uma.workspace_path), ''), '__unknown__') = ?");

    const where = `WHERE ${conditions.join(' AND ')}`;
    const from = `
      FROM usage_records u
      LEFT JOIN users usr ON usr.id = u.user_id
      LEFT JOIN teams t ON t.id = usr.team_id
      LEFT JOIN user_groups ug ON ug.id = usr.group_id
      LEFT JOIN providers p ON p.id = u.provider_id
      LEFT JOIN usage_message_analysis uma ON uma.usage_id = u.id
      LEFT JOIN LATERAL (
        SELECT m0.id, m0.name, m0.provider
        FROM models m0
        WHERE m0.id = u.model_id
           OR (u.provider_id IS NOT NULL AND m0.upstream_model_id = u.model_id AND m0.provider = u.provider_id)
        ORDER BY CASE WHEN m0.id = u.model_id THEN 0 ELSE 1 END
        LIMIT 1
      ) mdl ON TRUE`;
    const baseSelect = `
      u.user_id,
      COALESCE(usr.username, '未知成员') AS user_name,
      usr.team_id,
      COALESCE(t.name, '未分配 Team') AS team_name,
      usr.group_id,
      COALESCE(ug.name, '未分配用户组') AS group_name,
      COALESCE(NULLIF(TRIM(uma.workspace_path), ''), '__unknown__') AS workspace_path,
      COALESCE(NULLIF(u.request_source, ''), 'unknown') AS request_source,
      u.model_id,
      COALESCE(NULLIF(mdl.name, ''), '未知模型') AS model_name,
      u.provider_id,
      COALESCE(NULLIF(p.name, ''), '未知供应商') AS provider_name,
      COALESCE((
        SELECT key FROM jsonb_object_keys(COALESCE(u.plugin_meta, '{}'::jsonb)) AS key LIMIT 1
      ), '__none__') AS plugin_dim,
      COUNT(*)::int AS requests,
      COALESCE(SUM(u.tokens_used), 0)::bigint AS tokens,
      COALESCE(SUM(u.cost), 0)::numeric AS cost,
      AVG(u.latency_ms)::numeric AS avg_latency,
      MAX(u.created_at) AS last_activity`;
    const combinations = await pool.query(`SELECT ${baseSelect} ${from} ${where}
      GROUP BY u.user_id, usr.username, usr.team_id, t.name, usr.group_id, ug.name,
        COALESCE(NULLIF(TRIM(uma.workspace_path), ''), '__unknown__'),
        COALESCE(NULLIF(u.request_source, ''), 'unknown'), u.model_id,
        COALESCE(NULLIF(mdl.name, ''), '未知模型'), u.provider_id, COALESCE(NULLIF(p.name, ''), '未知供应商'),
        COALESCE((
          SELECT key FROM jsonb_object_keys(COALESCE(u.plugin_meta, '{}'::jsonb)) AS key LIMIT 1
        ), '__none__')
      ORDER BY requests DESC LIMIT 500`, params);
    const summary = await pool.query(`SELECT COUNT(*)::int AS requests, COALESCE(SUM(u.tokens_used), 0)::bigint AS tokens,
      COALESCE(SUM(u.cost), 0)::numeric AS cost, AVG(u.latency_ms)::numeric AS avg_latency,
      COUNT(DISTINCT u.user_id)::int AS active_users, COUNT(DISTINCT usr.team_id)::int AS active_teams,
      COUNT(DISTINCT usr.group_id)::int AS active_groups,
      COUNT(DISTINCT NULLIF(TRIM(uma.workspace_path), ''))::int AS active_projects,
      COUNT(DISTINCT COALESCE(mdl.id, u.model_id))::int AS active_models,
      COUNT(DISTINCT u.provider_id)::int AS active_providers,
      COUNT(DISTINCT COALESCE(NULLIF(u.request_source, ''), 'unknown'))::int AS active_sources
      ${from} ${where}`, params);
    const rows = combinations.rows;
    const aggregate = (key) => {
      const map = new Map();
      rows.forEach(row => {
        const id = row[key] ?? `unknown:${row[key.replace('_id', '_name')]}`;
        const current = map.get(String(id)) || { id, name: row[key.replace('_id', '_name')], requests: 0, tokens: 0, cost: 0 };
        current.requests += Number(row.requests || 0);
        current.tokens += Number(row.tokens || 0);
        current.cost += Number(row.cost || 0);
        map.set(String(id), current);
      });
      return [...map.values()].sort((a, b) => b.requests - a.requests).slice(0, 20);
    };
    const { sourceLabel } = require('../utils/request-source');
    const relationLabelKey = (key) => ({
      user_id: 'user_name', team_id: 'team_name', group_id: 'group_name',
      model_id: 'model_name', provider_id: 'provider_name',
      workspace_path: 'workspace_path', request_source: 'request_source'
    }[key] || key);
    const relation = (leftKey, rightKey) => {
      const map = new Map();
      rows.forEach(row => {
        const left = leftKey === 'request_source'
          ? (sourceLabel(row[relationLabelKey(leftKey)]) || '未知客户端')
          : (row[relationLabelKey(leftKey)] || (leftKey === 'workspace_path' ? '未识别项目' : '未知'));
        const right = rightKey === 'request_source'
          ? (sourceLabel(row[relationLabelKey(rightKey)]) || '未知客户端')
          : (row[relationLabelKey(rightKey)] || (rightKey === 'workspace_path' ? '未识别项目' : '未知'));
        const key = `${left}::${right}`;
        const current = map.get(key) || { left, right, requests: 0, tokens: 0, cost: 0 };
        current.requests += Number(row.requests || 0);
        current.tokens += Number(row.tokens || 0);
        current.cost += Number(row.cost || 0);
        map.set(key, current);
      });
      return [...map.values()].sort((a, b) => b.requests - a.requests).slice(0, 50);
    };
    res.json({
      summary: summary.rows[0] || {},
      combinations: rows,
      dimensions: {
        users: aggregate('user_id'), teams: aggregate('team_id'), groups: aggregate('group_id'),
        projects: aggregate('workspace_path'),
        models: aggregate('model_id').map(row => ({ ...row, name: row.name || '未知模型' })),
        providers: aggregate('provider_id').map(row => ({ ...row, name: row.name || '未知供应商' })),
        sources: aggregate('request_source').map(row => ({ ...row, name: sourceLabel(row.name) || '未知客户端' })),
        plugins: aggregate('plugin_dim').filter(row => row.id !== '__none__').map(row => ({ ...row, name: row.name || row.id }))
      },
      relationships: {
        user_model: relation('user_id', 'model_id'),
        team_model: relation('team_id', 'model_id'),
        group_source: relation('group_id', 'request_source'),
        project_source: relation('workspace_path', 'request_source'),
        model_provider: relation('model_id', 'provider_id'),
        user_project: relation('user_id', 'workspace_path')
      },
      caveats: ['Team 按成员当前主 Team 归属统计；用户组按当前成员关系回溯历史用量；项目未完成消息分析的记录归入未识别项目。']
    });
  } catch (error) {
    Logger.error('[获取多维关联统计] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取系统统计
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const startDate = req.query.start;
    const endDate = req.query.end;
    const filterUserId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;

    let dateSql = `u.created_at >= NOW() - ($1::int * INTERVAL '1 day')`;
    const baseParams = [days];
    let pIdx = 2;
    if (startDate && endDate) {
      dateSql = `u.created_at >= $${pIdx}::date AND u.created_at < ($${pIdx + 1}::date + INTERVAL '1 day')`;
      baseParams.length = 0;
      baseParams.push(startDate, endDate);
      pIdx = 3;
    }
    let userSql = '';
    if (filterUserId && Number.isFinite(filterUserId)) {
      userSql = ` AND u.user_id = $${baseParams.length + 1}`;
      baseParams.push(filterUserId);
    }
    const whereUsage = `WHERE ${dateSql}${userSql}`;
    // daily 表无别名
    const dateSqlBare = dateSql.replace(/u\./g, '');
    const userSqlBare = userSql.replace(/u\./g, '');
    const whereBare = `WHERE ${dateSqlBare}${userSqlBare}`;

    const usersResult = await pool.query('SELECT COUNT(*) as total FROM users');
    const modelsResult = await pool.query('SELECT COUNT(*) as total FROM models WHERE enabled = TRUE');
    const apiKeysResult = await pool.query('SELECT COUNT(*) as total FROM api_keys');
    // created_at 为上海墙钟（会话 TimeZone=Asia/Shanghai）
    const dailyResult = await pool.query(`
      SELECT
        to_char(created_at, 'YYYY-MM-DD') as date,
        COUNT(*) as requests,
        SUM(tokens_used) as tokens,
        SUM(prompt_tokens) as prompt_tokens,
        SUM(completion_tokens) as completion_tokens,
        SUM(cached_tokens) as cached_tokens,
        SUM(cost) as cost
      FROM usage_records u
      ${whereBare}
      GROUP BY to_char(created_at, 'YYYY-MM-DD')
      ORDER BY date DESC
    `, baseParams);
    const byModelResult = await pool.query(`
      SELECT
        COALESCE(m.id, u.model_id) as model_id,
        COALESCE(m.name, u.model_id) as model_name,
        COUNT(*) as requests,
        SUM(u.tokens_used) as tokens,
        SUM(u.cached_tokens) as cached_tokens,
        SUM(u.cost) as cost
      FROM usage_records u
      LEFT JOIN LATERAL (
        SELECT m0.*
        FROM models m0
        WHERE m0.id = u.model_id
           OR (u.provider_id IS NOT NULL AND m0.upstream_model_id = u.model_id AND m0.provider = u.provider_id)
        ORDER BY CASE
          WHEN m0.id = u.model_id AND (u.provider_id IS NULL OR m0.provider = u.provider_id) THEN 0
          WHEN u.provider_id IS NOT NULL AND m0.upstream_model_id = u.model_id AND m0.provider = u.provider_id THEN 1
          WHEN m0.id = u.model_id THEN 2
          ELSE 3
        END
        LIMIT 1
      ) m ON TRUE
      ${whereUsage}
      GROUP BY COALESCE(m.id, u.model_id), COALESCE(m.name, u.model_id)
      ORDER BY requests DESC
      LIMIT 20
    `, baseParams);
    const byProviderResult = await pool.query(`
      SELECT
        COALESCE(p.name, u.provider_id, '未知') as provider,
        COUNT(*) as requests,
        SUM(u.tokens_used) as tokens,
        SUM(u.cached_tokens) as cached_tokens,
        SUM(u.cost) as cost
      FROM usage_records u
      LEFT JOIN providers p ON u.provider_id = p.id
      ${whereUsage}
      GROUP BY COALESCE(p.name, u.provider_id, '未知')
      ORDER BY requests DESC
      LIMIT 20
    `, baseParams);
    const bySourceResult = await pool.query(`
      SELECT
        COALESCE(NULLIF(u.request_source, ''), 'unknown') as request_source,
        COUNT(*) as requests,
        SUM(u.tokens_used) as tokens,
        SUM(u.prompt_tokens) as prompt_tokens,
        SUM(u.completion_tokens) as completion_tokens,
        SUM(u.cached_tokens) as cached_tokens,
        SUM(u.cost) as cost,
        AVG(u.latency_ms) as avg_latency
      FROM usage_records u
      ${whereUsage}
      GROUP BY COALESCE(NULLIF(u.request_source, ''), 'unknown')
      ORDER BY requests DESC
    `, baseParams);
    const byUserResult = await pool.query(`
      SELECT
        u.user_id,
        COALESCE(usr.username, '未知成员') AS user_name,
        COUNT(*) AS requests,
        SUM(u.tokens_used) AS tokens,
        SUM(u.cached_tokens) AS cached_tokens,
        SUM(u.cost) AS cost,
        AVG(u.latency_ms) AS avg_latency
      FROM usage_records u
      LEFT JOIN users usr ON usr.id = u.user_id
      ${whereUsage}
      GROUP BY u.user_id, COALESCE(usr.username, '未知成员')
      ORDER BY requests DESC
      LIMIT 100
    `, baseParams);
    const byTeamResult = await pool.query(`
      SELECT
        t.id AS team_id,
        COALESCE(t.name, '未分配 Team') AS team_name,
        COUNT(*) AS requests,
        SUM(u.tokens_used) AS tokens,
        SUM(u.cached_tokens) AS cached_tokens,
        SUM(u.cost) AS cost,
        AVG(u.latency_ms) AS avg_latency
      FROM usage_records u
      LEFT JOIN user_teams ut ON ut.user_id = u.user_id
      LEFT JOIN teams t ON t.id = ut.team_id
      ${whereUsage}
      GROUP BY t.id, COALESCE(t.name, '未分配 Team')
      ORDER BY requests DESC
      LIMIT 100
    `, baseParams);
    const byGroupResult = await pool.query(`
      SELECT
        ug.id AS group_id,
        COALESCE(ug.name, '未分配用户组') AS group_name,
        COUNT(*) AS requests,
        SUM(u.tokens_used) AS tokens,
        SUM(u.cached_tokens) AS cached_tokens,
        SUM(u.cost) AS cost,
        AVG(u.latency_ms) AS avg_latency
      FROM usage_records u
      LEFT JOIN users usr ON usr.id = u.user_id
      LEFT JOIN user_groups ug ON ug.id = usr.group_id
      ${whereUsage}
      GROUP BY ug.id, COALESCE(ug.name, '未分配用户组')
      ORDER BY requests DESC
      LIMIT 100
    `, baseParams);
    const dailyBySourceResult = await pool.query(`
      SELECT
        to_char(u.created_at, 'YYYY-MM-DD') as date,
        COALESCE(NULLIF(u.request_source, ''), 'unknown') as request_source,
        COUNT(*) as requests,
        SUM(u.tokens_used) as tokens,
        SUM(u.cost) as cost
      FROM usage_records u
      ${whereUsage}
      GROUP BY to_char(u.created_at, 'YYYY-MM-DD'), COALESCE(NULLIF(u.request_source, ''), 'unknown')
      ORDER BY date ASC, requests DESC
    `, baseParams);
    const bySourceModelResult = await pool.query(`
      SELECT
        COALESCE(NULLIF(u.request_source, ''), 'unknown') as request_source,
        u.model_id,
        m.name as model_name,
        COUNT(*) as requests,
        SUM(u.tokens_used) as tokens,
        SUM(u.cost) as cost
      FROM usage_records u
      LEFT JOIN models m ON u.model_id = m.id
      ${whereUsage}
      GROUP BY COALESCE(NULLIF(u.request_source, ''), 'unknown'), u.model_id, m.name
      ORDER BY requests DESC
      LIMIT 80
    `, baseParams);

    const { buildSourceStats } = require('../utils/source-stats');
    const { bySource, sourceSummary } = buildSourceStats(bySourceResult.rows);

    const dailyWithAnomalies = markCompactionBoundaries(
      [...dailyResult.rows].sort((a, b) => String(a.date).localeCompare(String(b.date)))
    ).sort((a, b) => String(b.date).localeCompare(String(a.date)));

    res.json({
      users: parseInt(usersResult.rows[0].total),
      models: parseInt(modelsResult.rows[0].total),
      apiKeys: parseInt(apiKeysResult.rows[0].total),
      days: startDate && endDate ? null : days,
      range: startDate && endDate ? { start: startDate, end: endDate } : { days },
      daily: dailyWithAnomalies,
      byModel: byModelResult.rows,
      byProvider: byProviderResult.rows,
      bySource,
      dailyBySource: dailyBySourceResult.rows,
      bySourceModel: bySourceModelResult.rows,
      byUser: byUserResult.rows,
      byTeam: byTeamResult.rows,
      byGroup: byGroupResult.rows,
      sourceSummary
    });
  } catch (error) {
    Logger.error('[获取系统统计] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 消息结构聚合统计：只读取后台持久化的分析标记，不再扫描 messages JSONB。
router.get('/message-stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const params = [];
    const where = [];
    let idx = 1;
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
    const stats = aggregateMessageStats(result.rows.map(row => ({ ...row, analysis: row })));
    const status = await getMessageAnalysisStatus();
    stats.summary.sampled = false;
    stats.summary.sample_size = result.rows.length;
    stats.summary.analysis_status = status;
    res.json(stats);
  } catch (error) {
    Logger.error('[消息结构统计] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用量日志过滤：见 utils/usage-logs-filter

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// 从 plugin_meta.customInstructions 取文件名列表（逗号连接，供 CSV 导出）
function customInstructionsFiles(pluginMeta) {
  const ci = pluginMeta && pluginMeta.customInstructions;
  if (!Array.isArray(ci)) return '';
  return ci.map((i) => i && i.file).filter(Boolean).map((f) => String(f).trim()).join(',');
}

router.get('/usage-logs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const { where, params, idx: startIdx, fromSql } = buildUsageLogsFilter(req.query);
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
        COALESCE(
          CASE WHEN jsonb_typeof(u.plugin_meta->'customInstructions') = 'array'
               THEN jsonb_array_length(u.plugin_meta->'customInstructions')
               ELSE 0 END, 0
        ) as custom_instruction_count,
        u.cost,
        u.created_at,
        us.username,
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
    Logger.error('[获取用量日志] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取近期 API 调用错误记录
function buildErrorLogsFilter(query) {
  const userId = query.user_id;
  const userQ = (query.user_q || '').trim();
  const modelQ = (query.model_q || '').trim();
  const providerQ = (query.provider_q || '').trim();
  const statusCode = query.status_code;
  const errorType = (query.error_type || '').trim();
  const startDate = query.start_date;
  const endDate = query.end_date;
  const finalOnly = query.final_only === '1' || query.final_only === 'true';

  let where = 'WHERE 1=1';
  const params = [];
  let idx = 1;

  if (userId) { where += ` AND e.user_id = $${idx++}`; params.push(userId); }
  if (userQ) {
    where += ` AND (us.username ILIKE $${idx} OR CAST(e.user_id AS TEXT) ILIKE $${idx})`;
    params.push(`%${userQ}%`);
    idx++;
  }
  if (modelQ) {
    where += ` AND (m.name ILIKE $${idx} OR COALESCE(m.upstream_model_id,'') ILIKE $${idx} OR CAST(e.model_id AS TEXT) ILIKE $${idx} OR COALESCE(m.alias,'') ILIKE $${idx})`;
    params.push(`%${modelQ}%`);
    idx++;
  }
  if (providerQ) {
    where += ` AND (p.name ILIKE $${idx} OR CAST(e.provider_id AS TEXT) ILIKE $${idx})`;
    params.push(`%${providerQ}%`);
    idx++;
  }
  if (statusCode) { where += ` AND e.status_code = $${idx++}`; params.push(parseInt(statusCode, 10)); }
  if (errorType) {
    where += ` AND e.error_type ILIKE $${idx++}`;
    params.push(`%${errorType}%`);
  }
  if (startDate) { where += ` AND e.created_at >= $${idx++}::date`; params.push(startDate); }
  if (endDate) { where += ` AND e.created_at < ($${idx++}::date + INTERVAL '1 day')`; params.push(endDate); }
  if (finalOnly) { where += ` AND e.is_final = TRUE`; }

  const fromSql = `
      FROM api_error_records e
      LEFT JOIN users us ON e.user_id = us.id
      LEFT JOIN api_keys ak ON e.api_key_id = ak.id
      LEFT JOIN models m ON e.model_id = m.id
      LEFT JOIN providers p ON e.provider_id = p.id`;

  return { where, params, idx, fromSql };
}

router.get('/error-logs', requireAuth, requireAdmin, async (req, res) => {
  try {
    // 确保表存在（首次部署兼容）
    const { ensureApiErrorRecordsTable, RETENTION_DAYS } = require('../utils/error-records');
    await ensureApiErrorRecordsTable();

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const { where, params, idx: startIdx, fromSql } = buildErrorLogsFilter(req.query);
    let idx = startIdx;

    const countResult = await pool.query(
      `SELECT COUNT(*) ${fromSql} ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const dataParams = [...params, limit, offset];
    const result = await pool.query(`
      SELECT
        e.id,
        e.user_id,
        e.api_key_id,
        e.model_id,
        e.provider_id,
        e.request_type,
        e.status_code,
        e.error_type,
        e.error_message,
        e.error_body,
        e.latency_ms,
        e.ip_address,
        e.is_final,
        e.created_at,
        us.username,
        ak.key_prefix,
        ak.name as key_name,
        m.series,
        m.name as model_name,
        m.upstream_model_id,
        p.name as provider_name
      ${fromSql}
      ${where}
      ORDER BY e.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, dataParams);

    res.json({
      total,
      page,
      limit,
      retention_days: RETENTION_DAYS,
      logs: result.rows
    });
  } catch (error) {
    Logger.error('[获取错误记录] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 导出调用记录（CSV，沿用当前筛选条件，最多 5 万条）
router.get('/usage-logs/export', requireAuth, requireAdmin, async (req, res) => {
  try {
    const maxRows = Math.min(parseInt(req.query.limit) || 50000, 50000);
    const { where, params, idx: startIdx, fromSql } = buildUsageLogsFilter(req.query);
    let idx = startIdx;

    const result = await pool.query(`
      SELECT
        u.created_at,
        us.username,
        u.user_id,
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
        u.plugin_meta,
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
      '时间', '用户名', '用户ID', '模型', '上游模型ID', '系列', '供应商',
      'Key前缀', 'Key名称', '请求类型', '客户端', '总Token', '输入Token', '输出Token',
      '缓存Token', '积分', '延迟ms', 'IP', '自定义提示词文件'
    ];

    const lines = [header.map(csvEscape).join(',')];
    for (const row of result.rows) {
      const created = formatShanghaiDateTime(row.created_at);
      lines.push([
        created,
        row.username || '',
        row.user_id,
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
        row.ip_address || '',
        customInstructionsFiles(row.plugin_meta)
      ].map(csvEscape).join(','));
    }

    const stamp = formatShanghaiDateTime(new Date()).replace(/[: ]/g, '-');
    const bom = '\uFEFF';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="usage-logs-${stamp}.csv"`);
    res.send(bom + lines.join('\n'));
    Logger.info(`[用量导出] admin 导出 ${result.rows.length} 条`);
  } catch (error) {
    Logger.error('[导出用量日志] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取单条调用记录详情（含 messages / response 大字段，须在 /export 之后注册以免被 :id 遮蔽）
router.get('/usage-logs/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的 ID' });

    const { where, params, fromSql } = buildUsageLogsFilter(req.query);
    const detailIdParam = params.length + 1;
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
        u.plugin_meta,
        u.cost,
        u.created_at,
        us.username,
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
      ${where} AND u.id = $${detailIdParam}
    `, [...params, id]);

    if (!result.rows.length) return res.status(404).json({ error: '记录不存在' });
    const log = result.rows[0];
    // 读取消息中实际存在的上下文字段/区块；不使用客户端识别结果替代原文分析。
    res.json({ log: { ...log, message_analysis: analyzeMessages(log.messages) } });
  } catch (error) {
    Logger.error('[获取用量详情] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取供应商列表（支持可选分页：?page=&limit=&q=&status=&scope=&key_mode=&tag_id=）
router.get('/providers', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureKeyModeColumn();

    // 检查是否有 created_by 列
    const colCheck = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'created_by'"
    );
    const hasCreatedBy = colCheck.rows.length > 0;

    // 检查 notes 列（兼容旧库）
    let hasNotes = false;
    try {
      const notesCol = await pool.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'notes' LIMIT 1"
      );
      hasNotes = notesCol.rows.length > 0;
    } catch (_) { /* ignore */ }

    const selectSql = hasCreatedBy
      ? `SELECT p.*, u.username FROM providers p LEFT JOIN users u ON p.created_by = u.id`
      : `SELECT p.* FROM providers p`;
    const fromSql = hasCreatedBy
      ? `FROM providers p LEFT JOIN users u ON p.created_by = u.id`
      : `FROM providers p`;
    const orderSql = hasCreatedBy
      ? 'ORDER BY p.created_by NULLS FIRST, p.name'
      : 'ORDER BY p.name';

    const q = (req.query.q || '').trim();
    const status = (req.query.status || '').trim();
    const scope = (req.query.scope || '').trim();
    const keyMode = (req.query.key_mode || '').trim();
    const tagId = req.query.tag_id != null && req.query.tag_id !== ''
      ? parseInt(req.query.tag_id, 10)
      : null;

    const whereParts = [];
    const params = [];
    let idx = 1;

    if (q) {
      const fields = [`p.name ILIKE $${idx}`, `COALESCE(p.base_url,'') ILIKE $${idx}`];
      if (hasNotes) fields.push(`COALESCE(p.notes,'') ILIKE $${idx}`);
      if (hasCreatedBy) fields.push(`COALESCE(u.username,'') ILIKE $${idx}`);
      whereParts.push(`(${fields.join(' OR ')})`);
      params.push(`%${q}%`);
      idx++;
    }
    if (status === 'enabled') {
      whereParts.push('p.enabled = TRUE');
    } else if (status === 'disabled') {
      whereParts.push('p.enabled = FALSE');
    }
    if (hasCreatedBy) {
      if (scope === 'global') whereParts.push('p.created_by IS NULL');
      else if (scope === 'user') whereParts.push('p.created_by IS NOT NULL');
    }
    if (keyMode === 'script') {
      whereParts.push(`COALESCE(p.key_mode, 'fixed') = 'script'`);
    } else if (keyMode === 'fixed') {
      whereParts.push(`COALESCE(p.key_mode, 'fixed') <> 'script'`);
    }
    if (Number.isFinite(tagId) && tagId > 0) {
      whereParts.push(
        `EXISTS (SELECT 1 FROM provider_tag_assignments pta WHERE pta.provider_id = p.id AND pta.tag_id = $${idx})`
      );
      params.push(tagId);
      idx++;
    }

    const where = whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : '';

    // 批量查询供应商标签
    const loadTags = async (providerIds) => {
      const tagMap = {};
      if (!providerIds.length) return tagMap;
      try {
        const tagsResult = await pool.query(`
          SELECT pta.provider_id, pt.id, pt.name, pt.color
          FROM provider_tag_assignments pta
          JOIN provider_tags pt ON pta.tag_id = pt.id
          WHERE pta.provider_id = ANY($1)
        `, [providerIds]);
        for (const row of tagsResult.rows) {
          if (!tagMap[row.provider_id]) tagMap[row.provider_id] = [];
          tagMap[row.provider_id].push({ id: row.id, name: row.name, color: row.color });
        }
      } catch (_) { /* 供应商标签表可能尚未创建 */ }
      return tagMap;
    };

    // 列表脱敏：不返回完整 api_key / api_keys，仅标记是否已配置与数量
    const maskProvider = (r, tagMap) => {
      const { api_key, api_keys, ark_secret_key, ...rest } = r;
      const keyCount = countProviderApiKeys(r);
      return {
        ...rest,
        has_api_key: keyCount > 0,
        api_key_count: keyCount,
        has_ark_secret_key: !!ark_secret_key,
        api_key_select_mode: getApiKeySelectMode(r),
        tags: tagMap[r.id] || []
      };
    };

    // 全库统计（不受列表筛选影响，供顶部卡片）
    const loadStats = async () => {
      try {
        if (hasCreatedBy) {
          const r = await pool.query(`
            SELECT
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_by IS NULL)::int AS global_count,
              COUNT(*) FILTER (WHERE created_by IS NOT NULL)::int AS user_count,
              COUNT(*) FILTER (WHERE enabled)::int AS enabled_count,
              COUNT(*) FILTER (WHERE COALESCE(key_mode, 'fixed') = 'script')::int AS script_count
            FROM providers
          `);
          const s = r.rows[0] || {};
          return {
            total: s.total || 0,
            globalCount: s.global_count || 0,
            userCount: s.user_count || 0,
            enabledCount: s.enabled_count || 0,
            scriptCount: s.script_count || 0
          };
        }
        const r = await pool.query(`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE enabled)::int AS enabled_count,
            COUNT(*) FILTER (WHERE COALESCE(key_mode, 'fixed') = 'script')::int AS script_count
          FROM providers
        `);
        const s = r.rows[0] || {};
        return {
          total: s.total || 0,
          globalCount: s.total || 0,
          userCount: 0,
          enabledCount: s.enabled_count || 0,
          scriptCount: s.script_count || 0
        };
      } catch (err) {
        Logger.warn(`[供应商列表] 统计失败: ${err.message}`);
        return { total: 0, globalCount: 0, userCount: 0, enabledCount: 0, scriptCount: 0 };
      }
    };

    // 无 page 参数时保持旧行为（全量数组），兼容导出/脚本等场景
    if (req.query.page === undefined) {
      const result = await pool.query(`${selectSql} ${where} ${orderSql}`, params);
      const tagMap = await loadTags(result.rows.map(r => r.id));
      return res.json(result.rows.map(r => maskProvider(r, tagMap)));
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count ${fromSql} ${where}`,
      params
    );
    const total = countResult.rows[0].count;
    const stats = await loadStats();

    const listParams = [...params, limit, offset];
    const limIdx = params.length + 1;
    const offIdx = params.length + 2;
    const result = await pool.query(
      `${selectSql} ${where} ${orderSql} LIMIT $${limIdx} OFFSET $${offIdx}`,
      listParams
    );
    const tagMap = await loadTags(result.rows.map(r => r.id));
    res.json({
      items: result.rows.map(r => maskProvider(r, tagMap)),
      total,
      page,
      limit,
      stats
    });
  } catch (error) {
    Logger.error('[获取供应商列表] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取 models.dev 供应商索引（用于向导式添加）
router.get('/providers/lookup-index', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [index, existingResult] = await Promise.all([
      fetchProvidersIndex(),
      pool.query('SELECT id FROM providers')
    ]);
    const existingIds = new Set(existingResult.rows.map(r => r.id));
    const providers = Object.entries(index).map(([id, entry]) => ({
      id: entry.id || id,
      name: entry.name || id,
      base_url: entry.api || '',
      format: (entry.npm && entry.npm.includes('anthropic')) ? 'anthropic' : 'openai'
    })).filter(p => p.base_url); // 过滤掉没有 API 地址的供应商
    providers.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ providers, existingIds: [...existingIds] });
  } catch (error) {
    Logger.error('[获取供应商索引] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 确保 key_mode 列存在（兼容迁移未完成的情况）
let _keyModeColumnExists = null;
async function ensureKeyModeColumn() {
  if (_keyModeColumnExists === true) return;
  try {
    const col = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'providers' AND column_name = 'key_mode'`
    );
    if (col.rows.length === 0) {
      await pool.query(`ALTER TABLE providers ADD COLUMN key_mode VARCHAR(20) DEFAULT 'fixed'`);
      await pool.query(`ALTER TABLE providers ADD COLUMN key_script TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE providers ADD COLUMN key_refresh_interval INTEGER DEFAULT 3600`);
      Logger.info('[供应商保存] 已自动添加 key_mode/key_script/key_refresh_interval 列');
    }
    _keyModeColumnExists = true;
  } catch (err) {
    Logger.warn(`[供应商保存] 检查 key_mode 列失败: ${err.message}`);
  }
}

// 创建/更新供应商
router.post('/providers', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_PROVIDER_CREATE, {
  resourceType: 'provider',
  resourceIdFrom: (req, res) => res._logBody?.id,
  descriptionFrom: (req) => `创建供应商「${req.body?.name || '-'}」`,
}), async (req, res) => {
  const { id, name, base_url, api_key, api_keys, api_key_select_mode, format, enabled, grp, models_url, quota_enabled, quota_mode, notes,
          key_mode, key_script, key_refresh_interval, proxy_enabled, proxy_mode, proxy_url, proxy_use_system,
          content_type_mode, forward_headers, test_user_agent, quota_schedule_enabled, quota_schedule_interval,
          ark_access_key, ark_secret_key, ark_region, ark_service, ark_usage_action, ark_usage_params } = req.body;
  if (!name || !base_url) {
    return res.status(400).json({ error: '供应商名称和URL不能为空' });
  }
  try {
    // 确保 key_mode 列存在（兼容迁移未完成的情况）
    await ensureKeyModeColumn();
    try {
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS api_keys JSONB DEFAULT NULL`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS api_key_select_mode VARCHAR(20) DEFAULT 'order'`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS proxy_mode VARCHAR(20) DEFAULT 'pool'`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS proxy_url TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS proxy_use_system BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_mode VARCHAR(32) DEFAULT 'script'`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS ark_access_key TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS ark_secret_key TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS ark_region VARCHAR(64) DEFAULT 'cn-north-1'`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS ark_service VARCHAR(64) DEFAULT 'ark'`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS ark_usage_action VARCHAR(64) DEFAULT 'GetInferenceUsage'`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS ark_usage_params JSONB DEFAULT '{}'::jsonb`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS test_user_agent TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_schedule_enabled BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_schedule_interval INTEGER DEFAULT 3600`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_last_checked_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_last_ok BOOLEAN`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_last_result JSONB`);
      await pool.query(`ALTER TABLE providers ADD COLUMN IF NOT EXISTS quota_last_error TEXT`);
    } catch (_) { /* 迁移可能已完成 */ }

    // 有 id → 更新已有供应商；无 id → 生成随机 id 创建新供应商
    const providerId = id || crypto.randomUUID();
    const keyMode = key_mode || 'fixed';
    const keyScript = key_mode === 'script' ? (key_script || '') : '';
    const keyRefreshInterval = parseInt(key_refresh_interval) || 3600;
    const selectMode = String(api_key_select_mode || 'order').toLowerCase() === 'weight' ? 'weight' : 'order';
    const finalProxyMode = String(proxy_mode || 'pool').toLowerCase() === 'single' ? 'single' : 'pool';
    const finalProxyUrl = typeof proxy_url === 'string' ? proxy_url.trim() : '';
    const finalProxyUseSystem = proxy_use_system === true || proxy_use_system === 'true';
    const normalizedQuotaMode = String(quota_mode || 'script').toLowerCase();
    const finalQuotaMode = ['opencode_go', 'codex_wham', 'grok_billing', 'ark_inference', 'ark_afp'].includes(normalizedQuotaMode) ? normalizedQuotaMode : 'script';
    const testUaProvided = Object.prototype.hasOwnProperty.call(req.body, 'test_user_agent');
    const finalTestUserAgent = normalizeTestUserAgent(test_user_agent);
    const scheduleProvided = Object.prototype.hasOwnProperty.call(req.body, 'quota_schedule_enabled')
      || Object.prototype.hasOwnProperty.call(req.body, 'quota_schedule_interval');
    const finalScheduleEnabled = quota_schedule_enabled === true || quota_schedule_enabled === 'true';
    const finalScheduleInterval = normalizeQuotaScheduleInterval(quota_schedule_interval);

    // 多 Key：优先 api_keys 数组；否则单个 api_key
    const keyEntries = normalizeKeysInput(api_keys, api_key);
    const storage = keyEntries ? toStorageFields(keyEntries) : null;

    // 无新 Key 时保留原值
    let existing = null;
    if (!storage && id) {
      const er = await pool.query('SELECT api_key, api_keys FROM providers WHERE id = $1', [id]);
      existing = er.rows[0] || null;
    }
    const encryptedStorage = storage && {
      api_key: encryptSecret(storage.api_key),
      api_keys: storage.api_keys?.map((entry) => ({ ...entry, key: encryptSecret(entry.key) })) || null
    };
    const finalApiKey = encryptedStorage
      ? encryptedStorage.api_key
      : (existing?.api_key || '');
    const finalApiKeys = encryptedStorage
      ? (encryptedStorage.api_keys ? JSON.stringify(encryptedStorage.api_keys) : null)
      : (existing?.api_keys != null ? JSON.stringify(normalizeProviderKeyEntries(existing).map((entry) => ({ ...entry, key: encryptSecret(entry.key) }))) : (finalApiKey ? JSON.stringify([{ key: finalApiKey, weight: 1 }]) : null));

    await pool.query(`
      INSERT INTO providers (id, name, base_url, api_key, api_keys, api_key_select_mode, format, enabled, grp, models_url, quota_enabled, quota_mode, notes,
                             key_mode, key_script, key_refresh_interval, proxy_enabled, proxy_mode, proxy_url, proxy_use_system,
                             content_type_mode, forward_headers, test_user_agent, ark_access_key, ark_secret_key, ark_region, ark_service, ark_usage_action, ark_usage_params,
                             quota_schedule_enabled, quota_schedule_interval)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $31, $32)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        base_url = EXCLUDED.base_url,
        api_key = CASE
          WHEN EXCLUDED.api_key IS NOT NULL AND EXCLUDED.api_key <> '' THEN EXCLUDED.api_key
          ELSE providers.api_key
        END,
        api_keys = CASE
          WHEN EXCLUDED.api_keys IS NOT NULL THEN EXCLUDED.api_keys
          ELSE providers.api_keys
        END,
        api_key_select_mode = EXCLUDED.api_key_select_mode,
        format = EXCLUDED.format,
        enabled = EXCLUDED.enabled,
        grp = EXCLUDED.grp,
        models_url = COALESCE(NULLIF(EXCLUDED.models_url, ''), providers.models_url),
        quota_enabled = EXCLUDED.quota_enabled,
        quota_mode = EXCLUDED.quota_mode,
        notes = EXCLUDED.notes,
        key_mode = EXCLUDED.key_mode,
        key_script = EXCLUDED.key_script,
        key_refresh_interval = EXCLUDED.key_refresh_interval,
        proxy_enabled = EXCLUDED.proxy_enabled,
        proxy_mode = EXCLUDED.proxy_mode,
        proxy_url = EXCLUDED.proxy_url,
        proxy_use_system = EXCLUDED.proxy_use_system,
        content_type_mode = EXCLUDED.content_type_mode,
        forward_headers = EXCLUDED.forward_headers,
        test_user_agent = CASE WHEN $30 THEN EXCLUDED.test_user_agent ELSE providers.test_user_agent END,
        ark_access_key = COALESCE(NULLIF(EXCLUDED.ark_access_key, ''), providers.ark_access_key),
        ark_secret_key = CASE WHEN EXCLUDED.ark_secret_key <> '' THEN EXCLUDED.ark_secret_key ELSE providers.ark_secret_key END,
        ark_region = EXCLUDED.ark_region,
        ark_service = EXCLUDED.ark_service,
        ark_usage_action = EXCLUDED.ark_usage_action,
        ark_usage_params = EXCLUDED.ark_usage_params,
        quota_schedule_enabled = CASE WHEN $33 THEN EXCLUDED.quota_schedule_enabled ELSE providers.quota_schedule_enabled END,
        quota_schedule_interval = CASE WHEN $33 THEN EXCLUDED.quota_schedule_interval ELSE providers.quota_schedule_interval END
    `, [providerId, name, base_url, finalApiKey || '', finalApiKeys, selectMode, format || 'openai', enabled !== false, grp || '',
        models_url || '', quota_enabled === true, finalQuotaMode, notes || '', keyMode, keyScript, keyRefreshInterval,
        proxy_enabled === true, finalProxyMode, finalProxyUrl, finalProxyUseSystem,
        content_type_mode || 'hardcoded', forward_headers !== false, finalTestUserAgent,
        ark_access_key || '', ark_secret_key || '', ark_region || 'cn-north-1', ark_service || 'ark',
        ark_usage_action || (finalQuotaMode === 'ark_afp' ? 'GetAFPUsage' : 'GetInferenceUsage'), ark_usage_params || '{}',
        testUaProvided, finalScheduleEnabled, finalScheduleInterval, scheduleProvided]);

    // 注册/更新密钥刷新计划
    keyRefresher.registerProvider({ id: providerId, key_mode: keyMode, key_refresh_interval: keyRefreshInterval });

    res.json({ success: true, id: providerId });
  } catch (error) {
    Logger.error('[创建/更新供应商] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

/**
 * 彻底删除一批模型及其所有关联引用。
 * @param {import('pg').PoolClient|import('pg').Pool} db
 * @param {string[]} modelIds
 */
async function purgeModelsCompletely(db, modelIds) {
  if (!modelIds || modelIds.length === 0) return 0;

  // 1) Team 关联
  await db.query('DELETE FROM team_models WHERE model_id = ANY($1)', [modelIds]);
  // 2) API Key 模型映射
  await db.query('DELETE FROM api_key_models WHERE model_id = ANY($1)', [modelIds]);
  // 2b) API Key 按 Harness 单独绑定
  await db.query('DELETE FROM api_key_harness_models WHERE model_id = ANY($1)', [modelIds]).catch(() => {});
  // 3) 清空或提升 Key 当前绑定模型（队列中有剩余则升为首选）
  await db.query(
    `UPDATE api_keys ak
     SET current_model_id = (
       SELECT akm.model_id FROM api_key_models akm
       WHERE akm.api_key_id = ak.id
       ORDER BY akm.sort_order ASC, akm.id ASC
       LIMIT 1
     )
     WHERE ak.current_model_id = ANY($1)`,
    [modelIds]
  );
  // 4) 清空 Fusion 相关绑定
  await db.query(
    `UPDATE api_keys SET fusion_judge_model_id = NULL
     WHERE fusion_judge_model_id = ANY($1::text[])`,
    [modelIds]
  );
  await db.query(
    `UPDATE api_keys SET fusion_outer_model_id = NULL
     WHERE fusion_outer_model_id = ANY($1::text[])`,
    [modelIds]
  );
  await db.query(
    `UPDATE api_keys
     SET fusion_panel_models = COALESCE((
       SELECT jsonb_agg(elem)
       FROM jsonb_array_elements_text(COALESCE(fusion_panel_models, '[]'::jsonb)) AS elem
       WHERE NOT (elem = ANY($1::text[]))
     ), '[]'::jsonb)
     WHERE fusion_panel_models IS NOT NULL
       AND fusion_panel_models <> '[]'::jsonb
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(fusion_panel_models) e
         WHERE e = ANY($1::text[])
       )`,
    [modelIds]
  );
  // 5) 其它模型上的思考路由引用
  await db.query(
    `UPDATE models SET thinking_model_id = '' WHERE thinking_model_id = ANY($1::text[])`,
    [modelIds]
  );
  await db.query(
    `UPDATE models SET non_thinking_model_id = '' WHERE non_thinking_model_id = ANY($1::text[])`,
    [modelIds]
  );
  // 6) Fusion 配置中的引用
  await db.query(
    `UPDATE fusion_configs SET judge_model_id = '' WHERE judge_model_id = ANY($1::text[])`,
    [modelIds]
  );
  await db.query(
    `UPDATE fusion_configs SET outer_model_id = '' WHERE outer_model_id = ANY($1::text[])`,
    [modelIds]
  );
  await db.query(
    `UPDATE fusion_configs
     SET panel_models = COALESCE((
       SELECT jsonb_agg(elem)
       FROM jsonb_array_elements_text(COALESCE(panel_models, '[]'::jsonb)) AS elem
       WHERE NOT (elem = ANY($1::text[]))
     ), '[]'::jsonb)
     WHERE panel_models IS NOT NULL
       AND panel_models <> '[]'::jsonb
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(panel_models) e
         WHERE e = ANY($1::text[])
       )`,
    [modelIds]
  );
  // 7) 模型测试结果
  try {
    await db.query('DELETE FROM model_test_results WHERE model_id = ANY($1)', [modelIds]);
  } catch (e) {
    Logger.warn(`[purgeModels] 清理 model_test_results 跳过: ${e.message}`);
  }
  // 8) 用量记录：保留历史，仅解除模型外键
  await db.query(
    'UPDATE usage_records SET model_id = NULL WHERE model_id = ANY($1)',
    [modelIds]
  );
  // 9) 删除模型（级联其余 ON DELETE CASCADE 表）
  await db.query('DELETE FROM models WHERE id = ANY($1)', [modelIds]);
  return modelIds.length;
}

// 删除供应商（级联清理该供应商下所有模型及其关联痕迹）
router.delete('/providers/:id', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_PROVIDER_DELETE, {
  resourceType: 'provider',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `删除供应商 #${req.params.id}`,
}), async (req, res) => {
  const providerId = req.params.id;
  const client = await pool.connect();
  try {
    const exists = await client.query('SELECT id, name FROM providers WHERE id = $1', [providerId]);
    if (exists.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }

    await client.query('BEGIN');

    const modelsResult = await client.query(
      'SELECT id FROM models WHERE provider = $1',
      [providerId]
    );
    const modelIds = modelsResult.rows.map(r => r.id);
    const deletedModels = await purgeModelsCompletely(client, modelIds);

    // 用量记录上的供应商引用
    await client.query(
      'UPDATE usage_records SET provider_id = NULL WHERE provider_id = $1',
      [providerId]
    );

    // 供应商本身（标签/模型库排序等表多有 ON DELETE CASCADE）
    await client.query('DELETE FROM providers WHERE id = $1', [providerId]);

    await client.query('COMMIT');

    try { keyRefresher.unregisterProvider(providerId); } catch (_) {}

    Logger.info(
      `[删除供应商] id=${providerId} name=${exists.rows[0].name}, 清理模型 ${deletedModels} 个`
    );
    res.json({ success: true, deletedModels });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    Logger.error('[删除供应商] 错误:', error);
    res.status(500).json({ error: '服务器错误: ' + error.message });
  } finally {
    client.release();
  }
});

/**
 * 清理供应商已不存在的孤立模型（历史数据修复）
 * @returns {Promise<number>} 删除的模型数
 */
async function cleanupOrphanedModels() {
  const result = await pool.query(`
    SELECT m.id FROM models m
    LEFT JOIN providers p ON m.provider = p.id
    WHERE p.id IS NULL
  `);
  const modelIds = result.rows.map(r => r.id);
  if (modelIds.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const n = await purgeModelsCompletely(client, modelIds);
    await client.query('COMMIT');
    return n;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// 手动刷新供应商密钥
router.post('/providers/:id/refresh-key', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureKeyModeColumn();
    // 先检查供应商是否存在及模式
    const check = await pool.query('SELECT id, key_mode, key_script FROM providers WHERE id = $1', [req.params.id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, error: '供应商不存在' });
    }
    const p = check.rows[0];
    Logger.info(`[手动刷新密钥] provider=${p.id}, key_mode=${p.key_mode}, has_script=${!!(p.key_script && p.key_script.trim())}`);

    if (p.key_mode !== 'script') {
      return res.status(400).json({ success: false, error: `供应商当前密钥模式为「${p.key_mode || 'fixed'}」，需先在编辑页面切换为「脚本刷新」模式并保存脚本后再刷新` });
    }
    if (!p.key_script || !p.key_script.trim()) {
      return res.status(400).json({ success: false, error: '密钥脚本为空，请先编辑脚本内容' });
    }

    const result = await keyRefresher.refreshProviderKey(req.params.id);
    if (result.success) {
      res.json({ success: true, expiresAt: result.expiresAt });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (error) {
    Logger.error('[手动刷新密钥] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取所有 script 模式供应商的密钥刷新状态
router.get('/providers/refresh-status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = await keyRefresher.getRefreshStatus();
    res.json(status);
  } catch (error) {
    Logger.error('[获取密钥刷新状态] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取单个供应商详情（含完整 API Keys，仅管理员编辑用）
// 须放在 /providers/refresh-status 等静态路径之后，避免被 :id 吃掉
router.get('/providers/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM providers WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }
    const p = result.rows[0];
    const entries = normalizeProviderKeyEntries(p);
    let tags = [];
    try {
      const tr = await pool.query(
        `SELECT t.id, t.name, t.color FROM provider_tags t
         JOIN provider_tag_assignments m ON m.tag_id = t.id
         WHERE m.provider_id = $1 ORDER BY t.sort_order ASC, t.name`,
        [p.id]
      );
      tags = tr.rows;
    } catch (_) { /* 标签表可能未创建 */ }

    res.json({
      ...p,
      api_keys: entries,
      api_key: entries[0]?.key || p.api_key || '',
      api_key_select_mode: getApiKeySelectMode(p),
      api_key_count: entries.length,
      has_api_key: entries.length > 0,
      tags
    });
  } catch (error) {
    Logger.error('[获取供应商详情] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 切换供应商额度查询开关
router.post('/providers/:id/toggle-quota', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    await pool.query('UPDATE providers SET quota_enabled = $1 WHERE id = $2', [!!enabled, req.params.id]);
    res.json({ success: true, quota_enabled: !!enabled });
  } catch (error) {
    Logger.error('[切换额度查询开关] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 切换供应商启用/禁用
router.post('/providers/:id/toggle-enabled', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_PROVIDER_TOGGLE, {
  resourceType: 'provider',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `切换供应商 #${req.params.id} 启用状态`,
  detailsFrom: (req) => ({ enabled: req.body?.enabled }),
}), async (req, res) => {
  try {
    const { enabled } = req.body;
    await pool.query('UPDATE providers SET enabled = $1 WHERE id = $2', [!!enabled, req.params.id]);
    res.json({ success: true, enabled: !!enabled });
  } catch (error) {
    Logger.error('[切换供应商启用状态] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 检测供应商连通性
router.get('/providers/:id/ping', requireAuth, requireAdmin, async (req, res) => {
  try {
    const providerResult = await pool.query('SELECT base_url, api_key, api_keys FROM providers WHERE id = $1', [req.params.id]);
    if (providerResult.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }
    const provider = providerResult.rows[0];
    const baseUrl = provider.base_url?.replace(/\/+$/, '');
    if (!baseUrl) {
      return res.json({ ok: false, latency_ms: null, error: '未配置 Base URL' });
    }

    const headers = { 'Content-Type': 'application/json' };
    const primaryKey = getPrimaryApiKey(provider);
    if (primaryKey) {
      headers['Authorization'] = `Bearer ${primaryKey}`;
    }

    // 尝试推断的模型路径，并为无版本 Base URL 保留 /models 回退
    const candidates = [upstreamUrl(baseUrl, '/models')];
    if (!/\/v\d+(?:[a-z]+\d*)?\/?$/i.test(baseUrl)) {
      candidates.push(`${baseUrl}/models`);
    }

    for (const url of candidates) {
      const start = Date.now();
      try {
        const resp = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(5000)
        });
        const latency = Date.now() - start;
        if (resp.ok) {
          return res.json({ ok: true, latency_ms: latency, url });
        }
        // 401/403 也算连通（只是鉴权问题）
        if (resp.status === 401 || resp.status === 403) {
          return res.json({ ok: true, latency_ms: latency, url, note: `HTTP ${resp.status} (鉴权)` });
        }
      } catch (e) {
        // 继续尝试下一个候选 URL
      }
    }

    // 所有候选都失败，用 base_url 做 TCP 连通性测试
    const start = Date.now();
    try {
      const resp = await fetch(baseUrl, {
        headers,
        signal: AbortSignal.timeout(5000),
        redirect: 'follow'
      });
      const latency = Date.now() - start;
      return res.json({ ok: true, latency_ms: latency, url: baseUrl, note: `HTTP ${resp.status}` });
    } catch (e) {
      const latency = Date.now() - start;
      return res.json({ ok: false, latency_ms: latency, error: e.message || '连接失败' });
    }
  } catch (error) {
    Logger.error('[检测连通性] 错误:', error);
    res.status(500).json({ ok: false, latency_ms: null, error: error.message });
  }
});

/**
 * 从上游拉取供应商模型列表（自定义 models_url + 多路径回退）
 * @param {object} provider - providers 表行
 * @returns {Promise<{ ok: true, models: Array<{id,name}>, succeededUrl: string, attempts: any[] }
 *          | { ok: false, error: string, status?: number, attempts?: any[] }>}
 */
async function fetchUpstreamModelsForProvider(provider) {
  const baseUrl = provider.base_url?.replace(/\/+$/, '');
  const customModelsUrl = provider.models_url?.replace(/\/+$/, '') || '';
  // 获取模型列表：仅使用主 Key（多 Key 列表第一项）
  const apiKey = getPrimaryApiKey(provider);

  if (!baseUrl) {
    return { ok: false, error: '供应商未配置 Base URL', status: 400 };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const candidateUrls = [];
  if (customModelsUrl) {
    candidateUrls.push(
      customModelsUrl.startsWith('http')
        ? customModelsUrl
        : `${baseUrl}${customModelsUrl.startsWith('/') ? '' : '/'}${customModelsUrl}`
    );
  }

  const cleanBaseUrl = baseUrl
    .replace(/\/(chat\/completions|completions|messages|responses|embeddings)\/?$/, '')
    .replace(/\/+$/, '');

  candidateUrls.push(upstreamUrl(cleanBaseUrl, '/models'));
  if (!/\/v\d+(?:[a-z]+\d*)?\/?$/i.test(cleanBaseUrl)) {
    candidateUrls.push(`${cleanBaseUrl}/models`);
  }
  const uniqueUrls = [...new Set(candidateUrls)];

  const attempts = [];
  for (const modelsUrl of uniqueUrls) {
    const urlCheck = await validateUrl(modelsUrl);
    if (!urlCheck.ok) {
      Logger.warn(`[获取供应商模型] SSRF 拦截: ${modelsUrl} - ${urlCheck.error}`);
      continue;
    }

    Logger.info(`[获取供应商模型] 尝试: ${modelsUrl}`);
    const attempt = { url: modelsUrl };
    try {
      const response = await fetch(modelsUrl, {
        headers,
        signal: AbortSignal.timeout(15000)
      });
      attempt.status = response.status;
      attempt.contentType = response.headers.get('content-type') || '';

      const text = await response.text();
      attempt.bodyPreview = text.substring(0, 500);

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        attempt.error = '非 JSON 响应';
        attempts.push(attempt);
        Logger.warn(`[获取供应商模型] ${modelsUrl} 返回非 JSON`);
        continue;
      }

      if (!response.ok) {
        const msg = data.error?.message || data.message || JSON.stringify(data.error || data);
        attempt.error = `HTTP ${response.status}: ${msg}`;
        attempts.push(attempt);
        Logger.warn(`[获取供应商模型] ${modelsUrl} 返回 ${response.status}`);
        continue;
      }

      const models = (data.data || data.models || []).map(m => ({
        id: m.id,
        name: m.name || m.id
      }));

      attempt.success = true;
      attempt.modelCount = models.length;
      attempts.push(attempt);

      Logger.info(`[获取供应商模型] 成功: ${modelsUrl}, ${models.length} 个模型`);
      return { ok: true, models, succeededUrl: modelsUrl, attempts };
    } catch (fetchError) {
      attempt.error = fetchError.message;
      attempts.push(attempt);
      Logger.warn(`[获取供应商模型] ${modelsUrl} 请求失败: ${fetchError.message}`);
    }
  }

  const errorMsg = attempts.map(a => `${a.url}: ${a.error || a.status}`).join('; ');
  Logger.error(`[获取供应商模型] 所有路径失败: ${errorMsg}`);
  return { ok: false, error: '所有模型列表路径均失败', status: 502, attempts };
}

/**
 * 查询某供应商本地模型，并与上游 ID 集合对比，得到已下架模型列表
 * @param {string} providerId
 * @param {Set<string>|string[]} upstreamIds
 */
async function findStaleModelsForProvider(providerId, upstreamIds) {
  const upstreamSet = upstreamIds instanceof Set
    ? upstreamIds
    : new Set((upstreamIds || []).map(String));
  const existingResult = await pool.query(
    'SELECT id, name, upstream_model_id, enabled FROM models WHERE provider = $1',
    [providerId]
  );
  const existingById = new Map();
  existingResult.rows.forEach(r => {
    const key = r.upstream_model_id || r.id;
    existingById.set(key, { systemId: r.id, enabled: r.enabled });
  });
  const existingModels = existingResult.rows.map(r => ({
    id: r.upstream_model_id || r.id,
    name: r.name || r.upstream_model_id || r.id,
    systemId: r.id,
    enabled: r.enabled
  }));
  const staleModels = existingModels.filter(m => !upstreamSet.has(m.id));
  return {
    existingById,
    existingModels,
    existingIds: [...existingById.keys()],
    staleModels
  };
}

// 获取供应商模型列表（支持自定义 models_url 和多路径回退）
router.get('/providers/:id/fetch-models', requireAuth, requireAdmin, async (req, res) => {
  try {
    const providerResult = await pool.query('SELECT * FROM providers WHERE id = $1', [req.params.id]);
    if (providerResult.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }
    const provider = providerResult.rows[0];
    const fetchResult = await fetchUpstreamModelsForProvider(provider);
    if (!fetchResult.ok) {
      return res.status(fetchResult.status || 502).json({
        error: fetchResult.error,
        debug: { attempts: fetchResult.attempts || [] }
      });
    }

    const models = fetchResult.models;
    const { existingById, existingModels, existingIds } = await findStaleModelsForProvider(
      req.params.id,
      models.map(m => m.id)
    );

    Logger.info(
      `[获取供应商模型] 供应商 ${provider.name}: 上游 ${models.length} 个, 已添加 ${existingIds.length} 个`
    );
    return res.json({
      models,
      existingIds,
      existingModels,
      existingById: Object.fromEntries(existingById),
      provider_name: provider.name,
      debug: { attempts: fetchResult.attempts, succeededUrl: fetchResult.succeededUrl }
    });
  } catch (error) {
    Logger.error('[获取供应商模型] 错误:', error);
    res.status(500).json({ error: '获取模型列表失败: ' + error.message });
  }
});

/**
 * 清理单个供应商的已下架模型（本地有、上游列表无）
 * 必须先成功拉取上游列表，避免网络失败时误删全部模型
 */
router.post('/providers/:id/cleanup-stale-models', requireAuth, requireAdmin, async (req, res) => {
  const providerId = req.params.id;
  try {
    const providerResult = await pool.query('SELECT * FROM providers WHERE id = $1', [providerId]);
    if (providerResult.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }
    const provider = providerResult.rows[0];

    // 可选：前端已识别的 systemId 列表；若提供则只删这些，且仍校验属于本供应商
    const requestedIds = Array.isArray(req.body?.modelIds)
      ? [...new Set(req.body.modelIds.map(String).filter(Boolean))]
      : null;

    const fetchResult = await fetchUpstreamModelsForProvider(provider);
    if (!fetchResult.ok) {
      return res.status(fetchResult.status || 502).json({
        error: `无法拉取上游模型列表，已取消清理: ${fetchResult.error}`,
        debug: { attempts: fetchResult.attempts || [] }
      });
    }

    const { staleModels } = await findStaleModelsForProvider(
      providerId,
      fetchResult.models.map(m => m.id)
    );
    let toDelete = staleModels.map(m => m.systemId);
    if (requestedIds) {
      const staleSet = new Set(toDelete);
      toDelete = requestedIds.filter(id => staleSet.has(id));
    }

    if (toDelete.length === 0) {
      return res.json({
        success: true,
        deleted: 0,
        provider_id: providerId,
        provider_name: provider.name,
        upstreamCount: fetchResult.models.length,
        message: '没有可清理的已下架模型'
      });
    }

    await purgeModelsCompletely(pool, toDelete);
    Logger.info(
      `[清理已下架] 供应商 ${provider.name}(${providerId}): 删除 ${toDelete.length} 个, 上游 ${fetchResult.models.length} 个`
    );
    res.json({
      success: true,
      deleted: toDelete.length,
      deletedIds: toDelete,
      provider_id: providerId,
      provider_name: provider.name,
      upstreamCount: fetchResult.models.length
    });
  } catch (error) {
    Logger.error('[清理已下架] 错误:', error);
    res.status(500).json({ error: '清理失败: ' + error.message });
  }
});

/**
 * 清理所有供应商的已下架模型：逐个拉取上游列表后对比删除
 * 拉取失败的供应商会跳过（不误删）
 */
router.post('/providers/cleanup-stale-models', requireAuth, requireAdmin, async (req, res) => {
  try {
    const providersResult = await pool.query(
      'SELECT * FROM providers ORDER BY name NULLS LAST, id'
    );
    const providers = providersResult.rows;
    let totalDeleted = 0;
    let successProviders = 0;
    let skippedProviders = 0;
    const details = [];

    for (const provider of providers) {
      const fetchResult = await fetchUpstreamModelsForProvider(provider);
      if (!fetchResult.ok) {
        skippedProviders++;
        details.push({
          provider_id: provider.id,
          provider_name: provider.name,
          ok: false,
          error: fetchResult.error,
          deleted: 0
        });
        continue;
      }

      const { staleModels } = await findStaleModelsForProvider(
        provider.id,
        fetchResult.models.map(m => m.id)
      );
      const toDelete = staleModels.map(m => m.systemId);
      if (toDelete.length > 0) {
        await purgeModelsCompletely(pool, toDelete);
      }
      totalDeleted += toDelete.length;
      successProviders++;
      details.push({
        provider_id: provider.id,
        provider_name: provider.name,
        ok: true,
        deleted: toDelete.length,
        upstreamCount: fetchResult.models.length,
        staleCount: staleModels.length
      });
    }

    Logger.info(
      `[清理全部已下架] 供应商 ${providers.length} 个, 成功 ${successProviders}, 跳过 ${skippedProviders}, 删除模型 ${totalDeleted}`
    );
    res.json({
      success: true,
      deleted: totalDeleted,
      providerCount: providers.length,
      successProviders,
      skippedProviders,
      details
    });
  } catch (error) {
    Logger.error('[清理全部已下架] 错误:', error);
    res.status(500).json({ error: '清理失败: ' + error.message });
  }
});

// 同步供应商模型（一键保存启用/禁用状态）
router.post('/providers/:id/sync-models', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_PROVIDER_SYNC, {
  resourceType: 'provider',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `同步供应商 #${req.params.id} 模型`,
}), async (req, res) => {
  const { enabledModelIds } = req.body;
  if (!Array.isArray(enabledModelIds)) {
    return res.status(400).json({ error: '参数错误：enabledModelIds 必须是数组' });
  }
  try {
    const providerResult = await pool.query('SELECT id, name FROM providers WHERE id = $1', [req.params.id]);
    if (providerResult.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }
    const providerId = req.params.id;

    // 查询当前已添加的模型
    const existingResult = await pool.query(
      'SELECT id, upstream_model_id, enabled FROM models WHERE provider = $1',
      [providerId]
    );
    const existingByUpstream = new Map();
    existingResult.rows.forEach(r => {
      const key = r.upstream_model_id || r.id;
      existingByUpstream.set(key, { systemId: r.id, enabled: r.enabled });
    });

    let added = 0;
    let enabled = 0;
    let disabled = 0;
    // 需要挂载到前沿 Team 的模型（新建 + 重新启用）
    const frontierCandidateIds = [];

    for (const modelId of enabledModelIds) {
      const existing = existingByUpstream.get(modelId);
      if (existing) {
        // 已存在但被禁用 → 启用（禁用时会删 team_models，需重新挂前沿）
        if (!existing.enabled) {
          await pool.query('UPDATE models SET enabled = TRUE WHERE id = $1', [existing.systemId]);
          frontierCandidateIds.push(existing.systemId);
          enabled++;
        }
      } else {
        // 不存在 → 新建并启用
        const uuid = crypto.randomUUID();
        await pool.query(
          `INSERT INTO models (id, name, provider, enabled, upstream_model_id)
           VALUES ($1, $2, $3, TRUE, $4)`,
          [uuid, modelId, providerId, modelId]
        );
        frontierCandidateIds.push(uuid);
        added++;
      }
    }

    // 已存在但不在启用列表中的 → 彻底清理关联并禁用
    for (const [upstreamId, existing] of existingByUpstream) {
      if (!enabledModelIds.includes(upstreamId) && existing.enabled) {
        const modelUuid = existing.systemId;
        // 1) 删除 Team 关联（team_models 有 ON DELETE CASCADE 但显式删更安全）
        await pool.query('DELETE FROM team_models WHERE model_id = $1', [modelUuid]);
        // 2) 删除 API Key 模型映射
        await pool.query('DELETE FROM api_key_models WHERE model_id = $1', [modelUuid]);
        // 2b) 删除 Harness 单独绑定
        await pool.query('DELETE FROM api_key_harness_models WHERE model_id = $1', [modelUuid]).catch(() => {});
        // 3) 清空或提升 API Key 的 current_model_id（队列有剩余则升为首选）
        await pool.query(
          `UPDATE api_keys ak
           SET current_model_id = (
             SELECT akm.model_id FROM api_key_models akm
             WHERE akm.api_key_id = ak.id
             ORDER BY akm.sort_order ASC, akm.id ASC
             LIMIT 1
           )
           WHERE ak.current_model_id = $1`,
          [modelUuid]
        );
        // 4) 禁用模型
        await pool.query('UPDATE models SET enabled = FALSE WHERE id = $1', [modelUuid]);
        disabled++;
      }
    }

    // 新模型 / 重新启用的模型 → 自动挂载前沿 Team
    if (frontierCandidateIds.length > 0) {
      try {
        await addModelsToFrontierTeams(frontierCandidateIds);
      } catch (e) {
        Logger.warn('[同步模型] 自动添加到前沿Team失败:', e.message);
      }
    }

    Logger.info(`[同步模型] 供应商 ${providerId}: 新增 ${added}, 启用 ${enabled}, 禁用 ${disabled}`);
    res.json({ success: true, added, enabled, disabled });
  } catch (error) {
    Logger.error('[同步模型] 错误:', error);
    res.status(500).json({ error: '同步失败: ' + error.message });
  }
});

// 获取供应商默认额度查询脚本
router.get('/providers/:id/default-quota-script', requireAuth, requireAdmin, async (req, res) => {
  try {
    const providerResult = await pool.query('SELECT * FROM providers WHERE id = $1', [req.params.id]);
    if (providerResult.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }
    const provider = providerResult.rows[0];
    const script = generateDefaultQuotaScript(provider);
    res.json({ script });
  } catch (error) {
    Logger.error('[获取默认脚本] 错误:', error);
    res.status(500).json({ error: '获取默认脚本失败' });
  }
});

// 保存供应商额度查询脚本
router.post('/providers/:id/quota-script', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { script } = req.body;
    // 验证脚本格式
    if (script && script.trim()) {
      try {
        const parsed = JSON.parse(script);
        if (!parsed.request || !parsed.extractor) {
          return res.status(400).json({ error: '脚本必须包含 request 和 extractor 字段' });
        }
      } catch (e) {
        return res.status(400).json({ error: '脚本格式错误: ' + e.message });
      }
    }
    await pool.query('UPDATE providers SET quota_script = $1 WHERE id = $2', [script || '', req.params.id]);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[保存额度脚本] 错误:', error);
    res.status(500).json({ error: '保存脚本失败' });
  }
});

// 查询供应商额度（执行脚本）
router.get('/providers/:id/check-quota', requireAuth, requireAdmin, async (req, res) => {
  try {
    const providerResult = await pool.query('SELECT * FROM providers WHERE id = $1', [req.params.id]);
    if (providerResult.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }
    const provider = providerResult.rows[0];
    const result = await queryProviderQuota(provider);
    await saveQuotaSnapshot(provider.id, result);
    if (!result.ok) {
      return res.status(result.status || 502).json({
        error: result.error || '查询失败',
        provider: result.provider || { id: provider.id, name: provider.name }
      });
    }
    res.json({
      success: true,
      provider: result.provider,
      quota: result.quota
    });
  } catch (error) {
    Logger.error('[查询供应商额度] 错误:', error);
    res.status(500).json({ error: '查询额度失败: ' + error.message });
  }
});

// ========== 代理池管理 API ==========

// 更新供应商代理配置
router.post('/providers/:id/proxy-pool', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { proxy_enabled, proxy_pool, proxy_subscription_url, proxy_mode, proxy_url, proxy_use_system } = req.body;

    const providerResult = await pool.query('SELECT * FROM providers WHERE id = $1', [req.params.id]);
    if (providerResult.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }

    const updates = [];
    const values = [];
    let paramIdx = 1;

    if (proxy_enabled !== undefined) {
      updates.push(`proxy_enabled = $${paramIdx++}`);
      values.push(proxy_enabled);
    }
    if (proxy_pool !== undefined) {
      updates.push(`proxy_pool = $${paramIdx++}`);
      values.push(JSON.stringify(proxy_pool));
    }
    if (proxy_subscription_url !== undefined) {
      updates.push(`proxy_subscription_url = $${paramIdx++}`);
      values.push(proxy_subscription_url);
    }
    if (proxy_mode !== undefined) {
      updates.push(`proxy_mode = $${paramIdx++}`);
      values.push(String(proxy_mode).toLowerCase() === 'single' ? 'single' : 'pool');
    }
    if (proxy_url !== undefined) {
      updates.push(`proxy_url = $${paramIdx++}`);
      values.push(typeof proxy_url === 'string' ? proxy_url.trim() : '');
    }
    if (proxy_use_system !== undefined) {
      updates.push(`proxy_use_system = $${paramIdx++}`);
      values.push(proxy_use_system === true || proxy_use_system === 'true');
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: '没有要更新的字段' });
    }

    values.push(req.params.id);
    await pool.query(
      `UPDATE providers SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      values
    );

    Logger.info(`[ProxyPool] 供应商 ${req.params.id} 代理配置已更新`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[ProxyPool] 更新代理配置失败:', error);
    res.status(500).json({ error: '更新失败: ' + error.message });
  }
});

// 添加代理到供应商代理池
router.post('/providers/:id/proxy-pool/add', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: '请提供代理 URL' });
    }

    const providerResult = await pool.query('SELECT proxy_pool FROM providers WHERE id = $1', [req.params.id]);
    if (providerResult.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }

    const proxies = proxyPool.parseProxyPool(providerResult.rows[0].proxy_pool);
    const newProxy = proxyPool.createProxyEntry(url);
    proxies.push(newProxy);

    await pool.query('UPDATE providers SET proxy_pool = $1 WHERE id = $2', [JSON.stringify(proxies), req.params.id]);

    Logger.info(`[ProxyPool] 已添加代理到供应商 ${req.params.id}: ${url}`);
    res.json({ success: true, proxy: newProxy });
  } catch (error) {
    Logger.error('[ProxyPool] 添加代理失败:', error);
    res.status(500).json({ error: '添加失败: ' + error.message });
  }
});

// 从供应商代理池删除代理
router.delete('/providers/:id/proxy-pool/:proxyId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const providerResult = await pool.query('SELECT proxy_pool FROM providers WHERE id = $1', [req.params.id]);
    if (providerResult.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }

    const proxies = proxyPool.parseProxyPool(providerResult.rows[0].proxy_pool);
    const filtered = proxies.filter(p => p.id !== req.params.proxyId);

    if (filtered.length === proxies.length) {
      return res.status(404).json({ error: '代理不存在' });
    }

    await pool.query('UPDATE providers SET proxy_pool = $1 WHERE id = $2', [JSON.stringify(filtered), req.params.id]);

    Logger.info(`[ProxyPool] 已从供应商 ${req.params.id} 删除代理 ${req.params.proxyId}`);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[ProxyPool] 删除代理失败:', error);
    res.status(500).json({ error: '删除失败: ' + error.message });
  }
});

// 切换代理启用状态
router.put('/providers/:id/proxy-pool/:proxyId/toggle', requireAuth, requireAdmin, async (req, res) => {
  try {
    const providerResult = await pool.query('SELECT proxy_pool FROM providers WHERE id = $1', [req.params.id]);
    if (providerResult.rows.length === 0) {
      return res.status(404).json({ error: '供应商不存在' });
    }

    const proxies = proxyPool.parseProxyPool(providerResult.rows[0].proxy_pool);
    const proxy = proxies.find(p => p.id === req.params.proxyId);
    if (!proxy) {
      return res.status(404).json({ error: '代理不存在' });
    }

    proxy.enabled = !proxy.enabled;
    await pool.query('UPDATE providers SET proxy_pool = $1 WHERE id = $2', [JSON.stringify(proxies), req.params.id]);

    res.json({ success: true, enabled: proxy.enabled });
  } catch (error) {
    Logger.error('[ProxyPool] 切换代理状态失败:', error);
    res.status(500).json({ error: '操作失败: ' + error.message });
  }
});

// 从 URL 导入代理列表
router.post('/fetch-proxies-url', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: '请提供代理列表 URL' });
    }

    // SSRF 防护：校验 URL（管理员允许内网地址）
    const urlCheck = await validateUrl(url, { allowPrivate: true });
    if (!urlCheck.ok) {
      return res.status(400).json({ error: `URL 校验失败: ${urlCheck.error}` });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(502).json({ error: '获取失败: HTTP ' + response.status });
    }

    // 限制响应体最大 1MB，防止读入过大内容导致内存/性能问题
    const MAX_BODY_BYTES = 1024 * 1024;
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      return res.status(413).json({ error: `文件过大 (${(contentLength / 1024 / 1024).toFixed(1)}MB)，最大支持 1MB` });
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reader.cancel();
        return res.status(413).json({ error: '文件过大，最大支持 1MB' });
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));

    const MAX_PROXIES = 5000;
    const proxies = text.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && l.match(/^(https?|socks[45]?h?):\/\//i))
      .slice(0, MAX_PROXIES);

    res.json({ success: true, proxies, count: proxies.length });
  } catch (error) {
    Logger.error('[ProxyPool] 获取代理列表失败:', error);
    res.status(500).json({ error: '获取失败: ' + error.message });
  }
});

// 获取系统设置
router.get('/settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM settings');
    const settings = {};
    result.rows.forEach(row => {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch {
        settings[row.key] = row.value;
      }
    });
    settings.autoAddNewModelsToFrontier = settings.autoAddNewModelsToFrontier === true;
    // 敏感配置脱敏：飞书密钥勿经通用设置接口泄露
    if (settings.feishu_login && typeof settings.feishu_login === 'object') {
      settings.feishu_login = {
        ...settings.feishu_login,
        appSecret: settings.feishu_login.appSecret ? MASKED_SECRET : '',
        hasAppSecret: !!settings.feishu_login.appSecret,
      };
    }
    res.json(settings);
  } catch (error) {
    Logger.error('[获取系统设置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 统计上报开关更新后立即失效缓存，避免 60s TTL 延迟
function invalidateStatsReporter(keys) {
  const list = typeof keys === 'string' ? [keys] : keys;
  if (list && list.some(k => k === 'stats_report_enabled')) {
    try {
      require('../utils/stats-reporter').invalidateEnabledCache();
    } catch { /* 上报模块可选 */ }
  }
}

// 更新系统设置（支持单个或批量）
router.put('/settings', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_SETTINGS, {
  resourceType: 'system',
  descriptionFrom: (req) => '更新系统设置',
}), async (req, res) => {
  const body = req.body;
  try {
    // 批量更新：body 是 { key1: value1, key2: value2, ... }
    if (typeof body === 'object' && !body.key && !body.value) {
      const entries = Object.entries(body);
      if (entries.length === 0) {
        return res.status(400).json({ error: '设置不能为空' });
      }
      for (const [key, value] of entries) {
        if (key === 'autoAddNewModelsToFrontier' && typeof value !== 'boolean') {
          return res.status(400).json({ error: 'autoAddNewModelsToFrontier 必须是布尔值' });
        }
        // model_list 校验：必须保留至少一个非 fusion 模型（除非只配了 fusion）
        if (key === 'model_list' && Array.isArray(value)) {
          const nonFusionModels = value.filter(m => m !== 'fusion');
          if (value.length > 0 && nonFusionModels.length === 0) {
            return res.status(400).json({ error: '必须保留至少一个非 fusion 的模型 ID，否则将无法使用正常模型' });
          }
        }
        await pool.query(
          'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
          [key, JSON.stringify(value)]
        );
      }
      invalidateStatsReporter(entries.map(e => e[0]));
      return res.json({ success: true });
    }

    // 单个更新：body 是 { key: 'xxx', value: 'yyy' }
    const { key, value } = body;
    if (!key) {
      return res.status(400).json({ error: '设置键不能为空' });
    }
    if (key === 'autoAddNewModelsToFrontier' && typeof value !== 'boolean') {
      return res.status(400).json({ error: 'autoAddNewModelsToFrontier 必须是布尔值' });
    }
    // model_list 校验：必须保留至少一个非 fusion 模型（除非只配了 fusion）
    if (key === 'model_list' && Array.isArray(value)) {
      const nonFusionModels = value.filter(m => m !== 'fusion');
      if (value.length > 0 && nonFusionModels.length === 0) {
        return res.status(400).json({ error: '必须保留至少一个非 fusion 的模型 ID，否则将无法使用正常模型' });
      }
    }
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, JSON.stringify(value)]
    );
    invalidateStatsReporter(key);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[更新系统设置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ========== 数据保留配置与任务 ==========

const RETENTION_LIMITS = {
  compressDays: 3650,
  purgeDays: 3650,
  compressSizeGb: 1024,
  purgeSizeGb: 1024,
};

function parseRetentionInt(value, name, max) {
  if (typeof value === 'string' && value.trim() === '') throw new Error(`${name} 必须是非负整数`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${name} 必须是 0 到 ${max} 的整数`);
  return n;
}

function normalizeRetentionPayload(body = {}) {
  const config = {
    compressDays: parseRetentionInt(body.compress_days, 'compress_days', RETENTION_LIMITS.compressDays),
    purgeDays: parseRetentionInt(body.purge_days, 'purge_days', RETENTION_LIMITS.purgeDays),
    compressSizeGb: parseRetentionInt(body.compress_size_gb, 'compress_size_gb', RETENTION_LIMITS.compressSizeGb),
    purgeSizeGb: parseRetentionInt(body.purge_size_gb, 'purge_size_gb', RETENTION_LIMITS.purgeSizeGb),
    aggEnabled: body.agg_enabled === true,
  };
  if (config.compressDays && config.purgeDays && config.compressDays >= config.purgeDays) {
    const error = new Error('compress_days must be less than purge_days when both are non-zero');
    error.code = 'RETENTION_DAYS_ORDER';
    throw error;
  }
  if (config.compressSizeGb && config.purgeSizeGb && config.compressSizeGb >= config.purgeSizeGb) {
    const error = new Error('compress_size_gb must be less than purge_size_gb when both are non-zero');
    error.code = 'RETENTION_SIZE_ORDER';
    throw error;
  }
  return config;
}

router.get('/retention-config', requireAuth, requireAdmin, async (req, res) => {
  try {
    const cfg = await getRetentionConfig({ fresh: true });
    res.json({
      compress_days: cfg.compressDays,
      purge_days: cfg.purgeDays,
      compress_size_gb: cfg.compressSizeGb,
      purge_size_gb: cfg.purgeSizeGb,
      agg_enabled: cfg.aggEnabled,
    });
  } catch (error) {
    Logger.error('[数据保留] 获取配置失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.put('/retention-config', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_SETTINGS, {
  resourceType: 'retention',
  descriptionFrom: () => '更新数据保留配置',
}), async (req, res) => {
  try {
    const cfg = normalizeRetentionPayload(req.body);
    const values = {
      'retention.compress_days': cfg.compressDays,
      'retention.purge_days': cfg.purgeDays,
      'retention.compress_size_gb': cfg.compressSizeGb,
      'retention.purge_size_gb': cfg.purgeSizeGb,
      'retention.agg_enabled': cfg.aggEnabled,
    };
    for (const [key, value] of Object.entries(values)) {
      await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
    }
    invalidateRetentionConfigCache();
    res.json({ success: true, ...req.body });
  } catch (error) {
    res.status(400).json({ code: error.code || 'RETENTION_INVALID_VALUE', error: error.message });
  }
});

function runRetentionTask(task, kind, req, res) {
  const started = retentionRunner.startTask(kind, task, { dryRun: Boolean(req.body?.dry_run) });
  if (started.conflict) return res.status(409).json({ code: 'RETENTION_TASK_BUSY', error: '数据保留任务正在执行' });
  return res.status(202).json({ taskId: started.taskId, status: 'queued' });
}
router.get('/retention/tasks/:taskId', requireAuth, requireAdmin, (req, res) => {
  const task = retentionRunner.getTask(req.params.taskId);
  if (!task) return res.status(404).json({ code: 'RETENTION_TASK_NOT_FOUND', error: '任务不存在' });
  res.json(task);
});
router.post('/retention/run-compress', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_SETTINGS, { resourceType: 'retention', descriptionFrom: () => '立即执行数据压缩' }), (req, res) => runRetentionTask(runCompressOnce, 'compress', req, res));
router.post('/retention/run-purge', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_SETTINGS, { resourceType: 'retention', descriptionFrom: () => '立即执行数据清除' }), (req, res) => runRetentionTask(runPurgeOnce, 'purge', req, res));

// ========== 飞书登录配置 ==========

// 获取飞书登录配置（密钥脱敏）
router.get('/feishu-login', requireAuth, requireAdmin, async (req, res) => {
  try {
    const cfg = await getFeishuConfig();
    const view = toPublicAdminView(cfg);
    Logger.info(
      `[飞书配置] 管理员 ${req.session.user?.username} 读取配置: ` +
      `enabled=${view.enabled}, hasAppId=${!!view.appId}, hasSecret=${view.hasAppSecret}, source=${view.source}`
    );
    res.json(view);
  } catch (error) {
    Logger.error('[飞书配置] 获取失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新飞书登录配置
router.put('/feishu-login', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_FEISHU, {
  resourceType: 'system',
  descriptionFrom: (req) => '更新飞书登录配置',
}), async (req, res) => {
  try {
    const { enabled, appId, appSecret, tenantKey } = req.body || {};
    const wantEnabled = enabled === true;
    const nextAppId = (appId || '').trim();
    const secretProvided = !!(appSecret && appSecret !== MASKED_SECRET);

    if (wantEnabled) {
      if (!nextAppId) {
        return res.status(400).json({ error: '启用飞书登录时必须填写 App ID' });
      }
      const current = await getFeishuConfig();
      if (!secretProvided && !current.appSecret) {
        return res.status(400).json({ error: '启用飞书登录时必须填写 App Secret' });
      }
    }

    const saved = await saveFeishuConfig({
      enabled: wantEnabled,
      appId: nextAppId,
      appSecret: secretProvided ? appSecret : MASKED_SECRET,
      tenantKey: (tenantKey || '').trim(),
    });

    Logger.info(
      `[飞书配置] 管理员 ${req.session.user?.username} 更新飞书登录配置: ` +
      `enabled=${saved.enabled}, appId=${saved.appId ? saved.appId.slice(0, 8) + '…' : '(空)'}, ` +
      `secretUpdated=${secretProvided}, tenantKey=${saved.tenantKey ? '已设置' : '未设置'}`
    );

    res.json({ success: true, ...toPublicAdminView({ ...saved, source: 'settings' }) });
  } catch (error) {
    Logger.error('[飞书配置] 更新失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ========== 兑换码管理 ==========

// 获取兑换码列表
router.get('/redemption-codes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rc.*, u.username AS created_by_name,
              (SELECT COUNT(*) FROM redemption_code_uses rcu WHERE rcu.code_id = rc.id) AS actual_uses
       FROM redemption_codes rc
       LEFT JOIN users u ON u.id = rc.created_by
       ORDER BY rc.created_at DESC`
    );
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取兑换码列表] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建兑换码
router.post('/redemption-codes', requireAuth, requireAdmin, async (req, res) => {
  const { code, amount, max_uses, expires_at, batch_name } = req.body;
  if (!code || !amount) {
    return res.status(400).json({ error: '兑换码和金额不能为空' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO redemption_codes (code, amount, max_uses, expires_at, batch_name, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [code, amount, max_uses || 1, expires_at || null, batch_name || null, req.session.user.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: '兑换码已存在' });
    }
    Logger.error('[创建兑换码] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除兑换码
router.delete('/redemption-codes/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM redemption_codes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[删除兑换码] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量生成兑换码
router.post('/redemption-codes/batch', requireAuth, requireAdmin, async (req, res) => {
  const { count, amount, max_uses, expires_at, batch_name, prefix } = req.body;
  if (!count || !amount) {
    return res.status(400).json({ error: '数量和金额不能为空' });
  }
  try {
    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = prefix
        ? `${prefix}${Math.random().toString(36).slice(2, 8).toUpperCase()}`
        : Math.random().toString(36).slice(2, 10).toUpperCase();
      codes.push(code);
    }

    const values = codes.map((code, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`).join(', ');
    const params = codes.flatMap(code => [code, amount, max_uses || 1, expires_at || null, batch_name || null, req.session.user.id]);

    await pool.query(
      `INSERT INTO redemption_codes (code, amount, max_uses, expires_at, batch_name, created_by) VALUES ${values}`,
      params
    );
    res.json({ success: true, count: codes.length });
  } catch (error) {
    Logger.error('[批量生成兑换码] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 生成兑换码（前端调用的接口）
router.post('/redemption-codes/generate', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_REDEMPTION_CODE, {
  resourceType: 'redemption_code',
  descriptionFrom: (req) => `生成兑换码`,
  detailsFrom: (req) => ({ count: req.body?.count, amount: req.body?.amount, batch_name: req.body?.batch_name }),
}), async (req, res) => {
  const { amount, count, maxUses, expiresAt, batchName, refundable, feeRate } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: '请输入有效的兑换金额' });
  }
  if (!count || count < 1 || count > 1000) {
    return res.status(400).json({ error: '生成数量必须在 1-1000 之间' });
  }
  try {
    const generatedCodes = [];
    for (let i = 0; i < count; i++) {
      const code = Math.random().toString(36).slice(2, 10).toUpperCase();
      const result = await pool.query(
        `INSERT INTO redemption_codes (code, amount, max_uses, expires_at, batch_name, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [code, amount, maxUses || 1, expiresAt || null, batchName || null, req.session.user.id]
      );
      generatedCodes.push(result.rows[0]);
    }
    res.json({ success: true, codes: generatedCodes });
  } catch (error) {
    Logger.error('[生成兑换码] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量删除兑换码
router.post('/redemption-codes/batch-delete', requireAuth, requireAdmin, async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要删除的兑换码' });
  }
  try {
    await pool.query('DELETE FROM redemption_codes WHERE id = ANY($1)', [ids]);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[批量删除兑换码] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量设置兑换码可退款属性
router.post('/redemption-codes/batch-set-refundable', requireAuth, requireAdmin, async (req, res) => {
  const { ids, refundable, feeRate } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要设置的兑换码' });
  }
  try {
    // 注意：redemption_codes 表可能没有 refundable 和 fee_rate 字段
    // 这里先尝试更新，如果字段不存在则跳过
    try {
      await pool.query(
        'UPDATE redemption_codes SET refundable = $1, fee_rate = $2 WHERE id = ANY($3)',
        [refundable || false, feeRate || 0, ids]
      );
    } catch (e) {
      // 字段可能不存在，忽略错误
      Logger.warn('[批量设置兑换码属性] 字段可能不存在:', e.message);
    }
    res.json({ success: true });
  } catch (error) {
    Logger.error('[批量设置兑换码属性] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ========== 商品管理 ==========

// 获取商品列表
router.get('/products', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM products ORDER BY sort_order ASC, created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取商品列表] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建商品
router.post('/products', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_PRODUCT, {
  resourceType: 'product',
  resourceIdFrom: (req, res) => res._logBody?.id,
  descriptionFrom: (req) => `创建商品「${req.body?.name || '-'}」`,
}), async (req, res) => {
  const { name, description, price, image_url, link, is_active, sort_order } = req.body;
  if (!name) {
    return res.status(400).json({ error: '商品名称不能为空' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO products (name, description, price, image_url, link, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name, description || '', price || 0, image_url || '', link || '', is_active !== false, sort_order || 0]
    );
    res.json(result.rows[0]);
  } catch (error) {
    Logger.error('[创建商品] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新商品
router.put('/products/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name, description, price, image_url, link, is_active, sort_order } = req.body;
  try {
    const result = await pool.query(
      `UPDATE products SET name = $1, description = $2, price = $3, image_url = $4, link = $5, is_active = $6, sort_order = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 RETURNING *`,
      [name, description, price, image_url, link, is_active, sort_order, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '商品不存在' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    Logger.error('[更新商品] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除商品
router.delete('/products/:id', requireAuth, requireAdmin, auditMiddleware(ACTIONS.ADMIN_PRODUCT, {
  resourceType: 'product',
  resourceIdFrom: (req) => req.params.id,
  descriptionFrom: (req) => `删除商品 #${req.params.id}`,
}), async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[删除商品] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量删除商品
router.post('/products/batch-delete', requireAuth, requireAdmin, async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要删除的商品' });
  }
  try {
    await pool.query('DELETE FROM products WHERE id = ANY($1)', [ids]);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[批量删除商品] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ========== 导入配置 ==========

router.post('/import-grok', requireAuth, requireAdmin, async (req, res) => {
  const { providerId, config } = req.body;
  if (!providerId) return res.status(400).json({ error: '请选择要绑定的供应商' });
  if (!config || typeof config !== 'object') return res.status(400).json({ error: '无效的配置内容' });
  try {
    const auth = parseGrokAuthConfig(config);
    if (!auth) return res.status(400).json({ error: '未找到有效的 Grok Token。auth.json 通常是包含 key、user_id 的账号映射，请确认文件来自 ~/.grok/auth.json' });
    const existing = await pool.query('SELECT id FROM providers WHERE id = $1', [providerId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: '供应商不存在' });
    await pool.query(`
      UPDATE providers SET quota_enabled = TRUE, quota_mode = 'grok_billing',
        oauth_access_token = $1, oauth_refresh_token = $2, oauth_expires_at = $3,
        oauth_account_id = $4, oauth_issuer = $5, oauth_client_id = $6
      WHERE id = $7
    `, [auth.accessToken, auth.refreshToken || null, auth.expiresAt, auth.userId || null, auth.issuer || null, auth.clientId || null, providerId]);
    res.json({ success: true, providerId, updated: true });
  } catch (error) {
    Logger.error('[导入 SuperGrok 配置] 错误:', error);
    res.status(500).json({ error: '导入失败: ' + error.message });
  }
});

router.post('/import-codex', requireAuth, requireAdmin, async (req, res) => {
  const { providerId, config } = req.body;
  if (!providerId) return res.status(400).json({ error: '请选择要绑定的供应商' });
  if (!config || typeof config !== 'object') return res.status(400).json({ error: '无效的配置内容' });

  try {
    const { parseCodexAuthConfig } = require('../utils/codex-usage');
    const tokens = parseCodexAuthConfig(config);
    if (!tokens) return res.status(400).json({ error: '未找到 tokens.access_token 或 refresh_token' });
    const existing = await pool.query('SELECT id FROM providers WHERE id = $1', [providerId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: '供应商不存在' });
    await pool.query(`
      UPDATE providers SET quota_enabled = TRUE, quota_mode = 'codex_wham',
        oauth_access_token = $1,
        oauth_refresh_token = COALESCE($2, oauth_refresh_token),
        oauth_expires_at = $3,
        oauth_account_id = $4
      WHERE id = $5
    `, [tokens.accessToken || null, tokens.refreshToken || null, tokens.expiresAt, tokens.accountId || null, providerId]);
    res.json({ success: true, providerId, updated: true });
  } catch (error) {
    Logger.error('[导入 Codex 配置] 错误:', error);
    res.status(500).json({ error: '导入失败: ' + error.message });
  }
});

router.post('/import-opencode', requireAuth, requireAdmin, async (req, res) => {
  const { providerId, providerName, config } = req.body;
  if (!providerName) {
    return res.status(400).json({ error: '供应商名称不能为空' });
  }
  // 支持传入已有 id 进行更新，否则自动生成
  const effectiveProviderId = providerId || crypto.randomUUID();
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: '无效的配置内容' });
  }

  try {
    let created = 0, updated = 0, modelsCount = 0;

    // 格式一: Claude Code 配置 { env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN } }
    if (config.env && typeof config.env === 'object') {
      const baseUrl = config.env.ANTHROPIC_BASE_URL;
      const apiKey = config.env.ANTHROPIC_AUTH_TOKEN;
      if (!baseUrl || !apiKey) {
        return res.status(400).json({ error: 'Claude Code 配置缺少 ANTHROPIC_BASE_URL 或 ANTHROPIC_AUTH_TOKEN' });
      }

      const existing = await pool.query('SELECT id FROM providers WHERE id = $1', [effectiveProviderId]);
      await pool.query(`
        INSERT INTO providers (id, name, base_url, api_key, format, enabled)
        VALUES ($1, $2, $3, $4, 'openai', TRUE)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, base_url = EXCLUDED.base_url, api_key = EXCLUDED.api_key
      `, [effectiveProviderId, providerName, baseUrl, encryptSecret(apiKey)]);

      if (existing.rows.length > 0) updated++; else created++;

      // 尝试获取模型列表
      try {
        const modelsUrl = upstreamUrl(baseUrl, '/models');
        const modelsRes = await fetch(modelsUrl, {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (modelsRes.ok) {
          const modelsData = await modelsRes.json();
          const models = modelsData.data || [];
          const importedModelIds = [];
          for (const m of models) {
            // 同一供应商下同名模型不重复添加
            const existingModel = await pool.query(
              'SELECT id FROM models WHERE upstream_model_id = $1 AND provider = $2',
              [m.id, effectiveProviderId]
            );
            if (existingModel.rows.length > 0) continue;

            const modelUuid = crypto.randomUUID();
            await pool.query(`
              INSERT INTO models (id, name, provider, enabled, input_price_per_1k_tokens, output_price_per_1k_tokens, upstream_model_id)
              VALUES ($1, $2, $3, TRUE, 0, 0, $4)
            `, [modelUuid, m.id, effectiveProviderId, m.id]);
            importedModelIds.push(modelUuid);
            modelsCount++;
          }
          // 新模型自动挂载到前沿 Team
          if (importedModelIds.length > 0) {
            try {
              await addModelsToFrontierTeams(importedModelIds);
            } catch (e) {
              Logger.warn('[导入配置] 自动添加到前沿Team失败:', e.message);
            }
          }
        }
      } catch (e) {
        Logger.warn('[导入配置] 获取模型列表失败:', e.message);
      }

    } else {
      // 格式二: OpenCode auth.json { "provider": { "type": "api", "key": "sk-xxx" }, ... }
      // 收集所有 API key，合并到同一个供应商
      const keys = [];
      for (const [key, entry] of Object.entries(config)) {
        if (entry && entry.key) keys.push(entry.key);
      }

      if (keys.length === 0) {
        return res.status(400).json({ error: '未找到有效的 API Key' });
      }

      // 尝试从已知供应商匹配 base URL
      const providerHints = {
        'openai': 'https://api.openai.com',
        'anthropic': 'https://api.anthropic.com',
        'google': 'https://generativelanguage.googleapis.com',
        'deepseek': 'https://api.deepseek.com',
        'groq': 'https://api.groq.com',
      };
      let baseUrl = '';
      for (const [k, url] of Object.entries(providerHints)) {
        if (config[k] && config[k].key) { baseUrl = url; break; }
      }

      const existing = await pool.query('SELECT id FROM providers WHERE id = $1', [effectiveProviderId]);
      await pool.query(`
        INSERT INTO providers (id, name, base_url, api_key, format, enabled)
        VALUES ($1, $2, $3, $4, 'openai', TRUE)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, base_url = EXCLUDED.base_url, api_key = EXCLUDED.api_key
      `, [effectiveProviderId, providerName, baseUrl, encryptSecret(keys[0])]);

      if (existing.rows.length > 0) updated++; else created++;
    }

    Logger.info(`[导入配置] 完成: id=${effectiveProviderId}, 新增 ${created}, 更新 ${updated}, 模型 ${modelsCount}`);
    res.json({ id: effectiveProviderId, imported: { created, updated, models: modelsCount } });
  } catch (error) {
    Logger.error('[导入配置] 错误:', error);
    res.status(500).json({ error: '导入失败' });
  }
});

// ========== 用户组管理 ==========

// 获取所有用户组
router.get('/user-groups', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ug.*,
        (SELECT COUNT(*) FROM users WHERE group_id = ug.id) AS member_count,
        (SELECT COUNT(*) FROM user_group_rules WHERE group_id = ug.id) AS rule_count
      FROM user_groups ug
      ORDER BY ug.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取用户组列表] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建用户组
router.post('/user-groups', requireAuth, requireAdmin, async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '用户组名称不能为空' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO user_groups (name, description) VALUES ($1, $2) RETURNING *',
      [name.trim(), description || '']
    );
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: '用户组名称已存在' });
    }
    Logger.error('[创建用户组] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新用户组
router.put('/user-groups/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name, description } = req.body;
  try {
    const result = await pool.query(
      'UPDATE user_groups SET name = COALESCE($1, name), description = COALESCE($2, description), updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
      [name, description, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '用户组不存在' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: '用户组名称已存在' });
    }
    Logger.error('[更新用户组] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 设置默认用户组
router.put('/user-groups/:id/set-default', requireAuth, requireAdmin, async (req, res) => {
  try {
    // 先清除所有默认标记
    await pool.query('UPDATE user_groups SET is_default = FALSE WHERE is_default = TRUE');
    // 设置新的默认组
    const result = await pool.query(
      'UPDATE user_groups SET is_default = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '用户组不存在' });
    }
    Logger.info(`[用户组] 已将 "${result.rows[0].name}" 设为默认用户组`);
    res.json(result.rows[0]);
  } catch (error) {
    Logger.error('[设置默认用户组] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除用户组
router.delete('/user-groups/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    // 先将该用户组的用户 group_id 置空
    await pool.query('UPDATE users SET group_id = NULL WHERE group_id = $1', [req.params.id]);
    const result = await pool.query('DELETE FROM user_groups WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '用户组不存在' });
    }
    res.json({ success: true });
  } catch (error) {
    Logger.error('[删除用户组] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取用户组规则
router.get('/user-groups/:id/rules', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM user_group_rules WHERE group_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取用户组规则] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 添加用户组规则
router.post('/user-groups/:id/rules', requireAuth, requireAdmin, async (req, res) => {
  const { rule_type, rule_value, duration_hours, description } = req.body;
  if (!rule_type || rule_value === undefined) {
    return res.status(400).json({ error: '规则类型和值不能为空' });
  }
  try {
    // 验证用户组存在
    const groupCheck = await pool.query('SELECT id FROM user_groups WHERE id = $1', [req.params.id]);
    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ error: '用户组不存在' });
    }
    const result = await pool.query(
      `INSERT INTO user_group_rules (group_id, rule_type, rule_value, duration_hours, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, rule_type, rule_value, duration_hours || null, description || '']
    );
    res.json(result.rows[0]);
  } catch (error) {
    Logger.error('[添加用户组规则] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新用户组规则
router.put('/user-group-rules/:id', requireAuth, requireAdmin, async (req, res) => {
  const { rule_value, duration_hours, description } = req.body;
  if (rule_value === undefined) {
    return res.status(400).json({ error: '限制值不能为空' });
  }
  try {
    const result = await pool.query(
      `UPDATE user_group_rules SET rule_value = $1, duration_hours = COALESCE($2, duration_hours),
       description = COALESCE($3, description) WHERE id = $4 RETURNING *`,
      [rule_value, duration_hours ?? null, description ?? null, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: '规则不存在' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    Logger.error('[更新用户组规则] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除用户组规则
router.delete('/user-group-rules/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM user_group_rules WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[删除用户组规则] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==================== AI 脚本分析与修复 ====================

// 清理 base_url：去掉尾部已知端点路径，避免重复拼接。
// 保留 /v1、/api/v1 版本前缀，由 upstreamUrl() 智能补全
function cleanBaseUrl(base) {
  return base
    .replace(/\/$/, '')
    .replace(/\/v1\/chat\/completions$/i, '')
    .replace(/\/v1\/messages$/i, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/messages$/i, '')
    .replace(/\/anthropic$/i, '')
    .replace(/\/openai$/i, '');
}

// 查找系统中可用的模型及其供应商列表（用于内部 AI 调用，优先 OpenAI 格式）
async function findAvailableProviders() {
  try {
    const result = await pool.query(`
      SELECT m.id AS model_id, m.name AS model_name, m.upstream_model_id,
             p.id AS provider_id, p.name AS provider_name, p.base_url, p.api_key, p.api_keys, p.format
      FROM models m
      JOIN providers p ON m.provider = p.id
      WHERE m.enabled = TRUE AND p.enabled = TRUE AND p.api_key IS NOT NULL AND p.api_key != ''
      ORDER BY CASE WHEN p.format = 'openai' THEN 0 ELSE 1 END, m.created_at ASC
    `);
    return result.rows.map(r => ({
      modelId: r.model_id,
      modelName: r.model_name || r.model_id,
      model: r.upstream_model_id || r.model_id,
      provider: {
        id: r.provider_id,
        name: r.provider_name || r.provider_id,
        base_url: r.base_url,
        api_key: getPrimaryApiKey({ api_key: decryptSecret(r.api_key), api_keys: r.api_keys }),
        format: r.format || 'openai'
      }
    }));
  } catch (e) {
    Logger.warn('[AI脚本分析] 查找可用模型失败:', e.message);
    return [];
  }
}

// 根据供应商格式构建正确的 API URL
function buildProviderApiUrl(provider) {
  const base = cleanBaseUrl(provider.base_url);
  if (provider.format === 'anthropic') {
    return { url: upstreamUrl(base, '/messages'), isAnthropic: true };
  }
  return { url: upstreamUrl(base, '/chat/completions'), isAnthropic: false };
}

// 构建 Anthropic 格式请求体
function buildAnthropicBody(model, messages, stream, maxTokens, temperature) {
  const systemMsg = messages.find(m => m.role === 'system');
  const userMsgs = messages.filter(m => m.role !== 'system');
  const body = {
    model,
    messages: userMsgs,
    max_tokens: maxTokens || 4096,
    stream: !!stream
  };
  if (systemMsg) body.system = systemMsg.content;
  if (temperature !== undefined) body.temperature = temperature;
  return body;
}

// 解析上游 SSE 流，提取 content 文本（兼容 OpenAI 和 Anthropic 格式）
function createStreamParser(isAnthropic) {
  let toolUseState = null;
  let thinkingContent = '';

  return {
    parseLine(line) {
      if (!line.startsWith('data: ')) return null;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return { done: true };

      try {
        const parsed = JSON.parse(data);

        // OpenAI 格式
        if (!isAnthropic) {
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) return { content };
          return null;
        }

        // Anthropic 格式
        const evt = parsed.type;
        if (evt === 'content_block_start') {
          const block = parsed.content_block;
          if (block?.type === 'tool_use') {
            toolUseState = { id: block.id, name: block.name, input: '' };
          }
          return null;
        }
        if (evt === 'content_block_delta') {
          const delta = parsed.delta;
          if (delta?.type === 'text_delta' && delta.text) return { content: delta.text };
          if (delta?.type === 'thinking_delta' && delta.thinking) {
            thinkingContent += delta.thinking;
            return null;
          }
          if (delta?.type === 'input_json_delta' && toolUseState) {
            toolUseState.input += delta.partial_json || '';
            return null;
          }
          return null;
        }
        if (evt === 'content_block_stop') {
          toolUseState = null;
          return null;
        }
        if (evt === 'message_stop') return { done: true };
        return null;
      } catch (e) {
        return null;
      }
    }
  };
}

// 尝试用第一个可用的供应商发起 AI 请求（带 fallback，最多尝试 3 个）
// preferredModelId：管理后台 AI 辅助显式选择的模型 id
async function tryAiRequest(bodyBuilder, { stream = false, excludeProviderId = null, preferredModelId = null } = {}) {
  const providers = await findAvailableProviders();

  // 优先使用请求中显式指定的模型
  if (preferredModelId) {
    try {
      const preferredIdx = providers.findIndex(p =>
        p.provider.id !== excludeProviderId
        && (String(p.modelId) === String(preferredModelId)
          || String(p.model) === String(preferredModelId))
      );
      if (preferredIdx >= 0) {
        const [preferred] = providers.splice(preferredIdx, 1);
        providers.unshift(preferred);
        Logger.info(`[AI调用] 优先使用指定模型: ${preferredModelId} (${preferred.modelName || preferred.model})`);
      } else {
        // 再按 models 表解析一次（兼容只传了库内 id 的情况）
        const modelResult = await pool.query(
          `SELECT id, upstream_model_id FROM models WHERE id = $1 AND enabled = TRUE`,
          [preferredModelId]
        );
        const upstreamId = modelResult.rows[0]?.upstream_model_id || preferredModelId;
        const fallbackIdx = providers.findIndex(p =>
          p.provider.id !== excludeProviderId
          && (String(p.model) === String(upstreamId) || String(p.modelId) === String(preferredModelId))
        );
        if (fallbackIdx >= 0) {
          const [preferred] = providers.splice(fallbackIdx, 1);
          providers.unshift(preferred);
          Logger.info(`[AI调用] 优先使用指定模型(解析后): ${preferredModelId} → ${preferred.model}`);
        } else {
          Logger.warn(`[AI调用] 指定模型不可用，将回退自动选择: ${preferredModelId}`);
        }
      }
    } catch (e) {
      Logger.warn('[AI调用] 解析指定模型失败:', e.message);
    }
  }

  const candidates = providers.filter(p => p.provider.id !== excludeProviderId);
  if (candidates.length === 0) {
    throw new Error('系统中没有可用的 AI 模型，请先配置供应商和模型');
  }

  const MAX_ATTEMPTS = 3;
  const TIMEOUT_MS = 60000;
  let lastError = null;

  for (let i = 0; i < Math.min(candidates.length, MAX_ATTEMPTS); i++) {
    const { model, provider } = candidates[i];
    const { url, isAnthropic } = buildProviderApiUrl(provider);
    const reqBody = bodyBuilder(model, isAnthropic);
    const headers = { 'Content-Type': 'application/json' };
    if (provider.api_key) {
      headers['Authorization'] = isAnthropic ? `${provider.api_key}` : `Bearer ${provider.api_key}`;
      headers['x-api-key'] = provider.api_key;
    }
    if (isAnthropic) {
      headers['anthropic-version'] = '2023-06-01';
    }

    Logger.info(`[AI调用] 尝试 (${i + 1}/${MAX_ATTEMPTS}): provider=${provider.id}, model=${model}, format=${provider.format}, url=${url}`);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (res.ok) {
        Logger.info(`[AI调用] 成功: provider=${provider.id}, model=${model}`);
        return { response: res, isAnthropic, provider, model };
      }
      const errText = await res.text().catch(() => '');
      Logger.warn(`[AI调用] 失败: provider=${provider.id}, status=${res.status}, body=${errText.substring(0, 200)}`);
      lastError = `provider=${provider.id}, status=${res.status}`;
    } catch (fetchErr) {
      Logger.warn(`[AI调用] 请求异常: provider=${provider.id}, error=${fetchErr.message}`);
      lastError = `provider=${provider.id}, error=${fetchErr.message}`;
    }
  }
  throw new Error(`AI 供应商调用失败 (${lastError})`);
}

// 流式分析脚本错误
router.post('/providers/:id/analyze-script-error', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { script, error, modelId } = req.body;
    if (!script || !error) {
      return res.status(400).json({ error: '缺少脚本内容或错误信息' });
    }

    const prompt = `你是一个 JavaScript/Node.js 专家。请分析以下密钥刷新脚本的错误并给出修改建议。

## 脚本代码
\`\`\`javascript
${script}
\`\`\`

## 错误信息
${error}

## 脚本上下文
这是一个用于自动刷新 API 密钥的脚本。脚本运行在一个沙箱环境中，上下文对象 ctx 包含：
- baseUrl: 供应商的基础 URL
- providerId: 供应商 ID
- providerName: 供应商名称
- currentKey: 当前密钥
- fetch: 全局 fetch 函数

脚本应返回一个字符串（新密钥）或对象 { key: string, expiresIn?: number }。

请：
1. 分析错误原因
2. 指出具体的问题代码行
3. 给出修改建议
4. 如果可以修复，给出完整的修复后代码`;

    const messages = [
      { role: 'system', content: '你是 CrewRouter 密钥脚本分析助手，专门帮助用户调试和修复密钥刷新脚本。请用中文回复。' },
      { role: 'user', content: prompt }
    ];

    const { response: upstreamRes, isAnthropic } = await tryAiRequest(
      (model, isAnthropic) => isAnthropic
        ? buildAnthropicBody(model, messages, true, 4096, 0.3)
        : { model, messages, stream: true, max_tokens: 4096, temperature: 0.3 },
      { stream: true, excludeProviderId: req.params.id, preferredModelId: modelId || null }
    );

    // 流式转发 SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let clientDisconnected = false;

    req.on('close', () => { clientDisconnected = true; });

    const writeSSE = (data) => {
      if (clientDisconnected) return false;
      return res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const parser = createStreamParser(isAnthropic);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const result = parser.parseLine(line);
          if (!result) continue;
          if (result.done) {
            writeSSE({ done: true });
            res.end();
            return;
          }
          if (result.content) {
            writeSSE({ content: result.content });
          }
        }
      }
    } catch (streamErr) {
      if (!clientDisconnected) {
        Logger.error('[AI脚本分析] 流式传输错误:', streamErr.message);
      }
    }

    writeSSE({ done: true });
    res.end();
  } catch (error) {
    Logger.error('[AI脚本分析] 错误:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: '服务器错误' });
    } else {
      res.end();
    }
  }
});

// AI 修复脚本（流式，实时显示修复过程）
router.post('/providers/:id/fix-script', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { script, error, analysis, modelId } = req.body;
    if (!script || !error) {
      return res.status(400).json({ error: '缺少脚本内容或错误信息' });
    }

    const prompt = `你是一个 JavaScript/Node.js 专家。请根据以下信息修复密钥刷新脚本。

## 原始脚本
\`\`\`javascript
${script}
\`\`\`

## 错误信息
${error}

${analysis ? `## AI 分析\n${analysis}\n\n` : ''}## 脚本上下文
这是一个用于自动刷新 API 密钥的脚本。脚本运行在沙箱环境中，上下文对象 ctx 包含：
- baseUrl: 供应商的基础 URL
- providerId: 供应商 ID
- providerName: 供应商名称
- currentKey: 当前密钥
- fetch: 全局 fetch 函数

脚本应返回一个字符串（新密钥）或对象 { key: string, expiresIn?: number }。

请直接返回修复后的完整脚本代码，不要包含任何解释文字，只返回纯代码。`;

    const messages = [
      { role: 'system', content: '你是 CrewRouter 密钥脚本修复助手。只返回修复后的 JavaScript 代码，不要包含 markdown 代码块标记或任何解释。' },
      { role: 'user', content: prompt }
    ];

    const { response: upstreamRes, isAnthropic } = await tryAiRequest(
      (model, isAnthropic) => isAnthropic
        ? buildAnthropicBody(model, messages, true, 4096, 0.2)
        : { model, messages, stream: true, max_tokens: 4096, temperature: 0.2 },
      { stream: true, excludeProviderId: req.params.id, preferredModelId: modelId || null }
    );

    // 流式转发 SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let clientDisconnected = false;

    req.on('close', () => { clientDisconnected = true; });

    const writeSSE = (data) => {
      if (clientDisconnected) return false;
      return res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const parser = createStreamParser(isAnthropic);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const result = parser.parseLine(line);
          if (!result) continue;
          if (result.done) {
            // 清理 markdown 代码块标记
            let fixedScript = fullText.replace(/^```(?:javascript|js)?\s*\n/i, '').replace(/\n```\s*$/, '').trim();
            writeSSE({ done: true, fixedScript });
            res.end();
            return;
          }
          if (result.content) {
            fullText += result.content;
            writeSSE({ content: result.content });
          }
        }
      }
    } catch (streamErr) {
      if (!clientDisconnected) {
        Logger.error('[AI脚本修复] 流式传输错误:', streamErr.message);
      }
    }

    // 流结束但没收到 done 信号
    let fixedScript = fullText.replace(/^```(?:javascript|js)?\s*\n/i, '').replace(/\n```\s*$/, '').trim();
    writeSSE({ done: true, fixedScript });
    res.end();
  } catch (error) {
    Logger.error('[AI脚本修复] 错误:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: '服务器错误' });
    } else {
      res.end();
    }
  }
});

// ==================== Fusion 配置管理 ====================

// 获取所有 Fusion 配置
router.get('/fusion-configs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM fusion_configs ORDER BY is_default DESC, name ASC'
    );
    res.json(result.rows);
  } catch (error) {
    Logger.error('[获取Fusion配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取单个 Fusion 配置
router.get('/fusion-configs/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM fusion_configs WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Fusion配置未找到' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    Logger.error('[获取Fusion配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建 Fusion 配置
router.post('/fusion-configs', requireAuth, requireAdmin, async (req, res) => {
  const { name, description, panel_models, judge_model_id, outer_model_id, max_panel_count, temperature, max_tokens, is_default, enabled } = req.body;

  if (!name || !panel_models || !judge_model_id || !outer_model_id) {
    return res.status(400).json({ error: '缺少必填字段: name, panel_models, judge_model_id, outer_model_id' });
  }

  try {
    // 如果设置为默认，先取消其他默认配置
    if (is_default) {
      await pool.query('UPDATE fusion_configs SET is_default = FALSE WHERE is_default = TRUE');
    }

    const result = await pool.query(
      `INSERT INTO fusion_configs (name, description, panel_models, judge_model_id, outer_model_id,
       max_panel_count, temperature, max_tokens, is_default, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [name, description || '', JSON.stringify(panel_models), judge_model_id, outer_model_id,
       max_panel_count || 8, temperature || 0.7, max_tokens || 4096, is_default || false, enabled !== false]
    );

    Logger.info(`[Fusion配置] 创建成功: id=${result.rows[0].id}, name=${name}`);
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') { // unique_violation
      return res.status(400).json({ error: '配置名称已存在' });
    }
    Logger.error('[创建Fusion配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新 Fusion 配置
router.put('/fusion-configs/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name, description, panel_models, judge_model_id, outer_model_id, max_panel_count, temperature, max_tokens, is_default, enabled } = req.body;

  try {
    // 检查配置是否存在
    const existing = await pool.query('SELECT * FROM fusion_configs WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Fusion配置未找到' });
    }

    // 如果设置为默认，先取消其他默认配置
    if (is_default) {
      await pool.query('UPDATE fusion_configs SET is_default = FALSE WHERE is_default = TRUE AND id != $1', [req.params.id]);
    }

    const result = await pool.query(
      `UPDATE fusion_configs
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           panel_models = COALESCE($3, panel_models),
           judge_model_id = COALESCE($4, judge_model_id),
           outer_model_id = COALESCE($5, outer_model_id),
           max_panel_count = COALESCE($6, max_panel_count),
           temperature = COALESCE($7, temperature),
           max_tokens = COALESCE($8, max_tokens),
           is_default = COALESCE($9, is_default),
           enabled = COALESCE($10, enabled),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $11
       RETURNING *`,
      [name, description, panel_models ? JSON.stringify(panel_models) : null,
       judge_model_id, outer_model_id, max_panel_count, temperature, max_tokens,
       is_default, enabled, req.params.id]
    );

    Logger.info(`[Fusion配置] 更新成功: id=${req.params.id}`);
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: '配置名称已存在' });
    }
    Logger.error('[更新Fusion配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除 Fusion 配置
router.delete('/fusion-configs/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM fusion_configs WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Fusion配置未找到' });
    }

    Logger.info(`[Fusion配置] 删除成功: id=${req.params.id}, name=${result.rows[0].name}`);
    res.json({ success: true, message: '配置已删除' });
  } catch (error) {
    Logger.error('[删除Fusion配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 批量删除 Fusion 配置
router.post('/fusion-configs/batch-delete', requireAuth, requireAdmin, async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要删除的配置' });
  }

  try {
    await pool.query('DELETE FROM fusion_configs WHERE id = ANY($1)', [ids]);
    Logger.info(`[Fusion配置] 批量删除: ${ids.length} 个配置`);
    res.json({ success: true, message: `已删除 ${ids.length} 个配置` });
  } catch (error) {
    Logger.error('[批量删除Fusion配置] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取 Fusion 用量统计
router.get('/fusion-usage', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { user_id, start_date, end_date, limit = 100, offset = 0 } = req.query;

    let query = `
      SELECT fur.*, u.username, fc.name as config_name
      FROM fusion_usage_records fur
      LEFT JOIN users u ON fur.user_id = u.id
      LEFT JOIN fusion_configs fc ON fur.config_id = fc.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (user_id) {
      query += ` AND fur.user_id = $${paramIndex++}`;
      params.push(user_id);
    }

    if (start_date) {
      query += ` AND fur.created_at >= $${paramIndex++}`;
      params.push(start_date);
    }

    if (end_date) {
      query += ` AND fur.created_at <= $${paramIndex++}`;
      params.push(end_date);
    }

    query += ` ORDER BY fur.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // 获取总数
    let countQuery = 'SELECT COUNT(*) FROM fusion_usage_records WHERE 1=1';
    const countParams = [];
    let countParamIndex = 1;

    if (user_id) {
      countQuery += ` AND user_id = $${countParamIndex++}`;
      countParams.push(user_id);
    }

    if (start_date) {
      countQuery += ` AND created_at >= $${countParamIndex++}`;
      countParams.push(start_date);
    }

    if (end_date) {
      countQuery += ` AND created_at <= $${countParamIndex++}`;
      countParams.push(end_date);
    }

    const countResult = await pool.query(countQuery, countParams);

    res.json({
      data: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    Logger.error('[获取Fusion用量] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取 Fusion 用量汇总统计
router.get('/fusion-usage/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let query = `
      SELECT
        COUNT(*) as total_requests,
        SUM(total_tokens) as total_tokens,
        SUM(total_cost) as total_cost,
        AVG(latency_ms) as avg_latency,
        COUNT(DISTINCT user_id) as unique_users
      FROM fusion_usage_records
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (start_date) {
      query += ` AND created_at >= $${paramIndex++}`;
      params.push(start_date);
    }

    if (end_date) {
      query += ` AND created_at <= $${paramIndex++}`;
      params.push(end_date);
    }

    const result = await pool.query(query, params);

    res.json(result.rows[0]);
  } catch (error) {
    Logger.error('[获取Fusion统计] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 模型调用可用率（平台全局）
router.get('/models/uptime', requireAuth, requireAdmin, async (req, res) => {
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
    Logger.error('[管理员模型 uptime 批量] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

router.get('/models/:id/uptime', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { getModelUptimeDetail, DEFAULT_DAYS } = require('../utils/model-uptime');
    const days = parseInt(req.query.days, 10) || DEFAULT_DAYS;
    const data = await getModelUptimeDetail(req.params.id, days);
    res.json(data);
  } catch (error) {
    Logger.error('[管理员模型 uptime 详情] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 模型测试：测试单个模型
router.post('/models/:id/test', requireAdmin, async (req, res) => {
  try {
    const { testModel } = require('../utils/model-test');
    const result = await testModel(req.params.id, req.session.user.id);
    res.json(result);
  } catch (error) {
    Logger.error('[管理员模型测试] 错误:', error);
    res.status(500).json({ ok: false, error: '服务器错误' });
  }
});

// 模型测试：批量测试
router.post('/models/test-batch', requireAdmin, async (req, res) => {
  try {
    const { testModelsBatch } = require('../utils/model-test');
    const { modelIds } = req.body;
    if (!Array.isArray(modelIds) || modelIds.length === 0) {
      return res.status(400).json({ ok: false, error: '请提供 modelIds 数组' });
    }
    const results = await testModelsBatch(modelIds, req.session.user.id);
    res.json({ results });
  } catch (error) {
    Logger.error('[管理员批量测试] 错误:', error);
    res.status(500).json({ ok: false, error: '服务器错误' });
  }
});

// ========== 供应商标签管理 ==========

// 获取所有供应商标签
router.get('/provider-tags', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, color, sort_order, created_at FROM provider_tags ORDER BY sort_order ASC, id ASC');
    res.json(result.rows);
  } catch (error) {
    if (error.code === '42P01') return res.json([]); // 表不存在时返回空数组
    Logger.error('[获取供应商标签] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 创建供应商标签
router.post('/provider-tags', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '标签名不能为空' });
    const sortOrderResult = await pool.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM provider_tags');
    const sortOrder = sortOrderResult.rows[0].next;
    const result = await pool.query('INSERT INTO provider_tags (name, color, sort_order) VALUES ($1, $2, $3) RETURNING id, name, color, sort_order', [name.trim(), color || '#3b82f6', sortOrder]);
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: '标签名已存在' });
    Logger.error('[创建供应商标签] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 更新供应商标签
router.put('/provider-tags/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, color } = req.body;
    const result = await pool.query('UPDATE provider_tags SET name = COALESCE($1, name), color = COALESCE($2, color) WHERE id = $3 RETURNING id, name, color, sort_order', [name || null, color || null, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '标签不存在' });
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: '标签名已存在' });
    Logger.error('[更新供应商标签] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 删除供应商标签（级联删除关联）
router.delete('/provider-tags/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM provider_tags WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    Logger.error('[删除供应商标签] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 供应商标签排序
router.put('/provider-tags/reorder', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: '参数错误' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query('UPDATE provider_tags SET sort_order = $1 WHERE id = $2', [i, orderedIds[i]]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    res.json({ success: true });
  } catch (error) {
    Logger.error('[供应商标签排序] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 设置供应商的标签（替换模式：先删后插）
router.put('/providers/:id/tags', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: '参数错误' });
    const providerCheck = await pool.query('SELECT id FROM providers WHERE id = $1', [req.params.id]);
    if (providerCheck.rows.length === 0) return res.status(404).json({ error: '供应商不存在' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM provider_tag_assignments WHERE provider_id = $1', [req.params.id]);
      for (const tagId of tagIds) {
        await client.query('INSERT INTO provider_tag_assignments (provider_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, tagId]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    // 返回更新后的标签
    const tagsResult = await pool.query(`
      SELECT pt.id, pt.name, pt.color FROM provider_tag_assignments pta
      JOIN provider_tags pt ON pta.tag_id = pt.id WHERE pta.provider_id = $1 ORDER BY pt.sort_order
    `, [req.params.id]);
    res.json({ success: true, tags: tagsResult.rows });
  } catch (error) {
    Logger.error('[设置供应商标签] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 挂载工具方法，供启动迁移等调用
router.cleanupOrphanedModels = cleanupOrphanedModels;
router.purgeModelsCompletely = purgeModelsCompletely;

// ========== 操作日志查询（管理员） ==========
router.get('/audit-logs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const userId = (req.query.user_id || '').trim();
    const action = (req.query.action || '').trim();
    const resourceType = (req.query.resource_type || '').trim();
    const q = (req.query.q || '').trim();

    const whereParts = [];
    const params = [];
    let idx = 1;
    if (userId) { whereParts.push(`user_id = $${idx++}`); params.push(parseInt(userId, 10)); }
    if (action) { whereParts.push(`action = $${idx++}`); params.push(action); }
    if (resourceType) { whereParts.push(`resource_type = $${idx++}`); params.push(resourceType); }
    if (q) { whereParts.push(`(username ILIKE $${idx} OR description ILIKE $${idx})`); params.push(`%${q}%`); idx++; }
    const where = whereParts.length ? whereParts.join(' AND ') : 'TRUE';

    const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM operation_logs WHERE ${where}`, params);
    const total = countResult.rows[0].count;

    const listParams = [...params, limit, offset];
    const result = await pool.query(
      `SELECT id, user_id, username, is_admin, action, resource_type, resource_id,
              description, details, ip_address, user_agent, status, duration_ms, created_at
       FROM operation_logs
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      listParams
    );

    res.json({ items: result.rows, total, page, limit });
  } catch (error) {
    Logger.error('[管理端操作日志查询] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 用量安全子集导出（字段白名单聚合，绝不含 messages/response/request_params/凭证）
router.get('/export-usage', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { usageSummary } = require('../utils/plugin-data-read');
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const groupBy = ['model_id', 'day'].includes(req.query.groupBy) ? req.query.groupBy : 'model_id';
    const data = await usageSummary({ days, groupBy });
    const payload = { exportedAt: new Date().toISOString(), days, groupBy, ...data };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="usage-export-${days}d-${Date.now()}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (error) {
    Logger.error('[用量导出] 错误:', error);
    res.status(500).json({ error: '导出失败' });
  }
});

module.exports = router;
