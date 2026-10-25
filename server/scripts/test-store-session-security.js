'use strict';

// Pure synthetic configuration and signed-cookie fixtures. No application
// configuration, database, external identity provider or application logger.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { isStoreSessionSecretValid } = require('../utils/store-session-secret');
const storeState = require('../utils/passport-store-state');

const NOW = 1_800_000_000_000;
const SECRET = crypto.randomBytes(32).toString('base64url');
const noLog = { info() {}, warn() {}, error() {} };
const USER = { username: '合成用户', avatar: 'https://images.example.test/avatar.png', admin: false };

function loadSession() {
  const file = path.resolve(__dirname, '../store/session.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, Buffer,
    Date: class extends Date { static now() { return NOW; } },
    require(name) {
      if (name === '../logger') return noLog;
      return name.startsWith('.') ? require(path.resolve(path.dirname(file), name)) : require(name);
    },
  }, { filename: file });
  return module.exports;
}

const session = loadSession();
const body = overrides => ({ ...USER, iat: NOW, ...overrides });
function signPayload(payload, secret = SECRET, prefix = '') {
  return payload + '.' + crypto.createHmac('sha256', secret).update(prefix + payload).digest('base64url');
}
function signed(value, secret = SECRET) {
  return signPayload(Buffer.from(JSON.stringify(value)).toString('base64url'), secret);
}
function decoded(value) { return session.decodeSession(value, SECRET); }

test('random signing secrets work across independent instances without changing privilege', () => {
  for (const admin of [false, true]) {
    const value = session.encodeSession({ ...USER, admin }, SECRET);
    const user = loadSession().decodeSession(value, SECRET);
    assert.equal(user.username, USER.username);
    assert.equal(user.avatar, USER.avatar);
    assert.equal(user.admin, admin);
    assert.equal(user.iat, NOW);
  }
  assert.equal(decoded(session.encodeSession({ username: 'alice', admin: false }, SECRET)).avatar, '');
});

test('only bounded string secrets of at least 32 UTF-8 bytes pass', () => {
  const minimum = crypto.randomBytes(24).toString('base64url');
  assert.equal(Buffer.byteLength(minimum), 32);
  assert.equal(isStoreSessionSecretValid(minimum), true);
  assert.equal(isStoreSessionSecretValid(crypto.randomBytes(3072).toString('base64url')), true);
  for (const secret of [undefined, null, true, 42, [], {}, Buffer.alloc(32), '', minimum.slice(1),
    SECRET + ' ', ' ' + SECRET, SECRET + '\n', SECRET + '\x00', SECRET + '\ud800', 'x'.repeat(4097), '字'.repeat(1366)]) {
    assert.equal(isStoreSessionSecretValid(secret), false);
    assert.equal(session.decodeSession(signed(body()), secret), null);
    assert.throws(() => session.encodeSession(USER, secret), error => error.code === 'PASSPORT_NOT_CONFIGURED');
  }
});

test('known defaults and templates cannot mint or verify a forged administrator cookie', () => {
  for (const secret of ['change-me-in-production', 'your-session-secret-here',
    'your-store-session-signing-secret', 'YOUR-STORE-SESSION-SIGNING-SECRET']) {
    const forged = signed(body({ username: 'synthetic-admin', admin: true }), secret);
    assert.equal(session.decodeSession(forged, secret), null);
    assert.throws(() => session.encodeSession({ ...USER, admin: true }, secret),
      error => error.code === 'PASSPORT_NOT_CONFIGURED');
  }
});

test('signature tampering, key rotation and non-string cookie values fail closed', () => {
  const value = session.encodeSession(USER, SECRET);
  assert.equal(session.decodeSession(value, crypto.randomBytes(32).toString('hex')), null);
  const [payload, signature] = value.split('.');
  assert.equal(decoded(payload + '.' + (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)), null);
  for (const candidate of [undefined, null, true, 1, [], {}, Buffer.from(value), '', value + '.extra']) {
    assert.equal(decoded(candidate), null);
  }
});

test('administrator claims are strictly boolean on both issuance and verification', () => {
  for (const admin of ['false', 'true', '0', '1', 0, 1, null, undefined, [], {}]) {
    assert.equal(decoded(signed(body({ admin }))), null);
    assert.throws(() => session.encodeSession({ ...USER, admin }, SECRET),
      error => error.code === 'PASSPORT_SESSION_INVALID');
  }
});

test('usernames must be bounded nonempty strings without whitespace edges or controls', () => {
  for (const username of ['', ' ', ' alice', 'alice ', [], {}, true, 1, null, undefined,
    'a'.repeat(256), 'alice\n', 'alice\x00', 'alice\x7f', '\ud800']) {
    assert.equal(decoded(signed(body({ username }))), null);
    assert.throws(() => session.encodeSession({ ...USER, username }, SECRET),
      error => error.code === 'PASSPORT_SESSION_INVALID');
  }
  assert.equal(decoded(signed(body({ username: 'a'.repeat(255) }))).username.length, 255);
});

test('avatars cannot be coerced from objects or exceed their length bound', () => {
  for (const avatar of [[], {}, true, 1, null, 'x'.repeat(2049), 'https://example.test/\n', '\ud800']) {
    assert.equal(decoded(signed(body({ avatar }))), null);
    assert.throws(() => session.encodeSession({ ...USER, avatar }, SECRET),
      error => error.code === 'PASSPORT_SESSION_INVALID');
  }
  assert.equal(decoded(signed(body({ avatar: 'x'.repeat(2048) }))).avatar.length, 2048);
  assert.equal(decoded(signed(body({ avatar: undefined }))), null);
});

test('only the defined session object shape is accepted', () => {
  for (const value of [null, true, 1, 'alice', [], [body()], {}, { ...body(), unexpected: true }]) {
    assert.equal(decoded(signed(value)), null);
  }
  for (const value of [null, undefined, true, 1, [], 'alice']) {
    assert.throws(() => session.encodeSession(value, SECRET), error => error.code === 'PASSPORT_SESSION_INVALID');
  }
});

test('issued-at must be a positive safe integer rather than a coercible value', () => {
  for (const iat of [String(NOW), 'not-a-date', NaN, Infinity, null, undefined, 0, -1,
    NOW + 0.5, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
    assert.equal(decoded(signed(body({ iat }))), null);
  }
});

test('expiration is exact and future timestamps have at most 60 seconds clock tolerance', () => {
  assert(decoded(signed(body({ iat: NOW - session.MAX_AGE_MS + 1 }))));
  assert.equal(decoded(signed(body({ iat: NOW - session.MAX_AGE_MS }))), null);
  assert(decoded(signed(body({ iat: NOW + session.MAX_CLOCK_SKEW_MS }))));
  assert.equal(decoded(signed(body({ iat: NOW + session.MAX_CLOCK_SKEW_MS + 1 }))), null);
  assert.equal(decoded(signed(body({ iat: NOW + 365 * 24 * 60 * 60 * 1000 }))), null);
});

test('both signing and decoding enforce a total cookie size limit', () => {
  assert.equal(decoded(signed(body({ avatar: 'x'.repeat(100000) }))), null);
  // Individually valid fields still must fit a browser cookie after UTF-8/base64.
  assert.throws(() => session.encodeSession({ ...USER, username: '字'.repeat(255), avatar: 'x'.repeat(2048) }, SECRET),
    error => error.code === 'PASSPORT_SESSION_INVALID');
});

test('noncanonical base64url and invalid UTF-8 are rejected even with a valid signature', () => {
  const payload = Buffer.from(JSON.stringify(body())).toString('base64url');
  for (const value of [payload + '=', payload + '\n', payload + '!', 'A']) {
    assert.equal(decoded(signPayload(value)), null);
  }
  let bytes = Buffer.from(JSON.stringify(body()));
  if (bytes.length % 3 === 0) bytes = Buffer.concat([bytes, Buffer.from(' ')]);
  const canonical = bytes.toString('base64url');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const noncanonical = canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.at(-1)) ^ 1];
  assert.equal(Buffer.from(noncanonical, 'base64url').toString('base64url'), canonical);
  assert.equal(decoded(signPayload(noncanonical)), null);
  const malformed = Buffer.concat([Buffer.from('{"username":"'), Buffer.from([0xff]),
    Buffer.from('","avatar":"","admin":false,"iat":' + NOW + '}')]);
  assert.equal(decoded(signPayload(malformed.toString('base64url'))), null);
});

test('request parsing ignores unrelated cookies and never throws for malformed target encoding', () => {
  const value = session.encodeSession(USER, SECRET);
  const read = cookie => session.readSessionFromReq({ headers: { cookie } }, SECRET);
  assert.equal(read('unrelated=%ZZ; bl_store_session=' + value).username, USER.username);
  assert.equal(read('bl_store_session=' + encodeURIComponent(value)).username, USER.username);
  for (const cookie of [undefined, null, [], {}, 'bl_store_session=%ZZ', 'bl_store_session=%E0%A4%A',
    'bl_store_session=', 'bl_store_session=' + 'x'.repeat(3801), 'other=' + 'x'.repeat(16384),
    'bl_store_session=' + value + '; bl_store_session=' + value,
    'bl_store_session=; bl_store_session=' + value, 'bl_store_session=' + value + '; bl_store_session=']) {
    assert.equal(read(cookie), null);
  }
  assert.equal(session.readSessionFromReq(null, SECRET), null);
});

test('cookie issuance validates before setting a response cookie and preserves protections', () => {
  let set;
  let cleared;
  const res = { cookie(name, value, opts) { set = { name, value, opts }; }, clearCookie(name, opts) { cleared = { name, opts }; } };
  assert.throws(() => session.setSessionCookie(res, { ...USER, admin: 'false' }, SECRET, true));
  assert.equal(set, undefined);
  session.setSessionCookie(res, USER, SECRET, true);
  assert.equal(set.name, session.COOKIE_NAME);
  assert.equal(set.opts.httpOnly, true);
  assert.equal(set.opts.secure, true);
  assert.equal(set.opts.sameSite, 'lax');
  assert.equal(set.opts.path, '/');
  assert.equal(set.opts.domain, undefined);
  session.clearSessionCookie(res, true);
  assert.equal(cleared.name, set.name);
  assert.equal(cleared.opts.path, set.opts.path);
  assert.equal(cleared.opts.secure, set.opts.secure);
});

function stateFixture(secret = SECRET) {
  const cfg = { isConfigured: true, appId: 'synthetic-app', appSecret: 'synthetic-app-secret',
    sessionSecret: secret, baseUrl: 'https://passport.example.test' };
  const callback = 'https://router.example.test/store/auth/callback';
  const req = { secure: true, headers: {}, query: {} };
  let cookie;
  const res = { cookie(name, value) { cookie = { name, value }; }, clearCookie() {} };
  const flow = storeState.issueState(req, res, cfg, callback, '/store', NOW);
  req.query = { code: 'synthetic-code', state: flow.state };
  req.headers.cookie = cookie.name + '=' + cookie.value;
  function replaceBody(overrides) {
    const original = JSON.parse(Buffer.from(cookie.value.split('.')[0], 'base64url').toString('utf8'));
    const payload = Buffer.from(JSON.stringify({ ...original, ...overrides })).toString('base64url');
    req.headers.cookie = cookie.name + '=' + signPayload(payload, secret, 'crewrouter-store-oauth\0');
  }
  return { cfg, callback, req, res, cookie, replaceBody,
    consume: () => storeState.consumeState(req, res, cfg, callback, NOW + 1) };
}

test('OAuth state issuance and consumption enforce the same signing-secret policy', () => {
  for (const secret of ['short-secret', 'your-store-session-signing-secret', 'change-me-in-production', {}, Buffer.alloc(32)]) {
    assert.throws(() => stateFixture(secret), error => error.code === 'PASSPORT_STATE_INVALID');
    const f = stateFixture();
    f.cfg.sessionSecret = secret;
    assert.throws(f.consume, error => error.code === 'PASSPORT_STATE_INVALID');
  }
  assert.equal(stateFixture().consume().code, 'synthetic-code');
});

test('OAuth state rejects malformed, oversized and ambiguous cookie headers', () => {
  for (const replacement of [undefined, null, [], {}, '%ZZ', '%E0%A4%A', 'x'.repeat(3801)]) {
    const f = stateFixture();
    f.req.headers.cookie = typeof replacement === 'string' ? f.cookie.name + '=' + replacement : replacement;
    assert.throws(f.consume, error => error.code === 'PASSPORT_STATE_INVALID');
  }
  for (const variant of ['duplicate', 'large-header']) {
    const f = stateFixture();
    f.req.headers.cookie += variant === 'duplicate' ? '; ' + f.req.headers.cookie : '; other=' + 'x'.repeat(16384);
    assert.throws(f.consume, error => error.code === 'PASSPORT_STATE_INVALID');
  }
});

test('OAuth state requires canonical payload encoding and bounded integer expiration', () => {
  for (const expiresAt of [String(NOW + 1000), NOW + 1000.5, NOW + storeState.STATE_TTL_MS + 2,
    NOW, Number.MAX_SAFE_INTEGER + 1, null, {}, []]) {
    const f = stateFixture();
    f.replaceBody({ expiresAt });
    assert.throws(f.consume, error => error.code === 'PASSPORT_STATE_INVALID');
  }
  for (const returnTo of [null, {}, [], '//attacker.example.test', '/..//attacker.example.test', '/store?x=' + 'a'.repeat(1024)]) {
    const f = stateFixture();
    f.replaceBody({ returnTo });
    assert.throws(f.consume, error => error.code === 'PASSPORT_STATE_INVALID');
  }
  const f = stateFixture();
  const payload = f.cookie.value.split('.')[0] + '=';
  f.req.headers.cookie = f.cookie.name + '=' + signPayload(payload, SECRET, 'crewrouter-store-oauth\0');
  assert.throws(f.consume, error => error.code === 'PASSPORT_STATE_INVALID');
});

function loadPassportConfig(env = {}) {
  const file = path.resolve(__dirname, '../store/passport.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, Buffer, URLSearchParams, process: { env },
    require(name) {
      if (name === '../logger') return noLog;
      if (name === '../utils/passport-verifier') return { verifyPassportCode() { throw new Error('External exchange forbidden in this test'); } };
      return name.startsWith('.') ? require(path.resolve(path.dirname(file), name)) : require(name);
    },
  }, { filename: file });
  return module.exports.getPassportConfig;
}

test('actual store configuration rejects the Core default and accepts a strong explicit key', () => {
  const getConfig = loadPassportConfig();
  const config = { app: { sessionSecret: 'change-me-in-production' }, store: { passport: {
    appId: 'synthetic-private-app', appSecret: crypto.randomBytes(32).toString('hex'),
  } } };
  const invalid = getConfig(config);
  assert.equal(invalid.sessionSecret, '');
  assert.equal(invalid.isConfigured, false);
  config.app.sessionSecret = SECRET;
  const valid = getConfig(config);
  assert.equal(valid.sessionSecret, SECRET);
  assert.equal(valid.isConfigured, true);
});

test('an explicitly invalid signing-key source cannot fall back to a lower-priority source', () => {
  const config = { app: { sessionSecret: SECRET }, store: { sessionSecret: SECRET,
    passport: { appId: 'synthetic-private-app', appSecret: crypto.randomBytes(32).toString('hex'), sessionSecret: SECRET } } };
  for (const value of ['', null, false, 123, 'short-secret', 'your-store-session-signing-secret']) {
    for (const env of [{ CR_STORE_SESSION_SECRET: value, PASSPORT_SESSION_SECRET: SECRET }, { PASSPORT_SESSION_SECRET: value }]) {
      const cfg = loadPassportConfig(env)(config);
      assert.equal(cfg.sessionSecret, '');
      assert.equal(cfg.isConfigured, false);
    }
    for (const selected of [
      { ...config, store: { ...config.store, passport: { ...config.store.passport, sessionSecret: value } } },
      { ...config, store: { sessionSecret: value, passport: { ...config.store.passport, sessionSecret: undefined } } },
    ]) {
      assert.equal(loadPassportConfig()(selected).sessionSecret, '');
    }
  }
});

test('the isolated tests never load application config, database or logger', () => {
  for (const name of ['../config-loader', '../store/db', '../logger']) {
    assert.equal(require.cache[require.resolve(name)], undefined);
  }
});
