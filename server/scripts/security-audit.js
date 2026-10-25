'use strict';

// Read-only audit of CrewRouter's security-sensitive database state.
// Usage: node server/scripts/security-audit.js [config.json]
// Every database statement runs inside a READ ONLY, repeatable-read transaction.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

const REQUIRED_PUBLIC_TABLES = [
  'providers', 'users', 'user_teams', 'teams', 'team_models', 'models',
  'api_keys', 'user_sessions', 'user_code_balances', 'redemption_codes', 'operation_logs',
];
const OPTIONAL_PUBLIC_TABLES = [
  'balance_preconsumes', 'redemption_code_uses', 'api_key_members', 'plugins',
];

const configPath = path.resolve(process.argv[2] || process.env.CR_CONFIG_PATH || path.join(__dirname, '../../config.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value || '').digest('hex');
}

async function hasPublicTable(client, name) {
  const result = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${name}`]);
  return result.rows[0].present;
}

async function inspectPublicTableShapes(client) {
  const required = new Set(REQUIRED_PUBLIC_TABLES);
  const names = [...REQUIRED_PUBLIC_TABLES, ...OPTIONAL_PUBLIC_TABLES];
  const result = await client.query(`
    SELECT requested.name, c.relkind, c.relrowsecurity AS "rowSecurityEnabled"
    FROM unnest($1::text[]) AS requested(name)
    LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = 'public'
    LEFT JOIN pg_catalog.pg_class c
      ON c.relnamespace = n.oid AND c.relname = requested.name
    ORDER BY requested.name
  `, [names]);
  const rows = result.rows;
  return {
    missingRequired: rows.filter(row => required.has(row.name) && row.relkind === null).map(row => row.name),
    nonTableRelations: rows.filter(row => row.relkind !== null && !['r', 'p'].includes(row.relkind))
      .map(row => ({ name: row.name, kind: row.relkind })),
    rowSecurityEnabled: rows.filter(row => row.relrowsecurity === true).map(row => row.name),
    optionalMissing: rows.filter(row => !required.has(row.name) && row.relkind === null).map(row => row.name),
  };
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
  const report = { generatedAt: new Date().toISOString(), configPath, readOnly: false, complete: false, checks: {} };
  let activeCheck = 'connection';
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    report.readOnly = (await client.query("SELECT current_setting('transaction_read_only') = 'on' AS active")).rows[0].active;
    if (!report.readOnly) throw new Error('database transaction did not enter READ ONLY mode');

    // Pin relation lookup to the application schema and fail closed if a public
    // relation was replaced with a view/foreign table or has row policies.
    await client.query('SET LOCAL search_path TO pg_catalog, public');
    await client.query('SET LOCAL row_security = off');
    activeCheck = 'schema preflight';
    report.checks.schemaShape = await inspectPublicTableShapes(client);
    const schemaShape = report.checks.schemaShape;
    if (schemaShape.missingRequired.length || schemaShape.nonTableRelations.length || schemaShape.rowSecurityEnabled.length) {
      await client.query('ROLLBACK');
      return report;
    }

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

    activeCheck = 'plugins';
    if (!(await hasPublicTable(client, 'plugins'))) {
      report.checks.plugins = { tableMissing: true };
    } else {
      const plugins = await client.query(`
        SELECT id, name, version, enabled, permissions, config
        FROM public.plugins ORDER BY id
      `);
      report.checks.plugins = {
        total: plugins.rowCount,
        enabledCount: plugins.rows.filter(plugin => plugin.enabled).length,
        entries: plugins.rows.map(plugin => ({
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          enabled: plugin.enabled,
          permissions: plugin.permissions,
          configSha256: sha256(JSON.stringify(plugin.config || {})),
        })),
      };
    }

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

    activeCheck = 'balance preconsumes';
    report.checks.balancePreconsumes = await hasPublicTable(client, 'balance_preconsumes')
      ? (await client.query(`
      SELECT count(*) FILTER(WHERE status='pending')::int AS "pendingCount",
             count(*) FILTER(WHERE status='pending' AND created_at < now() - interval '24 hours')::int AS "stalePendingCount",
             count(*) FILTER(WHERE status='settled' AND (actual_amount IS NULL OR settled_at IS NULL))::int AS "incompleteSettlementCount",
             count(*) FILTER(WHERE status NOT IN ('pending','settled'))::int AS "unknownStatusCount",
             count(*) FILTER(WHERE amount < 0 OR actual_amount < 0)::int AS "negativeAmountCount"
      FROM balance_preconsumes
    `)).rows[0]
      : { tableMissing: true };

    activeCheck = 'redemption codes';
    report.checks.redemptionCodes = await hasPublicTable(client, 'redemption_codes')
      && await hasPublicTable(client, 'redemption_code_uses')
      ? (await client.query(`
      SELECT count(*) FILTER(WHERE COALESCE(rc.used_count,0) <> COALESCE(uses.actual_uses,0))::int AS "usedCountMismatches",
             count(*) FILTER(WHERE rc.max_uses > 0 AND COALESCE(uses.actual_uses,0) > rc.max_uses)::int AS "codesOverUseLimit",
             count(*) FILTER(WHERE rc.used_count < 0 OR rc.max_uses < 0 OR rc.amount < 0)::int AS "invalidCodeValues"
      FROM redemption_codes rc
      LEFT JOIN (
        SELECT code_id, count(*)::int AS actual_uses
        FROM redemption_code_uses GROUP BY code_id
      ) uses ON uses.code_id = rc.id
    `)).rows[0]
      : { tableMissing: true };

    activeCheck = 'API key memberships';
    report.checks.apiKeyMemberships = await hasPublicTable(client, 'api_key_members')
      ? (await client.query(`
      SELECT count(*) FILTER(WHERE ak.id IS NULL OR u.id IS NULL)::int AS "orphanMemberships",
             count(*) FILTER(WHERE ak.id IS NOT NULL AND ak.user_id = m.user_id)::int AS "ownerAlsoMemberCount",
             (SELECT count(*)::int FROM api_keys WHERE enabled = TRUE AND user_id IS NULL) AS "enabledKeysWithoutOwner"
      FROM api_key_members m
      LEFT JOIN api_keys ak ON ak.id = m.api_key_id
      LEFT JOIN users u ON u.id = m.user_id
    `)).rows[0]
      : { tableMissing: true };

    activeCheck = 'catalog';
    report.checks.catalog = (await client.query(`
      SELECT count(*) FILTER(WHERE NOT i.indisvalid)::int AS "invalidIndexes",
             count(*) FILTER(WHERE NOT i.indisready)::int AS "notReadyIndexes",
             (SELECT count(*)::int FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated) AS "unvalidatedConstraints"
      FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
    `)).rows[0];

    activeCheck = 'database hooks and role';
    report.checks.databaseHooks = (await client.query(`
      SELECT n.nspname AS "schemaName", c.relname AS "tableName", t.tgname AS "triggerName",
             p.proname AS "functionName", l.lanname AS "languageName",
             p.prosecdef AS "securityDefiner", pg_get_userbyid(p.proowner) AS "functionOwner"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      JOIN pg_language l ON l.oid=p.prolang
      WHERE NOT t.tgisinternal AND n.nspname='public'
      ORDER BY c.relname,t.tgname
    `)).rows;
    report.checks.databaseEventTriggers = (await client.query(`
      SELECT evtname AS name, evtevent AS event, evtenabled AS enabled,
             pg_get_userbyid(evtowner) AS owner
      FROM pg_event_trigger ORDER BY evtname
    `)).rows;
    report.checks.databaseRole = (await client.query(`
      SELECT rolname AS name, rolsuper AS superuser, rolcreaterole AS createRole,
             rolcreatedb AS createDatabase, rolreplication AS replication,
             rolbypassrls AS bypassRls,
             has_schema_privilege(current_user, 'public', 'CREATE') AS publicSchemaCreate
      FROM pg_roles WHERE rolname=current_user
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
      WHERE s.relkind='S' AND t.relkind IN ('r','p') AND tn.nspname='public'
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
    report.complete = true;
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
  if (!report.complete) {
    process.exitCode = 2;
    return;
  }
  const c = report.checks;
  const unexpectedTriggers = c.databaseHooks.filter(trigger => ![
    'quota_cycle_attempt_changed',
    'quota_cycle_sample_changed',
  ].includes(trigger.triggerName));
  if (c.schemaShape.optionalMissing.includes('plugins')
      || c.providers.plaintextApiKeyCount > 0
      || c.providers.scriptKeyCount > 0
      || c.providers.customQuotaScriptCount > 0
      || c.plugins.enabledCount > 0
      || c.teamConsistency.primaryMembershipMismatches > 0
      || c.teamConsistency.orphanMemberships > 0
      || c.teamConsistency.orphanTeamModels > 0
      || c.teamConsistency.duplicateTeamNames > 0
      || c.identities.duplicateUsernames > 0
      || c.identities.duplicateEmails > 0
      || c.balances.negativeBalances > 0
      || c.balances.negativeRefundBalances > 0
      || c.balances.refundDetailMismatches > 0
      || c.balances.orphanCodeBalances > 0
      || c.balancePreconsumes.stalePendingCount > 0
      || c.balancePreconsumes.incompleteSettlementCount > 0
      || c.balancePreconsumes.unknownStatusCount > 0
      || c.balancePreconsumes.negativeAmountCount > 0
      || c.redemptionCodes.usedCountMismatches > 0
      || c.redemptionCodes.codesOverUseLimit > 0
      || c.redemptionCodes.invalidCodeValues > 0
      || c.apiKeyMemberships.orphanMemberships > 0
      || c.apiKeyMemberships.ownerAlsoMemberCount > 0
      || c.apiKeyMemberships.enabledKeysWithoutOwner > 0
      || c.catalog.invalidIndexes > 0
      || c.catalog.notReadyIndexes > 0
      || c.catalog.unvalidatedConstraints > 0
      || unexpectedTriggers.length > 0
      || c.databaseEventTriggers.length > 0
      || c.databaseRole.superuser
      || c.databaseRole.createRole
      || c.databaseRole.createDatabase
      || c.databaseRole.replication
      || c.databaseRole.bypassRls
      || c.databaseRole.publicSchemaCreate
      || c.sequences.behindCount > 0
      || report.checks.providers.suspiciousProviderNames.length > 0
      || report.checks.providers.suspiciousProviderScripts.length > 0
      || c.balancePreconsumes.tableMissing === true
      || c.redemptionCodes.tableMissing === true
      || c.apiKeyMemberships.tableMissing === true
      || c.plugins.tableMissing === true) process.exitCode = 1;
}).catch(error => {
  // Deliberately omit error text and connection diagnostics that could expose config values.
  process.stderr.write(`Security audit failed (${error.activeCheck || 'database query'}): ${error.code || error.name || 'unknown error'}\n`);
  process.exitCode = 2;
});
