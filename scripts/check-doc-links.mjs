#!/usr/bin/env node
'use strict';

// Check relative Markdown links in the SDK-facing documentation. Only the
// files maintained by the SDK work are scanned; older research documents have
// their own historical links.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  'README.md',
  'docs/API.md',
  'docs/integration-guide.md',
];

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

const SDK_DOCS = path.join(ROOT, 'docs/sdk');
if (fs.existsSync(SDK_DOCS)) {
  for (const file of walk(SDK_DOCS)) TARGETS.push(path.relative(ROOT, file));
}

const LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const missing = [];

for (const relative of TARGETS) {
  const file = path.join(ROOT, relative);
  if (!fs.existsSync(file)) {
    missing.push(`${relative}: file does not exist`);
    continue;
  }
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(LINK_RE)) {
    let target = match[1].trim();
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (target.startsWith('/')) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!fs.existsSync(resolved)) {
      missing.push(`${relative}: ${match[1]}`);
    }
  }
}

if (missing.length) {
  console.error('Broken documentation links:');
  for (const item of [...new Set(missing)].sort()) console.error(`  ${item}`);
  process.exit(1);
}
console.log(`Documentation links OK (${TARGETS.length} files checked)`);
