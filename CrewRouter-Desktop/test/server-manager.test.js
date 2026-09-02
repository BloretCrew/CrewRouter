'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { findFreePort, createRuntimeConfig, resolveServerEntry, redact, LocalServerManager } = require('../src/server-manager');

test('findFreePort returns a bindable dynamic port', async () => {
  const port = await findFreePort('127.0.0.1');
  assert.ok(port > 0 && port !== 20003 && port !== 20004);
});

test('createRuntimeConfig creates isolated config, data and logs paths', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-desktop-'));
  const result = await createRuntimeConfig(dir, { app: { port: 12345 } });
  const config = JSON.parse(await fsp.readFile(result.configPath, 'utf8'));
  assert.equal(config.app.port, 12345);
  assert.equal(config.runtime, 'desktop-local');
  assert.equal(config.edition, 'personal');
  assert.deepEqual(config.auth, { required: false, methods: ['local'] });
  assert.equal(config.demo, false);
  assert.equal(config.loginReport.enabled, true);
  assert.equal(config.statsReport.enabled, true);
  assert.match(result.configPath, /runtime/);
  assert.ok(fs.statSync(result.dataDir).isDirectory());
  assert.ok(fs.statSync(result.logsDir).isDirectory());
  await fsp.rm(dir, { recursive: true, force: true });
});

test('resolveServerEntry supports development and packaged resources', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-entry-'));
  await fsp.mkdir(path.join(dir, 'server'));
  await fsp.writeFile(path.join(dir, 'server', 'index.js'), '');
  assert.equal(resolveServerEntry('development', { serverRoot: dir }), path.join(dir, 'server/index.js'));
  assert.equal(resolveServerEntry('development', { resourceRoot: dir }), path.join(dir, 'server/index.js'));
  assert.equal(resolveServerEntry('packaged', { resourceRoot: dir }), path.join(dir, 'server/index.js'));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('redact removes credentials from log output', () => {
  assert.equal(redact('CR_SESSION_SECRET=abc token:xyz Bearer abc'), 'CR_SESSION_SECRET=[REDACTED] token:[REDACTED] Bearer [REDACTED]');
});

test('manager polls both health endpoints and does not expose env secrets', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-manager-'));
  const entry = path.join(dir, 'child.js');
  await fsp.writeFile(entry, `const http=require('http'); const s=http.createServer((q,r)=>{if(q.url==='/api/version')r.end(JSON.stringify({version:'test'}));else if(q.url==='/api/setup/status')r.end(JSON.stringify({needsSetup:false}));else if(q.url==='/api/instance')r.end(JSON.stringify({runtime:'desktop-local',edition:'personal',auth:{required:false,methods:['local']},demo:false,secret:'no'}));else r.statusCode=404,r.end();}); s.listen(process.env.CR_APP_PORT,process.env.CR_APP_HOST);`);
  process.env.CR_APP_PORT = '20003';
  const manager = new LocalServerManager({ serverEntry: entry, userData: dir, createDatabase: false, startupTimeoutMs: 3000, pollIntervalMs: 20, env: { CR_SESSION_SECRET: 'hidden' } });
  const status = await manager.start();
  assert.equal(status.ready, true);
  assert.equal(status.version, 'test');
  assert.equal(status.edition, 'personal');
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'secret'), false);
  assert.notEqual(status.port, 20003);
  await manager.stop();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('waitUntilReady reports non-2xx and timeout clearly', async () => {
  const server = http.createServer((req, res) => { res.statusCode = 503; res.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const manager = new LocalServerManager({ host: '127.0.0.1', port, startupTimeoutMs: 80, pollIntervalMs: 10 });
  manager.status.baseUrl = `http://127.0.0.1:${port}`;
  await assert.rejects(manager.waitUntilReady(), /timed out.*HTTP 503/);
  await new Promise((resolve) => server.close(resolve));
});
