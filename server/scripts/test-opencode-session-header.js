'use strict';

// 回归：OpenCode Zen / Go 上游要求 x-opencode-session，第三方客户端缺失时需由网关补齐。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { extractRequestIdentity } = require('../utils/session-identity');
const { filterResponsesLiteHeader } = require('../utils/responses-compat');

const source = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
const start = source.indexOf('function isOpenCodeUpstream(');
const end = source.indexOf('// 清理 base_url 与拼接上游端点');
assert.ok(start > 0 && end > start, 'api.js helper section not found');

const context = { crypto, URL, extractRequestIdentity, filterResponsesLiteHeader };
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
const { buildUpstreamHeaders } = context;

const openCodeProvider = {
  base_url: 'https://opencode.ai/inference/go/openai/v1',
  format: 'openai',
  forward_headers: true,
};

function req(headers = {}, apiUser = { keyId: 106, userId: 1 }) {
  return { headers, body: {}, apiUser };
}

// 1. 第三方客户端无 x-opencode-session 时补齐，并按会话身份保持稳定
const first = buildUpstreamHeaders(openCodeProvider, req({ 'x-grok-session-id': 'grok-session-1' }), {});
const second = buildUpstreamHeaders(openCodeProvider, req({ 'x-grok-session-id': 'grok-session-1' }), {});
assert.ok(first['x-opencode-session'], 'must inject x-opencode-session');
assert.equal(first['x-opencode-session'], second['x-opencode-session'], 'same session must keep same routing key');
assert.notEqual(
  first['x-opencode-session'],
  buildUpstreamHeaders(openCodeProvider, req({ 'x-grok-session-id': 'grok-session-2' }), {})['x-opencode-session'],
  'different sessions must not share routing key',
);

// 2. 客户端自带时保持不变
assert.equal(
  buildUpstreamHeaders(openCodeProvider, req({ 'x-opencode-session': 'client-key' }), {})['x-opencode-session'],
  'client-key',
);

// 3. forward_headers=false 也要补齐
assert.ok(
  buildUpstreamHeaders({ ...openCodeProvider, forward_headers: false }, req(), {})['x-opencode-session'],
  'injection must not depend on forward_headers',
);

// 4. 无会话头时按 API Key 稳定回退
const noSessionA = buildUpstreamHeaders(openCodeProvider, req(), {});
const noSessionB = buildUpstreamHeaders(openCodeProvider, req(), {});
assert.equal(noSessionA['x-opencode-session'], noSessionB['x-opencode-session']);

// 5. 非 OpenCode 上游不注入
assert.equal(
  buildUpstreamHeaders({ base_url: 'https://api.deepseek.com', format: 'openai' }, req(), {})['x-opencode-session'],
  undefined,
);

// 6. OpenCode 严格校验：消息及内容块的私有字段必须被裁剪
const cleaned = context.sanitizeOpenAIMessages([
  {
    role: 'user',
    isMeta: true,
    model_id: 'internal',
    content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
  },
]);
assert.equal(JSON.stringify(cleaned), JSON.stringify([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]));

console.log('OpenCode session header injection: 6/6 passed');
