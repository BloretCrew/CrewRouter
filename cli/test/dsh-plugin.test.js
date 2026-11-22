'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { candidates, install, runDsh, PACKAGE, PACKAGE_NAME, isInstalled, dshHome, state, saveInstallState } = require('../lib/dsh-plugin');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-dsh-plugin-'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const dsh = path.join(bin, 'dsh');
  const record = path.join(root, 'args.json');
  fs.writeFileSync(dsh, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)))\n`);
  fs.chmodSync(dsh, 0o700);
  return { root, bin, dsh, record };
}
function makeProfile(home, profile, deps = {}) {
  const dir = path.join(home, 'profiles', profile); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dependencies: deps, dsh: { profile: { bundles: [] } } }));
  return dir;
}

test('uses trimmed DSH_HOME or the default home consistently', () => {
  const previousHome = process.env.DSH_HOME; const previousOsHome = process.env.HOME;
  try {
    process.env.DSH_HOME = '  ';
    process.env.HOME = '/tmp/cr-home';
    assert.equal(dshHome(), path.join(os.homedir(), '.dsh'));
    process.env.DSH_HOME = ' /tmp/custom-dsh ';
    assert.equal(dshHome(), '/tmp/custom-dsh');
  } finally { process.env.DSH_HOME = previousHome; process.env.HOME = previousOsHome; }
});

test('persists a user opt-out across normalized CLI config reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-dsh-opt-out-')); const previous = process.env.CR_CLI_HOME;
  try {
    process.env.CR_CLI_HOME = root;
    const cfg = require('../lib/config');
    cfg.saveConfig({ ...cfg.loadConfig(), dshPluginAutoPrompt: false });
    assert.equal(cfg.loadConfig().dshPluginAutoPrompt, false);
    assert.equal(state().version, 1);
    saveInstallState('web', true);
    assert.equal(state().profiles.web.installed, true);
    saveInstallState('web', false);
    assert.equal(state().profiles.web, undefined);
  } finally { process.env.CR_CLI_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); }
});

test('finds a DSH executable on PATH', () => {
  const env = sandbox(); const previous = process.env.PATH;
  try { process.env.PATH = env.bin; assert.equal(candidates(), env.dsh); }
  finally { process.env.PATH = previous; fs.rmSync(env.root, { recursive: true, force: true }); }
});

test('installs a bundled package into an initialized selected profile and stores private state', async () => {
  const env = sandbox(); const cliHome = path.join(env.root, 'cli-home'); const dshHome = path.join(env.root, 'dsh-home'); const previousPath = process.env.PATH; const previousHome = process.env.CR_CLI_HOME; const previousDshHome = process.env.DSH_HOME;
  makeProfile(dshHome, 'standard');
  try {
    process.env.PATH = env.bin; process.env.CR_CLI_HOME = cliHome; process.env.DSH_HOME = dshHome;
    assert.equal(await install('standard', { yes: true }), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.record)), ['plugin', '--profile', 'standard', 'add', PACKAGE()]);
    const state = JSON.parse(fs.readFileSync(path.join(cliHome, 'dsh-plugin.json')));
    assert.equal(state.profiles.standard.installed, true);
    assert.equal(fs.statSync(path.join(cliHome, 'dsh-plugin.json')).mode & 0o777, 0o600);
  } finally { process.env.PATH = previousPath; process.env.CR_CLI_HOME = previousHome; process.env.DSH_HOME = previousDshHome; fs.rmSync(env.root, { recursive: true, force: true }); }
});

test('does not touch an uninitialized arbitrary profile', async () => {
  const env = sandbox(); const previousPath = process.env.PATH; const previousDshHome = process.env.DSH_HOME;
  try { process.env.PATH = env.bin; process.env.DSH_HOME = path.join(env.root, 'dsh-home'); await assert.rejects(install('custom', { yes: true }), /尚未初始化/); assert.equal(fs.existsSync(env.record), false); }
  finally { process.env.PATH = previousPath; process.env.DSH_HOME = previousDshHome; fs.rmSync(env.root, { recursive: true, force: true }); }
});

test('isInstalled validates the DSH manifest and checks the requested profile', () => {
  const env = sandbox(); const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = path.join(env.root, 'dsh-home');
    makeProfile(process.env.DSH_HOME, 'safe', { [PACKAGE_NAME]: 'file:../../../CrewRouter/dsh-plugin' });
    assert.equal(isInstalled('safe'), true);
    assert.equal(isInstalled('other'), false);
    assert.equal(isInstalled('../safe'), false);
  } finally { process.env.DSH_HOME = previousHome; fs.rmSync(env.root, { recursive: true, force: true }); }
});

test('does not mistake a foreign package manifest for a DSH profile', () => {
  const env = sandbox(); const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = env.root;
    const dir = path.join(env.root, 'profiles', 'fake'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'unrelated', dependencies: { [PACKAGE_NAME]: '*' } }));
    assert.equal(isInstalled('fake'), false);
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
