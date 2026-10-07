'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { findFreePort } = require('./util/free-port');
const { resolvePostgresProvider } = require('./postgres');

function redact(value) {
  return String(value)
    .replace(/((?:secret|password|token|api[_-]?key|master[_-]?key|authorization|cookie)\s*[=:]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
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

// 启动阶段进度：数据库 → 启动进程 → 等待就绪（第 4 步“打开控制台”由主进程完成）。
const PROGRESS = Object.freeze({
  database: { step: 1, total: 4, label: '正在准备本地数据库' },
  databaseInit: { step: 1, total: 4, label: '正在初始化本地数据库（首次需要一些时间）' },
  spawn: { step: 2, total: 4, label: '正在启动本地服务' },
  ready: { step: 3, total: 4, label: '正在检查服务就绪' },
});

const INHERITED_CONFIG_KEYS = /^(?:CR(?:W)?_|CREWROUTER_(?:SERVER_ROOT|PACKAGED_SERVER_ROOT)$|DATABASE_URL$|PG(?:HOST|PORT|USER|PASSWORD|DATABASE)$)/;

function emptyStatus() {
  return { pid: null, port: null, baseUrl: null, ready: false, runtime: null, edition: null, auth: null, demo: null, capabilities: {}, version: null, logsDir: null, logPath: null, setup: null, database: null };
}

class LocalServerManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { mode: 'development', host: '127.0.0.1', startupTimeoutMs: 30000, pollIntervalMs: 150, requestTimeoutMs: 1500, ...options };
    this.child = null;
    this.status = emptyStatus();
    this.runtime = null;
    this.database = null;
    this.childNonce = null;
    this.localToken = null;
    this.aborted = false;
    this.serverEntry = null;
  }

  progress(key) { this.emit('progress', { ...PROGRESS[key] }); }

  _configOverrides() {
    const opts = this.options;
    return {
      ...(opts.config || {}),
      ...(typeof opts.runtime === 'string' ? { runtime: opts.runtime } : {}),
      ...(opts.edition ? { edition: opts.edition } : {}),
      ...(opts.auth ? { auth: opts.auth } : {}),
      ...(opts.demo !== undefined ? { demo: opts.demo } : {}),
      ...(opts.localIdentityId ? { localIdentityId: opts.localIdentityId } : {}),
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
    };
  }

  async start() {
    if (this.child) throw new Error('Local server is already running');
    const opts = this.options;
    this.aborted = false;
    const userData = opts.userData || path.join(os.tmpdir(), 'crewrouter-desktop');
    const port = opts.port || await (opts.findFreePort || findFreePort)(opts.host);
    let database = opts.database || null;
    if (!database && opts.createDatabase !== false) {
      this.progress('database');
      const provider = opts.postgres || resolvePostgresProvider();
      this.database = await provider.start({
        userData,
        host: opts.host,
        findFreePort: opts.findFreePort || findFreePort,
        logger: opts.logger,
        onProgress: (phase) => this.progress(phase === 'init' ? 'databaseInit' : 'database'),
      });
      database = this.database.config;
    }
    let entry;
    try {
      this.runtime = await createRuntimeConfig(userData, { ...this._configOverrides(), ...(database ? { database } : {}) });
      entry = resolveServerEntry(opts.mode, opts);
      this.serverEntry = entry;
    } catch (error) {
      await this.database?.stop().catch(() => {});
      this.database = null;
      throw error;
    }
    this.progress('spawn');
    const logPath = path.join(this.runtime.logsDir, 'server.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    const inherited = { ...process.env };
    // 不允许子进程意外继承父项目的生产监听/配置。
    for (const key of Object.keys(inherited)) if (INHERITED_CONFIG_KEYS.test(key)) delete inherited[key];
    const env = { ...inherited };
    for (const [key, value] of Object.entries(opts.env || {})) {
      if (!INHERITED_CONFIG_KEYS.test(key)) env[key] = value;
    }
    const db = this.runtime.config.database;
    this.localToken = crypto.randomBytes(24).toString('hex');
    Object.assign(env, {
      CR_APP_HOST: opts.host,
      CR_APP_PORT: String(port),
      CR_CONFIG_PATH: this.runtime.configPath,
      CR_DATA_DIR: this.runtime.dataDir,
      CR_LOG_DIR: this.runtime.logsDir,
      CR_RUNTIME: this.runtime.config.runtime || 'desktop-local',
      CR_EDITION: this.runtime.config.edition || 'personal',
      CR_AUTH_REQUIRED: String(this.runtime.config.auth?.required ?? false),
      CR_AUTH_METHODS: Array.isArray(this.runtime.config.auth?.methods) ? this.runtime.config.auth.methods.join(',') : 'local',
      CR_LOGIN_REPORT_ENABLED: String(this.runtime.config.loginReport?.enabled ?? true),
      CR_STATS_REPORT_ENABLED: String(this.runtime.config.statsReport?.enabled ?? true),
      CR_DEMO: String(this.runtime.config.demo === true),
      CR_LOCAL_ID: this.runtime.config.localIdentityId || '',
      CR_LOCAL_DISPLAY_NAME: this.runtime.config.displayName || '',
      CR_LOCAL_TOKEN: this.localToken,
      CR_DB_HOST: db.host,
      CR_DB_PORT: String(db.port),
      CR_DB_NAME: db.name,
      CR_DB_USER: db.user,
      CR_DB_PASSWORD: db.password,
    });
    // 打包后的 Electron 可执行文件需要切换到 Node 模式才能运行 Server 子进程。
    if (process.versions.electron && opts.runAsNode !== false) env.ELECTRON_RUN_AS_NODE = '1';
    let child;
    try {
      child = (opts.spawn || spawn)(process.execPath, [entry], { cwd: this.runtime.runtimeDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      this.childNonce = crypto.randomUUID();
      this.status = { ...emptyStatus(), pid: child.pid || null, ownerNonce: this.childNonce, port, baseUrl: `http://${opts.host}:${port}`, logsDir: this.runtime.logsDir, logPath, database: this.database ? { provider: this.database.provider, port: this.database.port } : null };
      const write = (chunk) => logStream.write(redact(chunk));
      child.stdout?.on('data', write); child.stderr?.on('data', write);
      let exitError;
      child.once('exit', (code, signal) => {
        logStream.end();
        exitError = new Error(`Local server exited before becoming ready (code ${code}, signal ${signal || 'none'}); see ${logPath}`);
        exitError.code = code;
        if (this.child === child) {
          const wasReady = this.status.ready;
          this.child = null; this.status.ready = false; this.status.exit = { code, signal };
          this.emit('exit', { code, signal, wasReady, aborted: this.aborted, logPath });
        }
      });
      if (opts.waitForReady !== false) {
        this.progress('ready');
        await this.waitUntilReady(child, () => exitError);
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

  async waitUntilReady(child = this.child, getExitError = () => null) {
    if (!this.status.baseUrl) throw new Error('Local server has not been started');
    const deadline = Date.now() + this.options.startupTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      if (this.aborted) { const cancelled = new Error('本地服务启动已取消'); cancelled.cancelled = true; throw cancelled; }
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

  // 取消进行中的启动：waitUntilReady 会以 cancelled 错误退出，随后由 start() 的清理逻辑停止子进程与数据库。
  abort() {
    this.aborted = true;
    const child = this.child;
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }

  async stop(expectedNonce = this.childNonce) {
    const child = this.child;
    if (!child) {
      this.childNonce = null; this.status.ready = false; this.status.ownerNonce = null;
      await this.database?.stop().catch(() => {});
      this.database = null;
      return;
    }
    if (expectedNonce !== this.childNonce || child.pid !== this.status.pid || child !== this.child) throw new Error('Local server ownership check failed');
    this.child = null; this.childNonce = null;
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, this.options.stopTimeoutMs || 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.status.ready = false;
    this.status.ownerNonce = null;
    await this.database?.stop().catch(() => {});
    this.database = null;
  }

  getStatus() { return { ...this.status }; }
}

module.exports = { LocalServerManager, findFreePort, createRuntimeConfig, resolveServerEntry, redact, requestJson, PROGRESS };
