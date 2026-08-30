'use strict';

const assert = require('assert');
const {
  ERROR_CATEGORIES,
  buildAuthHeaders,
  getCapabilityPolicy,
  classifyRequestError
} = require('../utils/request-policy');

assert.deepStrictEqual(buildAuthHeaders('anthropic', 'k'), { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
assert.deepStrictEqual(buildAuthHeaders('gemini', 'k'), { 'x-goog-api-key': 'k' });
assert.deepStrictEqual(buildAuthHeaders('openai', 'k'), { Authorization: 'Bearer k' });
assert.strictEqual(getCapabilityPolicy('openai', 'anthropic').supported, true);
assert.strictEqual(getCapabilityPolicy('unknown', 'openai').supported, false);
assert.strictEqual(classifyRequestError({ status: 401 }).category, ERROR_CATEGORIES.AUTHENTICATION);
assert.strictEqual(classifyRequestError({ status: 429 }).category, ERROR_CATEGORIES.RATE_LIMIT);
assert.strictEqual(classifyRequestError({ code: 'unsupported_provider_format' }).category, ERROR_CATEGORIES.CAPABILITY);
assert.strictEqual(classifyRequestError({ timeout: true }).category, ERROR_CATEGORIES.TIMEOUT);

console.log('request policy tests passed');
