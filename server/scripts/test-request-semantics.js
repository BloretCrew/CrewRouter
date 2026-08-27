'use strict';

const assert = require('assert');
const { classifyRequestSemantics, resetRequestSemanticsCache } = require('../utils/request-semantics');

function classify(body = {}, headers = {}, extra = {}) {
  return classifyRequestSemantics({ body, headers, requestSource: extra.requestSource, url: extra.url });
}

let result = classify({}, {}, { url: '/session/s-1/summarize' });
assert.deepStrictEqual([result.type, result.confidence], ['compaction', 'high']);
assert(result.reason_codes.includes('url.opencode.session.summarize'));

result = classify({ messages: [{ role: 'user', content: 'compact this' }] }, { 'x-openai-subagent': 'compact' });
assert.deepStrictEqual([result.type, result.confidence], ['compaction', 'high']);

result = classify({ client_metadata: { parent_thread_id: 'parent-1' }, messages: [{ role: 'user', content: 'review this change' }] }, { 'x-openai-subagent': 'review' });
assert.deepStrictEqual([result.type, result.confidence], ['review', 'high']);

result = classify({ client_metadata: { parent_thread_id: 'parent-1' }, messages: [{ role: 'user', content: 'delegate' }] });
assert.deepStrictEqual([result.type, result.confidence], ['subagent', 'high']);

result = classify({ prompt_id: 'abc#sub#1', messages: [{ role: 'user', content: 'delegate' }] });
assert.deepStrictEqual([result.type, result.confidence], ['subagent', 'medium']);

result = classify({ system: 'You are the Goal Plan Writer for the xAI Grok Build harness.', messages: [{ role: 'user', content: 'plan' }] });
assert.deepStrictEqual([result.type, result.confidence], ['plan', 'medium']);
result = classify({ system: 'You are the Goal Summarizer for the xAI Grok Build harness.', max_tokens: 200, messages: [{ role: 'user', content: 'summarize' }] });
assert.deepStrictEqual([result.type, result.confidence], ['title', 'medium']);
result = classify({ system: 'You are the Goal Strategist for the xAI Grok Build harness.', messages: [{ role: 'user', content: 'plan_mode' }] });
assert.deepStrictEqual([result.type, result.confidence], ['other_automation', 'low']);

result = classify({ messages: [{ role: 'user', content: 'please summarize this document' }] });
assert.notStrictEqual(result.type, 'compaction');
assert.strictEqual(result.type, 'primary');

result = classify({ input: 'hello', max_output_tokens: 100 });
assert.strictEqual(result.type, 'primary');
result = classify({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }], max_output_tokens: 100 });
assert.strictEqual(result.type, 'primary');
result = classify({ input: '' });
assert.strictEqual(result.type, 'heartbeat');

result = classify({ messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 });
assert.notStrictEqual(result.type, 'title');
assert(['other_automation', 'primary'].includes(result.type));

result = classify({ system: 'You are a coding assistant.', tools: [{ type: 'function', function: { name: 'read' } }], messages: [{ role: 'user', content: 'Fix the failing test in this repository.' }, { role: 'assistant', content: 'I will inspect the repository and run the relevant tests.' }] }, {}, { requestSource: 'codex' });
assert.strictEqual(result.type, 'primary');

result = classify({});
assert.strictEqual(result.type, 'heartbeat');

resetRequestSemanticsCache();
const retryBody = { messages: [{ role: 'user', content: 'same request' }] };
assert.notStrictEqual(classify(retryBody).type, 'retry');
assert.notStrictEqual(classify(retryBody, {}, { requestSource: 'codex' }).type, 'retry');
assert.notStrictEqual(classify({ ...retryBody, metadata: { user_id: 'user-1' }, prompt_cache_key: 'cache-1' }, { 'x-grok-session-id': 'other-session' }).type, 'retry');
assert.strictEqual(classify(retryBody, { 'x-codex-parent-thread-id': 'thread-1' }).type, 'subagent');
assert.strictEqual(classify(retryBody, { 'x-codex-parent-thread-id': 'thread-1' }).type, 'subagent');
assert.strictEqual(classify({ messages: [{ role: 'user', content: `same request${'x'.repeat(20000)}` }] }, { 'x-codex-parent-thread-id': 'thread-1' }).type, 'subagent');
resetRequestSemanticsCache();
assert.notStrictEqual(classify(retryBody, { 'x-grok-session-id': 'session-1' }).type, 'retry');
assert.strictEqual(classify(retryBody, { 'x-grok-session-id': 'session-1' }).type, 'retry');
assert.notStrictEqual(classify({ messages: [{ role: 'user', content: `same request${'x'.repeat(20000)}` }] }, { 'x-grok-session-id': 'session-1' }).type, 'retry');

console.log('request semantics tests passed');
