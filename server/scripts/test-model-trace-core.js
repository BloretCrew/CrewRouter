'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { loadCore, loadBank } = require('../utils/model-trace-core');

async function main() {
  const root = path.resolve(__dirname, '../../public/vendor/modeltrace');
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/model-trace-python.json'), 'utf8'));
  const { bank, metadata } = await loadBank();
  const core = await loadCore();
  const browser = await import(pathToFileURL(path.join(root, 'fingerprint-core.mjs')).href);
  const challenge = await import(pathToFileURL(path.join(root, 'challenge-browser.mjs')).href);
  assert.equal(core.analyzeGlobalOutputs, browser.analyzeGlobalOutputs);
  assert.equal(core.parseNumbers, browser.parseNumbers);
  assert.equal(core.generateChallenges, challenge.generateChallenges);
  assert.equal(fixture.source_commit, metadata.source_commit);
  assert.equal(metadata.bank_hash, createHash('sha256').update(fs.readFileSync(path.join(root, 'data/unified_bank.json'))).digest('hex'));
  assert.ok(Object.isFrozen(bank.models[0].counts));
  assert.equal(await loadBank(), await loadBank());
  for (const item of fixture.parse_cases) assert.deepEqual(core.parseNumbers(item.text), item.expected);
  let maximumError = 0;
  function close(actual, expected) {
    const error = Math.abs(actual - expected);
    maximumError = Math.max(maximumError, error);
    assert.ok(Number.isFinite(actual) && error <= fixture.tolerance, `${actual} differs from Python ${expected}`);
  }
  for (const item of fixture.cases) {
    const actual = core.analyzeGlobalOutputs(item.outputs, bank);
    const expected = item.expected;
    assert.equal(actual.prediction, expected.prediction);
    assert.equal(actual.family_prediction, expected.family_prediction);
    assert.equal(actual.used_outputs, expected.used_outputs);
    assert.deepEqual(actual.diagnostics, expected.diagnostics);
    assert.deepEqual(actual.calibration, expected.calibration);
    assert.deepEqual(actual.results.map(row => row.model), expected.results.map(row => row.model));
    for (let i = 0; i < actual.results.length; i += 1) {
      const row = actual.results[i];
      const python = expected.results[i];
      for (const key of ['score', 'probability', 'profile_similarity', 'conditional_probability']) close(row[key], python[key]);
    }
    actual.family_probabilities.forEach((row, i) => close(row.probability, expected.family_probabilities[i].probability));
    close(actual.results.reduce((total, row) => total + row.probability, 0), 1);
  }
  for (const error of Object.values(fixture.basis_orthogonality_error)) assert.ok(error < 1e-12);
  assert.throws(() => core.analyzeGlobalOutputs([{ text: '' }], bank), /没有可用回答/);
  assert.throws(() => core.analyzeGlobalOutputs([{ text: Array(79).fill('1').join(' ') }], bank), /没有可用回答/);
  assert.throws(() => core.parseNumbers('1'.repeat(65537)), /有界字符串/);
  assert.throws(() => core.parseNumbers({}), /有界字符串/);
  for (const outputs of [[], Array(4).fill({ text: '1' }), [{ text: 123 }], [{ text: '1', expected_count: NaN }], [{ text: '1', expected_count: -1 }], [{ text: '1', expected_count: 4097 }], [{ text: '1', expected_count: 1.5 }]]) {
    assert.throws(() => core.analyzeGlobalOutputs(outputs, bank), /无效指纹库或输入/);
  }
  const mutate = change => {
    const modified = JSON.parse(JSON.stringify(bank));
    change(modified);
    assert.throws(() => browser.validateBank(modified), /无效指纹库或输入/);
  };
  mutate(value => { value.models = []; });
  mutate(value => { value.schema = 'unknown'; });
  mutate(value => { value.models[1].id = value.models[0].id; });
  mutate(value => { value.robust.model_order.reverse(); });
  mutate(value => { value.models[0].counts.pop(); });
  mutate(value => { value.models[0].counts[0] = 1.5; });
  mutate(value => { value.robust.hellinger.feature_scale[0] = 0; });
  mutate(value => { value.robust.hellinger.feature_mean[0] = Infinity; });
  mutate(value => { value.robust.ordered_blocks.centroids[0].pop(); });
  mutate(value => { value.robust.ordered_blocks.environment_centroids = []; });
  mutate(value => { value.robust.hellinger.nuisance_basis[0][0] += 0.1; });
  mutate(value => { value.calibration['2'].beta = NaN; });
  mutate(value => { value.calibration['3'].cv_accuracy = 1.1; });
  mutate(value => { value.padding = 'x'.repeat(2049); });
  mutate(value => { value.robust.ordered_blocks.weight = 0.5; });
  assert.throws(() => browser.parseBankJson(' '.repeat(browser.LIMITS.maxBankBytes + 1)), /bank bytes/);
  assert.throws(() => browser.parseBankJson('{'), SyntaxError);
  assert.throws(() => browser.parseBankJson('{}'), /schema/);
  const oversized = { nodes: Array.from({ length: 4096 }, () => Array(40).fill(0)) };
  assert.throws(() => browser.validateBank(oversized), /size\/depth/);
  for (const count of [0, -1, 4, 42, Infinity, 1.5, '3']) assert.throws(() => core.generateChallenges(count), /1–3/);
  for (const count of [1, 2, 3]) {
    const generated = core.generateChallenges(count);
    assert.equal(generated.length, count);
    assert.equal(new Set(generated.map(item => item.expected_count)).size, count);
    assert.equal(new Set(generated.map(item => item.id)).size, count);
    for (const item of generated) {
      assert.ok(item.expected_count >= 292 && item.expected_count <= 332);
      assert.match(item.prompt, /禁止调用或借助任何工具/);
      assert.match(item.id, /^probe-\d-[a-f0-9]{28}$/);
    }
  }
  console.log(`ModelTrace core: PASS; ${fixture.cases.length} Python fixtures, ${fixture.parse_cases.length} parser fixtures; max numeric error=${maximumError}; tolerance=${fixture.tolerance}; shared browser/server ESM, schema/input limits and challenge bounds verified; no model calls.`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
