#!/usr/bin/env node
'use strict';
/**
 * 模型库顶部 API Key 过滤回归测试
 *
 * 覆盖：
 *  - 已关闭（enabled=false）的 Key 不进入模型库顶部的切换芯片与绑定栏
 *  - 选中项被关闭后自动切换到仍启用的 Key，并同步顶部「当前模型」
 *  - 全部 Key 被关闭时给出「去启用」引导而不是「去创建」
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');

const elements = new Map();
const fetches = [];
const context = {
  console, URL, URLSearchParams, Date, Number, Math, JSON, Promise, Error, parseInt, parseFloat, String, Number,
  CSS: { escape: value => String(value).replace(/"/g, '\\"') },
  window: { crewrouterIcons: { name: name => name } },
  document: {
    getElementById: id => elements.get(id),
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  },
  t: value => value,
  renderProviderNameTag: name => name || '',
  safeColor: c => c || '',
  setHTML: (element, html) => { element.html = html; },
  localStorage: { getItem: () => null, setItem: () => {} },
  fetch: (url) => {
    fetches.push(String(url));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(context.__keys),
    });
  },
};
vm.createContext(context);
const initialization = source.indexOf('const app = new ConsoleApp();');
assert.ok(initialization > 0, 'production ConsoleApp initialization boundary');
vm.runInContext(source.slice(0, initialization) + '\nglobalThis.App = ConsoleApp;', context);

const app = Object.create(context.App.prototype);
app.user = { id: 1 };
app._renderLibraryStickyKeyBtn = () => {};
elements.set('modelLibraryBindingSummary', { style: {}, html: '' });
elements.set('modelLibraryKeySelector', { style: {} });
elements.set('libraryKeyChips', { html: '' });
elements.set('modelLibraryStickyKeyWrap', { style: {} });
elements.set('modelLibraryStickyKeyBtn', { setAttribute: () => {}, style: {} });

const enabledKey = (id, model) => ({
  id, name: `Key ${id}`, enabled: true, current_model_id: model ? model.id : null,
  current_model_name: model ? model.name : null, current_model_provider_name: model ? model.provider_name : null,
  tags: [], harness_models: [],
});
const closedKey = (id, model) => ({ ...enabledKey(id, model), enabled: false });

function keyChips() {
  return (elements.get('libraryKeyChips').html || '');
}

(async () => {
  // 1) 混合启用/关闭 Key：只有启用的进入模型库顶部
  context.__keys = [
    closedKey(1, { id: 'm-a', name: 'Model A', provider_name: 'P1' }),
    enabledKey(2, { id: 'm-b', name: 'Model B', provider_name: 'P1' }),
    { ...enabledKey(3, null), enabled: undefined }, // 兼容缺少 enabled 字段的历史数据
  ];
  await app._loadLibraryKeys();
  assert.deepEqual(app._libraryKeys.map(k => k.id), [2, 3], '已关闭的 Key 不进入模型库');
  assert.equal(app._libraryKeys.length, 2);
  assert.equal(app._libraryAllKeysClosed, false);
  assert.equal(app._librarySelectedKeyId, 2, '首个启用的 Key 成为默认选择');
  assert.ok(!keyChips().includes('data-key-id="1"'), '切换芯片不渲染已关闭的 Key');
  assert.ok(keyChips().includes('data-key-id="2"'), '切换芯片渲染启用的 Key');
  let summary = elements.get('modelLibraryBindingSummary').html;
  assert.ok(!summary.includes('已全部关闭'), '存在启用 Key 时不显示全部关闭的空态');

  // 2) 当前选中的 Key 被关闭 → 自动切换并同步顶部当前模型
  context.__keys = [
    closedKey(1, { id: 'm-a', name: 'Model A', provider_name: 'P1' }),
    closedKey(2, { id: 'm-b', name: 'Model B', provider_name: 'P1' }),
    enabledKey(3, { id: 'm-c', name: 'Model C', provider_name: 'P2' }),
  ];
  app._librarySelectedKeyId = 2;
  app._libraryCurrentModel = { id: 'm-b', name: 'Model B', provider_name: 'P1' };
  await app._loadLibraryKeys();
  assert.equal(app._librarySelectedKeyId, 3, '选中项被关闭后切换到仍启用的 Key');
  assert.deepEqual(app._libraryKeys.map(k => k.id), [3]);
  assert.equal(app._libraryCurrentModel.id, 'm-c', '顶部当前模型同步为新选中 Key 的绑定');
  assert.equal(app._libraryCurrentModel.name, 'Model C');
  assert.ok(!keyChips().includes('data-key-id="2"'), '被关闭的选中 Key 从芯片中移除');

  // 3) 优先保留仍然有效的选择
  app._librarySelectedKeyId = 3;
  app._libraryCurrentModel = { id: 'm-c', name: 'Model C', provider_name: 'P2' };
  await app._loadLibraryKeys();
  assert.equal(app._librarySelectedKeyId, 3, '仍然启用的选中 Key 保持不变');
  assert.equal(app._libraryAllKeysClosed, false);

  // 4) 全部 Key 被关闭 → 空态引导「去启用」
  context.__keys = [
    closedKey(1, { id: 'm-a', name: 'Model A', provider_name: 'P1' }),
    closedKey(2, { id: 'm-b', name: 'Model B', provider_name: 'P1' }),
  ];
  await app._loadLibraryKeys();
  assert.deepEqual(app._libraryKeys, [], '全部关闭时不保留任何 Key');
  assert.equal(app._librarySelectedKeyId, null);
  assert.equal(app._libraryAllKeysClosed, true);
  assert.equal(keyChips(), '', '全部关闭时不渲染切换芯片');
  summary = elements.get('modelLibraryBindingSummary').html;
  assert.ok(summary.includes('API Key 已全部关闭，启用后才能绑定模型'), '全部关闭时给出启用引导文案');
  assert.ok(summary.includes('去启用 API Key'), '全部关闭时按钮为去启用');
  assert.ok(!summary.includes('还没有 API Key'), '全部关闭时不提示创建');

  // 5) 空模型库空态的引导按钮同样跟随「去启用」
  const library = { teams: [], starred_models: [] };
  elements.set('modelLibraryContent', { html: '' });
  app.renderModelLibrary(library, null);
  const libraryHtml = elements.get('modelLibraryContent').html;
  assert.ok(libraryHtml.includes('去启用 API Key'), '模型库空态引导为去启用');
  assert.ok(!libraryHtml.includes('创建 API Key'), '模型库空态不再提示创建');

  // 6) 恢复正常：重新出现启用 Key 后恢复创建引导
  context.__keys = [enabledKey(9, null)];
  await app._loadLibraryKeys();
  assert.equal(app._libraryAllKeysClosed, false);
  assert.deepEqual(app._libraryKeys.map(k => k.id), [9]);
  app.renderModelLibrary({ teams: [], starred_models: [] }, null);
  assert.ok(!elements.get('modelLibraryContent').html.includes('去启用 API Key'));

  console.log('模型库顶部已关闭 API Key 过滤：芯片/绑定栏/空态引导/选中项切换 全部通过。');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
