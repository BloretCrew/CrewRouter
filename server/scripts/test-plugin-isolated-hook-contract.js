'use strict';
const assert = require('node:assert/strict');
const { sanitizeIsolatedHookInput, sanitizeIsolatedHookResult } = require('../plugins/isolated-hook-contract');

const billing = sanitizeIsolatedHookInput('shopper', 'billing:calculate', {
  cost: 3, ratio: 2, weightedTokens: 100, apiKey: 'secret', requestBody: { prompt: 'private' },
}, { requestType: 'openai', userId: 42, provider: { apiKey: 'secret' } });
assert.deepEqual(billing, { payload: { cost: 3, ratio: 2, weightedTokens: 100 }, meta: { requestType: 'openai' } });
assert.deepEqual(sanitizeIsolatedHookResult('shopper', 'billing:calculate', { cost: 2.7, ratio: 1.8, apiKey: 'leak' }, { cost: 3, ratio: 2, weightedTokens: 100 }), { cost: 2.7, ratio: 1.8, weightedTokens: 100 });
assert.throws(() => sanitizeIsolatedHookResult('shopper', 'billing:calculate', { cost: -1 }, { cost: 1 }), /invalid cost/);
const stats = sanitizeIsolatedHookInput('shopper', 'stats:record', { meta: { 'plugin:shopper': 'x', 'plugin:other': 'leak', 'dim:shopper:cost': 1, userId: 42 } }, { userId: 42, provider: 'private' });
assert.deepEqual(stats, { payload: { meta: { 'plugin:shopper': 'x', 'dim:shopper:cost': 1 } }, meta: { requestType: '' } });
const result = sanitizeIsolatedHookResult('shopper', 'stats:record', { meta: { 'plugin:shopper': 'safe', 'plugin:other': 'no', email: 'no' } }, { meta: { existing: true } });
assert.deepEqual(result, { meta: { existing: true, 'plugin:shopper': 'safe' } });
assert.throws(() => sanitizeIsolatedHookInput('shopper', 'gateway:beforeUpstream', {}, {}), /不支持/);
console.log('PASS isolated hook broker strips secrets, constrains billing fields and plugin-owned stats metadata');
