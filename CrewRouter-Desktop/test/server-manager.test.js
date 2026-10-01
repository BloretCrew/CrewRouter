'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { findFreePort, createRuntimeConfig, resolveServerEntry, redact, LocalServerManager } = require('../src/server-manager');
const { resolvePostgresProvider } = require('../src/postgres');

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

const READY_CHILD = `const http=require('http'); const s=http.createServer((q,r)=>{if(q.url==='/api/version')r.end(JSON.stringify({version:'test'}));else if(q.url==='/api/setup/status')r.end(JSON.stringify({needsSetup:false}));else if(q.url==='/api/instance')r.end(JSON.stringify({runtime:'desktop-local',edition:'personal',auth:{required:false,methods:['local']},demo:false,secret:'no'}));else if(q.url==='/env')r.end(JSON.stringify({token:process.env.CR_LOCAL_TOKEN,db:process.env.CR_DB_NAME,port:process.env.CR_APP_PORT}));else r.statusCode=404,r.end();}); s.listen(process.env.CR_APP_PORT,process.env.CR_APP_HOST);`;

function getJson(url) {
  return new Promise((resolve, reject) => { http.get(url, (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve(JSON.parse(body))); }).once('error', reject); });
}

test('manager polls health endpoints, injects the local token and does not expose env secrets', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-manager-'));
  const entry = path.join(dir, 'child.js');
  await fsp.writeFile(entry, READY_CHILD);
  process.env.CR_APP_PORT = '20003';
  const manager = new LocalServerManager({ serverEntry: entry, userData: dir, createDatabase: false, startupTimeoutMs: 3000, pollIntervalMs: 20, env: { CR_SESSION_SECRET: 'hidden' } });
  const progress = [];
  manager.on('progress', (event) => progress.push(event.step));
  const status = await manager.start();
  assert.equal(status.ready, true);
  assert.equal(status.version, 'test');
  assert.equal(status.edition, 'personal');
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'secret'), false);
  assert.notEqual(status.port, 20003);
  assert.equal(status.logsDir, path.join(dir, 'logs'));
  assert.deepEqual(progress, [2, 3], '未使用数据库时只报告启动与就绪进度');
  assert.match(manager.localToken, /^[a-f0-9]{48}$/);
  const env = await getJson(`${status.baseUrl}/env`);
  assert.equal(env.token, manager.localToken);
  assert.equal(env.port, String(status.port));
  await manager.stop();
  assert.equal(manager.getStatus().ready, false);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('manager uses an injected postgres provider and stops it with the server', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-manager-db-'));
  const entry = path.join(dir, 'child.js');
  await fsp.writeFile(entry, READY_CHILD);
  const events = [];
  const provider = { name: 'fake', async start({ userData, host, findFreePort: pick, onProgress }) { events.push(`start:${path.basename(userData)}:${host}`); onProgress('init'); const port = await pick(host); return { provider: 'fake', port, config: { host, port, name: 'fake_db', user: 'u', password: 'p' }, stop: async () => { events.push('stop'); } }; } };
  const manager = new LocalServerManager({ serverEntry: entry, userData: dir, postgres: provider, startupTimeoutMs: 3000, pollIntervalMs: 20 });
  const labels = [];
  manager.on('progress', (event) => labels.push(event.label));
  const status = await manager.start();
  assert.equal(status.database.provider, 'fake');
  assert.ok(labels.some((label) => /初始化本地数据库/.test(label)));
  const env = await getJson(`${status.baseUrl}/env`);
  assert.equal(env.db, 'fake_db');
  const config = JSON.parse(await fsp.readFile(manager.runtime.configPath, 'utf8'));
  assert.equal(config.database.name, 'fake_db');
  await manager.stop();
  assert.deepEqual(events, [`start:${path.basename(dir)}:127.0.0.1`, 'stop']);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('unexpected child exit is reported and abort cancels a pending start', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cr-manager-exit-'));
  const entry = path.join(dir, 'child.js');
  await fsp.writeFile(entry, READY_CHILD);
  const manager = new LocalServerManager({ serverEntry: entry, userData: dir, createDatabase: false, startupTimeoutMs: 3000, pollIntervalMs: 20 });
  const exits = [];
  manager.on('exit', (event) => exits.push(event));
  const status = await manager.start();
  process.kill(status.pid, 'SIGKILL');
  await new Promise((resolve) => manager.once('exit', resolve));
  assert.equal(exits[0].wasReady, true);
  assert.equal(exits[0].aborted, false);
  assert.equal(manager.getStatus().ready, false);
  await manager.stop();

  const hanging = path.join(dir, 'hang.js');
  await fsp.writeFile(hanging, 'setInterval(() => {}, 1000);');
  const slow = new LocalServerManager({ serverEntry: hanging, userData: dir, createDatabase: false, startupTimeoutMs: 5000, pollIntervalMs: 20 });
  const pending = slow.start();
  setTimeout(() => slow.abort(), 100);
  await assert.rejects(pending, (error) => error.cancelled === true);
  assert.equal(slow.child, null);
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

test('postgres provider resolution prefers embedded binaries and explains what is missing', () => {
  let provider;
  try { provider = resolvePostgresProvider(); } catch (error) { assert.match(error.message, /embedded-postgres/); return; }
  assert.ok(['embedded', 'system-runuser'].includes(provider.name));
});
