const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRemoteUrl } = require('../src/url-policy');

test('remote hostname resolving to loopback is blocked before connection', async () => {
  const target = await validateRemoteUrl('https://remote.example', { lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  assert.equal(target.ok, false);
});

test('mixed public and private DNS answers are rejected before the target fetch', async () => {
  const target = await validateRemoteUrl('https://remote.example', { lookup: async () => [
    { address: '8.8.8.8', family: 4 }, { address: 'fd00::1', family: 6 },
  ] });
  assert.equal(target.ok, false);
  const targetRequests = target.ok ? 1 : 0;
  assert.equal(targetRequests, 0);
});

test('public-only DNS answers allow a remote target', async () => {
  assert.equal((await validateRemoteUrl('https://remote.example', { lookup: async () => [
    { address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 },
  ] })).ok, true);
});
