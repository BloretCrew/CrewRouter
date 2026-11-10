'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createFakeServer } = require('./helpers/fake-server');

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cli-service-'));
  process.env.CR_CLI_HOME = home;
  return home;
}

async function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

test('probeHealth reads version, setup and instance', async () => {
  const fake = await createFakeServer();
  try {
    const { probeHealth } = require('../lib/service');
    const result = await probeHealth(fake.baseUrl, { timeoutMs: 1000 });
    assert.equal(result.ok, true);
    assert.equal(result.version.version, '1.0.0');
    assert.equal(result.setup.needsSetup, false);
    assert.equal(result.instance.edition, 'team');
  } finally { await fake.close(); }
});

test('dbConfigured ignores DATABASE_URL/PGHOST because the server does not read them', () => {
  const { dbConfigured } = require('../lib/service');
  assert.equal(dbConfigured({ configPath: '/nonexistent/config.json', env: { DATABASE_URL: 'postgres://x' } }), false);
  assert.equal(dbConfigured({ configPath: '/nonexistent/config.json', env: { PGHOST: 'db' } }), false);
  assert.equal(dbConfigured({ configPath: '/nonexistent/config.json', env: { CR_DB_HOST: 'db' } }), true);
  assert.equal(dbConfigured({ configPath: '/nonexistent/config.json', demo: true, env: {} }), true);
});

test('startLocalService writes state/log and passes loopback env to the child', async () => {
  freshHome();
  const { startLocalService } = require('../lib/service');
  const config = require('../lib/config');
  const port = await freePort();
  let captured = null;
  let probes = 0;
  const spawnImpl = (command, args, options) => {
    captured = { command, args, options };
    return { pid: process.pid, once() {}, unref() {} };
  };
  const result = await startLocalService({
    host: '127.0.0.1',
    port,
    demo: true,
    spawn: spawnImpl,
    probe: async () => (++probes === 1
      ? { ok: false, error: 'refused' }
      : { ok: true, version: { name: 'CrewRouter', version: '1.0.0' }, setup: { needsSetup: false }, instance: { edition: 'team' } }),
  });
  assert.equal(result.started, true);
  assert.equal(result.port, port);
  assert.equal(captured.options.detached, true);
  assert.equal(captured.options.env.CR_APP_HOST, '127.0.0.1');
  assert.equal(captured.options.env.CR_APP_PORT, String(port));
  assert.equal(captured.options.env.CR_DEMO, 'true');
  assert.ok(captured.args[0].endsWith('local-server-entry.js'));
  const state = config.loadServiceState();
  assert.equal(state.port, port);
  assert.ok(fs.existsSync(state.logPath));
  assert.equal(fs.statSync(state.logPath).mode & 0o777, 0o600);
  config.clearServiceState();
});

test('startLocalService rejects an occupied port and a missing database config', async () => {
  freshHome();
  const { startLocalService } = require('../lib/service');
  try {
    const port = await freePort();
    await assert.rejects(() => startLocalService({
      host: '127.0.0.1',
      port,
      demo: false,
      configPath: '/nonexistent/config.json',
      env: {},
      probe: async () => ({ ok: false, error: 'refused' }),
      spawn: () => { throw new Error('should not spawn'); },
    }), /PostgreSQL/);
  } finally { /* no server to close */ }
});

test('stopLocalService refuses a foreign PID unless forced and stops an owned process', async () => {
  freshHome();
  const config = require('../lib/config');
  const { stopLocalService, processAlive } = require('../lib/service');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000);', 'local-server-entry.js'], { stdio: 'ignore' });
  try {
    config.saveServiceState({
      pid: child.pid,
      nonce: 'test',
      host: '127.0.0.1',
      port: 20003,
      baseUrl: 'http://127.0.0.1:20003',
      startedAt: Date.now(),
      configPath: null,
      logPath: path.join(process.env.CR_CLI_HOME, 'test.log'),
      demo: false,
    });
    assert.equal(processAlive(child.pid), true);
    const result = await stopLocalService({ timeoutMs: 3000 });
    assert.equal(result.stopped, true);
    assert.equal(processAlive(child.pid), false);
    assert.equal(config.loadServiceState(), null);
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
});

test.after(() => { delete process.env.CR_CLI_HOME; });
