'use strict';

const { shanghaiDateRange, shanghaiDateString } = require('./timezone');

const MAX_RANGE_DAYS = 90;
const DEFAULT_DAYS = 7;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 100;
const QUERY_TIMEOUT_MS = 20_000;

const cache = new Map();

const PERCENTILES = [
  ['p50', 0.5],
  ['p75', 0.75],
  ['p95', 0.95],
  ['p99', 0.99],
];

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addDays(dateString, delta) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  const a = new Date(`${start}T12:00:00Z`).getTime();
  const b = new Date(`${end}T12:00:00Z`).getTime();
  return Math.floor((b - a) / 86400000) + 1;
}

function normalizeText(value, maxLength = 100) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text.length > maxLength) return null;
  return text;
}

function parseBoolean(value) {
  if (value === true || value === '1' || value === 'true') return true;
  if (value === false || value === '0' || value === 'false') return false;
  return null;
}

function parseLatencyQuery(query = {}) {
  let start;
  let end;
  let requestedDays = null;
  let clipped = false;

  if (query.start || query.end) {
    if (!isDateString(query.start) || !isDateString(query.end)) {
      throw badRequest('请提供有效的开始和结束日期');
    }
    if (query.start > query.end) throw badRequest('开始日期不能晚于结束日期');
    start = query.start;
    end = query.end;
    requestedDays = daysBetween(start, end);
    if (requestedDays > MAX_RANGE_DAYS) {
      start = addDays(end, -(MAX_RANGE_DAYS - 1));
      clipped = true;
    }
  } else {
    const rawDays = parseInt(query.days, 10);
    const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : DEFAULT_DAYS;
    const range = shanghaiDateRange(days);
    start = range.start;
    end = range.end;
    requestedDays = days;
    if (days > MAX_RANGE_DAYS) {
      start = addDays(end, -(MAX_RANGE_DAYS - 1));
      clipped = true;
    }
  }

  const isStream = parseBoolean(query.is_stream);

  return {
    start,
    end,
    days: daysBetween(start, end),
    requestedDays,
    clipped,
    maxDays: MAX_RANGE_DAYS,
    timezone: 'Asia/Shanghai',
    modelId: normalizeText(query.model_id, 100),
    providerId: normalizeText(query.provider_id, 100),
    requestSource: normalizeText(query.request_source, 32),
    isStream,
  };
}

function buildWhere(parsed, scope, userId) {
  const params = [parsed.start, parsed.end];
  const clauses = [
    "ur.created_at >= $1::date",
    "ur.created_at < ($2::date + INTERVAL '1 day')",
  ];

  if (scope === 'user') {
    params.push(userId);
    clauses.push(`ur.user_id = $${params.length}`);
  }
  if (parsed.modelId) {
    params.push(parsed.modelId);
    clauses.push(`ur.model_id = $${params.length}`);
  }
  if (parsed.providerId) {
    params.push(parsed.providerId);
    clauses.push(`ur.provider_id = $${params.length}`);
  }
  if (parsed.requestSource) {
    params.push(parsed.requestSource);
    clauses.push(`COALESCE(NULLIF(ur.request_source, ''), 'unknown') = $${params.length}`);
  }
  if (parsed.isStream != null) {
    params.push(parsed.isStream);
    clauses.push(`ur.is_stream = $${params.length}`);
  }

  return { params, where: clauses.join(' AND ') };
}

function percentileSelect(expression, aliasBase = expression) {
  return PERCENTILES.map(([name, fraction]) =>
    `percentile_cont(${fraction}) WITHIN GROUP (ORDER BY ${expression}) FILTER (WHERE ${expression} IS NOT NULL) AS ${aliasBase}_${name}`
  ).join(',\n    ');
}

function toNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 3) {
  const n = toNumber(value);
  if (n == null) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function mapPercentiles(row, field, digits = 0) {
  const out = {};
  for (const [name] of PERCENTILES) {
    out[name] = round(row[`${field}_${name}`], digits);
  }
  return out;
}

function mapSummary(row) {
  const totalRequests = toNumber(row.requests) || 0;
  const measuredRequests = toNumber(row.measured) || 0;
  const promptTokens = toNumber(row.prompt_tokens) || 0;
  const cachedTokens = toNumber(row.cached_tokens) || 0;
  return {
    requests: totalRequests,
    measuredRequests,
    coverage: totalRequests > 0 ? measuredRequests / totalRequests : 0,
    ttft: mapPercentiles(row, 'ttft_ms', 0),
    e2e: mapPercentiles(row, 'e2e_ms', 0),
    tpot: mapPercentiles(row, 'tpot_ms', 1),
    outputTps: mapPercentiles(row, 'output_tps', 2),
    upstreamProcessing: mapPercentiles(row, 'upstream_processing_ms', 0),
    upstreamProcessingAvg: round(row.upstream_processing_avg, 0),
    cacheHitRate: promptTokens > 0 ? cachedTokens / promptTokens : null,
    tpsThresholds: {
      ge50: toNumber(row.tps_ge_50),
      ge80: toNumber(row.tps_ge_80),
      ge90: toNumber(row.tps_ge_90),
      ge100: toNumber(row.tps_ge_100),
    },
  };
}

function mapGroupRow(row, labelField) {
  return {
    id: row[labelField],
    name: row[`${labelField === 'model_id' ? 'model_name' : 'provider_name'}`] || row[labelField] || null,
    requests: toNumber(row.requests) || 0,
    measuredRequests: toNumber(row.measured) || 0,
    coverage: (toNumber(row.requests) || 0) > 0
      ? (toNumber(row.measured) || 0) / (toNumber(row.requests) || 1)
      : 0,
    ttft: mapPercentiles(row, 'ttft_ms', 0),
    e2e: mapPercentiles(row, 'e2e_ms', 0),
    tpot: mapPercentiles(row, 'tpot_ms', 1),
    outputTps: mapPercentiles(row, 'output_tps', 2),
    cacheHitRate: (toNumber(row.prompt_tokens) || 0) > 0
      ? (toNumber(row.cached_tokens) || 0) / (toNumber(row.prompt_tokens) || 1)
      : null,
  };
}

function mapDailyRow(row) {
  return {
    date: row.date,
    requests: toNumber(row.requests) || 0,
    measuredRequests: toNumber(row.measured) || 0,
    ttft: mapPercentiles(row, 'ttft_ms', 0),
    e2e: mapPercentiles(row, 'e2e_ms', 0),
    outputTps: mapPercentiles(row, 'output_tps', 2),
  };
}

function mapRateLimitRow(row) {
  return {
    providerId: row.provider_id,
    providerName: row.provider_name || row.provider_id || null,
    rateLimit: row.rate_limit || null,
    serviceTier: row.service_tier || null,
    observedAt: row.created_at || null,
  };
}

function cacheKey(scope, userId, parsed) {
  return JSON.stringify({
    scope,
    userId: scope === 'user' ? userId : null,
    start: parsed.start,
    end: parsed.end,
    modelId: parsed.modelId,
    providerId: parsed.providerId,
    requestSource: parsed.requestSource,
    isStream: parsed.isStream,
  });
}

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

function clearLatencyStatsCache() {
  cache.clear();
}

async function withTimeoutTransaction(db, fn) {
  if (!db || typeof db.query !== 'function') throw new Error('数据库连接不可用');
  if (typeof db.connect !== 'function') return fn(db);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore rollback failure */ }
    throw error;
  } finally {
    client.release();
  }
}

async function queryLatencyStats(db, query = {}, scope = 'user', userId = null) {
  const parsed = parseLatencyQuery(query);
  const key = cacheKey(scope, userId, parsed);
  const cached = getCached(key);
  if (cached) return cached;

  const { params, where } = buildWhere(parsed, scope, userId);

  const summarySql = `
    SELECT
      COUNT(*) AS requests,
      COUNT(e2e_ms) AS measured,
      ${percentileSelect('ttft_ms')},
      ${percentileSelect('e2e_ms')},
      ${percentileSelect('tpot_ms')},
      ${percentileSelect('output_tps')},
      ${percentileSelect('upstream_processing_ms')},
      AVG(upstream_processing_ms) FILTER (WHERE upstream_processing_ms IS NOT NULL) AS upstream_processing_avg,
      SUM(prompt_tokens) AS prompt_tokens,
      SUM(cached_tokens) AS cached_tokens,
      AVG(CASE WHEN output_tps >= 50 THEN 1.0 ELSE 0 END) FILTER (WHERE output_tps IS NOT NULL) AS tps_ge_50,
      AVG(CASE WHEN output_tps >= 80 THEN 1.0 ELSE 0 END) FILTER (WHERE output_tps IS NOT NULL) AS tps_ge_80,
      AVG(CASE WHEN output_tps >= 90 THEN 1.0 ELSE 0 END) FILTER (WHERE output_tps IS NOT NULL) AS tps_ge_90,
      AVG(CASE WHEN output_tps >= 100 THEN 1.0 ELSE 0 END) FILTER (WHERE output_tps IS NOT NULL) AS tps_ge_100
    FROM usage_records ur
    WHERE ${where}
  `;

  const groupSql = (labelField, joinSql, nameField) => `
    SELECT
      ur.${labelField} AS ${labelField},
      ${nameField} AS ${labelField === 'model_id' ? 'model_name' : 'provider_name'},
      COUNT(*) AS requests,
      COUNT(ur.e2e_ms) AS measured,
      ${percentileSelect('ur.ttft_ms', 'ttft_ms')},
      ${percentileSelect('ur.e2e_ms', 'e2e_ms')},
      ${percentileSelect('ur.tpot_ms', 'tpot_ms')},
      ${percentileSelect('ur.output_tps', 'output_tps')},
      SUM(ur.prompt_tokens) AS prompt_tokens,
      SUM(ur.cached_tokens) AS cached_tokens
    FROM usage_records ur
    ${joinSql}
    WHERE ${where}
    GROUP BY ur.${labelField}, ${nameField}
    ORDER BY requests DESC
    LIMIT 50
  `;

  const dailySql = `
    SELECT
      to_char(ur.created_at, 'YYYY-MM-DD') AS date,
      COUNT(*) AS requests,
      COUNT(ur.e2e_ms) AS measured,
      ${percentileSelect('ur.ttft_ms', 'ttft_ms')},
      ${percentileSelect('ur.e2e_ms', 'e2e_ms')},
      ${percentileSelect('ur.output_tps', 'output_tps')}
    FROM usage_records ur
    WHERE ${where}
    GROUP BY to_char(ur.created_at, 'YYYY-MM-DD')
    ORDER BY date ASC
  `;

  const rateLimitSql = `
    SELECT DISTINCT ON (ur.provider_id)
      ur.provider_id,
      p.name AS provider_name,
      ur.rate_limit,
      ur.service_tier,
      ur.created_at
    FROM usage_records ur
    LEFT JOIN providers p ON p.id = ur.provider_id
    WHERE ${where}
      AND ur.rate_limit IS NOT NULL
    ORDER BY ur.provider_id, ur.created_at DESC
    LIMIT 50
  `;

  let result;
  try {
    result = await withTimeoutTransaction(db, async (client) => {
      const summary = await client.query(summarySql, params);
      const byModel = await client.query(groupSql(
        'model_id',
        'LEFT JOIN models m ON m.id = ur.model_id',
        'COALESCE(m.name, ur.model_id)'
      ), params);
      const byProvider = await client.query(groupSql(
        'provider_id',
        'LEFT JOIN providers p ON p.id = ur.provider_id',
        'COALESCE(p.name, ur.provider_id)'
      ), params);
      const daily = await client.query(dailySql, params);
      const rateLimits = await client.query(rateLimitSql, params);
      return {
        summary: summary.rows[0] || {},
        byModel: byModel.rows,
        byProvider: byProvider.rows,
        daily: daily.rows,
        rateLimits: rateLimits.rows,
      };
    });
  } catch (error) {
    if (error && (error.code === '57014' || /statement timeout/i.test(error.message || ''))) {
      const timeout = new Error('延迟统计查询超时，请缩小时间范围');
      timeout.status = 503;
      throw timeout;
    }
    throw error;
  }

  const summary = mapSummary(result.summary);
  const payload = {
    window: {
      start: parsed.start,
      end: parsed.end,
      days: parsed.days,
      requestedDays: parsed.requestedDays,
      clipped: parsed.clipped,
      maxDays: parsed.maxDays,
      timezone: parsed.timezone,
    },
    coverage: {
      totalRequests: summary.requests,
      measuredRequests: summary.measuredRequests,
      rate: summary.coverage,
    },
    summary,
    byModel: result.byModel.map(row => mapGroupRow(row, 'model_id')),
    byProvider: result.byProvider.map(row => mapGroupRow(row, 'provider_id')),
    daily: result.daily.map(mapDailyRow),
    rateLimits: result.rateLimits.map(mapRateLimitRow),
    generatedAt: new Date().toISOString(),
  };

  payload.rateLimitNote = payload.rateLimits.length
    ? null
    : '所选范围内没有带限流响应头的记录；上游未返回 x-ratelimit-* / anthropic-ratelimit-* 时无法采集。';

  setCached(key, payload);
  return payload;
}

module.exports = {
  DEFAULT_DAYS,
  MAX_RANGE_DAYS,
  clearLatencyStatsCache,
  parseLatencyQuery,
  queryLatencyStats,
  // exported for tests
  _private: { daysBetween, addDays, mapSummary, mapGroupRow, mapDailyRow, buildWhere },
};
