'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

// Importing this module must not read a real config or start its CLI.
const previousConfigPath = process.env.CR_CONFIG_PATH;
process.env.CR_CONFIG_PATH = '/nonexistent-security-audit-offline-config.json';
const { audit, auditExitCode } = require('./security-audit');
if (previousConfigPath === undefined) delete process.env.CR_CONFIG_PATH;
else process.env.CR_CONFIG_PATH = previousConfigPath;

function cleanChecks() {
  return {
    providerModelIntegrity: { modelsWithoutProvider: 0 },
    teamConsistency: { primaryMembershipMismatches: 0, multipleMemberships: 1, orphanMemberships: 0, orphanTeamModels: 0, duplicateTeamNames: 0, usersWithoutMembership: 0 },
    identities: { emptyUsernames: 0, emptyEmails: 1, administratorAccounts: 1, duplicateUsernames: 0, duplicateEmails: 0, duplicateGitHubIds: 0, duplicateFeishuOpenIds: 0, duplicatePassportUsernames: 0, blankExternalIdentities: 0 },
    sessions: { activeSessions: 0, expiredSessions: 0, enabledUserApiKeys: 0, recoverableEnabledUserApiKeys: 0 },
    balances: { negativeBalances: 0, negativeRefundBalances: 0, negativeCodeBalanceAmounts: 0, negativeCodeBalanceFeeRates: 0, refundDetailMismatches: 0, orphanCodeBalances: 0, regularBalanceTotal: '0.0000', refundBalanceTotal: '0.0000' },
    balancePreconsumes: { pendingCount: 0, stalePendingCount: 0, incompleteSettlementCount: 0, unknownStatusCount: 0, negativeAmountCount: 0 },
    redemptionCodes: { usedCountMismatches: 0, codesOverUseLimit: 0, invalidCodeValues: 0, orphanCreators: 0 },
    apiKeyMemberships: { orphanMemberships: 0, ownerAlsoMemberCount: 0, orphanOwners: 0, enabledKeysWithoutOwner: 0 },
    catalog: { invalidIndexes: 0, notReadyIndexes: 0, unvalidatedConstraints: 0 },
    databaseRole: { name: 'offline-auditor', superuser: false, createRole: false, createDatabase: false, replication: false, bypassRls: false, publicSchemaCreate: false },
  };
}

function fixture({ shapes = {}, missing = [], tablePresence = {}, readOnly = true, checks = cleanChecks(), hooks = [], failBusinessReads = false } = {}) {
  const calls = [];
  const result = rows => ({ rows, rowCount: rows.length });
  const client = {
    connected: false,
    closed: false,
    async connect() { this.connected = true; },
    async end() { this.closed = true; },
    async query(statement, params) {
      const sql = statement.replace(/\s+/g, ' ').trim();
      calls.push(sql);
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL ')) return result([]);
      if (sql.includes("current_setting('transaction_read_only')")) return result([{ active: readOnly }]);
      if (sql.includes('FROM unnest($1::text[])')) return result(params[0].map(name => ({ name, relkind: missing.includes(name) ? null : 'r', rowSecurityEnabled: false, ...shapes[name] })));
      if (failBusinessReads) assert.fail(`Preflight must stop before business reads: ${sql}`);
      if (sql.startsWith('SELECT to_regclass')) {
        const name = params[0].replace(/^public\./, '');
        return result([{ present: Object.hasOwn(tablePresence, name) ? tablePresence[name] : !missing.includes(name) }]);
      }
      if (sql.includes('pg_stat_activity')) return result([{ name: 'offline', bytes: '0', connections: 1 }]);
      if (sql.includes('FROM public.providers ORDER BY')) return result([]);
      if (sql.includes("api_key NOT LIKE 'aesgcm:%'")) return result([{ n: 0 }]);
      if (sql.includes('AS "modelsWithoutProvider"')) return result([checks.providerModelIntegrity]);
      if (sql.includes('FROM public.plugins ORDER BY')) return result([]);
      if (sql.includes('AS "primaryMembershipMismatches"')) return result([checks.teamConsistency]);
      if (sql.includes('AS "emptyUsernames"')) return result([checks.identities]);
      if (sql.includes('FROM user_sessions')) return result([checks.sessions]);
      if (sql.includes("WHERE action = 'admin.user_refund'")) return result([]);
      if (sql.includes('AS "negativeBalances"')) return result([checks.balances]);
      if (sql.includes('AS "stalePendingCount"')) return result([checks.balancePreconsumes]);
      if (sql.includes('AS "usedCountMismatches"')) return result([checks.redemptionCodes]);
      if (sql.includes('AS "ownerAlsoMemberCount"')) return result([checks.apiKeyMemberships]);
      if (sql.includes('AS "invalidIndexes"')) return result([checks.catalog]);
      if (sql.includes('FROM pg_trigger t')) return result(hooks);
      if (sql.includes('FROM pg_event_trigger')) return result([]);
      if (sql.includes('FROM pg_roles')) return result([checks.databaseRole]);
      if (sql.includes('JOIN pg_sequence')) return result([]);
      if (sql.includes('GROUP BY ip_address,action')) return result([]);
      assert.fail(`Unexpected query in offline fixture: ${sql}`);
    },
  };
  return { client, calls, run: () => audit({ client, configPath: '/nonexistent-security-audit-offline-config.json' }) };
}

const baselineSource = fs.readFileSync(path.join(__dirname, '../utils/quota-cycle-analysis.js'), 'utf8')
  .match(/CREATE OR REPLACE FUNCTION quota_cycle_attempt_changed\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$/)[1];

function expectedTrigger(overrides = {}) {
  return {
    schemaName: 'public', tableName: 'request_attempts', triggerName: 'quota_cycle_attempt_changed',
    functionSchema: 'public', functionName: 'quota_cycle_attempt_changed', languageName: 'plpgsql',
    securityDefiner: false, functionOwner: 'offline-auditor', enabled: 'O', triggerType: 21,
    argumentCount: 0, hasCondition: false, isConstraint: false, hasFunctionSettings: false,
    functionSource: baselineSource, ...overrides,
  };
}

test('RLS, replaced views, and missing required tables stop before any business read', async t => {
  for (const [name, options, field, expected] of [
    ['required table RLS', { shapes: { users: { rowSecurityEnabled: true } } }, 'rowSecurityEnabled', ['users']],
    ['optional table RLS', { shapes: { plugins: { rowSecurityEnabled: true } } }, 'rowSecurityEnabled', ['plugins']],
    ['replaced view', { shapes: { providers: { relkind: 'v' } } }, 'nonTableRelations', [{ name: 'providers', kind: 'v' }]],
    ['missing users', { missing: ['users'] }, 'missingRequired', ['users']],
  ]) {
    await t.test(name, async () => {
      const f = fixture({ ...options, failBusinessReads: true });
      const report = await f.run();
      assert.equal(report.readOnly, true);
      assert.equal(report.complete, false);
      assert.deepEqual(report.checks.schemaShape[field], expected);
      assert.equal(auditExitCode(report), 2);
      assert.equal(f.calls.at(-1), 'ROLLBACK');
      assert(f.client.closed);
    });
  }
});

test('a failed READ ONLY assertion closes the connection and performs no business read', async () => {
  const f = fixture({ readOnly: false, failBusinessReads: true });
  await assert.rejects(f.run(), /did not enter READ ONLY/);
  assert(f.client.closed);
  assert.equal(f.calls.length, 2);
});

test('missing schema and table-presence result aliases fail closed', async () => {
  const schema = fixture({ shapes: { users: { rowSecurityEnabled: undefined, relrowsecurity: true } }, failBusinessReads: true });
  await assert.rejects(schema.run(), { code: 'AUDIT_RESULT_SHAPE', activeCheck: 'schema preflight' });
  assert(schema.client.closed);
  const presence = fixture({ tablePresence: { plugins: undefined } });
  await assert.rejects(presence.run(), { code: 'AUDIT_RESULT_SHAPE', activeCheck: 'plugins' });
  assert(presence.client.closed);
});

test('complete clean snapshot keeps legal empty emails and multiple Team memberships informational', async () => {
  const f = fixture();
  const report = await f.run();
  assert.equal(report.complete, true);
  assert.equal(report.readOnly, true);
  assert.equal(auditExitCode(report), 0);
  assert.equal(report.checks.identities.emptyEmails, 1);
  assert.equal(report.checks.teamConsistency.multipleMemberships, 1);
  assert.equal(f.calls.at(-1), 'ROLLBACK');
  assert(f.client.closed);
  assert(f.calls.every(sql => /^(SELECT|BEGIN|SET LOCAL|ROLLBACK)\b/.test(sql)));
});

test('duplicate and blank external identity bindings affect the exit code without emitting identity values', async t => {
  for (const field of ['duplicateGitHubIds', 'duplicateFeishuOpenIds', 'duplicatePassportUsernames', 'blankExternalIdentities']) {
    await t.test(field, async () => {
      const checks = cleanChecks();
      checks.identities[field] = 1;
      const report = await fixture({ checks }).run();
      assert.equal(report.complete, true);
      assert.equal(report.checks.identities[field], 1);
      assert.equal(auditExitCode(report), 1);
      assert(!Object.hasOwn(report.checks.identities, 'github_id'));
    });
  }
});

test('missing or incorrectly aliased critical query results cannot produce a clean or complete report', async t => {
  for (const [section, field] of [['databaseRole', 'publicSchemaCreate'], ['identities', 'duplicateGitHubIds'], ['balances', 'refundDetailMismatches']]) {
    await t.test(`${section}.${field}`, async () => {
      const checks = cleanChecks();
      checks[section][field.toLowerCase()] = checks[section][field];
      delete checks[section][field];
      const report = await fixture({ checks }).run();
      assert.equal(report.complete, false);
      assert(report.incompleteCheckFields.includes(`${section}.${field}`));
      assert.equal(auditExitCode(report), 2);
    });
  }
});

test('missing optional tables are findings rather than a clean result', async () => {
  const report = await fixture({ missing: ['plugins', 'balance_preconsumes', 'redemption_code_uses', 'api_key_members'] }).run();
  assert.equal(report.complete, true);
  assert.equal(auditExitCode(report), 1);
  for (const name of ['plugins', 'balancePreconsumes', 'redemptionCodes', 'apiKeyMemberships']) assert.equal(report.checks[name].tableMissing, true);
});

test('approved trigger names require matching table, function, execution settings and repository body', async t => {
  const baseline = await fixture({ hooks: [expectedTrigger(), expectedTrigger({ triggerName: 'quota_cycle_sample_changed', tableName: 'request_quota_samples' })] }).run();
  assert.equal(auditExitCode(baseline), 0);
  assert.equal(baseline.checks.databaseHooks[0].functionSourceMatchesRepository, true);
  assert.match(baseline.checks.databaseHooks[0].functionSourceSha256, /^[a-f0-9]{64}$/);
  assert(!Object.hasOwn(baseline.checks.databaseHooks[0], 'functionSource'));
  for (const [name, changed] of [
    ['wrong table', { tableName: 'users' }],
    ['wrong function schema', { functionSchema: 'attacker' }],
    ['wrong function', { functionName: 'replacement' }],
    ['security definer', { securityDefiner: true }],
    ['disabled trigger', { enabled: 'D' }],
    ['different events', { triggerType: 29 }],
    ['trigger arguments', { argumentCount: 1 }],
    ['conditional execution', { hasCondition: true }],
    ['constraint trigger', { isConstraint: true }],
    ['function configuration override', { hasFunctionSettings: true }],
    ['changed body', { functionSource: baselineSource.replace('RETURN NEW;', 'PERFORM pg_sleep(300); -- hidden-payload-do-not-emit\n        RETURN NEW;') }],
  ]) {
    await t.test(name, async () => {
      const report = await fixture({ hooks: [expectedTrigger(changed)] }).run();
      assert.equal(report.complete, true);
      assert.equal(auditExitCode(report), 1);
      assert(!JSON.stringify(report).includes('hidden-payload-do-not-emit'));
    });
  }
});

test('role privileges remain findings and missing read-only proof is incomplete', async () => {
  const checks = cleanChecks();
  checks.databaseRole.publicSchemaCreate = true;
  const report = await fixture({ checks }).run();
  assert.equal(auditExitCode(report), 1);
  assert.equal(auditExitCode({ ...report, readOnly: false }), 2);
  assert.equal(auditExitCode({ ...report, complete: false }), 2);
});
