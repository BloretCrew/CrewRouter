'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AppState, MODES } = require('../src/app/state');

test('state transitions cover begin, step, connected, fail and reset', () => {
  const state = new AppState();
  const changes = [];
  state.on('change', (snapshot) => changes.push(snapshot.mode));
  assert.equal(state.mode, 'idle');
  state.begin('local', { retry: { action: 'local', payload: { displayName: 'Ada' } } });
  assert.equal(state.mode, 'starting-local');
  assert.equal(state.pending.kind, 'local');
  assert.equal(state.isBusy(), true);
  state.step(2, 4, '正在启动本地服务');
  assert.deepEqual(state.progress, { step: 2, total: 4, label: '正在启动本地服务' });
  state.connected({ target: 'http://127.0.0.1:4321', instance: { runtime: 'desktop-local', edition: 'personal' }, profile: { id: 'p1', name: 'Ada', mode: 'local' } });
  assert.equal(state.mode, 'connected');
  assert.equal(state.pending, null);
  assert.equal(state.progress, null);
  state.fail('boom', { kind: 'local', retry: { action: 'local' } });
  assert.equal(state.mode, 'error');
  assert.equal(state.target, null, '失败后必须清空 target 以恢复启动页信任');
  assert.equal(state.error.message, 'boom');
  assert.deepEqual(state.error.retry, { action: 'local' });
  state.reset();
  assert.equal(state.mode, 'idle');
  assert.equal(state.error, null);
  assert.deepEqual(changes, ['starting-local', 'starting-local', 'connected', 'error', 'idle']);
});

test('state rejects unknown modes and pending kinds', () => {
  const state = new AppState();
  assert.throws(() => state.set({ mode: 'bogus' }), /未知状态/);
  assert.throws(() => state.begin('teleport'), /未知 pending/);
  for (const mode of MODES) state.set({ mode });
});

test('remote console snapshot omits profiles, local server and pending details', () => {
  const state = new AppState();
  state.set({ localServer: { ready: true, pid: 12, port: 4321, baseUrl: 'http://127.0.0.1:4321', logsDir: '/tmp/logs' }, localProfile: { id: 'l', displayName: 'Ada' }, prefill: { serverUrl: 'https://x.example' } });
  state.connected({ target: 'https://team.example', instance: { runtime: 'server', edition: 'team', auth: { required: true, methods: ['password'] }, capabilities: { teamAdmin: true } }, profile: { id: 'r1', name: 'Team', mode: 'remote', lastConnectedAt: 'now' } });
  const remote = state.snapshot('remoteConsole');
  assert.deepEqual(Object.keys(remote).sort(), ['edition', 'language', 'mode', 'profile', 'runtime', 'target', 'theme']);
  assert.deepEqual(remote.profile, { name: 'Team' });
  const full = state.snapshot('launcher');
  assert.equal(full.localServer.ready, true);
  assert.equal(full.localProfile.displayName, 'Ada');
  assert.equal(full.prefill.serverUrl, 'https://x.example');
  assert.equal(full.capabilities.teamAdmin, true);
  assert.equal(full.auth.required, true);
});

test('runtime falls back to desktop-local when the local server is running but nothing is connected', () => {
  const state = new AppState();
  assert.equal(state.snapshot().runtime, null);
  state.set({ localServer: { ready: true, pid: 1, port: 2 } });
  assert.equal(state.snapshot().runtime, 'desktop-local');
});
