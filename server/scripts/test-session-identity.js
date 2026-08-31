'use strict';

const assert = require('assert');
const {
  sessionKeyFor,
  extractEventIdentity,
  extractRequestIdentity,
} = require('../utils/session-identity');

const harnesses = ['claude_code', 'codex', 'grok', 'qwen_code', 'opencode', 'hermes', 'openclaw', 'deepseek_harness'];
for (const harness of harnesses) {
  const identity = extractEventIdentity({ harness, session_id: 'same-session' });
  assert.strictEqual(identity.harness, harness);
  assert.strictEqual(identity.confidence, 'high');
  assert.strictEqual(identity.logicalSessionKey, sessionKeyFor('same-session', harness));
}

const first = extractRequestIdentity({
  headers: { 'x-session-id': 'session-a' },
  body: { session_id: 'ignored-body' },
}, { requestSource: 'codex' });
assert.strictEqual(first.sessionId, 'session-a');
assert.strictEqual(first.sessionIdSource, 'header');
assert.notStrictEqual(first.logicalSessionKey, sessionKeyFor('session-b', 'codex'));
assert.strictEqual(
  extractRequestIdentity({ headers: {}, body: { sessionId: 'session-a' } }, { requestSource: 'codex' }).logicalSessionKey,
  first.logicalSessionKey,
);
assert.strictEqual(
  extractRequestIdentity({ headers: { 'thread-id': 'thread-a' }, body: {} }, { requestSource: 'codex' }).sessionId,
  'thread-a',
);
assert.strictEqual(
  extractRequestIdentity({ headers: {}, body: { session_key: 'openclaw:main:subagent:worker' } }, { requestSource: 'openclaw' }).sessionId,
  'openclaw:main:subagent:worker',
);
assert.notStrictEqual(
  extractRequestIdentity({ headers: {}, body: { session_id: 'same-session' } }, { requestSource: 'codex' }).logicalSessionKey,
  extractRequestIdentity({ headers: {}, body: { session_id: 'same-session' } }, { requestSource: 'grok' }).logicalSessionKey,
);

const parentChild = extractRequestIdentity({
  headers: {},
  body: { session_id: 'child', parent_session_id: 'parent', subagent_id: 'worker-1' },
}, { requestSource: 'openclaw' });
assert.strictEqual(parentChild.parentSessionId, 'parent');
assert.strictEqual(parentChild.subagentId, 'worker-1');
assert.notStrictEqual(parentChild.logicalSessionKey, parentChild.parentSessionKey);

const unknown = extractEventIdentity({ harness: 'hermes' });
assert.strictEqual(unknown.logicalSessionKey, null);
assert.strictEqual(unknown.confidence, 'unknown');

console.log('All session identity assertions passed.');
