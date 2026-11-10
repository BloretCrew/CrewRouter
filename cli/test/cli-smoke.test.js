'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('../index');

const ROOT = path.resolve(__dirname, '..', '..');

function run(args, { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cli-smoke-')), env = {} } = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'cli', 'bin', 'cr.js'), ...args], {
    cwd: ROOT,
    env: { ...process.env, CR_CLI_HOME: home, NO_COLOR: '1', ...env },
    encoding: 'utf8',
    timeout: 15000,
  });
}

test('help and version exit successfully', () => {
  const help = run(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /CrewRouter CLI/);
  const version = run(['version', '--json']);
  assert.equal(version.status, 0);
  const payload = JSON.parse(version.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.data.cli);
});

test('--api-key and --url flags reach the parsed command context', () => {
  process.env.CR_CLI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cli-smoke-'));
  const args = parseArgs(['login', '--url', 'http://127.0.0.1:20003', '--api-key', 'sk-test']);
  assert.equal(args.url, 'http://127.0.0.1:20003');
  assert.equal(args['api-key'], 'sk-test');
  const context = require('../lib/context').createContext({ ...args, profile: undefined });
  assert.equal(context.client.apiKey, 'sk-test');

  process.env.CREWROUTER_URL = 'http://127.0.0.1:19999';
  process.env.CREWROUTER_API_KEY = 'sk-env';
  const fromEnv = require('../lib/context').createContext({});
  assert.equal(fromEnv.client.baseUrl, 'http://127.0.0.1:19999');
  assert.equal(fromEnv.client.apiKey, 'sk-env');
  delete process.env.CREWROUTER_URL;
  delete process.env.CREWROUTER_API_KEY;
});

test('profiles JSON is isolated to a temporary home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cli-smoke-'));
  const result = run(['profiles', '--json'], { home });
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.profiles.length, 0);
  assert.equal(fs.existsSync(home), true);
});

test('unknown commands exit 2 with a useful message', () => {
  const result = run(['definitely-not-a-command']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /未知命令/);
});

test('non-TTY cr prints status instead of opening the TUI', () => {
  const result = run(['--url', 'http://127.0.0.1:1', '--timeout', '200']);
  assert.ok([0, 1].includes(result.status));
  assert.match(result.stdout + result.stderr, /CrewRouter|离线|连接失败/);
});
