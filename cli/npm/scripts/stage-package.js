#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const destination = path.resolve(process.argv[2] || process.env.CREWROUTER_CLI_STAGE_DEST || '');
if (!process.argv[2] && !process.env.CREWROUTER_CLI_STAGE_DEST) throw new Error('Pass an explicit temporary output directory.');
if (!path.isAbsolute(destination) || destination === root || destination.startsWith(`${root}${path.sep}`)) throw new Error('Stage output must be an explicit directory outside the repository.');
const cli = path.join(root, 'cli');
const source = path.join(__dirname, '..');
const pkg = { ...require('../package.json'), private: false };
fs.mkdirSync(destination, { recursive: true });
for (const entry of ['bin', 'lib', 'tui']) fs.cpSync(path.join(cli, entry), path.join(destination, entry), { recursive: true });
fs.copyFileSync(path.join(cli, 'index.js'), path.join(destination, 'index.js'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'));
fs.copyFileSync(path.join(source, 'README.md'), path.join(destination, 'README.md'));
fs.writeFileSync(path.join(destination, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
const install = spawnSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: destination, stdio: 'inherit', timeout: 120000 });
if (install.status !== 0) process.exit(install.status || 1);
