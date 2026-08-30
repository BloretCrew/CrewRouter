'use strict';
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
test('scans invalid or missing hooks', () => {
  const old = process.env.GROK_HOME; process.env.GROK_HOME = '/tmp/crewrouter-helper-test-missing';
  const status = api.scanHooks('/missing/cr-report'); assert.equal(status.exists, false);
  if (old === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = old;
});
