#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public/pages/console.html'), 'utf8');
const start = html.indexOf('<!-- 模型库页面');
const end = html.indexOf('<!-- 统计信息页面', start);
assert.ok(start >= 0 && end > start, 'Batch B scope must be present');
const scope = html.slice(start, html.indexOf('</body>'));

for (const id of ['modelLibraryContent', 'myProvidersTable', 'myTeamModelsTable', 'apiKeysList', 'providerQuotaGrid']) {
  assert.match(scope, new RegExp(`id="${id}"[^>]*data-blora-state="(?:loading|idle|error|success|empty)"`), `${id} needs an explicit state contract`);
}
for (const id of ['createApiKeyModal', 'keyModelsModal', 'addProviderModal', 'editProviderModal', 'manageModelsModal', 'selectKeyModal']) {
  assert.match(scope, new RegExp(`id="${id}"[^>]*class="blora-dialog modal"[^>]*role="dialog"[^>]*aria-modal="true"`), `${id} needs dialog semantics`);
}
assert.match(scope, /class="blora-button\b/);
assert.match(scope, /class="blora-input\b/);
assert.match(scope, /class="blora-select\b/);
assert.match(scope, /class="blora-dialog__panel\b/);
for (const marker of ['模型库', '我的上游', '当前 Key', '供应商额度', '添加供应商', '配置 API Key', 'API Key', '模型队列', 'Claude Code', 'Codex', 'DeepSeek Harness']) {
  assert.ok(scope.includes(marker), `missing Batch B behavior marker: ${marker}`);
}
assert.doesNotMatch(scope, /--blora-[a-z-]+\s*:/);
assert.ok(!scope.includes('--blora-'), 'local Blora tokens must not be declared');
console.log('Blora console Batch B static contract/state assertions passed.');
