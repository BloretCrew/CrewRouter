'use strict';

const assert = require('assert');
const { extractAttribution } = require('../utils/attribution');
const proxyPool = require('../proxy-pool');
const config = require('../config-loader');
const api = require('../routes/api');

const attribution = extractAttribution({
  headers: {
    'X-Codex-Parent-Thread-Id': 'parent-header',
    'x-openai-subagent': 'collab_spawn',
    'X-Grok-Session-Id': 'grok-session',
  },
  body: {
    metadata: { user_id: JSON.stringify({ session_id: 'anthropic-session', account_uuid: 'account' }) },
    client_metadata: { thread_id: 'thread-body', agent_name: 'worker' },
    promptId: 'qwen-session#subagent#1',
  },
});
assert.strictEqual(attribution.parentThreadId, 'thread-body');
assert.strictEqual(attribution.subagent, 'worker');
assert.strictEqual(attribution.sessionId, 'anthropic-session');
assert.ok(attribution.source.length >= 6);

const proxies = [
  { id: 'proxy-a', url: 'http://proxy-a', enabled: true },
  { id: 'proxy-b', url: 'http://proxy-b', enabled: true },
];
const originalRandom = Math.random;
Math.random = () => 0;
const first = proxyPool.selectBestProxy(proxies, 'test-provider', 'same-key');
Math.random = () => 0.99;
const pinned = proxyPool.selectBestProxy(proxies, 'test-provider', 'same-key');
const different = proxyPool.selectBestProxy(proxies, 'test-provider', 'different-key');
assert.strictEqual(first.id, pinned.id);
assert.strictEqual(different.id, 'proxy-b');
proxyPool.markProxy429('test-provider', first.id);
assert.strictEqual(proxyPool.selectBestProxy(proxies, 'test-provider', 'same-key').id, 'proxy-b');
Math.random = originalRandom;

assert.strictEqual(config.gateway.fourth_cache_breakpoint, false);
const makeBody = (cacheCount) => ({
  messages: Array.from({ length: 6 }, (_, index) => ({
    role: index === 5 ? 'user' : (index % 2 ? 'assistant' : 'user'),
    content: index === 5 ? [{ type: 'text', text: 'tail' }] : [{ type: 'text', text: `message-${index}` }],
  })),
});
const enabledBody = makeBody(0);
enabledBody.messages[0].content[0].cache_control = { type: 'ephemeral' };
assert.strictEqual(api.addFourthCacheBreakpoint(enabledBody, undefined, true), true);
assert.deepStrictEqual(enabledBody.messages[5].content.at(-1).cache_control, { type: 'ephemeral' });
const disabledBody = makeBody(0);
assert.strictEqual(api.addFourthCacheBreakpoint(disabledBody, undefined, false), false);
assert.strictEqual(disabledBody.messages[5].content.at(-1).cache_control, undefined);
console.log('attribution, affinity, and fourth-breakpoint assertions passed');
