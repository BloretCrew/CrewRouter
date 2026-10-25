'use strict';

// Read-only audit of CrewRouter's security-sensitive database state.
// Usage: node server/scripts/security-audit.js [config.json]
// Every database statement runs inside a READ ONLY, repeatable-read transaction.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { HARNESS_SOURCES } = require('../utils/request-source');

const REQUIRED_PUBLIC_TABLES = [
  'providers', 'users', 'user_teams', 'teams', 'team_models', 'models',
  'api_keys', 'user_sessions', 'user_code_balances', 'redemption_codes', 'operation_logs',
];
const OPTIONAL_PUBLIC_TABLES = [
  'balance_preconsumes', 'redemption_code_uses', 'api_key_members', 'plugins',
  'api_key_models', 'api_key_harness_models', 'inject_prompts', 'inject_prompt_key_bindings',
];

const RISK_COUNTS = {
  providers: ['plaintextApiKeyCount', 'scriptKeyCount', 'customQuotaScriptCount'],
  plugins: ['enabledCount'],
  providerModelIntegrity: ['modelsWithoutProvider'],
  teamConsistency: ['primaryMembershipMismatches', 'orphanMemberships', 'orphanTeamModels', 'duplicateTeamNames', 'usersWithoutMembership'],
  identities: ['emptyUsernames', 'duplicateUsernames', 'duplicateEmails', 'duplicateGitHubIds', 'duplicateFeishuOpenIds', 'duplicatePassportUsernames', 'blankExternalIdentities'],
  balances: ['negativeBalances', 'negativeRefundBalances', 'negativeCodeBalanceAmounts', 'negativeCodeBalanceFeeRates', 'refundDetailMismatches', 'orphanCodeBalances'],
  balancePreconsumes: ['stalePendingCount', 'incompleteSettlementCount', 'unknownStatusCount', 'negativeAmountCount'],
  redemptionCodes: ['usedCountMismatches', 'codesOverUseLimit', 'invalidCodeValues', 'orphanCreators', 'orphanUses', 'duplicateUses', 'balancesWithoutUse'],
  apiKeyMemberships: ['orphanMemberships', 'ownerAlsoMemberCount', 'orphanOwners', 'enabledKeysWithoutOwner'],
  apiKeyQueues: ['orphanKeys', 'orphanModels', 'duplicateBindings'],
  apiKeyHarness: ['orphanKeys', 'orphanModels', 'duplicateBindings', 'invalidHarnesses'],
  promptRecords: ['orphanOwners'],
  promptBindings: ['orphanBindings', 'crossOwnerBindings', 'duplicateBindings'],
  catalog: ['invalidIndexes', 'notReadyIndexes', 'unvalidatedConstraints'],
  sequences: ['behindCount'],
};
const NEW_CHECK_TABLES = { apiKeyQueues: ['api_key_models'], apiKeyHarness: ['api_key_harness_models'], promptRecords: ['inject_prompts'], promptBindings: ['inject_prompts', 'inject_prompt_key_bindings'] };
const OPTIONAL_CHECKS = ['plugins', 'balancePreconsumes', 'redemptionCodes', 'apiKeyMemberships', ...Object.keys(NEW_CHECK_TABLES)];
const ROLE_FLAGS = ['superuser', 'createRole', 'createDatabase', 'replication', 'bypassRls', 'publicSchemaCreate'];

function invalidCheckFields(checks) {
  const invalid = [];
  for (const [section, fields] of Object.entries(RISK_COUNTS)) {
    if (Object.hasOwn(NEW_CHECK_TABLES, section)) {
      const missing = checks?.[section]?.missingTables;
      if (!Array.isArray(missing) || new Set(missing).size !== missing.length || missing.some(name => !NEW_CHECK_TABLES[section].includes(name))
        || checks?.[section]?.tableMissing !== (missing?.length > 0)) invalid.push(`${section}.missingTables`);
      if (checks?.[section]?.tableMissing !== true && (!Number.isInteger(checks?.[section]?.total) || checks[section].total < 0)) invalid.push(`${section}.total`);
    }
    if (OPTIONAL_CHECKS.includes(section) && checks?.[section]?.tableMissing === true) continue;
    for (const field of fields) {
      const value = checks?.[section]?.[field];
      if (!Number.isInteger(value) || value < 0) invalid.push(`${section}.${field}`);
    }
  }
  for (const field of ROLE_FLAGS) {
    if (typeof checks?.databaseRole?.[field] !== 'boolean') invalid.push(`databaseRole.${field}`);
  }
  for (const [section, field] of [
    ...['missingRequired', 'nonTableRelations', 'rowSecurityEnabled', 'optionalMissing'].map(field => ['schemaShape', field]),
    ['providers', 'suspiciousProviderNames'], ['providers', 'suspiciousProviderScripts'],
  ]) {
    if (!Array.isArray(checks?.[section]?.[field])) invalid.push(`${section}.${field}`);
  }
  for (const field of ['databaseHooks', 'databaseEventTriggers']) {
    if (!Array.isArray(checks?.[field])) invalid.push(field);
  }
  return invalid;
}

function expectedQuotaFunctionSource() {
  // Read the checked-out schema as data; do not load application modules or execute SQL.
  const source = fs.readFileSync(path.join(__dirname, '../utils/quota-cycle-analysis.js'), 'utf8');
  const match = source.match(/CREATE OR REPLACE FUNCTION quota_cycle_attempt_changed\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$/);
  if (!match) throw new Error('quota trigger source baseline is unavailable');
  return match[1].replace(/\r\n/g, '\n').trim();
}

function isExpectedTrigger(trigger) {
  const tableForTrigger = {
    quota_cycle_attempt_changed: 'request_attempts',
    quota_cycle_sample_changed: 'request_quota_samples',
  };
  return trigger.schemaName === 'public'
    && Object.hasOwn(tableForTrigger, trigger.triggerName)
    && trigger.tableName === tableForTrigger[trigger.triggerName]
    && trigger.functionSchema === 'public'
    && trigger.functionName === 'quota_cycle_attempt_changed'
    && trigger.languageName === 'plpgsql'
    && trigger.securityDefiner === false
    && trigger.enabled === 'O'
    && trigger.triggerType === 21 // AFTER INSERT OR UPDATE, FOR EACH ROW
    && trigger.argumentCount === 0
    && trigger.hasCondition === false
    && trigger.isConstraint === false
    && trigger.hasFunctionSettings === false
    && trigger.functionSourceMatchesRepository === true;
}

function auditExitCode(report) {
  if (report?.readOnly !== true || report?.complete !== true || invalidCheckFields(report.checks).length) return 2;
  const c = report.checks;
  if (c.schemaShape.missingRequired.length || c.schemaShape.nonTableRelations.length || c.schemaShape.rowSecurityEnabled.length) return 2;
  const positiveCount = Object.entries(RISK_COUNTS).some(([section, fields]) => fields.some(field => c[section]?.[field] > 0));
  return positiveCount
    || c.schemaShape.optionalMissing.length > 0
    || OPTIONAL_CHECKS.some(section => c[section]?.tableMissing === true)
    || c.providers.suspiciousProviderNames.length > 0
    || c.providers.suspiciousProviderScripts.length > 0
    || c.databaseHooks.some(trigger => !isExpectedTrigger(trigger))
    || c.databaseEventTriggers.length > 0
    || ROLE_FLAGS.some(field => c.databaseRole[field])
    ? 1 : 0;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value || '').digest('hex');
}

async function hasPublicTable(client, name) {
  const result = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${name}`]);
  if (typeof result.rows[0]?.present !== 'boolean') {
    throw Object.assign(new Error('invalid table presence result'), { code: 'AUDIT_RESULT_SHAPE' });
  }
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
  if (rows.length !== names.length || new Set(rows.map(row => row.name)).size !== names.length
      || rows.some(row => !names.includes(row.name) || !Object.hasOwn(row, 'relkind')
        || (row.relkind !== null && (typeof row.relkind !== 'string' || typeof row.rowSecurityEnabled !== 'boolean')))) {
    throw Object.assign(new Error('invalid schema preflight result'), { code: 'AUDIT_RESULT_SHAPE' });
  }
  return {
    missingRequired: rows.filter(row => required.has(row.name) && row.relkind === null).map(row => row.name),
    nonTableRelations: rows.filter(row => row.relkind !== null && !['r', 'p'].includes(row.relkind))
      .map(row => ({ name: row.name, kind: row.relkind })),
    rowSecurityEnabled: rows.filter(row => row.rowSecurityEnabled === true).map(row => row.name),
    optionalMissing: rows.filter(row => !required.has(row.name) && row.relkind === null).map(row => row.name),
  };
}

async function audit({ client: suppliedClient, configPath: suppliedConfigPath } = {}) {
  const configPath = path.resolve(suppliedConfigPath || process.argv[2] || process.env.CR_CONFIG_PATH || path.join(__dirname, '../../config.json'));
  // Importing the auditor for offline regression checks must not read credentials
  // or create a live database connection.
  const config = suppliedClient ? {} : JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const client = suppliedClient || new Client({
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
    report.checks.providerModelIntegrity = (await client.query(`
      SELECT count(*) FILTER(WHERE p.id IS NULL)::int AS "modelsWithoutProvider"
      FROM public.models m
      LEFT JOIN public.providers p ON p.id = m.provider
    `)).rows[0];

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
             (SELECT count(*)::int FROM (SELECT lower(btrim(email)) FROM users WHERE email IS NOT NULL AND btrim(email)<>'' GROUP BY lower(btrim(email)) HAVING count(*)>1) x) AS "duplicateEmails",
             (SELECT count(*)::int FROM (SELECT github_id FROM users WHERE github_id IS NOT NULL GROUP BY github_id HAVING count(*)>1) x) AS "duplicateGitHubIds",
             (SELECT count(*)::int FROM (SELECT feishu_open_id FROM users WHERE feishu_open_id IS NOT NULL GROUP BY feishu_open_id HAVING count(*)>1) x) AS "duplicateFeishuOpenIds",
             (SELECT count(*)::int FROM (SELECT passport_username FROM users WHERE passport_username IS NOT NULL GROUP BY passport_username HAVING count(*)>1) x) AS "duplicatePassportUsernames",
             count(*) FILTER(WHERE (github_id IS NOT NULL AND btrim(github_id)='')
               OR (feishu_open_id IS NOT NULL AND btrim(feishu_open_id)='')
               OR (passport_username IS NOT NULL AND btrim(passport_username)=''))::int AS "blankExternalIdentities"
      FROM users
    `)).rows[0];

    report.checks.sessions = (await client.query(`
      SELECT count(*) FILTER(WHERE expire>now())::int AS "activeSessions",
             count(*) FILTER(WHERE expire<=now())::int AS "expiredSessions",
             (SELECT count(*)::int FROM api_keys WHERE enabled) AS "enabledUserApiKeys",
             (SELECT count(*)::int FROM api_keys WHERE enabled AND key_value IS NOT NULL AND key_value<>'') AS "recoverableEnabledUserApiKeys"
      FROM user_sessions
    `)).rows[0];

    activeCheck = 'refund history';
    report.checks.refundHistory = (await client.query(`
      SELECT id, user_id AS "operatorUserId", username AS operator,
             resource_id AS "affectedUserId", details->'refund_amount' AS "requestedNetAmount",
             status, created_at AS "createdAt"
      FROM operation_logs
      WHERE action = 'admin.user_refund'
      ORDER BY created_at, id
    `)).rows;

    activeCheck = 'balances';
    report.checks.balances = (await client.query(`
      SELECT count(*) FILTER(WHERE balance<0)::int AS "negativeBalances",
             count(*) FILTER(WHERE refund_balance<0)::int AS "negativeRefundBalances",
             (SELECT count(*)::int FROM user_code_balances WHERE amount < 0) AS "negativeCodeBalanceAmounts",
             (SELECT count(*)::int FROM user_code_balances WHERE fee_rate < 0) AS "negativeCodeBalanceFeeRates",
             (SELECT count(*)::int FROM users u WHERE COALESCE(u.refund_balance,0) <> (
               SELECT COALESCE(sum(ucb.amount),0) FROM user_code_balances ucb WHERE ucb.user_id=u.id
             )) AS "refundDetailMismatches",
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
             count(*) FILTER(WHERE rc.used_count IS NULL OR rc.max_uses IS NULL OR rc.amount IS NULL OR rc.fee_rate IS NULL OR rc.used_count < 0 OR rc.max_uses < 0 OR rc.amount <= 0 OR rc.fee_rate < 0)::int AS "invalidCodeValues",
             count(*) FILTER(WHERE rc.created_by IS NOT NULL AND u.id IS NULL)::int AS "orphanCreators",
             (SELECT count(*)::int FROM redemption_code_uses r LEFT JOIN redemption_codes c ON c.id=r.code_id
               LEFT JOIN users u ON u.id=r.user_id WHERE c.id IS NULL OR u.id IS NULL) AS "orphanUses",
             (SELECT count(*)::int FROM (SELECT code_id,user_id FROM redemption_code_uses GROUP BY code_id,user_id HAVING count(*)>1) d) AS "duplicateUses",
             (SELECT count(*)::int FROM user_code_balances b WHERE NOT EXISTS
               (SELECT 1 FROM redemption_code_uses r WHERE r.code_id=b.code_id AND r.user_id=b.user_id)) AS "balancesWithoutUse"
      FROM redemption_codes rc
      LEFT JOIN users u ON u.id = rc.created_by
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
             (SELECT count(*)::int FROM api_keys ak LEFT JOIN users owner ON owner.id=ak.user_id
               WHERE ak.user_id IS NOT NULL AND owner.id IS NULL) AS "orphanOwners",
             (SELECT count(*)::int FROM api_keys WHERE enabled = TRUE AND user_id IS NULL) AS "enabledKeysWithoutOwner"
      FROM api_key_members m
      LEFT JOIN api_keys ak ON ak.id = m.api_key_id
      LEFT JOIN users u ON u.id = m.user_id
    `)).rows[0]
      : { tableMissing: true };

    // These checks emit aggregate counts only; prompt text and key material never leave SQL.
    for (const [section, tables] of Object.entries(NEW_CHECK_TABLES)) {
      activeCheck = section;
      const missingTables = tables.filter(name => schemaShape.optionalMissing.includes(name));
      if (missingTables.length) {
        report.checks[section] = { tableMissing: true, missingTables };
        continue;
      }
      let sql;
      let params = [];
      if (section === 'apiKeyQueues' || section === 'apiKeyHarness') {
        const harness = section === 'apiKeyHarness';
        const table = harness ? 'api_key_harness_models' : 'api_key_models';
        const uniqueColumn = harness ? 'harness' : 'model_id';
        sql = `SELECT count(*)::int AS total,
          count(*) FILTER(WHERE k.id IS NULL)::int AS "orphanKeys",
          count(*) FILTER(WHERE m.id IS NULL)::int AS "orphanModels",
          (SELECT count(*)::int FROM (SELECT api_key_id, ${uniqueColumn} FROM public.${table}
            GROUP BY api_key_id, ${uniqueColumn} HAVING count(*) > 1) d) AS "duplicateBindings"
          ${harness ? ', count(*) FILTER(WHERE q.harness IS NULL OR NOT (q.harness = ANY($1::text[])))::int AS "invalidHarnesses"' : ''}
          FROM public.${table} q LEFT JOIN public.api_keys k ON k.id=q.api_key_id
          LEFT JOIN public.models m ON m.id=q.model_id`;
        if (harness) params = [HARNESS_SOURCES];
      } else if (section === 'promptRecords') {
        // NULL owners remain compatible with legacy global prompts.
        sql = `SELECT count(*)::int AS total,
          count(*) FILTER(WHERE p.user_id IS NOT NULL AND u.id IS NULL)::int AS "orphanOwners"
          FROM public.inject_prompts p LEFT JOIN public.users u ON u.id=p.user_id`;
      } else {
        sql = `SELECT count(*)::int AS total,
          count(*) FILTER(WHERE p.id IS NULL OR k.id IS NULL)::int AS "orphanBindings",
          count(*) FILTER(WHERE p.id IS NOT NULL AND k.id IS NOT NULL AND p.user_id IS NOT NULL
            AND p.user_id IS DISTINCT FROM k.user_id)::int AS "crossOwnerBindings",
          (SELECT count(*)::int FROM (SELECT prompt_id, api_key_id FROM public.inject_prompt_key_bindings
            GROUP BY prompt_id, api_key_id HAVING count(*) > 1) d) AS "duplicateBindings"
          FROM public.inject_prompt_key_bindings b LEFT JOIN public.inject_prompts p ON p.id=b.prompt_id
          LEFT JOIN public.api_keys k ON k.id=b.api_key_id`;
      }
      const result = await client.query(sql, params);
      if (result.rows.length !== 1) throw Object.assign(new Error('invalid aggregate result'), { code: 'AUDIT_RESULT_SHAPE' });
      report.checks[section] = { ...result.rows[0], tableMissing: false, missingTables: [] };
    }

    activeCheck = 'catalog';
    report.checks.catalog = (await client.query(`
      SELECT count(*) FILTER(WHERE NOT i.indisvalid)::int AS "invalidIndexes",
             count(*) FILTER(WHERE NOT i.indisready)::int AS "notReadyIndexes",
             (SELECT count(*)::int FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated) AS "unvalidatedConstraints"
      FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
    `)).rows[0];

    activeCheck = 'database hooks and role';
    const databaseHooks = (await client.query(`
      SELECT n.nspname AS "schemaName", c.relname AS "tableName", t.tgname AS "triggerName",
             fn.nspname AS "functionSchema", p.proname AS "functionName", l.lanname AS "languageName",
             p.prosecdef AS "securityDefiner", pg_get_userbyid(p.proowner) AS "functionOwner",
             t.tgenabled AS enabled, t.tgtype::int AS "triggerType", t.tgnargs::int AS "argumentCount",
             (t.tgqual IS NOT NULL) AS "hasCondition", (t.tgconstraint <> 0) AS "isConstraint",
             (p.proconfig IS NOT NULL) AS "hasFunctionSettings", p.prosrc AS "functionSource"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid
      JOIN pg_namespace fn ON fn.oid=p.pronamespace
      JOIN pg_language l ON l.oid=p.prolang
      WHERE NOT t.tgisinternal AND n.nspname='public'
      ORDER BY c.relname,t.tgname
    `)).rows;
    const expectedSource = databaseHooks.length ? expectedQuotaFunctionSource() : null;
    report.checks.databaseHooks = databaseHooks.map(({ functionSource, ...hook }) => ({
      ...hook,
      functionSourceSha256: sha256(functionSource),
      functionSourceMatchesRepository: typeof functionSource === 'string'
        && functionSource.replace(/\r\n/g, '\n').trim() === expectedSource,
    }));
    report.checks.databaseEventTriggers = (await client.query(`
      SELECT evtname AS name, evtevent AS event, evtenabled AS enabled,
             pg_get_userbyid(evtowner) AS owner
      FROM pg_event_trigger ORDER BY evtname
    `)).rows;
    report.checks.databaseRole = (await client.query(`
      SELECT rolname AS name, rolsuper AS superuser, rolcreaterole AS "createRole",
             rolcreatedb AS "createDatabase", rolreplication AS replication,
             rolbypassrls AS "bypassRls",
             has_schema_privilege(current_user, 'public', 'CREATE') AS "publicSchemaCreate"
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
      SELECT ip_address AS source,action,count(*)::int AS count,min(created_at) AS "firstSeen",max(created_at) AS "lastSeen",
             array_agg(DISTINCT substring(description FROM '创建供应商「([^」]{1,100})」'))
               FILTER(WHERE description ILIKE '%artex%' AND description ILIKE '%创建供应商%') AS "artexNames"
      FROM operation_logs
      WHERE created_at >= TIMESTAMPTZ '2026-10-18 00:00:00+08'
        AND created_at < TIMESTAMPTZ '2026-10-22 00:00:00+08'
        AND action IN ('auth.login_2fa','admin.provider_create','admin.provider_delete','admin.provider_update')
      GROUP BY ip_address,action ORDER BY "firstSeen"
    `)).rows;

    await client.query('ROLLBACK');
    const invalidFields = invalidCheckFields(report.checks);
    report.complete = invalidFields.length === 0;
    if (invalidFields.length) report.incompleteCheckFields = invalidFields;
    return report;
  } catch (error) {
    error.activeCheck = activeCheck;
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  audit().then(report => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = auditExitCode(report);
  }).catch(error => {
    // Deliberately omit error text and connection diagnostics that could expose config values.
    process.stderr.write(`Security audit failed (${error.activeCheck || 'database query'}): ${error.code || error.name || 'unknown error'}\n`);
    process.exitCode = 2;
  });
}

module.exports = { audit, auditExitCode };
