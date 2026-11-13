'use strict';

const { pool } = require('../../models/database');
const concurrency = require('./concurrency');

function dayString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function aggregateDay(db, day) {
  const date = String(day || dayString());
  await db.query(
    `INSERT INTO policy_metrics_daily (day, policy_id, action, decision, request_source, team_id, hits, blocked, avg_eval_ms, p95_eval_ms)
     SELECT $1::date, policy_id, action, decision, request_source, team_id,
            COUNT(*),
            COUNT(*) FILTER (WHERE decision = 'block'),
            COALESCE(AVG(eval_ms), 0),
            COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY eval_ms), 0)
       FROM policy_hits
      WHERE created_at >= $1::date AND created_at < ($1::date + INTERVAL '1 day')
      GROUP BY policy_id, action, decision, request_source, team_id
     ON CONFLICT (day, policy_id, action, decision, request_source, team_id)
     DO UPDATE SET hits = EXCLUDED.hits, blocked = EXCLUDED.blocked,
       avg_eval_ms = EXCLUDED.avg_eval_ms, p95_eval_ms = EXCLUDED.p95_eval_ms`,
    [date]
  );
}

async function aggregateRecentDays(days = 2) {
  for (let offset = 0; offset < Math.max(1, days); offset += 1) {
    const date = new Date(Date.now() - offset * 86400000);
    await aggregateDay(pool, dayString(date)).catch(() => {});
  }
}

async function analytics({ from, to, groupBy = 'policy', limit = 50, teamIds = null } = {}) {
  const since = from ? new Date(from) : new Date(Date.now() - 7 * 86400000);
  const until = to ? new Date(to) : new Date();
  const groupMap = {
    policy: 'policy_id, policy_name',
    user: 'user_id',
    team: 'team_id',
    source: 'request_source',
    action: 'action',
    model: 'requested_model',
  };
  const group = groupMap[groupBy] || groupMap.policy;
  const order = groupBy === 'policy' ? 'policy_id' : groupBy === 'user' ? 'user_id' : groupBy === 'team' ? 'team_id' : groupBy === 'source' ? 'request_source' : groupBy === 'model' ? 'requested_model' : 'action';
  const hasTeams = Array.isArray(teamIds) && teamIds.length > 0;
  const teamFilter = hasTeams ? 'AND team_id = ANY($3::int[])' : '';
  const rowParams = [since, until, ...(hasTeams ? [teamIds] : []), Math.min(500, Math.max(1, limit))];
  const baseParams = [since, until, ...(hasTeams ? [teamIds] : [])];
  const limitPlaceholder = hasTeams ? '$4' : '$3';
  const [rows, series, totals] = await Promise.all([
    pool.query(
      `SELECT ${group},
              COUNT(*)::int AS hits,
              COUNT(*) FILTER (WHERE decision = 'block')::int AS blocked,
              COUNT(DISTINCT user_id)::int AS members
         FROM policy_hits
        WHERE created_at >= $1 AND created_at <= $2 ${teamFilter}
        GROUP BY ${group}
        ORDER BY hits DESC
        LIMIT ${limitPlaceholder}`,
      rowParams
    ),
    pool.query(
      `SELECT date_trunc('hour', created_at) AS bucket,
              COUNT(*)::int AS hits,
              COUNT(*) FILTER (WHERE decision = 'block')::int AS blocked
         FROM policy_hits
        WHERE created_at >= $1 AND created_at <= $2 ${teamFilter}
        GROUP BY bucket ORDER BY bucket ASC`,
      baseParams
    ),
    pool.query(
      `SELECT COUNT(*)::int AS hits,
              COUNT(*) FILTER (WHERE decision = 'block')::int AS blocked,
              COUNT(DISTINCT user_id)::int AS members,
              COALESCE(AVG(eval_ms), 0) AS avg_eval_ms
         FROM policy_hits WHERE created_at >= $1 AND created_at <= $2 ${teamFilter}`,
      baseParams
    ),
  ]);
  return {
    range: { from: since.toISOString(), to: until.toISOString() },
    groupBy,
    totals: totals.rows[0],
    rows: rows.rows.map(row => ({ ...row, group: row[order] })),
    series: series.rows,
  };
}

async function prometheusText() {
  const [hits, policies, queue] = await Promise.all([
    pool.query(`SELECT
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS hits_24h,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours' AND decision = 'block')::int AS blocked_24h,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour')::int AS hits_1h
      FROM policy_hits`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE enabled)::int AS enabled, COUNT(*)::int AS total FROM access_policies`),
    Promise.resolve(concurrency.stats()),
  ]);
  const h = hits.rows[0] || {};
  const p = policies.rows[0] || {};
  return [
    '# HELP crewrouter_policy_hits_total Policy hits in the last 24 hours',
    '# TYPE crewrouter_policy_hits_total gauge',
    `crewrouter_policy_hits_total ${Number(h.hits_24h || 0)}`,
    '# HELP crewrouter_policy_blocked_total Blocked requests in the last 24 hours',
    '# TYPE crewrouter_policy_blocked_total gauge',
    `crewrouter_policy_blocked_total ${Number(h.blocked_24h || 0)}`,
    '# HELP crewrouter_policy_hits_1h Policy hits in the last hour',
    '# TYPE crewrouter_policy_hits_1h gauge',
    `crewrouter_policy_hits_1h ${Number(h.hits_1h || 0)}`,
    '# HELP crewrouter_policy_enabled Number of enabled policies',
    '# TYPE crewrouter_policy_enabled gauge',
    `crewrouter_policy_enabled ${Number(p.enabled || 0)}`,
    '# HELP crewrouter_policy_total Number of policies',
    '# TYPE crewrouter_policy_total gauge',
    `crewrouter_policy_total ${Number(p.total || 0)}`,
    '# HELP crewrouter_policy_concurrency_active Active gateway requests',
    '# TYPE crewrouter_policy_concurrency_active gauge',
    `crewrouter_policy_concurrency_active ${Number(queue.active || 0)}`,
    '# HELP crewrouter_policy_queue_length Queued gateway requests',
    '# TYPE crewrouter_policy_queue_length gauge',
    `crewrouter_policy_queue_length ${Number(queue.queued || 0)}`,
    '',
  ].join('\n');
}

module.exports = { aggregateDay, aggregateRecentDays, analytics, prometheusText, dayString };
