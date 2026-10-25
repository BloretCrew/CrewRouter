'use strict';

// Security regressions must never inherit deployment credentials or reuse a
// database directory. Each caller gets a newly initialized Unix-socket cluster.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function executable(name) {
  const directories = [...String(process.env.PATH || '').split(path.delimiter), '/usr/bin',
    '/usr/pgsql-18/bin', '/usr/pgsql-17/bin', '/usr/pgsql-16/bin', '/usr/pgsql-15/bin', '/usr/pgsql-14/bin'];
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) {}
  }
  throw new Error(`Isolated PostgreSQL regression requires ${name}`);
}

function createIsolatedPostgres(label = 'data') {
  if (!/^[a-z0-9-]{1,24}$/.test(label)) throw new TypeError('Invalid isolated test label');
  const initdb = executable('initdb');
  const pgctl = executable('pg_ctl');
  const asRoot = process.getuid?.() === 0;
  const runuser = asRoot ? executable('runuser') : null;
  let owner;
  if (asRoot) {
    owner = {
      uid: Number(execFileSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).trim()),
      gid: Number(execFileSync('id', ['-g', 'postgres'], { encoding: 'utf8' }).trim()),
    };
  }
  const root = fs.mkdtempSync(`/tmp/cr-data-${label}-`);
  const dataDir = path.join(root, 'data');
  const socketDir = path.join(root, 'socket');
  const cleanEnvironment = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' };
  const run = (command, args) => execFileSync(asRoot ? runuser : command,
    asRoot ? ['-u', 'postgres', '--', command, ...args] : args,
    { cwd: root, env: cleanEnvironment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  const pidFile = path.join(dataDir, 'postmaster.pid');
  let started = false;
  let stopped = false;
  try {
    fs.mkdirSync(socketDir, { mode: 0o700 });
    if (owner) {
      fs.chownSync(root, owner.uid, owner.gid);
      fs.chownSync(socketDir, owner.uid, owner.gid);
    }
    run(initdb, ['-D', dataDir, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']);
    started = true;
    run(pgctl, ['-D', dataDir, '-l', path.join(root, 'postgres.log'), '-w', '-t', '15', 'start', '-o',
      `-p 54327 -k '${socketDir}' -h '' -c shared_preload_libraries='' -c session_preload_libraries='' -c local_preload_libraries='' -c max_connections=16 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`]);
  } catch (error) {
    if (started && fs.existsSync(pidFile)) run(pgctl, ['-D', dataDir, '-m', 'immediate', '-w', '-t', '15', 'stop']);
    if (!fs.existsSync(pidFile)) fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    dataDir, socketDir,
    connection: {
      host: socketDir, port: 54327, user: 'postgres', database: 'postgres',
      password: 'isolated-test-only', ssl: false, connectionTimeoutMillis: 5000,
      application_name: `crewrouter-isolated-${label}-test`,
    },
    async assertIsolation(pool) {
      assert.equal((await pool.query('SHOW data_directory')).rows[0].data_directory, dataDir);
      assert.equal((await pool.query('SHOW listen_addresses')).rows[0].listen_addresses, '');
      assert.equal((await pool.query('SHOW unix_socket_directories')).rows[0].unix_socket_directories, socketDir);
    },
    stop() {
      if (stopped) return;
      run(pgctl, ['-D', dataDir, '-m', 'immediate', '-w', '-t', '15', 'stop']);
      assert.equal(fs.existsSync(pidFile), false, 'temporary PostgreSQL must stop before directory cleanup');
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false, 'remove only this generated cluster directory');
      stopped = true;
    },
  };
}

module.exports = { createIsolatedPostgres };
