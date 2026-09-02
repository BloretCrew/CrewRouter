'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateRemoteUrl, redactUrl } = require('../src/url-policy');
const { ProfileStore, validateLocalDisplayName } = require('../src/profile-store');
const { RedirectFlow } = require('../src/redirect-flow');
const { ConnectionManager, parseInstanceResponse } = require('../src/connection-manager');

const tempStore = () => new ProfileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-desktop-')), 'profiles.json'));

test('URL policy blocks private targets and redacts secrets', async () => {
  assert.equal((await validateRemoteUrl('http://127.0.0.1:1234')).ok, false);
  assert.equal((await validateRemoteUrl('http://localhost:1234')).ok, false);
  assert.equal((await validateRemoteUrl('http://127.0.0.1:1234', { allowLocalhost: true })).ok, true);
  assert.equal((await validateRemoteUrl('http://example.invalid', { allowLocalhost: true })).ok, false);
  assert.equal((await validateRemoteUrl('http://user:pass@example.com')).ok, false);
  assert.equal((await validateRemoteUrl('https://example.com/?access_token=secret')).ok, false);
  assert.equal((await validateRemoteUrl('file:///tmp/x')).ok, false);
  assert.match(redactUrl('https://example.com/cb?access_token=abc&state=xyz'), /access_token=%5BREDACTED%5D/);
  assert.doesNotMatch(redactUrl('https://example.com/cb?access_token=abc&state=xyz'), /abc|xyz/);
});

test('redirect state is single-use and expires', async () => {
  let now = 1000; const flow = new RedirectFlow({ now: () => now, ttlMs: 10 });
  const state = flow.createState({ source: 'demo' });
  assert.deepEqual(flow.consumeState(state), { source: 'demo' });
  assert.throws(() => flow.consumeState(state), /无效/);
  const expired = flow.createState(); now = 1011;
  assert.throws(() => flow.consumeState(expired), /过期/);
});

test('redirect callback binds one safe target and rejects replay or credentials', async () => {
  const flow = new RedirectFlow({ now: () => 1000 });
  const state = flow.createState({ source: 'demo', serverUrl: 'http://127.0.0.1:20001', targetOrigin: 'http://127.0.0.1:20001' });
  const callback = await flow.parseCallback(`crewrouter://connect/?state=${state}`, { allowLocalhost: true });
  assert.equal(callback.serverUrl, 'http://127.0.0.1:20001/');
  assert.throws(() => flow.parseCallback(`crewrouter://connect/?state=${state}`), /无效/);
  const second = flow.createState({ serverUrl: 'http://127.0.0.1:20001', targetOrigin: 'http://127.0.0.1:20001' });
  await assert.rejects(() => flow.parseCallback(`crewrouter://connect/?state=${second}&serverUrl=https%3A%2F%2Fother.example`, { allowLocalhost: true }), /不一致|DNS|内网/);
  const third = flow.createState({ serverUrl: 'http://127.0.0.1:20001' });
  assert.throws(() => flow.parseCallback(`crewrouter://connect/?state=${third}&code=secret`, { allowLocalhost: true }), /凭据/);
});

test('Demo URL construction supports configured templates without inventing an endpoint', () => {
  const flow = new RedirectFlow();
  const result = flow.buildDemoUrl('https://demo.example/redirect?next={target}', { target: 'https://target.example', metadata: { serverUrl: 'https://target.example' } });
  const url = new URL(result.url);
  assert.equal(url.pathname, '/redirect');
  assert.equal(url.searchParams.get('next'), 'https://target.example');
  assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{40,}$/);
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
  const manager = new ConnectionManager({ store, fetchImpl: async (url) => ({ ok: true, async json() { return { runtime: 'server', edition: 'team', auth: { required: true, methods: ['password', 'feishu'] }, capabilities: { sso: true }, protocolVersion: '1' }; } }) });
  const profile = await manager.connect({ id: 'team', name: 'Team', url: 'http://localhost:20001', allowLocalhost: true });
  assert.equal(profile.edition, 'team');
  assert.equal(profile.runtime, 'server');
  assert.deepEqual(profile.auth.methods, ['password', 'feishu']);
  assert.equal(manager.activeProfile().id, 'team');
  assert.equal(JSON.stringify(store.load()).includes('token'), false);
});
