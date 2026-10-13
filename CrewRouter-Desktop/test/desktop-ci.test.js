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
  const downloadIndex = packaging.steps.findIndex((step) => step.uses === 'actions/download-artifact@v4');
  const stageIndex = packaging.steps.findIndex((step) => step.run === 'npm run stage:server');
  const validateIndex = packaging.steps.findIndex((step) => step.run === 'npm run validate:server-bundle');
  const buildIndex = packaging.steps.findIndex((step) => step.run === '${{ matrix.command }}');
  assert.equal(packaging.steps[downloadIndex].with.name, upload.with.name);
  assert.equal(packaging.steps[downloadIndex].with.path, 'dist');
  assert.ok(downloadIndex < stageIndex && stageIndex < validateIndex && validateIndex < buildIndex);
});
