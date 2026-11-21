#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const version = require('../package.json').version;
const runner = path.resolve(__dirname, 'check-pack.js');
const temp = require('node:os').tmpdir();
const dest = fs.mkdtempSync(path.join(temp, `crewrouter-cli-install-${process.pid}-`));
const tarballs = fs.mkdtempSync(path.join(temp, `crewrouter-cli-tarballs-${process.pid}-`));
const packed = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 30000, env: { ...process.env, CREWROUTER_CLI_PACK_DEST: tarballs } });
if (packed.status !== 0) throw new Error(packed.stderr || 'CLI pack verification failed');
const output = path.join(tarballs, `crewrouter-${version}.tgz`);
const install = spawnSync('npm', ['install', '--global', output, '--prefix', dest, '--ignore-scripts', '--no-audit', '--no-fund'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  if (install.status !== 0) throw new Error(install.stderr);
  const bin = path.join(dest, 'bin');
  const result = spawnSync(path.join(bin, 'cr'), ['--help'], { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: dest, CR_CLI_HOME: path.join(dest, 'config') } });
  if (result.status !== 0) throw new Error(result.stderr);
  console.log(`Installed CLI ${version}: cr --help passed`);
} finally {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(tarballs, { recursive: true, force: true });
}
