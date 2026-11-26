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

test('OAuth device-code login polls until approval, stores a bearer token and calls the gateway', async () => {
  const fake = await createFakeServer({ oauthDeviceApproved: true });
  const oldHome = process.env.CR_CLI_HOME;
  process.env.CR_CLI_HOME = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'cr-cli-oauth-'));
  try {
    const { loginCommand } = require('../lib/commands/auth');
    const code = await loginCommand({ url: fake.baseUrl, profile: 'oauth-test', oauth: true }, { json: true });
    assert.equal(code, 0);
    const polls = fake.state.requests.filter(item => item.path === '/oauth/token');
    assert.equal(polls.length, 1);
    assert.equal(polls[0].body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
    const gateway = fake.state.requests.find(item => item.path === '/v1/models' && item.headers.authorization);
    assert.equal(gateway.headers.authorization, 'Bearer oauth-access-token');
    const saved = require('../lib/config').getSession('oauth-test');
    assert.equal(saved.authType, 'oauth');
    assert.equal(saved.oauthAccessToken, 'oauth-access-token');
  } finally {
    await fake.close();
    if (oldHome === undefined) delete process.env.CR_CLI_HOME;
    else process.env.CR_CLI_HOME = oldHome;
  }
});

test('OAuth device-code login reports user denial without storing credentials', async () => {
  const fake = await createFakeServer();
  const oldHome = process.env.CR_CLI_HOME;
  process.env.CR_CLI_HOME = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'cr-cli-oauth-deny-'));
  try {
    const { loginCommand } = require('../lib/commands/auth');
    fake.state.oauthDeviceApproved = 'denied';
    await assert.rejects(() => loginCommand({ url: fake.baseUrl, profile: 'oauth-denied', oauth: true }, { json: true }), /用户拒绝了设备授权/);
    assert.equal(require('../lib/config').getSession('oauth-denied'), null);
  } finally {
    await fake.close();
    if (oldHome === undefined) delete process.env.CR_CLI_HOME;
    else process.env.CR_CLI_HOME = oldHome;
  }
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
