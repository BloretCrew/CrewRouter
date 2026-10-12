'use strict';

const { shanghaiDateRange } = require('./timezone');
const { makeProviderUsageSourceSql } = require('./provider-usage-history');

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function parseQuotaQuery(query = {}) {
  const scalar = (key) => {
    if (query[key] === undefined || query[key] === '') return undefined;
    if (typeof query[key] !== 'string' && typeof query[key] !== 'number') throw invalid(`无效的筛选参数 ${key}`);
    return String(query[key]);
  };
  const integer = (key, fallback, max) => {
    const raw = scalar(key);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max) throw invalid(`无效的 ${key}`);
    return value;
  };
  const days = integer('days', 30, 365);
  let { start, end } = shanghaiDateRange(days);
  if (query.start !== undefined || query.end !== undefined) {
    start = scalar('start'); end = scalar('end');
    const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!valid(start) || !valid(end) || start > end || (Date.parse(end) - Date.parse(start)) / 86400000 >= 365) {
      throw invalid('时间范围需为有效的日期，且不超过 365 天');
    }
  }
  if (query.sort !== undefined || query.order !== undefined) throw invalid('无效的排序参数');
  const result = { start, end, page: integer('page', 1, 1000000), limit: integer('limit', 50, 200) };
  for (const key of ['provider_id', 'account_id', 'kind', 'unit', 'window_key', 'status', 'user_id', 'team_id', 'model_id', 'request_source', 'workspace_path', 'api_key_id']) result[key] = scalar(key);
  if (result.status && !['success', 'partial', 'failed', 'stale'].includes(result.status)) throw invalid('无效的额度状态');
  if (result.kind && !['balance', 'window', 'status'].includes(result.kind)) throw invalid('无效的额度类型');
  return result;
}

function accountScope(options, scope, userId, params) {
  const conditions = ['TRUE'];
  const bind = value => { params.push(value); return `$${params.length}`; };
  if (scope === 'user') {
    if (userId == null) throw invalid('无效的用户范围');
    conditions.push(`EXISTS (
      SELECT 1 FROM providers vp JOIN models vm ON vm.provider = vp.id
      JOIN team_models tm ON tm.model_id = vm.id JOIN user_teams ut ON ut.team_id = tm.team_id
      WHERE vp.id = a.provider_id AND vp.enabled = TRUE AND vp.quota_enabled = TRUE
        AND ut.user_id = ${bind(userId)} AND NOT EXISTS (
          SELECT 1 FROM teams ht WHERE ht.id = ut.team_id AND ht.hide_provider_quota = TRUE
        )
    )`);
  }
  if (options.provider_id) conditions.push(`a.provider_id = ${bind(options.provider_id)}`);
  if (options.account_id) conditions.push(`a.id::text = ${bind(options.account_id)}`);
  return conditions.join(' AND ');
}

function itemScope(options, alias, params) {
  const conditions = [];
  for (const key of ['kind', 'unit', 'window_key']) {
    if (options[key] !== undefined) {
      params.push(options[key]); conditions.push(`COALESCE(${alias}.${key}, '') = $${params.length}`);
    }
  }
  return conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
}

const ACCOUNT_RELATION = `(SELECT qa.id, qa.label, qp.provider_id, qp.active, qp.legacy, qp.last_attempt_at, qp.last_attempt_status, qp.last_valid_at
  FROM provider_quota_accounts qa JOIN provider_quota_account_providers qp ON qp.account_id = qa.id)`;

const DAILY_RELATION = `(SELECT account_id, date, kind, unit, window_key,
  (array_agg(provider_name ORDER BY last_observed_at DESC NULLS LAST))[1] AS provider_name,
  MIN(first_observed_at) AS first_observed_at, MAX(last_observed_at) AS last_observed_at,
  (array_agg(first_used_percent ORDER BY first_observed_at NULLS LAST))[1] AS first_used_percent,
  (array_agg(last_total ORDER BY last_observed_at DESC NULLS LAST))[1] AS last_total,
  (array_agg(last_used ORDER BY last_observed_at DESC NULLS LAST))[1] AS last_used,
  (array_agg(last_remaining ORDER BY last_observed_at DESC NULLS LAST))[1] AS last_remaining,
  (array_agg(last_used_percent ORDER BY last_observed_at DESC NULLS LAST))[1] AS last_used_percent,
  (array_agg(quality ORDER BY last_observed_at DESC NULLS LAST))[1] AS quality,
  SUM(observed_consumption) AS observed_consumption, CASE WHEN SUM(anomaly_count) = 0 THEN SUM(percent_change) ELSE NULL END AS percent_change, SUM(anomaly_count) AS anomaly_count,
  SUM(sample_count) AS sample_count, SUM(success_count) AS success_count, SUM(failure_count) AS failure_count
  FROM provider_quota_daily_agg WHERE kind != 'status' GROUP BY account_id, date, kind, unit, window_key)`;

const number = value => value == null ? null : Number(value);
function publicItem(row) {
  const item = {};
  for (const key of ['provider_id', 'provider_name', 'account_id', 'label', 'kind', 'unit', 'window_key', 'resets_at', 'observed_at', 'status', 'last_attempt_at', 'last_attempt_status', 'checked_at', 'date']) {
    if (row[key] !== undefined) item[key] = row[key];
  }
  for (const key of ['total', 'used', 'remaining', 'used_percent']) item[key] = number(row[key]);
  for (const key of ['observed_consumption', 'anomaly_count', 'sample_count', 'success_count', 'failure_count', 'percent_change']) if (row[key] !== undefined) item[key] = number(row[key]);
  if (row.quality) {
    const quality = typeof row.quality === 'string' ? JSON.parse(row.quality) : row.quality;
    item.quality = {};
    for (const key of ['cached', 'source', 'precision', 'event', 'last_event', 'interval_start', 'interval_end', 'last_resets_at', 'gap_count', 'reset_count', 'unknown_used', 'legacy', 'duplicate_sample', 'correction']) {
      if (['string', 'number', 'boolean'].includes(typeof quality[key]) || quality[key] === null) item.quality[key] = quality[key];
    }
  }
  return item;
}

function groupItems(accounts) {
  const groups = new Map();
  const seen = new Set();
  for (const item of accounts) {
    const identity = JSON.stringify([item.account_id, item.kind, item.unit, item.window_key]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = JSON.stringify([item.kind, item.unit, item.window_key]);
    if (!groups.has(key)) groups.set(key, { kind: item.kind, unit: item.unit, window_key: item.window_key, accounts: 0, total: null, used: null, remaining: null, aggregatable: item.kind === 'balance' && !!item.unit && item.unit !== 'unknown' });
    const group = groups.get(key); group.accounts++;
    if (group.aggregatable) for (const field of ['total', 'used', 'remaining']) {
      if (item[field] != null) group[field] = (group[field] ?? 0) + item[field];
    }
  }
  return [...groups.values()];
}

async function queryUsageContribution(pool, options, scope, userId) {
  const params = [options.start, options.end];
  const conditions = ['u.agg_date >= $1::date AND u.agg_date <= $2::date'];
  const bind = value => { params.push(value); return `$${params.length}`; };
  if (scope === 'user') {
    conditions.push(`u.user_id = ${bind(userId)}`);
    const visibleParams = [];
    const visible = accountScope({}, scope, userId, visibleParams).replace(/\$1\b/g, bind(userId));
    conditions.push(`EXISTS (SELECT 1 FROM ${ACCOUNT_RELATION} a WHERE a.provider_id = u.provider_id AND ${visible})`);
    if (options.user_id || options.team_id) throw invalid('无效的用户关联筛选');
  }
  for (const [key, column] of Object.entries({ provider_id: 'u.provider_id', user_id: 'u.user_id', model_id: 'u.model_id', api_key_id: 'u.api_key_id', request_source: "COALESCE(NULLIF(u.request_source, ''), 'unknown')" })) {
    if (options[key]) conditions.push(`${column} = ${bind(options[key])}`);
  }
  if (options.team_id) conditions.push(`EXISTS (SELECT 1 FROM users usr WHERE usr.id = u.user_id AND usr.team_id = ${bind(options.team_id)})`);
  if (options.workspace_path) conditions.push(`u.workspace_path = ${bind(options.workspace_path)}`);
  const result = await pool.query(`SELECT u.provider_id, u.agg_date::text AS date,
    SUM(u.request_count)::bigint AS requests, COALESCE(SUM(u.tokens_used), 0)::bigint AS tokens, COALESCE(SUM(u.cost), 0)::numeric AS cost
    FROM ${makeProviderUsageSourceSql()} u WHERE ${conditions.join(' AND ')} GROUP BY u.provider_id, u.agg_date ORDER BY date`, params);
  return result.rows.map(row => ({ provider_id: row.provider_id, date: row.date, requests: Number(row.requests), tokens: Number(row.tokens), cost: Number(row.cost) }));
}

async function queryProviderQuotaOverview(pool, query, scope = 'admin', userId) {
  const options = parseQuotaQuery(query);
  const params = [options.start, options.end];
  const permission = accountScope(options, scope, userId, params);
  const itemFilter = itemScope(options, 'i', params);
  if (options.status && options.status !== 'stale') { params.push(options.status); }
  const statusFilter = options.status && options.status !== 'stale' ? ` AND COALESCE(attempt.status, CASE WHEN a.last_attempt_at < (($2::date + INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai') THEN a.last_attempt_status END) = $${params.length}` : '';
  const latest = await pool.query(`SELECT a.provider_id, COALESCE(p.name, o.provider_name, fallback.provider_name) AS provider_name,
    a.id AS account_id, a.label, i.kind, i.unit, i.window_key, i.total, i.used, i.remaining, i.used_percent, i.resets_at, i.quality,
    COALESCE(i.observed_at, o.observed_at, fallback.last_observed_at) AS observed_at, CASE WHEN o.id IS NOT NULL THEN o.status WHEN fallback.last_observed_at IS NOT NULL THEN 'success' ELSE 'unknown' END AS status, COALESCE(attempt.checked_at, CASE WHEN a.last_attempt_at < (($2::date + INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai') THEN a.last_attempt_at END) AS last_attempt_at,
    COALESCE(attempt.status, CASE WHEN a.last_attempt_at < (($2::date + INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai') THEN a.last_attempt_status END) AS last_attempt_status
    FROM ${ACCOUNT_RELATION} a LEFT JOIN providers p ON p.id = a.provider_id
    LEFT JOIN LATERAL (SELECT o0.* FROM provider_quota_observations o0 WHERE o0.account_id = a.id AND o0.provider_id = a.provider_id
      AND o0.checked_at < (($2::date + INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai') ORDER BY o0.checked_at DESC, o0.id DESC LIMIT 1) attempt ON TRUE
    LEFT JOIN LATERAL (SELECT o1.* FROM provider_quota_observations o1 WHERE o1.account_id = a.id 
      AND o1.status IN ('success', 'partial') AND EXISTS (SELECT 1 FROM provider_quota_observation_items vi WHERE vi.observation_id = o1.id) AND o1.observed_at < (($2::date + INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai')
      ORDER BY o1.observed_at DESC, o1.id DESC LIMIT 1) o ON TRUE
    LEFT JOIN LATERAL (SELECT d0.provider_name, d0.last_observed_at FROM provider_quota_daily_agg d0
      WHERE d0.account_id = a.id  AND d0.date <= $2::date AND d0.kind != 'status'
      ORDER BY d0.last_observed_at DESC NULLS LAST LIMIT 1) fallback ON TRUE
    LEFT JOIN LATERAL (
      SELECT DISTINCT ON (candidate.kind, candidate.unit, candidate.window_key) candidate.* FROM (
        SELECT oi.kind, oi.unit, oi.window_key, oi.total, oi.used, oi.remaining, oi.used_percent, oi.resets_at, oi.observed_at, oi.quality, vo.checked_at AS sample_checked_at, oi.id AS sample_order
        FROM provider_quota_observation_items oi JOIN provider_quota_observations vo ON vo.id = oi.observation_id
        WHERE oi.account_id = a.id  AND vo.status IN ('success','partial')
          AND oi.observed_at < (($2::date + INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai')
        UNION ALL
        SELECT fd.kind, fd.unit, fd.window_key, fd.last_total, fd.last_used, fd.last_remaining, fd.last_used_percent,
          (fd.quality->>'last_resets_at')::timestamptz, fd.last_observed_at, fd.quality, NULL::timestamptz AS sample_checked_at, 0::bigint AS sample_order
        FROM provider_quota_daily_agg fd WHERE fd.account_id = a.id 
          AND fd.date <= $2::date AND fd.kind != 'status' AND fd.last_observed_at IS NOT NULL
      ) candidate ORDER BY candidate.kind, candidate.unit, candidate.window_key, candidate.observed_at DESC NULLS LAST, candidate.sample_checked_at DESC NULLS LAST, candidate.sample_order DESC
    ) i ON TRUE
    WHERE a.active = TRUE AND a.legacy = FALSE AND $1::date <= $2::date AND ${permission}${itemFilter}${statusFilter} ORDER BY a.provider_id, a.id, i.kind, i.window_key`, params);
  const trendParams = [options.start, options.end];
  const trendScope = accountScope(options, scope, userId, trendParams);
  const trendFilter = itemScope(options, 'd', trendParams);
  const daily = await pool.query(`SELECT a.provider_id, a.id AS account_id, d.date::text AS date, d.kind, d.unit, d.window_key,
    d.last_total AS total, d.last_used AS used, d.last_remaining AS remaining, d.last_used_percent AS used_percent,
    d.last_observed_at AS observed_at, COALESCE(p.name, d.provider_name) AS provider_name, a.label, d.observed_consumption, d.anomaly_count, d.sample_count, d.success_count, d.failure_count, d.quality,
    d.percent_change, d.first_observed_at
    FROM ${DAILY_RELATION} d JOIN ${ACCOUNT_RELATION} a ON a.id = d.account_id LEFT JOIN providers p ON p.id = a.provider_id
    WHERE d.date >= $1::date AND d.date <= $2::date AND d.kind != 'status' AND ${trendScope}${trendFilter} ORDER BY d.date, a.id`, trendParams);
  const coverageParams = [];
  const coverageScope = accountScope(options, scope, userId, coverageParams);
  const coverageFilter = itemScope(options, 'd', coverageParams);
  const historicalCoverage = await pool.query(`SELECT a.id AS account_id, a.provider_id, MIN(d.first_observed_at) AS first_observed_at
    FROM ${DAILY_RELATION} d JOIN ${ACCOUNT_RELATION} a ON a.id = d.account_id LEFT JOIN providers p ON p.id = a.provider_id
    WHERE ${coverageScope}${coverageFilter} GROUP BY a.id, a.provider_id`, coverageParams);
  let usage = await queryUsageContribution(pool, options, scope, userId);
  const contributionFiltered = ['user_id', 'team_id', 'model_id', 'request_source', 'workspace_path', 'api_key_id'].some(key => options[key]);
  const related = new Set(usage.map(row => String(row.provider_id)));
  const accounts = latest.rows.filter(row => (!contributionFiltered || related.has(String(row.provider_id))) && (options.status !== 'stale' || !row.observed_at || Date.now() - Date.parse(row.observed_at) > 86400000 || row.last_attempt_status === 'failed')).map(row => {
    const item = publicItem(row);
    item.status = row.last_attempt_status || row.status || 'unknown';
    item.stale = !row.observed_at || Date.now() - Date.parse(row.observed_at) > 86400000 || Date.parse(row.observed_at) < Date.parse(`${options.start}T00:00:00+08:00`) || ['failed', 'error'].includes(item.status);
    if (options.status === 'stale') item.status = 'stale';
    // Contribution is provider-wide context, not attributable account consumption.
    const contribution = usage.filter(u => String(u.provider_id) === String(row.provider_id));
    for (const key of ['requests', 'tokens', 'cost']) item[key] = contribution.reduce((sum, u) => sum + u[key], 0);
    return item;
  });
  const allowedProviders = new Set(accounts.map(a => String(a.provider_id)));
  usage = usage.filter(row => allowedProviders.has(String(row.provider_id)));
  const ids = new Set(accounts.map(a => String(a.account_id)));
  const selectedAccounts = new Set(accounts.map(row => JSON.stringify([String(row.account_id), String(row.provider_id)])));
  const matchesSelectedStatus = row => !options.status || selectedAccounts.has(JSON.stringify([String(row.account_id), String(row.provider_id)]));
  const trendSeen = new Set();
  const trendRows = daily.rows.filter(row => {
    if (!matchesSelectedStatus(row)) return false;
    if (contributionFiltered && !related.has(String(row.provider_id))) return false;
    const key = JSON.stringify([row.account_id, row.kind, row.unit, row.window_key, row.date, row.provider_id]);
    if (trendSeen.has(key)) return false;
    trendSeen.add(key); return true;
  });
  const firstObserved = historicalCoverage.rows.filter(row => matchesSelectedStatus(row) && (!contributionFiltered || related.has(String(row.provider_id)))).map(row => row.first_observed_at).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
  const sequences = new Map();
  for (const row of [...new Map(trendRows.map(row => [JSON.stringify([row.account_id, row.kind, row.unit, row.window_key, row.date]), row])).values()]) {
    const key = JSON.stringify([row.account_id, row.kind, row.unit, row.window_key]);
    if (!sequences.has(key)) sequences.set(key, []);
    sequences.get(key).push(row);
  }
  let gaps = 0;
  for (const rows of sequences.values()) {
    rows.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    for (let index = 0; index < rows.length; index++) {
      const quality = rows[index].quality || {};
      if ((quality.last_event || quality.event) === 'gap') gaps++;
      else if (index && Date.parse(rows[index].first_observed_at || rows[index].observed_at) - Date.parse(rows[index - 1].observed_at) > 86400000) gaps++;
    }
  }
  const uniqueTrend = [...new Map(trendRows.map(row => [JSON.stringify([row.account_id, row.kind, row.unit, row.window_key, row.date]), row])).values()];
  const coverage = {
    start: options.start, end: options.end, timezone: 'Asia/Shanghai',
    first_observed_at: firstObserved,
    started_at: firstObserved,
    last_observed_at: accounts.map(row => row.observed_at).filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null,
    gaps, gap_threshold_hours: 24, gap_semantics: 'observed_sampling_intervals_not_exact_consumption',
    samples: uniqueTrend.reduce((sum, row) => sum + Number(row.sample_count || 0), 0),
    usage_source: 'provider_usage_daily_agg_and_unarchived_records', usage_complete: false,
    caveats: ['请求贡献按供应商去重；账户行中的请求贡献不可相加。', '额度观测可能包含平台外使用，不等同于账单；仅余额且同类型、单位、窗口可汇总。', '请求关联覆盖已归档和保留明细；启用归档前已删除的历史不可恢复，筛选后的额度为上下文，不是分摊成本。']
  };
  return {
    summary: { accounts: ids.size, providers: allowedProviders.size, success: new Set(accounts.filter(a => ['success', 'partial'].includes(a.status) && !a.stale).map(a => a.account_id)).size,
      failed: new Set(accounts.filter(a => ['failed', 'error'].includes(a.status)).map(a => a.account_id)).size,
      stale: new Set(accounts.filter(a => a.stale).map(a => a.account_id)).size,
      low: new Set(accounts.filter(a => a.used_percent >= 90 || a.remaining === 0).map(a => a.account_id)).size },
    groups: groupItems(accounts).map(group => {
      const consumption = uniqueTrend.filter(row => row.kind === group.kind && row.unit === group.unit && row.window_key === group.window_key && row.observed_consumption != null);
      return { ...group, observed_consumption: group.aggregatable && consumption.length ? consumption.reduce((sum, row) => sum + Number(row.observed_consumption), 0) : null };
    }), accounts, trend: trendRows.map(publicItem), usage_trend: usage, coverage
  };
}

async function queryProviderQuotaHistory(pool, query, scope = 'admin', userId) {
  const options = parseQuotaQuery(query);
  if (['user_id', 'team_id', 'model_id', 'request_source', 'workspace_path', 'api_key_id'].some(key => options[key])) throw invalid('无效的历史关联筛选');
  const params = [options.start, options.end];
  const permission = accountScope(options, scope, userId, params);
  const filters = itemScope(options, 'i', params);
  if (options.status) params.push(options.status);
  const where = `${permission} AND o.checked_at >= ($1::date AT TIME ZONE 'Asia/Shanghai')
    AND o.checked_at < (($2::date + INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai')${filters}${options.status ? (options.status === 'stale' ? ` AND o.observed_at < NOW() - INTERVAL '1 day' AND $${params.length}::text = 'stale'` : ` AND o.status = $${params.length}`) : ''}`;
  const from = `FROM provider_quota_observations o JOIN ${ACCOUNT_RELATION} a ON a.id = o.account_id AND a.provider_id = o.provider_id
    LEFT JOIN provider_quota_observation_items i ON i.observation_id = o.id WHERE ${where}`;
  const count = await pool.query(`SELECT COUNT(*)::int AS total ${from}`, params);
  const rows = await pool.query(`SELECT o.id AS observation_id, a.provider_id, o.provider_name, a.id AS account_id, a.label,
    o.checked_at, o.observed_at, o.status, i.kind, i.unit, i.window_key, i.total, i.used, i.remaining, i.used_percent, i.resets_at
    ${from} ORDER BY o.checked_at DESC, o.id DESC, i.kind, i.unit, i.window_key LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
  [...params, options.limit, (options.page - 1) * options.limit]);
  return { rows: rows.rows.map(row => ({ observation_id: row.observation_id, ...publicItem(row) })), total: Number(count.rows[0]?.total || 0), page: options.page, limit: options.limit };
}

module.exports = { invalid, parseQuotaQuery, accountScope, publicItem, groupItems, queryUsageContribution, queryProviderQuotaOverview, queryProviderQuotaHistory };
