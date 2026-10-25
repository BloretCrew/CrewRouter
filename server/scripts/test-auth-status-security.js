'use strict';

// The actual route runs with a loopback Express listener and isolated config.
// No application database, logger, configuration file or identity provider loads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const express = require('express');
const { metadata } = require('../utils/instance-edition');
const credentials = require('../utils/passport-credentials');

async function status(t, { runtime = 'server', mode = 'passport', passport, edition = 'team' } = {}) {
  const config = { edition, passport };
  const pool = { query() { throw new Error('Status must not query a live database'); } };
  const module = { exports: {} };
  const mocks = {
    express, bcryptjs: {},
    '../models/database': { pool },
    '../logger': {},
    '../utils/audit-log': { ACTIONS: {}, logAction() {} },
    '../utils/login-reporter': { reportLoginEvent() {}, reportLogoutEvent() {} },
    '../utils/instance-edition': { metadata, loadPersistedEdition: async () => edition },
    '../utils/auth-mode': { getAuthMode: async () => mode },
    '../utils/feishu-config': { isFeishuLoginAvailable: async () => false },
    '../config-loader': config,
    '../utils/passport-credentials': credentials,
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../routes/auth.js'), 'utf8');
  vm.runInNewContext(source, {
    module, exports: module.exports, URL, process: { env: { CR_RUNTIME: runtime } },
    setInterval: () => ({ unref() {} }),
    require(name) {
      assert(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
      return mocks[name];
    },
  }, { filename: 'isolated-auth-status.js' });
  const app = express();
  app.use('/auth', module.exports);
  const listener = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/auth/status`);
  const body = await response.json();
  const serialized = JSON.stringify(body);
  for (const value of [passport?.appId, passport?.appSecret]) {
    if (typeof value === 'string' && value) assert(!serialized.includes(value), 'credentials must never be exposed');
  }
  assert(!require.cache[require.resolve('../models/database')]);
  assert(!require.cache[require.resolve('../logger')]);
  assert(!require.cache[require.resolve('../config-loader')]);
  return { response, body };
}

test('missing credentials report unavailable PassPort without changing the authentication policy', async t => {
  const { response, body } = await status(t);
  assert.equal(response.status, 200);
  assert.equal(body.passportConfigured, false);
  assert.equal(body.passportConfigurationError, 'PASSPORT_NOT_CONFIGURED');
  assert.deepEqual(body.auth, { required: true, methods: ['password', 'passport'] });
});

test('instance-specific credentials report configured without exposing values', async t => {
  const { body } = await status(t, { passport: { appId: 'offline-instance-app', appSecret: 'offline-instance-secret-for-status-test' } });
  assert.equal(body.passportConfigured, true);
  assert.equal(body.passportConfigurationError, undefined);
});

test('template credentials fail closed', async t => {
  const { body } = await status(t, { passport: { appId: 'your-passport-app-id', appSecret: 'your-passport-app-secret' } });
  assert.equal(body.passportConfigured, false);
  assert.equal(body.passportConfigurationError, 'PASSPORT_NOT_CONFIGURED');
});

test('Desktop Local remains PassPort-only while credentials are missing', async t => {
  const { body } = await status(t, { runtime: 'desktop-local', mode: 'feishu', edition: 'personal', passport: {} });
  assert.equal(body.authMode, 'passport');
  assert.deepEqual(body.auth, { required: true, methods: ['passport'] });
  assert.equal(body.passportConfigured, false);
  assert.equal(body.passportOrigin, 'https://passport.bloret.net');
});

test('a different authentication mode does not advertise PassPort availability', async t => {
  const { body } = await status(t, { mode: 'feishu', passport: { appId: 'offline-instance-app', appSecret: 'offline-instance-secret-for-status-test' } });
  assert.equal(body.passportConfigured, false);
  assert.equal(body.passportConfigurationError, undefined);
  assert(!body.auth.methods.includes('passport'));
});
