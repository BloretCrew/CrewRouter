'use strict';
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../src');
test('maps Grok and Claude event field names', () => {
  assert.equal(api.mapHookEvent({ hookEventName: 'PostToolUse' }), 'tool_use');
  assert.equal(api.mapHookEvent({ hook_event_name: 'session_start' }), 'session_start');
  assert.equal(api.mapHookEvent({ hookEventName: 'Unknown' }), null);
});
test('normalizes compatible fields without sensitive values', () => {
  const p = api.normalizeHook({ sessionId: 's', toolName: 'Bash', workspaceRoot: '/tmp', toolInput: { command: 'secret' }, hookEventName: 'PreToolUse' });
  assert.equal(p.session_id, 's'); assert.equal(p.tool_name, 'Bash'); assert.equal(p.event, 'tool_use');
  assert.deepEqual(p.detail.tool_input_keys, ['command']); assert.equal(p.detail.tool_input, undefined);
});
test('redacts credentials and commands', () => {
  const safe = api.safeDetail({ message: 'Authorization: Bearer abc123 token=xyz', error: 'curl https://x.test/?token=secret' });
  assert.match(safe.message, /REDACTED/); assert.doesNotMatch(safe.message, /abc123|xyz/); assert.doesNotMatch(safe.error, /secret/);
});
test('scans invalid or missing hooks', () => {
  const old = process.env.GROK_HOME; process.env.GROK_HOME = `/tmp/crewrouter-helper-test-missing-${process.pid}`;
  try { fs.rmSync(process.env.GROK_HOME, { recursive: true, force: true }); } catch {}
  const status = api.scanHooks('/missing/cr-report'); assert.equal(status.exists, false); assert.equal(status.level, 'MISSING');
  if (old === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = old;
});
test('quotes and parses paths containing spaces', () => {
  const command = api.shellQuote('/tmp/my cli/cr-report'); assert.equal(api.commandPath(command + ' hook --harness grok'), '/tmp/my cli/cr-report');
});
test('credential status detects expired credentials', () => {
  assert.equal(api.credentialStatus({ access_token: 'x', expires_at: 1 }).level, 'ERROR');
  assert.equal(api.credentialStatus({ access_token: 'x', refresh_token: 'r', expires_at: 1 }).level, 'WARN');
});

test('watch detection distinguishes absent state', () => {
  const old = process.env.HOME; process.env.HOME = '/tmp/crewrouter-helper-watch-test';
  assert.equal(api.watchState().running, false);
  if (old === undefined) delete process.env.HOME; else process.env.HOME = old;
});
