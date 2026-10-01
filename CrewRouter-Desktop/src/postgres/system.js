'use strict';

// 开发兜底：Linux root + 系统 postgres 用户，通过 runuser 拉起一个隔离的 PostgreSQL 实例。
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function runAsPostgres(command, args, options = {}) {
  return execFileSync('runuser', ['-u', 'postgres', '--', command, ...args], { stdio: 'inherit', ...options });
}

function isSystemPostgresAvailable() {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  try { execFileSync('id', ['-u', 'postgres'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function createSystemPostgresProvider() {
  return {
    name: 'system-runuser',
    async start({ userData, host = '127.0.0.1', findFreePort, onProgress = () => {} }) {
      const postgresUid = Number(execFileSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).trim());
      const postgresGid = Number(execFileSync('id', ['-g', 'postgres'], { encoding: 'utf8' }).trim());
      const postgresKey = crypto.createHash('sha256').update(path.resolve(userData)).digest('hex').slice(0, 16);
      // PostgreSQL 以 postgres 用户运行，无法进入 root 拥有的 home 目录，因此数据放在临时目录。
      const postgresRoot = path.join(os.tmpdir(), `crewrouter-desktop-postgres-${postgresKey}`);
      const dataDir = path.join(postgresRoot, 'data');
      const logPath = path.join(postgresRoot, 'postgres.log');
      const pgCtl = process.env.PG_CTL || 'pg_ctl';
      const psql = process.env.PSQL || 'psql';
      const databaseName = `crewrouter_desktop_${postgresKey}`;
      let stopped = false;
      await fsp.mkdir(path.join(userData, 'runtime'), { recursive: true });
      await fsp.mkdir(postgresRoot, { recursive: true, mode: 0o755 });
      await fsp.chown(postgresRoot, postgresUid, postgresGid);
      if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
        onProgress('init');
        await fsp.mkdir(dataDir, { recursive: true });
        await fsp.chown(dataDir, postgresUid, postgresGid);
        runAsPostgres(process.env.PG_INITDB || 'initdb', ['--no-locale', '--encoding=UTF8', '--auth=trust', '-D', dataDir]);
      }
      onProgress('start');
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
        provider: 'system-runuser',
        dataDir,
        port,
        config: { host, port, name: databaseName, user: 'postgres', password: '' },
        stop: async () => {
          if (stopped) return;
          stopped = true;
          try { runAsPostgres(pgCtl, ['-D', dataDir, 'stop', '-m', 'fast']); } catch {}
        },
      };
    },
  };
}

module.exports = { createSystemPostgresProvider, isSystemPostgresAvailable };
