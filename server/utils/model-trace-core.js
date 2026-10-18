'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, webcrypto } = require('node:crypto');

const SOURCE_COMMIT = '654c8334bb53951aaf04cbd61252d163649e1369';
const ALGORITHM_VERSION = 'lm-detector-shared-v2-crewrouter.1';
const FILES = ['fingerprint-core.mjs', 'challenge-browser.mjs', 'data/unified_bank.json', 'data/shared_detector.bin', 'LICENSE'];
let assetsPromise;
let corePromise;
let bankPromise;

async function readBounded(file, maximum) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('ModelTrace 资源超出大小限制');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error('ModelTrace 资源超出大小限制');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

async function loadAssets() {
  if (!assetsPromise) assetsPromise = (async () => {
    // __dirname changes to the bundle root in release and Desktop builds.
    const candidates = [path.join(__dirname, '../../public'), path.join(__dirname, 'public'), path.join(__dirname, '../public')];
    let root;
    for (const candidate of candidates) {
      try {
        await fs.access(path.join(candidate, 'vendor/modeltrace/metadata.json'));
        root = path.join(candidate, 'vendor/modeltrace');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!root) throw new Error('缺少 ModelTrace 发布资源');
    const metadata = JSON.parse((await readBounded(path.join(root, 'metadata.json'), 16384)).toString('utf8'));
    if (metadata.schema !== 'crewrouter-modeltrace-metadata-v1' || metadata.source_commit !== SOURCE_COMMIT || metadata.algorithm_version !== ALGORITHM_VERSION || !/^[a-f0-9]{64}$/.test(metadata.bank_hash || '') || !metadata.files) {
      throw new Error('无效 ModelTrace 版本信息');
    }
    const contents = {};
    for (const file of FILES) {
      const info = metadata.files[file];
      if (!info || !/^[a-f0-9]{64}$/.test(info.sha256 || '') || !Number.isSafeInteger(info.bytes) || info.bytes < 1) throw new Error('无效 ModelTrace 资源校验信息');
      const bytes = await readBounded(path.join(root, file), file.endsWith('.bin') ? 8388608 : file.endsWith('.json') ? 262144 : 131072);
      if (bytes.length !== info.bytes || createHash('sha256').update(bytes).digest('hex') !== info.sha256) throw new Error(`ModelTrace 资源校验失败: ${file}`);
      contents[file] = bytes;
    }
    if (metadata.bank_hash !== metadata.files['data/unified_bank.json'].sha256) throw new Error('ModelTrace 库版本校验失败');
    if (metadata.detector_hash !== metadata.files['data/shared_detector.bin'].sha256) throw new Error('LM Detector 检测器版本校验失败');
    return { root, metadata: freezeTree(metadata), contents };
  })().catch(error => { assetsPromise = undefined; throw error; });
  return assetsPromise;
}

async function loadCore() {
  if (!corePromise) corePromise = (async () => {
    const { root } = await loadAssets();
    if (!globalThis.crypto) globalThis.crypto = webcrypto;
    const fingerprint = await import(pathToFileURL(path.join(root, 'fingerprint-core.mjs')).href);
    const challenge = await import(pathToFileURL(path.join(root, 'challenge-browser.mjs')).href);
    return Object.freeze({
      analyzeGlobalOutputs: fingerprint.analyzeGlobalOutputs,
      generateChallenges: challenge.generateChallenges,
      parseNumbers: fingerprint.parseNumbers,
    });
  })().catch(error => { corePromise = undefined; throw error; });
  return corePromise;
}

async function loadBank() {
  if (!bankPromise) bankPromise = (async () => {
    const { root, metadata, contents } = await loadAssets();
    const { parseBankJson, attachDetector } = await import(pathToFileURL(path.join(root, 'fingerprint-core.mjs')).href);
    const bank = freezeTree(attachDetector(parseBankJson(contents['data/unified_bank.json'].toString('utf8')), contents['data/shared_detector.bin']));
    return Object.freeze({ bank, metadata });
  })().catch(error => { bankPromise = undefined; throw error; });
  return bankPromise;
}

module.exports = { loadCore, loadBank };
