'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const repository = path.resolve(__dirname, '../..');
const preload = path.join(__dirname, 'test-support/offline-security-preload.js');

function run(source) {
  const result = spawnSync(process.execPath, ['--require', preload, '--eval', source], {
    cwd: repository, encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, LANG: 'C', NODE_OPTIONS: '',
      CR_DB_HOST: 'unused-offline-fixture.invalid',
      QUOTA_TEST_DATABASE_URL: 'postgresql://unused-offline-fixture.invalid/test',
      CRW_MASTER_KEY: 'not-a-real-key-fixture' },
  });
  assert(!result.error, result.error?.message);
  return result;
}

test('offline preload substitutes deployment modules without loading configuration, logging or credentials', () => {
  const result = run(`
    const assert = require('node:assert/strict');
    assert.equal(require('./server/config-loader').runtime, 'server');
    require('./server/logger').info('offline-only');
    assert(!require.cache[require.resolve('./server/config-loader')]);
    assert(!require.cache[require.resolve('./server/logger')]);
    assert.equal(process.env.CR_DB_HOST, undefined);
    assert.equal(process.env.QUOTA_TEST_DATABASE_URL, undefined);
    assert.equal(process.env.CRW_MASTER_KEY, 'offline-security-regression-test-only');
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('application pool operations fail the child even if application code catches the exception', () => {
  const result = run(`
    try { require('./server/models/database').pool.query('SELECT 1'); }
    catch (error) { console.error(error.message); }
  `);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OFFLINE_TEST_BLOCKED_APPLICATION_DATABASE_OPERATION/);
});

test('application startup and direct deployment config reads are blocked before execution', () => {
  for (const [source, error] of [
    ["require('./server/index')", 'OFFLINE_TEST_BLOCKED_APPLICATION_STARTUP'],
    ["require('node:fs').readFileSync('./config.json')", 'OFFLINE_TEST_BLOCKED_DEPLOYMENT_CONFIG'],
  ]) {
    const result = run(source);
    assert.equal(result.status, 1);
    assert(result.stderr.includes(error));
  }
});

test('fixed production-like listeners and unregistered local, external and Unix connections are blocked', () => {
  for (const source of [
    "require('node:net').createServer().listen(20003, '127.0.0.1')",
    "require('node:net').createConnection(20003, '127.0.0.1')",
    "require('node:net').createConnection(443, 'unused-offline-fixture.invalid')",
    "require('node:net').createConnection('/var/run/postgresql/.s.PGSQL.5432')",
  ]) {
    const result = run(source);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OFFLINE_TEST_BLOCKED_(FIXED_LISTEN_PORT|UNREGISTERED_CONNECTION|UNIX_SOCKET)/);
  }
});

test('the preload permits only a newly created loopback HTTP fixture for transport regressions', () => {
  const result = run(`
    const assert = require('node:assert/strict');
    const server = require('node:http').createServer((request, response) => response.end('fixture'));
    server.listen(0, '127.0.0.1', async () => {
      try {
        const response = await fetch('http://127.0.0.1:' + server.address().port);
        assert.equal(await response.text(), 'fixture');
      } catch (error) { console.error(error); process.exitCode = 1; }
      finally { server.closeAllConnections(); server.close(); }
    });
  `);
  assert.equal(result.status, 0, result.stderr);
});
