'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const stats = require('./provider-quota-stats');
const { addMoney } = require('./money');
const { DEFAULTS } = require('./request-quota-config');
const Logger = require('../logger');

const DIMENSIONS = ['user', 'team', 'model', 'project', 'client', 'key', 'session'];
const dimensionColumns = { user: 'user_id', team: 'team_id', model: 'model', project: 'project_id', client: 'source', key: 'api_key_id', session: 'session_id' };
const numericFields = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'total_tokens', 'weighted_tokens', 'points'];
const snapshotFields = ['id', 'logical_request_id', 'user_id', 'team_id', 'api_key_id', 'project_id', 'session_id', 'source', 'platform', 'model', 'requested_model', 'streaming', 'provider_id', 'account_id', 'started_at', 'ended_at', 'status', 'error_class', 'usage_record_id', ...numericFields, 'usage_quality', 'capture_status', 'termination_quality'];
const uuid = value => {
  const hex = crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const iso = value => value == null ? null : new Date(value).toISOString();
const num = value => value == null || value === '' ? null : Number(value);
const json = value => typeof value === 'string' ? JSON.parse(value) : value || {};
function sampleSnapshot(item) {
  const result = {};
  for (const field of ['kind', 'unit', 'window_key', 'total', 'used', 'remaining', 'used_percent', 'resets_at']) {
    if (item[field] !== undefined) result[field] = item[field];
  }
  result.quality = {};
  for (const field of ['cached', 'source', 'precision', 'correction', 'unlimited', 'unknown_used', 'legacy', 'event']) {
    const value = item.quality?.[field];
    if (['string', 'number', 'boolean'].includes(typeof value) || value === null) result.quality[field] = value;
  }
  return result;
}
function percent(item) {
  if (item.kind === 'window') return num(item.used_percent);
  const total = num(item.total);
  if (!(total > 0) || item.quality?.unlimited) return null;
  if (item.used != null) return num(item.used) / total * 100;
  return item.remaining == null ? null : (total - num(item.remaining)) / total * 100;
}
function classify(previous, item) {
  if (!previous) return 'initial';
  if (item.quality?.correction) return 'correction';
  if (previous.resets_at && item.resets_at && new Date(item.resets_at) > new Date(previous.resets_at) && new Date(item.observed_at) >= new Date(previous.resets_at)) return 'reset';
  if (num(previous.total) !== num(item.total)) return 'adjustment';
  if (item.kind === 'window' && num(item.used_percent) < num(previous.used_percent)) return 'reset';
  if (item.kind === 'balance' && ((item.remaining != null && previous.remaining != null && num(item.remaining) > num(previous.remaining)) || (item.used != null && previous.used != null && num(item.used) < num(previous.used)))) return 'topup';
  const fields = item.kind === 'window' ? ['used_percent'] : ['used', 'remaining'];
  if (fields.some(key => item[key] != null && previous[key] != null && num(item[key]) !== num(previous[key]))) return 'consumption';
  return fields.every(key => item[key] == null || previous[key] == null) ? 'unknown' : 'unchanged';
}

async function ensureQuotaCycleSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS quota_cycle_dirty_attempts(attempt_id UUID PRIMARY KEY,account_id UUID NOT NULL,started_at TIMESTAMPTZ NOT NULL,ended_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS quota_cycle_series (
      account_id UUID NOT NULL, kind TEXT NOT NULL, unit TEXT NOT NULL, window_key TEXT NOT NULL,
      dirty BOOLEAN NOT NULL DEFAULT FALSE, rebuild_required BOOLEAN NOT NULL DEFAULT FALSE, due_at TIMESTAMPTZ,
      last_reconcile_at TIMESTAMPTZ, last_observed_at TIMESTAMPTZ, PRIMARY KEY(account_id,kind,unit,window_key)
    );
    ALTER TABLE quota_cycle_series ADD COLUMN IF NOT EXISTS request_dirty BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_quota_series_work ON quota_cycle_series(due_at) WHERE dirty OR due_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS quota_cycle_samples (
      id UUID PRIMARY KEY, observation_id TEXT NOT NULL, account_id UUID NOT NULL, provider_id TEXT NOT NULL,
      kind TEXT NOT NULL, unit TEXT NOT NULL, window_key TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), snapshot JSONB NOT NULL,
      UNIQUE(observation_id,account_id,kind,unit,window_key)
    );
    CREATE INDEX IF NOT EXISTS idx_quota_cycle_samples_series ON quota_cycle_samples(account_id,kind,unit,window_key,observed_at);
    CREATE TABLE IF NOT EXISTS quota_cycles (
      id UUID PRIMARY KEY, account_id UUID NOT NULL, provider_id TEXT NOT NULL, kind TEXT NOT NULL, unit TEXT NOT NULL,
      window_key TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ, resets_at TIMESTAMPTZ,
      start_percent NUMERIC, end_percent NUMERIC, state TEXT NOT NULL, inferred BOOLEAN NOT NULL,
      exhausted_at TIMESTAMPTZ, confirmed_at TIMESTAMPTZ, reconciliation_due_at TIMESTAMPTZ,
      version INTEGER NOT NULL DEFAULT 1, quality JSONB NOT NULL DEFAULT '{}', initial_snapshot JSONB NOT NULL, final_snapshot JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quota_cycles_account_time ON quota_cycles(account_id,started_at DESC);
    CREATE TABLE IF NOT EXISTS quota_change_intervals (
      id UUID PRIMARY KEY, cycle_id UUID NOT NULL REFERENCES quota_cycles(id), sequence INTEGER NOT NULL,
      started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ NOT NULL, event TEXT NOT NULL,
      before_snapshot JSONB NOT NULL, after_snapshot JSONB NOT NULL, observed_consumption NUMERIC,
      percent_change NUMERIC, version INTEGER NOT NULL, quality JSONB NOT NULL DEFAULT '{}', UNIQUE(cycle_id,sequence)
    );
    ALTER TABLE quota_change_intervals ADD COLUMN IF NOT EXISTS needs_link BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS quota_interval_requests (
      interval_id UUID NOT NULL REFERENCES quota_change_intervals(id) ON DELETE CASCADE,
      attempt_id UUID NOT NULL, cycle_id UUID NOT NULL, relation TEXT NOT NULL CHECK(relation IN ('certain','candidate','pending')),
      snapshot JSONB NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(interval_id,attempt_id)
    );
    CREATE INDEX IF NOT EXISTS idx_quota_interval_requests_cycle ON quota_interval_requests(cycle_id,attempt_id);
    CREATE INDEX IF NOT EXISTS idx_quota_interval_requests_overlap ON quota_interval_requests(cycle_id,((snapshot->>'started_at')),((snapshot->>'ended_at')));
    CREATE INDEX IF NOT EXISTS idx_quota_interval_requests_user ON quota_interval_requests((snapshot->>'user_id'),cycle_id);
    INSERT INTO quota_cycle_series(account_id,kind,unit,window_key,dirty,rebuild_required,last_observed_at)
      SELECT account_id,kind,unit,window_key,TRUE,TRUE,MAX(observed_at) FROM quota_cycle_samples GROUP BY account_id,kind,unit,window_key ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS quota_cycle_reports (
      cycle_id UUID NOT NULL REFERENCES quota_cycles(id), version INTEGER NOT NULL, reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), report JSONB NOT NULL, PRIMARY KEY(cycle_id,version)
    );
  `);
  const attempts=await db.query("SELECT to_regclass('request_attempts') AS name");
  if (attempts.rows[0]?.name) {
    await db.query(`CREATE TABLE IF NOT EXISTS quota_cycle_dirty_attempts(attempt_id UUID PRIMARY KEY,account_id UUID NOT NULL,started_at TIMESTAMPTZ NOT NULL,ended_at TIMESTAMPTZ);
      CREATE INDEX IF NOT EXISTS idx_quota_dirty_attempts_account ON quota_cycle_dirty_attempts(account_id);
      CREATE OR REPLACE FUNCTION quota_cycle_attempt_changed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE a RECORD;
      BEGIN
        IF TG_TABLE_NAME='request_attempts' THEN a:=NEW;
        ELSE SELECT account_id,id,started_at,ended_at INTO a FROM request_attempts WHERE id=NEW.attempt_id; END IF;
        IF a.account_id IS NOT NULL THEN
          INSERT INTO quota_cycle_dirty_attempts(attempt_id,account_id,started_at,ended_at) VALUES(a.id,a.account_id,a.started_at,a.ended_at)
          ON CONFLICT(attempt_id) DO UPDATE SET ended_at=EXCLUDED.ended_at;
          UPDATE quota_cycle_series SET dirty=TRUE,request_dirty=TRUE WHERE account_id=a.account_id;
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS quota_cycle_attempt_changed ON request_attempts;
      CREATE TRIGGER quota_cycle_attempt_changed AFTER INSERT OR UPDATE ON request_attempts FOR EACH ROW EXECUTE FUNCTION quota_cycle_attempt_changed();`);
    const samples=await db.query("SELECT to_regclass('request_quota_samples') AS name");
    if (samples.rows[0]?.name) await db.query(`DROP TRIGGER IF EXISTS quota_cycle_sample_changed ON request_quota_samples;
      CREATE TRIGGER quota_cycle_sample_changed AFTER INSERT OR UPDATE ON request_quota_samples FOR EACH ROW EXECUTE FUNCTION quota_cycle_attempt_changed();`);
  }
}

async function transaction(db, fn, isolation = '') {
  if (typeof db.connect !== 'function' || typeof db.totalCount !== 'number') return fn(db);
  const client = await db.connect();
  try { await client.query(`BEGIN ${isolation}`); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
function safeSnapshot(row) {
  const result = {};
  const metadata = json(row.metadata);
  for (const field of snapshotFields) {
    const value = row[field] ?? metadata[field];
    if (value !== undefined) result[field] = value;
  }
  const termination = json(row.termination_quality ?? metadata.termination_quality);
  result.termination_quality = {};
  for (const field of ['interrupted', 'end_time_inferred']) {
    if (typeof termination[field] === 'boolean') result.termination_quality[field] = termination[field];
  }
  for (const field of ['basis', 'end_time_basis']) {
    if (['started_at_only', 'last_owner_heartbeat', 'observed_terminal', 'actual'].includes(termination[field])) result.termination_quality[field] = termination[field];
  }
  return result;
}
async function linkRequests(db, interval, cycle, version, preserved = []) {
  const exists = await db.query("SELECT to_regclass('request_attempts') AS name");
  const saved = await db.query(`SELECT DISTINCT ON(attempt_id) attempt_id,snapshot FROM quota_interval_requests WHERE cycle_id=$1 AND (snapshot->>'started_at')::timestamptz < $3 AND ((snapshot->>'ended_at') IS NULL OR (snapshot->>'ended_at')::timestamptz > $2) ORDER BY attempt_id,version DESC`, [cycle.id,interval.started_at,interval.ended_at]);
  const attempts = new Map([...preserved, ...saved.rows].map(row => [row.attempt_id, row.snapshot]));
  if (exists.rows[0]?.name) {
    const rows = await db.query(`SELECT * FROM request_attempts WHERE account_id=$1 AND started_at < $3::timestamptz
      AND (ended_at IS NULL OR ended_at > $2::timestamptz)`, [cycle.account_id, interval.started_at, interval.ended_at]);
    for (const row of rows.rows) {
      const snapshot=safeSnapshot(row); snapshot.quota_samples=await requestSamples(db,row.id);
      attempts.set(row.id,snapshot);
    }
  }
  await db.query('DELETE FROM quota_interval_requests WHERE interval_id=$1', [interval.id]);
  let certain = 0, candidate = 0, pending = 0;
  for (const [id, snapshot] of attempts) {
    const start = new Date(snapshot.started_at), end = snapshot.ended_at && new Date(snapshot.ended_at);
    if (start >= new Date(interval.ended_at) || (end && end <= new Date(interval.started_at))) continue;
    const relation = !end ? 'pending' : !snapshot.termination_quality?.end_time_inferred && start >= new Date(interval.started_at) && end <= new Date(interval.ended_at) ? 'certain' : 'candidate';
    if (relation === 'certain') certain++; else if (relation === 'candidate') candidate++; else pending++;
    await db.query(`INSERT INTO quota_interval_requests(interval_id,attempt_id,cycle_id,relation,snapshot,version)
      VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(interval_id,attempt_id) DO UPDATE SET relation=EXCLUDED.relation,snapshot=EXCLUDED.snapshot,version=EXCLUDED.version`,
    [interval.id, id, cycle.id, relation, JSON.stringify(snapshot), version]);
  }
  await db.query('UPDATE quota_change_intervals SET quality=$2::jsonb WHERE id=$1', [interval.id, JSON.stringify({ certain, candidate, pending, unexplained_change: !(certain + candidate + pending) && interval.event === 'consumption', attribution: 'observed_interval_not_request_cost' })]);
}
function summarize(rows) {
  const result = { attempts: rows.length, logical_requests: new Set(rows.map(row => row.snapshot.logical_request_id || row.attempt_id)).size,
    certain: 0, candidate: 0, pending: 0, success: 0, failed: 0, cancelled: 0, retries: 0, streaming: 0, unknown_usage: 0, estimated_usage: 0, inferred_terminal: 0,
    first_request_at: null, last_request_at: null, latency_ms: { p50: null, p95: null, p99: null }, throughput_per_second: null };
  for (const field of numericFields) result[field] = null;
  const latency = [];
  for (const row of rows) {
    const s = row.snapshot;
    if (s.termination_quality?.end_time_inferred) result.inferred_terminal++;
    result[row.relation]++;
    if (s.status === 'success') result.success++; else if (s.status === 'cancelled') result.cancelled++; else result.failed++;
    if (s.streaming) result.streaming++;
    if (s.usage_quality === 'estimated') result.estimated_usage++;
    if (s.usage_quality === 'unknown' || s.total_tokens == null) result.unknown_usage++;
    for (const field of numericFields) if (s[field] != null) result[field] = field === 'points' ? addMoney(result[field], s[field]) : (result[field] || 0) + Number(s[field]);
    if (s.started_at && (!result.first_request_at || new Date(s.started_at) < new Date(result.first_request_at))) result.first_request_at = s.started_at;
    const last = s.ended_at || s.started_at;
    if (last && (!result.last_request_at || new Date(last) > new Date(result.last_request_at))) result.last_request_at = last;
    if (s.ended_at && !s.termination_quality?.end_time_inferred) latency.push(new Date(s.ended_at) - new Date(s.started_at));
  }
  result.retries = result.attempts - result.logical_requests;
  latency.sort((a, b) => a - b);
  for (const [key, p] of [['p50', .5], ['p95', .95], ['p99', .99]]) {
    if (!latency.length) continue;
    const index = (latency.length - 1) * p, lower = Math.floor(index), upper = Math.ceil(index);
    result.latency_ms[key] = latency[lower] + (latency[upper] - latency[lower]) * (index - lower);
  }
  const seconds = (new Date(result.last_request_at) - new Date(result.first_request_at)) / 1000;
  if (seconds > 0) result.throughput_per_second = result.attempts / seconds;
  return result;
}
async function requestFacts(db, cycleId, userId) {
  const result = await db.query(`SELECT DISTINCT ON(attempt_id) attempt_id,snapshot,relation FROM quota_interval_requests
    WHERE cycle_id=$1 ${userId == null ? '' : "AND snapshot->>'user_id'=$2"}
    ORDER BY attempt_id, CASE relation WHEN 'certain' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,version DESC`,
  userId == null ? [cycleId] : [cycleId, String(userId)]);
  return result.rows;
}
function filterFacts(rows, options = {}) {
  return rows.filter(row => Object.entries({ user_id: 'user_id', team_id: 'team_id', model_id: 'model', request_source: 'source', workspace_path: 'project_id', api_key_id: 'api_key_id' }).every(([key, field]) => !options[key] || String(row.snapshot[field]) === String(options[key])));
}
async function report(db, cycle, userId, options = {}) {
  const rows = filterFacts(await requestFacts(db, cycle.id, userId), options);
  const summary = summarize(rows), dimensions = {};
  for (const dimension of DIMENSIONS) {
    const groups = new Map();
    for (const row of rows) {
      const key = row.snapshot[dimensionColumns[dimension]] ?? null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    dimensions[dimension] = [...groups].map(([key, members]) => {
      const value = summarize(members);
      return { key, ...value, request_share: summary.attempts ? value.attempts / summary.attempts : null,
        token_share: summary.total_tokens > 0 ? (value.total_tokens || 0) / summary.total_tokens : null,
        points_share: summary.points > 0 ? (value.points || 0) / summary.points : null };
    }).sort((a, b) => b.attempts - a.attempts);
  }
  const totals = await db.query(`SELECT SUM(observed_consumption)::text AS observed_consumption,SUM(percent_change)::text AS percent_change,
    COUNT(*)::int AS intervals FROM quota_change_intervals WHERE cycle_id=$1`, [cycle.id]);
  return { cycle, summary, dimensions, quota: totals.rows[0], contribution_scope: userId == null ? 'all_authorized_requests' : 'self',
    coverage: { exact_request_cost: false, platform_requests_complete: false, samples_preserved: true, requests_preserved: true, ...await captureCoverage(db, cycle, userId) },
    caveats: ['额度为区间观测，不是单请求账单；可能包含平台外使用。', '请求、Token和积分贡献比例不代表上游额度分摊。'] };
}
async function publish(db, cycle, reason) {
  const payload = await report(db, cycle);
  const previous = await db.query('SELECT report FROM quota_cycle_reports WHERE cycle_id=$1 ORDER BY version DESC LIMIT 1', [cycle.id]);
  if (previous.rows.length) {
    const old = previous.rows[0].report;
    const comparable = value => { const copy = JSON.parse(JSON.stringify(value)); delete copy.cycle.version;
      for (const interval of copy.audit?.intervals || []) { delete interval.version; delete interval.needs_link; }
      return copy; };
    if (isDeepStrictEqual(comparable(old), comparable(payload))) {
      cycle.version = old.cycle.version;
      await db.query('UPDATE quota_cycles SET version=$2 WHERE id=$1', [cycle.id, cycle.version]);
      await db.query('UPDATE quota_change_intervals SET version=$2 WHERE cycle_id=$1', [cycle.id, cycle.version]);
      await db.query('UPDATE quota_interval_requests SET version=$2 WHERE cycle_id=$1', [cycle.id, cycle.version]);
      return;
    }
  }
  await db.query(`INSERT INTO quota_cycle_reports(cycle_id,version,reason,report) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`, [cycle.id, cycle.version, reason, JSON.stringify(payload)]);
  await trimCycleReportVersions(db, cycle.id);
}

// 每个周期只保留最近 MAX_REPORT_VERSIONS 个报告版本，防止 reconciliation 反复触发时
// 全量 audit 快照无限堆积（曾因无上限把表空间写满）。
const MAX_REPORT_VERSIONS = 10;
async function trimCycleReportVersions(db, cycleId) {
  try {
    await db.query(`DELETE FROM quota_cycle_reports
      WHERE cycle_id=$1 AND version <= (
        SELECT COALESCE(MAX(version),0) - $2 FROM quota_cycle_reports WHERE cycle_id=$1
      )`, [cycleId, MAX_REPORT_VERSIONS]);
  } catch (err) {
    Logger.warn(`[额度周期报告] 清理旧版本失败 ${cycleId}: ${err.message}`);
  }
}

async function rebuild(db, accountId, kind, unit, windowKey, reason, options = {}) {
  const all = await db.query(`SELECT DISTINCT ON(observed_at) * FROM quota_cycle_samples
    WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4 ORDER BY observed_at,received_at DESC,id DESC`, [accountId, kind, unit, windowKey]);
  const old = await db.query('SELECT * FROM quota_cycles WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4 FOR UPDATE', [accountId, kind, unit, windowKey]);
  const prior = new Map(old.rows.map(row => [row.id, row]));
  const preserved = await db.query(`SELECT r.attempt_id,r.snapshot FROM quota_interval_requests r JOIN quota_cycles c ON c.id=r.cycle_id
    WHERE c.account_id=$1 AND c.kind=$2 AND c.unit=$3 AND c.window_key=$4`, [accountId, kind, unit, windowKey]);
  let cycle, previous, baseline, sequence = 0;
  const activeIds = new Set();
  const now = options.now ? new Date(options.now) : new Date();
  const wait = options.reconciliationSeconds ?? DEFAULTS.reconciliation_seconds;
  if (!Number.isFinite(wait) || wait < 0) throw stats.invalid('无效的对账等待期');
  async function saveCycle() {
    if (!cycle) return;
    cycle.final_snapshot = previous;
    cycle.end_percent = percent(previous);
    const pending = await db.query("SELECT COUNT(DISTINCT attempt_id)::int AS count FROM quota_interval_requests WHERE cycle_id=$1 AND relation='pending'", [cycle.id]);
    cycle.quality.pending_requests = pending.rows[0].count;
    if (cycle.exhausted_at && ['active', 'partial', 'exhausted_pending_reconciliation', 'complete'].includes(cycle.state)) {
      cycle.reconciliation_due_at = new Date(new Date(cycle.exhausted_at).getTime() + wait * 1000).toISOString();
      const ready = now >= new Date(cycle.reconciliation_due_at);
      cycle.state = ready ? cycle.start_percent === 0 && !cycle.quality.gap && !cycle.quality.correction && !cycle.quality.pending_requests ? 'complete' : 'partial' : 'exhausted_pending_reconciliation';
      if (ready) cycle.confirmed_at = prior.get(cycle.id)?.confirmed_at || now.toISOString();
    }
    await db.query(`UPDATE quota_cycles SET ended_at=$2,end_percent=$3,state=$4,exhausted_at=$5,confirmed_at=$6,
      reconciliation_due_at=$7,final_snapshot=$8::jsonb,quality=$9::jsonb WHERE id=$1`,
    [cycle.id, cycle.ended_at, cycle.end_percent, cycle.state, cycle.exhausted_at, cycle.confirmed_at, cycle.reconciliation_due_at, JSON.stringify(previous), JSON.stringify(cycle.quality)]);
    await db.query(`DELETE FROM quota_change_intervals WHERE cycle_id=$1 AND sequence>$2`, [cycle.id, sequence]);
    // Reports are published after request facts and coverage reconcile.
  }
  async function interval(item, event) {
    sequence++;
    const id = uuid(`${cycle.id}:${sequence}`);
    await db.query(`INSERT INTO quota_change_intervals(id,cycle_id,sequence,started_at,ended_at,event,before_snapshot,after_snapshot,observed_consumption,percent_change,version)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,
        CASE WHEN $6='consumption' AND $9='balance' THEN CASE WHEN $8::jsonb->>'used' IS NOT NULL AND $7::jsonb->>'used' IS NOT NULL
          THEN ($8::jsonb->>'used')::numeric-($7::jsonb->>'used')::numeric ELSE ($7::jsonb->>'remaining')::numeric-($8::jsonb->>'remaining')::numeric END END,
        CASE WHEN $6='consumption' AND $9='window' THEN ($8::jsonb->>'used_percent')::numeric-($7::jsonb->>'used_percent')::numeric END,$10)
      ON CONFLICT(id) DO UPDATE SET started_at=EXCLUDED.started_at,ended_at=EXCLUDED.ended_at,event=EXCLUDED.event,before_snapshot=EXCLUDED.before_snapshot,
      after_snapshot=EXCLUDED.after_snapshot,observed_consumption=EXCLUDED.observed_consumption,percent_change=EXCLUDED.percent_change,version=EXCLUDED.version`,
    [id, cycle.id, sequence, baseline.observed_at, item.observed_at, event, JSON.stringify(baseline), JSON.stringify(item), kind, cycle.version]);
    await linkRequests(db, { id, started_at: baseline.observed_at, ended_at: item.observed_at, event }, cycle, cycle.version, preserved.rows);
    baseline = item;
  }
  for (const sample of all.rows) {
    const item = { ...sample.snapshot, sample_id: sample.id, observation_id: sample.observation_id, observed_at: iso(sample.observed_at), quality: json(sample.snapshot.quality) };
    const event = classify(previous, item);
    if (cycle && ['reset', 'adjustment', 'topup'].includes(event)) {
      await interval(item, event);
      cycle.ended_at = item.observed_at;
      cycle.state = event === 'reset' ? cycle.exhausted_at ? cycle.state : 'reset_before_exhaustion' : 'adjusted';
      await saveCycle(); cycle = null;
    }
    if (!cycle) {
      const id = uuid(`${accountId}:${kind}:${unit}:${windowKey}:${sample.id}`), oldCycle = prior.get(id);
      cycle = { id, account_id: accountId, provider_id: sample.provider_id, kind, unit, window_key: windowKey,
        started_at: item.observed_at, ended_at: null, resets_at: item.resets_at, start_percent: percent(item), end_percent: percent(item),
        state: percent(item) === 0 ? 'active' : 'partial', inferred: !item.resets_at, exhausted_at: null, confirmed_at: null, reconciliation_due_at: null,
        version: (oldCycle?.version || 0) + 1, quality: { initial_gap: percent(item) !== 0 }, initial_snapshot: item, final_snapshot: item };
      sequence = 0; baseline = item; activeIds.add(id);
      await db.query(`INSERT INTO quota_cycles(id,account_id,provider_id,kind,unit,window_key,started_at,resets_at,start_percent,end_percent,state,inferred,version,initial_snapshot,final_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13::jsonb,$13::jsonb)
        ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,initial_snapshot=EXCLUDED.initial_snapshot,start_percent=EXCLUDED.start_percent`,
      [id, accountId, sample.provider_id, kind, unit, windowKey, item.observed_at, item.resets_at, cycle.start_percent, cycle.state, cycle.inferred, cycle.version, JSON.stringify(item)]);
    } else if (event !== 'unchanged') await interval(item, event);
    if (previous && new Date(item.observed_at) - new Date(previous.observed_at) > (options.gapSeconds ?? 86400) * 1000) cycle.quality.gap = true;
    if (item.quality?.correction) cycle.quality.correction = true;
    cycle.quality.samples = (cycle.quality.samples || 0) + 1;
    if (item.quality?.cached) cycle.quality.cached_samples = (cycle.quality.cached_samples || 0) + 1;
    if (percent(item) >= 100 && percent(item) !== null && !cycle.exhausted_at) cycle.exhausted_at = item.observed_at;
    previous = item;
  }
  if (cycle) {
    if (baseline.observed_at !== previous.observed_at) await interval(previous, 'unchanged');
    await saveCycle();
  }
  for (const stale of old.rows) if (!activeIds.has(stale.id)) {
    stale.state = 'invalidated'; stale.version++;
    await db.query("UPDATE quota_cycles SET state='invalidated',version=$2 WHERE id=$1", [stale.id, stale.version]);
    await publish(db, stale, 'reconciliation_invalidated');
  }
  return [...activeIds];
}
async function markSeriesDirty(db, accountId) {
  if (!accountId) return;
  const installed = await db.query("SELECT to_regclass('quota_cycle_series') AS name");
  if (!installed.rows[0]?.name) return;
  await db.query('UPDATE quota_cycle_series SET dirty=TRUE,request_dirty=TRUE WHERE account_id=$1', [accountId]);
}
async function captureCoverage(db, cycle, userId) {
  const facts = await requestFacts(db, cycle.id, userId);
  const result = { failed_samples: 0, unsupported_samples: 0, missing_samples: 0, post_start_baselines: 0, cached_samples: 0 };
  for (const row of facts) {
    const samples = row.snapshot.quota_samples || [];
    for (const phase of ['baseline', 'terminal']) {
      const phased = samples.filter(sample => sample.phase === phase);
      if (!phased.length || !phased.some(sample => sample.normalized_snapshot?.items?.length)) result.missing_samples++;
      for (const sample of phased) {
        const quality = sample.quality || {};
        if (['failed', 'rate_limited', 'pending', 'running'].includes(quality.status)) result.failed_samples++;
        if (quality.status === 'unsupported') result.unsupported_samples++;
        if (quality.post_start_baseline && phase === 'baseline') result.post_start_baselines++;
        if (sample.reused || quality.cached) result.cached_samples++;
      }
    }
  }
  result.gap = Object.values(result).some(value => value > 0);
  return result;
}
async function requestSamples(db, attemptId) {
  const exists = await db.query("SELECT to_regclass('request_quota_samples') AS name");
  if (!exists.rows[0]?.name) return [];
  const samples = await db.query(`SELECT id,phase,observation_id,sample_age_ms,reused,quality,normalized_snapshot
    FROM request_quota_samples WHERE attempt_id=$1 ORDER BY phase,id`, [attemptId]);
  return samples.rows;
}
async function incremental(db, series, sample, options) {
  const latest = await db.query(`SELECT * FROM quota_cycles WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4
    AND state!='invalidated' ORDER BY started_at DESC LIMIT 1 FOR UPDATE`, series);
  let cycle = latest.rows[0];
  const item = { ...sample.snapshot, sample_id: sample.id, observation_id: sample.observation_id, observed_at: iso(sample.observed_at) };
  let previous = cycle?.final_snapshot;
  const event = classify(previous, item);
  const boundary = ['reset','topup','adjustment'].includes(event);
  if (cycle && boundary) {
    const last=await db.query('SELECT COALESCE(MAX(sequence),0)::int AS n FROM quota_change_intervals WHERE cycle_id=$1',[cycle.id]);
    const sequence=last.rows[0].n+1;
    await db.query(`INSERT INTO quota_change_intervals(id,cycle_id,sequence,started_at,ended_at,event,before_snapshot,after_snapshot,version) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
      [uuid(`${cycle.id}:${sequence}`),cycle.id,sequence,previous.observed_at,item.observed_at,event,JSON.stringify(previous),JSON.stringify(item),cycle.version]);
    await db.query(`UPDATE quota_cycles SET ended_at=$2,state=CASE WHEN exhausted_at IS NOT NULL AND $3='reset' THEN state
      WHEN $3='reset' THEN 'reset_before_exhaustion' ELSE 'adjusted' END WHERE id=$1`, [cycle.id,item.observed_at,event]);
    cycle = null;
  }
  if (!cycle) {
    const id = uuid(`${series.join(':')}:${sample.id}`);
    await db.query(`INSERT INTO quota_cycles(id,account_id,provider_id,kind,unit,window_key,started_at,resets_at,start_percent,end_percent,state,inferred,initial_snapshot,final_snapshot,quality,version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12::jsonb,$12::jsonb,$13::jsonb,0)`,
    [id,series[0],sample.provider_id,series[1],series[2],series[3],item.observed_at,item.resets_at,percent(item),percent(item)===0?'active':'partial',!item.resets_at,JSON.stringify(item),JSON.stringify({samples:1,initial_gap:percent(item)!==0})]);
    cycle = (await db.query('SELECT * FROM quota_cycles WHERE id=$1',[id])).rows[0];
  } else {
    const last = await db.query('SELECT * FROM quota_change_intervals WHERE cycle_id=$1 ORDER BY sequence DESC LIMIT 1',[cycle.id]);
    const existing = last.rows[0];
    const extend = existing?.event==='unchanged';
    const sequence = extend ? existing.sequence : (existing?.sequence || 0)+1;
    const baseline = extend ? existing.before_snapshot : previous;
    const intervalEvent = classify(baseline,item);
    const id = uuid(`${cycle.id}:${sequence}`);
    await db.query(`INSERT INTO quota_change_intervals(id,cycle_id,sequence,started_at,ended_at,event,before_snapshot,after_snapshot,version,observed_consumption,percent_change)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,
      CASE WHEN $6='consumption' AND $10='balance' THEN COALESCE(($8::jsonb->>'used')::numeric-($7::jsonb->>'used')::numeric,($7::jsonb->>'remaining')::numeric-($8::jsonb->>'remaining')::numeric) END,
      CASE WHEN $6='consumption' AND $10='window' THEN ($8::jsonb->>'used_percent')::numeric-($7::jsonb->>'used_percent')::numeric END)
      ON CONFLICT(id) DO UPDATE SET ended_at=EXCLUDED.ended_at,event=EXCLUDED.event,after_snapshot=EXCLUDED.after_snapshot,
      observed_consumption=EXCLUDED.observed_consumption,percent_change=EXCLUDED.percent_change,needs_link=TRUE`,
    [id,cycle.id,sequence,baseline.observed_at,item.observed_at,intervalEvent,JSON.stringify(baseline),JSON.stringify(item),cycle.version,series[1]]);
    const quality = { ...cycle.quality,samples:(cycle.quality.samples||0)+1 };
    if (item.resets_at && new Date(item.observed_at)>=new Date(item.resets_at)) { quality.stale_window_boundary=true; quality.gap=true; }
    if (item.quality?.cached) { quality.cached_samples=(quality.cached_samples||0)+1; quality.gap=true; }
    if (new Date(item.observed_at)-new Date(previous.observed_at)>(options.gapSeconds??86400)*1000) quality.gap=true;
    await db.query('UPDATE quota_cycles SET final_snapshot=$2::jsonb,end_percent=$3,resets_at=COALESCE($4,resets_at),quality=$5::jsonb WHERE id=$1',
      [cycle.id,JSON.stringify(item),percent(item),item.resets_at,JSON.stringify(quality)]);
  }
  if (percent(item)!==null && percent(item)>=100) {
    const due = new Date(new Date(item.observed_at).getTime()+(options.reconciliationSeconds??DEFAULTS.reconciliation_seconds)*1000);
    await db.query(`UPDATE quota_cycles SET exhausted_at=COALESCE(exhausted_at,$2),reconciliation_due_at=COALESCE(reconciliation_due_at,$3),
      state='exhausted_pending_reconciliation' WHERE id=$1 AND confirmed_at IS NULL`,[cycle.id,item.observed_at,due]);
  }
  return cycle.id;
}
async function processObservation(db, observation, items = observation.items || [], options = {}) {
  const accountId = observation.account_id || observation.accountId;
  const providerId = observation.provider_id || observation.providerId;
  const observedAt = iso(observation.observed_at || observation.observedAt);
  const observationId = observation.id || observation.observationId || observation.observation_id || uuid(JSON.stringify([accountId,providerId,observedAt,items]));
  if (!accountId || !providerId) throw stats.invalid('样本缺少账户或供应商身份');
  if (observation.status==='failed') {
    await db.query(`UPDATE quota_cycles SET quality=quality||'{"gap":true,"failed_observation":true}'::jsonb WHERE account_id=$1 AND ended_at IS NULL`,[accountId]);
    await markSeriesDirty(db,accountId); return {cycles:[],skipped:true};
  }
  return transaction(db,async client=>{
    const cycles=[];
    for (const item of [...items].sort((a,b)=>JSON.stringify([a.kind,a.unit,a.window_key]).localeCompare(JSON.stringify([b.kind,b.unit,b.window_key])))) {
      if (!['balance','window'].includes(item.kind)) continue;
      const series=[accountId,item.kind,item.unit,item.window_key||''];
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(series)]);
      await client.query(`INSERT INTO quota_cycle_series(account_id,kind,unit,window_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,series);
      const state=(await client.query('SELECT * FROM quota_cycle_series WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4 FOR UPDATE',series)).rows[0];
      const saved=await client.query(`INSERT INTO quota_cycle_samples(id,observation_id,account_id,provider_id,kind,unit,window_key,observed_at,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING RETURNING *`,
      [uuid(`${observationId}:${JSON.stringify(series)}`),String(observationId),accountId,providerId,item.kind,item.unit,item.window_key||'',observedAt,JSON.stringify(sampleSnapshot(item))]);
      if (!saved.rowCount) continue;
      const backfill=state.rebuild_required || item.quality?.correction || (state.last_observed_at && new Date(observedAt)<=new Date(state.last_observed_at));
      if (!backfill) {
        const id=await incremental(client,series,saved.rows[0],options); cycles.push(id);
        if (observation.status==='partial') await client.query(`UPDATE quota_cycles SET quality=quality||'{"gap":true,"partial_observation":true}'::jsonb WHERE id=$1`,[id]);
      }
      await client.query(`UPDATE quota_cycle_series SET dirty=TRUE,rebuild_required=rebuild_required OR $5,
        last_observed_at=GREATEST(last_observed_at,$6::timestamptz) WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4`,[...series,!!backfill,observedAt]);
    }
    return {cycles:[...new Set(cycles)],reports_pending:true};
  });
}
async function reconcileCycles(db, options = {}) {
  return transaction(db,async client=>{
    const now=options.now?new Date(options.now):new Date();
    const work=await client.query(`SELECT * FROM quota_cycle_series WHERE dirty OR due_at <= $1 ORDER BY account_id,kind,unit,window_key`,[now]);
    let count=0;
    for (const row of work.rows) {
      const series=[row.account_id,row.kind,row.unit,row.window_key];
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(series)]);
      const locked=await client.query('SELECT * FROM quota_cycle_series WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4 FOR UPDATE',series);
      Object.assign(row,locked.rows[0]);
      if (!row.dirty && (!row.due_at || new Date(row.due_at)>now)) continue;
      if (row.rebuild_required) await rebuild(client,...series,'backfill',options);
      const cycles=await client.query(`SELECT * FROM quota_cycles c WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4 AND state!='invalidated'
        AND (ended_at IS NULL OR state='exhausted_pending_reconciliation' OR EXISTS(SELECT 1 FROM quota_change_intervals i WHERE i.cycle_id=c.id AND i.needs_link)
        OR ($5 AND (NOT EXISTS(SELECT 1 FROM quota_cycle_dirty_attempts WHERE account_id=$1) OR EXISTS(SELECT 1 FROM quota_cycle_dirty_attempts d
          WHERE d.account_id=$1 AND d.started_at<=COALESCE(c.ended_at,'infinity'::timestamptz) AND (d.ended_at IS NULL OR d.ended_at>c.started_at)))))`,[...series,row.request_dirty]);
      for (const cycle of cycles.rows) {
        const intervals=await client.query(`SELECT * FROM quota_change_intervals i WHERE cycle_id=$1 AND (needs_link OR ($2 AND (
          NOT EXISTS(SELECT 1 FROM quota_cycle_dirty_attempts WHERE account_id=$3) OR EXISTS(SELECT 1 FROM quota_cycle_dirty_attempts d
            WHERE d.account_id=$3 AND d.started_at<i.ended_at AND (d.ended_at IS NULL OR d.ended_at>i.started_at))))) ORDER BY sequence`,[cycle.id,row.request_dirty,row.account_id]);
        for (const interval of intervals.rows) {
          await linkRequests(client,interval,cycle,cycle.version);
          await client.query('UPDATE quota_change_intervals SET needs_link=FALSE WHERE id=$1',[interval.id]);
        }
        const coverage=await captureCoverage(client,cycle);
        cycle.quality={...cycle.quality,capture:coverage};
        if (cycle.exhausted_at && cycle.reconciliation_due_at && now>=new Date(cycle.reconciliation_due_at) && !['adjusted','reset_before_exhaustion'].includes(cycle.state)) {
          const facts=await requestFacts(client,cycle.id);
          cycle.quality.pending_requests=facts.filter(fact=>fact.relation==='pending').length;
          cycle.state=num(cycle.start_percent)===0 && cycle.end_percent>=100 && !cycle.quality.gap && !cycle.quality.correction && !coverage.gap && !cycle.quality.pending_requests?'complete':'partial';
          cycle.confirmed_at=cycle.confirmed_at||now.toISOString();
        }
        cycle.version++;
        await client.query('UPDATE quota_cycles SET state=$2,confirmed_at=$3,quality=$4::jsonb,version=$5 WHERE id=$1',[cycle.id,cycle.state,cycle.confirmed_at,JSON.stringify(cycle.quality),cycle.version]);
        await publish(client,cycle,row.rebuild_required?'backfill':'reconciliation');
      }
      await client.query(`UPDATE quota_cycle_series SET dirty=FALSE,request_dirty=FALSE,rebuild_required=FALSE,last_reconcile_at=$5,
        due_at=(SELECT MIN(reconciliation_due_at) FROM quota_cycles WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4 AND confirmed_at IS NULL AND state='exhausted_pending_reconciliation')
        WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4`,[...series,now]);
      count++;
    }
    for (const accountId of new Set(work.rows.map(row=>row.account_id))) {
      await client.query('DELETE FROM quota_cycle_dirty_attempts WHERE account_id=$1 AND NOT EXISTS(SELECT 1 FROM quota_cycle_series WHERE account_id=$1 AND dirty)',[accountId]);
    }
    return {reconciled:count};
  });
}

async function access(db, query, scope, userId) {
  if (scope === 'user' && (query.user_id || query.team_id)) throw stats.invalid('无效的用户关联筛选');
  if (stats.resolveQuotaAccess) return stats.resolveQuotaAccess(db, query, scope, userId);
  return { scope, userId };
}
function parseQuery(query = {}) {
  const options = stats.parseQuotaQuery({ ...query, status: undefined });
  if (query.status && !['active', 'exhausted_pending_reconciliation', 'complete', 'reset_before_exhaustion', 'partial', 'adjusted', 'invalidated'].includes(query.status)) throw stats.invalid('无效的周期状态');
  if (query.version != null && (!/^\d+$/.test(String(query.version)) || Number(query.version) < 1)) throw stats.invalid('无效的报告版本');
  if (query.dimension && !DIMENSIONS.includes(query.dimension)) throw stats.invalid('无效的报告维度');
  return { ...options, status: query.status, version: query.version && Number(query.version), dimension: query.dimension };
}
function scopeSql(options, scope, userId, params) {
  const permission = stats.accountScope(options, scope, userId, params);
  return `EXISTS(SELECT 1 FROM provider_quota_accounts qa JOIN provider_quota_account_providers qp ON qp.account_id=qa.id
    CROSS JOIN LATERAL (SELECT qa.id,qp.provider_id) a WHERE qa.id=c.account_id AND ${permission})`;
}
async function queryQuotaCycles(db, query = {}, scope = 'admin', userId) {
  await access(db, query, scope, userId);
  const options = parseQuery(query), params = [options.start, options.end];
  const conditions = [scopeSql(options, scope, userId, params), "c.started_at < (($2::date+INTERVAL '1 day') AT TIME ZONE 'Asia/Shanghai')", "COALESCE(c.ended_at,'infinity'::timestamptz)>=($1::date AT TIME ZONE 'Asia/Shanghai')"];
  for (const key of ['kind', 'unit', 'window_key', 'status']) if (options[key] != null) { params.push(options[key]); conditions.push(`c.${key === 'status' ? 'state' : key}=$${params.length}`); }
  const where = conditions.join(' AND ');
  const total = await db.query(`SELECT COUNT(*)::int AS total FROM quota_cycles c WHERE ${where}`, params);
  const rows = await db.query(`SELECT c.* FROM quota_cycles c WHERE ${where} ORDER BY c.started_at DESC,c.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, options.limit, (options.page - 1) * options.limit]);
  return { rows: rows.rows, total: total.rows[0].total, page: options.page, limit: options.limit };
}
async function authorizedCycle(db, id, query, scope, userId) {
  await access(db, query, scope, userId);
  const options = parseQuery(query), params = [String(id)];
  const permission = scopeSql(options, scope, userId, params);
  const result = await db.query(`SELECT c.* FROM quota_cycles c WHERE c.id::text=$1 AND ${permission}`, params);
  if (!result.rows.length) { const error = new Error('额度周期不存在或无权限'); error.status = 404; throw error; }
  return { cycle: result.rows[0], options };
}
async function queryQuotaCycle(db, id, query = {}, scope = 'admin', userId) {
  const { cycle, options } = await authorizedCycle(db, id, query, scope, userId);
  if (scope === 'user' && options.version && options.version !== cycle.version) throw stats.invalid('个人贡献仅提供当前对账版本');
  if (scope === 'admin' && options.version) {
    const saved = await db.query('SELECT report FROM quota_cycle_reports WHERE cycle_id=$1 AND version=$2', [cycle.id, options.version]);
    if (!saved.rows.length) throw stats.invalid('报告版本不存在');
    return saved.rows[0].report;
  }
  const result = await report(db, cycle, scope === 'user' ? userId : null, options);
  if (options.dimension) result.dimensions = { [options.dimension]: result.dimensions[options.dimension] };
  if (scope === 'admin') {
    const versions = await db.query('SELECT version,reason,created_at FROM quota_cycle_reports WHERE cycle_id=$1 ORDER BY version DESC', [cycle.id]);
    result.versions = versions.rows;
  }
  return result;
}
async function queryQuotaIntervals(db, id, query = {}, scope = 'admin', userId) {
  const { cycle, options } = await authorizedCycle(db, id, query, scope, userId);
  const total = await db.query('SELECT COUNT(*)::int AS total FROM quota_change_intervals WHERE cycle_id=$1', [cycle.id]);
  const rows = await db.query(`SELECT * FROM quota_change_intervals WHERE cycle_id=$1 ORDER BY sequence LIMIT $2 OFFSET $3`, [cycle.id, options.limit, (options.page - 1) * options.limit]);
  if (scope === 'user') for (const row of rows.rows) {
    const facts = await db.query("SELECT attempt_id,snapshot,relation FROM quota_interval_requests WHERE interval_id=$1 AND snapshot->>'user_id'=$2", [row.id, String(userId)]);
    row.quality = { attribution: 'observed_interval_not_request_cost' };
    row.summary = summarize(filterFacts(facts.rows, options));
  }
  return { rows: rows.rows, total: total.rows[0].total, page: options.page, limit: options.limit };
}
async function queryQuotaRequests(db, id, query = {}, scope = 'admin', userId) {
  const { cycle, options } = await authorizedCycle(db, id, query, scope, userId);
  const params=[cycle.id];
  const conditions=['cycle_id=$1'];
  if (scope==='user') { params.push(String(userId)); conditions.push(`snapshot->>'user_id'=$${params.length}`); }
  for (const [key,field] of Object.entries({user_id:'user_id',team_id:'team_id',model_id:'model',request_source:'source',workspace_path:'project_id',api_key_id:'api_key_id'})) {
    if (options[key]) { params.push(options[key]); conditions.push(`snapshot->>'${field}'=$${params.length}`); }
  }
  const source=`(SELECT DISTINCT ON(attempt_id) attempt_id,snapshot,relation FROM quota_interval_requests WHERE ${conditions.join(' AND ')}
    ORDER BY attempt_id,CASE relation WHEN 'certain' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,version DESC) facts`;
  const total=await db.query(`SELECT COUNT(*)::int AS total FROM ${source}`,params);
  const selected=await db.query(`SELECT * FROM ${source} ORDER BY snapshot->>'started_at' DESC,attempt_id LIMIT $${params.length+1} OFFSET $${params.length+2}`,
    [...params,options.limit,(options.page-1)*options.limit]);
  const paged=selected.rows;
  for (const row of paged) {
    const links = await db.query('SELECT interval_id,relation,version FROM quota_interval_requests WHERE cycle_id=$1 AND attempt_id=$2 ORDER BY interval_id', [cycle.id, row.attempt_id]);
    row.intervals = links.rows;
    const freshSamples=await requestSamples(db,row.attempt_id);
    row.samples=freshSamples.length?freshSamples:(row.snapshot.quota_samples||[]);
  }
  return { rows: paged, total: total.rows[0].total, page: options.page, limit: options.limit };
}
async function exportQuotaCycle(db, id, query = {}, scope = 'admin', userId) {
  return transaction(db, client => exportCurrentQuotaCycle(client, id, query, scope, userId), 'ISOLATION LEVEL REPEATABLE READ READ ONLY');
}
async function exportCurrentQuotaCycle(db, id, query, scope, userId) {
  if (query.format && !['json', 'csv'].includes(query.format)) throw stats.invalid('无效的导出格式');
  const { cycle, options } = await authorizedCycle(db,id,query,scope,userId);
  if (options.version && options.version !== cycle.version) throw stats.invalid('不支持历史版本导出，请查看历史报告');
  const expectedVersion = query.expected_version ?? query.version;
  if (expectedVersion != null && (!/^[1-9]\d*$/.test(String(expectedVersion)) || Number(expectedVersion) !== cycle.version)) throw stats.invalid('报告版本已变化，请刷新后重试导出');
  const payload = await report(db,cycle,scope==='user'?userId:null,options);
  const cap = 10000;
  const cursor = query.cursor == null ? 0 : Number(query.cursor);
  if (!Number.isInteger(cursor) || cursor < 0) throw stats.invalid('无效的导出游标');
  if (cursor && expectedVersion == null) throw stats.invalid('继续导出需要expected_version绑定报告版本');
  const facts=filterFacts(await requestFacts(db,cycle.id,scope==='user'?userId:null),options)
    .sort((a,b)=>a.attempt_id.localeCompare(b.attempt_id));
  const rows=facts.slice(cursor,cursor+cap);
  for (const row of rows) row.samples=row.snapshot.quota_samples||[];
  const requests={rows,total:facts.length,offset:cursor,limit:cap};
  const metadata={complete:cursor+rows.length>=facts.length,next_cursor:cursor+rows.length<facts.length?String(cursor+rows.length):null,safe_cap:cap,total:facts.length,version:cycle.version,expected_version:cycle.version};
  if (query.format !== 'csv') return { ...payload,requests,export_paged:!metadata.complete,export:metadata };
  if (!metadata.complete || cursor) throw stats.invalid('CSV导出超过安全上限，请使用JSON游标分段导出');
  const fields = ['attempt_id', 'relation', 'user_id', 'team_id', 'model', 'project_id', 'source', 'api_key_id', 'session_id', 'status', ...numericFields];
  const cell = value => { let text = String(value ?? ''); if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"`; };
  return [fields.join(','), ...requests.rows.map(row => fields.map(field => cell(row[field] ?? row.snapshot[field])).join(','))].join('\n');
}

function registerQuotaCycleRoutes(router, db, middleware, scope) {
  for (const [suffix, handler] of [['', queryQuotaCycles], ['/:id', queryQuotaCycle], ['/:id/intervals', queryQuotaIntervals], ['/:id/requests', queryQuotaRequests], ['/:id/export', exportQuotaCycle]]) {
    router.get(`/stats/provider-quota/cycles${suffix}`, ...middleware, async (req, res) => {
      try {
        const userId = scope === 'user' ? req.session.user.id : undefined;
        const result = suffix ? await handler(db, req.params.id, req.query, scope, userId) : await handler(db, req.query, scope, userId);
        if (typeof result === 'string') return res.type('text/csv').attachment('quota-cycle.csv').send(result);
        res.json(result);
      } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '服务器错误' }); }
    });
  }
}

module.exports = { ensureQuotaCycleSchema, processObservation, reconcileCycles, markSeriesDirty, markAccountDirty: markSeriesDirty, queryQuotaCycles, queryQuotaCycle, queryQuotaIntervals, queryQuotaRequests, exportQuotaCycle, registerQuotaCycleRoutes, percent, classify, summarize };
