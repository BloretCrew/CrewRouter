'use strict';

// Creates a new temporary PostgreSQL cluster with TCP disabled. No application
// config or CR_DB_*/PG* connection environment is used. The cluster is stopped
// and its own generated directory removed before this process exits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const { sha256Hex } = require('../utils/key-hash');

function executable(name) {
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), '/usr/bin', '/usr/pgsql-18/bin', '/usr/pgsql-17/bin', '/usr/pgsql-16/bin', '/usr/pgsql-15/bin', '/usr/pgsql-14/bin'];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  throw new Error(`Isolated PostgreSQL test requires ${name}`);
}

function createCluster() {
  const initdb = executable('initdb');
  const pgctl = executable('pg_ctl');
  const root = fs.mkdtempSync('/tmp/cr-oauth-revoke-');
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  fs.mkdirSync(socket, { mode: 0o700 });
  const asRoot = process.getuid?.() === 0;
  let runuser;
  if (asRoot) {
    runuser = executable('runuser');
    const uid = Number(execFileSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).trim());
    const gid = Number(execFileSync('id', ['-g', 'postgres'], { encoding: 'utf8' }).trim());
    fs.chownSync(root, uid, gid); fs.chownSync(socket, uid, gid);
  }
  const cleanEnv = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' };
  const run = (command, args) => execFileSync(asRoot ? runuser : command,
    asRoot ? ['-u', 'postgres', '--', command, ...args] : args,
    { cwd: root, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  let started = false;
  try {
    run(initdb, ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']);
    // root/socket are generated ASCII paths; no user-supplied path is inserted
    // into pg_ctl's server option string.
    started = true;
    run(pgctl, ['-D', data, '-l', path.join(root, 'postgres.log'), '-w', '-t', '15', 'start', '-o',
      `-p 54327 -k '${socket}' -h '' -c shared_preload_libraries='' -c session_preload_libraries='' -c local_preload_libraries='' -c max_connections=12 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`]);
  } catch (error) {
    if (started && fs.existsSync(path.join(data, 'postmaster.pid'))) run(pgctl, ['-D', data, '-m', 'immediate', '-w', 'stop']);
    if (!fs.existsSync(path.join(data, 'postmaster.pid'))) fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    data, socket,
    connection: { host: socket, port: 54327, user: 'postgres', database: 'postgres', password: 'isolated-test-only', ssl: false, connectionTimeoutMillis: 5000, application_name: 'crewrouter-isolated-oauth-revocation-test' },
    stop() {
      run(pgctl, ['-D', data, '-m', 'immediate', '-w', '-t', '15', 'stop']);
      assert.equal(fs.existsSync(path.join(data, 'postmaster.pid')), false, 'confirm the temporary server stopped before cleanup');
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false);
    },
  };
}

function loadOAuth(pool) {
  const routes = new Map();
  const logs = [];
  const router = {
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
  };
  const file = path.resolve(__dirname, '../routes/oauth.js');
  const mocks = {
    express: { Router: () => router },
    '../models/database': { pool },
    '../config-loader': {},
    '../logger': { info() {}, warn(message) { logs.push(message); }, error(message) { logs.push(message); } },
    '../middleware/auth': { requireAuth(_req, _res, next) { next(); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\ntablesReady = true; module.exports._test = { revokeChain, issueTokenPair, lockTokenPrincipal, handleRefreshTokenGrant, MAX_REVOKE_TOKEN_ROWS };', {
    module, exports: module.exports, Buffer, __dirname: path.dirname(file), process: { env: {} },
    require: name => mocks[name] || (name.startsWith('.') ? require(path.resolve(path.dirname(file), name)) : require(name)),
  }, { filename: file });
  return {
    ...module.exports._test, logs,
    async request(route, body, userId = 1) {
      const handlers = routes.get(`POST ${route}`);
      assert(handlers, route);
      const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
      await handlers.at(-1)({ body, session: { user: { id: userId, username: 'offline-user' } } }, response);
      return response;
    },
  };
}

async function waitForLock(pool, pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected isolated revocation to wait for the principal advisory lock');
}

async function main() {
  const cluster = createCluster();
  const pool = new Pool({ ...cluster.connection, max: 4 });
  const single = new Pool({ ...cluster.connection, max: 1 });
  let queryCount = 0;
  let onPrincipalLock;
  const instrumented = {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return {
        query(...args) {
          queryCount++;
          if (String(args[0]).includes("hashtext('crewrouter-oauth-token-principal')")) onPrincipalLock?.(client.processID);
          return client.query(...args);
        },
        release() { client.release(); },
      };
    },
  };
  const oauth = loadOAuth(instrumented);
  const singleOAuth = loadOAuth(single);
  try {
    assert.equal((await pool.query('SHOW data_directory')).rows[0].data_directory, cluster.data);
    assert.equal((await pool.query('SHOW listen_addresses')).rows[0].listen_addresses, '');
    assert.equal((await pool.query('SHOW unix_socket_directories')).rows[0].unix_socket_directories, cluster.socket);
    await pool.query(`CREATE TABLE oauth_tokens (
      id BIGSERIAL PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL, api_key_id INTEGER, client_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'events:report', kind TEXT NOT NULL DEFAULT 'refresh',
      expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 day',
      revoked BOOLEAN NOT NULL DEFAULT FALSE, rotated_from BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ
    )`);
    await pool.query('CREATE INDEX idx_test_rotated_from ON oauth_tokens(rotated_from)');
    const reset = () => pool.query('TRUNCATE oauth_tokens RESTART IDENTITY');
    async function insert(id, parent = null, user = 1, client = 'a', kind = 'refresh') {
      await pool.query('INSERT INTO oauth_tokens(id, token_hash, user_id, client_id, kind, rotated_from) VALUES ($1,$2,$3,$4,$5,$6)', [id, `fixture-${id}`, user, client, kind, parent]);
    }
    const get = async id => (await pool.query('SELECT * FROM oauth_tokens WHERE id = $1', [id])).rows[0];
    const countRevoked = async () => Number((await pool.query('SELECT count(*) AS count FROM oauth_tokens WHERE revoked')).rows[0].count);

    await insert(1); await insert(2, 1); await insert(3, 1, 1, 'a', 'access'); await insert(4, 2, 1, 'a', 'access'); await insert(20);
    const basic = await oauth.revokeChain(await get(4));
    assert.equal(Number(basic.revoked_count), 4); assert.deepEqual([...basic.root_ids], ['1']);
    assert.equal((await get(20)).revoked, false, 'another authorization for the same principal remains live');

    await reset();
    await pool.query(`INSERT INTO oauth_tokens(id,token_hash,user_id,client_id,rotated_from)
      SELECT i, 'chain-' || i, 1, 'a', CASE WHEN i=1 THEN NULL ELSE i-1 END FROM generate_series(1,67) i`);
    await insert(10001, 1, 1, 'a', 'access');
    const beforeQueries = queryCount;
    const long = await oauth.revokeChain(await get(67));
    assert.equal(Number(long.revoked_count), 68); assert.equal((await get(10001)).revoked, true);
    assert.deepEqual([...long.root_ids], ['1']);
    assert(queryCount - beforeQueries <= 6, 'ancestor depth must not cause one network round-trip per ancestor');

    await reset();
    await insert(1, 3); await insert(2, 1); await insert(3, 2); await insert(4, 1, 1, 'a', 'access'); await insert(5, 3, 1, 'a', 'access'); await insert(20);
    const cycle = await oauth.revokeChain(await get(2));
    assert.equal(Number(cycle.revoked_count), 5); assert.equal(cycle.root_ids.length, 0);
    assert.equal((await get(20)).revoked, false);

    await reset();
    await insert(1); await insert(2, 1); await insert(3, 2, 1, 'a', 'access');
    await insert(10, 1, 2); await insert(11, 10, 2);
    await insert(12, 1, 1, 'b'); await insert(13, 12, 1, 'b');
    await insert(20); await insert(21, 20); await insert(30, 10); await insert(40, 12);
    assert.equal(Number((await oauth.revokeChain(await get(1))).revoked_count), 3);
    for (const id of [10, 11, 12, 13, 20, 21, 30, 40]) assert.equal((await get(id)).revoked, false, `foreign or unrelated row ${id}`);
    assert.equal(Number((await oauth.revokeChain(await get(30))).revoked_count), 1, 'foreign parent stops traversal');
    assert.equal((await get(10)).revoked, false);
    assert.equal(Number((await oauth.revokeChain({ id: 10, user_id: 1, client_id: 'a' })).revoked_count), 0, 'anchor ownership must match');

    await reset(); await insert(1, 999999); await insert(2, 1, 1, 'a', 'access');
    assert.equal(Number((await oauth.revokeChain(await get(2))).revoked_count), 2, 'orphan component stays within known related rows');

    await reset();
    await pool.query(`INSERT INTO oauth_tokens(id,token_hash,user_id,client_id,rotated_from)
      SELECT i, 'depth-' || i, 1, 'a', CASE WHEN i=1 THEN NULL ELSE i-1 END FROM generate_series(1,$1::int) i`, [oauth.MAX_REVOKE_TOKEN_ROWS + 1]);
    await assert.rejects(oauth.revokeChain(await get(oauth.MAX_REVOKE_TOKEN_ROWS + 1)), error => error.code === 'OAUTH_REVOKE_LIMIT');
    assert.equal(await countRevoked(), 0, 'ancestor cap must roll back without partial revocation');

    await reset(); await insert(1);
    await pool.query(`INSERT INTO oauth_tokens(id,token_hash,user_id,client_id,rotated_from)
      SELECT i, 'fanout-' || i, 1, 'a', 1 FROM generate_series(2,$1::int) i`, [oauth.MAX_REVOKE_TOKEN_ROWS + 1]);
    await pool.query('UPDATE oauth_tokens SET token_hash=$1 WHERE id=1', [sha256Hex('offline-root-token')]);
    await assert.rejects(oauth.revokeChain(await get(1)), error => error.code === 'OAUTH_REVOKE_LIMIT');
    assert.equal(await countRevoked(), 0, 'descendant cap must not partially revoke');
    assert.equal((await oauth.request('/oauth/revoke', { token: 'offline-root-token' })).statusCode, 503);
    assert.equal((await oauth.request('/oauth/revoke', { token: 'unknown-token' })).statusCode, 200);
    assert.equal((await oauth.request('/oauth/authorizations/revoke', { id: 1 })).statusCode, 503);
    assert.equal((await oauth.request('/oauth/authorizations/revoke', { id: 1 }, 2)).statusCode, 404);
    assert.equal((await singleOAuth.request('/oauth/token', { grant_type: 'refresh_token', refresh_token: 'offline-root-token', client_id: 'a' })).statusCode, 503, 'replay failure must use the existing connection and report failure even with pool.max=1');
    assert.equal(await countRevoked(), 0);

    await reset();
    await pool.query("ALTER TABLE oauth_tokens ADD CONSTRAINT test_reject_access CHECK (kind <> 'access')");
    await assert.rejects(oauth.issueTokenPair('a', 1, null, 'events:report'));
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM oauth_tokens')).rows[0].count), 0, 'pair creation rolls back its refresh if access insertion fails');
    await pool.query('ALTER TABLE oauth_tokens DROP CONSTRAINT test_reject_access');
    const pair = await oauth.issueTokenPair('a', 1, null, 'events:report');
    const refresh = (await pool.query('SELECT * FROM oauth_tokens WHERE token_hash=$1', [sha256Hex(pair.refreshToken)])).rows[0];
    assert.equal((await singleOAuth.request('/oauth/token', { grant_type: 'refresh_token', refresh_token: pair.refreshToken, client_id: 'a' })).statusCode, 200);
    assert.equal((await singleOAuth.request('/oauth/token', { grant_type: 'refresh_token', refresh_token: pair.refreshToken, client_id: 'a' })).statusCode, 400);
    assert.equal(await countRevoked(), 4, 'normal reuse revokes both generations including root access');

    await reset(); await insert(1); await insert(2, 1, 1, 'a', 'access');
    const blocker = await pool.connect();
    let revocation;
    try {
      await blocker.query('BEGIN');
      await oauth.lockTokenPrincipal(blocker, 1, 'a');
      // A legitimate rotation inserts these descendants while holding the same
      // lock. Revocation must take its snapshot after this transaction commits.
      await blocker.query("INSERT INTO oauth_tokens(id,token_hash,user_id,client_id,rotated_from) VALUES (3,'race-refresh',1,'a',1),(4,'race-access',1,'a',3)");
      let observeLock;
      const locking = new Promise(resolve => { observeLock = resolve; });
      onPrincipalLock = pid => observeLock(pid);
      revocation = oauth.revokeChain(await get(1));
      const pid = await locking;
      await waitForLock(pool, pid);
      await blocker.query('COMMIT');
      assert.equal(Number((await revocation).revoked_count), 4);
      assert.equal((await get(4)).revoked, true, 'child committed by the earlier rotation must not escape revocation');
    } finally {
      onPrincipalLock = null;
      await blocker.query('ROLLBACK').catch(() => {});
      blocker.release();
      if (revocation) await revocation.catch(() => {});
    }
    await reset(); await insert(1);
    await pool.query('UPDATE oauth_tokens SET token_hash=$1 WHERE id=1', [sha256Hex('timeout-root-token')]);
    const timeoutBlocker = await pool.connect();
    try {
      await timeoutBlocker.query('BEGIN');
      await oauth.lockTokenPrincipal(timeoutBlocker, 1, 'a');
      const timedOut = await oauth.request('/oauth/revoke', { token: 'timeout-root-token' });
      assert.equal(timedOut.statusCode, 503, 'a real PostgreSQL statement timeout must not be reported as successful revocation');
      assert.equal(await countRevoked(), 0);
    } finally {
      await timeoutBlocker.query('ROLLBACK').catch(() => {});
      timeoutBlocker.release();
    }
    assert.equal(refresh.user_id, 1);
    assert(!require.cache[require.resolve('../models/database')], 'never load the application database configuration');
    assert(!require.cache[require.resolve('../logger')], 'never write application logs');
    console.log('OAuth revocation: normal/67-generation/cyclic/bounded/principal-scoped/transactional/concurrent/timeout checks passed against a fresh Unix-only PostgreSQL cluster');
  } finally {
    await Promise.all([pool.end(), single.end()]);
    cluster.stop();
  }
  console.log('Temporary PostgreSQL stopped, PID file absent, generated test directory removed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
