#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const source = path.resolve(process.env.CREWROUTER_RELEASE_ROOT || process.argv[2] || path.resolve(__dirname, '../../dist'));
const destination = path.resolve(process.env.CREWROUTER_STAGE_ROOT || path.join(__dirname, '..', 'staging', 'server'));
const files = ['server.js', 'package.json'];
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

function patchDesktopInstancePayload() {
  const appPath = path.join(destination, 'public', 'js', 'app.js');
  if (!fs.existsSync(appPath)) throw new Error('Expected public/js/app.js in Server bundle');
  const sourceText = fs.readFileSync(appPath, 'utf8');
  const instanceMarker = "      this.instance = window.CrewRouterEditionBadge\n        ? await window.CrewRouterEditionBadge.load()\n        : null;";
  const instanceReplacement = "      const instancePayload = window.CrewRouterEditionBadge\n        ? await window.CrewRouterEditionBadge.load()\n        : null;\n      this.instance = instancePayload?.data && typeof instancePayload.data === 'object'\n        ? instancePayload.data\n        : instancePayload;";
  if (!sourceText.includes(instanceMarker)) throw new Error('Expected instance bootstrap was not found in staged app.js');
  fs.writeFileSync(appPath, sourceText.replace(instanceMarker, instanceReplacement));
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
    files.forEach(copyFile);
    directories.forEach(copyDirectory);
    patchDesktopInstancePayload();
    execFileSync(process.env.npm_execpath || 'npm', ['install', '--omit=dev', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'], {
      cwd: destination,
      stdio: 'inherit',
    });
    assertSafeBundle();
    console.log(`Staged CrewRouter Server at ${destination}`);
    console.log('Included: server.js, production package manifest/dependencies, public/, lang/');
  } catch (error) {
    console.error(`Unable to stage CrewRouter Server: ${error.message}`);
    process.exitCode = 1;
  }
}
