#!/usr/bin/env node
'use strict';

// 对 src/、scripts/、test/ 下的所有 JS 执行 node --check。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const targets = ['src', 'scripts', 'test'];
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'vendor' && entry.name !== 'node_modules') walk(full); }
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
}
targets.forEach((target) => { const dir = path.join(root, target); if (fs.existsSync(dir)) walk(dir); });
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed += 1; console.error(`✗ ${path.relative(root, file)}\n${result.stderr}`); }
}
console.log(`${files.length - failed}/${files.length} files passed syntax check`);
process.exitCode = failed ? 1 : 0;
