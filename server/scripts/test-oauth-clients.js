'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const clients = require('../utils/oauth-clients');

const noDb = {
  async query() {
    throw Object.assign(new Error('relation "oauth_clients" does not exist'), { code: '42P01' });
  },
};

const publicClient = {
  client_id: 'my-cli',
  name: 'My CLI',
  type: 'public',
  first_party: false,
  enabled: true,
  scopes: ['gateway:invoke'],
  redirect_uris: [
    'http://127.0.0.1/callback',
    'http://localhost/callback',
    'myapp://oauth/callback',
    'https://app.example.com/oauth/callback',
  ],
  allow_loopback_any_path: false,
};

const confidentialClient = {
  client_id: 'server-app',
  name: 'Server App',
  type: 'confidential',
  first_party: false,
  enabled: true,
  scopes: ['gateway:invoke'],
  redirect_uris: ['https://server.example.com/oauth/callback'],
  allow_loopback_any_path: false,
  secret_hash: clients.sha256Hex('top-secret'),
};

test('built-in clients remain public and accept arbitrary loopback paths', async () => {
  for (const id of ['crewrouter-desktop', 'crewrouter-helper', 'crewrouter-cli']) {
    const client = await clients.resolveClient(noDb, {}, id);
    assert.equal(client.client_id, id);
    assert.equal(client.type, 'public');
    assert.equal(client.first_party, true);
    assert.equal(client.allow_loopback_any_path, true);
  }
  const desktop = await clients.resolveClient(noDb, {}, 'crewrouter-desktop');
  assert.equal(clients.matchRedirectUri(desktop, 'http://127.0.0.1:43123/callback'), 'http://127.0.0.1:43123/callback');
  assert.equal(clients.matchRedirectUri(desktop, 'http://[::1]:43123/callback'), 'http://[::1]:43123/callback');
  assert.equal(clients.matchRedirectUri(desktop, 'http://localhost:43123/callback'), 'http://localhost:43123/callback');
  assert.equal(clients.matchRedirectUri(desktop, 'https://127.0.0.1/callback'), null);
  assert.equal(clients.matchRedirectUri(desktop, 'http://evil.example/callback'), null);
});

test('registered redirect URIs match exactly, with loopback ports ignored', () => {
  assert.equal(
    clients.matchRedirectUri(publicClient, 'http://127.0.0.1:53211/callback'),
    'http://127.0.0.1:53211/callback'
  );
  assert.equal(
    clients.matchRedirectUri(publicClient, 'http://localhost:53211/callback'),
    'http://localhost:53211/callback'
  );
  assert.equal(
    clients.matchRedirectUri(publicClient, 'myapp://oauth/callback'),
    'myapp://oauth/callback'
  );
  assert.equal(
    clients.matchRedirectUri(publicClient, 'https://app.example.com/oauth/callback'),
    'https://app.example.com/oauth/callback'
  );
  assert.equal(clients.matchRedirectUri(publicClient, 'https://app.example.com/oauth/callback/extra'), null);
  assert.equal(clients.matchRedirectUri(publicClient, 'https://app.example.com/oauth/callback?x=1'), null);
  assert.equal(clients.matchRedirectUri(publicClient, 'https://app.example.com/oauth/callback#frag'), null);
  assert.equal(clients.matchRedirectUri(publicClient, 'http://app.example.com/oauth/callback'), null);
  assert.equal(clients.matchRedirectUri(publicClient, 'javascript:alert(1)'), null);
  assert.equal(clients.matchRedirectUri(publicClient, 'https://user:pass@app.example.com/oauth/callback'), null);
});

test('custom scheme registration rejects unsafe or malformed values', () => {
  const invalid = clients.normalizeRedirectUris([
    'http://example.com/callback',
    'file:///tmp/callback',
    'javascript:alert(1)',
    'https://app.example.com/callback#fragment',
    'mailto:user@example.com',
    'tel:+10000000000',
    'https://app.example.com/callback',
  ]);
  assert.equal(invalid.ok, false);

  const valid = clients.normalizeRedirectUris([
    'https://app.example.com/callback',
    'myapp://oauth/callback',
    'http://127.0.0.1/callback',
  ]);
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.value, [
    'https://app.example.com/callback',
    'myapp://oauth/callback',
    'http://127.0.0.1/callback',
  ]);
});

test('scopes default to the client set and never escape it', async () => {
  assert.equal(clients.normalizeScopeRequest('', publicClient), 'gateway:invoke');
  assert.equal(clients.normalizeScopeRequest('gateway:invoke', publicClient), 'gateway:invoke');
  assert.equal(clients.normalizeScopeRequest('gateway:invoke events:report', publicClient), null);
  assert.equal(clients.normalizeScopeRequest('console:read', publicClient), null);
  assert.deepEqual(clients.normalizeScopes(['console:read']), ['console:read']);
  assert.deepEqual(clients.normalizeScopes(['gateway:invoke', 'events:report', 'console:read']), ['gateway:invoke', 'events:report', 'console:read']);
  assert.deepEqual(clients.normalizeScopes(['gateway:invoke', 'events:report']), ['gateway:invoke', 'events:report']);
});

test('PKCE challenge and verifier follow RFC 7636 syntax', () => {
  assert.equal(clients.isValidPkceChallenge('A'.repeat(43)), true);
  assert.equal(clients.isValidPkceChallenge('A'.repeat(42)), false);
  assert.equal(clients.isValidPkceChallenge('A'.repeat(42) + '='), false);
  assert.equal(clients.isValidPkceVerifier('A'.repeat(43)), true);
  assert.equal(clients.isValidPkceVerifier('A'.repeat(128)), true);
  assert.equal(clients.isValidPkceVerifier('A'.repeat(42)), false);
  assert.equal(clients.isValidPkceVerifier('A'.repeat(129)), false);
  assert.equal(clients.isValidPkceVerifier('bad verifier'.repeat(4)), false);
});

test('confidential clients require the correct secret', () => {
  assert.equal(clients.authenticateClient(confidentialClient, { headers: {} }, { client_id: 'server-app', client_secret: 'top-secret' }), true);
  assert.equal(clients.authenticateClient(confidentialClient, {
    headers: { authorization: 'Basic ' + Buffer.from('server-app:top-secret').toString('base64') },
  }, {}), true);
  assert.equal(clients.authenticateClient(confidentialClient, { headers: {} }, { client_id: 'server-app', client_secret: 'wrong' }), false);
  assert.equal(clients.authenticateClient(confidentialClient, { headers: {} }, { client_id: 'other', client_secret: 'top-secret' }), false);
  assert.equal(clients.authenticateClient(confidentialClient, { headers: {} }, { client_id: 'server-app' }), false);
  assert.equal(clients.authenticateClient(publicClient, { headers: {} }, { client_id: 'my-cli' }), true);
});

test('config.oauth.clients clients are resolved without touching the database', async () => {
  const config = {
    oauth: {
      clients: [{
        clientId: 'config-app',
        name: 'Config App',
        type: 'public',
        scopes: ['gateway:invoke'],
        redirectUris: ['http://127.0.0.1/callback'],
        enabled: true,
      }],
    },
  };
  const client = await clients.resolveClient(noDb, config, 'config-app');
  assert.equal(client.name, 'Config App');
  assert.equal(client.source, 'config');
  assert.equal(client.editable, false);
  assert.equal(clients.matchRedirectUri(client, 'http://127.0.0.1:3333/callback'), 'http://127.0.0.1:3333/callback');
  assert.equal(await clients.resolveClient(noDb, config, 'missing'), null);

  const weak = { oauth: { clients: [{
    clientId: 'weak-app', name: 'Weak', type: 'confidential', secret: 'short',
    scopes: ['gateway:invoke'], redirectUris: ['https://weak.example/callback'],
  }] } };
  assert.equal(await clients.resolveClient(noDb, weak, 'weak-app'), null);
});

test('database clients are normalised and merged into the admin list', async () => {
  const row = {
    client_id: 'db-app',
    name: 'DB App',
    first_party: false,
    client_type: 'confidential',
    redirect_uris: ['https://db.example.com/callback'],
    scopes: ['gateway:invoke'],
    allow_loopback_any_path: false,
    secret_hash: clients.sha256Hex('db-secret'),
    secret_hint: 'db-sec',
    description: 'database client',
    enabled: true,
    created_at: '2026-11-09T00:00:00.000Z',
    updated_at: '2026-11-09T00:00:00.000Z',
  };
  const pool = {
    async query(sql, params) {
      assert.match(sql, /oauth_clients/);
      if (params && params[0] === 'db-app') return { rows: [row] };
      return { rows: [row] };
    },
  };
  const client = await clients.resolveClient(pool, {}, 'db-app');
  assert.equal(client.type, 'confidential');
  assert.equal(client.secret_hint, 'db-sec');
  assert.equal(clients.authenticateClient(client, { headers: {} }, { client_id: 'db-app', client_secret: 'db-secret' }), true);

  const all = await clients.listClients(pool, {});
  const ids = all.map((item) => item.client_id);
  assert.ok(ids.includes('crewrouter-desktop'));
  assert.ok(ids.includes('db-app'));
  const view = clients.adminClientView(client);
  assert.equal(view.has_secret, true);
  assert.equal(Object.hasOwn(view, 'secret_hash'), false);
});

test('disabled clients are rejected by callers through the enabled flag', async () => {
  const pool = {
    async query() {
      return {
        rows: [{
          client_id: 'off-app', name: 'Off', first_party: false, client_type: 'public',
          redirect_uris: [], scopes: ['gateway:invoke'], allow_loopback_any_path: false,
          secret_hash: null, secret_hint: null, description: '', enabled: false,
          created_at: null, updated_at: null,
        }],
      };
    },
  };
  const client = await clients.resolveClient(pool, {}, 'off-app');
  assert.equal(client.enabled, false);
});
