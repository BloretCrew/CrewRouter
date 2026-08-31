'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateRemoteUrl, redactUrl } = require('../src/url-policy');
const { ProfileStore } = require('../src/profile-store');
const { RedirectFlow } = require('../src/redirect-flow');
const { ConnectionManager, parseInstanceResponse } = require('../src/connection-manager');

const tempStore = () => new ProfileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-desktop-')), 'profiles.json'));

test('URL policy blocks private targets and redacts secrets', async () => {
  assert.equal((await validateRemoteUrl('http://127.0.0.1:1234')).ok, false);
  assert.equal((await validateRemoteUrl('http://localhost:1234')).ok, false);
  assert.equal((await validateRemoteUrl('http://127.0.0.1:1234', { allowLocalhost: true })).ok, true);
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

test('profile store recovers corruption and switches profiles', () => {
  const store = tempStore();
  assert.equal(store.load().profiles.length, 0);
  store.upsert({ id: 'a', name: 'A', url: 'https://a.example' });
  store.upsert({ id: 'b', name: 'B', url: 'https://b.example', edition: 'team' });
  store.setActive('b'); assert.equal(store.getActive().id, 'b');
  fs.writeFileSync(store.filePath, '{broken');
  assert.equal(store.load().profiles.length, 0);
});

test('/api/instance parses personal/team and rejects invalid responses', () => {
  assert.equal(parseInstanceResponse({ edition: 'personal' }).edition, 'personal');
  assert.equal(parseInstanceResponse({ data: { edition: 'team' } }).edition, 'team');
  assert.throws(() => parseInstanceResponse({ edition: 'enterprise' }), /无效/);
  assert.throws(() => parseInstanceResponse({}), /缺失/);
});

test('connection manager saves metadata without tokens', async () => {
  const store = tempStore();
  const manager = new ConnectionManager({ store, fetchImpl: async (url) => ({ ok: true, async json() { return { edition: 'team', capabilities: { sso: true }, protocolVersion: '1' }; } }) });
  const profile = await manager.connect({ id: 'team', name: 'Team', url: 'http://localhost:20001', allowLocalhost: true });
  assert.equal(profile.edition, 'team');
  assert.equal(manager.activeProfile().id, 'team');
  assert.equal(JSON.stringify(store.load()).includes('token'), false);
});
