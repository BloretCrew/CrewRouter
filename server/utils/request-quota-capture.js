'use strict';

const crypto = require('node:crypto');
const { getQuotaCapturePool } = require('./quota-capture-database');
const Logger = require('../logger');
const history = require('./provider-quota-history');
const { normalizeProviderKeyEntries } = require('./provider-keys');
const { DEFAULTS: DEFAULT_CAPTURE_CONFIG, normalizeRequestQuotaConfig } = require('./request-quota-config');

const KEY_MODES = new Set(['script', 'opencode_go', 'commandcode', 'newapi', 'deepseek', 'cursor']);
const TERMINAL = new Set(['success', 'failed', 'cancelled', 'timeout', 'rejected']);
const ERROR_CLASSES = new Set(['network_error', 'upstream_error', 'protocol_error', 'stream_error', 'rate_limited', 'failed', 'cancelled', 'timeout', 'rejected']);
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'total_tokens', 'weighted_tokens', 'points'];
const INSTANCE_ID = crypto.randomUUID();
let heartbeatTimer;
let timer;
let ticking = false;

let configCache = new WeakMap();

function invalidateCaptureConfig(db) {
  if (db) configCache.delete(db);
  else configCache = new WeakMap();
}

async function getCaptureConfig(db = getQuotaCapturePool(), { fresh = false } = {}) {
  const cached = configCache.get(db);
  if (!fresh && cached && Date.now() - cached.at < 30000) return { ...cached.value };
  let stored = {};
  try {
    const result = await db.query("SELECT value FROM settings WHERE key='quota.request_capture_config'");
    stored = result.rows[0]?.value || {};
    if (typeof stored === 'string') stored = JSON.parse(stored);
  } catch (error) {
    if (error.code !== '42P01') throw error;
  }
  const value = normalizeRequestQuotaConfig(stored);
  configCache.set(db, { at: Date.now(), value });
  return { ...value };
}

async function markDirty(db, accountId) {
  const cycle = require('./quota-cycle-analysis');
  if (accountId && typeof cycle.markAccountDirty === 'function') await cycle.markAccountDirty(db, accountId);
}

async function normalizedSnapshot(db, observation) {
  if (!observation) return {};
  const items = await db.query(`SELECT kind,unit,window_key,total,used,remaining,used_percent,resets_at,quality
    FROM provider_quota_observation_items WHERE observation_id=$1 ORDER BY kind,unit,window_key`, [observation.id]);
  return { account_id: observation.account_id, observed_at: observation.observed_at, checked_at: observation.checked_at,
    status: observation.status, quality: observation.quality, items: items.rows };
}

function captureReason(provider) {
  if (!provider) return 'provider_missing';
  if (provider.quota_enabled !== true) return 'quota_not_enabled';
  if (provider.request_quota_capture_enabled === false) return 'capture_disabled';
  return null;
}

function bindIdentity(provider, key) {
  const actualKey = typeof key === 'string' ? key : key?.key;
  if (KEY_MODES.has(provider.quota_mode || 'script') && !actualKey) return null;
  return history.stableIdentity(provider, actualKey);
}

function configIdentity(provider, identity) {
  return history.stableIdentity({ ...provider, quota_mode: 'script' }, identity).identity;
}

function resolveCredential(provider, identity) {
  if (!provider) return null;
  if (!KEY_MODES.has(provider.quota_mode || 'script')) {
    return history.stableIdentity(provider).identity === identity ? provider : null;
  }
  const entry = normalizeProviderKeyEntries(provider).find(item => history.stableIdentity(provider, item.key).identity === identity);
  return entry ? { ...provider, api_key: entry.key, api_keys: [{ ...entry, enabled: true }] } : null;
}

function usageValues(metadata) {
  return USAGE_FIELDS.map(field => {
    const value = metadata[field];
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? String(value) : null;
  });
}

async function ensureRequestQuotaSchema(db) {
  await db.query(`
    ALTER TABLE providers ADD COLUMN IF NOT EXISTS request_quota_capture_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS request_attempts (
      id UUID PRIMARY KEY, logical_request_id UUID NOT NULL, user_id INTEGER, team_id INTEGER, api_key_id INTEGER,
      project_id TEXT, session_id TEXT, source TEXT, platform TEXT, model TEXT, requested_model TEXT,
      streaming BOOLEAN NOT NULL DEFAULT FALSE, provider_id TEXT NOT NULL,
      account_id UUID REFERENCES provider_quota_accounts(id), credential_identity TEXT, config_version TEXT,
      started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ,
      status TEXT NOT NULL CHECK(status IN ('running','success','failed','cancelled','timeout','rejected')),
      error_class TEXT, usage_record_id BIGINT, input_tokens NUMERIC, output_tokens NUMERIC,
      cache_read_tokens NUMERIC, cache_creation_tokens NUMERIC, total_tokens NUMERIC, weighted_tokens NUMERIC,
      points NUMERIC, usage_quality TEXT NOT NULL DEFAULT 'unknown' CHECK(usage_quality IN ('actual','estimated','unknown')),
      capture_status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_request_attempt_account_time ON request_attempts(account_id,started_at,ended_at);
    CREATE INDEX IF NOT EXISTS idx_request_attempt_user_time ON request_attempts(user_id,started_at);
    CREATE INDEX IF NOT EXISTS idx_request_attempt_logical ON request_attempts(logical_request_id);
    CREATE INDEX IF NOT EXISTS idx_request_attempt_provider_time ON request_attempts(provider_id,started_at);
    CREATE TABLE IF NOT EXISTS quota_capture_jobs (
      id UUID PRIMARY KEY, attempt_id UUID NOT NULL REFERENCES request_attempts(id),
      phase TEXT NOT NULL CHECK(phase IN ('baseline','terminal')), account_id UUID REFERENCES provider_quota_accounts(id),
      status TEXT NOT NULL CHECK(status IN ('pending','running','success','failed','rate_limited','unsupported')),
      triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), query_started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), lease_until TIMESTAMPTZ, lease_token UUID,
      tries INTEGER NOT NULL DEFAULT 0, error TEXT, UNIQUE(attempt_id,phase)
    );
    CREATE INDEX IF NOT EXISTS idx_quota_capture_due ON quota_capture_jobs(available_at,lease_until) WHERE status IN ('pending','running','rate_limited');
    CREATE TABLE IF NOT EXISTS request_quota_samples (
      id UUID PRIMARY KEY, attempt_id UUID NOT NULL REFERENCES request_attempts(id),
      phase TEXT NOT NULL CHECK(phase IN ('baseline','terminal')), job_id UUID REFERENCES quota_capture_jobs(id),
      observation_id UUID REFERENCES provider_quota_observations(id) ON DELETE SET NULL, sample_age_ms BIGINT,
      reused BOOLEAN NOT NULL DEFAULT FALSE, quality JSONB NOT NULL DEFAULT '{}', UNIQUE(attempt_id,phase,job_id)
    );
    CREATE TABLE IF NOT EXISTS quota_capture_instances (
      id UUID PRIMARY KEY, heartbeat_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quota_capture_instance_expiry ON quota_capture_instances(expires_at);
    ALTER TABLE request_attempts ADD COLUMN IF NOT EXISTS owner_id UUID;
    ALTER TABLE request_attempts ADD COLUMN IF NOT EXISTS termination_quality JSONB NOT NULL DEFAULT '{}';
    CREATE INDEX IF NOT EXISTS idx_request_attempt_running_owner ON request_attempts(owner_id) WHERE status='running';
    ALTER TABLE request_attempts ADD COLUMN IF NOT EXISTS capture_mode TEXT NOT NULL DEFAULT 'async';
    ALTER TABLE request_quota_samples ADD COLUMN IF NOT EXISTS normalized_snapshot JSONB NOT NULL DEFAULT '{}';
    UPDATE request_quota_samples s SET normalized_snapshot=jsonb_build_object(
      'account_id',o.account_id,'observed_at',o.observed_at,'checked_at',o.checked_at,'status',o.status,'quality',o.quality,
      'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',i.kind,'unit',i.unit,'window_key',i.window_key,
        'total',i.total,'used',i.used,'remaining',i.remaining,'used_percent',i.used_percent,'resets_at',i.resets_at,'quality',i.quality))
        FROM provider_quota_observation_items i WHERE i.observation_id=o.id),'[]'::jsonb))
      FROM provider_quota_observations o WHERE s.observation_id=o.id AND s.normalized_snapshot='{}'::jsonb;
    ALTER TABLE request_quota_samples DROP CONSTRAINT IF EXISTS request_quota_samples_observation_id_fkey;
    ALTER TABLE request_quota_samples ADD CONSTRAINT request_quota_samples_observation_id_fkey
      FOREIGN KEY(observation_id) REFERENCES provider_quota_observations(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS quota_capture_account_leases (
      account_id UUID PRIMARY KEY REFERENCES provider_quota_accounts(id), lease_token UUID,
      lease_until TIMESTAMPTZ, next_query_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_request_quota_baseline ON request_quota_samples(attempt_id,phase) WHERE job_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_request_quota_observation ON request_quota_samples(observation_id);
  `);
  await require('./quota-request-context').ensureLogicalRequestSchema(db);
}

async function enqueue(client, attempt, phase, reason) {
  const job = await client.query(`INSERT INTO quota_capture_jobs(id,attempt_id,phase,account_id,status,error,completed_at)
    VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $5='unsupported' THEN NOW() END)
    ON CONFLICT(attempt_id,phase) DO NOTHING RETURNING id`,
  [crypto.randomUUID(), attempt.id, phase, attempt.account_id, reason ? 'unsupported' : 'pending', reason]);
  if (reason && job.rows.length) {
    await client.query(`INSERT INTO request_quota_samples(id,attempt_id,phase,job_id,quality)
      VALUES($1,$2,$3,$4,$5::jsonb)`, [crypto.randomUUID(), attempt.id, phase, job.rows[0].id, JSON.stringify({ status: 'unsupported', reason })]);
  }
}

async function heartbeatInstance(db = getQuotaCapturePool(), options = {}) {
  const instanceId = options.instanceId || INSTANCE_ID;
  const leaseSeconds = Math.max(1, options.liveLeaseSeconds || 90);
  await db.query(`INSERT INTO quota_capture_instances(id,heartbeat_at,expires_at)
    VALUES($1,NOW(),NOW()+($2*INTERVAL '1 second')) ON CONFLICT(id) DO UPDATE SET
    heartbeat_at=EXCLUDED.heartbeat_at,expires_at=EXCLUDED.expires_at`, [instanceId,leaseSeconds]);
  return instanceId;
}

async function recoverInterruptedAttempts(db = getQuotaCapturePool(), options = {}) {
  const config = await getCaptureConfig(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const expired = await client.query(`SELECT id,heartbeat_at FROM quota_capture_instances
      WHERE expires_at<=NOW() AND EXISTS(SELECT 1 FROM request_attempts a WHERE a.owner_id=quota_capture_instances.id AND a.status='running')
      ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT $1`, [options.recoveryBatchSize || 100]);
    const ids = expired.rows.map(row => row.id);
    const attempts = await client.query(`SELECT a.*,i.heartbeat_at FROM request_attempts a
      LEFT JOIN quota_capture_instances i ON i.id=a.owner_id
      WHERE a.status='running' AND (a.owner_id=ANY($1::uuid[]) OR a.owner_id IS NULL)
      ORDER BY a.started_at FOR UPDATE OF a SKIP LOCKED LIMIT $2`, [ids,options.recoveryBatchSize || 100]);
    for (const attempt of attempts.rows) {
      await client.query(`UPDATE request_attempts SET status='failed',error_class='process_interrupted',usage_quality='unknown',
        ended_at=GREATEST(started_at,LEAST(NOW(),COALESCE($2::timestamptz,started_at))),
        termination_quality=jsonb_build_object('interrupted',TRUE,'end_time_inferred',TRUE,
          'end_time_basis',CASE WHEN $2::timestamptz IS NULL THEN 'started_at_only' ELSE 'last_owner_heartbeat' END,
          'recovered_at',NOW()) WHERE id=$1 AND status='running'`, [attempt.id,attempt.heartbeat_at]);
      await enqueue(client,attempt,'terminal',!config.enabled ? 'capture_disabled' : attempt.capture_status==='unsupported' ? 'capture_unavailable' : null);
      await markDirty(client,attempt.account_id);
    }
    await client.query('COMMIT');
    return { recovered:attempts.rowCount };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function beginAttempt(context = {}, provider, key, options = {}) {
  const db = options.pool || getQuotaCapturePool();
  if (!provider?.id) throw new Error('request_attempt_provider_required');
  const config = await getCaptureConfig(db);
  const strict = (options.mode || config.mode) === 'strict';
  const identity = bindIdentity(provider, key);
  const reason = !config.enabled ? 'capture_disabled' : captureReason(provider) || (!identity ? 'credential_identity_missing' : null);
  const started = context.started_at || new Date().toISOString();
  const id = crypto.randomUUID();
  const ownerId = await heartbeatInstance(db,options);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let accountId = null;
    if (identity) {
      const account = await client.query(`INSERT INTO provider_quota_accounts(id,identity,provider_id,label,scope)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(identity) DO UPDATE SET label=EXCLUDED.label RETURNING id`,
      [crypto.randomUUID(), identity.identity, provider.id, history.safeText(provider.name, provider), identity.scope]);
      accountId = account.rows[0].id;
      await client.query(`INSERT INTO provider_quota_account_providers(account_id,provider_id,active)
        VALUES($1,$2,TRUE) ON CONFLICT(account_id,provider_id) DO NOTHING`, [accountId, provider.id]);
    }
    const text = field => context[field] == null ? null : history.safeText(context[field], provider);
    await client.query(`INSERT INTO request_attempts(id,logical_request_id,user_id,team_id,api_key_id,project_id,session_id,
      source,platform,model,requested_model,streaming,provider_id,account_id,credential_identity,config_version,started_at,status,capture_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'running',$18)`,
    [id, context.logical_request_id || crypto.randomUUID(), context.user_id || null, context.team_id || null, context.api_key_id || null,
      text('project_id'), text('session_id'), text('source'), text('platform'), text('model'), text('requested_model'), !!context.streaming,
      provider.id, accountId, identity?.identity || null, identity ? configIdentity(provider, identity.identity) : null, started, reason ? 'unsupported' : 'pending']);
    await client.query('UPDATE request_attempts SET capture_mode=$2,owner_id=$3 WHERE id=$1', [id, strict ? 'strict' : 'async',ownerId]);
    const baseline = accountId && !reason && !strict ? await client.query(`SELECT * FROM provider_quota_observations o
      WHERE account_id=$1 AND status IN ('success','partial') AND observed_at<=$2::timestamptz
        AND EXISTS(SELECT 1 FROM provider_quota_observation_items i WHERE i.observation_id=o.id)
      ORDER BY observed_at DESC LIMIT 1`, [accountId, started]) : { rows: [] };
    if (baseline.rows.length) {
      const sample = baseline.rows[0];
      await client.query(`INSERT INTO request_quota_samples(id,attempt_id,phase,observation_id,sample_age_ms,reused,quality,normalized_snapshot)
        VALUES($1,$2,'baseline',$3,$4,TRUE,$5::jsonb,$6::jsonb)`,
      [crypto.randomUUID(), id, sample.id, Math.max(0, new Date(started) - new Date(sample.observed_at)), JSON.stringify({ ...sample.quality, baseline_reference: true }), JSON.stringify(await normalizedSnapshot(client, sample))]);
    } else await enqueue(client, { id, account_id: accountId }, 'baseline', reason);
    await client.query('COMMIT');

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  if (strict && !reason) {
    await runStrictJob(db, id, 'baseline', { ...options, config });
    await db.query("UPDATE request_attempts SET started_at=NOW() WHERE id=$1 AND status='running'", [id]);
  }
  return id;
}

async function endAttempt(id, metadata = {}, options = {}) {
  if (!id) return;
  const db = options.pool || getQuotaCapturePool();
  const config = await getCaptureConfig(db);
  const client = await db.connect();
  let accountId;
  let attemptMode;
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM request_attempts WHERE id=$1 FOR UPDATE', [id]);
    if (!existing.rows.length) throw new Error('request_attempt_missing');
    const attempt = existing.rows[0];
    accountId = attempt.account_id;
    attemptMode = attempt.capture_mode;
    const assignments = USAGE_FIELDS.map((field, i) => `${field}=COALESCE($${i + 7}::numeric,${field})`).join(',');
    await client.query(`UPDATE request_attempts SET ended_at=COALESCE(ended_at,$2::timestamptz),
      status=CASE WHEN status='running' THEN $3 ELSE status END, error_class=COALESCE(error_class,$4),
      usage_record_id=COALESCE($5::bigint,usage_record_id),usage_quality=COALESCE($6,usage_quality),${assignments} WHERE id=$1`,
    [id, metadata.ended_at || new Date().toISOString(), TERMINAL.has(metadata.status) ? metadata.status : 'failed',
      ERROR_CLASSES.has(metadata.error_class) ? metadata.error_class : null, metadata.usage_record_id || null,
      ['actual', 'estimated', 'unknown'].includes(metadata.usage_quality) ? metadata.usage_quality : null, ...usageValues(metadata)]);
    await enqueue(client, attempt, 'terminal', !config.enabled ? 'capture_disabled' : attempt.capture_status === 'unsupported' ? 'capture_unavailable' : null);
    await markDirty(client, accountId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  if ((options.mode || attemptMode || config.mode) === 'strict' && config.enabled) await runStrictJob(db, id, 'terminal', { ...options, config });
}

async function finishJob(db, job, status, error, observation) {
  const snapshot = await normalizedSnapshot(db, observation);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const done = await client.query(`UPDATE quota_capture_jobs SET status=$3,error=$4,completed_at=NOW(),lease_until=NULL,lease_token=NULL
      WHERE id=$1 AND lease_token=$2 RETURNING id`, [job.id, job.lease_token, status, error]);
    if (done.rows.length) {
      await client.query(`INSERT INTO request_quota_samples(id,attempt_id,phase,job_id,observation_id,sample_age_ms,reused,quality,normalized_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) ON CONFLICT(attempt_id,phase,job_id) DO NOTHING`,
      [crypto.randomUUID(), job.attempt_id, job.phase, job.id, observation?.id || null,
        observation ? Math.max(0, Date.now() - new Date(observation.observed_at)) : null,
        !!observation?.quality?.cached, JSON.stringify({ ...observation?.quality, status, error, post_start_baseline: job.phase === 'baseline' && !job.strict_baseline }), JSON.stringify(snapshot)]);
      if (job.phase === 'terminal') await client.query('UPDATE request_attempts SET capture_status=$2 WHERE id=$1', [job.attempt_id, status]);
    }
    if (done.rows.length) await markDirty(client, job.account_id);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function processJob(db, job, options) {
  const config = options.config || await getCaptureConfig(db);
  if (!config.enabled) {
    await finishJob(db, job, 'unsupported', 'capture_disabled', null);
    return true;
  }
  const acquired = await db.query(`INSERT INTO quota_capture_account_leases(account_id,lease_token,lease_until)
    VALUES($1,$2,NOW()+($3*INTERVAL '1 second')) ON CONFLICT(account_id) DO UPDATE SET
    lease_token=EXCLUDED.lease_token,lease_until=EXCLUDED.lease_until
    WHERE (quota_capture_account_leases.lease_until IS NULL OR quota_capture_account_leases.lease_until<=NOW())
      AND quota_capture_account_leases.next_query_at<=NOW() RETURNING account_id`,
  [job.account_id, job.lease_token, options.leaseSeconds || config.lease_seconds]);
  if (!acquired.rowCount) {
    if (options.strict) return false;
    await db.query(`UPDATE quota_capture_jobs SET status='pending',tries=GREATEST(0,tries-1),lease_token=NULL,lease_until=NULL,
      available_at=NOW()+INTERVAL '1 second' WHERE id=$1 AND lease_token=$2`, [job.id,job.lease_token]);
    return false;
  }
  try { await queryJob(db, job, options); return true; }
  finally {
    await db.query(`UPDATE quota_capture_account_leases SET lease_token=NULL,lease_until=NULL,
      next_query_at=NOW()+($3*INTERVAL '1 millisecond') WHERE account_id=$1 AND lease_token=$2`,
    [job.account_id,job.lease_token,options.accountThrottleMs ?? 250]);
  }
}

async function queryJob(db, job, options) {
  const data = await db.query(`SELECT p.*,a.credential_identity,a.config_version,a.capture_mode FROM request_attempts a LEFT JOIN providers p ON p.id=a.provider_id WHERE a.id=$1`, [job.attempt_id]);
  if (data.rows[0]?.capture_mode === 'strict') options = { ...options, strict: true };
  const provider = data.rows[0]?.id ? data.rows[0] : null;
  const reason = captureReason(provider);
  const selected = !reason && resolveCredential(provider, data.rows[0].credential_identity);
  if (reason || !selected) return finishJob(db, job, 'unsupported', reason || 'credential_changed', null);
  if (configIdentity(provider, data.rows[0].credential_identity) !== data.rows[0].config_version) {
    return finishJob(db, job, 'unsupported', 'configuration_changed', null);
  }
  // 批次以任务为幂等键；租约过期后的重领可以复用已经持久化的真实查询。
  const batchId = `request:${job.id}:${job.tries}`;
  let observed = await db.query(`SELECT * FROM provider_quota_observations WHERE batch_id LIKE $1 AND account_id=$2
    AND status IN ('success','partial') ORDER BY checked_at DESC LIMIT 1`, [`request:${job.id}:%`, job.account_id]);
  let result;
  if (!observed.rows.length) {
    result = await (options.queryQuota || require('./provider-quota').queryProviderQuotaForRequest)(selected,
      { source: 'request', batchId, checkedAt: new Date().toISOString(), signal: options.signal });
    if (options.signal?.aborted) return;
    const owner = await db.query('SELECT id FROM quota_capture_jobs WHERE id=$1 AND lease_token=$2', [job.id,job.lease_token]);
    if (!owner.rowCount) return;
    await history.recordQuotaHistory(db, selected, result, { updateSnapshot: false, partialAccounts: true });
    observed = await db.query('SELECT * FROM provider_quota_observations WHERE batch_id=$1 AND account_id=$2', [batchId, job.account_id]);
  }
  const observation = observed.rows[0];
  if (options.strict && (observation?.quality?.cached || observation?.quality?.duplicate_sample)) {
    return finishJob(db, job, 'failed', 'fresh_sample_unavailable', observation);
  }
  if (observation?.status !== 'failed' && observation) return finishJob(db, job, 'success', null, observation);
  const limited = result?.status === 429 || /429|rate.?limit/i.test(result?.error || '');
  const error = limited ? 'quota_rate_limited' : 'quota_query_failed';
  if (options.strict || job.tries >= (options.maxTries || options.config?.max_tries || 5)) return finishJob(db, job, 'failed', error, observation);
  // 失败批次也保留；重试使用新的批次，不冒充原有测量。
  await db.query(`UPDATE quota_capture_jobs SET status=$3,error=$4,available_at=NOW()+($5 * INTERVAL '1 second'),
    lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2`,
  [job.id, job.lease_token, limited ? 'rate_limited' : 'pending', error, Math.min(3600, (limited ? 60 : 5) * 2 ** (job.tries - 1))]);
}

async function runWorker(options = {}) {
  const db = options.pool || getQuotaCapturePool();
  await heartbeatInstance(db,options);
  await recoverInterruptedAttempts(db,options);
  const config = await getCaptureConfig(db);
  options = { ...options, config, maxTries: options.maxTries || config.max_tries };
  const token = crypto.randomUUID();
  const jobs = await db.query(`WITH due AS (
    SELECT id FROM quota_capture_jobs WHERE (status IN ('pending','rate_limited') AND available_at<=NOW())
      OR (status='running' AND lease_until<=NOW()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT $1
    ) UPDATE quota_capture_jobs j SET status='running',lease_token=$2,lease_until=NOW()+($3 * INTERVAL '1 second'),
      tries=tries+1,query_started_at=NOW() FROM due WHERE j.id=due.id RETURNING j.*`,
  [Math.max(1, Math.min(100, options.batchSize || config.batch_size)), token, Math.max(30, options.leaseSeconds || config.lease_seconds)]);
  await Promise.all(jobs.rows.map(async job => {
    let timeout;
    const controller = new AbortController();
    try {
      const work = processJob(db, job, { ...options, signal:controller.signal });
      const result = await Promise.race([work, new Promise(resolve => {
        timeout = setTimeout(() => { controller.abort(); resolve('timeout'); }, options.captureTimeoutMs || 20000);
      })]);
      if (result === 'timeout') await finishJob(db,job,'failed','quota_capture_timeout',null);
    }
    catch {
      if (options.strict || job.tries >= (options.maxTries || options.config?.max_tries || 5)) await finishJob(db, job, 'failed', 'capture_worker_failed', null);
      else await db.query(`UPDATE quota_capture_jobs SET status='pending',error='capture_worker_failed',available_at=NOW()+INTERVAL '30 seconds',
        lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`, [job.id, job.lease_token]);
    } finally { clearTimeout(timeout); }
  }));
  return { claimed: jobs.rowCount };
}

async function runStrictJob(db, attemptId, phase, options) {
  const controller = new AbortController();
  const deadline = Date.now() + (options.strictTimeoutMs || 20000);
  const token = crypto.randomUUID();
  let claim = await db.query(`UPDATE quota_capture_jobs SET status='running',lease_token=$3,
    lease_until=NOW()+($4*INTERVAL '1 second'),query_started_at=NOW(),tries=tries+1
    WHERE attempt_id=$1 AND phase=$2 AND (status IN ('pending','rate_limited') OR (status='running' AND lease_until<=NOW())) RETURNING *`,
  [attemptId,phase,token,options.config.lease_seconds]);
  let job = claim.rows[0];
  if (job) job.strict_baseline = phase === 'baseline';
  while (!job && Date.now() < deadline) {
    const current = await db.query('SELECT * FROM quota_capture_jobs WHERE attempt_id=$1 AND phase=$2', [attemptId, phase]);
    if (!current.rows.length || ['success','failed','unsupported'].includes(current.rows[0].status)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
    claim = await db.query(`UPDATE quota_capture_jobs SET status='running',lease_token=$3,
      lease_until=NOW()+($4*INTERVAL '1 second'),query_started_at=NOW(),tries=tries+1
      WHERE attempt_id=$1 AND phase=$2 AND (status IN ('pending','rate_limited') OR (status='running' AND lease_until<=NOW())) RETURNING *`,
    [attemptId,phase,token,options.config.lease_seconds]);
    job = claim.rows[0];
    if (job) job.strict_baseline = phase === 'baseline';
  }
  if (!job) {
    const timed = await db.query('SELECT * FROM quota_capture_jobs WHERE attempt_id=$1 AND phase=$2', [attemptId,phase]);
    if (timed.rows[0]) await finishJob(db,timed.rows[0],'failed','quota_capture_timeout',null);
    return;
  }
  let timeout;
  const expired = new Promise(resolve => { timeout = setTimeout(() => { controller.abort(); resolve('timeout'); }, Math.max(1,deadline-Date.now())); });
  const work = (async () => {
    while (!controller.signal.aborted) {
      if (await processJob(db, job, { ...options, strict:true, signal:controller.signal })) return 'done';
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return 'timeout';
  })().catch(() => 'error');
  const result = await Promise.race([work, expired]);
  clearTimeout(timeout);
  if (result !== 'done') {
    controller.abort();
    await finishJob(db,job,'failed',result === 'timeout' ? 'quota_capture_timeout' : 'capture_worker_failed',null);
  }
}

function startWorker(options = {}) {
  if (timer) return;
  let nextRun = 0;
  let heartbeatRunning = false;
  const beat = async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try { await heartbeatInstance(options.pool || getQuotaCapturePool(), options); }
    catch { Logger.warn('[请求额度] 实例心跳失败'); }
    finally { heartbeatRunning = false; }
  };
  heartbeatTimer = setInterval(beat, Math.max(250,options.heartbeatIntervalMs || 10000));
  heartbeatTimer.unref();
  beat();
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const db = options.pool || getQuotaCapturePool();
      const config = await getCaptureConfig(db);
      if (Date.now() < nextRun) return;
      nextRun = Date.now() + config.worker_interval_ms;
      await runWorker(options);
      const cycle = require('./quota-cycle-analysis');
      if (typeof cycle.markAccountDirty === 'function') await cycle.reconcileCycles(db, { reconciliationSeconds:config.reconciliation_seconds });
    } catch { Logger.warn('[请求额度] worker 执行失败'); }
    finally { ticking = false; }
  };
  timer = setInterval(tick, 250);
  timer.unref();
  tick();
}

function stopWorker() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { beginAttempt, endAttempt, runWorker, ensureRequestQuotaSchema, startWorker, stopWorker,
  heartbeatInstance, recoverInterruptedAttempts, INSTANCE_ID, getCaptureConfig, invalidateCaptureConfig, DEFAULT_CAPTURE_CONFIG, captureReason, bindIdentity, resolveCredential, configIdentity, usageValues };
