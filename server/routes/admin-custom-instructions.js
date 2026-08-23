'use strict';

/**
 * 自定义提示词聚合接口（管理端）
 *
 * 扫描 usage_records.plugin_meta->'customInstructions'（JSONB 数组，
 * 由 server/utils/custom-instructions-extractor.js 在落库时提取），按内容指纹去重合并：
 *   指纹 = sha256(file + content)，file 为空时用 sha256(source + content)。
 *
 * SQL 侧以 (file, source, content) 分组展开聚合（jsonb_array_elements），
 * 该元组与指纹一一对应，指纹在 Node 侧统一计算。
 *
 * 性能护栏：先取扫描窗口内最新 M 条 usage_records 再展开
 * （CR_CI_SCAN_DAYS 默认 30 天、CR_CI_SCAN_MAX_RECORDS 默认 200000 条）。
 */

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../models/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Logger = require('../logger');

const router = express.Router();

const DEFAULT_SCAN_DAYS = 30;
const DEFAULT_SCAN_MAX_RECORDS = 200000;

/** plugin_meta JSONB GIN 索引（自动迁移，进程内只尝试一次；失败仅告警不阻断查询） */
let indexAttempted = false;
async function ensurePluginMetaIndex() {
  if (indexAttempted) return;
  indexAttempted = true;
  try {
    await pool.query(
      'CREATE INDEX IF NOT EXISTS idx_usage_records_plugin_meta_gin ON usage_records USING gin(plugin_meta jsonb_path_ops)'
    );
  } catch (err) {
    Logger.warn('[自定义提示词] plugin_meta GIN 索引创建失败（不影响查询）:', err.message);
  }
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 扫描窗口配置（环境变量可覆盖） */
function scanWindow() {
  return {
    days: clampInt(process.env.CR_CI_SCAN_DAYS, 1, 3650, DEFAULT_SCAN_DAYS),
    maxRecords: clampInt(process.env.CR_CI_SCAN_MAX_RECORDS, 1000, 2000000, DEFAULT_SCAN_MAX_RECORDS),
  };
}

/** 内容指纹：sha256(file + content)，file 为空用 source + content */
function fingerprintOf(file, source, content) {
  const key = String(file || '').trim()
    ? `${file}${content}`
    : `${source}${content}`;
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * 公共 CTE：扫描窗口内带 customInstructions 的记录展开为条目流。
 * @param {number} daysIdx 扫描天数参数下标
 * @param {number} limitIdx 窗口记录数上限参数下标
 */
function expandCte(daysIdx, limitIdx) {
  return `
    win AS (
      SELECT id, user_id, created_at, request_source, plugin_meta
      FROM usage_records
      WHERE created_at >= NOW() - make_interval(days => $${daysIdx}::int)
        AND plugin_meta IS NOT NULL
        AND jsonb_typeof(plugin_meta->'customInstructions') = 'array'
      ORDER BY created_at DESC
      LIMIT $${limitIdx}::int
    ),
    items AS (
      SELECT w.id AS record_id,
             w.user_id,
             w.created_at,
             COALESCE(w.request_source, 'unknown') AS request_source,
             COALESCE(e->>'file', '') AS file,
             COALESCE(e->>'source', 'other') AS source,
             e->>'content' AS content,
             COALESCE((e->>'chars')::int, LENGTH(e->>'content')) AS chars,
             COALESCE(e->>'position', '') AS position,
             COALESCE((e->>'truncated')::boolean, false) AS truncated
      FROM win w
      CROSS JOIN LATERAL jsonb_array_elements(w.plugin_meta->'customInstructions') e
      WHERE jsonb_typeof(e) = 'object'
        AND COALESCE(e->>'content', '') <> ''
    )`;
}

// 排序白名单（防注入）：字段 -> ORDER BY 表达式
const SORTS = {
  count: 'occurrence_count DESC',
  first_seen: 'first_seen DESC',
  last_seen: 'last_seen DESC',
};

/**
 * GET /api/admin/custom-instructions
 * 去重合并后的自定义提示词列表。query: page/pageSize/search/source/sort
 */
router.get('/custom-instructions', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensurePluginMetaIndex();
    const { days, maxRecords } = scanWindow();

    const page = clampInt(req.query.page, 1, 1e9, 1);
    const pageSize = clampInt(req.query.pageSize, 1, 200, 20);
    const offset = (page - 1) * pageSize;
    const search = String(req.query.search || '').trim();
    const source = String(req.query.source || '').trim();
    const orderBy = SORTS[req.query.sort] || SORTS.count;

    const params = [days, maxRecords];
    // $3 search / $4 source：空值传 NULL 以复用同一份 SQL
    params.push(search ? `%${search}%` : null);
    params.push(source || null);
    params.push(pageSize, offset);

    const result = await pool.query(
      `
      WITH ${expandCte(1, 2)},
      filtered AS (
        SELECT * FROM items
        WHERE ($3::text IS NULL OR file ILIKE $3 OR content ILIKE $3)
          AND ($4::text IS NULL OR source = $4)
      )
      SELECT
        file,
        source,
        MIN(created_at) AS first_seen,
        MAX(created_at) AS last_seen,
        COUNT(*)::int AS occurrence_count,
        COUNT(DISTINCT user_id)::int AS user_count,
        MAX(chars)::int AS chars,
        BOOL_OR(truncated) AS truncated,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT position), '') AS positions,
        (ARRAY_AGG(record_id ORDER BY created_at DESC))[1] AS sample_record_id,
        COUNT(*) OVER ()::int AS total_groups,
        content
      FROM filtered
      GROUP BY file, source, content
      ORDER BY ${orderBy}, last_seen DESC
      LIMIT $5::int OFFSET $6::int
      `,
      params
    );

    const total = result.rows.length ? parseInt(result.rows[0].total_groups, 10) : 0;
    const items = result.rows.map((row) => ({
      fingerprint: fingerprintOf(row.file, row.source, row.content),
      file: row.file || '',
      source: row.source,
      chars: parseInt(row.chars, 10) || 0,
      occurrence_count: parseInt(row.occurrence_count, 10) || 0,
      user_count: parseInt(row.user_count, 10) || 0,
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
      items,
    });
  } catch (error) {
    Logger.error('[自定义提示词] 列表查询错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

/**
 * GET /api/admin/custom-instructions/:fingerprint
 * 指纹详情：完整内容 + 聚合信息 + 最近 N 条引用记录。query: refsLimit
 */
router.get('/custom-instructions/:fingerprint', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensurePluginMetaIndex();
    const { days, maxRecords } = scanWindow();
    const fingerprint = String(req.params.fingerprint || '').toLowerCase().trim();
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      return res.status(400).json({ error: '无效的指纹' });
    }
    const refsLimit = clampInt(req.query.refsLimit, 1, 50, 10);

    // 复用窗口展开逻辑，在 Node 侧匹配指纹
    const aggResult = await pool.query(
      `
      WITH ${expandCte(1, 2)}
      SELECT
        file,
        source,
        content,
        MIN(created_at) AS first_seen,
        MAX(created_at) AS last_seen,
        COUNT(*)::int AS occurrence_count,
        COUNT(DISTINCT user_id)::int AS user_count,
        MAX(chars)::int AS chars,
        BOOL_OR(truncated) AS truncated,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT position), '') AS positions,
        (ARRAY_AGG(record_id ORDER BY created_at DESC))[1] AS sample_record_id
      FROM items
      GROUP BY file, source, content
      `,
      [days, maxRecords]
    );

    const group = aggResult.rows.find(
      (row) => fingerprintOf(row.file, row.source, row.content) === fingerprint
    );
    if (!group) {
      return res.status(404).json({ error: '未找到该提示词（可能超出扫描窗口或已被清理）' });
    }

    const refsResult = await pool.query(
      `
      WITH matched AS (
        SELECT id, created_at, user_id, model_id, request_source
        FROM usage_records
        WHERE created_at >= NOW() - make_interval(days => $1::int)
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
             m.user_id,
             u.username,
             m.model_id,
             COALESCE(m.request_source, 'unknown') AS request_source
      FROM matched m
      LEFT JOIN users u ON u.id = m.user_id
      ORDER BY m.created_at DESC
      `,
      [days, group.file || '', group.source, group.content, refsLimit]
    );

    res.json({
      fingerprint,
      file: group.file || '',
      source: group.source,
      content: group.content,
      chars: parseInt(group.chars, 10) || 0,
      truncated: !!group.truncated,
      positions: group.positions || [],
      occurrence_count: parseInt(group.occurrence_count, 10) || 0,
      user_count: parseInt(group.user_count, 10) || 0,
      first_seen: group.first_seen,
      last_seen: group.last_seen,
      sample_record_id: group.sample_record_id,
      recent_refs: refsResult.rows.map((r) => ({
        record_id: r.record_id,
        created_at: r.created_at,
        user_id: r.user_id,
        username: r.username || null,
        model_id: r.model_id,
        request_source: r.request_source,
      })),
    });
  } catch (error) {
    Logger.error('[自定义提示词] 详情查询错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
