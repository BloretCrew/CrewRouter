'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cli-config-'));
  process.env.CR_CLI_HOME = home;
  return home;
}

test('profiles are written atomically with 0600 and never contain passwords', () => {
  const home = freshHome();
  const config = require('../lib/config');
  config.saveRemoteProfile('prod', 'https://router.example.com/', { makeCurrent: true, displayName: '生产' });
  const saved = config.loadConfig();
  assert.equal(saved.currentProfile, 'prod');
  assert.equal(saved.profiles.prod.baseUrl, 'https://router.example.com');
  assert.equal(saved.profiles.prod.type, 'remote');
  const mode = fs.statSync(path.join(home, 'cli.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.ok(!fs.readFileSync(path.join(home, 'cli.json'), 'utf8').includes('password'));
});

test('URL normalization rejects credentials, query and subpaths', () => {
  const config = require('../lib/config');
  assert.equal(config.normalizeBaseUrl('http://127.0.0.1:20003/'), 'http://127.0.0.1:20003');
  assert.equal(config.normalizeBaseUrl('https://example.com/v1'), 'https://example.com');
  assert.throws(() => config.normalizeBaseUrl('https://user:pass@example.com'), /用户名或密码/);
  assert.throws(() => config.normalizeBaseUrl('https://example.com/path'), /根路径/);
  assert.throws(() => config.normalizeBaseUrl('ftp://example.com'), /http/);
});

test('sessions persist separately and can be cleared per profile', () => {
  freshHome();
  const config = require('../lib/config');
  config.saveSession('prod', {
    authType: 'session',
    cookieJar: [{ name: 'connect.sid', value: 'secret', path: '/', secure: false }],
    csrfToken: 'csrf',
    username: 'admin',
    isAdmin: true,
  });
  const session = config.getSession('prod');
  assert.equal(session.username, 'admin');
  assert.equal(session.cookieJar[0].name, 'connect.sid');
  config.clearSession('prod');
  assert.equal(config.getSession('prod'), null);
});

test('local port follows explicit option, env then config file', () => {
  const home = freshHome();
  const config = require('../lib/config');
  const configFile = path.join(home, 'server-config.json');
  fs.writeFileSync(configFile, JSON.stringify({ app: { port: 21003 } }));
  assert.equal(config.resolveLocalPort({ configPath: configFile }), 21003);
  process.env.CR_APP_PORT = '22003';
  assert.equal(config.resolveLocalPort({ configPath: configFile }), 22003);
  delete process.env.CR_APP_PORT;
  assert.equal(config.resolveLocalPort({ port: 23003, configPath: configFile }), 23003);
});

test.after(() => { delete process.env.CR_CLI_HOME; delete process.env.CR_APP_PORT; });
