'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { spawn } = require('node:child_process');

const SECRET_KEYS = /(secret|password|token|api[_-]?key|master[_-]?key|authorization|cookie)/i;

function runAsPostgres(command, args, options = {}) {
  return execFileSync('runuser', ['-u', 'postgres', '--', command, ...args], { stdio: 'inherit', ...options });
}

async function startIsolatedPostgres(userData, host = '127.0.0.1') {
  const postgresUid = Number(execFileSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).trim());
  const postgresGid = Number(execFileSync('id', ['-g', 'postgres'], { encoding: 'utf8' }).trim());
  const runtimeDir = path.join(userData, 'runtime');
  const postgresKey = crypto.createHash('sha256').update(path.resolve(userData)).digest('hex').slice(0, 16);
  // PostgreSQL runs as postgres and cannot traverse root-owned home directories such as /root/.config.
  const postgresRoot = path.join(os.tmpdir(), `crewrouter-desktop-postgres-${postgresKey}`);
  const dataDir = path.join(postgresRoot, 'data');
  const logPath = path.join(postgresRoot, 'postgres.log');
  const pgCtl = process.env.PG_CTL || 'pg_ctl';
  const psql = process.env.PSQL || 'psql';
  const databaseName = `crewrouter_desktop_${postgresKey}`;
  let stopped = false;
  await fsp.mkdir(runtimeDir, { recursive: true });
  await fsp.mkdir(postgresRoot, { recursive: true, mode: 0o755 });
  await fsp.chown(postgresRoot, postgresUid, postgresGid);
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.chown(dataDir, postgresUid, postgresGid);
    runAsPostgres(process.env.PG_INITDB || 'initdb', ['--no-locale', '--encoding=UTF8', '--auth=trust', '-D', dataDir]);
  }
  const port = await findFreePort(host);
  try {
    try {
      runAsPostgres(pgCtl, ['-D', dataDir, 'status'], { stdio: 'ignore' });
      runAsPostgres(pgCtl, ['-D', dataDir, 'stop', '-m', 'immediate'], { stdio: 'ignore' });
    } catch {}
    runAsPostgres(pgCtl, ['-D', dataDir, '-o', `-h ${host} -p ${port}`, '-l', logPath, 'start']);
    const databases = execFileSync('runuser', ['-u', 'postgres', '--', psql, '-h', host, '-p', String(port), '-d', 'postgres', '-At', '-c', `SELECT 1 FROM pg_database WHERE datname = '${databaseName}'`], { encoding: 'utf8' });
    if (!databases.trim()) runAsPostgres(psql, ['-h', host, '-p', String(port), '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${databaseName}`]);
  } catch (error) {
    try { runAsPostgres(pgCtl, ['-D', dataDir, 'stop', '-m', 'immediate']); } catch {}
    throw error;
  }
  return {
    dataDir,
    port,
    config: { host, port, name: databaseName, user: 'postgres', password: '' },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try { runAsPostgres(pgCtl, ['-D', dataDir, 'stop', '-m', 'fast']); } catch {}
    },
  };
}

function redact(value) {
  return String(value)
    .replace(/((?:secret|password|token|api[_-]?key|master[_-]?key|authorization|cookie)\s*[=:]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
}

function findFreePort(host = '127.0.0.1', netModule = net) {
  return new Promise((resolve, reject) => {
    const server = netModule.createServer();
    server.once('error', reject);
    server.listen({ host, port: 0 }, () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function mergeConfig(base, overrides) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides || {})) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? mergeConfig(base[key], value)
      : value;
  }
  return result;
}

async function createRuntimeConfig(userData, overrides = {}) {
  if (!userData) throw new TypeError('userData directory is required');
  const runtimeDir = path.join(userData, 'runtime');
  const dataDir = path.join(runtimeDir, 'data');
  const logsDir = path.join(userData, 'logs');
  await Promise.all([fsp.mkdir(runtimeDir, { recursive: true }), fsp.mkdir(dataDir, { recursive: true }), fsp.mkdir(logsDir, { recursive: true })]);
  const configPath = path.join(runtimeDir, 'config.json');
  const databaseKey = crypto.createHash('sha256').update(path.resolve(userData)).digest('hex').slice(0, 16);
  const databaseName = `crewrouter_desktop_${databaseKey}`;
  const config = {
    app: { name: 'CrewRouter Desktop', host: '127.0.0.1', port: 0, sessionSecret: crypto.randomBytes(32).toString('hex') },
    database: { host: '127.0.0.1', port: 5432, name: databaseName, user: 'postgres', password: '' },
    runtime: 'desktop-local',
    edition: 'personal',
    auth: { required: false, methods: ['local'] },
    loginReport: { enabled: true },
    statsReport: { enabled: true },
    demo: false,
  };
  const finalConfig = mergeConfig(config, overrides);
  await fsp.writeFile(configPath, `${JSON.stringify(finalConfig, null, 2)}\n`, { mode: 0o600 });
  return { runtimeDir, configPath, dataDir, logsDir, config: finalConfig };
}

function resolveServerEntry(mode, options = {}) {
  if (options.serverEntry) return path.resolve(options.serverEntry);
  if (mode === 'development') {
    const root = options.serverRoot || process.env.CREWROUTER_SERVER_ROOT;
    if (root) return path.join(path.resolve(root), 'server', 'index.js');
    const fallbackRoot = options.resourceRoot || path.join(__dirname, '..', 'staging', 'server');
    for (const candidate of ['server/index.js', 'index.js', 'server.js']) {
      if (fs.existsSync(path.join(path.resolve(fallbackRoot), candidate))) return path.join(path.resolve(fallbackRoot), candidate);
    }
    throw new Error(`CREWROUTER_SERVER_ROOT is not set and staged server was not found in ${path.resolve(fallbackRoot)}`);
  }
  const packagedRoot = options.app?.isPackaged ? options.app.resourcesPath : (mode === 'packaged' ? process.resourcesPath : null);
  const resourceRoot = options.resourceRoot || (packagedRoot ? path.join(packagedRoot, 'server') : null) || process.env.CREWROUTER_PACKAGED_SERVER_ROOT;
  if (!resourceRoot) throw new Error('packaged server resource path is not configured');
  const root = path.resolve(resourceRoot);
  for (const candidate of ['server/index.js', 'index.js', 'server.js']) {
    if (fs.existsSync(path.join(root, candidate))) return path.join(root, candidate);
  }
  throw new Error(`packaged server entry not found in ${root}`);
}

function requestJson(url, timeoutMs, request = http) {
  return new Promise((resolve, reject) => {
    const req = request.get(url, { headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let value;
        try { value = body ? JSON.parse(body) : {}; } catch { value = { raw: body }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`Health check ${url} returned HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.response = value;
          reject(error);
        } else resolve({ statusCode: res.statusCode, body: value });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Health check timed out: ${url}`)));
    req.once('error', reject);
  });
}

class LocalServerManager {
  constructor(options = {}) {
    this.options = { mode: 'development', host: '127.0.0.1', startupTimeoutMs: 30000, pollIntervalMs: 150, requestTimeoutMs: 1500, ...options };
    this.child = null;
    this.status = { pid: null, port: null, baseUrl: null, ready: false, runtime: null, edition: null, auth: null, demo: null, capabilities: {}, version: null };
    this.runtime = null;
    this.database = null;
  }

  async start() {
    if (this.child) throw new Error('Local server is already running');
    const opts = this.options;
    const userData = opts.userData || path.join(os.tmpdir(), 'crewrouter-desktop');
    const port = opts.port || await (opts.findFreePort || findFreePort)(opts.host);
    this.runtime = await createRuntimeConfig(userData, {
      ...(opts.config || {}),
      ...(typeof opts.runtime === 'string' ? { runtime: opts.runtime } : {}),
      ...(opts.edition ? { edition: opts.edition } : {}),
      ...(opts.auth ? { auth: opts.auth } : {}),
      ...(opts.demo !== undefined ? { demo: opts.demo } : {}),
      ...(opts.localIdentityId ? { localIdentityId: opts.localIdentityId } : {}),
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
      ...(opts.database ? { database: opts.database } : {}),
    });
      if (!opts.database && opts.createDatabase !== false && process.platform === 'linux' && (() => { try { execFileSync('id', ['-u', 'postgres']); return true; } catch { return false; } })()) {
      this.database = await startIsolatedPostgres(userData, opts.host);
      this.runtime = await createRuntimeConfig(userData, {
        ...(opts.config || {}),
        ...(typeof opts.runtime === 'string' ? { runtime: opts.runtime } : {}),
        ...(opts.edition ? { edition: opts.edition } : {}),
        ...(opts.auth ? { auth: opts.auth } : {}),
        ...(opts.demo !== undefined ? { demo: opts.demo } : {}),
        ...(opts.localIdentityId ? { localIdentityId: opts.localIdentityId } : {}),
        ...(opts.displayName ? { displayName: opts.displayName } : {}),
        database: this.database.config,
      });
    }
    let entry;
    try {
      entry = resolveServerEntry(opts.mode, opts);
      this.serverEntry = entry;
    } catch (error) {
      await this.database?.stop().catch(() => {});
      this.database = null;
      throw error;
    }
    const logPath = path.join(this.runtime.logsDir, 'server.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    const inherited = { ...process.env };
    // Do not let a desktop child accidentally use the parent's production listener/config.
    const inheritedConfigKeys = /^(?:CR(?:W)?_|CREWROUTER_(?:SERVER_ROOT|PACKAGED_SERVER_ROOT)$|DATABASE_URL$|PG(?:HOST|PORT|USER|PASSWORD|DATABASE)$)/;
    for (const key of Object.keys(inherited)) if (inheritedConfigKeys.test(key)) delete inherited[key];
    const env = { ...inherited };
    for (const [key, value] of Object.entries(opts.env || {})) {
      if (!inheritedConfigKeys.test(key)) env[key] = value;
    }
    const database = this.runtime.config.database;
    Object.assign(env, { CR_APP_HOST: opts.host, CR_APP_PORT: String(port), CR_CONFIG_PATH: this.runtime.configPath, CR_DATA_DIR: this.runtime.dataDir, CR_LOG_DIR: this.runtime.logsDir, CR_RUNTIME: this.runtime.config.runtime || 'desktop-local', CR_EDITION: this.runtime.config.edition || 'personal', CR_AUTH_REQUIRED: String(this.runtime.config.auth?.required ?? false), CR_AUTH_METHODS: Array.isArray(this.runtime.config.auth?.methods) ? this.runtime.config.auth.methods.join(',') : 'local', CR_LOGIN_REPORT_ENABLED: String(this.runtime.config.loginReport?.enabled ?? true), CR_STATS_REPORT_ENABLED: String(this.runtime.config.statsReport?.enabled ?? true), CR_DEMO: String(this.runtime.config.demo === true), CR_LOCAL_ID: this.runtime.config.localIdentityId || '', CR_LOCAL_DISPLAY_NAME: this.runtime.config.displayName || '', CR_DB_HOST: database.host, CR_DB_PORT: String(database.port), CR_DB_NAME: database.name, CR_DB_USER: database.user, CR_DB_PASSWORD: database.password });
    // A packaged Electron executable must be switched to Node mode for the bundled Server child.
    if (process.versions.electron && opts.runAsNode !== false) env.ELECTRON_RUN_AS_NODE = '1';
    let child;
    try {
      child = (opts.spawn || spawn)(process.execPath, [entry], { cwd: this.runtime.runtimeDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      this.status = { pid: child.pid || null, port, baseUrl: `http://${opts.host}:${port}`, ready: false, runtime: null, edition: null, auth: null, demo: null, capabilities: {}, version: null, setup: null };
      const write = (chunk) => logStream.write(redact(chunk));
      child.stdout?.on('data', write); child.stderr?.on('data', write);
      let exitError;
      child.once('exit', (code, signal) => {
        logStream.end();
        exitError = new Error(`Local server exited before becoming ready (code ${code}, signal ${signal || 'none'}); see ${logPath}`);
        exitError.code = code;
        if (this.child === child) { this.child = null; this.status.ready = false; this.status.exit = { code, signal }; }
      });
      if (opts.waitForReady !== false) {
          await this.waitUntilReady(child, () => exitError);
        await this.ensureLocalPrincipalReady();
      }
      return this.getStatus();
    } catch (error) {
      if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
      this.child = null;
      logStream.end();
      await this.database?.stop().catch(() => {});
      this.database = null;
      throw error;
    }
  }

  async ensureLocalPrincipalReady() {
    if (this.runtime?.config.runtime !== 'desktop-local') return;
    let me;
    try { me = await requestJson(`${this.status.baseUrl}/auth/me`, this.options.requestTimeoutMs, this.options.request || http); }
    catch (error) {
      // Older or minimal test servers may not expose the optional identity endpoint.
      if (error.statusCode === 401 || error.statusCode === 404) return;
      throw new Error(`本地身份初始化检查失败：${error.message}`);
    }
    if (!me.body?.needsPasswordSetup) return;
    const bcryptPath = path.join(path.dirname(this.serverEntry || ''), 'node_modules', 'bcryptjs');
    let bcrypt;
    try { bcrypt = require(bcryptPath); } catch (error) { throw new Error(`本地身份初始化依赖缺失：${error.message}`); }
    const passwordHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
    const database = this.runtime.config.database;
    const sql = `UPDATE users SET password_hash = '${passwordHash}' WHERE username = 'desktop-local' AND (password_hash IS NULL OR password_hash = '')`;
    const psql = this.options.psql || process.env.PSQL || 'psql';
    execFileSync('runuser', ['-u', 'postgres', '--', psql, '-h', database.host, '-p', String(database.port), '-d', database.name, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'ignore' });
  }

  async waitUntilReady(child = this.child, getExitError = () => null) {
    if (!this.status.baseUrl) throw new Error('Local server has not been started');
    const deadline = Date.now() + this.options.startupTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      const exitError = getExitError();
      if (exitError || (child && child.exitCode !== null)) throw (exitError || new Error(`Local server exited before becoming ready (code ${child.exitCode})`));
      try {
        const version = await requestJson(`${this.status.baseUrl}/api/version`, this.options.requestTimeoutMs, this.options.request || http);
        const setup = await requestJson(`${this.status.baseUrl}/api/setup/status`, this.options.requestTimeoutMs, this.options.request || http);
        const instance = await requestJson(`${this.status.baseUrl}/api/instance`, this.options.requestTimeoutMs, this.options.request || http);
        if (!setup.body || typeof setup.body !== 'object' || typeof setup.body.needsSetup !== 'boolean') throw new Error('Setup status is invalid');
        if (setup.body.needsSetup) throw new Error('Local server still requires setup; desktop-local configuration was not applied');
        this.status.setup = { needsSetup: false };
        this.status.version = version.body.version || null;
        const metadata = instance.body.data && typeof instance.body.data === 'object' ? instance.body.data : instance.body;
        this.status.runtime = metadata.runtime || this.runtime.config.runtime || null;
        this.status.edition = metadata.edition || this.runtime.config.edition || null;
        this.status.auth = metadata.auth || this.runtime.config.auth || null;
        this.status.demo = metadata.demo === undefined ? (this.runtime.config.demo === true ? true : false) : metadata.demo;
        this.status.capabilities = metadata.capabilities || {};
        if (this.status.runtime !== 'desktop-local' || this.status.edition !== 'personal' || this.status.auth?.required !== false || JSON.stringify(this.status.auth?.methods) !== JSON.stringify(['local']) || this.status.demo !== false) throw new Error(`Local server metadata is not desktop-local personal local-auth non-demo: runtime=${this.status.runtime}, edition=${this.status.edition}, auth=${JSON.stringify(this.status.auth)}, demo=${this.status.demo}`);
        this.status.ready = true;
        return this.getStatus();
      } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs)); }
    }
    const error = new Error(`Local server readiness timed out after ${this.options.startupTimeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
    error.cause = lastError;
    throw error;
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, this.options.stopTimeoutMs || 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.status.ready = false;
    await this.database?.stop().catch(() => {});
    this.database = null;
  }

  getStatus() { return { ...this.status }; }
}

module.exports = { LocalServerManager, findFreePort, createRuntimeConfig, resolveServerEntry, redact, requestJson };
