/**
 * 弹窗通知（管理后台广播的一次性弹窗）存储层
 *
 * 设计：
 *  - popup_notices：管理员创建的弹窗内容（标题 / 正文 / 关闭按钮文字 / 启停）
 *  - popup_notice_views：按用户记录的已读明细（复合主键，删除通知级联清理）
 *  - 用户端只返回 enabled 且该用户未读的通知；已读写入幂等
 *  - 表由 server/index.js 的 runPendingMigrations() 统一创建，demo 模式不建表，
 *    因此调用方必须能容忍表不存在（演示路由走 server/demo/extra.js 的桩）
 */

const { pool } = require('../models/database');
const Logger = require('../logger');

const MAX_UNSEEN = 50;
const MAX_SEEN_IDS = 100;
const TITLE_MAX = 200;
const BODY_MAX = 4000;
const CLOSE_TEXT_MAX = 40;
const DEFAULT_CLOSE_TEXT = '知道了';

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS popup_notices (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    close_text VARCHAR(40) NOT NULL DEFAULT '知道了',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS popup_notice_views (
    notice_id BIGINT NOT NULL REFERENCES popup_notices(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (notice_id, user_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_popup_notice_views_user ON popup_notice_views(user_id)',
];

async function ensurePopupNoticeSchema(db = pool) {
  for (const sql of SCHEMA_SQL) {
    await db.query(sql);
  }
}

function normalizeText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/** 校验并裁剪管理员输入；非法抛 400，调用方转 400 */
function normalizeNoticeInput(input = {}) {
  const title = normalizeText(input.title, TITLE_MAX);
  if (!title) throw validationError('标题不能为空');
  const body = normalizeText(input.body, BODY_MAX);
  const closeText = normalizeText(input.closeText, CLOSE_TEXT_MAX) || DEFAULT_CLOSE_TEXT;
  const enabled = input.enabled === undefined ? true : input.enabled === true || input.enabled === 'true';
  return { title, body, closeText, enabled };
}

/** 解析用户端提交的 id 列表：正整数、去重、最多 100 个 */
function normalizeIds(ids) {
  if (!Array.isArray(ids)) throw validationError('ids 必须为数组');
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) throw validationError('ids 含非法值');
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length > MAX_SEEN_IDS) throw validationError(`一次最多提交 ${MAX_SEEN_IDS} 条`);
  }
  return out;
}

function toAdminItem(row) {
  return {
    id: Number(row.id),
    title: row.title,
    body: row.body || '',
    closeText: row.close_text || DEFAULT_CLOSE_TEXT,
    enabled: row.enabled === true,
    seenCount: Number(row.seen_count || 0),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function toUserItem(row) {
  return {
    id: Number(row.id),
    title: row.title,
    body: row.body || '',
    closeText: row.close_text || DEFAULT_CLOSE_TEXT,
  };
}

async function listUnseenForUser(userId, db = pool) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) return [];
  const result = await db.query(
    `SELECT n.id, n.title, n.body, n.close_text
     FROM popup_notices n
     WHERE n.enabled = TRUE
       AND NOT EXISTS (
         SELECT 1 FROM popup_notice_views v
         WHERE v.notice_id = n.id AND v.user_id = $1
       )
     ORDER BY n.id ASC
     LIMIT $2`,
    [Number(userId), MAX_UNSEEN]
  );
  return result.rows.map(toUserItem);
}

/**
 * 批量标记已读（幂等）。
 * 用 INSERT ... SELECT 过滤已删除的通知，避免外键错误；返回实际新增的行数。
 */
async function markSeenForUser(userId, ids, db = pool) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) return 0;
  const clean = normalizeIds(ids);
  if (!clean.length) return 0;
  const result = await db.query(
    `INSERT INTO popup_notice_views (notice_id, user_id)
     SELECT n.id, $2 FROM popup_notices n WHERE n.id = ANY($1::bigint[])
     ON CONFLICT DO NOTHING`,
    [clean, Number(userId)]
  );
  return result.rowCount || 0;
}

async function listForAdmin(db = pool) {
  const result = await db.query(
    `SELECT n.id, n.title, n.body, n.close_text, n.enabled, n.created_at, n.updated_at,
            COUNT(v.user_id)::int AS seen_count
     FROM popup_notices n
     LEFT JOIN popup_notice_views v ON v.notice_id = n.id
     GROUP BY n.id
     ORDER BY n.id ASC`
  );
  return result.rows.map(toAdminItem);
}

async function getForAdmin(id, db = pool) {
  const result = await db.query(
    `SELECT n.id, n.title, n.body, n.close_text, n.enabled, n.created_at, n.updated_at,
            COUNT(v.user_id)::int AS seen_count
     FROM popup_notices n
     LEFT JOIN popup_notice_views v ON v.notice_id = n.id
     WHERE n.id = $1
     GROUP BY n.id`,
    [Number(id)]
  );
  return result.rows[0] ? toAdminItem(result.rows[0]) : null;
}

async function createNotice(input, db = pool) {
  const data = normalizeNoticeInput(input);
  const result = await db.query(
    `INSERT INTO popup_notices (title, body, close_text, enabled)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [data.title, data.body, data.closeText, data.enabled]
  );
  return getForAdmin(result.rows[0].id, db);
}

async function updateNotice(id, input, db = pool) {
  const data = normalizeNoticeInput(input);
  const result = await db.query(
    `UPDATE popup_notices
     SET title = $2, body = $3, close_text = $4, enabled = $5, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id`,
    [Number(id), data.title, data.body, data.closeText, data.enabled]
  );
  if (!result.rows.length) return null;
  return getForAdmin(result.rows[0].id, db);
}

async function setNoticeEnabled(id, enabled, db = pool) {
  const result = await db.query(
    `UPDATE popup_notices SET enabled = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 RETURNING id`,
    [Number(id), enabled === true]
  );
  if (!result.rows.length) return null;
  return getForAdmin(result.rows[0].id, db);
}

async function deleteNotice(id, db = pool) {
  const result = await db.query('DELETE FROM popup_notices WHERE id = $1', [Number(id)]);
  return result.rowCount > 0;
}

/** 重置已读（仅该通知），用于管理员改文案后重新触达 */
async function resetSeen(id, db = pool) {
  const result = await db.query('DELETE FROM popup_notice_views WHERE notice_id = $1', [Number(id)]);
  return result.rowCount || 0;
}

function logError(message, error) {
  try { Logger.error(`[弹窗通知] ${message}:`, error); } catch (_) { /* logger 可选 */ }
}

module.exports = {
  DEFAULT_CLOSE_TEXT,
  MAX_UNSEEN,
  MAX_SEEN_IDS,
  ensurePopupNoticeSchema,
  normalizeNoticeInput,
  normalizeIds,
  listUnseenForUser,
  markSeenForUser,
  listForAdmin,
  getForAdmin,
  createNotice,
  updateNotice,
  setNoticeEnabled,
  deleteNotice,
  resetSeen,
  logError,
};
