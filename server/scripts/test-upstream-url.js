'use strict';

const assert = require('assert');
const { cleanBaseUrl, upstreamUrl } = require('../utils/url-validator');

const cases = [
  ['https://api.openai.com', '/chat/completions', 'https://api.openai.com/v1/chat/completions'],
  ['https://api.openai.com/v1', '/chat/completions', 'https://api.openai.com/v1/chat/completions'],
  ['https://openrouter.ai/api/v1', '/chat/completions', 'https://openrouter.ai/api/v1/chat/completions'],
  ['https://open.bigmodel.cn/api/paas/v4', '/chat/completions', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
  ['https://generativelanguage.googleapis.com/v1beta', '/models', 'https://generativelanguage.googleapis.com/v1beta/models'],
  ['https://example.com/V2/', '/responses', 'https://example.com/V2/responses'],
  ['https://example.com/api', '/models', 'https://example.com/api/v1/models'],
];

for (const [base, endpoint, expected] of cases) {
  assert.strictEqual(upstreamUrl(base, endpoint), expected, `${base} + ${endpoint}`);
}

assert.strictEqual(
  cleanBaseUrl('https://open.bigmodel.cn/api/paas/v4/chat/completions'),
  'https://open.bigmodel.cn/api/paas/v4'
);
assert.strictEqual(
  upstreamUrl('https://open.bigmodel.cn/api/paas/v4/chat/completions', '/chat/completions'),
  'https://open.bigmodel.cn/api/paas/v4/chat/completions'
);

console.log(`upstreamUrl: ${cases.length + 2} assertions passed`);
