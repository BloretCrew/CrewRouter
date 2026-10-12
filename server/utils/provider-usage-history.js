'use strict';

// 归档账本只保存请求 ID；每日聚合保存分析维度，清理明细后仍可关联额度。
async function ensureProviderUsageHistory(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS provider_usage_archived (
    usage_id BIGINT PRIMARY KEY, archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS provider_usage_daily_agg (
    agg_date DATE NOT NULL, user_id INTEGER NOT NULL, provider_id VARCHAR(100) NOT NULL,
    model_id VARCHAR(100) NOT NULL, api_key_id INTEGER NOT NULL, request_source TEXT NOT NULL,
    workspace_path TEXT NOT NULL, request_count BIGINT NOT NULL DEFAULT 0,
    tokens_used BIGINT NOT NULL DEFAULT 0, cost NUMERIC NOT NULL DEFAULT 0,
    PRIMARY KEY (agg_date,user_id,provider_id,model_id,api_key_id,request_source,workspace_path)
  )`);
  await client.query('CREATE INDEX IF NOT EXISTS idx_provider_usage_user_date ON provider_usage_daily_agg(user_id,agg_date)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_provider_usage_provider_date ON provider_usage_daily_agg(provider_id,agg_date)');
}

async function archiveProviderUsage(client, { ids, start, end } = {}) {
  if (!ids && (!start || !end)) throw new Error('归档需要请求 ID 或日期范围');
  if (ids && !ids.length) return { rows: 0 };
  const where = ids ? 'u.id = ANY($1::bigint[])' : "u.created_at >= $1::date AND u.created_at < ($2::date + INTERVAL '1 day')";
  const params = ids ? [ids] : [start, end];
  const result = await client.query(`WITH newly_archived AS (
    INSERT INTO provider_usage_archived(usage_id)
    SELECT u.id FROM usage_records u WHERE ${where}
    ON CONFLICT DO NOTHING RETURNING usage_id
  ), source AS (
    SELECT u.created_at::date AS agg_date, COALESCE(u.user_id,0) AS user_id,
      COALESCE(u.provider_id,'') AS provider_id, COALESCE(u.model_id,'') AS model_id,
      COALESCE(u.api_key_id,0) AS api_key_id, COALESCE(NULLIF(u.request_source,''),'unknown') AS request_source,
      COALESCE(NULLIF(TRIM(a.workspace_path),''),'__unknown__') AS workspace_path,
      COALESCE(u.tokens_used,0) AS tokens_used, COALESCE(u.cost,0) AS cost
    FROM newly_archived n JOIN usage_records u ON u.id=n.usage_id
    LEFT JOIN LATERAL (SELECT workspace_path FROM usage_message_analysis WHERE usage_id=u.id LIMIT 1) a ON TRUE
  ) INSERT INTO provider_usage_daily_agg
    (agg_date,user_id,provider_id,model_id,api_key_id,request_source,workspace_path,request_count,tokens_used,cost)
    SELECT agg_date,user_id,provider_id,model_id,api_key_id,request_source,workspace_path,
      COUNT(*),SUM(tokens_used),SUM(cost) FROM source GROUP BY 1,2,3,4,5,6,7
    ON CONFLICT (agg_date,user_id,provider_id,model_id,api_key_id,request_source,workspace_path)
    DO UPDATE SET request_count=provider_usage_daily_agg.request_count+EXCLUDED.request_count,
      tokens_used=provider_usage_daily_agg.tokens_used+EXCLUDED.tokens_used,
      cost=provider_usage_daily_agg.cost+EXCLUDED.cost`, params);
  return { rows: result.rowCount || 0 };
}

// 聚合与尚未归档的请求互斥，避免清理前后重复计数。
function makeProviderUsageSourceSql() {
  return `(SELECT agg_date,user_id,provider_id,model_id,api_key_id,request_source,workspace_path,
      request_count,tokens_used,cost FROM provider_usage_daily_agg
    UNION ALL
    SELECT u.created_at::date,COALESCE(u.user_id,0),COALESCE(u.provider_id,''),COALESCE(u.model_id,''),
      COALESCE(u.api_key_id,0),COALESCE(NULLIF(u.request_source,''),'unknown'),
      COALESCE(NULLIF(TRIM(a.workspace_path),''),'__unknown__'),1::bigint,
      COALESCE(u.tokens_used,0)::bigint,COALESCE(u.cost,0)::numeric
    FROM usage_records u LEFT JOIN LATERAL
      (SELECT workspace_path FROM usage_message_analysis WHERE usage_id=u.id LIMIT 1) a ON TRUE
    WHERE NOT EXISTS (SELECT 1 FROM provider_usage_archived pa WHERE pa.usage_id=u.id))`;
}

module.exports = { ensureProviderUsageHistory, archiveProviderUsage, makeProviderUsageSourceSql };
