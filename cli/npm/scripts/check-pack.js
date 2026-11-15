#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const cli = path.join(root, 'cli');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-cli-stage-'));
const externalPublish = process.env.CREWROUTER_CLI_PACK_DEST;
const publish = externalPublish ? path.resolve(externalPublish) : fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-cli-pack-'));
fs.mkdirSync(publish, { recursive: true });
const pkg = { ...require('../package.json'), private: false };
for (const entry of ['bin', 'lib', 'tui']) fs.cpSync(path.join(cli, entry), path.join(stage, entry), { recursive: true });
fs.copyFileSync(path.join(cli, 'index.js'), path.join(stage, 'index.js'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.copyFileSync(path.join(__dirname, '../README.md'), path.join(stage, 'README.md'));
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
try {
  const result = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', publish], { cwd: stage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0) throw new Error('npm pack failed');
  const packed = JSON.parse(result.stdout)[0];
  const files = new Set(packed.files.map(file => file.path));
  for (const required of ['bin/cr.js', 'index.js', 'lib/config.js', 'tui/app.js', 'README.md', 'LICENSE']) if (!files.has(required)) throw new Error(`CLI package missing ${required}`);
  if ([...files].some(name => name.startsWith('server/') || name.startsWith('test/'))) throw new Error('CLI package includes server source or tests');
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-cli-beta-smoke-'));
  try {
    const tarball = path.join(publish, packed.filename);
    const untar = spawnSync('tar', ['-xzf', tarball, '-C', extracted], { stdio: 'inherit' });
    if (untar.status !== 0) throw new Error('Could not extract CLI package');
    const bin = path.join(extracted, 'package', 'bin', 'cr.js');
    const env = { PATH: process.env.PATH, HOME: extracted, CR_CLI_HOME: path.join(extracted, 'config'), CREWROUTER_CLI_SERVER_ROOT: root };
    for (const args of [['--help'], ['version', '--json']]) {
      const smoke = spawnSync(process.execPath, [bin, ...args], { cwd: extracted, env, encoding: 'utf8', timeout: 10000 });
      if (smoke.status !== 0) throw new Error(`CLI smoke failed (${args.join(' ')}): ${smoke.stderr}`);
    }
  } finally { fs.rmSync(extracted, { recursive: true, force: true }); }
  console.log(`CLI pack contract passed: ${packed.filename}; files=${packed.entryCount}; size=${packed.size}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
  if (!externalPublish) fs.rmSync(publish, { recursive: true, force: true });
}
