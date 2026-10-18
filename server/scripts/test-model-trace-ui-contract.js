'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

async function main() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/model-trace.js'), 'utf8');
  const fingerprint = await import(pathToFileURL(path.resolve(__dirname, '../../public/vendor/modeltrace/fingerprint-core.mjs')).href);
  const generator = await import(pathToFileURL(path.resolve(__dirname, '../../public/vendor/modeltrace/challenge-browser.mjs')).href);
  const vendor = path.resolve(__dirname, '../../public/vendor/modeltrace');
  const metadata = JSON.parse(fs.readFileSync(path.join(vendor, 'metadata.json'), 'utf8'));
  let bankText = fs.readFileSync(path.join(vendor, 'data/unified_bank.json'), 'utf8');
  const detector = fs.readFileSync(path.join(vendor, 'data/shared_detector.bin'));
  const nodes = [{ value: Array(300).fill('123').join(' ') }, { value: '' }, { value: '' }];
  const counts = Array.from({ length: 3 }, () => ({ textContent: '' }));
  const resultNode = {};
  const context = vm.createContext({
    sharedFingerprint: fingerprint, sharedGenerator: generator, metadata, bankSummary: undefined, corePromise: undefined,
    Uint8Array, TextEncoder, crypto: require('node:crypto').webcrypto,
    challenges: Array.from({ length: 3 }, () => ({ expected_count: 300 })),
    tr: value => value,
    esc: value => String(value ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    put: (node, content) => { node.html = content; },
    document: {
      getElementById: () => resultNode,
      querySelectorAll: selector => selector === '[data-trace-answer]' ? nodes : counts,
    },
    fetch: async url => ({ ok: true, text: async () => url.endsWith('metadata.json') ? JSON.stringify(metadata) : bankText, arrayBuffer: async () => detector.buffer.slice(detector.byteOffset, detector.byteOffset + detector.byteLength) }),
  });
  function extract(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `Missing contract function: ${start}`);
    return source.slice(from, to);
  }
  const coreSource = extract('async function core()', 'let corePromise;')
    .replace("import('/vendor/modeltrace/fingerprint-core.mjs')", 'Promise.resolve(sharedFingerprint)')
    .replace("import('/vendor/modeltrace/challenge-browser.mjs')", 'Promise.resolve(sharedGenerator)');
  vm.runInContext(extract('function ranking(', 'function best(') + extract('function resultHTML(', 'function taskHTML(') + coreSource + extract('async function analyze()', 'async function page()'), context);
  const library = await vm.runInContext('core()', context);
  assert.equal(library.analyzeGlobalOutputs, fingerprint.analyzeGlobalOutputs);
  assert.equal(library.metadata.bank_hash, metadata.bank_hash);
  bankText = '{}';
  await assert.rejects(vm.runInContext('core()', context), /schema/);
  bankText = fs.readFileSync(path.join(vendor, 'data/unified_bank.json'), 'utf8');
  bankText += ' ';
  await assert.rejects(vm.runInContext('core()', context), /校验失败/);
  bankText = bankText.slice(0, -1);
  detector[detector.length - 1] ^= 1;
  await assert.rejects(vm.runInContext('core()', context), /校验失败/);
  detector[detector.length - 1] ^= 1;
  await vm.runInContext('analyze()', context);
  assert.match(resultNode.html, /候选模型排行/);
  assert.match(resultNode.html, /未生成排名/);
  assert.ok(resultNode.html.includes(metadata.bank_hash));
  assert.match(counts[0].textContent, /300/);
  nodes[0].value = '1'.repeat(65537);
  await vm.runInContext('analyze()', context);
  assert.match(resultNode.html, /65536|有界字符串/);
  assert.match(source, /maxlength="65536"/);
  const html = vm.runInContext(`resultHTML({ results: [{model: 'internal-id', display_name: '<Friendly>', probability: 0.5, profile_similarity: 0.75}], family_probabilities: [{family: 'gpt', display_name: 'GPT', probability: 1}], version: {algorithm_version: 'fixture-version'} }, 1)`, context);
  assert.match(html, /&lt;Friendly&gt;/);
  assert.match(html, /50\.00%/);
  assert.match(html, /分布相似度.*75\.00%/);
  const allCandidates = vm.runInContext(`resultHTML({results: Array.from({length: 18}, (_, index) => ({model: 'candidate-' + index, probability: 1 / 18}))}, 3)`, context);
  assert.match(allCandidates, /candidate-17/);
  assert.match(html, /GPT/);
  assert.match(html, /fixture-version/);
  const partial = vm.runInContext(`resultHTML({results: [{model: 'partial', probability: null, score: 3.2}]}, 1)`, context);
  assert.doesNotMatch(partial, /320\.00%|0\.00%/);
  assert.doesNotMatch(html, /\[object Object\]/);
  context.bankSummary = { bank_hash: 'summary-hash' };
  assert.match(vm.runInContext('resultHTML({results: []}, 1)', context), /summary-hash/);
  console.log('ModelTrace UI contract: PASS; shared core, validated bank loading, manual analyze argument order, results/display_name/profile_similarity, metadata/summary versions and input bounds; no model calls.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
