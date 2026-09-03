#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public/pages/console.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const start = html.indexOf('<!-- 模型库页面');
const end = html.indexOf('</body>', start);
assert.ok(start >= 0 && end > start, 'Batch B scope must be present');
const scope = html.slice(start, end);

const dialogs = {
  batchEditMyModelsModal: 'batchEditMyModelsTitle', createApiKeyModal: 'createApiKeyModalTitle',
  hookNotifySelectModal: 'hookNotifySelectTitle', keyModelsModal: 'keyModelsTitle',
  keyOptionsModal: 'keyOptionsTitle', keySignatureModal: 'keySignatureTitle', keyScheduleModal: 'keyScheduleTitle',
  addProviderModal: 'addProviderModalTitle', editProviderModal: 'editProviderModalTitle',
  manageModelsModal: 'manageModelsTitle', batchPriceModal: 'batchPriceTitle', selectKeyModal: 'selectKeyTitle',
  configToolSelectModal: 'configToolSelectTitle', modelTestModal: 'modelTestTitle',
  modelUptimeModal: 'modelUptimeModalTitle', usageDetailModal: 'usageDetailTitle',
};
for (const [id, title] of Object.entries(dialogs)) {
  const rootMatch = scope.match(new RegExp(`id="${id}"[^>]*class="blora-dialog modal"[^>]*`));
  assert.ok(rootMatch && new RegExp(`role="dialog"`).test(rootMatch[0]) && new RegExp(`aria-modal="true"`).test(rootMatch[0]) && new RegExp(`aria-labelledby="${title}"`).test(rootMatch[0]), `${id} must use dialog semantics and ${title}`);
  assert.ok(rootMatch, `${id} must use dialog semantics and ${title}`);
  const from = scope.indexOf(rootMatch[0]);
  const nextMatch = scope.slice(from + rootMatch[0].length).match(/<div id="[^"]+"[^>]*class="blora-dialog modal"/);
  const next = nextMatch ? from + rootMatch[0].length + nextMatch.index : -1;
  const block = scope.slice(from, next < 0 ? scope.length : next);
  assert.match(block, /class="blora-dialog__panel\b/);
  assert.match(block, new RegExp(`id="${title}"`));
  assert.match(block, /class="[^"]*blora-button[^"]*"/);
  assert.match(block, /modal-close[^>]*aria-label="关闭"/);
}
assert.match(scope, /id="keyModelsModalContent"[^>]*class="blora-dialog__panel/);
for (const id of ['modelLibraryContent', 'myProvidersTable', 'myTeamModelsTable', 'apiKeysList', 'providerQuotaGrid', 'keyModelsContent', 'modelTestModalBody', 'modelUptimeModalBody', 'usageDetailContent']) {
  assert.match(html, new RegExp(`id="${id}"[^>]*data-blora-state="(?:loading|idle|error|success|empty)"`), `${id} needs a state contract`);
}
for (const marker of ['模型库', '我的上游', '当前 Key', '供应商额度', '添加供应商', '配置 API Key', 'API Key', '模型队列', 'Claude Code', 'Codex', 'DeepSeek Harness']) assert.ok(scope.includes(marker), `missing marker: ${marker}`);
assert.doesNotMatch(scope, /--blora-[a-z-]+\s*:/);
assert.match(js, /setHTML\(/);
for (const marker of ['escapeHtml(', '_jsString(', 'modelTestModal', 'modelUptimeModal', 'usageDetailModal', 'showKeyModels', 'blora-button']) assert.ok(js.includes(marker), `missing dynamic/security marker: ${marker}`);
assert.match(js, /model\.model_id[^\n]*_jsString/);
console.log('Blora console Batch B static contract/state/dynamic safety assertions passed.');
