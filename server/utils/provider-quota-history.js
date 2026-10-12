'use strict';

const crypto = require('node:crypto');
const config = require('../config-loader');
const { decryptSecret } = require('./secret-crypto');
const { normalizeProviderKeyEntries, getPrimaryApiKey } = require('./provider-keys');

const contexts = new WeakMap();
const keyModes = new Set(['script', 'opencode_go', 'commandcode', 'newapi', 'cursor']);

function identitySecret() {
  const secret = process.env.CRW_MASTER_KEY || process.env.CR_MASTER_KEY || config.gateway?.masterKey
    || config.masterKey || config.app?.sessionSecret;
  if (!secret) throw new Error('额度历史稳定身份需要配置服务端密钥');
  return String(secret);
}

function stableIdentity(provider, key, legacy = false) {
  let scope = 'provider';
  let parts;
  if (legacy) {
    parts = ['legacy', provider.id];
  } else if (provider.quota_mode === 'cpa') {
    let parsed;
    try { parsed = JSON.parse(provider.quota_script || '{}') || {}; } catch { parsed = {}; }
    scope = 'shared_subscription';
    parts = ['cpa', String(provider.cpa_management_url || '').replace(/\/+$/, ''), parsed.auth_index || 'unconfigured'];
  } else if (keyModes.has(provider.quota_mode || 'script')) {
    scope = 'upstream_key';
    parts = [provider.id, provider.quota_mode || 'script', provider.base_url || '', provider.quota_script || '', key || getPrimaryApiKey(provider) || 'unconfigured'];
  } else {
    let subject;
    try { subject = JSON.parse(Buffer.from(String(provider.oauth_access_token || '').split('.')[1] || '', 'base64url').toString()).sub; } catch { subject = null; }
    // 没有可靠账号身份的 opaque token 轮换必须开启新序列，避免误合并不同账户。
    parts = [provider.id, provider.quota_mode, provider.oauth_account_id || subject
      || provider.ark_access_key || provider.oauth_refresh_token || provider.oauth_access_token || 'unconfigured'];
  }
  const identity = crypto.createHmac('sha256', identitySecret()).update(JSON.stringify(parts)).digest('hex');
  return { identity, scope };
}

function credentials(provider) {
  const values = normalizeProviderKeyEntries(provider).map(entry => entry.key);
  for (const field of ['api_key', 'oauth_access_token', 'oauth_refresh_token', 'ark_secret_key', 'cpa_management_key']) {
    if (provider[field]) values.push(decryptSecret(provider[field]));
  }
  return values.filter(Boolean);
}

function safeText(value, provider, max = 255) {
  let text = String(value || '');
  for (const secret of credentials(provider)) text = text.split(secret).join('[redacted]');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:authorization|access_token|refresh_token|api[_-]?key|token|secret)\s*[=:]\s*["']?[^\s,"'}]+/gi, '[redacted]')
    .replace(/\b(?:sk-|crsr_)[a-zA-Z0-9_-]+/g, '[redacted]').slice(0, max);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestamp(value, fallback = null) {
  const ms = value == null || value === '' ? NaN : new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

function normalizeQuotaItems(quota = {}, provider = {}) {
  quota = quota && typeof quota === 'object' ? quota : {};
  const items = [];
  const cached = quota.source === 'passive';
  const unknownUsed = provider.quota_mode === 'newapi' && /未开放 usage 接口/.test(quota.extra || '');
  const quality = { cached, source: cached ? 'passive' : 'active', precision: 'observation', ...(unknownUsed ? { unknown_used: true } : {}) };
  if (quota.isValid === false) return items;
  if (quota.unit !== 'percent') {
    const explicitUnit = quota.currency || (quota.unit && quota.unit !== 'balance' ? quota.unit : null);
    const unit = explicitUnit || (['newapi', 'cursor'].includes(provider.quota_mode) ? 'USD' : null) || (/^(USD|CNY|EUR|GBP)$/i.test(quota.extra || '') ? quota.extra.toUpperCase() : 'unknown');
    const item = { kind: 'balance', unit: safeText(unit, provider, 64), window_key: '',
      total: numberOrNull(quota.total), used: unknownUsed ? null : numberOrNull(quota.used), remaining: unknownUsed ? null : numberOrNull(quota.remaining),
      used_percent: numberOrNull(quota.currentPercent), resets_at: timestamp(quota.resetsAt), quality };
    if ([item.total, item.used, item.remaining].some(value => value !== null)) items.push(item);
  }
  const periods = Array.isArray(quota.periods) ? quota.periods : [];
  const windows = periods.length ? periods : quota.unit === 'percent' ? [{ key: 'primary', percent: quota.currentPercent ?? quota.used, resetsAt: quota.resetsAt }] : [];
  const seen = new Set();
  for (const period of windows) {
    const windowKey = safeText(period.key || 'primary', provider, 128);
    if (seen.has(windowKey)) continue;
    seen.add(windowKey);
    const percent = numberOrNull(period.percent);
    if (percent === null) continue;
    items.push({ kind: 'window', unit: 'percent', window_key: windowKey,
      total: null, used: null, remaining: null, used_percent: percent,
      resets_at: timestamp(period.resetsAt), quality });
  }
  return items;
}

function safeQuota(quota = {}, provider) {
  quota = quota && typeof quota === 'object' ? quota : {};
  const payload = {};
  for (const field of ['planName', 'unit', 'providerType', 'source', 'currency', 'extra']) {
    if (quota[field] != null) payload[field] = safeText(quota[field], provider);
  }
  for (const field of ['total', 'used', 'remaining', 'currentPercent']) payload[field] = numberOrNull(quota[field]);
  if (typeof quota.isValid === 'boolean') payload.isValid = quota.isValid;
  if (quota.credits && typeof quota.credits === 'object') {
    payload.credits = { balance: numberOrNull(quota.credits.balance) };
    for (const field of ['hasCredits', 'unlimited', 'overageLimitReached']) {
      if (typeof quota.credits[field] === 'boolean') payload.credits[field] = quota.credits[field];
    }
  }
  if (quota.rateLimitResetCredits && typeof quota.rateLimitResetCredits === 'object') {
    payload.rateLimitResetCredits = { available_count: numberOrNull(quota.rateLimitResetCredits.available_count) };
  }
  if (provider.quota_mode === 'newapi' && /未开放 usage 接口/.test(quota.extra || '')) {
    payload.used = null;
    payload.remaining = null;
  }
  payload.observedAt = timestamp(quota.observedAt);
  payload.periods = (Array.isArray(quota.periods) ? quota.periods : []).map(period => ({
    key: safeText(period.key, provider, 128), label: safeText(period.label, provider),
    percent: numberOrNull(period.percent), startsAt: timestamp(period.startsAt), resetsAt: timestamp(period.resetsAt)
  }));
  return payload;
}

function serializeSafeResult(result, provider) {
  const payload = safeQuota(result.quota, provider);
  if (Array.isArray(result.keys)) payload.keys = result.keys.map(entry => ({
    index: entry.index, label: safeText(entry.label, provider), masked_key: '****', enabled: entry.enabled !== false,
    ok: !!entry.ok, error: entry.ok ? null : '额度查询失败', quota: entry.ok ? safeQuota(entry.quota, provider) : null
  }));
  if (result.aggregated) payload.aggregated = safeQuota(result.aggregated, provider);
  return payload;
}

function attachQuotaBatch(result, provider, options = {}) {
  if (contexts.has(result)) return result;
  const entries = normalizeProviderKeyEntries(provider).filter(entry => entry.enabled !== false);
  const rows = Array.isArray(result.keys) && result.keys.length && provider.quota_mode !== 'cpa'
    ? result.keys.map((entry, index) => ({ ...entry, identity: stableIdentity(provider, entries[index]?.key) }))
    : [{ ok: result.ok, error: result.error, quota: result.quota, label: provider.name, identity: stableIdentity(provider) }];
  contexts.set(result, { batchId: options.batchId || crypto.randomUUID(), checkedAt: timestamp(options.checkedAt, new Date().toISOString()),
    source: options.source || 'query', completedAt: timestamp(options.completedAt || options.checkedAt, new Date().toISOString()), provider: { ...provider }, rows });
  return result;
}

function transferQuotaBatch(from, to) {
  if (contexts.has(from)) contexts.set(to, contexts.get(from));
  return to;
}

async function ensureQuotaHistorySchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS provider_quota_accounts (
      id UUID PRIMARY KEY, identity TEXT NOT NULL UNIQUE, provider_id TEXT NOT NULL,
      label TEXT NOT NULL, scope TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_sample_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS provider_quota_account_providers (
      account_id UUID NOT NULL REFERENCES provider_quota_accounts(id), provider_id TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE, legacy BOOLEAN NOT NULL DEFAULT FALSE,
      last_attempt_at TIMESTAMPTZ, last_attempt_status TEXT, last_valid_at TIMESTAMPTZ,
      PRIMARY KEY(account_id,provider_id)
    );
    CREATE INDEX IF NOT EXISTS idx_quota_account_providers_active ON provider_quota_account_providers(provider_id,active);
    CREATE TABLE IF NOT EXISTS provider_quota_batches (
      batch_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, checked_at TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_quota_observations (
      id UUID PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES provider_quota_batches(batch_id),
      provider_id TEXT NOT NULL, account_id UUID NOT NULL REFERENCES provider_quota_accounts(id),
      provider_name TEXT NOT NULL, source TEXT NOT NULL, checked_at TIMESTAMPTZ NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL CHECK(status IN ('success','partial','failed')),
      error TEXT, quality JSONB NOT NULL DEFAULT '{}', aggregated_at TIMESTAMPTZ,
      UNIQUE(batch_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS provider_quota_observation_items (
      id BIGSERIAL PRIMARY KEY, observation_id UUID NOT NULL REFERENCES provider_quota_observations(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES provider_quota_accounts(id), provider_id TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL, kind TEXT NOT NULL, unit TEXT NOT NULL, window_key TEXT NOT NULL DEFAULT '',
      total NUMERIC, used NUMERIC, remaining NUMERIC, used_percent NUMERIC, resets_at TIMESTAMPTZ,
      quality JSONB NOT NULL DEFAULT '{}', UNIQUE(observation_id, kind, unit, window_key)
    );
    CREATE TABLE IF NOT EXISTS provider_quota_daily_agg (
      account_id UUID NOT NULL REFERENCES provider_quota_accounts(id), provider_id TEXT NOT NULL,
      provider_name TEXT NOT NULL, date DATE NOT NULL, kind TEXT NOT NULL, unit TEXT NOT NULL, window_key TEXT NOT NULL DEFAULT '',
      sample_count BIGINT NOT NULL DEFAULT 0, success_count BIGINT NOT NULL DEFAULT 0, failure_count BIGINT NOT NULL DEFAULT 0,
      first_observed_at TIMESTAMPTZ, last_observed_at TIMESTAMPTZ,
      first_total NUMERIC, last_total NUMERIC, first_used NUMERIC, last_used NUMERIC,
      first_remaining NUMERIC, last_remaining NUMERIC, first_used_percent NUMERIC, last_used_percent NUMERIC,
      observed_consumption NUMERIC, anomaly_count BIGINT NOT NULL DEFAULT 0, quality JSONB NOT NULL DEFAULT '{}',
      PRIMARY KEY(account_id, provider_id, date, kind, unit, window_key)
    );
    ALTER TABLE provider_quota_daily_agg ADD COLUMN IF NOT EXISTS percent_change NUMERIC;
    CREATE INDEX IF NOT EXISTS idx_quota_observation_provider_time ON provider_quota_observations(provider_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quota_observation_account_time ON provider_quota_observations(account_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quota_items_account_time ON provider_quota_observation_items(account_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quota_items_provider_time ON provider_quota_observation_items(provider_id, observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quota_daily_provider_date ON provider_quota_daily_agg(provider_id, date);
  `);
}

function classifyChange(previous, item, observedAt) {
  if (!previous) return { consumption: null, event: 'initial' };
  if (new Date(observedAt) <= new Date(previous.observed_at)) return { consumption: null, event: 'backfill' };
  if (timestamp(previous.resets_at) !== timestamp(item.resets_at)) return { consumption: null, event: 'reset' };
  if (new Date(observedAt) - new Date(previous.observed_at) > 86400000) return { consumption: null, event: 'gap' };
  if (numberOrNull(previous.total) !== item.total) return { consumption: null, event: 'adjustment' };
  if (item.kind !== 'balance') {
    const previousPercent = numberOrNull(previous.used_percent);
    const percentChange = previousPercent === null || item.used_percent === null ? null : item.used_percent - previousPercent;
    return { consumption: null, percentChange: percentChange !== null && percentChange >= 0 ? percentChange : null,
      event: percentChange !== null && percentChange < 0 ? 'reset' : 'window_change' };
  }
  const oldUsed = numberOrNull(previous.used);
  const oldRemaining = numberOrNull(previous.remaining);
  const delta = oldUsed !== null && item.used !== null ? item.used - oldUsed
    : oldRemaining !== null && item.remaining !== null ? oldRemaining - item.remaining : null;
  return { consumption: delta !== null && delta >= 0 ? delta : null,
    event: delta === null ? 'unknown' : delta < 0 ? 'recharge_or_reset' : 'observed_consumption' };
}

async function aggregateRow(client, observation, item, change) {
  const valid = !!item;
  const values = item || { kind: 'status', unit: 'unknown', window_key: '', total: null, used: null, remaining: null, used_percent: null };
  await client.query(`INSERT INTO provider_quota_daily_agg AS a
    (account_id,provider_id,provider_name,date,kind,unit,window_key,sample_count,success_count,failure_count,
     first_observed_at,last_observed_at,first_total,last_total,first_used,last_used,first_remaining,last_remaining,
     first_used_percent,last_used_percent,observed_consumption,anomaly_count,quality,percent_change)
    VALUES ($1,$2,$3,($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,$5,$6,$7,$8,$9,$10,
      $11,$11,$12,$12,$13,$13,$14,$14,$15,$15,$16,$17,$18::jsonb,$19)
    ON CONFLICT (account_id,provider_id,date,kind,unit,window_key) DO UPDATE SET
      provider_name=EXCLUDED.provider_name, sample_count=a.sample_count+EXCLUDED.sample_count,
      success_count=a.success_count+EXCLUDED.success_count, failure_count=a.failure_count+EXCLUDED.failure_count,
      first_total=CASE WHEN EXCLUDED.first_observed_at<a.first_observed_at THEN EXCLUDED.first_total ELSE a.first_total END,
      first_used=CASE WHEN EXCLUDED.first_observed_at<a.first_observed_at THEN EXCLUDED.first_used ELSE a.first_used END,
      first_remaining=CASE WHEN EXCLUDED.first_observed_at<a.first_observed_at THEN EXCLUDED.first_remaining ELSE a.first_remaining END,
      first_used_percent=CASE WHEN EXCLUDED.first_observed_at<a.first_observed_at THEN EXCLUDED.first_used_percent ELSE a.first_used_percent END,
      last_total=CASE WHEN EXCLUDED.last_observed_at>=a.last_observed_at THEN EXCLUDED.last_total ELSE a.last_total END,
      last_used=CASE WHEN EXCLUDED.last_observed_at>=a.last_observed_at THEN EXCLUDED.last_used ELSE a.last_used END,
      last_remaining=CASE WHEN EXCLUDED.last_observed_at>=a.last_observed_at THEN EXCLUDED.last_remaining ELSE a.last_remaining END,
      last_used_percent=CASE WHEN EXCLUDED.last_observed_at>=a.last_observed_at THEN EXCLUDED.last_used_percent ELSE a.last_used_percent END,
      first_observed_at=LEAST(a.first_observed_at,EXCLUDED.first_observed_at),
      last_observed_at=GREATEST(a.last_observed_at,EXCLUDED.last_observed_at),
      observed_consumption=CASE WHEN a.observed_consumption IS NULL AND EXCLUDED.observed_consumption IS NULL THEN NULL
        ELSE COALESCE(a.observed_consumption,0)+COALESCE(EXCLUDED.observed_consumption,0) END,
      percent_change=CASE WHEN a.percent_change IS NULL AND EXCLUDED.percent_change IS NULL THEN NULL
        ELSE COALESCE(a.percent_change,0)+COALESCE(EXCLUDED.percent_change,0) END,
      anomaly_count=a.anomaly_count+EXCLUDED.anomaly_count, quality=a.quality || EXCLUDED.quality`,
  [observation.accountId, observation.providerId, observation.providerName, observation.observedAt,
    values.kind, values.unit, values.window_key, valid ? 1 : 0, valid ? 1 : 0, observation.status === 'failed' ? 1 : 0,
    valid ? observation.observedAt : null, values.total, values.used, values.remaining, values.used_percent,
    change?.consumption ?? null, change && !['initial', 'window_change', 'observed_consumption'].includes(change.event) ? 1 : 0,
    JSON.stringify({ ...(values.quality || {}), ...(change ? { last_event: change.event, interval_start: timestamp(change.previousAt), interval_end: observation.observedAt } : {}) }), change?.percentChange ?? null]);
}

async function recordQuotaHistory(pool, provider, result, options = {}) {
  attachQuotaBatch(result, provider, options);
  const ctx = contexts.get(result);
  provider = ctx.provider || provider;
  if (options.source && ctx.source === 'query') ctx.source = options.source;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hasValidQuota = !!result.ok && ctx.rows.some(row => row.ok && normalizeQuotaItems(row.quota, provider).length > 0);
    const status = !hasValidQuota ? 'failed' : ctx.rows.some(row => !row.ok || !normalizeQuotaItems(row.quota, provider).length) ? 'partial' : 'success';
    const batch = await client.query(`INSERT INTO provider_quota_batches(batch_id,provider_id,checked_at,source,status)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING batch_id`,
    [ctx.batchId, provider.id, ctx.checkedAt, ctx.source, status]);
    if (!batch.rowCount) {
      await client.query('COMMIT');
      return { recorded: true, duplicate: true, batch_id: ctx.batchId };
    }
    const snapshotBefore = options.updateSnapshot !== false
      ? await client.query('SELECT quota_last_result,quota_last_checked_at FROM providers WHERE id=$1 FOR UPDATE', [provider.id]) : { rows: [] };
    const currentConfiguration = ctx.source !== 'legacy' && (!snapshotBefore.rows[0]?.quota_last_checked_at
      || new Date(ctx.checkedAt) >= new Date(snapshotBefore.rows[0].quota_last_checked_at));
    if (currentConfiguration && !options.partialAccounts) await client.query('UPDATE provider_quota_account_providers SET active=FALSE WHERE provider_id=$1 AND (last_attempt_at IS NULL OR last_attempt_at<=$2::timestamptz)', [provider.id,ctx.checkedAt]);
    const cycleSchema = await client.query("SELECT to_regclass('quota_cycle_samples') AS table_name");
    const seen = new Set();
    for (const row of [...ctx.rows].sort((a, b) => a.identity.identity.localeCompare(b.identity.identity))) {
      if (seen.has(row.identity.identity)) continue;
      seen.add(row.identity.identity);
      const account = await client.query(`INSERT INTO provider_quota_accounts(id,identity,provider_id,label,scope)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(identity) DO UPDATE SET label=EXCLUDED.label RETURNING *`,
      [crypto.randomUUID(), row.identity.identity, provider.id, safeText(row.label || provider.name, provider), row.identity.scope]);
      const accountId = account.rows[0].id;
      row.accountId = accountId;
      const observedAt = timestamp(row.quota?.observedAt, ctx.source === 'legacy' ? ctx.checkedAt : ctx.completedAt || ctx.checkedAt);
      const cached = row.quota?.source === 'passive';
      const normalized = row.ok ? normalizeQuotaItems(row.quota, provider) : [];
      const items = [];
      for (const item of normalized) {
        if (cached) {
          const existing = await client.query(`SELECT total,used,remaining,used_percent,resets_at
            FROM provider_quota_observation_items WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4
              AND observed_at=$5::timestamptz ORDER BY id DESC LIMIT 1`,
          [accountId,item.kind,item.unit,item.window_key,observedAt]);
          let previous = existing.rows[0];
          if (!previous) {
            const daily = await client.query(`SELECT last_total AS total,last_used AS used,last_remaining AS remaining,
              last_used_percent AS used_percent,quality->>'last_resets_at' AS resets_at
              FROM provider_quota_daily_agg WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4
                AND last_observed_at=$5::timestamptz LIMIT 1`,
            [accountId,item.kind,item.unit,item.window_key,observedAt]);
            previous = daily.rows[0];
          }
          if (previous && ['total','used','remaining','used_percent'].every(field => numberOrNull(previous[field]) === item[field])
            && timestamp(previous.resets_at) === item.resets_at) continue;
          if (previous) item.quality = { ...item.quality, correction: true };
        }
        items.push(item);
      }
      const duplicateSample = cached && normalized.length > 0 && items.length === 0;
      const rowStatus = row.ok && (items.length || duplicateSample) ? (status === 'partial' ? 'partial' : 'success') : 'failed';
      row.valid = rowStatus !== 'failed';
      await client.query(`INSERT INTO provider_quota_account_providers AS m
        (account_id,provider_id,active,legacy,last_attempt_at,last_attempt_status,last_valid_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(account_id,provider_id) DO UPDATE SET
          active=CASE WHEN m.last_attempt_at<=EXCLUDED.last_attempt_at THEN EXCLUDED.active ELSE m.active END,
          last_attempt_status=CASE WHEN m.last_attempt_at<=EXCLUDED.last_attempt_at THEN EXCLUDED.last_attempt_status ELSE m.last_attempt_status END,
          last_attempt_at=GREATEST(m.last_attempt_at,EXCLUDED.last_attempt_at),
          last_valid_at=GREATEST(m.last_valid_at,EXCLUDED.last_valid_at)`,
      [accountId,provider.id,currentConfiguration,ctx.source === 'legacy',ctx.checkedAt,rowStatus,row.valid ? observedAt : null]);
      const observationId = crypto.randomUUID();
      await client.query(`INSERT INTO provider_quota_observations
        (id,batch_id,provider_id,account_id,provider_name,source,checked_at,observed_at,status,error,quality)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [observationId, ctx.batchId, provider.id, accountId, safeText(provider.name, provider), ctx.source,
        ctx.checkedAt, observedAt, rowStatus, rowStatus === 'failed' ? '额度查询失败' : null,
        JSON.stringify({ cached, duplicate_sample: !!duplicateSample, legacy: ctx.source === 'legacy', completed_at: ctx.completedAt || ctx.checkedAt })]);
      const observation = { accountId, providerId: provider.id, providerName: safeText(provider.name, provider), observedAt, status: rowStatus };
      for (const item of items) {
        const prior = await client.query(`SELECT observed_at,total,used,remaining,used_percent,resets_at FROM provider_quota_observation_items
          WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4 ORDER BY observed_at DESC,id DESC LIMIT 1`,
        [accountId, item.kind, item.unit, item.window_key]);
        let previous = prior.rows[0];
        if (!previous) {
          const daily = await client.query(`SELECT last_observed_at AS observed_at,last_total AS total,last_used AS used,last_remaining AS remaining,last_used_percent AS used_percent,
            quality->>'last_resets_at' AS resets_at FROM provider_quota_daily_agg
            WHERE account_id=$1 AND kind=$2 AND unit=$3 AND window_key=$4 AND sample_count>0 ORDER BY last_observed_at DESC LIMIT 1`,
          [accountId, item.kind, item.unit, item.window_key]);
          previous = daily.rows[0];
        }
        const change = { ...classifyChange(previous, item, observedAt), previousAt: previous?.observed_at };
        item.quality = { ...item.quality, event: change.event, last_resets_at: item.resets_at };
        await client.query(`INSERT INTO provider_quota_observation_items
          (observation_id,account_id,provider_id,observed_at,kind,unit,window_key,total,used,remaining,used_percent,resets_at,quality)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
        [observationId,accountId,provider.id,observedAt,item.kind,item.unit,item.window_key,item.total,item.used,item.remaining,item.used_percent,item.resets_at,JSON.stringify(item.quality)]);
        await aggregateRow(client, observation, item, change);
      }
      if (cycleSchema.rows[0]?.table_name && items.length) {
        await require('./quota-cycle-analysis').processObservation(client, { id: observationId, account_id: accountId,
          provider_id: provider.id, observed_at: observedAt, status: rowStatus, quality: { cached } }, items);
      }
      if (!items.length) await aggregateRow(client, { ...observation, observedAt: ctx.checkedAt }, null, null);
      if (items.length) await client.query(`UPDATE provider_quota_accounts SET last_sample_at=GREATEST(last_sample_at,$2::timestamptz) WHERE id=$1`, [accountId, observedAt]);
      await client.query('UPDATE provider_quota_observations SET aggregated_at=NOW() WHERE id=$1', [observationId]);
    }
    if (options.updateSnapshot !== false) {
      const snapshot = serializeSafeResult(result,provider);
      const oldSnapshot = snapshotBefore.rows[0]?.quota_last_result;
      snapshot.status = status;
      snapshot.coverage = { successful: ctx.rows.filter(row => row.valid).length, total: ctx.rows.length };
      snapshot.last_valid_at = ctx.rows.filter(row => row.valid).map(row => timestamp(row.quota?.observedAt, ctx.completedAt || ctx.checkedAt)).sort().at(-1) || null;
      if (!snapshot.keys) snapshot.account_id = ctx.rows[0]?.accountId;
      if (!snapshot.keys && hasValidQuota && oldSnapshot?.periods && oldSnapshot.account_id === snapshot.account_id) {
        const periods = new Map(oldSnapshot.periods.map(period => [period.key, period]));
        for (const period of snapshot.periods) periods.set(period.key,period);
        snapshot.periods = [...periods.values()];
      }
      if (snapshot.keys) snapshot.keys = snapshot.keys.map((entry,index) => {
        const accountId = ctx.rows[index]?.accountId;
        const previous = snapshotBefore.rows[0]?.quota_last_result?.keys?.find(key => key.account_id === accountId);
        const valid = ctx.rows[index]?.valid;
        if (valid && previous?.quota?.periods) {
          const periods = new Map(previous.quota.periods.map(period => [period.key,period]));
          for (const period of entry.quota?.periods || []) periods.set(period.key,period);
          entry.quota.periods = [...periods.values()];
        }
        return { ...entry, ok: !!valid, account_id: accountId, quota: valid ? entry.quota : previous?.quota || null, stale: !valid };
      });
      await client.query(`UPDATE providers SET quota_last_checked_at=$2,quota_last_ok=$3,
        quota_last_result=CASE WHEN $3 THEN $4::jsonb ELSE quota_last_result END,quota_last_error=$5
        WHERE id=$1 AND (quota_last_checked_at IS NULL OR quota_last_checked_at<=$2::timestamptz)`,
      [provider.id,ctx.checkedAt,hasValidQuota,JSON.stringify(snapshot),hasValidQuota ? null : '额度查询失败']);
    }
    await client.query('COMMIT');
    return { recorded: true, duplicate: false, batch_id: ctx.batchId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function importLegacyQuotaHistory(pool) {
  const providers = await pool.query(`SELECT * FROM providers WHERE quota_last_checked_at IS NOT NULL`);
  let imported = 0;
  for (const provider of providers.rows) {
    const snapshot = provider.quota_last_result || {};
    const result = { ok: provider.quota_last_ok === true, quota: snapshot, keys: snapshot.keys };
    const ctx = { batchId: `legacy:${provider.id}`, checkedAt: timestamp(provider.quota_last_checked_at), source: 'legacy', provider,
      rows: [{ ok: result.ok, quota: snapshot.aggregated || (snapshot.keys?.length ? null : snapshot),
        label: provider.name, identity: stableIdentity(provider, null, true) }] };
    // 旧快照只有下标与掩码，不能安全映射到当前凭据。
    if (snapshot.keys?.length) ctx.rows = snapshot.keys.map((entry, index) => ({ ...entry,
      identity: { ...stableIdentity({ ...provider, id: `${provider.id}:legacy:${index}` }, null, true), scope: 'legacy' } }));
    contexts.set(result, ctx);
    const saved = await recordQuotaHistory(pool, provider, result, { updateSnapshot: false });
    if (!saved.duplicate) imported++;
  }
  return imported;
}

async function cleanupQuotaHistory(pool, retentionDays = 90) {
  if (!Number.isInteger(retentionDays) || retentionDays < 0) throw new Error('额度明细保留天数必须为非负整数');
  if (retentionDays === 0) return 0;
  // aggregated_at 只在同一事务内全部聚合成功后写入；批次收据和日聚合不清理。
  const result = await pool.query(`DELETE FROM provider_quota_observations
    WHERE checked_at < NOW()-($1 * INTERVAL '1 day') AND aggregated_at IS NOT NULL`, [retentionDays]);
  return result.rowCount;
}

module.exports = { stableIdentity, safeText, numberOrNull, normalizeQuotaItems, classifyChange, serializeSafeResult,
  attachQuotaBatch, transferQuotaBatch, ensureQuotaHistorySchema, recordQuotaHistory, importLegacyQuotaHistory, cleanupQuotaHistory };
