'use strict';

// Offline exchange regressions. No deployment configuration, logger, database,
// authorization endpoint or network transport is loaded by these fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const { createPassportVerifier, MAX_RESPONSE_BYTES, VERIFY_TIMEOUT_MS } = require('../utils/passport-verifier');
const { validateUrl: realValidateUrl } = require('../utils/url-validator');

const config = { appId: 'offline-app', appSecret: 'synthetic-exchange-secret', baseUrl: 'https://passport.example.test' };
const code = 'synthetic-one-use-code';
const identity = { username: 'alice', apptoken: 'synthetic-user-token', admin: false };
const sensitive = [config.appSecret, code, identity.apptoken, 'synthetic-password-hash', 'remote-sensitive-error'];
const addresses = [{ address: '93.184.216.34', family: 4 }];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const json = (value, options) => new Response(JSON.stringify(value), options);

function fixture(overrides = {}) {
  const calls = [];
  const checks = [];
  const verify = createPassportVerifier({
    validateUrl: async (url, opts) => {
      checks.push(url);
      assert.equal(opts.allowPrivate, false);
      assert.equal(new URL(url).search, '');
      for (const marker of sensitive) assert(!url.includes(marker));
      return { ok: true, url: new URL(url), addresses };
    },
    pinnedFetchValidated: async (check, options) => {
      calls.push({ check, options });
      assert.equal(check.addresses, addresses, 'reuse the DNS snapshot');
      assert.equal(options.redirect, 'manual');
      return json(identity);
    },
    ...overrides,
  });
  return { verify, calls, checks };
}

async function failure(promise, expectedCode) {
  let caught;
  try { await promise; } catch (error) { caught = error; }
  assert(caught, 'the exchange must reject');
  assert.equal(caught.code, expectedCode);
  assert.deepEqual(Object.keys(caught), ['code'], 'never attach raw response, URL, payload, cause or transport properties');
  for (const marker of sensitive) assert(!util.inspect(caught, { depth: 20 }).includes(marker), 'errors must not disclose secrets');
  return caught;
}

function loadStore(verifyPassportCode, logs = []) {
  const filename = path.resolve(__dirname, '../store/passport.js');
  const module = { exports: {} };
  const mocks = {
    '../logger': Object.fromEntries(['info', 'warn', 'error'].map(name => [name, (...args) => logs.push(args)])),
    '../utils/passport-verifier': { verifyPassportCode },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, URL, URLSearchParams, process: { env: {} },
    require(name) {
      if (mocks[name]) return mocks[name];
      assert(['../utils/passport-credentials', '../utils/store-session-secret'].includes(name), `Unexpected dependency: ${name}`);
      return require(path.resolve(path.dirname(filename), name));
    },
  }, { filename });
  return module.exports;
}

async function main() {
  assert.equal(VERIFY_TIMEOUT_MS, 10000);
  for (const method of ['GET', 'POST']) {
    const f = fixture();
    const result = await f.verify(config, code, { method, requireAppToken: true });
    assert.deepEqual(result, identity);
    assert.equal(f.calls.length, 1);
    const { check, options } = f.calls[0];
    assert.equal(options.method, method);
    assert.equal(check.url.pathname, '/app/verify');
    const params = method === 'GET' ? Object.fromEntries(check.url.searchParams) : JSON.parse(options.body);
    assert.deepEqual(params, { app_id: config.appId, app_secret: config.appSecret, code });
    if (method === 'GET') assert.equal(options.body, undefined);
    else {
      assert.equal(check.url.search, '');
      assert.equal(options.headers['Content-Type'], 'application/json');
    }
  }
  for (const appSecret of ['', ' ', 'replace-me', 'your-passport-app-secret', ['secret'], 123]) {
    const f = fixture();
    await failure(f.verify({ ...config, appSecret }, code), 'PASSPORT_NOT_CONFIGURED');
    assert.equal(f.checks.length + f.calls.length, 0);
  }
  for (const invalidCode of ['', ' ', ['code'], {}, 'x'.repeat(4097), 'code\nlog']) {
    const f = fixture();
    await failure(f.verify(config, invalidCode), 'MISSING_CODE');
    assert.equal(f.checks.length + f.calls.length, 0);
  }
  for (const baseUrl of ['http://passport.example.test', 'https://user:pass@passport.example.test',
    'https://passport.example.test/?secret=hidden', 'https://passport.example.test/#hidden', 'not-a-url']) {
    const f = fixture();
    await failure(f.verify({ ...config, baseUrl }, code), 'PASSPORT_URL_REJECTED');
    assert.equal(f.checks.length + f.calls.length, 0);
  }
  for (const baseUrl of ['https://127.0.0.1', 'https://169.254.169.254', 'https://[::1]', 'https://localhost']) {
    const f = fixture({ validateUrl: realValidateUrl });
    await failure(f.verify({ ...config, baseUrl }, code), 'PASSPORT_URL_REJECTED');
    assert.equal(f.calls.length, 0);
  }
  const remoteError = Object.assign(new Error(sensitive.join('|')), { response: { data: sensitive }, config: { url: sensitive.join('/') }, cause: new Error(code) });
  for (const stage of ['validateUrl', 'pinnedFetchValidated']) {
    const f = fixture({ [stage]: async () => { throw remoteError; } });
    await failure(f.verify(config, code, { method: 'GET' }), 'PASSPORT_REQUEST_FAILED');
  }
  for (const value of [null, [], true, 123, 'text', { data: null }, { data: [] }, { username: 42 },
    { username: '' }, { username: 'x'.repeat(256) }, { username: 'alice\nadmin' }, { username: '\ud800' }, { username: 'alice', avatar: {} },
    { username: 'alice', nickname: 'x'.repeat(256) }, { username: 'alice', email: 'x'.repeat(256) },
    { username: 'alice', avatar: 'x'.repeat(2049) }, { username: 'alice', nickname: '\ud800' },
    { username: 'alice', email: 'alice\n@example.test' }, { username: 'alice', avatar: 'https://example.test\r' }]) {
    const f = fixture({ pinnedFetchValidated: async () => json(value) });
    await failure(f.verify(config, code), 'PASSPORT_BAD_RESPONSE');
  }
  for (const value of [{ ...identity, error: sensitive.join('|') }, { ...identity, code: 401 },
    { ...identity, success: false }, { code: 0, data: { ...identity, error: 'remote-sensitive-error' } }]) {
    const f = fixture({ pinnedFetchValidated: async () => json(value) });
    await failure(f.verify(config, code), 'PASSPORT_VERIFY_FAILED');
  }
  await failure(fixture({ pinnedFetchValidated: async () => new Response(sensitive.join('|')) }).verify(config, code), 'PASSPORT_BAD_RESPONSE');
  const malformedUtf8 = Buffer.concat([Buffer.from('{"username":"ali'), Buffer.from([0xc3, 0x28]), Buffer.from('ce"}')]);
  await failure(fixture({ pinnedFetchValidated: async () => new Response(malformedUtf8) }).verify(config, code), 'PASSPORT_BAD_RESPONSE');
  for (const status of [302, 400, 401, 404, 500]) {
    let calls = 0;
    let canceled = false;
    const f = fixture({ pinnedFetchValidated: async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { canceled = true; } }), { status, headers: { Location: 'https://other.example.test' } });
    } });
    await failure(f.verify(config, code), 'PASSPORT_VERIFY_FAILED');
    assert.equal(calls, 1, 'never retry or follow redirects for an authorization code');
    assert(canceled, 'cancel rejected HTTP bodies without reading remote error text');
  }
  for (const apptoken of [undefined, '', [], 42]) {
    const f = fixture({ pinnedFetchValidated: async () => json({ username: 'alice', apptoken }) });
    await failure(f.verify(config, code, { requireAppToken: true }), 'PASSPORT_BAD_RESPONSE');
    assert.equal((await f.verify(config, code, { requireAppToken: false })).username, 'alice');
  }
  for (const wrapped of [false, true]) {
    const raw = { ...identity, username: ' alice ', password: 'synthetic-password-hash' };
    const f = fixture({ pinnedFetchValidated: async () => json(wrapped ? { code: 0, data: raw } : raw) });
    assert.deepEqual(await f.verify(config, code), { username: 'alice', admin: false });
  }
  const storeLogs = [];
  const store = loadStore(fixture().verify, storeLogs);
  assert.equal((await store.verifyCode(config, code)).username, 'alice');
  for (const flag of [false, 'true', '1', 1, [], {}, null, undefined]) {
    assert.equal(store.isAdminUser('alice', flag, {}), false);
    const f = fixture({ pinnedFetchValidated: async () => json({ username: 'alice', admin: flag }) });
    assert.equal((await f.verify(config, code)).admin, false);
  }
  assert.equal(store.isAdminUser('alice', true, {}), true);
  assert.equal(store.isAdminUser('alice', 'true', { adminUsernames: ['alice'] }), true);
  const failedStore = loadStore(fixture({ pinnedFetchValidated: async () => { throw remoteError; } }).verify, storeLogs);
  await failure(failedStore.verifyCode(config, code), 'PASSPORT_REQUEST_FAILED');
  assert.deepEqual(storeLogs, [], 'exchange helpers must never log response bodies or transport errors');

  const prefix = JSON.stringify({ username: 'alice', ignored: '' });
  const exactLimit = JSON.stringify({ username: 'alice', ignored: 'a'.repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(prefix)) });
  assert.equal(Buffer.byteLength(exactLimit), MAX_RESPONSE_BYTES);
  assert.equal((await fixture({ pinnedFetchValidated: async () => new Response(exactLimit) }).verify(config, code)).username, 'alice');
  for (const declaredLength of [false, true]) {
    let canceled = false;
    let signal;
    const f = fixture({ pinnedFetchValidated: async (_check, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from(exactLimit + ' ')); },
        cancel() { canceled = true; },
      }), { headers: declaredLength ? { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) } : {} });
    } });
    await failure(f.verify(config, code), 'PASSPORT_RESPONSE_TOO_LARGE');
    assert(canceled);
    assert(signal.aborted);
  }
  let streamCanceled = false;
  let streamSignal;
  const stalled = fixture({ timeoutMs: 20, pinnedFetchValidated: async (_check, options) => {
    streamSignal = options.signal;
    return new Response(new ReadableStream({ cancel() { streamCanceled = true; return new Promise(() => {}); } }));
  } });
  await failure(stalled.verify(config, code), 'PASSPORT_TIMEOUT');
  assert(streamCanceled);
  assert(streamSignal.aborted);

  const dns = deferred();
  const slowDns = fixture({ timeoutMs: 20, validateUrl: () => dns.promise });
  await failure(slowDns.verify(config, code), 'PASSPORT_TIMEOUT');
  dns.resolve({ ok: true, url: new URL(config.baseUrl + '/app/verify'), addresses });
  await sleep(0);
  assert.equal(slowDns.calls.length, 0, 'late DNS resolution must not start a credential exchange');

  const pendingResponse = deferred();
  let lateSignal;
  const slowHeaders = fixture({ timeoutMs: 20, pinnedFetchValidated: async (_check, options) => { lateSignal = options.signal; return pendingResponse.promise; } });
  await failure(slowHeaders.verify(config, code), 'PASSPORT_TIMEOUT');
  assert(lateSignal.aborted);
  let lateCanceled = false;
  pendingResponse.resolve(new Response(new ReadableStream({ cancel() { lateCanceled = true; } })));
  await sleep(0);
  assert(lateCanceled, 'cancel even a transport response that arrives after the deadline');

  let pieces = 0;
  let dripCanceled = false;
  const drip = fixture({ timeoutMs: 35, pinnedFetchValidated: async () => new Response(new ReadableStream({
    async pull(controller) { await sleep(10); if (!dripCanceled) { pieces++; controller.enqueue(Buffer.from(' ')); } },
    cancel() { dripCanceled = true; },
  })) });
  await failure(drip.verify(config, code), 'PASSPORT_TIMEOUT');
  assert(pieces > 0);
  assert(dripCanceled, 'receiving chunks must not reset the total deadline');
  await failure(fixture({ pinnedFetchValidated: async () => new Response(new ReadableStream({ start(controller) { controller.error(remoteError); } })) }).verify(config, code), 'PASSPORT_REQUEST_FAILED');
  console.log('PassPort verifier security: all offline checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
