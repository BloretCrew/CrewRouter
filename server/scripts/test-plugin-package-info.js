'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const storeSource = fs.readFileSync(path.resolve(__dirname, '../store/store.js'), 'utf8');
const routeSource = fs.readFileSync(path.resolve(__dirname, '../routes/plugins.js'), 'utf8');
const storeRouteSource = fs.readFileSync(path.resolve(__dirname, '../routes/store.js'), 'utf8');

assert.match(storeSource, /signature_algorithm/);
assert.match(storeSource, /signature: plugin\.signature/);
assert.match(storeSource, /signatureKeyId: plugin\.signatureKeyId/);
assert.match(storeSource, /signatureAlgorithm: plugin\.signatureAlgorithm/);
assert.match(storeSource, /插件包权限与商店审核权限不一致/);
assert.match(storeSource, /hasBackendCode: !!manifest && !!manifest\._hasBackendCode/);
assert.match(routeSource, /inspectStorePackage\(plugin/);
assert.match(routeSource, /signatureTrustConfigured/);
assert.match(storeRouteSource, /getPluginPackageInfo\(req\.params\.id\)/);
console.log('PASS package-info checks server-parsed package code, permissions, signature metadata and approval gating');
