'use strict';

const assert = require('assert');
const { cleanBaseUrl, upstreamUrl, isBlockedIPv6 } = require('../utils/url-validator');

const cases = [
  ['https://api.openai.com', '/chat/completions', 'https://api.openai.com/v1/chat/completions'],
  ['https://api.openai.com/v1', '/chat/completions', 'https://api.openai.com/v1/chat/completions'],
  ['https://openrouter.ai/api/v1', '/chat/completions', 'https://openrouter.ai/api/v1/chat/completions'],
  ['https://open.bigmodel.cn/api/paas/v4', '/chat/completions', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
  ['https://generativelanguage.googleapis.com/v1beta', '/models', 'https://generativelanguage.googleapis.com/v1beta/models'],
  ['https://example.com/V2/', '/responses', 'https://example.com/V2/responses'],
  ['https://example.com/api', '/models', 'https://example.com/api/v1/models'],
  ['https://generativelanguage.googleapis.com', '/models/gemini-2.5-pro:generateContent', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent', '/v1beta'],
  ['https://generativelanguage.googleapis.com/v1beta', '/models/gemini-2.5-pro:generateContent', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent', '/v1beta'],
  ['https://example.com/v1//', '/chat/completions', 'https://example.com/v1/chat/completions'],
  ['https://example.com/api/v1///', '/responses', 'https://example.com/api/v1/responses'],
];

for (const [base, endpoint, expected, defaultVersion] of cases) {
  assert.strictEqual(upstreamUrl(base, endpoint, defaultVersion), expected, `${base} + ${endpoint}`);
}

assert.strictEqual(
  cleanBaseUrl('https://open.bigmodel.cn/api/paas/v4/chat/completions'),
  'https://open.bigmodel.cn/api/paas/v4'
);
assert.strictEqual(
  upstreamUrl('https://open.bigmodel.cn/api/paas/v4/chat/completions', '/chat/completions'),
  'https://open.bigmodel.cn/api/paas/v4/chat/completions'
);
assert.strictEqual(
  cleanBaseUrl('https://example.com/v1/chat/completions//'),
  'https://example.com'
);

const blockedIPv6 = ['::', '::1', '0:0:0:0:0:0:0:1', 'fc12::1', 'fdab::1', 'fe90::1', 'febf::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254'];
for (const ip of blockedIPv6) {
  assert.strictEqual(isBlockedIPv6(ip), true, `${ip} should be blocked`);
}
assert.strictEqual(isBlockedIPv6('2001:4860:4860::8888'), false);

console.log(`upstreamUrl/IPv6: ${cases.length + blockedIPv6.length + 4} assertions passed`);
