'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { loadCore, loadBank } = require('../utils/model-trace-core');

async function main() {
  const root = path.resolve(__dirname, '../../public/vendor/modeltrace');
  const { bank, metadata } = await loadBank();
  const core = await loadCore();
  const browser = await import(pathToFileURL(path.join(root, 'fingerprint-core.mjs')).href);
  assert.equal(core.analyzeGlobalOutputs, browser.analyzeGlobalOutputs);
  assert.equal(metadata.source_repository, 'https://github.com/Ikaleio/lm-detector');
  assert.equal(bank.models.length, 60);
  assert.ok(Object.isFrozen(bank.models[0]));
  assert.equal(await loadBank(), await loadBank());
  for (const [file, info] of Object.entries(metadata.files)) {
    const bytes = fs.readFileSync(path.join(root, file));
    assert.equal(bytes.length, info.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), info.sha256);
  }
  const outputs = Array.from({ length: 3 }, (_, sample) => ({ text: Array.from({ length: 300 }, (_, index) => index % 2 ? 230 + (index * 17 + sample * 31) % 125 : 1 + (index * 13 + sample * 23) % 120).join(' '), expected_count: 300 }));
  const browserBank = browser.attachDetector(browser.parseBankJson(fs.readFileSync(path.join(root, 'data/unified_bank.json'), 'utf8')), fs.readFileSync(path.join(root, 'data/shared_detector.bin')));
  const result = core.analyzeGlobalOutputs(outputs, bank);
  assert.deepEqual(result, browser.analyzeGlobalOutputs(outputs, browserBank));
  assert.equal(result.used_outputs, 3);
  assert.equal(result.results.length, 60);
  assert.equal(result.method, 'shared-detector-v2');
  assert.equal(result.probability_status, 'reference_calibrated');
  assert.ok(Math.abs(result.results.reduce((total, row) => total + row.probability, 0) - 1) < 1e-12);
  for (const count of [1, 2]) {
    const partial = core.analyzeGlobalOutputs(outputs.slice(0, count), bank);
    assert.equal(partial.decision, 'partial');
    assert.equal(partial.probability, null);
    assert.ok(partial.results.every(row => row.probability === null));
  }
  assert.equal(core.analyzeGlobalOutputs([{ text: '' }], bank).decision, 'unscorable');
  assert.equal(core.analyzeGlobalOutputs(Array(3).fill({ text: Array(300).fill('123').join(' ') }), bank).decision, 'not_model');
  assert.throws(() => core.parseNumbers('1'.repeat(65537)), /有界字符串/);
  assert.throws(() => core.parseNumbers({}), /有界字符串/);
  for (const invalid of [[], Array(4).fill(outputs[0]), [{ text: 123 }], [{ text: '1', expected_count: NaN }], [{ text: '1', expected_count: 4097 }]]) assert.throws(() => core.analyzeGlobalOutputs(invalid, bank), /无效指纹库或输入/);
  assert.throws(() => browser.parseBankJson('{}'), /schema/);
  assert.throws(() => browser.parseBankJson(' '.repeat(browser.LIMITS.maxBankBytes + 1)), /bank bytes/);
  assert.throws(() => browser.attachDetector(browserBank, new Uint8Array(8)), /头部/);
  const mismatched = JSON.parse(JSON.stringify(browserBank));
  mismatched.models[0].response_count++;
  assert.throws(() => browser.attachDetector(mismatched, fs.readFileSync(path.join(root, 'data/shared_detector.bin'))), /不匹配/);
  for (const count of [0, -1, 4, Infinity, 1.5, '3']) assert.throws(() => core.generateChallenges(count), /1–3/);
  for (const count of [1, 2, 3]) {
    const generated = core.generateChallenges(count);
    assert.equal(generated.length, count);
    assert.equal(new Set(generated.map(item => item.expected_count)).size, count);
    assert.equal(new Set(generated.map(item => item.id)).size, count);
    assert.ok(generated.every(item => item.expected_count >= 292 && item.expected_count <= 332));
  }
  console.log('PASS lm-detector: 60 candidates, shared browser/server results, calibration, partial/no-model outcomes, resource integrity and input bounds; no model calls');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
