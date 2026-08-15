/**
 * 调用记录列表过滤 / JOIN（管理端与用户端共用）
 */

const ALLOWED_REQUEST_TYPES = new Set(['chat', 'responses', 'fusion', 'playground']);
const ALLOWED_REQUEST_SOURCES = new Set([
  'grok',
  'codex',
  'claude_code',
  'opencode',
  'qwen_code',
  'hermes',
  'openclaw',
  'deepseek_harness',
  'unknown',
]);

function normalizeRequestSource(raw) {
  if (raw == null || raw === '') return null;
  const source = String(raw).trim().toLowerCase();
  return ALLOWED_REQUEST_SOURCES.has(source) ? source : null;
}

/**
 * models 关联：优先本地 id+供应商一致 → 上游名+供应商 → 仅 id 兜底
 */
const MODELS_LATERAL_JOIN = `
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
      ) m ON TRUE`;

const MODEL_NAME_SELECT = `
        COALESCE(
          m.name,
          CASE WHEN u.request_type = 'fusion' THEN 'Fusion' ELSE NULL END,
          u.model_id
        ) as model_name`;

/**
 * 规范化 request_type 查询参数
 * @param {string|undefined|null} raw
 * @returns {string|null}
 */
function normalizeRequestType(raw) {
  if (raw == null || raw === '') return null;
  const t = String(raw).trim().toLowerCase();
  if (!ALLOWED_REQUEST_TYPES.has(t)) return null;
  return t;
}

/**
 * 管理端过滤
 * @param {object} query
 */
function buildUsageLogsFilter(query) {
  const userId = query.user_id;
  const userQ = (query.user_q || '').trim();
  const modelId = query.model_id;
  const modelQ = (query.model_q || '').trim();
  const providerQ = (query.provider_q || '').trim();
  const startDate = query.start_date;
  const endDate = query.end_date;
  const requestType = normalizeRequestType(query.request_type);

  let where = 'WHERE 1=1';
  const params = [];
  let idx = 1;

  if (userId) { where += ` AND u.user_id = $${idx++}`; params.push(userId); }
  if (userQ) {
    where += ` AND (us.username ILIKE $${idx} OR CAST(u.user_id AS TEXT) ILIKE $${idx})`;
    params.push(`%${userQ}%`);
    idx++;
  }
  if (modelId) { where += ` AND u.model_id = $${idx++}`; params.push(modelId); }
  if (modelQ) {
    where += ` AND (m.name ILIKE $${idx} OR COALESCE(m.upstream_model_id,'') ILIKE $${idx} OR CAST(u.model_id AS TEXT) ILIKE $${idx} OR COALESCE(m.alias,'') ILIKE $${idx})`;
    params.push(`%${modelQ}%`);
    idx++;
  }
  if (providerQ) {
    where += ` AND (p.name ILIKE $${idx} OR CAST(u.provider_id AS TEXT) ILIKE $${idx})`;
    params.push(`%${providerQ}%`);
    idx++;
  }
  if (startDate) { where += ` AND u.created_at >= $${idx++}::date`; params.push(startDate); }
  if (endDate) { where += ` AND u.created_at < ($${idx++}::date + INTERVAL '1 day')`; params.push(endDate); }
  if (requestType) { where += ` AND u.request_type = $${idx++}`; params.push(requestType); }
  const requestSource = normalizeRequestSource(query.request_source);
  if (requestSource) { where += ` AND u.request_source = $${idx++}`; params.push(requestSource); }

  const fromSql = `
      FROM usage_records u
      LEFT JOIN users us ON u.user_id = us.id
      LEFT JOIN api_keys ak ON u.api_key_id = ak.id
      ${MODELS_LATERAL_JOIN}
      LEFT JOIN providers p ON u.provider_id = p.id`;

  return { where, params, idx, fromSql, requestType, requestSource };
}

/**
 * 用户端过滤（强制 user_id）
 * @param {number} userId
 * @param {object} query
 */
function buildUserUsageLogsFilter(userId, query) {
  const modelQ = (query.model_q || '').trim();
  const modelId = query.model_id;
  const startDate = query.start_date;
  const endDate = query.end_date;
  const apiKeyId = query.api_key_id;
  const requestType = normalizeRequestType(query.request_type);

  let where = 'WHERE u.user_id = $1';
  const params = [userId];
  let idx = 2;

  if (modelId) {
    where += ` AND u.model_id = $${idx++}`;
    params.push(modelId);
  }
  if (modelQ) {
    where += ` AND (m.name ILIKE $${idx} OR COALESCE(m.upstream_model_id,'') ILIKE $${idx} OR CAST(u.model_id AS TEXT) ILIKE $${idx} OR COALESCE(m.alias,'') ILIKE $${idx})`;
    params.push(`%${modelQ}%`);
    idx++;
  }
  if (apiKeyId) {
    where += ` AND u.api_key_id = $${idx++}`;
    params.push(apiKeyId);
  }
  if (startDate) {
    where += ` AND u.created_at >= $${idx++}::date`;
    params.push(startDate);
  }
  if (endDate) {
    where += ` AND u.created_at < ($${idx++}::date + INTERVAL '1 day')`;
    params.push(endDate);
  }
  if (requestType) {
    where += ` AND u.request_type = $${idx++}`;
    params.push(requestType);
  }
  const requestSource = normalizeRequestSource(query.request_source);
  if (requestSource) {
    where += ` AND u.request_source = $${idx++}`;
    params.push(requestSource);
  }

  const fromSql = `
      FROM usage_records u
      LEFT JOIN api_keys ak ON u.api_key_id = ak.id
      ${MODELS_LATERAL_JOIN}
      LEFT JOIN providers p ON u.provider_id = p.id`;

  return { where, params, idx, fromSql, requestType, requestSource };
}

module.exports = {
  ALLOWED_REQUEST_TYPES,
  ALLOWED_REQUEST_SOURCES,
  MODELS_LATERAL_JOIN,
  MODEL_NAME_SELECT,
  normalizeRequestType,
  normalizeRequestSource,
  buildUsageLogsFilter,
  buildUserUsageLogsFilter
};
