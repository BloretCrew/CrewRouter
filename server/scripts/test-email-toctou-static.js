'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = ['routes/setup.js', 'routes/admin.js', 'routes/passport-auth.js', 'routes/feishu.js'];
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(source, /normalizeEmail/, `${file} must normalize email`);
  assert.ok(!/email\.toLowerCase\(\)\.trim\(\)/.test(source), `${file} has an unshared normalizer`);
}
const init = fs.readFileSync(path.join(root, 'scripts/init-db.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
assert.match(init, /users_email_lower_unique/);
assert.match(migration, /users_email_lower_unique/);
assert.match(init, /WHERE email IS NOT NULL/);
assert.match(migration, /WHERE email IS NOT NULL/);
const identity = require('../utils/user-identity');
assert.strictEqual(identity.normalizeEmail('  User@Example.COM '), 'user@example.com');
assert.strictEqual(identity.normalizeEmail(''), null);
assert.throws(() => identity.normalizeEmail('invalid'), /邮箱格式无效/);
console.log('email TOCTOU normalization and partial unique-index contracts passed');
