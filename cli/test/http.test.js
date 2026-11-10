'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeServer } = require('./helpers/fake-server');
const { CliClient, ApiError } = require('../lib/client');
const { loginPassword, completeTwoFactor, loginApiKey, TwoFactorRequired, verifySession } = require('../lib/auth');

test('password login fetches CSRF, persists the session cookie and accepts a retried CSRF token', async () => {
  const fake = await createFakeServer({ strictCsrf: true });
  try {
    const client = new CliClient({ baseUrl: fake.baseUrl });
    await loginPassword(client, { login: 'admin', password: 'pass' });
    assert.equal(client.username, 'admin');
    assert.equal(client.isAdmin, true);
    assert.ok(client.cookieJar.some(cookie => cookie.name === 'connect.sid'));
    assert.ok(client.csrfToken);
    assert.equal(await verifySession(client) !== null, true);

    client.csrfToken = '';
    const toggled = await client.put('/api/user/api-keys/1/enabled', { enabled: false });
    assert.equal(toggled.enabled, false);
    assert.ok(client.csrfToken, 'client should refresh CSRF after 403 and retry');
  } finally { await fake.close(); }
});

test('wrong password produces a 401 ApiError', async () => {
  const fake = await createFakeServer();
  try {
    const client = new CliClient({ baseUrl: fake.baseUrl });
    await assert.rejects(() => loginPassword(client, { login: 'admin', password: 'wrong' }), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.statusCode, 401);
      return true;
    });
  } finally { await fake.close(); }
});

test('2FA login requires a code and completes on the regenerated session', async () => {
  const fake = await createFakeServer({ twoFactor: true });
  try {
    const client = new CliClient({ baseUrl: fake.baseUrl });
    let pending;
    try { await loginPassword(client, { login: 'admin', password: 'pass' }); }
    catch (error) { pending = error; }
    assert.ok(pending instanceof TwoFactorRequired);
    const me = await completeTwoFactor(client, pending.userId, '123456');
    assert.equal(me.username, 'admin');
    assert.equal(fake.state.meCalls, 1);
  } finally { await fake.close(); }
});

test('API key login detects admin and sends the key header without CSRF', async () => {
  const fake = await createFakeServer();
  try {
    const client = new CliClient({ baseUrl: fake.baseUrl });
    const me = await loginApiKey(client, 'sk-admin');
    assert.equal(client.authType(), 'api-key');
    assert.equal(client.isAdmin, true);
    assert.equal(me.isAdmin, true);
    const keys = await client.get('/api/user/api-keys');
    assert.equal(keys.length, 1);
  } finally { await fake.close(); }
});

test('a valid key without management permission still logs in with a warning', async () => {
  const fake = await createFakeServer({ balance403: true });
  try {
    const client = new CliClient({ baseUrl: fake.baseUrl });
    const me = await loginApiKey(client, 'sk-user');
    assert.ok(me.warning);
    assert.match(client.authWarning, /缺少管理接口权限/);
    assert.equal(client.apiKey, 'sk-user');
  } finally { await fake.close(); }
});

test('invalid API key is rejected and cleared', async () => {
  const fake = await createFakeServer();
  try {
    const client = new CliClient({ baseUrl: fake.baseUrl });
    await assert.rejects(() => loginApiKey(client, 'sk-invalid'), error => {
      assert.equal(error.statusCode, 401);
      return true;
    });
    assert.equal(client.apiKey, '');
  } finally { await fake.close(); }
});

test('client rejects redirects and server errors with structured errors', async () => {
  const fake = await createFakeServer();
  try {
    const client = new CliClient({ baseUrl: fake.baseUrl });
    await client.refreshCsrfToken();
    await assert.rejects(() => client.get('/api/does-not-exist'), error => {
      assert.equal(error.statusCode, 401);
      return true;
    });
  } finally { await fake.close(); }
});
