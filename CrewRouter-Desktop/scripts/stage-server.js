#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const source = path.resolve(process.env.CREWROUTER_RELEASE_ROOT || process.argv[2] || path.resolve(__dirname, '../../dist'));
const destination = path.resolve(process.env.CREWROUTER_STAGE_ROOT || path.join(__dirname, '..', 'staging', 'server'));
const files = ['server.js', 'model-trace-worker.js'];
const runtimeRoot = path.join(__dirname, '..', 'server-staging');
const runtimeFiles = ['package.json', 'package-lock.json'];
const directories = ['public', 'lang'];
const forbidden = /(^|\/)(?:\.env(?:\..*)?|.*\.(?:db|sqlite|sqlite3)|credentials?|secrets?)(?:$|\/)/i;

function copyFile(relative) {
  const from = path.join(source, relative);
  if (!fs.existsSync(from)) throw new Error(`Required release file not found: ${from}`);
  const to = path.join(destination, relative);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  if (relative === 'package.json') {
    const manifest = JSON.parse(fs.readFileSync(to, 'utf8'));
    // Electron's embedded Node version cannot require the newer ESM-only proxy agents from this CommonJS bundle.
    manifest.dependencies = { ...manifest.dependencies, 'https-proxy-agent': '^5.0.1', 'socks-proxy-agent': '^7.0.0', uuid: '^9.0.1' };
    fs.writeFileSync(to, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function copyDirectory(relative) {
  const from = path.join(source, relative);
  if (!fs.existsSync(from)) return;
  const to = path.join(destination, relative);
  fs.cpSync(from, to, {
    recursive: true,
    filter: (entry) => !forbidden.test(path.relative(source, entry)),
  });
}

function copyRuntimeFile(relative) {
  const from = path.join(runtimeRoot, relative);
  if (!fs.existsSync(from)) throw new Error(`Required Desktop server runtime file not found: ${from}`);
  fs.copyFileSync(from, path.join(destination, relative));
}

function assertRuntimeManifestMatchesRelease() {
  const release = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const runtime = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
  const releaseNames = Object.keys(release.dependencies || {}).sort();
  const runtimeNames = Object.keys(runtime.dependencies || {}).sort();
  if (JSON.stringify(releaseNames) !== JSON.stringify(runtimeNames)) {
    throw new Error('Desktop server runtime dependencies do not match the release dependency names');
  }
  const lock = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package-lock.json'), 'utf8'));
  if (lock.name !== runtime.name || lock.version !== runtime.version || lock.packages?.['']?.name !== runtime.name || lock.packages?.['']?.version !== runtime.version || JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(runtime.dependencies)) {
    throw new Error('Desktop server runtime package-lock.json does not match its package.json');
  }
}

function assertSafeBundle() {
  const unsafe = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = path.relative(destination, path.join(dir, entry.name));
      if (forbidden.test(relative)) unsafe.push(relative);
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  }
  walk(destination);
  if (unsafe.length) throw new Error(`Unsafe files found in server bundle: ${unsafe.join(', ')}`);
}

if (!fs.existsSync(source)) {
  console.error(`Release directory not found: ${source}`);
  process.exitCode = 1;
} else {
  try {
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });
    assertRuntimeManifestMatchesRelease();
    files.forEach(copyFile);
    runtimeFiles.forEach(copyRuntimeFile);
    directories.forEach(copyDirectory);
    const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
    const npmCommand = process.platform === 'win32'
      ? (process.env.npm_node_execpath || process.execPath)
      : (process.env.npm_execpath || 'npm');
    if (process.platform === 'win32' && process.env.npm_execpath) npmArgs.unshift(process.env.npm_execpath);
    execFileSync(npmCommand, npmArgs, {
      cwd: destination,
      stdio: 'inherit',
    });
    assertSafeBundle();
    console.log(`Staged CrewRouter Server at ${destination}`);
    console.log('Included: server.js, pinned production package manifest/lock/dependencies, public/, lang/');
  } catch (error) {
    console.error(`Unable to stage CrewRouter Server: ${error.message}`);
    process.exitCode = 1;
  }
}
