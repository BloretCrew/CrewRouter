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

result = classify({}, { 'x-openai-subagent': 'review' });
assert.deepStrictEqual([result.type, result.confidence], ['review', 'high']);

result = classify({ client_metadata: { parent_thread_id: 'parent-1' }, messages: [{ role: 'user', content: 'delegate' }] });
assert.deepStrictEqual([result.type, result.confidence], ['subagent', 'high']);

result = classify({ prompt_id: 'abc#sub#1', messages: [{ role: 'user', content: 'delegate' }] });
assert.deepStrictEqual([result.type, result.confidence], ['subagent', 'medium']);

result = classify({ system: 'You are the Goal Summarizer for the xAI Grok Build harness.', max_tokens: 200, messages: [{ role: 'user', content: 'summarize' }] });
assert.deepStrictEqual([result.type, result.confidence], ['title', 'medium']);

result = classify({ messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 });
assert.notStrictEqual(result.type, 'title');
assert(['unknown', 'other_automation', 'primary'].includes(result.type));

result = classify({ system: 'You are a coding assistant.', tools: [{ type: 'function', function: { name: 'read' } }], messages: [{ role: 'user', content: 'Fix the failing test in this repository.' }, { role: 'assistant', content: 'I will inspect the repository and run the relevant tests.' }] }, {}, { requestSource: 'codex' });
assert.strictEqual(result.type, 'primary');

result = classify({});
assert.strictEqual(result.type, 'heartbeat');

resetRequestSemanticsCache();
const retryBody = { messages: [{ role: 'user', content: 'same request' }] };
assert.notStrictEqual(classify(retryBody, { 'x-grok-session-id': 'session-1' }).type, 'retry');
assert.strictEqual(classify(retryBody, { 'x-grok-session-id': 'session-1' }).type, 'retry');

console.log('request semantics tests passed');
