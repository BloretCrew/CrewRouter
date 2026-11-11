'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../routes/user.js'), 'utf8');
const start = source.indexOf("router.put('/settings'");
const end = source.indexOf('// ========== 兑换码', start);
assert(start >= 0 && end > start);

function fixture(fail = false) {
  let handler;
  const writes = [], invalidations = [];
  vm.runInNewContext(source.slice(start, end), {
    router: { put(_path, ...handlers) { handler = handlers.at(-1); } },
    requireAuth() {}, auditMiddleware() {}, ACTIONS: {},
    normalizeEmail: value => value?.toLowerCase(), isUniqueViolation: () => false,
    Logger: { error() {} },
    pool: { async query(sql, params) {
      if (fail) throw new Error('isolated write failure');
      writes.push({ sql, params: [...params] });
    } },
    invalidateUserApiKeyCache: id => invalidations.push(id),
  });
  return { writes, invalidations, async request(body) {
    const user = { id: 7, api_signature_enabled: true };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
    await handler({ body, authUser: user }, res);
    return { user, res };
  } };
}

test('signature false and template updates persist and invalidate inherited key policy', async () => {
  for (const body of [{ api_signature_enabled: false }, { api_signature_template: 'new template' }, { api_signature_enabled: true }]) {
    const f = fixture();
    const { user, res } = await f.request(body);
    assert.equal(res.body.success, true);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.invalidations, [7]);
    for (const [field, value] of Object.entries(body)) {
      assert.equal(user[field], value);
      assert(f.writes[0].sql.includes(`${field} = $2`));
      assert.equal(f.writes[0].params[1], value);
    }
  }
});

test('unrelated settings and failed writes keep signature cache intact', async () => {
  const f = fixture();
  await f.request({ avatar: '/avatar.png' });
  assert.deepEqual(f.invalidations, []);
  const failed = fixture(true);
  const { user, res } = await failed.request({ api_signature_enabled: false });
  assert.equal(res.statusCode, 500);
  assert.equal(user.api_signature_enabled, true);
  assert.deepEqual(failed.invalidations, []);
});
