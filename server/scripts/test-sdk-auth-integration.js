'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const express = require('express');
const { CrewRouter } = require('../../sdk/typescript/dist/esm/index.js');

const state = {
  key: 'sk-sdk-auth-test',
  permissions: ['keys.read', 'account.profile.read'],
  enabled: true,
};
const pool = {
  async query(_sql, values = []) {
    const supplied = values[0];
    if (supplied === state.key || supplied === require('../utils/api-key-identity').sha256Hex(state.key)) {
      if (!state.enabled) return { rows: [] };
      return { rows: [{
        id: 17,
        user_id: 9,
        owner_id: 9,
        username: 'sdk-test-user',
        email: 'sdk-test@example.invalid',
        is_admin: false,
        team_id: null,
        name: 'SDK integration key',
        permissions: state.permissions,
        enabled: true,
        expires_at: null,
      }] };
    }
    return { rows: [] };
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (resolved === path.resolve(__dirname, '../models/database.js')) return { pool };
  return originalLoad.call(this, request, parent, isMain);
};
let resolveRequestAuth;
let requireApiKeyPermission;
try {
  ({ resolveRequestAuth } = require('../middleware/request-auth'));
  ({ requireApiKeyPermission } = require('../middleware/api-key-permissions'));
} finally {
  Module._load = originalLoad;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(resolveRequestAuth);
  app.use('/api', requireApiKeyPermission);
  app.get('/api/user/api-keys', (req, res) => res.json([{
    id: req.authActor.key.id,
    name: req.authActor.key.name,
    key_value: null,
    permissions: req.authActor.key.permissions,
    tags: [],
    model_queue: [],
  }]));
  app.get('/api/user/balance', (_req, res) => res.json({
    balance: 10,
    refund_balance: 8,
    rate_limit_rpm: 60,
    rate_limit_tpm: 1000,
    group: null,
  }));
  app.get('/api/user/usage', (_req, res) => res.json([]));
  const server = app.listen(0, '127.0.0.1');
  const port = await new Promise(resolve => server.once('listening', () => resolve(server.address().port)));
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const valid = new CrewRouter({ baseUrl, apiKey: state.key });
    const keys = await valid.keys.list();
    assert.equal(keys.data[0].id, 17);
    assert.equal(keys.data[0].key_value, null);
    const balance = await valid.balance.get();
    assert.equal(balance.data.refund_balance, 8);

    const invalid = new CrewRouter({ baseUrl, apiKey: 'sk-invalid' });
    await assert.rejects(invalid.keys.list(), error => {
      assert.equal(error.status, 401);
      assert.equal(error.code, 'invalid_api_key');
      return true;
    });

    await assert.rejects(valid.usage.get(), error => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'permission_denied');
      assert.equal(error.permission, 'usage.read');
      return true;
    });
    console.log('SDK auth integration: valid key, invalid key 401, and missing permission 403 passed');
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
