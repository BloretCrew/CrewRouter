'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

test('desktop ships embedded PostgreSQL with optional platform binaries', () => {
  assert.ok(manifest.dependencies['embedded-postgres']);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
    assert.equal(Object.keys(dependencies).some((name) => name.startsWith('@embedded-postgres/')), false);
  }
  const embedded = lock.packages['node_modules/embedded-postgres'];
  for (const platform of ['linux-x64', 'windows-x64', 'darwin-arm64', 'darwin-x64']) {
    const name = `@embedded-postgres/${platform}`;
    assert.ok(embedded.optionalDependencies[name], `${name} must be optional`);
    assert.equal(lock.packages[`node_modules/${name}`].optional, true);
  }
  assert.ok(manifest.build.asarUnpack.includes('node_modules/@embedded-postgres/**/*'));
  assert.ok(manifest.build.asarUnpack.includes('node_modules/embedded-postgres/**/*'));
});

test('each desktop platform references an existing packaging icon', () => {
  for (const platform of ['linux', 'win', 'mac']) {
    const icon = manifest.build[platform].icon;
    assert.equal(fs.existsSync(path.join(root, icon)), true, `${platform} icon is missing: ${icon}`);
  }
});


test('client configuration parsers are production dependencies included in packaging', () => {
  for (const name of ['@iarna/toml', 'json5', 'jsonc-parser', 'yaml']) {
    assert.ok(manifest.dependencies[name]);
    assert.notEqual(lock.packages[`node_modules/${name}`].dev, true);
    assert.ok(manifest.build.files.includes(`node_modules/${name}/**/*`));
    assert.ok(require(name));
  }
});
