const express = require('express');
const { pool } = require('../models/database');
const { requireAuth, requireAdmin, requireProviderManager } = require('../middleware/auth');
const { requireTeamEdition, loadPersistedEdition } = require('../utils/instance-edition');
const Logger = require('../logger');
const router = express.Router();
const teamEdition = requireTeamEdition(() => loadPersistedEdition(pool));

function parseQuery(query) {
  const text = (key, fallback = '') => {
    if (query[key] === undefined) return fallback;
    if (typeof query[key] !== 'string') throw new Error(`${key} 必须是字符串`);
    return query[key].trim();
  };
  const boolean = key => {
    const value = text(key);
    if (!value) return null;
    if (!['true', 'false'].includes(value)) throw new Error(`${key} 必须是 true 或 false`);
    return value === 'true';
  };
  const integer = (key, fallback, max) => {
    const value = text(key, String(fallback));
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
      throw new Error(`${key} 超出有效范围`);
    }
    return Number(value);
  };
  const options = {
    view: text('view', 'providers'), teamId: text('teamId'), q: text('q'),
    provider: text('provider'), series: text('series'), tag: text('tag'),
    test: text('test'), systemEnabled: boolean('systemEnabled'), teamEnabled: boolean('teamEnabled'),
    sort: text('sort', 'name'), page: integer('page', 1, 1000000), limit: integer('limit', 50, 200),
  };
  if (!['providers', 'models'].includes(options.view)) throw new Error('view 必须是 providers 或 models');
  if (!['name', 'name_desc', 'newest', 'test_latency', 'test_speed', 'price_asc', 'price_desc'].includes(options.sort)) throw new Error('sort 无效');
  if (!['', 'pass', 'fail', 'untested'].includes(options.test)) throw new Error('test 无效');
  if (options.teamId && (!/^[1-9]\d*$/.test(options.teamId) || Number(options.teamId) > 2147483647)) throw new Error('teamId 无效');
  if (options.teamEnabled !== null && !options.teamId) throw new Error('teamEnabled 需要 teamId');
  if (options.tag && (!/^[1-9]\d*$/.test(options.tag) || Number(options.tag) > 2147483647)) throw new Error('tag 必须是标签 ID');
  return options;
}

function buildLibraryQuery(options) {
  const params = [];
  const bind = value => { params.push(value); return `$${params.length}`; };
  const team = bind(options.teamId || null);
  const providerWhere = options.teamId ? ['p.created_by IS NULL'] : [];
  if (options.provider) providerWhere.push(`p.id = ${bind(options.provider)}`);
  if (options.tag) providerWhere.push(`EXISTS (SELECT 1 FROM provider_tag_assignments pa WHERE pa.provider_id = p.id AND pa.tag_id = ${bind(options.tag)})`);
  const modelWhere = [];
  let searchParam;
  if (options.q) {
    const q = searchParam = bind(`%${options.q.replace(/[\\%_]/g, '\\$&')}%`);
    modelWhere.push(`(p.name ILIKE ${q} OR m.id ILIKE ${q} OR m.name ILIKE ${q} OR m.upstream_model_id ILIKE ${q} OR m.alias ILIKE ${q} OR m.series ILIKE ${q} OR m.description ILIKE ${q})`);
  }
  if (options.series) modelWhere.push(`m.series = ${bind(options.series)}`);
  if (options.systemEnabled !== null) modelWhere.push(`m.enabled = ${bind(options.systemEnabled)}`);
  if (options.teamEnabled !== null) modelWhere.push(`COALESCE(tm.enabled, FALSE) = ${bind(options.teamEnabled)}`);
  if (options.test) modelWhere.push(`mtr.ok IS ${options.test === 'pass' ? 'TRUE' : options.test === 'fail' ? 'FALSE' : 'NULL'}`);
  const cte = `WITH visible_providers AS (
    SELECT p.id, p.name, p.format, p.enabled AS provider_enabled, p.created_at,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id', pt.id, 'name', pt.name, 'color', pt.color) ORDER BY pt.sort_order, pt.id)
             FROM provider_tag_assignments pa JOIN provider_tags pt ON pt.id = pa.tag_id
             WHERE pa.provider_id = p.id), '[]'::jsonb) AS tags
    FROM providers p ${providerWhere.length ? `WHERE ${providerWhere.join(' AND ')}` : ''}
  ), filtered_models AS (
    SELECT m.id AS model_id, m.name, m.provider AS provider_id, p.name AS provider_name,
           m.upstream_model_id, m.alias, m.series, m.description, m.icon_url,
           m.input_price_per_1k_tokens, m.output_price_per_1k_tokens, m.model_multiplier,
           m.rate_limit_rpm, m.rate_limit_tpm,
           COALESCE(m.enabled AND p.provider_enabled AND (${team}::int IS NULL OR tm.enabled), FALSE) AS effective_available,
           m.created_at, m.enabled AS system_enabled, p.provider_enabled,
           CASE WHEN ${team}::int IS NULL THEN NULL ELSE COALESCE(tm.enabled, FALSE) END AS team_enabled,
           mtr.ok AS test_ok, mtr.latency_ms AS test_latency_ms,
           mtr.tokens_per_second AS test_tokens_per_second, mtr.tested_at AS test_tested_at
    FROM models m JOIN visible_providers p ON p.id = m.provider
    LEFT JOIN team_models tm ON tm.model_id = m.id AND tm.team_id = ${team}::int
    LEFT JOIN model_test_results mtr ON mtr.model_id = m.id
    ${modelWhere.length ? `WHERE ${modelWhere.join(' AND ')}` : ''}
  ), provider_stats AS (
    SELECT p.id, p.name, p.format, p.tags, p.provider_enabled, p.created_at,
           COUNT(m.model_id)::int AS model_count,
           COUNT(m.model_id) FILTER (WHERE m.system_enabled)::int AS system_enabled_count,
           CASE WHEN ${team}::int IS NULL THEN NULL ELSE COUNT(m.model_id) FILTER (WHERE m.team_enabled)::int END AS team_enabled_count,
           COUNT(m.model_id) FILTER (WHERE m.system_enabled AND m.provider_enabled AND (${team}::int IS NULL OR m.team_enabled))::int AS available_count,
           COUNT(m.model_id) FILTER (WHERE m.test_ok IS TRUE)::int AS test_pass_count,
           COUNT(m.model_id) FILTER (WHERE m.test_ok IS FALSE)::int AS test_fail_count,
           COUNT(m.model_id) FILTER (WHERE m.test_ok IS NULL)::int AS test_untested_count
    FROM visible_providers p LEFT JOIN filtered_models m ON m.provider_id = p.id
    GROUP BY p.id, p.name, p.format, p.tags, p.provider_enabled, p.created_at
    ${modelWhere.length ? `HAVING COUNT(m.model_id) > 0${searchParam && !options.series && options.systemEnabled === null && options.teamEnabled === null && !options.test
      ? ` OR (p.name ILIKE ${searchParam} AND NOT EXISTS (SELECT 1 FROM models all_models WHERE all_models.provider = p.id))` : ''}` : ''}
  )`;
  return { cte, params };
}

router.get('/model-library', requireAuth, requireProviderManager, async (req, res, next) => {
  let options;
  try { options = parseQuery(req.query); } catch (error) { return res.status(400).json({ error: error.message }); }
  req.modelLibraryOptions = options;
  if (!options.teamId) return next();
  return teamEdition(req, res, () => requireAdmin(req, res, next));
}, async (req, res) => {
  const options = req.modelLibraryOptions;
  try {
    if (options.teamId) {
      const team = await pool.query('SELECT id, name FROM teams WHERE id = $1', [options.teamId]);
      if (!team.rows.length) return res.status(404).json({ error: 'Team 不存在' });
    }
    const { cte, params } = buildLibraryQuery(options);
    const providers = await pool.query(`${cte} SELECT * FROM provider_stats ORDER BY name, id`, params);
    const counts = await pool.query(`${cte} SELECT COUNT(*)::int AS model_count,
      COUNT(*) FILTER (WHERE system_enabled)::int AS system_enabled_count,
      CASE WHEN $1::int IS NULL THEN NULL ELSE COUNT(*) FILTER (WHERE team_enabled)::int END AS team_enabled_count,
      COUNT(*) FILTER (WHERE system_enabled AND provider_enabled AND ($1::int IS NULL OR team_enabled))::int AS available_count FROM filtered_models`, params);
    const modelSort = { name: 'provider_name, name, model_id', name_desc: 'provider_name DESC, name DESC, model_id', newest: 'created_at DESC NULLS LAST, model_id', test_latency: 'test_latency_ms ASC NULLS LAST, model_id', test_speed: 'test_tokens_per_second DESC NULLS LAST, model_id', price_asc: 'input_price_per_1k_tokens ASC NULLS LAST, output_price_per_1k_tokens ASC NULLS LAST, model_id', price_desc: 'input_price_per_1k_tokens DESC NULLS LAST, output_price_per_1k_tokens DESC NULLS LAST, model_id' };
    const providerSort = { name: 'name, id', name_desc: 'name DESC, id', newest: 'created_at DESC NULLS LAST, id', test_latency: 'name, id', test_speed: 'name, id', price_asc: 'name, id', price_desc: 'name, id' };
    const source = options.view === 'models' ? 'filtered_models' : 'provider_stats';
    const order = options.view === 'models' ? modelSort[options.sort] : providerSort[options.sort];
    const items = await pool.query(`${cte} SELECT * FROM ${source} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, options.limit, (options.page - 1) * options.limit]);
    const seriesQuery = buildLibraryQuery({ ...options, series: '' });
    const series = await pool.query(`${seriesQuery.cte} SELECT DISTINCT series FROM filtered_models WHERE COALESCE(series, '') <> '' ORDER BY series`, seriesQuery.params);
    const stats = { ...counts.rows[0], provider_count: providers.rows.length };
    res.json({ view: options.view, team_id: options.teamId ? Number(options.teamId) : null,
      items: items.rows, total: options.view === 'models' ? stats.model_count : stats.provider_count,
      page: options.page, limit: options.limit, stats, providers: providers.rows, series: series.rows.map(row => row.series) });
  } catch (error) {
    Logger.error('[管理模型库] 错误:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
module.exports.parseQuery = parseQuery;
module.exports.buildLibraryQuery = buildLibraryQuery;
