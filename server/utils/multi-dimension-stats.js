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
  const { dimensions, metric, days, start, end } = parseSelection(query, scope);
  const selected = dimensions.map((key, index) => {
    const { value, name } = DIMENSIONS[key];
    return { value, name, index };
  });
  const columns = selected.flatMap(({ value, name, index }) => [
    `${value} AS value_${index}`, `${name} AS name_${index}`
  ]);
  const groups = [...new Set(selected.flatMap(({ value, name }) => [value, name]))];
  const conditions = start
    ? ["u.created_at >= $1::date AND u.created_at < ($2::date + INTERVAL '1 day')"]
    : ["u.created_at >= NOW() - ($1::int * INTERVAL '1 day')"];
  const params = start ? [start, end] : [days];
  if (scope === 'user') {
    params.push(userId);
    conditions.push(`u.user_id = $${params.length}`);
  }
  const result = await pool.query(`
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
  `, params);
  return {
    dimensions, metric,
    rows: result.rows.map(row => ({
      labels: selected.map(({ index }) => row[`name_${index}`]),
      values: selected.map(({ index }) => row[`value_${index}`]),
      requests: Number(row.requests), tokens: Number(row.tokens), cost: Number(row.cost)
    }))
  };
}

module.exports = { DIMENSIONS, METRICS, parseSelection, queryMultiDimensionStats };
