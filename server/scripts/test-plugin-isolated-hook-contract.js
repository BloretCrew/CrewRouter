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
const headers = sanitizeIsolatedHookResult('shopper', 'gateway:finalResponse', { statusCode: 200, headers: {
  'X-Plugin-shopper-trace': 'ok', 'Set-Cookie': 'secret=1', 'X-Plugin-shopper-bad': 'x\r\nInjected: true',
} }, { statusCode: 201, headers: {} });
assert.deepEqual(headers, { statusCode: 201, headers: { 'X-Plugin-shopper-trace': 'ok' } });
const modelInput = sanitizeIsolatedHookInput('shopper', 'models:list', { models: [{ id: 'm1', object: 'model', api_key: 'secret' }, { id: 'm2' }] }, { requestType: 'gemini', userId: 9 });
assert.deepEqual(modelInput, { payload: { models: [{ id: 'm1' }, { id: 'm2' }] }, meta: { requestType: 'gemini' } });
const modelOutput = sanitizeIsolatedHookResult('shopper', 'models:list', { models: [{ id: 'm1' }, { id: 'attacker-added' }] }, { models: [{ id: 'm1', object: 'model' }, { id: 'm2', object: 'model' }] });
assert.deepEqual(modelOutput, { models: [{ id: 'm1', object: 'model' }] });
const providers = sanitizeIsolatedHookInput('shopper', 'provider:select', { candidates: [{ id: 'p1', name: 'One', api_key: 'do-not-cross' }, { id: 'p2', api_key: 'also-secret' }] }, { providerId: 'p1', group: 'g', userId: 9 });
assert.deepEqual(providers, { payload: { candidates: [{ id: 'p1', name: 'One' }, { id: 'p2', name: '' }] }, meta: { providerId: 'p1', group: 'g' } });
const selected = sanitizeIsolatedHookResult('shopper', 'provider:select', { candidateIds: ['p2', 'attacker-provider', 'p2'] }, { candidates: [{ id: 'p1', api_key: 'secret-1' }, { id: 'p2', api_key: 'secret-2' }] });
assert.deepEqual(selected.candidates, [{ id: 'p2', api_key: 'secret-2' }]);
console.log('PASS isolated hook broker strips secrets, constrains billing fields and plugin-owned stats metadata');
