#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const source = path.resolve(process.env.CREWROUTER_RELEASE_ROOT || process.argv[2] || path.resolve(__dirname, '../../release'));
const destination = path.resolve(process.env.CREWROUTER_STAGE_ROOT || path.join(__dirname, '..', 'staging', 'server'));
const excluded = new Set(['node_modules', '.git', '.env', '.env.local']);

function copyTree(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      if (!excluded.has(entry)) copyTree(path.join(from, entry), path.join(to, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

if (!fs.existsSync(source)) {
  console.error(`Release directory not found: ${source}`);
  process.exitCode = 1;
} else {
  fs.rmSync(destination, { recursive: true, force: true });
  copyTree(source, destination);
  console.log(`Staged server release at ${destination} (node_modules excluded)`);
}
