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
assert.ok(start >= 0 && end > start);
const scope = html.slice(start, end);
const dialogs = {
  batchEditMyModelsModal: 'batchEditMyModelsTitle', createApiKeyModal: 'createApiKeyModalTitle', hookNotifySelectModal: 'hookNotifySelectTitle', keyModelsModal: 'keyModelsTitle', keyOptionsModal: 'keyOptionsTitle', keySignatureModal: 'keySignatureTitle', keyScheduleModal: 'keyScheduleTitle', addProviderModal: 'addProviderModalTitle', editProviderModal: 'editProviderModalTitle', manageModelsModal: 'manageModelsTitle', batchPriceModal: 'batchPriceTitle', selectKeyModal: 'selectKeyTitle', configToolSelectModal: 'configToolSelectTitle', addEditModelModal: 'addEditModelTitle', modelTestModal: 'modelTestTitle', modelUptimeModal: 'modelUptimeModalTitle', usageDetailModal: 'usageDetailTitle',
};
for (const [id, title] of Object.entries(dialogs)) {
  const re = new RegExp(`<div id="${id}"[^>]*class="blora-dialog modal"[^>]*>`);
  const match = scope.match(re);
  assert.ok(match, `${id} root contract`);
  assert.ok(/role="dialog"/.test(match[0]) && /aria-modal="true"/.test(match[0]) && match[0].includes(`aria-labelledby="${title}"`), `${id} a11y contract`);
  assert.strictEqual((scope.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} unique root`);
  const from = scope.indexOf(match[0]);
  const next = scope.slice(from + match[0].length).search(/<div id="[^"]+"[^>]*class="blora-dialog modal"/);
  const block = scope.slice(from, next < 0 ? scope.length : from + match[0].length + next);
  assert.match(block, /class="blora-dialog__panel\b/);
  assert.match(block, new RegExp(`id="${title}"`));
  assert.match(block, /class="[^"]*blora-button[^>]*>/);
  assert.match(block, /modal-close[^>]*aria-label="关闭"/);
}
assert.match(scope, /id="keyModelsModalContent"[^>]*class="blora-dialog__panel/);
for (const id of ['modelLibraryContent', 'myProvidersTable', 'myTeamModelsTable', 'apiKeysList', 'providerQuotaGrid', 'keyModelsContent', 'modelTestModalBody', 'modelUptimeModalBody', 'usageDetailContent']) assert.match(html, new RegExp(`id="${id}"[^>]*data-blora-state="(?:loading|idle|error|success|empty)"`));
for (const marker of ['模型库', '我的上游', '当前 Key', '供应商额度', '添加供应商', '配置 API Key', 'API Key', '模型队列', 'Claude Code', 'Codex', 'DeepSeek Harness']) assert.ok(scope.includes(marker), marker);
assert.doesNotMatch(html, /data-blora-state="[^"]+"[^>]*data-blora-state=/);
for (const marker of ['safeHttpUrl(', 'safeColor(', 'class="blora-card model-library-item', 'class="blora-button btn btn-sm btn-secondary model-test-btn', 'class="blora-button model-star-btn', "pingLibraryProvider('${this._jsString(provider.provider_id)}')", "app.testProviderModels('${this._jsString(team.team_id)}', '${this._jsString(provider.provider_id)}')", "setBloraState('modelLibraryContent', 'loading')", "setBloraState('myProvidersTable', 'loading')", "setBloraState('myTeamModelsTable', 'loading')", "setBloraState('apiKeysList', 'loading')", "setBloraState('providerQuotaGrid', 'loading')"]) assert.ok(js.includes(marker), marker);
assert.match(js, /series_icon_url[^\n]*safeHttpUrl/);
assert.match(js, /model\.model_id[^\n]*_jsString/);
for (const marker of [
  'id="keyModelPickerSearch" placeholder="${escapeHtml(t(\'搜索模型、供应商、Team...\'))}" class="blora-input',
  'class="blora-input" onchange="app.toggleSelectAllMyTeamModels(this.checked)"',
  'class="blora-input my-team-model-checkbox"',
  'class="blora-button btn btn-sm btn-secondary" onclick="app.editMyTeamModel(\'${this._jsString(m.id)}\')"',
  'class="blora-button btn btn-sm" style="color:var(--destructive);background:transparent;border:1px solid var(--border);" onclick="app.deleteMyTeamModel(\'${this._jsString(m.id)}\')"',
  "setBloraState('keyModelsContent', 'loading')",
  "setBloraState('keyModelsContent', 'success')",
  "setBloraState('keyModelsContent', 'error')",
  "setBloraState('manageModelsLoading', 'loading')",
  "setBloraState('manageModelsError', 'error')",
  "setBloraState('manageModelsContent', models.length ? 'success' : 'empty')",
]) assert.ok(js.includes(marker), marker);
for (const marker of [
  'class="blora-button btn btn-sm btn-secondary" onclick="app.showManageModelsModal(\'${this._jsString(p.id)}\')"',
  'class="blora-button btn btn-sm btn-secondary" onclick="app.pingUserProvider(\'${this._jsString(p.id)}\')"',
  'class="blora-button btn btn-sm btn-secondary" onclick="app.editMyProvider(\'${this._jsString(p.id)}\')"',
  'class="blora-button btn btn-sm" style="color:var(--destructive);background:transparent;border:1px solid var(--border);" onclick="app.deleteMyProvider(\'${this._jsString(p.id)}\')"',
]) assert.ok(js.includes(marker), marker);
assert.match(js, /app\.testTeamModels\('\$\{this\._jsString\(team\.team_id\)\}'\)/);
assert.ok((js.match(/app\.loadProviderModelsPage\('\$\{this\._jsString\(team\.team_id\)\}','\$\{this\._jsString\(provider\.provider_id\)\}'/g) || []).length >= 3);
assert.doesNotMatch(js, /app\.(?:testTeamModels|loadProviderModelsPage|showManageModelsModal|pingUserProvider|editMyProvider|deleteMyProvider|_retryLoadProviderModels|editMyTeamModel|deleteMyTeamModel|selectProvider)\([^\n]*escapeHtml\(/);
for (const marker of [
  'class="blora-button btn btn-sm btn-secondary" onclick="app.editMyTeamModel(\'${this._jsString(m.id)}\')"',
  'class="blora-button btn btn-sm" style="color:var(--destructive);background:transparent;border:1px solid var(--border);" onclick="app.deleteMyTeamModel(\'${this._jsString(m.id)}\')"',
  'class="blora-input manage-model-checkbox" id="manageModel_${index}" value="${escapeHtml(String(model.id))}"',
  "app._retryLoadProviderModels('${this._jsString(team.team_id)}','${this._jsString(provider.provider_id)}\\')",
  "app.selectProvider('${this._jsString(p.id)}')",
  "setBloraState('myProvidersTable', 'empty')",
  "setBloraState('myProvidersTable', 'success')",
  "setBloraState('myProvidersTable', 'error')",
]) assert.ok(js.includes(marker), marker);
console.log('Blora console Batch B static contract/state/dynamic safety assertions passed.');
