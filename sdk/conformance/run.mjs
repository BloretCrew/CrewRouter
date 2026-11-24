#!/usr/bin/env node
'use strict';

// Cross-language conformance runner. Each language reads the same
// sdk/contract/conformance/cases.json.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const COMMANDS = {
  node: {
    command: 'npm',
    args: ['--prefix', 'sdk/typescript', 'run', 'test'],
    cwd: ROOT,
    env: {},
  },
  nodePackage: {
    command: 'npm',
    args: ['pack', '--dry-run'],
    cwd: path.join(ROOT, 'sdk/typescript'),
    env: {},
  },
  python: {
    command: process.env.PYTHON || 'python3',
    args: ['-m', 'unittest', 'discover', '-s', 'tests'],
    cwd: path.join(ROOT, 'sdk/python'),
    env: { PYTHONPATH: 'src' },
  },
  go: {
    command: 'go',
    args: ['test', './...'],
    cwd: path.join(ROOT, 'sdk/go'),
    env: {},
  },
};

function run(language) {
  const spec = COMMANDS[language];
  if (!spec) throw new Error(`Unknown language: ${language}`);
  console.log(`\n[conformance] ${language}: ${spec.command} ${spec.args.join(' ')}`);
  const result = spawnSync(spec.command, spec.args, {
    cwd: spec.cwd,
    stdio: 'inherit',
    env: { ...process.env, ...spec.env },
  });
  if (result.status !== 0) throw new Error(`${language} conformance failed`);
}

const args = process.argv.slice(2);
const langArgs = args.filter((arg) => arg.startsWith('--lang='));
const languages = langArgs.length
  ? langArgs.map((arg) => arg.slice('--lang='.length))
  : ['node', 'nodePackage', 'python', 'go'];

if (!languages.length) {
  console.error('Usage: node sdk/conformance/run.mjs [--all] [--lang=node|nodePackage|python|go]');
  process.exit(2);
}

for (const language of languages) run(language);
console.log(`\n[conformance] passed: ${languages.join(', ')}`);
