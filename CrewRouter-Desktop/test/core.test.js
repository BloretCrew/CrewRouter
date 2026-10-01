'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateRemoteUrl, redactUrl } = require('../src/url-policy');
const { ProfileStore, validateLocalDisplayName } = require('../src/profile-store');
const { ConnectionManager, parseInstanceResponse } = require('../src/connection-manager');

const tempStore = () => new ProfileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-desktop-')), 'profiles.json'));

test('URL policy blocks private targets and redacts secrets', async () => {
  assert.equal((await validateRemoteUrl('http://127.0.0.1:1234')).ok, false);
  assert.equal((await validateRemoteUrl('http://localhost:1234')).ok, false);
  assert.equal((await validateRemoteUrl('https://example.com/#access_token=secret')).ok, false);
  assert.equal(redactUrl('https://example.com/#access_token=secret'), 'https://example.com/#[REDACTED]');
  assert.equal((await validateRemoteUrl('http://127.0.0.1:1234', { allowLocalhost: true })).ok, true);
  assert.equal((await validateRemoteUrl('http://example.invalid', { allowLocalhost: true })).ok, false);
  assert.equal((await validateRemoteUrl('http://user:pass@example.com')).ok, false);
  assert.equal((await validateRemoteUrl('https://example.com/?access_token=secret')).ok, false);
  assert.equal((await validateRemoteUrl('file:///tmp/x')).ok, false);
  assert.equal((await validateRemoteUrl('http://10.0.0.8')).ok, false);
  assert.equal((await validateRemoteUrl('http://[::1]:8080')).ok, false);
  assert.equal((await validateRemoteUrl('http://203.0.113.10:8080')).ok, true, '公网 IP 字面量不需要 DNS');
  assert.match(redactUrl('https://example.com/cb?access_token=abc&state=xyz'), /access_token=%5BREDACTED%5D/);
  assert.doesNotMatch(redactUrl('https://example.com/cb?access_token=abc&state=xyz'), /abc|xyz/);
});

test('local display name validation trims, rejects unsafe values and preserves HTML as text', () => {
  assert.deepEqual(validateLocalDisplayName('  Ada  '), { ok: true, value: 'Ada' });
  assert.equal(validateLocalDisplayName('   ').ok, false);
  assert.equal(validateLocalDisplayName('<img src=x>').ok, false);
  assert.equal(validateLocalDisplayName('a'.repeat(65)).ok, false);
  assert.equal(validateLocalDisplayName('中文用户-01').ok, true);
});

test('profile store persists local display name and identity without affecting remote profiles', () => {
  const store = tempStore();
  store.upsert({ id: 'local', name: '本地 CrewRouter', displayName: 'Ada', localIdentityId: 'stable-local-id', url: 'http://localhost:1234', mode: 'local' });
  store.upsert({ id: 'remote', name: 'Remote', url: 'https://remote.example', mode: 'remote' });
  const state = store.load();
  assert.equal(state.profiles.find((p) => p.id === 'local').displayName, 'Ada');
  assert.equal(state.profiles.find((p) => p.id === 'local').localIdentityId, 'stable-local-id');
  assert.equal(state.profiles.find((p) => p.id === 'remote').displayName, null);
});

test('desktop settings are isolated, include language and profiles can be renamed or removed', () => {
  const store = tempStore();
  store.upsert({ id: 'local', name: 'Local', url: 'http://localhost:1234', mode: 'local' });
  store.upsert({ id: 'remote', name: 'Remote', url: 'https://remote.example', mode: 'remote' });
  store.rename('remote', '远程工作区');
  assert.deepEqual(store.getSettings(), { autoConnect: true, theme: 'system', language: null, notifications: true, updateChecks: true });
  store.saveSettings({ theme: 'dark', language: 'en', autoConnect: false, notifications: true, updateChecks: false, token: 'must-not-persist' });
  assert.deepEqual(store.getSettings(), { theme: 'dark', language: 'en', autoConnect: false, notifications: true, updateChecks: false });
  assert.equal(store.saveSettings({ language: 'fr' }).language, null, '未知语言回落');
  assert.doesNotMatch(JSON.stringify(store.load()), /token|api.?key/i);
  store.remove('remote');
  assert.equal(store.load().profiles.length, 1);
});

test('profile store recovers corruption and switches profiles', () => {
  const store = tempStore();
  assert.equal(store.load().profiles.length, 0);
  store.upsert({ id: 'a', name: 'A', url: 'https://a.example' });
  store.upsert({ id: 'b', name: 'B', url: 'https://b.example', edition: 'team' });
  store.setActive('b'); assert.equal(store.getActive().id, 'b');
  fs.writeFileSync(store.filePath, '{broken');
  assert.equal(store.load().profiles.length, 0);
});

test('/api/instance parses authoritative runtime and auth metadata', () => {
  const local = parseInstanceResponse({ edition: 'personal' }, { allowLocalRuntime: true });
  assert.equal(local.runtime, 'desktop-local');
  assert.deepEqual(local.auth, { required: false, methods: ['local'] });
  const explicitLocal = parseInstanceResponse({ runtime: 'desktop-local', edition: 'personal', auth: { required: false, methods: ['local'] } });
  assert.equal(explicitLocal.runtime, 'desktop-local');
  assert.deepEqual(explicitLocal.auth, { required: false, methods: ['local'] });
  const personal = parseInstanceResponse({ runtime: 'server', edition: 'personal', auth: { required: true, methods: ['passport'] } });
  assert.deepEqual(personal.auth.methods, ['passport']);
  const team = parseInstanceResponse({ runtime: 'server', edition: 'team', auth: { required: true, methods: ['password', 'feishu'] } });
  assert.deepEqual(team.auth.methods, ['password', 'feishu']);
  assert.throws(() => parseInstanceResponse({ edition: 'personal' }), /runtime/);
  assert.throws(() => parseInstanceResponse({ runtime: 'server', edition: 'personal', auth: { required: true, methods: ['feishu'] } }), /Passport/);
  assert.throws(() => parseInstanceResponse({ runtime: 'desktop-local', edition: 'personal', auth: { required: true, methods: ['local'] } }), /Local/);
  assert.throws(() => parseInstanceResponse({ runtime: 'server', edition: 'team', auth: { required: true, methods: ['token'] } }), /无效/);
});

test('connection manager saves metadata without tokens', async () => {
  const store = tempStore();
  const manager = new ConnectionManager({ store, fetchImpl: async () => ({ ok: true, async json() { return { runtime: 'server', edition: 'team', auth: { required: true, methods: ['password', 'feishu'] }, capabilities: { sso: true }, protocolVersion: '1' }; } }) });
  const profile = await manager.connect({ id: 'team', name: 'Team', url: 'http://localhost:20001', allowLocalhost: true });
  assert.equal(profile.edition, 'team');
  assert.equal(profile.runtime, 'server');
  assert.deepEqual(profile.auth.methods, ['password', 'feishu']);
  assert.equal(manager.activeProfile().id, 'team');
  assert.equal(JSON.stringify(store.load()).includes('token'), false);
});
