'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const workflow = YAML.parse(fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/build-desktop.yml'), 'utf8'));

test('Desktop CI rebuilds the kernel from the current revision and shares it across platforms', () => {
  const kernel = workflow.jobs.kernel;
  assert.equal(kernel.needs, 'test');
  assert.ok(kernel.steps.some((step) => step.uses === 'actions/checkout@v4' && !step.with?.ref));
  assert.ok(kernel.steps.some((step) => step.run === 'npm ci'));
  assert.ok(kernel.steps.some((step) => step.run === 'npm run build'));
  const upload = kernel.steps.find((step) => step.uses === 'actions/upload-artifact@v4');
  assert.equal(upload.with.name, 'crewrouter-desktop-kernel-${{ github.sha }}');
  assert.deepEqual(upload.with.path.trim().split('\n'), ['dist/server.js', 'dist/model-trace-worker.js', 'dist/package.json', 'dist/public/', 'dist/lang/']);
  assert.equal(upload.with['if-no-files-found'], 'error');

  const packaging = workflow.jobs.package;
  assert.deepEqual(packaging.needs, ['test', 'kernel']);
  assert.deepEqual(packaging.strategy.matrix.include.map((entry) => entry.platform), ['linux', 'windows', 'macos-arm64', 'macos-x64']);
  assert.ok(packaging.steps[1].with['cache-dependency-path'].includes('CrewRouter-Desktop/server-staging/package-lock.json'));
  const downloadIndex = packaging.steps.findIndex((step) => step.uses === 'actions/download-artifact@v4');
  const stageIndex = packaging.steps.findIndex((step) => step.run === 'npm run stage:server');
  const validateIndex = packaging.steps.findIndex((step) => step.run === 'npm run validate:server-bundle');
  const buildIndex = packaging.steps.findIndex((step) => step.run === '${{ matrix.command }}');
  assert.equal(packaging.steps[downloadIndex].with.name, upload.with.name);
  assert.equal(packaging.steps[downloadIndex].with.path, 'dist');
  assert.ok(downloadIndex < stageIndex && stageIndex < validateIndex && validateIndex < buildIndex);
});

test('Desktop server staging uses a pinned, matching npm lockfile', () => {
  const runtimeRoot = path.resolve(__dirname, '../server-staging');
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package-lock.json'), 'utf8'));
  const stageScript = fs.readFileSync(path.resolve(__dirname, '../scripts/stage-server.js'), 'utf8');

  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(lock.packages[''].version, manifest.version);
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.doesNotMatch(version, /^[~^*]|\s[<>=]/, `${name} must be pinned to an exact version`);
    assert.ok(lock.packages[`node_modules/${name}`], `${name} must have a root lock entry`);
  }
  assert.equal(lock.packages['node_modules/nodemailer'].version, '10.2.1');
  assert.equal(manifest.dependencies['https-proxy-agent'], '5.0.1');
  assert.equal(manifest.dependencies['socks-proxy-agent'], '7.0.0');
  assert.equal(manifest.dependencies.uuid, '8.3.2');
  assert.match(stageScript, /\['ci', '--omit=dev', '--ignore-scripts'/);
  assert.doesNotMatch(stageScript, /'install'.*'--no-package-lock'/);
});
