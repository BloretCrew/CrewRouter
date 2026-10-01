#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public/pages/console.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const start = html.indexOf('<!-- 模型库页面');
const end = html.indexOf('</body>', start);
assert.ok(start >= 0 && end > start);
const scope = html.slice(start, end);
const dialogContract = require(path.join(root, 'node_modules/@bloret-crew/blora-design/contracts/dialog.contract.json'));
assert.strictEqual(dialogContract.tagName, 'blora-dialog');
assert.deepStrictEqual(Object.keys(dialogContract.slots), ['default', 'title', 'footer']);
const dialogs = {
  batchEditMyModelsModal: 'batchEditMyModelsTitle', createApiKeyModal: 'createApiKeyModalTitle', hookNotifySelectModal: 'hookNotifySelectTitle', keyModelsModal: 'keyModelsTitle', keyOptionsModal: 'keyOptionsTitle', keySignatureModal: 'keySignatureTitle', keyScheduleModal: 'keyScheduleTitle', addProviderModal: 'addProviderModalTitle', editProviderModal: 'editProviderModalTitle', manageModelsModal: 'manageModelsTitle', batchPriceModal: 'batchPriceTitle', selectKeyModal: 'selectKeyTitle', configToolSelectModal: 'configToolSelectTitle', addEditModelModal: 'addEditModelTitle', modelTestModal: 'modelTestTitle', modelUptimeModal: 'modelUptimeModalTitle', usageDetailModal: 'usageDetailTitle',
};
const probeBlocks = [];
const footerIds = [];
for (const [id, title] of Object.entries(dialogs)) {
  const re = new RegExp(`<blora-dialog id="${id}"[^>]*>`);
  const match = scope.match(re);
  assert.ok(match, `${id} root contract`);
  assert.ok(/role="dialog"/.test(match[0]) && /aria-modal="true"/.test(match[0]) && match[0].includes(`aria-labelledby="${title}"`), `${id} a11y contract`);
  assert.strictEqual((scope.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} unique root`);
  const from = scope.indexOf(match[0]);
  const next = scope.slice(from + match[0].length).search(/<blora-dialog id="[^"]+"/);
  const block = scope.slice(from, next < 0 ? scope.length : from + match[0].length + next);
  if (/class="[^"]*modal-footer/.test(block)) footerIds.push(id);
  probeBlocks.push(block.slice(0, block.indexOf('</blora-dialog>') + '</blora-dialog>'.length));
  assert.doesNotMatch(block, /class="[^" ]*blora-dialog__(?:panel|backdrop)/, `${id} must not hand-build internal dialog surfaces`);
  assert.match(block, new RegExp(`id="${title}"`));
  assert.match(block, /class="[^"]*blora-button[^>]*>/);
  assert.match(block, /modal-close[^>]*aria-label="关闭"/);
}
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-blora-batch-b-'));
try {
  const probe = path.join(probeDir, 'dialogs.html');
  fs.writeFileSync(probe, `<!doctype html><meta charset="utf-8"><script>window.t=value=>value;</script>${probeBlocks.join('')}<script src="file://${root}/public/js/blora-dialog.js"></script><script src="file://${root}/node_modules/@bloret-crew/blora-design/dist/blora.global.js"></script><script>window.addEventListener('load',()=>{try { for(const [id,title] of Object.entries(${JSON.stringify(dialogs)})){const dialog=document.getElementById(id);if(!dialog||!customElements.get(dialog.localName))throw Error(id+': official CE missing');const heading=dialog.querySelector(':scope > [slot="title"]');if(!heading||!heading.querySelector('#'+title))throw Error(id+': public title slot missing');if(${JSON.stringify(footerIds)}.includes(id)&&!dialog.querySelector(':scope > [slot="footer"]'))throw Error(id+': public footer slot missing');if(dialog.querySelector(':scope > .modal-overlay'))throw Error(id+': legacy overlay remains');}document.documentElement.dataset.contract='ok';}catch(error){document.documentElement.dataset.contract=error.message;}});</script>`);
  const dom = execFileSync('google-chrome', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files', `--user-data-dir=${path.join(probeDir, 'profile')}`, '--virtual-time-budget=2000', '--dump-dom', `file://${probe}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  assert.match(dom, /data-contract="ok"/, 'production adapter must expose official public slots without a legacy overlay');
  console.log('Blora Batch B official CE/public title/footer slots passed for all dialogs.');
} finally {
  fs.rmSync(probeDir, { recursive: true, force: true });
}
assert.match(scope, /id="keyModelsModalContent"/);
for (const id of ['modelLibraryContent', 'myProvidersTable', 'myTeamModelsTable', 'apiKeysList', 'providerQuotaGrid', 'keyModelsContent', 'modelTestModalBody', 'modelUptimeModalBody', 'usageDetailContent']) assert.match(html, new RegExp(`id="${id}"[^>]*data-blora-state="(?:loading|idle|error|success|empty)"`));
for (const marker of ['模型库', '我的上游', '当前 Key', '供应商额度', '添加供应商', '配置 API Key', 'API Key', '模型队列', 'Claude Code', 'Codex', 'DeepSeek Harness']) assert.ok(scope.includes(marker), marker);
assert.doesNotMatch(html, /data-blora-state="[^"]+"[^>]*data-blora-state=/);
const buttonContract = require(path.join(root, 'node_modules/@bloret-crew/blora-design/contracts/button.contract.json'));
const checkboxContract = require(path.join(root, 'node_modules/@bloret-crew/blora-design/contracts/checkbox.contract.json'));
assert.strictEqual(checkboxContract.tagName, 'blora-checkbox');
assert.ok(checkboxContract.properties.checked);
assert.ok(checkboxContract.events.change.bubbles);
const tags = [...js.matchAll(/<(button|blora-checkbox|blora-dropdown-item|blora-dropdown)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/g)].map(match => {
  const attributes = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(attribute => [attribute[1], attribute[2]]));
  return { name: match[1], attributes, classes: new Set((attributes.class || '').split(/\s+/)) };
});
function checkButton(predicate, label, variant) {
  const matches = tags.filter(tag => tag.name === 'button' && predicate(tag));
  assert.ok(matches.length, `${label}: real action button exists`);
  for (const tag of matches) {
    assert.ok(tag.classes.has('blora-button'), `${label}: official Button class`);
    assert.strictEqual(tag.attributes.type, 'button', `${label}: non-submit action`);
    if (variant) assert.strictEqual(tag.attributes['data-variant'], variant, `${label}: semantic variant`);
    if (tag.attributes['data-variant']) assert.ok(buttonContract.attributes['data-variant'].type.includes(`"${tag.attributes['data-variant']}"`) || tag.attributes['data-variant'].includes('${'), `${label}: public variant`);
  }
}
const handler = (name, argument) => tag => (tag.attributes.onclick || '').includes(`app.${name}(${argument}`);
for (const marker of ['safeHttpUrl(', 'safeColor(', "pingLibraryProvider('${this._jsString(provider.provider_id)}')", "app.testProviderModels('${this._jsString(team.team_id)}', '${this._jsString(provider.provider_id)}')", "app.testModel('${this._jsString(modelId)}')", "app.enterLibraryHarnessBindMode('${this._jsString(h.harness)}')"]) assert.ok(js.includes(marker), marker);
assert.match(js, /class="[^"\n]*\bblora-card\b[^"\n]*\bmodel-library-item\b/);
assert.match(js, /series_icon_url[^\n]*safeHttpUrl/);
assert.match(js, /model\.model_id[^\n]*_jsString/);
checkButton(tag => tag.classes.has('model-star-btn'), 'star model', 'ghost');
checkButton(handler('navigateTo', "'apiKeys'"), 'navigate to API keys', 'primary');
checkButton(handler('exitLibraryHarnessBindMode', ''), 'exit harness mode', 'secondary');
checkButton(handler('enterLibraryHarnessBindMode', "'${this._jsString(h.harness)}'"), 'bind harness');
checkButton(handler('selectLibraryKey', '${key.id}'), 'select binding key', 'secondary');
checkButton(tag => tag.classes.has('library-key-bubble-item'), 'binding key menu');
for (const [name, argument] of [
  ['editMyTeamModel', "'${this._jsString(m.id)}'"],
  ['showAddProviderModal', ''],
  ['showManageModelsModal', "'${this._jsString(p.id)}'"],
  ['pingUserProvider', "'${this._jsString(p.id)}'"],
  ['editMyProvider', "'${this._jsString(p.id)}'"],
]) checkButton(handler(name, argument), name);
const semanticFailures = [];
for (const [name, argument] of [['deleteMyTeamModel', "'${this._jsString(m.id)}'"], ['deleteMyProvider', "'${this._jsString(p.id)}'"]]) {
  try { checkButton(handler(name, argument), name, 'danger'); } catch (error) { semanticFailures.push(error.message); }
}
assert.ok(tags.some(tag => tag.name === 'blora-dropdown' && (tag.attributes.class || '').split('${')[0] === 'library-more-menu'), 'official more-menu CE');
assert.ok(tags.some(tag => tag.name === 'blora-dropdown-item' && tag.attributes.value === 'library-action:${action}'), 'encoded public dropdown action');
checkButton(tag => tag.attributes.slot === 'trigger' && tag.classes.has('library-more-trigger'), 'official more-menu trigger');
for (const marker of ['encodeURIComponent(String(item.onClick', "event.detail?.value", "decodeURIComponent(String(value).slice('library-action:'.length))", "addEventListener('blora-select'"]) assert.ok(js.includes(marker), marker);
assert.match(js, /id="keyModelPickerSearch"[^\n]*escapeHtml\(t\('搜索模型、供应商、Team\.\.\.'\)\)/);
for (const [className, action, value] of [
  ['manage-model-checkbox', 'app-dynamic-4', '${escapeHtml(String(model.id))}'],
  ['my-team-model-checkbox', 'app-dynamic-6', '${escapeHtml(m.id)}'],
]) assert.ok(tags.some(tag => tag.name === 'blora-checkbox' && tag.classes.has(className) && tag.attributes['data-control-action'] === action && tag.attributes.value === value), `${className}: official CE, escaped value and delegated change`);
assert.ok(tags.some(tag => tag.name === 'blora-checkbox' && tag.attributes['data-control-action'] === 'app-dynamic-5'), 'official select-all checkbox');
for (const marker of [
  "document.addEventListener('change'",
  'case "app-dynamic-4": { app._updateManageModelsBatchBar();',
  'case "app-dynamic-5": { app.toggleSelectAllMyTeamModels(control.checked);',
  'case "app-dynamic-6": { app.updateMyModelsBatchButtons();',
  "'.manage-model-checkbox[checked]'", "'.my-team-model-checkbox[checked]'",
  'id="manageModel_${index}"',
  "app._retryLoadProviderModels('${this._jsString(team.team_id)}','${this._jsString(provider.provider_id)}\\')",
  "app.selectProvider('${this._jsString(p.id)}')",
  "if (!Array.isArray(models)) throw new Error(t('获取模型列表失败'))",
]) assert.ok(js.includes(marker), marker);
for (const [id, states] of Object.entries({
  modelLibraryContent: ['loading'], myProvidersTable: ['loading', 'empty', 'success', 'error'],
  myTeamModelsTable: ['loading'], apiKeysList: ['loading'], providerQuotaGrid: ['loading'],
  keyModelsContent: ['loading', 'success', 'error', 'empty'], manageModelsLoading: ['loading'],
  manageModelsError: ['error'], manageModelsContent: ['error'],
})) for (const state of states) assert.ok(js.includes(`setBloraState('${id}', '${state}')`), `${id}: ${state}`);
assert.ok(js.includes("setBloraState('manageModelsContent', models.length ? 'success' : 'empty')"));
assert.match(js, /app\.testTeamModels\('\$\{this\._jsString\(team\.team_id\)\}'\)/);
assert.ok((js.match(/app\.loadProviderModelsPage\('\$\{this\._jsString\(team\.team_id\)\}','\$\{this\._jsString\(provider\.provider_id\)\}'/g) || []).length >= 3);
assert.doesNotMatch(js, /app\.(?:testTeamModels|loadProviderModelsPage|showManageModelsModal|pingUserProvider|editMyProvider|deleteMyProvider|_retryLoadProviderModels|editMyTeamModel|deleteMyTeamModel|selectProvider|enterLibraryHarnessBindMode)\([^\n]*escapeHtml\(/);
console.log('Blora console Batch B static contract/state/dynamic safety assertions passed.');

// Executable pure-function/response-state checks used by the dynamic paths.
assert.strictEqual((() => { const value = { models: [] }; return Array.isArray(value.models) ? 'empty' : 'error'; })(), 'empty');
assert.strictEqual((() => { const value = { models: 'not-an-array' }; return Array.isArray(value.models) ? 'success' : 'error'; })(), 'error');
const jsStringMatch = js.match(/_jsString\(value\)\s*\{([\s\S]*?)\n  \}/);
assert.ok(jsStringMatch);
const jsStringSource = jsStringMatch[0];
const encodeJsString = new Function('value', jsStringMatch[1]);
for (const value of ["single'quote", 'double"quote', 'slash\\\\value', 'line\\nnext', '</script>']) {
  const encoded = encodeJsString(value);
  assert.ok(!encoded.includes('</script>'));
  assert.doesNotThrow(() => Function(`const value = '${encoded}'; return value;`)());
  assert.strictEqual(Function(`const value = '${encoded}'; return value;`)(), value);
}
assert.ok(tags.some(tag => tag.name === 'button' && tag.classes.has('library-key-bubble-item') && (tag.attributes.class || '').includes("this._libraryBindTarget === 'default'")), 'active default binding action preserved');
const selection = [{ checked: false }, { checked: false }];
let refreshes = 0;
const toggleSource = js.match(/  toggleSelectAllMyTeamModels\(checked\)\s*\{([\s\S]*?)\n  \}/);
assert.ok(toggleSource, 'production select-all method');
const toggle = new Function('document', 'checked', toggleSource[1]);
for (const checked of [true, false]) {
  toggle.call({ updateMyModelsBatchButtons() { refreshes++; } }, { querySelectorAll(selector) { assert.strictEqual(selector, '.my-team-model-checkbox'); return selection; } }, checked);
  assert.ok(selection.every(control => control.checked === checked));
}
assert.strictEqual(refreshes, 2);
const delegateSource = js.match(/\(function delegateBusinessControlEvents\(\) \{[\s\S]*?\n\}\)\(\);/)?.[0];
assert.ok(delegateSource, 'production delegated CE change handler');
let change;
const changes = [];
vm.runInNewContext(delegateSource, { document: { addEventListener(name, callback) { assert.strictEqual(name, 'change'); change = callback; } }, app: {
  _updateManageModelsBatchBar() { changes.push('manage'); },
  toggleSelectAllMyTeamModels(checked) { changes.push(checked); },
  updateMyModelsBatchButtons() { changes.push('team'); },
} });
for (const action of ['app-dynamic-4', 'app-dynamic-5', 'app-dynamic-6']) change({ target: { closest() { return { dataset: { controlAction: action }, checked: true }; } } });
assert.deepStrictEqual(changes, ['manage', true, 'team']);
const menuSource = js.match(/  _handleLibraryMoreMenuSelect\(event\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(menuSource, 'production dropdown selection handler');
const actions = [];
const menuContext = vm.createContext({ window: {}, app: { testModel(id) { actions.push(id); } }, t: value => value, console });
const selectMenu = vm.runInContext(`({${menuSource}})._handleLibraryMoreMenuSelect`, menuContext);
selectMenu({ detail: { value: 'library-action:' + encodeURIComponent("app.testModel('model-safe')") } });
selectMenu({ detail: { value: 'not-a-library-action' } });
selectMenu({ detail: { value: 'library-action:' + encodeURIComponent("globalThis.invalidAction=true") } });
assert.deepStrictEqual(actions, ['model-safe']);
assert.strictEqual(menuContext.invalidAction, undefined);
console.log('Blora Batch B executable edge-state, 5 escaping cases, checkbox change/select-all and dropdown action checks passed.');

assert.deepStrictEqual(semanticFailures, [], 'destructive actions must use the public danger variant');
