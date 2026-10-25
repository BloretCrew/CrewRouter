'use strict';

// Read-only audit of CrewRouter's security-sensitive database state.
// Usage: node server/scripts/security-audit.js [config.json]
// Every database statement runs inside a READ ONLY, repeatable-read transaction.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const configPath = path.resolve(process.argv[2] || process.env.CR_CONFIG_PATH || path.join(__dirname, '../../config.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value || '').digest('hex');
}

async function audit() {
  const client = new Client({
    host: process.env.CR_DB_HOST || config.database?.host,
    port: Number(process.env.CR_DB_PORT || config.database?.port || 5432),
    database: process.env.CR_DB_NAME || config.database?.name,
    user: process.env.CR_DB_USER || config.database?.user,
    password: process.env.CR_DB_PASSWORD || config.database?.password,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    application_name: 'crewrouter-security-readonly-audit',
    options: '-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=1000',
  });
  const report = { generatedAt: new Date().toISOString(), configPath, readOnly: false, checks: {} };
  let activeCheck = 'connection';
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    report.readOnly = (await client.query("SELECT current_setting('transaction_read_only') = 'on' AS active")).rows[0].active;
    if (!report.readOnly) throw new Error('database transaction did not enter READ ONLY mode');

    activeCheck = 'database';
    report.database = (await client.query(`
      SELECT current_database() AS name, pg_database_size(current_database())::bigint AS bytes,
             (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database())::int AS connections
    `)).rows[0];

    activeCheck = 'providers';
    report.checks.providers = {};
    const providers = await client.query(`
      SELECT id, name, enabled, key_mode, key_script, quota_script, base_url, created_at
      FROM public.providers ORDER BY id
    `);
    const suspiciousProviderNames = [];
    const suspiciousProviderScripts = [];
    let scriptKeyCount = 0;
    let customQuotaScriptCount = 0;
    for (const provider of providers.rows) {
      const combined = `${provider.key_script || ''}\n${provider.quota_script || ''}`;
      const name = `${provider.id || ''} ${provider.name || ''}`;
      if (/\bartex\b/i.test(name)) {
        suspiciousProviderNames.push({ id: provider.id, name: provider.name, enabled: provider.enabled, createdAt: provider.created_at });
      }
      if (/\bscript\b/i.test(provider.key_mode || '')) scriptKeyCount += 1;
      if (provider.quota_script) customQuotaScriptCount += 1;
      if (/constructor\s*\.\s*constructor|return\s+process|child_process|require\s*\(/i.test(combined)) {
        suspiciousProviderScripts.push({ id: provider.id, name: provider.name, enabled: provider.enabled, keyScriptSha256: sha256(provider.key_script), quotaScriptSha256: sha256(provider.quota_script) });
      }
    }
    report.checks.providers = {
      total: providers.rowCount,
      enabled: providers.rows.filter(provider => provider.enabled).length,
      scriptKeyCount,
      customQuotaScriptCount,
      plaintextApiKeyCount: (await client.query("SELECT count(*)::int AS n FROM public.providers WHERE api_key IS NOT NULL AND api_key<>'' AND api_key NOT LIKE 'aesgcm:%' AND api_key NOT LIKE 'enc:v1:%'" )).rows[0].n,
      suspiciousProviderNames,
      suspiciousProviderScripts,
    };

    activeCheck = 'team consistency';
    report.checks.teamConsistency = (await client.query(`
      SELECT
        (SELECT count(*)::int FROM users u WHERE u.team_id IS DISTINCT FROM (
          SELECT ut.team_id FROM user_teams ut WHERE ut.user_id=u.id ORDER BY ut.created_at,ut.id LIMIT 1
        )) AS "primaryMembershipMismatches",
        (SELECT count(*)::int FROM (SELECT user_id FROM user_teams GROUP BY user_id HAVING count(*)>1) x) AS "multipleMemberships",
        (SELECT count(*)::int FROM user_teams ut LEFT JOIN users u ON u.id=ut.user_id LEFT JOIN teams t ON t.id=ut.team_id WHERE u.id IS NULL OR t.id IS NULL) AS "orphanMemberships",
        (SELECT count(*)::int FROM team_models tm LEFT JOIN teams t ON t.id=tm.team_id LEFT JOIN models m ON m.id=tm.model_id WHERE t.id IS NULL OR m.id IS NULL) AS "orphanTeamModels",
        (SELECT count(*)::int FROM (SELECT name FROM teams GROUP BY name HAVING count(*)>1) x) AS "duplicateTeamNames",
        (SELECT count(*)::int FROM users u WHERE NOT EXISTS (SELECT 1 FROM user_teams ut WHERE ut.user_id=u.id)) AS "usersWithoutMembership"
    `)).rows[0];

    activeCheck = 'user identities';
    report.checks.identities = (await client.query(`
      SELECT count(*) FILTER(WHERE username IS NULL OR btrim(username)='')::int AS "emptyUsernames",
             count(*) FILTER(WHERE email IS NULL OR btrim(email)='')::int AS "emptyEmails",
             count(*) FILTER(WHERE is_admin)::int AS "administratorAccounts",
             (SELECT count(*)::int FROM (SELECT lower(username) FROM users GROUP BY lower(username) HAVING count(*)>1) x) AS "duplicateUsernames",
             (SELECT count(*)::int FROM (SELECT lower(email) FROM users WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(*)>1) x) AS "duplicateEmails"
      FROM users
    `)).rows[0];

    report.checks.sessions = (await client.query(`
      SELECT count(*) FILTER(WHERE expire>now())::int AS "activeSessions",
             count(*) FILTER(WHERE expire<=now())::int AS "expiredSessions",
             (SELECT count(*)::int FROM api_keys WHERE enabled) AS "enabledUserApiKeys",
             (SELECT count(*)::int FROM api_keys WHERE enabled AND key_value IS NOT NULL AND key_value<>'') AS "recoverableEnabledUserApiKeys"
      FROM user_sessions
    `)).rows[0];

    activeCheck = 'balances';
    report.checks.balances = (await client.query(`
      SELECT count(*) FILTER(WHERE balance<0)::int AS "negativeBalances",
             count(*) FILTER(WHERE refund_balance<0)::int AS "negativeRefundBalances",
             (SELECT count(*)::int FROM users u WHERE abs(COALESCE(u.refund_balance,0)-(
               SELECT COALESCE(sum(ucb.amount),0) FROM user_code_balances ucb WHERE ucb.user_id=u.id
             ))>0.0001) AS "refundDetailMismatches",
             (SELECT count(*)::int FROM user_code_balances b LEFT JOIN users u ON u.id=b.user_id
               LEFT JOIN redemption_codes rc ON rc.id=b.code_id WHERE u.id IS NULL OR rc.id IS NULL) AS "orphanCodeBalances",
             (SELECT round(COALESCE(sum(balance),0)::numeric,4)::text FROM users) AS "regularBalanceTotal",
             (SELECT round(COALESCE(sum(refund_balance),0)::numeric,4)::text FROM users) AS "refundBalanceTotal"
      FROM users
    `)).rows[0];

    activeCheck = 'catalog';
    report.checks.catalog = (await client.query(`
      SELECT count(*) FILTER(WHERE NOT i.indisvalid)::int AS "invalidIndexes",
             count(*) FILTER(WHERE NOT i.indisready)::int AS "notReadyIndexes",
             (SELECT count(*)::int FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated) AS "unvalidatedConstraints"
      FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
    `)).rows[0];

    activeCheck = 'owned sequences';
    const sequenceOwners = await client.query(`
      SELECT sn.nspname AS "sequenceSchema",s.relname AS "sequenceName",
             tn.nspname AS "tableSchema",t.relname AS "tableName",a.attname AS "columnName",
             ps.seqincrement AS "increment"
      FROM pg_class s JOIN pg_namespace sn ON sn.oid=s.relnamespace
      JOIN pg_sequence ps ON ps.seqrelid=s.oid
      JOIN pg_depend d ON d.objid=s.oid AND d.deptype IN ('a','i')
      JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
      WHERE s.relkind='S' AND tn.nspname='public'
      ORDER BY tn.nspname,t.relname,a.attname
    `);
    const behindSequences = [];
    for (const sequence of sequenceOwners.rows) {
      activeCheck = `sequence ${sequence.sequenceName}`;
      const seqName = `${quoteIdentifier(sequence.sequenceSchema)}.${quoteIdentifier(sequence.sequenceName)}`;
      const tableName = `${quoteIdentifier(sequence.tableSchema)}.${quoteIdentifier(sequence.tableName)}`;
      const columnName = quoteIdentifier(sequence.columnName);
      const state = (await client.query(`SELECT last_value,is_called FROM ${seqName}`)).rows[0];
      const maximum = (await client.query(`SELECT max(${columnName})::text AS value FROM ${tableName}`)).rows[0].value;
      const nextValue = BigInt(state.last_value) + (state.is_called ? BigInt(sequence.increment) : 0n);
      if (maximum !== null && nextValue <= BigInt(maximum)) {
        behindSequences.push({ table: sequence.tableName, column: sequence.columnName, sequence: sequence.sequenceName, lastValue: String(state.last_value), nextValue: String(nextValue), maximum, deficit: String(BigInt(maximum) - nextValue + 1n) });
      }
    }
    report.checks.sequences = { ownedCount: sequenceOwners.rowCount, behindCount: behindSequences.length, behind: behindSequences };

    activeCheck = 'incident audit';
    report.checks.incidentAudit = (await client.query(`
      SELECT ip_address AS source,action,count(*)::int AS count,min(created_at) AS firstSeen,max(created_at) AS lastSeen,
             array_agg(DISTINCT substring(description FROM '创建供应商「([^」]{1,100})」'))
               FILTER(WHERE description ILIKE '%artex%' AND description ILIKE '%创建供应商%') AS artexNames
      FROM operation_logs
      WHERE created_at >= TIMESTAMPTZ '2026-10-18 00:00:00+08'
        AND created_at < TIMESTAMPTZ '2026-10-22 00:00:00+08'
        AND action IN ('auth.login_2fa','admin.provider_create','admin.provider_delete','admin.provider_update')
      GROUP BY ip_address,action ORDER BY firstSeen
    `)).rows;

    await client.query('ROLLBACK');
    return report;
  } catch (error) {
    error.activeCheck = activeCheck;
    throw error;
  } finally {
    await client.end();
  }
}

audit().then(report => {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.checks.sequences.behindCount > 0
      || report.checks.providers.suspiciousProviderNames.length > 0
      || report.checks.providers.suspiciousProviderScripts.length > 0) process.exitCode = 1;
}).catch(error => {
  // Deliberately omit error text and connection diagnostics that could expose config values.
  process.stderr.write(`Security audit failed (${error.activeCheck || 'database query'}): ${error.code || error.name || 'unknown error'}\n`);
  process.exitCode = 2;
});
