'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../plugins/plugin-manifest.schema.json'), 'utf8'));
const host = fs.readFileSync(path.resolve(__dirname, '../plugins/host.js'), 'utf8');
const permissions = new Set([...host.matchAll(/'([a-z][a-z0-9:_-]+)'/g)].map(m => m[1]));
const examples = ['all-capabilities', 'example-capabilities', 'example-events', 'example-hello', 'example-isolated-task', 'example-isolated-hooks', 'example-theme', 'usage-stats', 'webhook-demo'];
for (const id of examples) {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../plugins/${id}/plugin.json`), 'utf8'));
  assert.equal(manifest.id, id);
  assert.ok(schema.required.every(key => Object.hasOwn(manifest, key)), `${id} missing schema-required field`);
  for (const permission of manifest.permissions || []) assert.ok(permissions.has(permission), `${id} declares unknown permission ${permission}`);
}
assert.ok(schema.properties.routes.items.properties.auth.enum.includes('none'));
assert.ok(schema.properties.executionMode.enum.includes('isolated-task'));
assert.ok(schema.properties.executionMode.enum.includes('isolated-hooks'));
assert.equal(schema.properties.taskHandlers.type, 'array');
assert.ok(schema.properties.permissions.items.maxLength > 0);
console.log('PASS plugin manifest schema files parse and example permissions align with host inventory');
