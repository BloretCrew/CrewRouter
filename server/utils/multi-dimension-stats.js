'use strict';

const DIMENSIONS = Object.freeze({
  user: { label: '成员', value: 'u.user_id', name: "COALESCE(usr.username, '未知成员')" },
  team: { label: 'Team', value: 'usr.team_id', name: "COALESCE(t.name, '未分配 Team')" },
  project: { label: '项目', value: "COALESCE(NULLIF(TRIM(uma.workspace_path), ''), '__unknown__')", name: "COALESCE(NULLIF(TRIM(uma.workspace_path), ''), '未识别项目')" },
  source: { label: '客户端', value: "COALESCE(NULLIF(u.request_source, ''), 'unknown')", name: "COALESCE(NULLIF(u.request_source, ''), 'unknown')" },
  model: { label: '模型', value: 'u.model_id', name: "COALESCE(NULLIF(m.name, ''), u.model_id, '未知模型')" },
  provider: { label: '供应商', value: 'u.provider_id', name: "COALESCE(NULLIF(p.name, ''), '未知供应商')" },
  key: { label: '密钥', value: 'u.api_key_id', name: "COALESCE(NULLIF(ak.name, ''), '未识别密钥')" }
});
const { invalid, parseQuotaQuery, queryProviderQuotaOverview } = require('./provider-quota-stats');
const { makeProviderUsageSourceSql } = require('./provider-usage-history');
const QUOTA_DIMENSIONS = Object.freeze(['provider', 'account', 'kind', 'unit', 'window', 'date']);
const QUOTA_METRICS = Object.freeze(['total', 'used', 'remaining', 'used_percent', 'observed_consumption', 'percent_change']);

const METRICS = Object.freeze({ requests: 'COUNT(*)', tokens: 'COALESCE(SUM(u.tokens_used), 0)', cost: 'COALESCE(SUM(u.cost), 0)' });

function parseSelection(query, scope) {
  const raw = query.dimensions === undefined ? 'model' : query.dimensions;
  const dimensions = typeof raw === 'string' ? raw.split(',').map(s => s.trim()) : [];
  if (!dimensions.length || dimensions.length > Object.keys(DIMENSIONS).length ||
      new Set(dimensions).size !== dimensions.length ||
      dimensions.some(d => !Object.hasOwn(DIMENSIONS, d) || (scope === 'user' && (d === 'user' || d === 'team')))) {
    throw new Error('请选择有效且不同的维度');
  }
  const metric = query.metric === undefined ? 'requests' : query.metric;
  if (!Object.hasOwn(METRICS, metric)) throw new Error('无效的统计指标');
  if (query.start !== undefined || query.end !== undefined) {
    const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!validDate(query.start) || !validDate(query.end) || query.start > query.end ||
        (Date.parse(query.end) - Date.parse(query.start)) / 86400000 > 365) {
      throw new Error('时间范围需为有效的日期，且不超过 365 天');
    }
    return { dimensions, metric, start: query.start, end: query.end };
  }
  const days = Number(query.days === undefined ? 30 : query.days);
  if (typeof query.days === 'object' || query.days === '' || !Number.isInteger(days) || days < 1 || days > 365) throw new Error('时间范围需为 1 至 365 天');
  return { dimensions, metric, days };
}

async function queryMultiDimensionStats(pool, query, scope, userId) {
  const source = query.data_source || query.source || 'usage';
  if (!['usage', 'quota', 'provider_quota', 'association'].includes(source)) throw invalid('无效的分析数据源');
  if (source === 'quota' || source === 'provider_quota') return queryQuotaDimensions(pool, query, scope, userId);
  const { dimensions, metric, days, start, end } = parseSelection(query, scope);
  const filters = parseQuotaQuery(query);
  if (['kind', 'unit', 'window_key', 'status', 'account_id'].some(key => filters[key]) && source === 'usage') throw invalid('无效的请求统计额度筛选');
  const selected = dimensions.map((key, index) => {
    const { value, name } = DIMENSIONS[key];
    return { value, name, index };
  });
  const columns = selected.flatMap(({ value, name, index }) => [
    `${value} AS value_${index}`, `${name} AS name_${index}`
  ]);
  const groups = [...new Set(selected.flatMap(({ value, name }) => [value, name]))];
  const conditions = source === 'association' || start
    ? ["u.created_at >= $1::date AND u.created_at < ($2::date + INTERVAL '1 day')"]
    : ["u.created_at >= NOW() - ($1::int * INTERVAL '1 day')"];
  const params = source === 'association' ? [filters.start, filters.end] : start ? [start, end] : [days];
  if (scope === 'user') {
    params.push(userId);
    conditions.push(`u.user_id = $${params.length}`);
  }
  if (scope === 'user' && (filters.user_id || filters.team_id)) throw invalid('无效的用户关联筛选');
  for (const [key, column] of Object.entries({ provider_id: 'u.provider_id', model_id: 'u.model_id', user_id: 'u.user_id', team_id: 'usr.team_id', api_key_id: 'u.api_key_id', request_source: "COALESCE(NULLIF(u.request_source, ''), 'unknown')", workspace_path: "COALESCE(NULLIF(TRIM(uma.workspace_path), ''), '__unknown__')" })) {
    if (filters[key]) { params.push(filters[key]); conditions.push(`${column} = $${params.length}`); }
  }
  let usageSql = `
    SELECT ${columns.join(', ')}, COUNT(*)::int AS requests,
      COALESCE(SUM(u.tokens_used), 0)::bigint AS tokens,
      COALESCE(SUM(u.cost), 0)::numeric AS cost
    FROM usage_records u
    LEFT JOIN users usr ON usr.id = u.user_id
    LEFT JOIN teams t ON t.id = usr.team_id
    LEFT JOIN providers p ON p.id = u.provider_id
    LEFT JOIN api_keys ak ON ak.id = u.api_key_id AND ak.user_id = u.user_id
    LEFT JOIN LATERAL (
      SELECT m0.name FROM models m0
      WHERE m0.id = u.model_id
        OR (u.provider_id IS NOT NULL AND m0.upstream_model_id = u.model_id AND m0.provider = u.provider_id)
      ORDER BY CASE WHEN m0.id = u.model_id THEN 0 ELSE 1 END
      LIMIT 1
    ) m ON TRUE
    LEFT JOIN usage_message_analysis uma ON uma.usage_id = u.id
    WHERE ${conditions.join(' AND ')}
    GROUP BY ${groups.join(', ')}
    ORDER BY ${METRICS[metric]} DESC LIMIT 30
  `;
  if (source === 'association') {
    usageSql = usageSql.replace(/COUNT\(\*\)/g, 'SUM(u.request_count)')
      .replace(/u\.created_at/g, 'u.agg_date')
      .replace('FROM usage_records u', `FROM ${makeProviderUsageSourceSql()} u`)
      .replace('LEFT JOIN usage_message_analysis uma ON uma.usage_id = u.id', 'LEFT JOIN LATERAL (SELECT u.workspace_path) uma ON TRUE');
  }
  const result = await pool.query(usageSql, params);
  const quota = source === 'association' || query.include_quota === 'true' ? await queryProviderQuotaOverview(pool, query, scope, userId) : null;
  return {
    ...(quota ? { data_source: source, provider_quota: quota, quota_context: 'independent_provider_accounts_not_additive' } : {}),
    dimensions, metric,
    rows: result.rows.map(row => ({
      labels: selected.map(({ index }) => row[`name_${index}`]),
      values: selected.map(({ index }) => row[`value_${index}`]),
      requests: Number(row.requests), tokens: Number(row.tokens), cost: Number(row.cost)
    }))
  };
}

async function queryQuotaDimensions(pool, query, scope, userId) {
  const raw = query.dimensions === undefined ? 'provider' : query.dimensions;
  const dimensions = typeof raw === 'string' ? raw.split(',').map(s => s.trim()) : [];
  const metric = query.metric || 'remaining';
  if (!dimensions.length || new Set(dimensions).size !== dimensions.length || dimensions.some(d => !QUOTA_DIMENSIONS.includes(d))) throw invalid('请选择有效且不同的额度维度');
  if (!QUOTA_METRICS.includes(metric)) throw invalid('无效的额度指标');
  if (['used_percent', 'percent_change'].includes(metric) && !dimensions.includes('account')) throw invalid('无效的使用率组合：必须选择额度账户');
  if (query.status && dimensions.includes('date')) throw invalid('无效的趋势状态筛选：每日聚合包含全部查询状态');
  const quota = await queryProviderQuotaOverview(pool, query, scope, userId);
  const items = dimensions.includes('date') || ['observed_consumption', 'percent_change'].includes(metric) ? quota.trend : quota.accounts;
  const fields = { provider: 'provider_id', account: 'account_id', kind: 'kind', unit: 'unit', window: 'window_key', date: 'date' };
  const groups = new Map();
  const seen = new Set();
  for (const item of items) {
    const identity = JSON.stringify([item.account_id, item.kind, item.unit, item.window_key, item.date]);
    // A shared account exposed through multiple providers must count once per selected provider group.
    const selectedValues = dimensions.map(d => item[fields[d]]);
    const contributionIdentity = JSON.stringify([identity, selectedValues]);
    if (seen.has(contributionIdentity)) continue;
    seen.add(contributionIdentity);
    const additive = !['used_percent', 'percent_change'].includes(metric) && item.kind === 'balance' && !!item.unit && item.unit !== 'unknown';
    const key = JSON.stringify([selectedValues, item.kind, item.unit, item.window_key, additive ? null : item.account_id]);
    if (!groups.has(key)) groups.set(key, {
      labels: dimensions.map(d => d === 'provider' ? (item.provider_name || item.provider_id) : d === 'account' ? (item.label || item.account_id) : item[fields[d]]),
      values: selectedValues, value: null, kind: item.kind, unit: item.unit, window_key: item.window_key,
      account_id: dimensions.includes('account') || !additive ? item.account_id : null,
      account_ids: [], invalid_percent_change: false, aggregatable: additive, observed_at: item.observed_at, status: item.status,
      quality: item.quality, coverage: { start: quota.coverage.start, end: quota.coverage.end }
    });
    const group = groups.get(key);
    if (metric === 'percent_change' && (Number(item.anomaly_count || 0) > 0 || ['reset', 'gap', 'backfill', 'adjustment'].includes(item.quality?.last_event || item.quality?.event))) group.invalid_percent_change = true;
    if (!group.account_ids.includes(item.account_id)) group.account_ids.push(item.account_id);
    if (item[metric] != null) {
      if (additive) group.value = (group.value ?? 0) + Number(item[metric]);
      else if (!dimensions.includes('date') && metric === 'percent_change') group.value = (group.value ?? 0) + Number(item[metric]);
      else if (group.value === null || Date.parse(item.observed_at) >= Date.parse(group.observed_at)) group.value = Number(item[metric]);
    }
    if (Date.parse(item.observed_at) > Date.parse(group.observed_at)) group.observed_at = item.observed_at;
  }
  const rows = [...groups.values()].map(group => {
    if (group.invalid_percent_change) { group.value = null; group.quality = { ...group.quality, percent_change_unavailable: true }; }
    delete group.invalid_percent_change;
    return group;
  }).sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  return { dimensions, metric, data_source: 'quota', rows, provider_quota: quota, coverage: quota.coverage };
}

module.exports = { DIMENSIONS, METRICS, QUOTA_DIMENSIONS, QUOTA_METRICS, parseSelection, queryQuotaDimensions, queryMultiDimensionStats };
