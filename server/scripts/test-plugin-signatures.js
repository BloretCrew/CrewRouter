'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let config = { store: {} };
const filename = path.resolve(__dirname, '../plugins/store-client.js');
const fixtureModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  module: fixtureModule, exports: fixtureModule.exports, Buffer, URL, AbortController, setTimeout, clearTimeout,
  require(id) {
    if (id === 'crypto') return crypto;
    if (id === 'fs') return fs;
    if (id === '../logger') return { warn() {}, info() {}, error() {} };
    if (id === '../utils/url-validator') return { validateUrl: async () => ({ ok: true }) };
    if (id === '../proxy-pool') return {};
    if (id === './zip') return { extractZipSafe() {}, findZipManifest() {}, zipPayloadDir() {} };
    if (id === 'node:path') return path;
    if (id === 'node:os') return require('node:os');
    if (id === '../config-loader') return config;
    throw new Error(`Unexpected dependency ${id}`);
  },
});
const api = fixtureModule.exports;
const pair = crypto.generateKeyPairSync('ed25519');
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
const sha256 = 'ab'.repeat(32);
const id = 'test-plugin';
const version = '1.2.3';
const message = `crewrouter-plugin-v1\n${id}\n${version}\n${sha256}`;
const signature = crypto.sign(null, Buffer.from(message), pair.privateKey).toString('base64');

assert.equal(api.verifyPluginSignature({ id, version, sha256, signature, keyId: 'release-1' }).mode, 'administrator-trust');
assert.equal(api.verifyPluginSignature({ id, version, sha256, signature, keyId: 'release-1' }).verified, false);
config = { store: { pluginSigningKeys: { 'release-1': publicPem } } };
assert.equal(api.verifyPluginSignature({ id, version, sha256, signature, keyId: 'release-1' }).verified, true);
assert.throws(() => api.verifyPluginSignature({ id, version, sha256, signature, keyId: 'unknown' }), /不受信任/);
assert.throws(() => api.verifyPluginSignature({ id, version: '9.9.9', sha256, signature, keyId: 'release-1' }), /签名校验失败/);
assert.throws(() => api.verifyPluginSignature({ id, version, sha256: 'bad', signature, keyId: 'release-1' }), /摘要格式无效/);
config = { store: { pluginSigningKeys: { 'release-1': publicPem } } };
assert.equal(api.hasTrustedPluginSigningKeys(), true);
console.log('PASS Ed25519 plugin publisher signature, trusted key selection and tamper rejection');
