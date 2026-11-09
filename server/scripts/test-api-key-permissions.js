'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const permissions = require('../utils/api-key-permissions');

test('permission catalog has unique grouped ids', () => {
  const ids = permissions.permissionIds();
  assert.ok(ids.length > 20);
  assert.equal(new Set(ids).size, ids.length);
  for (const group of permissions.CATALOG.groups) {
    assert.ok(group.permissions.length > 0);
    for (const permission of group.permissions) {
      assert.match(permission.id, /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/);
      assert.equal(permission.group, group.id);
    }
  }
});

test('route matching is method-aware and prefers specific routes', () => {
  assert.equal(permissions.matchPermission('POST', '/v1/chat/completions')?.id, 'gateway.chat');
  assert.equal(permissions.matchPermission('GET', '/v1/models')?.id, 'gateway.models');
  assert.equal(permissions.matchPermission('GET', '/api/user/api-keys')?.id, 'keys.read');
  assert.equal(permissions.matchPermission('GET', '/api/user/api-keys/12/config')?.id, 'keys.secret');
  assert.equal(permissions.matchPermission('GET', '/api/user/api-keys/12/members')?.id, 'keys.members');
  assert.equal(permissions.matchPermission('POST', '/api/user/api-keys/12/members')?.id, 'keys.members');
  assert.equal(permissions.matchPermission('PUT', '/api/user/api-keys/12')?.id, 'keys.write');
  assert.equal(permissions.matchPermission('GET', '/api/admin/users')?.id, 'admin.users.read');
  assert.equal(permissions.matchPermission('POST', '/api/admin/users/1/refund')?.id, 'admin.users.write');
  assert.equal(permissions.matchPermission('GET', '/api/agent/manage/threads')?.id, 'agent.manage');
  assert.equal(permissions.matchPermission('GET', '/api/plugins/example/runtime')?.id, 'plugins.read');
  assert.equal(permissions.matchPermission('GET', '/api/user/not-a-route'), null);
});

test('default permissions keep gateway access open', () => {
  const defaults = permissions.defaultPermissions();
  assert.ok(defaults.includes('gateway.messages'));
  assert.ok(defaults.includes('gateway.chat'));
  assert.deepEqual(defaults.sort(), permissions.CATALOG.groups
    .find((group) => group.id === 'gateway')
    .permissions.map((permission) => permission.id)
    .sort());
  for (const id of defaults) {
    assert.equal(permissions.permissionById(id).adminOnly, false);
  }
});

test('permission normalisation rejects unknown and malformed values', () => {
  assert.deepEqual(permissions.normalizePermissions(['gateway.chat', 'gateway.chat']), { ok: true, value: ['gateway.chat'] });
  assert.equal(permissions.normalizePermissions(['not.a.real.permission']).ok, false);
  assert.equal(permissions.normalizePermissions('gateway.chat').ok, false);
  assert.deepEqual(permissions.normalizePermissions(undefined), { ok: true, value: [] });
});

test('grant validation prevents privilege escalation', () => {
  const user = permissions.validateGrant(['gateway.chat'], { isAdmin: false, actorType: 'session' });
  assert.equal(user.ok, true);
  const admin = permissions.validateGrant(['admin.users.read'], { isAdmin: false, actorType: 'session' });
  assert.equal(admin.ok, false);
  const adminAllowed = permissions.validateGrant(['admin.users.read'], { isAdmin: true, actorType: 'session' });
  assert.equal(adminAllowed.ok, true);

  const keySubset = permissions.validateGrant(['gateway.chat'], {
    isAdmin: false,
    actorType: 'api_key',
    currentPermissions: ['gateway.chat', 'gateway.models'],
  });
  assert.equal(keySubset.ok, true);

  const keyEscalation = permissions.validateGrant(['gateway.models'], {
    isAdmin: false,
    actorType: 'api_key',
    currentPermissions: ['gateway.chat'],
  });
  assert.equal(keyEscalation.ok, false);
});

test('public catalog omits route patterns', () => {
  const catalog = permissions.publicCatalog();
  assert.ok(catalog.groups.length > 0);
  for (const group of catalog.groups) {
    for (const permission of group.permissions) {
      assert.equal(Object.hasOwn(permission, 'routes'), false);
      assert.equal(typeof permission.adminOnly, 'boolean');
    }
  }
});
