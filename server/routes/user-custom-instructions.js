/**
 * 用户级自定义提示词查询（每位用户只能看到自己产生的提示词）
 *
 * 与 admin-custom-instructions.js 共享扫描逻辑（expandCte/scanWindow/fingerprintOf），
 * 但所有查询强制 user_id = 当前登录用户，普通用户可见；管理员如需全站视图走 admin 端点。
 */

const express = require('express');
const pool = require('../models/database').pool;
const Logger = require('../logger');
const { requireAuth } = require('../middleware/auth');

// 复用 admin 路由的内部工具（通过导出的 helper，避免复制 SQL）
const {
  scanWindow,
  expandCte,
  fingerprintOf,
  clampInt,
  SORTS,
} = require('./admin-custom-instructions');

const router = express.Router();

/** 从 items CTE 派生出「仅当前用户」+ 分组聚合的通用尾部 SQL */
function listQuery(orderBy) {
  return `
    WITH ${expandCte(1, 2)}, scoped AS (
      SELECT * FROM items WHERE user_id = $3::int
    ), filtered AS (
      SELECT * FROM scoped
      WHERE ($4::text IS NULL OR file ILIKE $4 OR content ILIKE $4)
        AND ($5::text IS NULL OR source = $5)
    )
    SELECT
      file,
      source,
      MIN(created_at) AS first_seen,
      MAX(created_at) AS last_seen,
      COUNT(*)::int AS occurrence_count,
      MAX(chars)::int AS chars,
      BOOL_OR(truncated) AS truncated,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT position), '') AS positions,
      (ARRAY_AGG(record_id ORDER BY created_at DESC))[1] AS sample_record_id,
      COUNT(*) OVER ()::int AS total_groups,
      content
    FROM filtered
    GROUP BY file, source, content
    ORDER BY ${orderBy}, last_seen DESC
    LIMIT $6::int OFFSET $7::int`;
}

// ---------- 列表 ----------
router.get('/custom-instructions', requireAuth, async (req, res) => {
  try {
    await ensureIndex();
    const { days, maxRecords } = scanWindow();
    const userId = req.session.user.id;

    const page = clampInt(req.query.page, 1, 1e9, 1);
    const pageSize = clampInt(req.query.pageSize, 1, 200, 20);
    const offset = (page - 1) * pageSize;
    const search = String(req.query.search || '').trim();
    const source = String(req.query.source || '').trim();
    const orderBy = SORTS[req.query.sort] || SORTS.count;

    const params = [days, maxRecords, userId];
    params.push(search ? `%${search}%` : null);
    params.push(source || null);
    params.push(pageSize, offset);

    const result = await pool.query(listQuery(orderBy), params);

    const total = result.rows.length ? parseInt(result.rows[0].total_groups, 10) : 0;
    const items = result.rows.map((row) => ({
      fingerprint: fingerprintOf(row.file, row.source, row.content),
      file: row.file || '',
      source: row.source,
      chars: parseInt(row.chars, 10) || 0,
      occurrence_count: parseInt(row.occurrence_count, 10) || 0,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      truncated: !!row.truncated,
      positions: row.positions || [],
      sample_record_id: row.sample_record_id,
      preview: String(row.content || '').slice(0, 160),
    }));

    res.json({
      total,
      page,
      pageSize,
      scan_window_days: days,
      scan_max_records: maxRecords,
      scope: 'self',
      items,
    });
  } catch (error) {
    Logger.error('[自定义提示词-用户] 列表查询错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ---------- 指纹详情（校验归属：该指纹至少有一条当前用户的记录才可见） ----------
router.get('/custom-instructions/:fingerprint', requireAuth, async (req, res) => {
  try {
    await ensureIndex();
    const { days, maxRecords } = scanWindow();
    const userId = req.session.user.id;
    const fingerprint = String(req.params.fingerprint || '').toLowerCase().trim();
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      return res.status(400).json({ error: '无效的指纹' });
    }
    const refsLimit = clampInt(req.query.refsLimit, 1, 50, 10);

    // 仅在当前用户自己的记录范围内聚合匹配指纹
    const aggResult = await pool.query(
      `
      WITH ${expandCte(1, 2)}, scoped AS (
        SELECT * FROM items WHERE user_id = $3::int
      )
      SELECT
        file, source, content,
        MIN(created_at) AS first_seen,
        MAX(created_at) AS last_seen,
        COUNT(*)::int AS occurrence_count,
        MAX(chars)::int AS chars,
        BOOL_OR(truncated) AS truncated,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT position), '') AS positions,
        (ARRAY_AGG(record_id ORDER BY created_at DESC))[1] AS sample_record_id
      FROM scoped
      GROUP BY file, source, content
      `,
      [days, maxRecords, userId]
    );

    const group = aggResult.rows.find(
      (row) => fingerprintOf(row.file, row.source, row.content) === fingerprint
    );
    if (!group) {
      return res.status(404).json({ error: '未找到该提示词（可能不属于你、超出扫描窗口或已被清理）' });
    }

    // 引用记录同样限定当前用户
    const refsResult = await pool.query(
      `
      WITH matched AS (
        SELECT id, created_at, model_id, request_source
        FROM usage_records
        WHERE created_at >= NOW() - make_interval(days => $1::int)
          AND user_id = $6::int
          AND plugin_meta IS NOT NULL
          AND jsonb_typeof(plugin_meta->'customInstructions') = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(plugin_meta->'customInstructions') e
            WHERE jsonb_typeof(e) = 'object'
              AND COALESCE(e->>'file', '') = $2::text
              AND COALESCE(e->>'source', 'other') = $3::text
              AND e->>'content' = $4::text
          )
        ORDER BY created_at DESC
        LIMIT $5::int
      )
      SELECT m.id AS record_id,
             m.created_at,
             m.model_id,
             COALESCE(m.request_source, 'unknown') AS request_source
      FROM matched m
      ORDER BY m.created_at DESC
      `,
      [days, group.file || '', group.source, group.content, refsLimit, userId]
    );

    res.json({
      fingerprint,
      file: group.file || '',
      source: group.source,
      content: String(group.content || ''),
      chars: parseInt(group.chars, 10) || 0,
      occurrence_count: parseInt(group.occurrence_count, 10) || 0,
      first_seen: group.first_seen,
      last_seen: group.last_seen,
      truncated: !!group.truncated,
      positions: group.positions || [],
      recent_refs: refsResult.rows.map((r) => ({
        record_id: r.record_id,
        created_at: r.created_at,
        model_id: r.model_id,
        request_source: r.request_source,
      })),
      scope: 'self',
    });
  } catch (error) {
    Logger.error('[自定义提示词-用户] 详情查询错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GIN 索引懒建（与 admin 版一致）；从 admin 模块取函数避免重复 DDL 逻辑
let _indexReady = null;
function ensureIndex() {
  if (_indexReady) return _indexReady;
  _indexReady = pool.query(
    `CREATE INDEX IF NOT EXISTS idx_usage_records_plugin_meta_gin ON usage_records USING gin(plugin_meta jsonb_path_ops)`
  );
  return _indexReady;
}

module.exports = router;
