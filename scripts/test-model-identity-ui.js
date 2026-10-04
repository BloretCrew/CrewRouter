'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ t: value => value });
vm.runInContext(fs.readFileSync(path.join(root, 'public/js/model-identity.js'), 'utf8') + '\nglobalThis.identity = ModelIdentity;', context);
const identity = context.identity;
assert.equal(identity.status({}).label, '上游未提供');
assert.equal(identity.status({ resolved_model: 'route', response_model: null }).label, '上游未提供');
assert.equal(identity.status({ response_model: 'response' }).label, '路由模型未采集，无法比对');
assert.equal(identity.status({ resolved_model: ' model ', response_model: 'model' }).label, '模型名称一致');
assert.equal(identity.status({ resolved_model: 'model', response_model: 'model-v2' }).label, '模型名称不一致');
assert.equal(identity.status({ resolved_model: {}, response_model: 1 }).label, '上游未提供');
const malicious = '<img src=x onerror="window.identityXss=1">&\'模型';
const html = identity.detail({ requested_model: malicious, resolved_model: malicious, response_model: 'r'.repeat(512) });
assert.ok(!html.includes('<img'));
assert.ok(html.includes('&lt;img'));
assert.ok(html.includes('&quot;'));
assert.ok(html.includes('供应商可能改写'));
assert.ok(html.includes('r'.repeat(512)));
assert.ok(identity.detail({ upstream_model_id: 'must-not-infer', model_id: 'must-not-infer' }).includes('历史记录'));
assert.ok(!identity.detail({ upstream_model_id: 'must-not-infer', model_id: 'must-not-infer' }).includes('must-not-infer'));
assert.equal(identity.badge({ resolved_model: 'm', response_model: 'm' }, true), '');
assert.ok(identity.summary({}).includes('客户端请求模型'));
assert.ok(identity.session({}).startsWith('<details'));
const merged = identity.session({ modelIdentities: [
  { id: 1, requested_model: 'first', resolved_model: 'route', response_model: 'route' },
  { id: 2, requested_model: 'second', resolved_model: 'route', response_model: 'different' }
] });
assert.ok(merged.includes('first') && merged.includes('second') && merged.includes('模型名称不一致'));
assert.equal((merged.match(/class="model-identity-detail"/g) || []).length, 2);
const numberedCalls = identity.session({ resolved_model: 'route', response_model: 'route', modelIdentities: [{ id: 7, resolved_model: 'route', response_model: 'route' }, { id: 8, resolved_model: 'route', response_model: 'switched' }] });
assert.ok(numberedCalls.includes('调用 #7') && numberedCalls.includes('调用 #8') && numberedCalls.includes('switched'));
assert.ok(numberedCalls.includes('模型名称不一致'));
for (const name of ['console', 'admin']) {
  const page = fs.readFileSync(path.join(root, `public/pages/${name}.html`), 'utf8');
  assert.ok(page.includes('/css/model-identity.css?v=1'));
  assert.ok(page.indexOf('/js/model-identity.js?v=1') < page.indexOf(`/js/${name === 'console' ? 'app' : 'admin'}.js`));
}
for (const name of ['app', 'admin']) {
  const source = fs.readFileSync(path.join(root, `public/js/${name}.js`), 'utf8');
  assert.ok(source.includes('ModelIdentity.summary(log)'));
  assert.ok(source.includes('ModelIdentity.detail(log)'));
}
assert.ok(fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8').includes('ModelIdentity.session(record)'));
console.log('PASS model identity UI: nullable/history, exact comparisons, escaping, long text, shared integrations and cache resources.');
