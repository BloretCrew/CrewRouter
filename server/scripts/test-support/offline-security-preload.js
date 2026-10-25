'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const net = require('node:net');
const startedAt = Date.now();
const repository = path.resolve(__dirname, '../../..');
const applicationConfig = path.join(repository, 'server/config-loader.js');
const applicationLogger = path.join(repository, 'server/logger.js');
const applicationDatabase = path.join(repository, 'server/models/database.js');
const applicationEntry = path.join(repository, 'server/index.js');
const isolatedConfig = { runtime: 'server', edition: 'team', app: {}, gateway: {} };
const isolatedLogger = { info() {}, warn() {}, error() {}, debug() {}, log() {} };

function forbidApplicationDatabase() {
  process.exitCode = 1;
  throw new Error('OFFLINE_TEST_BLOCKED_APPLICATION_DATABASE_OPERATION');
}

const isolatedDatabase = { pool: { query: forbidApplicationDatabase, connect: forbidApplicationDatabase } };
const originalLoad = Module._load;
Module._load = function offlineLoad(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (!Object.hasOwn(Module._cache, resolved)) {
    if (resolved === applicationConfig) return isolatedConfig;
    if (resolved === applicationLogger) return isolatedLogger;
    if (resolved === applicationDatabase) return isolatedDatabase;
    if (resolved === applicationEntry) throw new Error('OFFLINE_TEST_BLOCKED_APPLICATION_STARTUP');
  }
  return originalLoad.apply(this, arguments);
};

for (const name of Object.keys(process.env)) {
  if (/DATABASE_URL|^CR_DB_|^PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE|PASSFILE)|_PGLITE_MODULE$|MODEL_TRACE_TEST_PG_PORT/.test(name)) delete process.env[name];
}
process.env.CR_CONFIG_PATH = '/nonexistent-crewrouter-offline-test-config.json';
delete process.env.CR_MASTER_KEY;
delete process.env.CR_PROVIDER_KEY_ENCRYPTION_KEY;
process.env.CRW_MASTER_KEY = 'offline-security-regression-test-only';
process.env.NODE_ENV = 'test';
process.env.CR_ENV = 'test';

const originalRead = fs.readFileSync;
fs.readFileSync = function offlineRead(file, ...options) {
  if ((typeof file === 'string' || Buffer.isBuffer(file)) && path.resolve(String(file)) === path.join(repository, 'config.json')) {
    throw new Error('OFFLINE_TEST_BLOCKED_DEPLOYMENT_CONFIG');
  }
  return originalRead.call(this, file, ...options);
};

const testPorts = new Set();
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function offlineListen(...argumentsList) {
  const options = argumentsList[0];
  if (typeof options === 'object') {
    if (Number(options.port) !== 0) throw new Error('OFFLINE_TEST_BLOCKED_FIXED_LISTEN_PORT');
    options.host = options.host || '127.0.0.1';
    if (!['127.0.0.1', '::1', 'localhost'].includes(options.host)) throw new Error('OFFLINE_TEST_BLOCKED_LISTEN_ADDRESS');
  } else {
    if (Number(options) !== 0) throw new Error('OFFLINE_TEST_BLOCKED_FIXED_LISTEN_PORT');
    if (typeof argumentsList[1] !== 'string') argumentsList.splice(1, 0, '127.0.0.1');
    if (!['127.0.0.1', '::1', 'localhost'].includes(argumentsList[1])) throw new Error('OFFLINE_TEST_BLOCKED_LISTEN_ADDRESS');
  }
  this.once('listening', () => { testPorts.add(this.address().port); });
  return originalListen.apply(this, argumentsList);
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function offlineConnect(...argumentsList) {
  if (Array.isArray(argumentsList[0])) argumentsList = argumentsList[0];
  const options = typeof argumentsList[0] === 'object' ? argumentsList[0]
    : typeof argumentsList[0] === 'string' && !/^\d+$/.test(argumentsList[0]) ? { path: argumentsList[0] }
      : { port: Number(argumentsList[0]), host: argumentsList[1] };
  if (options.path) {
    const root = String(options.path).match(/^(\/tmp\/cr-(?:data-[a-z0-9-]+|oauth-revoke)-[^/]+)\//)?.[1];
    if (!root || fs.statSync(root).ctimeMs < startedAt - 1000) throw new Error('OFFLINE_TEST_BLOCKED_UNIX_SOCKET');
  } else if (!['127.0.0.1', '::1', 'localhost'].includes(options.host || 'localhost') || !testPorts.has(Number(options.port))) {
    throw new Error('OFFLINE_TEST_BLOCKED_UNREGISTERED_CONNECTION');
  }
  return originalConnect.apply(this, argumentsList);
};
