'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const api = require('../src');
function env(name, value) { const old = process.env[name]; process.env[name] = value; return () => { if (old === undefined) delete process.env[name]; else process.env[name] = old; }; }
test('clients setup plans without yes and installs Grok with confirmation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-task568-')); const restoreHome = env('HOME', root); const restoreGrok = env('GROK_HOME', path.join(root, '.grok'));
  try { const cli = path.resolve(__dirname, '../bin/cr-report.js'); const info = api.inspect('grok', { verbose: true, command: cli }); assert.equal(info.config_exists, false); assert.equal(info.auto_install, true); assert.ok(info.install_plan); const plan = api.setup('grok', { command: cli }); assert.equal(plan.action, 'plan'); assert.equal(plan.confirmation_required, true); const applied = api.setup('grok', { command: cli, confirmed: true }); assert.equal(applied.action, 'install'); assert.equal(applied.helper_installed, true); assert.equal(api.setup('claude').action, 'manual'); } finally { restoreHome(); restoreGrok(); fs.rmSync(root, { recursive: true, force: true }); }
});
test('migration backup CLI uses one namespace end to end under temporary HOME', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-migration-e2e-')); const cli = path.resolve(__dirname, '../bin/cr-report.js'); const envBase = { ...process.env, HOME: root, GROK_HOME: path.join(root, '.grok'), CR_REPORT_CONFIG: path.join(root, 'config.json'), CR_REPORT_BACKUP_DIR: path.join(root, 'migration-backups') }; const run = (...args) => require('child_process').spawnSync(process.execPath, [cli, ...args], { env: envBase, encoding: 'utf8' });
  try { let r = run('hooks', 'install'); assert.equal(r.status, 0, r.stderr); r = run('backup', 'create', '--yes'); assert.equal(r.status, 0, r.stderr); const created = JSON.parse(r.stdout); r = run('backup', 'list'); assert.equal(r.status, 0, r.stderr); assert.ok(JSON.parse(r.stdout).some(x => x.id === created.id)); r = run('backup', 'restore', created.id, '--yes'); assert.equal(r.status, 0, r.stderr); r = run('rollback', created.id, '--yes'); assert.equal(r.status, 0, r.stderr); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('metrics includes non-sensitive reliability counters', async () => { const m = await api.collect('/missing'); for (const key of ['heartbeat_total', 'remote_test_total', 'duplicate_total', 'repair_total']) assert.equal(typeof m[key], 'number'); assert.doesNotMatch(api.prometheus(m), /token|secret|password/i); });
