'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');
const speakeasy = require('speakeasy');
const { metadata } = require('../utils/instance-edition');

const source = fs.readFileSync(path.join(__dirname, '../routes/feishu.js'), 'utf8');
const secret = 'JBSWY3DPEHPK3PXP';

function fixture(options = {}) {
  const routes = new Map();
  const calls = { upstream: [], updates: [], audits: [], passwords: 0, saves: 0, regenerations: 0, destroys: 0 };
  const user = { id: 7, username: 'existing', email: 'existing@example.test', password_hash: 'fixture-hash',
    two_factor_enabled: true, totp_secret: { base32: secret }, feishu_open_id: null, is_admin: true,
    ...options.user };
  const config = { enabled: true, appId: 'fixture-app', appSecret: 'fixture-secret', tenantKey: 'fixture-tenant', ...options.config };
  const pool = { async query(sql, params) {
    if (sql.startsWith('SELECT * FROM users WHERE id =')) return { rows: options.missingUser ? [] : [{ ...user }] };
    if (sql.startsWith('SELECT * FROM users WHERE feishu_open_id =')) return { rows: options.byOpenId ? [{ ...user }] : [] };
    if (sql.startsWith('SELECT * FROM users WHERE LOWER(email) =')) return { rows: options.match === 'email' ? [{ ...user }] : [] };
    if (sql.startsWith('SELECT * FROM users WHERE username =')) return { rows: options.match === 'username' ? [{ ...user }] : [] };
    if (sql.startsWith('UPDATE users SET feishu_open_id =')) {
      calls.updates.push({ sql, params });
      return { rowCount: options.updateCount ?? 1, rows: [{ ...user, feishu_open_id: params[0], avatar: params[1] || user.avatar }] };
    }
    if (sql.startsWith('UPDATE users SET avatar =')) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  } };
  const module = { exports: {} };
  const dependency = (name) => {
    if (name === 'express') return { Router() { return {
      get(url, handler) { routes.set(`GET ${url}`, handler); },
      post(url, handler) { routes.set(`POST ${url}`, handler); },
    }; } };
    if (name === '../models/database') return { pool };
    if (name === '../logger') return { info() {}, warn() {}, error() {} };
    if (name === '../config-loader') return { edition: options.edition || 'team' };
    if (name === '../utils/auth-mode') return { getAuthMode: async () => options.mode || 'feishu' };
    if (name === '../utils/instance-edition') return { metadata, loadPersistedEdition: async () => options.edition || 'team' };
    if (name === '../utils/feishu-config') return {
      getFeishuConfig: async () => config, isFeishuLoginAvailable: async () => true,
      buildRedirectUri: () => 'https://router.example.test/auth/feishu/callback',
      getCachedAppAccessToken: () => 'fixture-app-token', setCachedAppAccessToken() {},
    };
    if (name === '../utils/login-reporter') return { reportLoginEvent() {} };
    if (name === '../utils/audit-log') return {
      ACTIONS: { AUTH_BIND_FEISHU: 'auth.bind_feishu' }, logAction: async (event) => calls.audits.push(event),
    };
    if (name === 'bcryptjs') return { compare: async (password, hash) => {
      calls.passwords += 1;
      return password === 'correct-password' && hash === 'fixture-hash';
    } };
    if (name === '../utils/pinned-axios') return { pinnedAxiosRequest: async (url) => {
      calls.upstream.push(url);
      if (url.endsWith('/oidc/access_token')) return { data: { code: 0, data: { access_token: 'fixture-user-token' } } };
      if (url.endsWith('/user_info')) return { data: { code: 0, data: { open_id: 'new-feishu-id',
        name: 'existing', email: 'existing@example.test', tenant_key: 'fixture-tenant', ...options.identity } } };
      throw new Error('Unexpected upstream endpoint');
    } };
    if (['crypto', 'speakeasy', '../utils/user-identity'].includes(name)) return require(name);
    throw new Error(`Unexpected dependency: ${name}`);
  };
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', {
    process: { env: { CR_RUNTIME: options.runtime || 'server' } },
    setInterval: () => ({ unref() {} }), Date, URL, URLSearchParams,
  }, { filename: 'feishu-security-fixture.js' })(dependency, module, module.exports);

  function request(overrides = {}) {
    const req = { ip: '192.0.2.7', headers: {}, body: {}, query: {}, sessionID: 'before-login', ...overrides };
    function attach(data) {
      return Object.assign(data, {
        save(callback) { calls.saves += 1; callback(options.saveError || (calls.saves === options.failSaveAt ? new Error('offline store') : null)); },
        regenerate(callback) { calls.regenerations += 1; req.sessionID = 'after-login'; req.session = attach({}); callback(); },
        destroy(callback) {
          calls.destroys += 1;
          if (options.destroyThrows) throw new Error('offline cleanup failure');
          req.session = null;
          callback();
        },
      });
    }
    req.session = attach(overrides.session || {});
    return req;
  }
  function pending(extra = {}) {
    return { feishuOpenId: 'new-feishu-id', feishuName: 'existing', existingUserId: user.id,
      existingUsername: user.username, requiresTwoFactor: user.two_factor_enabled,
      configurationHash: crypto.createHash('sha256').update(JSON.stringify([config.appId, config.appSecret, config.tenantKey || ''])).digest('hex'),
      expiresAt: Date.now() + 60000, attempts: 0, ...extra };
  }
  async function invoke(route, req) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }, redirect(url) { this.statusCode = 302; this.location = url; return this; } };
    await routes.get(route)(req, res);
    return res;
  }
  async function callbackRequest() {
    const req = request();
    await invoke('GET /feishu', req);
    req.query = { code: 'fixture-code', state: req.session.feishuState };
    return req;
  }
  return { calls, user, config, request, pending, invoke, callbackRequest };
}

test('a correct password cannot bind a local account protected by 2FA', async () => {
  const f = fixture();
  const req = f.request({ session: { feishuPending: f.pending() }, body: { password: 'correct-password' } });
  const res = await f.invoke('POST /feishu/bind', req);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.requiresTwoFactor, true);
  assert.equal(f.calls.updates.length, 0);
  assert.equal(req.session.user, undefined);
});

for (const [label, value] of [['JSONB object', { base32: secret }], ['JSON string', JSON.stringify({ base32: secret })],
  ['double JSON string', JSON.stringify(JSON.stringify({ base32: secret }))], ['legacy base32', secret]]) {
  test(`valid password and TOTP bind using ${label}, rotate session, and audit`, async () => {
    const f = fixture({ user: { totp_secret: value } });
    const req = f.request({ session: { feishuPending: f.pending(), user: { id: 999 } },
      body: { password: 'correct-password', code: speakeasy.totp({ secret, encoding: 'base32' }) } });
    const res = await f.invoke('POST /feishu/bind', req);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(f.calls.updates.length, 1);
    assert.match(f.calls.updates[0].sql, /password_hash = \$4/);
    assert.match(f.calls.updates[0].sql, /two_factor_enabled IS NOT DISTINCT FROM \$5/);
    assert.match(f.calls.updates[0].sql, /totp_secret IS NOT DISTINCT FROM \$6::jsonb/);
    assert.equal(req.session.user.id, 7);
    assert.equal(req.session.feishuPending, undefined);
    assert.equal(f.calls.regenerations, 1);
    assert.equal(f.calls.audits[0].action, 'auth.bind_feishu');
    assert.equal(f.calls.audits[0].details.twoFactorVerified, true);
  });
}

test('invalid password cannot be substituted with a valid TOTP', async () => {
  const f = fixture();
  const req = f.request({ session: { feishuPending: f.pending() },
    body: { password: 'incorrect', code: speakeasy.totp({ secret, encoding: 'base32' }) } });
  assert.equal((await f.invoke('POST /feishu/bind', req)).statusCode, 401);
  assert.equal(f.calls.updates.length, 0);
});

test('a non-2FA account retains the password-only binding path', async () => {
  const f = fixture({ user: { two_factor_enabled: false, totp_secret: null } });
  const req = f.request({ session: { feishuPending: f.pending() }, body: { password: 'correct-password' } });
  assert.equal((await f.invoke('POST /feishu/bind', req)).statusCode, 200);
  assert.equal(f.calls.updates.length, 1);
});

test('binding refuses a different existing identity and stale credential snapshots', async () => {
  for (const options of [{ user: { feishu_open_id: 'other-id' } }, { updateCount: 0 }]) {
    const f = fixture(options);
    const req = f.request({ session: { feishuPending: f.pending() },
      body: { password: 'correct-password', code: speakeasy.totp({ secret, encoding: 'base32' }) } });
    assert.equal((await f.invoke('POST /feishu/bind', req)).statusCode, 409);
    assert.equal(req.session.user, undefined);
  }
});

test('expired, old-format, and exhausted pending challenges cannot bind', async () => {
  for (const extra of [{ expiresAt: Date.now() - 1 }, { expiresAt: undefined }, { attempts: 5 }]) {
    const f = fixture();
    const req = f.request({ session: { feishuPending: f.pending(extra) }, body: { password: 'correct-password' } });
    assert.equal((await f.invoke('POST /feishu/bind', req)).statusCode, 400);
    assert.equal(f.calls.passwords, 0);
    assert.equal(req.session.feishuPending, undefined);
  }
});

test('fresh pending sessions cannot reset the IP/account attempt limit', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) {
    const req = f.request({ session: { feishuPending: f.pending() }, body: { password: 'incorrect' } });
    const res = await f.invoke('POST /feishu/bind', req);
    assert.equal(res.statusCode, i < 5 ? 401 : 429);
  }
  assert.equal(f.calls.passwords, 5);
});

for (const options of [{ mode: 'passport' }, { edition: 'personal' }, { runtime: 'desktop-local' }, { config: { enabled: false } }]) {
  test(`binding and callback enforce current method policy: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    const req = f.request({ session: { feishuPending: f.pending() }, body: { password: 'correct-password' } });
    assert.equal((await f.invoke('POST /feishu/bind', req)).statusCode, 403);
    const callback = f.request({ query: { code: 'fixture-code', state: 'fixture-state' },
      session: { feishuState: 'fixture-state', feishuStateExpiresAt: Date.now() + 60000 } });
    await f.invoke('GET /feishu/callback', callback);
    assert.equal(f.calls.upstream.length, 0);
    assert.equal(f.calls.updates.length, 0);
  });
}

for (const match of ['email', 'username']) {
  test(`a ${match} match requires explicit local credential proof`, async () => {
    const f = fixture({ match });
    const req = await f.callbackRequest();
    const res = await f.invoke('GET /feishu/callback', req);
    assert.equal(res.location, '/feishu-bind');
    assert.equal(f.calls.updates.length, 0);
    assert.equal(req.session.user, undefined);
    assert.equal(req.session.feishuPending.existingUserId, 7);
    assert.equal(req.session.feishuPending.requiresTwoFactor, true);
    assert.ok(req.session.feishuPending.expiresAt > Date.now());
    assert.equal(f.calls.regenerations, 1);
    assert.equal(f.calls.saves, 3);
  });
}

test('missing and expired callback state are rejected before upstream access', async () => {
  for (const session of [{}, { feishuState: 'fixture-state', feishuStateExpiresAt: Date.now() - 1 }]) {
    const f = fixture();
    const req = f.request({ session, query: { code: 'fixture-code', state: 'fixture-state' } });
    assert.equal((await f.invoke('GET /feishu/callback', req)).location, '/?error=feishu_state_invalid');
    assert.equal(f.calls.upstream.length, 0);
  }
});

test('pending save failure and malformed provider identities fail closed', async () => {
  for (const options of [{ saveError: new Error('offline store') }, { identity: { open_id: undefined } }]) {
    const f = fixture({ match: 'email', ...options });
    const req = await f.callbackRequest();
    const res = await f.invoke('GET /feishu/callback', req);
    assert.match(res.location, /error=/);
    assert.equal(f.calls.updates.length, 0);
    assert.equal(req.session.user, undefined);
  }
});

test('changing app, secret, or tenant invalidates issued callback and binding challenges', async () => {
  for (const key of ['appId', 'appSecret', 'tenantKey']) {
    const callbackFixture = fixture({ match: 'email' });
    const callback = await callbackFixture.callbackRequest();
    callbackFixture.config[key] = 'changed-configuration';
    assert.equal((await callbackFixture.invoke('GET /feishu/callback', callback)).location, '/?error=feishu_state_invalid');
    assert.equal(callbackFixture.calls.upstream.length, 0);

    const f = fixture({ match: 'email', user: { two_factor_enabled: false } });
    const req = await f.callbackRequest();
    assert.equal((await f.invoke('GET /feishu/callback', req)).location, '/feishu-bind');
    f.config[key] = 'changed-configuration';
    req.body = { password: 'correct-password' };
    assert.equal((await f.invoke('POST /feishu/bind', req)).statusCode, 400);
    assert.equal(f.calls.updates.length, 0);
    assert.equal(req.session.feishuPending, undefined);
  }
});

test('binding page presents the second factor and submits it to the protected endpoint', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/pages/feishu-bind.html'), 'utf8');
  assert.match(html, /id="twoFactorCode"[^>]*autocomplete="one-time-code"/);
  assert.match(html, /setTwoFactorRequired\(data\.requiresTwoFactor === true\)/);
  assert.match(html, /JSON\.stringify\(\{ password, code:/);
});

test('failed final session saves destroy authenticated state in callback and binding paths', async () => {
  const f = fixture({ failSaveAt: 3, byOpenId: true, user: { feishu_open_id: 'new-feishu-id' } });
  const callback = await f.callbackRequest();
  assert.equal((await f.invoke('GET /feishu/callback', callback)).location, '/?error=session_failed');
  assert.equal(f.calls.destroys, 1);
  assert.equal(callback.session, null);

  const binding = fixture({ failSaveAt: 2, user: { two_factor_enabled: false } });
  const req = binding.request({ session: { feishuPending: binding.pending() }, body: { password: 'correct-password' } });
  assert.equal((await binding.invoke('POST /feishu/bind', req)).statusCode, 500);
  assert.equal(binding.calls.updates.length, 1);
  assert.equal(binding.calls.audits.length, 1, 'already completed binding remains audited');
  assert.equal(binding.calls.destroys, 1);
  assert.equal(req.session, null);
});

test('session cleanup errors cannot leave an authenticated request eligible for implicit save', async () => {
  const f = fixture({ failSaveAt: 2, destroyThrows: true, user: { two_factor_enabled: false } });
  const req = f.request({ session: { feishuPending: f.pending() }, body: { password: 'correct-password' } });
  assert.equal((await f.invoke('POST /feishu/bind', req)).statusCode, 500);
  assert.equal(req.session, undefined);
  assert.equal(f.calls.destroys, 1);
});
