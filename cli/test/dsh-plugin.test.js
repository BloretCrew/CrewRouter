'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { candidates, install, runDsh, PACKAGE, PACKAGE_NAME, isInstalled } = require('../lib/dsh-plugin');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-dsh-plugin-'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const dsh = path.join(bin, 'dsh');
  const record = path.join(root, 'args.json');
  fs.writeFileSync(dsh, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)))\n`);
  fs.chmodSync(dsh, 0o700);
  return { root, bin, dsh, record };
}

test('finds a DSH executable on PATH', () => {
  const env = sandbox(); const previous = process.env.PATH;
  try { process.env.PATH = env.bin; assert.equal(candidates(), env.dsh); }
  finally { process.env.PATH = previous; fs.rmSync(env.root, { recursive: true, force: true }); }
});

test('installs a validated package into the explicitly selected profile', async () => {
  const env = sandbox(); const cliHome = path.join(env.root, 'cli-home'); const previousPath = process.env.PATH; const previousHome = process.env.CR_CLI_HOME; const previousDshHome = process.env.DSH_HOME;
  try {
    process.env.PATH = env.bin; process.env.CR_CLI_HOME = cliHome; process.env.DSH_HOME = path.join(env.root, 'dsh-home');
    assert.equal(await install('standard', { yes: true }), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.record)), ['plugin', '--profile', 'standard', 'add', PACKAGE()]);
    const state = JSON.parse(fs.readFileSync(path.join(cliHome, 'dsh-plugin.json')));
    assert.equal(state.profiles.standard.installed, true);
    assert.equal(fs.statSync(path.join(cliHome, 'dsh-plugin.json')).mode & 0o777, 0o600);
  } finally { process.env.PATH = previousPath; process.env.CR_CLI_HOME = previousHome; process.env.DSH_HOME = previousDshHome; fs.rmSync(env.root, { recursive: true, force: true }); }
});

test('isInstalled checks the selected DSH profile rather than process cwd', () => {
  const env = sandbox(); const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = path.join(env.root, 'dsh-home');
    const profile = path.join(process.env.DSH_HOME, 'profiles', 'safe'); fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { [PACKAGE_NAME]: 'link:../CrewRouter/dsh-plugin' } }));
    assert.equal(isInstalled('safe'), true);
    assert.equal(isInstalled('other'), false);
  } finally { process.env.DSH_HOME = previousHome; fs.rmSync(env.root, { recursive: true, force: true }); }
});

test('rejects malformed profile names before invoking DSH', async () => {
  const env = sandbox(); const previousPath = process.env.PATH;
  try { process.env.PATH = env.bin; await assert.rejects(install('../other', { yes: true }), /profile 名称/); assert.equal(fs.existsSync(env.record), false); }
  finally { process.env.PATH = previousPath; fs.rmSync(env.root, { recursive: true, force: true }); }
});

test('runDsh reports nonzero child status', async () => {
  const env = sandbox();
  try { const result = await runDsh(process.execPath, ['-e', 'process.exit(9)']); assert.equal(result.code, 9); }
  finally { fs.rmSync(env.root, { recursive: true, force: true }); }
});
