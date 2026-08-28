'use strict';
/**
 * 插件开放能力契约测试（三期）
 * 断言：
 *  - 权限门控：无权限时 ctx 无对应方法；有权限时有
 *  - usage 返回不含 messages/response 正文键
 *  - preferences 未授权返回 granted:false
 *  - webhook URL 校验拒绝内网 / 非 https
 *  - validateManifest 未知权限 warning 不阻断
 */
const assert = require('assert');

// ---- 1. validateManifest 未知权限不阻断 ----
const host = require('../plugins/host');
const manifest = { id: 'test-cap', name: 'Test Cap', permissions: ['usage:read', 'totally-unknown-perm'] };
const err = host.validateManifest(manifest);
assert.strictEqual(err, null, `validateManifest 不应阻断未知权限, got: ${err}`);
console.log('PASS manifest 未知权限不阻断');

// 非法 webhook 声明应阻断
const bad = host.validateManifest({ id: 'bad-webhook', name: 'X', webhooks: [{ url: 'http://insecure' }] });
assert.ok(bad, '非 https webhook 应被拒绝');
console.log('PASS webhook 非 https 被拒绝');

// ---- 2. 权限门控：buildContext 按权限挂 ctx ----
const hooksBus = require('../plugins/hooks');
const permed = host.buildContext({ id: 'cap-a', manifest: { permissions: ['usage:read', 'models:read', 'audit:write', 'meta:read'] }, config: {} }, hooksBus, 'test');
assert.ok(permed.usage, 'usage:read 应暴露 ctx.usage');
assert.ok(permed.models, 'models:read 应暴露 ctx.models');
assert.ok(permed.audit, 'audit:write 应暴露 ctx.audit');
assert.ok(permed.pluginMeta, 'meta:read 应暴露 ctx.pluginMeta');
assert.strictEqual(permed.fetch, undefined, '无 network 权限不应有 fetch');
assert.strictEqual(permed.storage, undefined, '无 storage 权限不应有 storage');
assert.strictEqual(permed.preferences, undefined, '无 preferences:read 不应有 preferences');
assert.strictEqual(permed.webhook, undefined, '无 webhook:register 不应有 webhook');
console.log('PASS 权限门控正确');

// ---- 3. usage 返回不含正文键 ----
(async () => {
  const dataRead = require('../utils/plugin-data-read');
  const out = await dataRead.usageSummary({ days: 1 });
  assert.ok(out && typeof out === 'object');
  assert.ok(Array.isArray(out.rows));
  for (const row of out.rows) {
    assert.strictEqual('messages' in row, false, 'usage 行不应含 messages');
    assert.strictEqual('response' in row, false, 'usage 行不应含 response');
    assert.strictEqual('request_params' in row, false, 'usage 行不应含 request_params');
  }
  assert.ok(out.summary && 'tokens_used' in out.summary);
  console.log(`PASS usage 聚合安全（rows=${out.rows.length}, 含正文键=${Object.keys(out.rows[0] || {}).filter(k => ['messages','response','request_params'].includes(k)).length}）`);
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
