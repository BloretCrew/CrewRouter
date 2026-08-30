'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const identity = require('../utils/user-identity');
assert.strictEqual(identity.normalizeEmail('  User@Example.COM '), 'user@example.com');
assert.strictEqual(identity.normalizeEmail(undefined), undefined);
assert.strictEqual(identity.normalizeEmail(null), null);
assert.strictEqual(identity.normalizeEmail('   '), null);
assert.throws(() => identity.normalizeEmail('invalid'), error => error.code === 'invalid_email');
assert.strictEqual(identity.isUniqueViolation({ code: '23505' }), true);
assert.strictEqual(identity.isUniqueViolation({ code: '23503' }), false);

const paths = {
  'routes/setup.js': { writes: /INSERT INTO users[\s\S]*email/, catches: /isUniqueViolation\(error\)/ },
  'routes/admin.js': { writes: /UPDATE users SET \$\{sets\.join\('\, '\)\}/, catches: /isUniqueViolation\(error\)/ },
  'routes/user.js': { writes: /UPDATE users SET \$\{sets\.join\('\, '\)\}/, catches: /isUniqueViolation\(error\)/ },
  'routes/passport-auth.js': { writes: /INSERT INTO users[\s\S]*email/, catches: /isUniqueViolation\(error\)/ },
  'routes/feishu.js': { writes: /INSERT INTO users[\s\S]*email|UPDATE users SET[^\n]*email/, catches: /isUniqueViolation\(error\)/ },
  'routes/oauth-github.js': { writes: /UPDATE users SET github_id/, catches: /isUniqueViolation\(error\)/ },
};
for (const [file, contract] of Object.entries(paths)) {
  const source = read(file);
  assert.match(source, /normalizeEmail/, `${file} must use shared email normalizer`);
  assert.match(source, contract.writes, `${file} must cover its user email-related path`);
  assert.match(source, contract.catches, `${file} must catch PostgreSQL 23505`);
  assert.ok(!/email\.toLowerCase\(\)\.trim\(\)/.test(source), `${file} has an unshared normalizer`);
}

const init = read('scripts/init-db.js');
const migration = read('index.js');
for (const source of [init, migration]) {
  assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique/);
  assert.match(source, /ON users \(LOWER\(email\)\) WHERE email IS NOT NULL/);
}
const passport = read('routes/passport-auth.js');
const feishu = read('routes/feishu.js');
assert.ok(!/emailCheck|SELECT 1 FROM users WHERE LOWER\(email\)/.test(passport), 'Passport must not pre-check email before INSERT');
assert.ok(!/const raced = await pool\.query/.test(feishu), 'Feishu must not recover a raced INSERT by SELECT');
const passkey = read('routes/passkey.js');
assert.match(passkey, /不(?:创建或修改|写入) users\.email/, 'Passkey email non-write behavior must be documented');
const auth = read('routes/auth.js');
assert.match(auth, /不写入 users\.email/, 'password email non-write behavior must be documented');
const github = read('routes/oauth-github.js');
assert.match(github, /不写入 users\.email/, 'GitHub email non-write behavior must be documented');
console.log('email TOCTOU normalization, unique-index, conflict handling, and path contracts passed');
