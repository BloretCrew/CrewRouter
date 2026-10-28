'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeUsageTokens } = require('../utils/token-normalize');

test('normalization preserves valid zeroes and parses integer strings before arithmetic', () => {
  assert.deepEqual(normalizeUsageTokens({ prompt_tokens: '12', completion_tokens: '3', cached_tokens: '2' }), {
    promptTokens: 12, completionTokens: 3, totalTokens: 15, cachedTokens: 2, cacheCreationTokens: 0,
  });
  assert.equal(normalizeUsageTokens({ prompt_tokens: 0, input_tokens: 40, cached_tokens: 0, prompt_tokens_details: { cached_tokens: 8 } }).promptTokens, 0);
  assert.equal(normalizeUsageTokens({ cached_tokens: 0, prompt_tokens_details: { cached_tokens: 8 } }).cachedTokens, 0);
  assert.equal(normalizeUsageTokens(null).totalTokens, 0);
});

test('Anthropic cache components are summed numerically and Gemini aliases remain supported', () => {
  assert.deepEqual(normalizeUsageTokens({ input_tokens: '10', cache_read_input_tokens: '20', cache_creation_input_tokens: '5', output_tokens: '2' }, 'anthropic'), {
    promptTokens: 35, completionTokens: 2, totalTokens: 37, cachedTokens: 20, cacheCreationTokens: 5,
  });
  assert.equal(normalizeUsageTokens({ input_tokens: '9', output_tokens: 1, cached_content_token_count: '4' }, 'gemini').totalTokens, 10);
});

test('malformed and out-of-range upstream counts are rejected rather than clamped', () => {
  for (const invalid of [-1, '-1', NaN, Infinity, -Infinity, 1.5, '1.5', '', ' ', '1e3', true, false, [], {}, 2147483648]) {
    assert.throws(() => normalizeUsageTokens({ prompt_tokens: invalid }), /Invalid token count/);
    assert.throws(() => normalizeUsageTokens({ output_tokens: invalid }, 'anthropic'), /Invalid token count/);
    assert.throws(() => normalizeUsageTokens({ cached_content_token_count: invalid }, 'gemini'), /Invalid token count/);
  }
  assert.throws(() => normalizeUsageTokens({ prompt_tokens: 2147483647, completion_tokens: 1 }), /totalTokens/);
  assert.throws(() => normalizeUsageTokens({ input_tokens: 2147483647, cache_read_input_tokens: 1 }, 'anthropic'), /promptTokens/);
});
