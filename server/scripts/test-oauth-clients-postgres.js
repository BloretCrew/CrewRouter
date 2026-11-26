'use strict';

// Isolated PostgreSQL integration for the admin OAuth client routes.
// No application database, config or logger is loaded; the temporary cluster
// listens only on its own Unix socket and is removed before exit.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const oauthClients = require('../utils/oauth-clients');

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
  const root = fs.mkdtempSync('/tmp/cr-oauth-clients-');
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
    started = true;
    run(pgctl, ['-D', data, '-l', path.join(root, 'postgres.log'), '-w', '-t', '15', 'start', '-o',
      `-p 54328 -k '${socket}' -h '' -c shared_preload_libraries='' -c session_preload_libraries='' -c local_preload_libraries='' -c max_connections=12 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`]);
  } catch (error) {
    if (started && fs.existsSync(path.join(data, 'postmaster.pid'))) run(pgctl, ['-D', data, '-m', 'immediate', '-w', 'stop']);
    if (!fs.existsSync(path.join(data, 'postmaster.pid'))) fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    data, socket,
    connection: { host: socket, port: 54328, user: 'postgres', database: 'postgres', password: 'isolated-test-only', ssl: false, connectionTimeoutMillis: 5000, application_name: 'crewrouter-isolated-oauth-clients-test' },
    stop() {
      run(pgctl, ['-D', data, '-m', 'immediate', '-w', '-t', '15', 'stop']);
      assert.equal(fs.existsSync(path.join(data, 'postmaster.pid')), false, 'confirm the temporary server stopped before cleanup');
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false);
    },
  };
}

function createRouter() {
  const routes = new Map();
  const router = {
    use() {},
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
    put(route, ...handlers) { routes.set(`PUT ${route}`, handlers); },
    delete(route, ...handlers) { routes.set(`DELETE ${route}`, handlers); },
  };
  return { router, routes };
}

function loadOAuth(pool) {
  const { router, routes } = createRouter();
  const module = { exports: {} };
  const file = path.resolve(__dirname, '../routes/oauth.js');
  const mocks = {
    express: { Router: () => router },
    '../models/database': { pool },
    '../logger': { info() {}, warn() {}, error() {} },
    '../config-loader': { oauth: { issuer: 'https://router.example.test' } },
    '../middleware/auth': { requireAuth(req, res, next) { if (!req.session?.user) return res.status(401).json({ error: 'login_required' }); next(); } },
    '../middleware/csrf': {
      ensureCsrfToken(req) { req.session.csrfToken ||= 'test-csrf-token'; return req.session.csrfToken; },
      csrfProtection(req, res, next) {
        if (req.path !== '/oauth/device/authorize') return next();
        if (req.body?._csrf === req.session?.csrfToken && req.session?.csrfToken) return next();
        return res.status(403).json({ error: 'CSRF 校验失败', type: 'csrf_failed' });
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module,
    exports: module.exports,
    Buffer,
    URL,
    __dirname: path.dirname(file),
    process: { env: {} },
    require(name) {
      if (mocks[name]) return mocks[name];
      return name.startsWith('.') ? require(path.resolve(path.dirname(file), name)) : require(name);
    },
  }, { filename: file });
  return { ensureOAuthTables: module.exports.ensureOAuthTables, routes };
}

function loadAdmin(pool, ensureOAuthTables) {
  const { router, routes } = createRouter();
  const module = { exports: {} };
  const file = path.resolve(__dirname, '../routes/admin-oauth-clients.js');
  const mocks = {
    express: { Router: () => router },
    '../models/database': { pool },
    '../logger': { info() {}, warn() {}, error() {} },
    '../config-loader': { oauth: { clients: [] } },
    '../middleware/auth': { requireAuth(_req, _res, next) { next(); }, requireAdmin(_req, _res, next) { next(); } },
    '../utils/audit-log': { ACTIONS: { ADMIN_OAUTH_CLIENT: 'admin.oauth_client' }, logAction: async () => {} },
    '../utils/oauth-clients': oauthClients,
    './oauth': { ensureOAuthTables },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module,
    exports: module.exports,
    Buffer,
    URL,
    __dirname: path.dirname(file),
    process: { env: {} },
    require(name) {
      if (mocks[name]) return mocks[name];
      return name.startsWith('.') ? require(path.resolve(path.dirname(file), name)) : require(name);
    },
  }, { filename: file });
  return {
    routes,
    async call(method, route, { body = {}, params = {}, session = { user: { id: 1, username: 'admin' } } } = {}) {
      const handlers = routes.get(`${method} ${route}`);
      assert(handlers, `${method} ${route} is registered`);
      const response = {
        statusCode: 200,
        body: null,
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
      };
      await handlers.at(-1)({ body, params, session, headers: {}, ip: '127.0.0.1', get() { return ''; } }, response);
      return response;
    },
  };
}

function createOAuthCaller(routes) {
  return async function call(method, route, {
    query = {}, body = {}, headers = {}, session = { user: { id: 1, username: 'alice' } },
  } = {}) {
    const handlers = routes.get(`${method} ${route}`);
    assert(handlers, `${method} ${route} is registered`);
    const response = {
      statusCode: 200,
      body: null,
      headers: {},
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; return this; },
      send(value) { this.body = value; return this; },
      sendFile() { this.sentFile = true; return this; },
      set(name, value) { this.headers[name] = value; return this; },
      redirect(status, url) { this.statusCode = status; this.location = url; return this; },
    };
    const request = {
      query, body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, session, path: route, method: 'POST', ip: '127.0.0.1', baseUrl: '', originalUrl: route,
      get() { return ''; },
    };
    for (const middleware of handlers.slice(0, -1)) {
      let continued = false;
      await middleware(request, response, () => { continued = true; });
      if (response.statusCode >= 400) return response;
      if (!continued) return response;
    }
    await handlers.at(-1)(request, response);
    return response;
  };
}

async function main() {
  const cluster = createCluster();
  const pool = new Pool({ ...cluster.connection, max: 4 });
  try {
    assert.equal((await pool.query('SHOW data_directory')).rows[0].data_directory, cluster.data);
    assert.equal((await pool.query('SHOW listen_addresses')).rows[0].listen_addresses, '');
    assert.equal((await pool.query('SHOW unix_socket_directories')).rows[0].unix_socket_directories, cluster.socket);

    const oauth = loadOAuth(pool);
    const ensureOAuthTables = oauth.ensureOAuthTables;
    await ensureOAuthTables();
    await pool.query('CREATE TABLE api_keys (id SERIAL PRIMARY KEY, user_id INTEGER, enabled BOOLEAN, name TEXT)');
    await pool.query("INSERT INTO api_keys (id, user_id, enabled, name) VALUES (1, 1, TRUE, 'test')");
    const admin = loadAdmin(pool, ensureOAuthTables);
    const oauthCall = createOAuthCaller(oauth.routes);

    const metadataHandlers = oauth.routes.get('GET /.well-known/oauth-authorization-server');
    const metadataResponse = { statusCode: 200, headers: {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; }, set(name, value) { this.headers[name] = value; return this; } };
    metadataHandlers.at(-1)({ protocol: 'https', get() { return 'router.example.test'; } }, metadataResponse);
    assert.equal(metadataResponse.body.issuer, 'https://router.example.test');
    assert.equal(metadataResponse.body.device_authorization_endpoint, 'https://router.example.test/oauth/device/code');
    assert.ok(metadataResponse.body.grant_types_supported.includes('urn:ietf:params:oauth:grant-type:device_code'));

    const columns = (await pool.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'oauth_clients' ORDER BY ordinal_position
    `)).rows.map((row) => row.column_name);
    for (const column of ['client_type', 'redirect_uris', 'scopes', 'allow_loopback_any_path', 'secret_hash', 'secret_hint', 'description', 'enabled', 'updated_at']) {
      assert(columns.includes(column), `oauth_clients.${column} exists`);
    }
    const builtins = await pool.query("SELECT client_id FROM oauth_clients WHERE first_party = TRUE ORDER BY client_id");
    assert.deepEqual(builtins.rows.map((row) => row.client_id), ['crewrouter-cli', 'crewrouter-desktop', 'crewrouter-helper']);

    const publicCreate = await admin.call('POST', '/', {
      body: { name: 'Public App', type: 'public', scopes: ['gateway:invoke'], redirectUris: ['http://127.0.0.1/callback'] },
    });
    assert.equal(publicCreate.statusCode, 201);
    assert.equal(publicCreate.body.client.type, 'public');
    assert.equal(publicCreate.body.client.has_secret, false);
    assert.equal(publicCreate.body.client_secret, undefined);
    const publicId = publicCreate.body.client.client_id;

    const confidentialCreate = await admin.call('POST', '/', {
      body: {
        name: 'Confidential App', type: 'confidential', scopes: ['gateway:invoke', 'events:report'],
        redirectUris: ['https://app.example.com/callback'], description: 'server app',
      },
    });
    assert.equal(confidentialCreate.statusCode, 201);
    const confidentialId = confidentialCreate.body.client.client_id;
    const secret = confidentialCreate.body.client_secret;
    assert.match(secret, /^crs_/);
    const stored = (await pool.query('SELECT * FROM oauth_clients WHERE client_id = $1', [confidentialId])).rows[0];
    assert.equal(stored.secret_hash, oauthClients.sha256Hex(secret));
    assert.equal(stored.secret_hint, secret.slice(0, 6));
    assert.equal(stored.description, 'server app');

    const list = await admin.call('GET', '/');
    assert.equal(list.statusCode, 200);
    const listed = new Map(list.body.clients.map((client) => [client.client_id, client]));
    assert.equal(listed.get('crewrouter-desktop').source, 'builtin');
    assert.equal(listed.get('crewrouter-desktop').editable, false);
    assert.equal(listed.get(publicId).editable, true);
    assert.equal(listed.get(confidentialId).has_secret, true);

    const builtinEdit = await admin.call('PUT', '/:clientId', {
      params: { clientId: 'crewrouter-desktop' },
      body: { name: 'Desktop', type: 'public', scopes: ['events:report'], redirectUris: ['http://127.0.0.1/callback'] },
    });
    assert.equal(builtinEdit.statusCode, 403);
    assert.equal(builtinEdit.body.code, 'BUILTIN_CLIENT');

    // 公共客户端授权码 + PKCE 流程。
    const verifier = 'test-verifier-' + 'x'.repeat(50);
    const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const publicParams = {
      client_id: publicId,
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:54321/callback',
      scope: 'gateway:invoke',
      state: 'state-public',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    const deniedStart = await oauthCall('POST', '/oauth/device/code', {
      body: { client_id: publicId, scope: 'gateway:invoke' }, session: {},
    });
    const deniedDecision = await oauthCall('POST', '/oauth/device/authorize', {
      body: { user_code: deniedStart.body.user_code, decision: 'deny', _csrf: 'test-csrf-token' },
      session: { user: { id: 1, username: 'alice' }, csrfToken: 'test-csrf-token' },
    });
    assert.equal(deniedDecision.statusCode, 200);
    const deniedPoll = await oauthCall('POST', '/oauth/token', {
      body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: publicId, device_code: deniedStart.body.device_code }, session: {},
    });
    assert.equal(deniedPoll.body.error, 'access_denied');

    const deviceStart = await oauthCall('POST', '/oauth/device/code', {
      body: { client_id: publicId, scope: 'gateway:invoke' },
      session: {},
    });
    assert.equal(deviceStart.statusCode, 200);
    assert.equal(deviceStart.headers['Cache-Control'], 'no-store');
    assert.equal(deviceStart.body.expires_in, 600);
    assert.equal(deviceStart.body.interval, 5);
    assert.match(deviceStart.body.user_code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const deviceStored = (await pool.query('SELECT * FROM oauth_device_codes WHERE user_code = $1', [deviceStart.body.user_code])).rows[0];
    await pool.query("UPDATE api_keys SET name = 'Main test key' WHERE id = 1");
    const deviceApprovalPage = await oauthCall('GET', '/oauth/device', { query: { user_code: deviceStart.body.user_code }, session: { user: { id: 1, username: 'alice' } } });
    assert.match(deviceApprovalPage.body, /Public App/);
    assert.match(deviceApprovalPage.body, /gateway:invoke/);
    assert.match(deviceApprovalPage.body, /name="api_key_id"/);
    assert.match(deviceApprovalPage.body, /Main test key/);
    assert.match(deviceApprovalPage.body, /name="_csrf" value="test-csrf-token"/);
    const missingDeviceCsrf = await oauthCall('POST', '/oauth/device/authorize', {
      body: { user_code: deviceStart.body.user_code, decision: 'approve' },
      session: { user: { id: 1, username: 'alice' }, csrfToken: 'test-csrf-token' },
    });
    assert.equal(missingDeviceCsrf.statusCode, 403);
    const deviceApproval = await oauthCall('POST', '/oauth/device/authorize', {
      body: { user_code: deviceStart.body.user_code, decision: 'approve', api_key_id: '1', _csrf: 'test-csrf-token' },
      session: { user: { id: 1, username: 'alice' }, csrfToken: 'test-csrf-token' },
    });
    assert.equal(deviceApproval.statusCode, 200);
    assert.equal((await pool.query('SELECT api_key_id FROM oauth_device_codes WHERE user_code = $1', [deviceStart.body.user_code])).rows[0].api_key_id, 1);
    assert.equal(deviceStored.device_code_hash, oauthClients.sha256Hex(deviceStart.body.device_code));
    assert.notEqual(deviceStored.device_code_hash, deviceStart.body.device_code);

    const pollDeviceStart = await oauthCall('POST', '/oauth/device/code', {
      body: { client_id: publicId, scope: 'gateway:invoke' }, session: {},
    });
    const pollStored = (await pool.query('SELECT * FROM oauth_device_codes WHERE user_code = $1', [pollDeviceStart.body.user_code])).rows[0];
    const pending = await oauthCall('POST', '/oauth/token', {
      body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: publicId, device_code: pollDeviceStart.body.device_code },
      session: {},
    });
    assert.equal(pending.statusCode, 400);
    assert.equal(pending.body.error, 'authorization_pending');
    await pool.query("UPDATE oauth_device_codes SET last_polled_at = now() WHERE device_code_hash = $1", [pollStored.device_code_hash]);
    const tooFastDevice = await oauthCall('POST', '/oauth/token', {
      body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: publicId, device_code: pollDeviceStart.body.device_code },
      session: {},
    });
    assert.equal(tooFastDevice.body.error, 'slow_down');
    assert.equal((await pool.query('SELECT interval_seconds FROM oauth_device_codes WHERE device_code_hash = $1', [pollStored.device_code_hash])).rows[0].interval_seconds, 10);
    await pool.query("UPDATE oauth_device_codes SET last_polled_at = now() - interval '11 seconds', status = 'approved', user_id = 1, api_key_id = 1 WHERE device_code_hash = $1", [pollStored.device_code_hash]);
    const deviceToken = await oauthCall('POST', '/oauth/token', {
      body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: publicId, device_code: pollDeviceStart.body.device_code },
      session: {},
    });
    assert.equal(deviceToken.statusCode, 200);
    assert.equal(deviceToken.body.token_type, 'Bearer');
    assert.equal(deviceToken.body.scope, 'gateway:invoke');
    const deviceTokenStored = (await pool.query('SELECT api_key_id, user_id FROM oauth_tokens WHERE token_hash = $1', [oauthClients.sha256Hex(deviceToken.body.access_token)])).rows[0];
    assert.equal(deviceTokenStored.api_key_id, 1);
    assert.equal(deviceTokenStored.user_id, 1);
    const repeatedDeviceToken = await oauthCall('POST', '/oauth/token', {
      body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: publicId, device_code: pollDeviceStart.body.device_code },
      session: {},
    });
    assert.equal(repeatedDeviceToken.body.error, 'invalid_grant');

    const publicInfo = await oauthCall('GET', '/oauth/authorize/info', { query: publicParams });
    assert.equal(publicInfo.statusCode, 200);
    assert.equal(publicInfo.body.client.type, 'public');
    assert.equal(publicInfo.body.client.first_party, false);
    const publicApprove = await oauthCall('POST', '/oauth/authorize/approve', {
      body: { ...publicParams, decision: 'approve', api_key_id: '1' },
    });
    assert.equal(publicApprove.statusCode, 302);
    const publicCallback = new URL(publicApprove.location);
    assert.equal(publicCallback.searchParams.get('state'), 'state-public');
    const publicCode = publicCallback.searchParams.get('code');
    const badPkceMethod = await oauthCall('GET', '/oauth/authorize/info', {
      query: { ...publicParams, code_challenge_method: undefined },
    });
    assert.equal(badPkceMethod.statusCode, 400);

    const publicToken = await oauthCall('POST', '/oauth/token', {
      body: { grant_type: 'authorization_code', code: publicCode, client_id: publicId, redirect_uri: publicParams.redirect_uri, code_verifier: verifier },
    });
    assert.equal(publicToken.statusCode, 200);
    assert.match(publicToken.body.access_token, /^crh_/);
    assert.match(publicToken.body.refresh_token, /^crh_/);

    // 回调地址不匹配必须拒绝。
    const badRedirect = await oauthCall('GET', '/oauth/authorize/info', {
      query: { ...publicParams, redirect_uri: 'https://evil.example/callback' },
    });
    assert.equal(badRedirect.statusCode, 400);
    assert.equal(badRedirect.body.error, 'invalid_redirect_uri');

    // 机密客户端必须带正确 secret。
    const confidentialParams = {
      client_id: confidentialId,
      response_type: 'code',
      redirect_uri: 'https://app.example.com/callback',
      scope: 'gateway:invoke',
      state: 'state-confidential',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    const confidentialInfo = await oauthCall('GET', '/oauth/authorize/info', { query: confidentialParams });
    assert.equal(confidentialInfo.statusCode, 200);
    const confidentialApprove = await oauthCall('POST', '/oauth/authorize/approve', {
      body: { ...confidentialParams, decision: 'approve', api_key_id: '1' },
    });
    assert.equal(confidentialApprove.statusCode, 302);
    const confidentialCode = new URL(confidentialApprove.location).searchParams.get('code');
    const missingSecret = await oauthCall('POST', '/oauth/token', {
      body: { grant_type: 'authorization_code', code: confidentialCode, client_id: confidentialId, redirect_uri: confidentialParams.redirect_uri, code_verifier: verifier },
    });
    assert.equal(missingSecret.statusCode, 401);
    assert.equal(missingSecret.body.error, 'invalid_client');
    const wrongSecret = await oauthCall('POST', '/oauth/token', {
      body: { grant_type: 'authorization_code', code: confidentialCode, client_id: confidentialId, redirect_uri: confidentialParams.redirect_uri, code_verifier: verifier },
      headers: { authorization: 'Basic ' + Buffer.from(`${confidentialId}:wrong`).toString('base64') },
    });
    assert.equal(wrongSecret.statusCode, 401);
    const confidentialToken = await oauthCall('POST', '/oauth/token', {
      body: { grant_type: 'authorization_code', code: confidentialCode, client_id: confidentialId, redirect_uri: confidentialParams.redirect_uri, code_verifier: verifier },
      headers: { authorization: 'Basic ' + Buffer.from(`${confidentialId}:${secret}`).toString('base64') },
    });
    assert.equal(confidentialToken.statusCode, 200);
    assert.match(confidentialToken.body.access_token, /^crh_/);

    // 公共客户端刷新不需要 secret；机密客户端刷新需要 Basic。
    const publicRefresh = await oauthCall('POST', '/oauth/token', {
      body: { grant_type: 'refresh_token', refresh_token: publicToken.body.refresh_token, client_id: publicId },
    });
    assert.equal(publicRefresh.statusCode, 200);
    const reusedPublicRefresh = await oauthCall('POST', '/oauth/token', {
      body: { grant_type: 'refresh_token', refresh_token: publicToken.body.refresh_token, client_id: publicId },
    });
    assert.equal(reusedPublicRefresh.statusCode, 400);
    const confidentialRefresh = await oauthCall('POST', '/oauth/token', {
      body: { grant_type: 'refresh_token', refresh_token: confidentialToken.body.refresh_token },
      headers: { authorization: 'Basic ' + Buffer.from(`${confidentialId}:${secret}`).toString('base64') },
    });
    assert.equal(confidentialRefresh.statusCode, 200);

    // 清理授权流程产生的令牌，便于下面精确验证停用吊销数量。
    await pool.query('DELETE FROM oauth_tokens WHERE client_id = $1', [confidentialId]);

    await pool.query(
      `INSERT INTO oauth_tokens (token_hash, user_id, client_id, scope, kind, expires_at)
       VALUES ('token-1', 1, $1, 'gateway:invoke', 'access', now() + interval '1 hour'),
              ('token-2', 1, $1, 'gateway:invoke', 'refresh', now() + interval '1 hour')`,
      [confidentialId]
    );
    await pool.query(
      `INSERT INTO oauth_auth_codes (code, client_id, user_id, scope, code_challenge, expires_at)
       VALUES ('code-1', $1, 1, 'gateway:invoke', 'challenge', now() + interval '10 minutes')`,
      [confidentialId]
    );

    const disable = await admin.call('PUT', '/:clientId', {
      params: { clientId: confidentialId },
      body: {
        name: 'Confidential App', type: 'confidential', scopes: ['gateway:invoke', 'events:report'],
        redirectUris: ['https://app.example.com/callback'], enabled: false,
      },
    });
    assert.equal(disable.statusCode, 200);
    assert.equal(disable.body.revokedTokens, 2);
    assert.equal((await pool.query('SELECT enabled FROM oauth_clients WHERE client_id = $1', [confidentialId])).rows[0].enabled, false);
    assert.equal(Number((await pool.query(
      'SELECT count(*) AS count FROM oauth_tokens WHERE client_id = $1 AND revoked',
      [confidentialId]
    )).rows[0].count), 2);

    const rotate = await admin.call('POST', '/:clientId/rotate-secret', { params: { clientId: confidentialId } });
    assert.equal(rotate.statusCode, 200);
    assert.match(rotate.body.client_secret, /^crs_/);
    assert.notEqual(rotate.body.client_secret, secret);
    const rotated = (await pool.query('SELECT secret_hash FROM oauth_clients WHERE client_id = $1', [confidentialId])).rows[0];
    assert.equal(rotated.secret_hash, oauthClients.sha256Hex(rotate.body.client_secret));

    const remove = await admin.call('DELETE', '/:clientId', { params: { clientId: confidentialId } });
    assert.equal(remove.statusCode, 200);
    assert.equal((await pool.query('SELECT count(*) AS count FROM oauth_clients WHERE client_id = $1', [confidentialId])).rows[0].count, '0');
    assert.equal((await pool.query('SELECT count(*) AS count FROM oauth_auth_codes WHERE client_id = $1', [confidentialId])).rows[0].count, '0');
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM oauth_tokens WHERE client_id = $1 AND revoked = FALSE', [confidentialId])).rows[0].count), 0);

    console.log('OAuth clients: schema upgrade, create/list/update/rotate/delete, token revocation checks passed');
  } finally {
    await pool.end();
    cluster.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
