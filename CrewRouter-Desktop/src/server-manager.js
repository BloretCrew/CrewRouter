'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const SECRET_KEYS = /(secret|password|token|api[_-]?key|master[_-]?key|authorization|cookie)/i;

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

async function createRuntimeConfig(userData, overrides = {}) {
  if (!userData) throw new TypeError('userData directory is required');
  const runtimeDir = path.join(userData, 'runtime');
  const dataDir = path.join(runtimeDir, 'data');
  const logsDir = path.join(userData, 'logs');
  await Promise.all([fsp.mkdir(runtimeDir, { recursive: true }), fsp.mkdir(dataDir, { recursive: true }), fsp.mkdir(logsDir, { recursive: true })]);
  const configPath = path.join(runtimeDir, 'config.json');
  const config = {
    app: { name: 'CrewRouter Desktop', host: '127.0.0.1', port: 0 },
    demo: true,
    edition: 'personal',
    ...overrides,
  };
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { runtimeDir, configPath, dataDir, logsDir, config };
}

function resolveServerEntry(mode, options = {}) {
  if (options.serverEntry) return path.resolve(options.serverEntry);
  if (mode === 'development') {
    const root = options.serverRoot || process.env.CREWROUTER_SERVER_ROOT;
    if (!root) throw new Error('CREWROUTER_SERVER_ROOT is required in development mode');
    return path.join(path.resolve(root), 'server', 'index.js');
  }
  const resourceRoot = options.resourceRoot || (options.app && options.app.isPackaged ? path.join(options.app.resourcesPath, 'server') : null) || process.env.CREWROUTER_PACKAGED_SERVER_ROOT;
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
    this.status = { pid: null, port: null, baseUrl: null, ready: false, edition: null, version: null };
    this.runtime = null;
  }

  async start() {
    if (this.child) throw new Error('Local server is already running');
    const opts = this.options;
    const port = opts.port || await (opts.findFreePort || findFreePort)(opts.host);
    this.runtime = opts.runtime || await createRuntimeConfig(opts.userData || path.join(os.tmpdir(), 'crewrouter-desktop'), opts.config || {});
    const entry = resolveServerEntry(opts.mode, opts);
    const logPath = path.join(this.runtime.logsDir, 'server.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    const inherited = { ...process.env };
    // Do not let a desktop child accidentally use the parent's production listener/config.
    for (const key of Object.keys(inherited)) if (/^CR_(APP_PORT|APP_HOST|CONFIG|DATA|LOG|DB_|EDITION|DEMO|ENV)$/.test(key)) delete inherited[key];
    const env = { ...inherited, ...(opts.env || {}), CR_APP_HOST: opts.host, CR_APP_PORT: String(port), CR_CONFIG_PATH: this.runtime.configPath, CR_DATA_DIR: this.runtime.dataDir, CR_LOG_DIR: this.runtime.logsDir, CR_RUNTIME: 'desktop-local', CR_EDITION: opts.edition || 'personal', CR_DEMO: opts.demo === undefined ? 'true' : String(opts.demo) };
    const child = (opts.spawn || spawn)(process.execPath, [entry], { cwd: this.runtime.runtimeDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.status = { pid: child.pid || null, port, baseUrl: `http://${opts.host}:${port}`, ready: false, edition: null, version: null };
    const write = (chunk) => logStream.write(redact(chunk));
    child.stdout?.on('data', write); child.stderr?.on('data', write);
    let exitError;
    child.once('exit', (code, signal) => {
      logStream.end();
      exitError = new Error(`Local server exited before becoming ready (code ${code}, signal ${signal || 'none'}); see ${logPath}`);
      exitError.code = code;
      if (this.child === child) { this.child = null; this.status.ready = false; this.status.exit = { code, signal }; }
    });
    if (opts.waitForReady !== false) await this.waitUntilReady(child, () => exitError);
    return this.getStatus();
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
        this.status.setup = { needsSetup: setup.body.needsSetup };
        this.status.version = version.body.version || null;
        this.status.edition = instance.body.edition || null;
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
    if (!child) return;
    this.child = null;
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, this.options.stopTimeoutMs || 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    this.status.ready = false;
  }

  getStatus() { return { ...this.status }; }
}

module.exports = { LocalServerManager, findFreePort, createRuntimeConfig, resolveServerEntry, redact, requestJson };
