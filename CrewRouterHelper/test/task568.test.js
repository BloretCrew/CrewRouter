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
test('metrics includes non-sensitive reliability counters', async () => { const m = await api.collect('/missing'); for (const key of ['heartbeat_total', 'remote_test_total', 'duplicate_total', 'repair_total']) assert.equal(typeof m[key], 'number'); assert.doesNotMatch(api.prometheus(m), /token|secret|password/i); });
