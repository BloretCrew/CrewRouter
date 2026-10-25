'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { Client } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');

test('public CREATE review and authorized revocation execute only against a fresh private PostgreSQL cluster', async context => {
  const cluster = createIsolatedPostgres('public-create');
  const client = new Client(cluster.connection);
  const applicationRole = 'cr runtime "quoted';
  const identifier = `"${applicationRole.replaceAll('"', '""')}"`;
  const script = path.resolve(__dirname, '../../audit/review-public-schema-create.sql');
  const auditSource = fs.readFileSync(path.join(__dirname, 'security-audit.js'), 'utf8');
  const roleQuery = auditSource.match(/report\.checks\.databaseRole = \(await client.query\(`([\s\S]*?)`\)\)\.rows\[0\]/)?.[1];
  assert(roleQuery);

  function run(parameters = {}, username = 'postgres') {
    const result = spawnSync('psql', ['--no-psqlrc', '--no-password', '--host', cluster.socketDir,
      '--port', String(cluster.connection.port), '--username', username, '--dbname', 'postgres',
      '--file', script, ...Object.entries({ expected_database: 'postgres', application_role: applicationRole,
        ...parameters }).filter(([, value]) => value !== null).flatMap(([name, value]) => ['--set', `${name}=${value}`])], {
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PGPASSWORD: 'isolated-test-only' }, encoding: 'utf8', timeout: 15000,
    });
    assert(!result.error, result.error?.message);
    return result;
  }

  const apply = { apply: 'true', authorization: 'REVOKE_PUBLIC_CREATE', commit: 'true' };
  async function state() {
    return (await client.query(`SELECT nspacl::text AS acl, nspowner::regrole::text AS owner,
      has_schema_privilege($1, 'public', 'CREATE') AS create FROM pg_namespace WHERE nspname='public'`, [applicationRole])).rows[0];
  }
  async function roleFlags() {
    await client.query(`SET ROLE ${identifier}`);
    try { return (await client.query(roleQuery)).rows[0]; }
    finally { await client.query('RESET ROLE'); }
  }

  try {
    await client.connect();
    await cluster.assertIsolation(client);
    await client.query(`CREATE ROLE ${identifier} LOGIN NOINHERIT;
      CREATE ROLE cr_ddl_group NOLOGIN;
      CREATE ROLE cr_unrelated LOGIN;
      GRANT CREATE, USAGE ON SCHEMA public TO PUBLIC;
      GRANT CREATE ON SCHEMA public TO ${identifier};
      CREATE TABLE public.runtime_probe(id SERIAL PRIMARY KEY, value TEXT);
      GRANT SELECT, INSERT ON public.runtime_probe TO ${identifier};
      GRANT USAGE ON SEQUENCE public.runtime_probe_id_seq TO ${identifier};
      GRANT SELECT ON public.runtime_probe TO cr_unrelated`);

    await context.test('default inspection is READ ONLY and exact ACL remains unchanged', async () => {
      const before = await state();
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /READ ONLY: inspected/);
      assert.match(result.stdout, /\bon\b/);
      assert.deepEqual(await state(), before);
    });
    await context.test('missing human authorization, wrong database and SQL-looking role names fail without changes', async () => {
      const before = await state();
      for (const parameters of [{ expected_database: null }, { application_role: null },
        { apply: 'true' }, { ...apply, authorization: 'not-authorized' },
        { ...apply, expected_database: 'wrong_database' },
        { ...apply, application_role: `${applicationRole}'; CREATE ROLE injected_role; --` }]) {
        const result = run(parameters);
        assert.notEqual(result.status, 0, result.stdout);
        assert.deepEqual(await state(), before);
      }
      assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_roles WHERE rolname='injected_role'")).rows[0].count, 0);
    });
    await context.test('authorized preview executes revocation assertions but rolls back by default', async () => {
      const before = await state();
      const result = run({ apply: 'true', authorization: 'REVOKE_PUBLIC_CREATE' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PREVIEW ONLY/);
      assert.deepEqual(await state(), before);
    });
    await context.test('unprivileged operator cannot falsely report a committed remediation', async () => {
      const before = await state();
      const result = run(apply, applicationRole);
      assert.notEqual(result.status, 0);
      assert.deepEqual(await state(), before);
    });
    await context.test('membership CREATE without inheritance is reported and blocks partial revocation', async () => {
      await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC, ${identifier};
        GRANT CREATE ON SCHEMA public TO cr_ddl_group; GRANT cr_ddl_group TO ${identifier}`);
      const flags = await roleFlags();
      assert.equal(flags.publicSchemaCreate, false);
      assert.equal(flags.publicSchemaMemberCreate, true);
      await client.query(`GRANT CREATE ON SCHEMA public TO PUBLIC, ${identifier}`);
      const before = await state();
      const result = run(apply);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ownership or membership/);
      assert.deepEqual(await state(), before);
      await client.query(`REVOKE cr_ddl_group FROM ${identifier}`);
    });
    await context.test('schema owner remains dangerous even after revoking its ordinary CREATE ACL', async () => {
      await client.query(`ALTER SCHEMA public OWNER TO ${identifier};
        REVOKE CREATE ON SCHEMA public FROM PUBLIC, ${identifier}`);
      const flags = await roleFlags();
      assert.equal(flags.publicSchemaCreate, false);
      assert.equal(flags.publicSchemaOwner, true);
      const before = await state();
      const result = run(apply);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ownership/);
      assert.deepEqual(await state(), before);
      await client.query('ALTER SCHEMA public OWNER TO pg_database_owner');
    });
    await context.test('database ownership and elevated role attributes block automated scope expansion', async () => {
      await client.query(`ALTER DATABASE postgres OWNER TO ${identifier}`);
      assert.equal((await roleFlags()).databaseOwner, true);
      let result = run(apply);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /ownership/);
      await client.query('ALTER DATABASE postgres OWNER TO postgres');
      await client.query(`ALTER ROLE ${identifier} CREATEROLE`);
      const before = await state();
      result = run(apply);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /elevated role attributes/);
      assert.deepEqual(await state(), before);
      await client.query(`ALTER ROLE ${identifier} NOCREATEROLE`);
    });
    await context.test('committed revocation removes PUBLIC and direct CREATE, preserves USAGE and runtime DML, and is idempotent', async () => {
      await client.query(`GRANT CREATE ON SCHEMA public TO PUBLIC, ${identifier}`);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = run(apply);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /APPLIED:/);
        assert.equal((await state()).create, false);
      }
      const flags = await roleFlags();
      for (const field of ['publicSchemaCreate', 'publicSchemaMemberCreate', 'publicSchemaOwner', 'databaseOwner']) assert.equal(flags[field], false);
      assert.equal((await client.query("SELECT has_schema_privilege('cr_unrelated', 'public', 'CREATE') AS create")).rows[0].create, false);
      await client.query(`SET ROLE ${identifier}`);
      try {
        await assert.rejects(client.query('CREATE TABLE public.forbidden_probe(id INTEGER)'), { code: '42501' });
        await client.query("INSERT INTO public.runtime_probe(value) VALUES('isolated-data')");
        assert.equal((await client.query('SELECT * FROM public.runtime_probe')).rows.length, 1);
      } finally { await client.query('RESET ROLE'); }
      await client.query('SET ROLE cr_unrelated');
      try { assert.equal((await client.query('SELECT * FROM public.runtime_probe')).rows.length, 1); }
      finally { await client.query('RESET ROLE'); }
    });
  } finally {
    await client.end();
    cluster.stop();
    assert.equal(fs.existsSync(cluster.dataDir), false);
  }
});
