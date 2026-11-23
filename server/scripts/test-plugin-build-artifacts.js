'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const build = fs.readFileSync(path.join(root, 'deploy/build/build-release.js'), 'utf8');
const registry = fs.readFileSync(path.join(root, 'server/plugins/registry.js'), 'utf8');
const docker = fs.readFileSync(path.join(root, 'deploy/docker/Dockerfile'), 'utf8');
const dockerSaas = fs.readFileSync(path.join(root, 'deploy/docker/Dockerfile.saas'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.match(build, /const pluginsSrc = path\.join\(ROOT, 'plugins'\)/);
assert.match(build, /copyDir\(pluginsSrc, pluginsDest\)/);
assert.match(registry, /path\.join\(__dirname, 'plugins'\)/);
assert.match(docker, /COPY plugins\/ \.\/plugins\//);
assert.match(dockerSaas, /COPY plugins\/ \.\/plugins\//);
assert.ok(packageJson.files.includes('plugins/**'));
for (const pluginId of ['all-capabilities', 'example-hello', 'usage-stats']) {
  const pluginDir = path.join(root, 'plugins', pluginId);
  assert.ok(fs.existsSync(path.join(pluginDir, 'plugin.json')), `${pluginId} manifest missing`);
}
console.log('PASS npm, release, Docker and SaaS build inputs include plugin manifests and resources');
