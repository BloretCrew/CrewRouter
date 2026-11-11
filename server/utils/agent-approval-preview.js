'use strict';

const {
  normalizeMultiplierBatch,
  toApprovalPreview
} = require('./agent-multiplier');

const MULTIPLIER_TOOLS = new Set(['batch_set_model_multipliers']);

async function loadSources(db, { userId, threadId, ids }) {
  if (!ids.length || !Number.isInteger(Number(userId)) || !Number.isInteger(Number(threadId))) return [];
  try {
    const result = await db.query(
      `SELECT id, filename, source, NULLIF(meta->>'url', '') AS url
       FROM agent_attachments
       WHERE id = ANY($1::int[]) AND user_id = $2 AND thread_id = $3
       ORDER BY id`,
      [ids, userId, threadId]
    );
    return result.rows.map(row => ({
      id: row.id,
      filename: row.filename,
      source: row.source,
      url: row.url
        ? String(row.url).replace(/\b(?:sk|key|tok)-[A-Za-z0-9_\-]{8,}\b/g, '[redacted]').slice(0, 2048)
        : null
    }));
  } catch (_) {
    return [];
  }
}

/**
 * 为待审批的写工具生成结构化预览。其它工具返回 null。
 */
async function buildApprovalPreview(db, { toolName, args, userId, threadId }) {
  if (!MULTIPLIER_TOOLS.has(toolName)) return null;
  const normalized = await normalizeMultiplierBatch(db, args, { requireExpected: false });
  if (!normalized.ok) return null;
  const preview = toApprovalPreview(normalized);
  const sourceIds = [...new Set(normalized.changes.flatMap(item => item.source_attachment_ids || []))];
  preview.sources = await loadSources(db, { userId, threadId, ids: sourceIds });
  return preview;
}

module.exports = { buildApprovalPreview, MULTIPLIER_TOOLS };
