'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const express = require('express');
const editions = require('../utils/instance-edition');

function fixture({ deleted = false, admin = false, fail = false, edition = 'team' } = {}) {
  const calls = [];
  const module = { exports: {} };
  const dependencies = {
    '../models/database': { pool: { async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (fail) throw new Error('private-database-error');
      if (sql.includes('instance_settings')) return { rows: [{ edition }] };
      return { rows: deleted ? [] : [{ id: 7, is_admin: admin }] };
    } } },
    '../config-loader': { runtime: 'server' },
    '../utils/instance-edition': editions,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../middleware/auth.js'), 'utf8'), {
    module, require(name) {
      assert(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  return { ...module.exports, calls };
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}

const guards = ['requireAuth', 'requireAdmin', 'requireProviderAccessContext', 'requireProviderManager'];

test('all identity guards reject missing or malformed sessions without querying the database', async context => {
  for (const guard of guards) {
    for (const request of [{}, { session: {} }, { session: { user: {} } },
      ...[null, '', 0, -1, 'not-an-id', [], {}].map(id => ({ session: { user: { id } } }))]) {
      await context.test(`${guard}: ${JSON.stringify(request)}`, async () => {
        const auth = fixture();
        const result = response();
        await auth[guard](request, result, () => assert.fail('invalid identity reached handler'));
        assert.equal(result.statusCode, 401);
        assert.equal(auth.calls.length, 0);
      });
    }
  }
});

test('deleted users cannot pass any guard using an otherwise valid stale session', async context => {
  for (const guard of guards) await context.test(guard, async () => {
    const result = response();
    await fixture({ deleted: true })[guard]({ session: { user: { id: 7, isAdmin: true } } }, result,
      () => assert.fail('deleted user reached handler'));
    assert.equal(result.statusCode, 401);
  });
});

test('database failures fail closed and never disclose private errors', async context => {
  for (const guard of guards) await context.test(guard, async () => {
    const result = response();
    await fixture({ fail: true })[guard]({ session: { user: { id: 7 } } }, result,
      () => assert.fail('database failure reached handler'));
    assert.equal(result.statusCode, 503);
    assert(!JSON.stringify(result.body).includes('private-database-error'));
  });
});

test('fresh identity checks refresh cached administrator status and reject demoted administrators', async () => {
  const auth = fixture();
  const request = { session: { user: { id: 7, isAdmin: true } } };
  let passed = 0;
  await auth.requireAuth(request, response(), () => { passed++; });
  assert.equal(passed, 1);
  assert.equal(request.session.user.isAdmin, false);
  request.session.user.isAdmin = true;
  const result = response();
  await auth.requireAdmin(request, result, () => assert.fail('demoted administrator reached handler'));
  assert.equal(result.statusCode, 403);
  assert.equal(request.session.user.isAdmin, false);
});

test('administrator authority requires the database boolean true, not a truthy fixture or stale flag', async context => {
  for (const admin of [false, 'false', 'true', 1, null, undefined]) await context.test(String(admin), async () => {
    const result = response();
    await fixture({ admin }).requireAdmin({ session: { user: { id: 7, isAdmin: true } } }, result,
      () => assert.fail('non-boolean admin reached handler'));
    assert.equal(result.statusCode, 403);
  });
});

test('valid administrator and personal-provider policy remain available', async () => {
  let passed = 0;
  await fixture({ admin: true }).requireAdmin({ session: { user: { id: '7' } } }, response(), () => { passed++; });
  await fixture({ edition: 'personal' }).requireProviderManager({ session: { user: { id: 7 } } }, response(), () => { passed++; });
  assert.equal(passed, 2);
});

test('downstream exceptions are not swallowed or rewritten as permission failures', async context => {
  for (const guard of guards) await context.test(guard, async () => {
    const result = response();
    await assert.rejects(fixture({ admin: true })[guard]({ session: { user: { id: 7 } } }, result,
      () => { throw new Error('downstream-handler-error'); }), /downstream-handler-error/);
    assert.equal(result.statusCode, 200);
  });
});

test('real Express guard chain stops stale identities before the protected write handler', async context => {
  const auth = fixture({ deleted: true });
  const app = express();
  let writes = 0;
  app.use((request, result, next) => { request.session = { user: { id: 7, isAdmin: true } }; next(); });
  app.post('/protected', auth.requireAuth, (request, result) => { writes++; result.json({ ok: true }); });
  const listener = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  context.after(() => new Promise(resolve => listener.close(resolve)));
  const result = await fetch(`http://127.0.0.1:${listener.address().port}/protected`, { method: 'POST' });
  assert.equal(result.status, 401);
  assert.equal(writes, 0);
  assert(!require.cache[require.resolve('../models/database')]);
  assert(!require.cache[require.resolve('../config-loader')]);
});
