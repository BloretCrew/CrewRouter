'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { hasPassportCredentials, isRetiredPassportSecret } = require('../utils/passport-credentials');

const loaderSource = fs.readFileSync(path.resolve(__dirname, '../config-loader.js'), 'utf8');
const helperSource = fs.readFileSync(path.resolve(__dirname, '../utils/passport-credentials.js'), 'utf8');
const fixturePath = '/isolated-passport-test/config.json';
const fixtureCredentials = { appId: 'test-app', appSecret: 'offline-app-secret' };

function loadConfig(file = {}, environment = {}, { missing = false } = {}) {
  const calls = { reads: [], logs: [] };
  const fakeFs = {
    existsSync(candidate) { assert.equal(candidate, fixturePath); return !missing; },
    readFileSync(candidate, encoding) {
      assert.equal(candidate, fixturePath); assert.equal(encoding, 'utf8');
      calls.reads.push(candidate);
      return JSON.stringify(file);
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(loaderSource, {
    module, exports: module.exports, __dirname: '/isolated-passport-test/server',
    process: { env: { CR_CONFIG_PATH: fixturePath, ...environment }, cwd: () => '/isolated-passport-test' },
    console: { log: (...args) => calls.logs.push(args.join(' ')), warn: (...args) => calls.logs.push(args.join(' ')) },
    require(name) {
      if (name === 'fs') return fakeFs;
      if (name === 'path') return path;
      throw new Error(`Unexpected config-loader dependency: ${name}`);
    },
  }, { filename: 'isolated-config-loader.js' });
  return { config: module.exports, calls };
}

test('credentials require a complete pair of bounded, non-template strings', () => {
  assert.equal(hasPassportCredentials(fixtureCredentials), true);
  assert.equal(hasPassportCredentials({ appId: 'app', appSecret: 'secret' }), true);
  assert.equal(hasPassportCredentials({ appId: 'a'.repeat(255), appSecret: 's'.repeat(4096) }), true);
  for (const cfg of [null, undefined, false, [], 'not-an-object', {}, { appId: 'app' }, { appSecret: 'secret' }]) {
    assert.equal(hasPassportCredentials(cfg), false);
  }
  for (const field of ['appId', 'appSecret']) {
    for (const value of [null, undefined, 42, true, {}, [], '', ' ', '\n', ' x', 'x ', 'x y', 'x\0y', 'x\x7fy',
      'your-passport-app-secret', 'YOUR_APP_ID', 'replace-me', 'change-me', '<app-secret>', '${APP_SECRET}', '{{APP_SECRET}}']) {
      assert.equal(hasPassportCredentials({ ...fixtureCredentials, [field]: value }), false, `${field} rejects invalid fixture`);
    }
  }
  assert.equal(hasPassportCredentials({ ...fixtureCredentials, appId: 'a'.repeat(256) }), false);
  assert.equal(hasPassportCredentials({ ...fixtureCredentials, appSecret: 's'.repeat(4097) }), false);
});

test('retired secret fingerprint blocks copied legacy credentials without retaining the secret in fixtures', () => {
  const retiredFingerprint = 'c65f0fce271122257dc98848df6b6dcc316dcc114a03287876aa0f53ffd8f94e';
  const module = { exports: {} };
  const hashed = [];
  // Inject only the digest for a fictional retired value. All other hashes use
  // real crypto; neither the original shared secret nor production config is read.
  vm.runInNewContext(helperSource, { module, exports: module.exports, require(name) {
    assert.equal(name, 'node:crypto');
    return { createHash(algorithm) {
      assert.equal(algorithm, 'sha256');
      let value;
      return {
        update(input, encoding) { assert.equal(encoding, 'utf8'); value = input; hashed.push(input); return this; },
        digest(encoding) {
          assert.equal(encoding, 'hex');
          return value === 'retired-fixture-only' ? retiredFingerprint : crypto.createHash(algorithm).update(value, 'utf8').digest(encoding);
        },
      };
    } };
  } });
  assert.equal(module.exports.isRetiredPassportSecret('retired-fixture-only'), true);
  assert.equal(module.exports.hasPassportCredentials({ appId: 'test-app', appSecret: 'retired-fixture-only' }), false);
  assert.equal(module.exports.hasPassportCredentials(fixtureCredentials), true);
  assert.equal(hashed.includes('retired-fixture-only'), true);
  for (const value of [null, undefined, 1, {}, [], '', 's'.repeat(4097), 'offline-app-secret']) {
    assert.equal(isRetiredPassportSecret(value), false);
  }
});

test('missing, empty and malformed passport configuration never restores shared credentials or crashes', () => {
  const absent = loadConfig({}, {}, { missing: true });
  assert.equal(absent.calls.reads.length, 0);
  assert.equal(absent.config.passport.appId, '');
  assert.equal(absent.config.passport.appSecret, '');
  for (const passport of [undefined, null, false, 3, 'invalid', [], {}, { appId: '', appSecret: '' },
    { appId: 'test-app' }, { appSecret: 'offline-app-secret' }, { appId: {}, appSecret: [] }]) {
    const { config, calls } = loadConfig({ passport });
    assert.equal(typeof config.passport, 'object');
    assert.equal(Array.isArray(config.passport), false);
    assert.equal(hasPassportCredentials(config.passport), false);
    assert.deepEqual(calls.reads, [fixturePath]);
  }
});

test('explicit file credentials work; environment wins without numeric or boolean coercion', () => {
  assert.equal(hasPassportCredentials(loadConfig({ passport: fixtureCredentials }).config.passport), true);
  const { config, calls } = loadConfig({ passport: fixtureCredentials }, {
    CR_PASSPORT_APP_ID: '000123', CR_PASSPORT_APP_SECRET: '000456', CR_APP_PORT: '21003',
  });
  assert.equal(config.passport.appId, '000123');
  assert.equal(config.passport.appSecret, '000456');
  assert.equal(config.app.port, 21003);
  assert.equal(hasPassportCredentials(config.passport), true);
  assert.equal(calls.logs.join('\n').includes('000456'), false);
  assert.equal(loadConfig({}, { CR_PASSPORT_APP_SECRET: 'true' }).config.passport.appSecret, 'true');
});

test('explicit empty environment credentials disable configured file credentials', () => {
  for (const key of ['CR_PASSPORT_APP_ID', 'CR_PASSPORT_APP_SECRET']) {
    const { config } = loadConfig({ passport: fixtureCredentials }, { [key]: '' });
    assert.equal(hasPassportCredentials(config.passport), false);
  }
  const { config } = loadConfig({ passport: null }, {
    CR_PASSPORT_APP_ID: 'test-app', CR_PASSPORT_APP_SECRET: 'offline-app-secret',
  });
  assert.equal(hasPassportCredentials(config.passport), true);
});

test('configuration example contains no active main PassPort credentials', () => {
  const example = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config.example.json'), 'utf8'));
  assert.equal(example.passport.appId, '');
  assert.equal(example.passport.appSecret, '');
  assert.equal(hasPassportCredentials(example.passport), false);
  assert.equal(hasPassportCredentials(example.store.passport), false);
});
