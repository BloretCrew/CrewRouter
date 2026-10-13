'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function validateModelTrace(publicRoot) {
  const root = path.join(publicRoot, 'vendor/modeltrace');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
  const files = ['fingerprint-core.mjs', 'challenge-browser.mjs', 'data/unified_bank.json', 'LICENSE'];
  if (metadata.schema !== 'crewrouter-modeltrace-metadata-v1' || metadata.source_commit !== '6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2' || metadata.algorithm_version !== 'modeltrace-1.0.0-crewrouter.1') throw new Error('Invalid ModelTrace release version');
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(root, file));
    const info = metadata.files?.[file];
    if (!info || bytes.length !== info.bytes || createHash('sha256').update(bytes).digest('hex') !== info.sha256) throw new Error(`Invalid ModelTrace release asset: ${file}`);
  }
  if (metadata.bank_hash !== metadata.files['data/unified_bank.json'].sha256) throw new Error('Invalid ModelTrace bank hash');
  const walk = dir => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (/reference/i.test(item.name)) throw new Error('Raw ModelTrace reference samples must not ship');
      if (item.isDirectory()) walk(path.join(dir, item.name));
    }
  };
  walk(root);
  return metadata;
}
module.exports = { validateModelTrace };
