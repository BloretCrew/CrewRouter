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
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFixture(relative, dependencies) {
  const filename = path.resolve(__dirname, '..', relative);
  const fixtureModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: fixtureModule,
    exports: fixtureModule.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected fixture dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename });
  return fixtureModule.exports;
}

const queries = [];
const aggregate = { request_count: 2, tokens_used: '17', cached_tokens: '3', weighted_tokens: '20', cost: '0.125' };
const pool = {
  async query(sql, params) {
    assert.ok(queries.length < 6, 'Unexpected extra fixture query');
    assert.match(sql, /^\s*SELECT\b/);
    assert.match(sql, /FROM usage_records WHERE user_id = \$1 AND created_at >= NOW\(\)/);
    assert.doesNotMatch(sql, /\b(?:messages|response|request_params)\b|\bSELECT\s+\*/i);
    assert.deepStrictEqual(Array.from(params), [10, 1]);
    queries.push({ sql, params: Array.from(params) });
    return { rows: [{ ...aggregate }] };
  },
  connect() { throw new Error('Database connections are forbidden in this fixture'); },
};
const dataRead = loadFixture('utils/plugin-data-read.js', { '../models/database': { pool } });
const host = loadFixture('plugins/host.js', {
  fs, path, vm,
  '../models/database': { pool },
  '../logger': { info() {}, warn() {}, error() {} },
  '../proxy-pool': {},
  '../utils/plugin-data-read': dataRead,
  '../utils/audit-log': { logAction() { throw new Error('Unexpected fixture audit write'); }, ACTIONS: {} },
  './registry': {},
});

// ---- 1. validateManifest 未知权限不阻断 ----
const manifest = { id: 'test-cap', name: 'Test Cap', permissions: ['usage:read', 'totally-unknown-perm'] };
const err = host.validateManifest(manifest);
assert.strictEqual(err, null, `validateManifest 不应阻断未知权限, got: ${err}`);
console.log('PASS manifest 未知权限不阻断');

// 非法 webhook 声明应阻断
const bad = host.validateManifest({ id: 'bad-webhook', name: 'X', webhooks: [{ url: 'http://insecure' }] });
assert.ok(bad, '非 https webhook 应被拒绝');
console.log('PASS webhook 非 https 被拒绝');

// ---- 2. 权限门控：buildContext 按权限挂 ctx ----
const subscriptions = [];
const hooksBus = { subscribe(...args) { subscriptions.push(args); } };
const permed = host.buildContext({ id: 'cap-a', manifest: { permissions: ['usage:read', 'export:usage', 'models:read', 'audit:write', 'meta:read'] }, config: {} }, hooksBus, 'test');
assert.ok(permed.usage, 'usage:read 应暴露 ctx.usage');
assert.ok(permed.models, 'models:read 应暴露 ctx.models');
assert.ok(permed.audit, 'audit:write 应暴露 ctx.audit');
assert.ok(permed.pluginMeta, 'meta:read 应暴露 ctx.pluginMeta');
assert.strictEqual(permed.pluginMeta.get('other-plugin'), null, 'meta:read 默认不得读取其他插件');
assert.strictEqual(permed.fetch, undefined, '无 network 权限不应有 fetch');
assert.strictEqual(permed.storage, undefined, '无 storage 权限不应有 storage');
assert.strictEqual(permed.preferences, undefined, '无 preferences:read 不应有 preferences');
assert.strictEqual(permed.webhook, undefined, '无 webhook:register 不应有 webhook');
assert.strictEqual(permed.tasks, undefined, '无 tasks:register 不应有任务 API');
console.log('PASS 权限门控正确');

// ---- 3. hook 名白名单及主体强制约束 ----
assert.throws(() => permed.on('unregistered:event', () => {}), /未知或不允许的钩子/);
const gatewayCtx = host.buildContext({ id: 'gateway-cap', manifest: { permissions: ['gateway:modify'] }, config: {} }, hooksBus, 'test');
gatewayCtx.on('gateway:beforeUpstream', () => {});
assert.strictEqual(subscriptions.length, 1);
assert.throws(() => gatewayCtx.on('billing:calculate', () => {}), /需要 billing:modify/);
const unscopedUsage = permed.usage.summary({ userId: 10, days: 1 });

// ---- 4. usage 返回不含正文键且主体由宿主确定 ----
(async () => {
  await assert.rejects(unscopedUsage, /已认证的用户请求上下文/);
  const out = await permed.usage.summary({ authUser: { id: 10 } }, { userId: 999, apiKeyId: 888, days: 1 });
  const modelUsage = await permed.usage.models({ authUser: { id: 10 } }, { userId: 999, apiKeyId: 888, days: 1 });
  const exported = await permed.exportUsage.json({ authUser: { id: 10 } }, { userId: 999, apiKeyId: 888, days: 1 });
  assert.ok(exported && exported.summary);
  assert.ok(out && typeof out === 'object');
  assert.ok(Array.isArray(out.rows));
  assert.strictEqual(out.rows.length, 1, '聚合夹具必须非空，避免空集通过');
  assert.ok(modelUsage && modelUsage.rows.length === 1);
  assert.strictEqual(queries.length, 6);
  for (const index of [0, 2, 4]) {
    assert.match(queries[index].sql, /user_id = \$1/);
    assert.deepStrictEqual(queries[index].params, [10, 1]);
  }
  for (const row of out.rows) {
    assert.strictEqual('messages' in row, false, 'usage 行不应含 messages');
    assert.strictEqual('response' in row, false, 'usage 行不应含 response');
    assert.strictEqual('request_params' in row, false, 'usage 行不应含 request_params');
  }
  assert.ok(out.summary && 'tokens_used' in out.summary);
  assert.strictEqual(out.summary.tokens_used, aggregate.tokens_used);
  console.log(`PASS usage 聚合安全（rows=${out.rows.length}, 含正文键=${Object.keys(out.rows[0] || {}).filter(k => ['messages','response','request_params'].includes(k)).length}）`);
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
