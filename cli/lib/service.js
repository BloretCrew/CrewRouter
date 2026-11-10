'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  DEFAULT_PORT,
  logDir,
  logPathForPort,
  ensurePrivateDir,
  defaultConfigFilePath,
  resolveLocalPort,
  loadServiceState,
  saveServiceState,
  clearServiceState,
  tailFile,
} = require('./config');
const { request } = require('./http');

const ENTRY_PATH = path.join(__dirname, 'local-server-entry.js');
const SERVER_ROOT = path.resolve(__dirname, '..', '..');

function sleep(ms, timers = {}) {
  return new Promise(resolve => (timers.setTimeout || setTimeout)(resolve, ms));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch (_) {
    try {
      const { execFileSync } = require('node:child_process');
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).trim();
    } catch (_) { return ''; }
  }
}

function ownsProcess(pid) {
  if (!processAlive(pid)) return false;
  const cmdline = readCmdline(pid);
  if (!cmdline) return process.platform === 'win32';
  return cmdline.includes('local-server-entry.js');
}

function portFree(host, port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    try { server.listen({ host, port }); }
    catch (_) { resolve(false); }
  });
}

async function probeHealth(baseUrl, { timeoutMs = 1500 } = {}) {
  const started = Date.now();
  try {
    const version = await request(`${baseUrl}/api/version`, { timeoutMs, maxBytes: 1024 * 1024 });
    if (version.statusCode < 200 || version.statusCode >= 300 || !version.json || typeof version.json !== 'object') {
      return { ok: false, baseUrl, error: `HTTP ${version.statusCode}`, latencyMs: Date.now() - started };
    }
    let setup = null;
    let instance = null;
    try {
      const response = await request(`${baseUrl}/api/setup/status`, { timeoutMs, maxBytes: 1024 * 1024 });
      setup = response.json;
    } catch (_) { /* optional */ }
    try {
      const response = await request(`${baseUrl}/api/instance`, { timeoutMs, maxBytes: 1024 * 1024 });
      instance = response.json;
    } catch (_) { /* optional */ }
    return {
      ok: true,
      baseUrl,
      version: version.json,
      setup,
      instance,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      baseUrl,
      error: error.code || error.message || '连接失败',
      latencyMs: Date.now() - started,
    };
  }
}

function dbConfigured({ configPath, demo, env = process.env } = {}) {
  if (demo) return true;
  if (env.CR_DB_HOST || env.CR_DB_NAME || env.CR_DB_USER || env.CR_DB_PASSWORD || env.CR_DB_PORT) return true;
  const file = configPath || defaultConfigFilePath();
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Boolean(config && config.database && (config.database.host || config.database.name || process.env.CR_CONFIG_PATH));
  } catch (_) {
    return false;
  }
}

function buildServiceEnv({ host, port, configPath, demo, env = process.env }) {
  const next = { ...env };
  next.CR_APP_HOST = host;
  next.CR_APP_PORT = String(port);
  if (configPath) next.CR_CONFIG_PATH = path.resolve(configPath);
  if (demo) next.CR_DEMO = 'true';
  else if (next.CR_DEMO === '1') next.CR_DEMO = 'true';
  return next;
}

async function startLocalService(options = {}) {
  const host = options.host || '127.0.0.1';
  let port = resolveLocalPort({ port: options.port, configPath: options.configPath });
  const configPath = options.configPath ? path.resolve(options.configPath) : null;
  const sourceEnv = options.env || process.env;
  const demo = options.demo === true || ['1', 'true'].includes(String(sourceEnv.CR_DEMO || '').toLowerCase());
  const spawnImpl = options.spawn || spawn;
  const probe = options.probe || probeHealth;
  const timers = options.timers || {};
  const now = options.now || Date.now;
  const baseUrl = `http://${host}:${port}`;

  const existing = loadServiceState();
  if (existing && processAlive(existing.pid)) {
    const health = await probe(existing.baseUrl, { timeoutMs: 1500 });
    if (health.ok) return { ...existing, health, reused: true };
  } else if (existing) {
    clearServiceState();
  }

  const health = await probe(baseUrl, { timeoutMs: 800 });
  if (health.ok) {
    return {
      pid: null,
      host,
      port,
      baseUrl,
      health,
      external: true,
      reused: true,
      logPath: existing && existing.logPath ? existing.logPath : null,
    };
  }

  if (!(await portFree(host, port))) {
    throw Object.assign(new Error(`端口 ${port} 已被其他进程占用，请使用 --port 指定其他端口`), { code: 'PORT_IN_USE' });
  }
  if (!dbConfigured({ configPath, demo, env: options.env || process.env })) {
    throw Object.assign(new Error(
      '本机服务需要 PostgreSQL 配置。请复制 config.example.json 为 config.json 并填写 database，或传入 --config / 设置 CR_DB_* 环境变量；也可用 --demo 启动无数据库试用模式。'
    ), { code: 'DB_NOT_CONFIGURED' });
  }

  ensurePrivateDir(logDir());
  const logPath = logPathForPort(port);
  const logFd = fs.openSync(logPath, 'a', 0o600);
  try { fs.fchmodSync(logFd, 0o600); } catch (_) {}
  const nonce = require('node:crypto').randomBytes(16).toString('hex');
  const env = buildServiceEnv({ host, port, configPath, demo, nonce, env: options.env || process.env });
  let child;
  try {
    child = spawnImpl(process.execPath, [ENTRY_PATH], {
      cwd: SERVER_ROOT,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    if (child && typeof child.unref === 'function') child.unref();
  } catch (error) {
    fs.closeSync(logFd);
    throw error;
  }
  fs.closeSync(logFd);
  if (!child || !child.pid) {
    throw new Error('本地服务进程启动失败（未获得 PID）');
  }

  const state = {
    pid: child.pid,
    nonce,
    host,
    port,
    baseUrl,
    startedAt: now(),
    configPath,
    logPath,
    demo,
  };
  saveServiceState(state);
  let exitCode = null;
  if (typeof child.once === 'function') child.once('exit', code => { exitCode = code; });

  const timeoutMs = Number(options.timeoutMs) || 30000;
  const deadline = Date.now() + timeoutMs;
  let lastHealth = null;
  try {
    while (Date.now() < deadline) {
      if (!processAlive(child.pid) || exitCode !== null) {
        throw new Error(`本地服务在就绪前退出（exit ${exitCode === null ? 'unknown' : exitCode}）`);
      }
      lastHealth = await probe(baseUrl, { timeoutMs: 1500 });
      if (lastHealth.ok) {
        const result = { ...state, health: lastHealth, started: true };
        if (options.onProgress) options.onProgress({ stage: 'ready', state: result });
        return result;
      }
      if (options.onProgress) options.onProgress({ stage: 'starting', port, baseUrl });
      await sleep(250, timers);
    }
    throw new Error(`本地服务在 ${Math.round(timeoutMs / 1000)} 秒内未就绪`);
  } catch (error) {
    try { process.kill(child.pid, 'SIGTERM'); } catch (_) {}
    clearServiceState();
    const tail = tailFile(logPath, 40);
    if (tail) error.message += `\n--- 最近日志 ---\n${tail}`;
    throw error;
  }
}

async function stopLocalService(options = {}) {
  const state = loadServiceState();
  if (!state) {
    return { running: false, stopped: false, message: '没有由 cr 启动的本地服务' };
  }
  if (!processAlive(state.pid)) {
    clearServiceState();
    return { running: false, stopped: false, message: '本地服务进程已不存在，已清理状态' };
  }
  const owned = ownsProcess(state.pid);
  if (!owned && !options.force) {
    throw Object.assign(new Error(`进程 ${state.pid} 不属于 cr 本地服务，拒绝停止；确认后可加 --force`), { code: 'NOT_OWNER' });
  }
  const kill = options.kill || process.kill.bind(process);
  try { kill(state.pid, 'SIGTERM'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + (Number(options.timeoutMs) || 10000);
  const timers = options.timers || {};
  while (Date.now() < deadline && processAlive(state.pid)) await sleep(100, timers);
  let forced = false;
  if (processAlive(state.pid)) {
    forced = true;
    try { kill(state.pid, 'SIGKILL'); } catch (_) {}
    const hardDeadline = Date.now() + 2000;
    while (Date.now() < hardDeadline && processAlive(state.pid)) await sleep(50, timers);
  }
  clearServiceState();
  return { running: false, stopped: true, forced, pid: state.pid, port: state.port };
}

async function serviceStatus(options = {}) {
  const state = loadServiceState();
  const probe = options.probe || probeHealth;
  if (state && !processAlive(state.pid)) {
    clearServiceState();
    const health = await probe(state.baseUrl, { timeoutMs: 800 });
    return { managed: false, stale: true, state, health, alive: false };
  }
  if (state) {
    const health = await probe(state.baseUrl, { timeoutMs: 1500 });
    return { managed: true, stale: false, state, health, alive: processAlive(state.pid), owned: ownsProcess(state.pid) };
  }
  const baseUrl = options.baseUrl;
  if (!baseUrl) return { managed: false, state: null, health: null, alive: false };
  const health = await probe(baseUrl, { timeoutMs: 1500 });
  return { managed: false, state: null, health, alive: false };
}

function currentLogPath() {
  const state = loadServiceState();
  return state && state.logPath ? state.logPath : null;
}

function readLogs(lines = 100, file = null) {
  const state = loadServiceState();
  const target = file || (state && state.logPath) || null;
  if (!target) return '';
  return tailFile(target, lines);
}

async function serveForeground(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = resolveLocalPort({ port: options.port, configPath: options.configPath });
  const configPath = options.configPath ? path.resolve(options.configPath) : null;
  const sourceEnv = options.env || process.env;
  const demo = options.demo === true || ['1', 'true'].includes(String(sourceEnv.CR_DEMO || '').toLowerCase());
  if (!dbConfigured({ configPath, demo, env: options.env || process.env })) {
    throw new Error('本机服务需要 PostgreSQL 配置；请传入 --config 或使用 --demo。');
  }
  if (!(await portFree(host, port))) {
    throw new Error(`端口 ${port} 已被占用`);
  }
  const env = buildServiceEnv({ host, port, configPath, demo, nonce: 'foreground', env: options.env || process.env });
  return new Promise((resolve, reject) => {
    const child = (options.spawn || spawn)(process.execPath, [ENTRY_PATH], {
      cwd: SERVER_ROOT,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ code, signal });
      else reject(Object.assign(new Error(`本地服务退出（code ${code}, signal ${signal || 'none'}）`), { exitCode: code }));
    });
    if (options.onSpawn) options.onSpawn(child, { host, port });
  });
}

module.exports = {
  ENTRY_PATH,
  SERVER_ROOT,
  sleep,
  processAlive,
  readCmdline,
  ownsProcess,
  portFree,
  probeHealth,
  dbConfigured,
  buildServiceEnv,
  startLocalService,
  stopLocalService,
  serviceStatus,
  currentLogPath,
  readLogs,
  serveForeground,
  DEFAULT_PORT,
};
