'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

async function inspectUsageData(client) {
  const usage = (await client.query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE created_at IS NULL)::int AS missing_time,
    count(*) FILTER (WHERE NOT isfinite(created_at) OR created_at < TIMESTAMP '2000-01-01'
      OR created_at > (statement_timestamp() AT TIME ZONE 'Asia/Shanghai') + INTERVAL '5 minutes')::int AS invalid_time,
    count(*) FILTER (WHERE tokens_used < 0 OR prompt_tokens < 0 OR completion_tokens < 0 OR cached_tokens < 0)::int AS negative_tokens
    FROM public.usage_records`)).rows[0];
  const analysis = (await client.query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE usage_id IS NULL)::int AS missing_usage_id FROM public.usage_message_analysis`)).rows[0];
  const attempts = (await client.query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE created_at IS NULL)::int AS missing_time FROM public.request_attempts`)).rows[0];
  return { usage, analysis, attempts };
}

async function findTimestampRepairs(client, lock = false) {
  return (await client.query(`SELECT usage.id AS usage_id, analysis.id AS analysis_id, usage.user_id,
      usage.created_at::text AS original_created_at, analysis.created_at::text AS repaired_created_at,
      analysis.analyzed_at::text AS analyzed_at
    FROM public.usage_records usage
    JOIN public.usage_message_analysis analysis ON analysis.usage_id = usage.id
    WHERE usage.user_id IS NOT NULL AND usage.user_id = analysis.user_id
      AND isfinite(analysis.created_at) AND analysis.created_at >= TIMESTAMP '2000-01-01'
      AND analysis.created_at <= (statement_timestamp() AT TIME ZONE 'Asia/Shanghai') + INTERVAL '5 minutes'
      AND isfinite(analysis.analyzed_at) AND analysis.analyzed_at >= analysis.created_at
      AND analysis.analyzed_at <= (statement_timestamp() AT TIME ZONE 'Asia/Shanghai') + INTERVAL '5 minutes'
      AND analysis.created_at = date_trunc('milliseconds', analysis.created_at)
      AND date_trunc('milliseconds', usage.created_at) IS DISTINCT FROM analysis.created_at
      AND NOT EXISTS (SELECT 1 FROM public.usage_message_analysis duplicate
        WHERE duplicate.usage_id = usage.id AND duplicate.id <> analysis.id)
    ORDER BY usage.id ${lock ? 'FOR UPDATE OF usage FOR SHARE OF analysis' : ''}`)).rows;
}

function writeDurable(filename, contents) {
  const descriptor = fs.openSync(filename, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const directory = fs.openSync(path.dirname(filename), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

async function repairUsageTimestamps(client, options = {}) {
  const apply = options.apply === true;
  const batchSize = options.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error('invalid_batch_size');
  if (apply && (!options.backupDirectory || !path.isAbsolute(options.backupDirectory))) {
    throw new Error('apply_requires_absolute_new_backup_directory');
  }
  let transaction = false;
  let backupWritten = false;
  let commitAttempted = false;
  let committed = false;
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    transaction = true;
    if (apply) {
      const lock = await client.query('SELECT pg_try_advisory_xact_lock(817391, 20261028) AS acquired');
      if (!lock.rows[0].acquired) throw new Error('usage_timestamp_repair_already_running');
    }
    const before = await inspectUsageData(client);
    const repairs = await findTimestampRepairs(client, apply);
    const result = { mode: apply ? 'apply' : 'dry-run', candidates: repairs.length, updated: 0, before };
    if (!apply || repairs.length === 0) {
      await client.query('ROLLBACK');
      transaction = false;
      return result;
    }

    const identity = (await client.query('SELECT current_database() AS database, statement_timestamp()::text AS captured_at')).rows[0];
    const contents = JSON.stringify({ version: 1, ...identity,
      source: 'usage_message_analysis.created_at copied from the same usage_id by message-analysis-store',
      target: 'public.usage_records.created_at', precision: 'milliseconds', repairs }, null, 2) + '\n';
    const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
    fs.mkdirSync(options.backupDirectory, { mode: 0o700 });
    const parent = fs.openSync(path.dirname(options.backupDirectory), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    writeDurable(path.join(options.backupDirectory, 'original-values.json'), contents);
    writeDurable(path.join(options.backupDirectory, 'SHA256SUMS'), `${sha256}  original-values.json\n`);
    backupWritten = true;

    for (let offset = 0; offset < repairs.length; offset += batchSize) {
      const batch = repairs.slice(offset, offset + batchSize);
      const updated = await client.query(`UPDATE public.usage_records usage SET created_at = patch.repaired_created_at
        FROM jsonb_to_recordset($1::jsonb) AS patch(usage_id integer, analysis_id integer, user_id integer,
          original_created_at timestamp, repaired_created_at timestamp, analyzed_at timestamp)
        JOIN public.usage_message_analysis analysis ON analysis.id = patch.analysis_id
          AND analysis.usage_id = patch.usage_id AND analysis.user_id = patch.user_id
          AND analysis.created_at = patch.repaired_created_at AND analysis.analyzed_at = patch.analyzed_at
        WHERE usage.id = patch.usage_id AND usage.user_id = patch.user_id
          AND usage.created_at IS NOT DISTINCT FROM patch.original_created_at`, [JSON.stringify(batch)]);
      if (updated.rowCount !== batch.length) throw new Error('usage_timestamp_repair_row_count_mismatch');
      result.updated += updated.rowCount;
    }
    if ((await findTimestampRepairs(client)).length !== 0) throw new Error('usage_timestamp_repair_verification_failed');
    result.after = await inspectUsageData(client);
    result.backupDirectory = options.backupDirectory;
    result.sha256 = sha256;
    commitAttempted = true;
    await client.query('COMMIT');
    committed = true;
    transaction = false;
    writeDurable(path.join(options.backupDirectory, 'result.json'), JSON.stringify({ status: 'committed', ...result }, null, 2) + '\n');
    return result;
  } catch (error) {
    let rolledBack = false;
    if (transaction) {
      try { await client.query('ROLLBACK'); rolledBack = true; } catch (_) {}
    }
    if (backupWritten) {
      try {
        writeDurable(path.join(options.backupDirectory, 'failure.json'), JSON.stringify({
          status: committed ? 'committed_result_file_failed' : commitAttempted ? 'commit_outcome_unknown' : rolledBack ? 'rolled_back' : 'outcome_unknown',
          error: error.message,
        }, null, 2) + '\n');
      } catch (_) {}
    }
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const backupIndex = args.indexOf('--backup-dir');
  const backupDirectory = backupIndex >= 0 ? args[backupIndex + 1] : undefined;
  const recognized = new Set(['--apply', '--backup-dir', backupDirectory].filter(Boolean));
  if (args.some(argument => !recognized.has(argument)) || (backupIndex >= 0 && (!backupDirectory || backupDirectory.startsWith('--')))) {
    throw new Error('usage: node server/scripts/repair-usage-timestamps.js [--apply --backup-dir /absolute/new/private/directory]');
  }
  if (apply && (!backupDirectory || !path.isAbsolute(backupDirectory))) throw new Error('apply_requires_absolute_new_backup_directory');
  const config = require('../config-loader').database;
  const client = new Client({ host: config.host, port: config.port, database: config.name, user: config.user, password: config.password,
    connectionTimeoutMillis: 5000, application_name: apply ? 'crewrouter-usage-timestamp-repair' : 'crewrouter-usage-timestamp-dry-run',
    options: `${apply ? '' : '-c default_transaction_read_only=on '}-c statement_timeout=30000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=60000 -c timezone=Asia/Shanghai`,
  });
  try {
    await client.connect();
    console.log(JSON.stringify(await repairUsageTimestamps(client, { apply, backupDirectory }), null, 2));
  } finally {
    await client.end();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { inspectUsageData, findTimestampRepairs, repairUsageTimestamps };
