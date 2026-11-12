'use strict';

const { pool } = require('../../models/database');
const Logger = require('../../logger');

const CACHE_TTL_MS = 5000;
const cache = new Map();

const WINDOW_SECONDS = {
  '1m': 60,
  '5m': 300,
  '1h': 3600,
  '24h': 86400,
  '7d': 604800,
  '30d': 2592000,
};

function cacheKey(query) {
  return JSON.stringify(query);
}

function intervalSql(window) {
  if (WINDOW_SECONDS[window]) return { sql: `NOW() - ($1::int * INTERVAL '1 second')`, params: [WINDOW_SECONDS[window]] };
  if (window === 'day') return { sql: `date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, params: [] };
  if (window === 'week') return { sql: `date_trunc('week', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, params: [] };
  if (window === 'month') return { sql: `date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, params: [] };
  return { sql: `NOW() - ($1::int * INTERVAL '1 second')`, params: [86400] };
}

function metricSql(metric) {
  if (metric === 'requests') return 'COUNT(*)';
  if (metric === 'tokens') return 'COALESCE(SUM(u.tokens_used), 0)';
  if (metric === 'weighted_tokens') return 'COALESCE(SUM(u.weighted_tokens), 0)';
  if (metric === 'cost' || metric === 'points') return 'COALESCE(SUM(u.cost), 0)';
  return 'COUNT(*)';
}

async function queryUsage({ metric, window, aggregate, subject }) {
  if (!subject || !subject.id) return 0;
  const key = cacheKey({ metric, window, aggregate, subject });
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const range = intervalSql(window);
  const metricExpr = metricSql(metric);
  const params = [...range.params];
  let where = '';
  let join = '';
  if (aggregate === 'team') {
    join = 'JOIN users uu ON uu.id = u.user_id';
    where = `uu.team_id = $${params.length + 1}`;
  } else if (aggregate === 'member') {
    where = `u.user_id = $${params.length + 1}`;
  } else if (aggregate === 'api_key') {
    where = `u.api_key_id = $${params.length + 1}`;
  } else if (aggregate === 'client') {
    where = `u.request_source = $${params.length + 1}`;
  } else if (aggregate === 'model') {
    where = `(u.model_id = $${params.length + 1} OR u.requested_model = $${params.length + 1})`;
  } else if (aggregate === 'provider') {
    where = `u.provider_id = $${params.length + 1}`;
  } else {
    return 0;
  }
  params.push(subject.id);
  const since = range.params.length ? `u.created_at >= ${range.sql}` : `u.created_at >= ${range.sql}`;
  const sql = `SELECT ${metricExpr} AS total FROM usage_records u ${join} WHERE ${where} AND ${since}`;
  try {
    const result = await pool.query(sql, params);
    const value = Number(result.rows[0]?.total || 0);
    cache.set(key, { value, at: Date.now() });
    if (cache.size > 5000) {
      const cutoff = Date.now() - CACHE_TTL_MS * 4;
      for (const [k, entry] of cache) if (entry.at < cutoff) cache.delete(k);
    }
    return value;
  } catch (error) {
    Logger.warn(`[策略] 用量查询失败: ${error.message}`);
    return 0;
  }
}

function invalidateUsageCache() {
  cache.clear();
}

module.exports = { queryUsage, invalidateUsageCache, WINDOW_SECONDS };
