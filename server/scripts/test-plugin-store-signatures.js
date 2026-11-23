'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sqlCalls = [];
let dbRow;
const pool = { async query(sql, params = []) {
  const maxPlaceholder = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])));
  if (maxPlaceholder && maxPlaceholder !== params.length) throw new Error(`SQL placeholder count ${maxPlaceholder} != values ${params.length}`);
  sqlCalls.push({ sql, params });
  if (/INSERT INTO plugin_store_plugins/.test(sql)) {
    const values = params;
    dbRow = { id: values[0], name: values[1], version: values[2], author: values[3], author_username: values[4], description: values[5], long_description: values[6], url: values[7], icon: values[8], download: values[9], sha256: values[10], signature: values[11], signature_key_id: values[12], signature_algorithm: values[13], permissions: JSON.parse(values[14]), tags: JSON.parse(values[15]), screenshots: JSON.parse(values[16]), status: 'pending', reject_reason: '', install_count: 0 };
    return { rows: [dbRow] };
  }
  if (/SELECT \* FROM plugin_store_plugins WHERE id/.test(sql)) return { rows: dbRow ? [dbRow] : [] };
  if (/SET pending_update=\$2::jsonb/.test(sql)) {
    dbRow.pending_update = JSON.parse(params[1]);
    dbRow.pendingUpdate = dbRow.pending_update;
    return { rows: [dbRow] };
  }
  if (/UPDATE plugin_store_plugins SET/.test(sql) && /pending_update=\$22::jsonb/.test(sql)) {
    dbRow = { ...dbRow, version: params[2], sha256: params[9], signature: params[10], signature_key_id: params[11], signature_algorithm: params[12], permissions: JSON.parse(params[13]), status: params[16], pending_update: params[21] ? JSON.parse(params[21]) : null };
    return { rows: [dbRow] };
  }
  if (/UPDATE plugin_store_plugins SET/.test(sql) && /signature_algorithm=\$13/.test(sql) && /reviewed_by=\$17/.test(sql)) {
    dbRow = { ...dbRow, version: params[2], sha256: params[9], signature: params[10], signature_key_id: params[11], signature_algorithm: params[12], permissions: JSON.parse(params[13]), status: 'approved', pending_update: null, reviewed_by: params[16] };
    return { rows: [dbRow] };
  }
  throw new Error(`Unexpected SQL: ${sql}`);
} };
const filename = path.resolve(__dirname, '../store/store.js');
const fixtureModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  module: fixtureModule, exports: fixtureModule.exports, __dirname: path.dirname(filename), Buffer, URL, AbortController,
  setTimeout, clearTimeout, console,
  require(id) {
    if (id === 'fs') return fs;
    if (id === 'os') return require('node:os');
    if (id === 'path') return path;
    if (id === 'node:crypto') return require('node:crypto');
    if (id === './db') return { getPool: () => pool };
    if (id === '../logger') return { info() {}, warn() {}, error() {} };
    if (id === '../utils/url-validator') return { validateUrl: async () => ({ ok: false }) };
    if (id === '../proxy-pool') return {};
    if (id === '../plugins/zip') return { readZipManifest: async () => null, extractZipSafe() {}, findZipManifest() {}, zipPayloadDir() {} };
    throw new Error(`Unexpected dependency: ${id}`);
  },
});
(async () => {
  const store = fixtureModule.exports;
  const created = await store.createPlugin({ id: 'signature-demo', name: 'Signature Demo', version: '1.0.0', download: 'https://example.test/plugin.zip', sha256: 'ab'.repeat(32), signature: 'signed-v1', signatureKeyId: 'release-1', signatureAlgorithm: 'Ed25519', permissions: ['events:subscribe'] }, 'publisher');
  assert.equal(created.signature, 'signed-v1');
  assert.equal(created.signatureKeyId, 'release-1');
  assert.equal(created.signatureAlgorithm, 'Ed25519');
  dbRow.status = 'approved';
  await store.updatePlugin('signature-demo', { version: '1.1.0', sha256: 'cd'.repeat(32), permissions: ['events:subscribe', 'models:read'], signature: 'signed-v2', signatureKeyId: 'release-1', signatureAlgorithm: 'Ed25519' }, { username: 'publisher' });
  assert.equal(dbRow.pending_update.signature, 'signed-v2');
  assert.equal(dbRow.pending_update.signatureKeyId, 'release-1');
  assert.equal(dbRow.pending_update.signatureAlgorithm, 'Ed25519');
  assert.deepEqual(dbRow.pending_update.permissions, ['events:subscribe', 'models:read']);
  await store.reviewPlugin('signature-demo', 'approve', '', 'reviewer');
  assert.equal(dbRow.signature, 'signed-v2');
  assert.equal(dbRow.signature_key_id, 'release-1');
  assert.equal(dbRow.signature_algorithm, 'Ed25519');
  assert.equal(dbRow.status, 'approved');
  assert.ok(sqlCalls.every(call => call.sql.trim()));
  console.log('PASS store publisher signature fields persist through create, pending update and approval with aligned SQL');
})().catch(error => { console.error(error); process.exitCode = 1; });
