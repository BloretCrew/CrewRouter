'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const DEFAULT_USER = 'crewrouter';
const DEFAULT_DATABASE = 'crewrouter_desktop';

function loadEmbeddedPostgres() {
  try {
    const mod = require('embedded-postgres');
    return mod?.default || mod?.EmbeddedPostgres || mod;
  } catch {
    return null;
  }
}

function isEmbeddedPostgresAvailable() {
  const Embedded = loadEmbeddedPostgres();
  return typeof Embedded === 'function';
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// 上次异常退出可能留下 postmaster.pid；若其中的进程已不存在则清理，否则说明有别的实例占用该数据目录。
async function clearStalePostmaster(databaseDir) {
  const pidFile = path.join(databaseDir, 'postmaster.pid');
  let content;
  try { content = await fsp.readFile(pidFile, 'utf8'); } catch { return; }
  const pid = Number(String(content).split('\n')[0]);
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); throw new Error(`本地数据库目录正被进程 ${pid} 使用，请先关闭其他 CrewRouter Desktop 实例`); }
    catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
  }
  await fsp.rm(pidFile, { force: true });
}

async function loadOrCreatePassword(secretPath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(secretPath, 'utf8'));
    if (typeof parsed?.password === 'string' && parsed.password.length >= 32) return parsed.password;
  } catch {}
  const password = crypto.randomBytes(24).toString('hex');
  await fsp.mkdir(path.dirname(secretPath), { recursive: true });
  await fsp.writeFile(secretPath, `${JSON.stringify({ password }, null, 2)}\n`, { mode: 0o600 });
  return password;
}

function resolveDataRoot(userData) {
  // root 下 PostgreSQL 会以独立系统用户运行，该用户无法进入 /root 之类的 0700 目录，因此改用临时目录（仅开发环境）。
  if (isRoot()) {
    const key = crypto.createHash('sha256').update(path.resolve(userData)).digest('hex').slice(0, 16);
    return path.join(os.tmpdir(), `crewrouter-desktop-postgres-${key}`);
  }
  return path.join(userData, 'postgres');
}

async function ensureDatabase(instance, { host, port, user, password, name }) {
  if (typeof instance.createDatabase === 'function') {
    try { await instance.createDatabase(name); return; }
    catch (error) { if (/already exists|已存在/i.test(String(error?.message || error))) return; throw error; }
  }
  let Client;
  try { ({ Client } = require('pg')); } catch { throw new Error('内置 PostgreSQL 缺少 pg 客户端，无法创建数据库'); }
  const client = new Client({ host, port, user, password, database: 'postgres' });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!exists.rows.length) await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } finally {
    await client.end().catch(() => {});
  }
}

function createEmbeddedPostgresProvider({ user = DEFAULT_USER, databaseName = DEFAULT_DATABASE } = {}) {
  return {
    name: 'embedded',
    async start({ userData, host = '127.0.0.1', findFreePort, logger = console, onProgress = () => {} }) {
      if (!userData) throw new TypeError('userData directory is required');
      const Embedded = loadEmbeddedPostgres();
      if (typeof Embedded !== 'function') throw new Error('未安装 embedded-postgres');
      const dataRoot = resolveDataRoot(userData);
      const databaseDir = path.join(dataRoot, 'data');
      const logsDir = path.join(userData, 'logs');
      const secretPath = path.join(userData, 'runtime', 'postgres.json');
      await Promise.all([fsp.mkdir(dataRoot, { recursive: true }), fsp.mkdir(logsDir, { recursive: true })]);
      const password = await loadOrCreatePassword(secretPath);
      const port = await findFreePort(host);
      const logStream = fs.createWriteStream(path.join(logsDir, 'postgres.log'), { flags: 'a', mode: 0o600 });
      const write = (chunk) => { try { logStream.write(`${String(chunk).replace(/\s+$/, '')}\n`); } catch {} };
      const instance = new Embedded({
        databaseDir,
        user,
        password,
        port,
        persistent: true,
        onLog: write,
        onError: write,
        // Linux root（开发容器）下 PostgreSQL 拒绝以 root 运行；包支持时会创建 postgres 系统用户并切换。
        createPostgresUser: isRoot(),
      });
      const initialized = fs.existsSync(path.join(databaseDir, 'PG_VERSION'));
      let started = false;
      try {
        if (!initialized) {
          onProgress('init');
          logger?.info?.(`[postgres] initialising embedded cluster at ${databaseDir}`);
          await instance.initialise();
        } else {
          await clearStalePostmaster(databaseDir);
        }
        onProgress('start');
        await instance.start();
        started = true;
        await ensureDatabase(instance, { host, port, user, password, name: databaseName });
      } catch (error) {
        if (started) await instance.stop().catch(() => {});
        logStream.end();
        throw new Error(`内置 PostgreSQL 启动失败：${error.message}`);
      }
      let stopped = false;
      return {
        provider: 'embedded',
        dataDir: databaseDir,
        port,
        config: { host, port, name: databaseName, user, password },
        stop: async () => {
          if (stopped) return;
          stopped = true;
          try { await instance.stop(); } catch (error) { logger?.warn?.(`[postgres] stop failed: ${error.message}`); }
          logStream.end();
        },
      };
    },
  };
}

module.exports = { createEmbeddedPostgresProvider, isEmbeddedPostgresAvailable, loadEmbeddedPostgres, resolveDataRoot, DEFAULT_DATABASE, DEFAULT_USER };
