'use strict';

const assert = require('assert');
const { cleanBaseUrl, upstreamUrl, isBlockedIPv6, isPrivateIPv4 } = require('../utils/url-validator');

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

// 198.18.0.0/15 是 RFC 2544 基准测试网段，Fake-IP 代理用它做公网域名占位，不属于私网
assert.strictEqual(isPrivateIPv4('198.18.0.25'), false);
assert.strictEqual(isPrivateIPv4('198.19.255.255'), false);
assert.strictEqual(isPrivateIPv4('10.0.0.1'), true);
assert.strictEqual(isPrivateIPv4('192.168.1.1'), true);
assert.strictEqual(isPrivateIPv4('169.254.169.254'), true);

console.log(`upstreamUrl/IPv6: ${cases.length + blockedIPv6.length + 9} assertions passed`);
