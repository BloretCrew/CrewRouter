#!/usr/bin/env node
'use strict';
// Key 按钮绑定模型回归。前置：verify-blora-correction-browser.js --server / --chrome。
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class CDP {
  constructor(url) {
    this.id = 0; this.pending = new Map(); this.events = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
      } else this.events.push(message);
    };
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    assert.equal(typeof expression, 'string', 'evaluate() requires a string expression');
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ': ' + (response.exceptionDetails.exception?.description || ''));
    return response.result.value;
  }
  async click(selector) {
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await sleep(800);
    const point = await this.evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.disabled);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight || !(hit === el || el.contains(hit))) return null;
      return { x: x - (visualViewport?.offsetLeft || 0), y: y - (visualViewport?.offsetTop || 0) };
    })()`);
    if (!point) return false;
    if (this.mobile) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, radiusX: 1, radiusY: 1 }] });
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    }
    await sleep(250);
    return true;
  }
}

const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18571';
const debugging = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18572';
async function main() {
  const target = await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  const check = async (expression, label) => assert.ok(await cdp.evaluate(expression), label);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (String(args[0]) === '/api/user/api-keys' && (!args[1]?.method || args[1].method === 'GET')) {
          const keys = await response.clone().json();
          const aiKeys = keys.map((key, i) => ({...key, permissions: [['gateway.chat'], ['gateway.messages'], ['gateway.responses'], ['gateway.gemini']][i % 4]}));
          return new Response(JSON.stringify([...aiKeys, {...keys[0], id: 99991, name: 'Non-AI test key', permissions: ['gateway.models', 'account.profile.read']}, {...keys[0], id: 99992, name: 'Empty permissions key', permissions: []}]), {status: 200, headers: {'Content-Type': 'application/json'}});
        }
        return response;
      };
    ` });
    for (const width of [1440, 390]) {
      cdp.mobile = width === 390;
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: cdp.mobile });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: 'about:blank' });
      await sleep(200);
      await cdp.send('Page.navigate', { url: `${base}/console#modelLibrary` });
      await sleep(1500);
      for (let i = 0; i < 100; i++) {
        if (await cdp.evaluate(`typeof app !== 'undefined' && !!document.querySelector('.ml-key-choice-model')`)) break;
        await sleep(100);
      }
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
      await cdp.evaluate(`window.scrollTo({top: 0, behavior: 'instant'})`);
      await sleep(600);
      await check(`app._libraryKeys.slice(0, 5).every((key, i) => document.querySelectorAll('.ml-key-choice-model')[i]?.textContent === String(key.current_model_name || key.current_model_id || t('未绑定')))`, '初始模型与 Key 绑定一致');
      await check(`!app._libraryKeys.some(key => [99991, 99992].includes(key.id))`, '无 AI 权限的 Key 从模型库排除');
      assert.ok(await cdp.click('#libraryKeyChips .ml-key-choice:not(.ml-key-expand):nth-of-type(2)'), '点击切换 Key');
      await check(`document.querySelector('.ml-key-choice.is-selected .ml-key-choice-model').textContent === String(app._getSelectedLibraryKey().current_model_name || app._getSelectedLibraryKey().current_model_id || t('未绑定'))`, '选中状态与绑定同步');
      assert.ok(await cdp.click('.ml-key-choice.is-selected'), '再次点击打开菜单');
      await check(`app._isLibraryKeyBubbleOpen()`, '工具菜单正常打开');
      await check(`!document.querySelector('#libraryKeyBubbleMenu [onclick*="onLibraryKeyBubbleHarness("]') && document.querySelector('#libraryKeyBubbleMenu [onclick*="toggleLibraryKeyHarnessSubmenu"]').textContent.includes('按 Harness 工具绑定')`, '主菜单收起 Harness 工具');
      assert.ok(await cdp.click('#libraryKeyBubbleMenu [onclick*="toggleLibraryKeyHarnessSubmenu"]'), '打开 Harness 子菜单');
      await check(`document.querySelectorAll('#libraryKeyBubbleMenu [onclick*="onLibraryKeyBubbleHarness("]').length === app._libraryHarnessList().length`, '子菜单包含全部 Harness');
      assert.ok(await cdp.click('#libraryKeyBubbleMenu [onclick*="toggleLibraryKeyHarnessSubmenu"]'), '返回 Key 主菜单');
      await check(`!!document.querySelector('#libraryKeyBubbleMenu [onclick*="removeLibraryKeyBinding"]') && document.querySelectorAll('#libraryKeyBubbleMenu [onclick*="onLibraryKeyBubbleManage"]').length >= 4`, '移除绑定与管理入口可用');
      assert.ok(await cdp.click('#libraryKeyBubbleMenu [onclick*="toggleLibraryKeyHarnessSubmenu"]'), '再次打开工具子菜单');
      const harnessId = await cdp.evaluate(`app._libraryHarnessList()[0].id`);
      assert.ok(await cdp.click('#libraryKeyBubbleMenu [onclick*="onLibraryKeyBubbleHarness("]'), '选择 Harness 绑定');
      await check(`app._libraryBindTarget === ${JSON.stringify(harnessId)} && !app._isLibraryKeyBubbleOpen()`, '选择工具后进入独立绑定模式');
      await cdp.evaluate(`app.exitLibraryHarnessBindMode()`);
      assert.ok(await cdp.click('.ml-key-choice.is-selected'), '返回默认绑定菜单');

      await cdp.evaluate(`window.__bindingWrites = []; const realFetch = window.fetch; window.fetch = async (...args) => {
        if (args[1]?.method === 'PUT' && String(args[0]).startsWith('/api/user/api-keys/') && String(args[0]).endsWith('/models')) {
          window.__bindingWrites.push(JSON.parse(args[1].body));
          return new Response(JSON.stringify({success: true}), {status: 200});
        }
        return realFetch(...args);
      }`);
      assert.ok(await cdp.click('#libraryKeyBubbleMenu [onclick*="removeLibraryKeyBinding"]'), '点击移除默认绑定');
      assert.ok(await cdp.click('[data-dialog-cancel]'), '取消移除');
      await check(`window.__bindingWrites.length === 0 && !!app._getSelectedLibraryKey().current_model_id`, '取消保留绑定');
      assert.ok(await cdp.click('.ml-key-choice.is-selected'), '重新打开 Key 菜单');
      assert.ok(await cdp.click('#libraryKeyBubbleMenu [onclick*="removeLibraryKeyBinding"]'), '重新移除');
      assert.ok(await cdp.click('[data-dialog-confirm]'), '确认移除');
      await check(`window.__bindingWrites.length === 1 && window.__bindingWrites[0].modelIds.length === 0 && !app._getSelectedLibraryKey().current_model_id && document.querySelector('.ml-key-choice.is-selected .is-unbound') && document.querySelector('#libraryStickyKeyBtn [data-variant="danger"]')`, '移除后按钮、摘要与悬浮栏同步未绑定');
      assert.ok(await cdp.click('.ml-key-choice.is-selected'), '未绑定 Key 菜单');
      await check(`document.querySelector('#libraryKeyBubbleMenu [onclick*="removeLibraryKeyBinding"]').disabled`, '无绑定时禁用移除');
      assert.ok(await cdp.click('#libraryKeyBubbleMenu [onclick*=\"onLibraryKeyBubbleManage(\'permissions\')\"]'), '打开权限管理');
      await check(`app.currentPage === 'apiKeys' && !!app._currentPermissionsKeyId`, '管理入口导航并打开当前 Key 权限');
      await cdp.evaluate(`app.closeModals(); app.navigateTo('modelLibrary')`);
      await sleep(1000);

      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(350);
      // 边界夹具仅修改隔离演示页面的内存数据。
      await cdp.evaluate(`(() => {
        const first = app._libraryKeys[0];
        app._libraryKeys = Array.from({length: 7}, (_, i) => ({...first, id: 900 + i, name: i === 0 ? '<Key & "long">'.repeat(12) : 'Key ' + i, current_model_name: i === 0 ? '<Model & "long">'.repeat(12) : i === 1 ? null : 'Model ' + i, current_model_id: i === 1 ? null : 'model-' + i}));
        app._librarySelectedKeyId = 900;
        app._libraryKeysExpanded = false;
        app._updateLibraryBindingBar();
      })()`);
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
      await check(`document.querySelectorAll('.ml-key-choice-model').length === 5 && document.querySelectorAll('.ml-key-choice-model')[1].textContent === t('未绑定')`, '未绑定与默认折叠');
      await check(`document.querySelector('.ml-key-choice-model').textContent === '<Model & "long">'.repeat(12) && document.querySelector('.ml-key-choice').title.includes('<Model & "long">') && !document.querySelector('.ml-key-choice model')`, '特殊字符安全及完整提示');
      await check(`[...document.querySelectorAll('.ml-key-choice')].every(el => el.getBoundingClientRect().right <= innerWidth) && document.documentElement.scrollWidth <= innerWidth`, '长名称无横向溢出');
      await check(`[...document.querySelectorAll('.ml-key-choice-model')].every(model => {
        const name = model.previousElementSibling.getBoundingClientRect();
        const pill = model.getBoundingClientRect();
        const style = getComputedStyle(model);
        return Math.abs((name.top + name.height / 2) - (pill.top + pill.height / 2)) < 1
          && pill.left >= name.right && pill.width > 14 && name.width > 0
          && parseFloat(style.borderTopLeftRadius) >= pill.height / 2
          && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
      })`, 'Key 名称与模型单行居中，模型显示为胶囊');
      assert.ok(await cdp.click('.ml-key-expand'), '展开 Key');
      await check(`document.querySelectorAll('.ml-key-choice-model').length === 7`, '展开后所有 Key 显示模型');
      assert.ok(await cdp.click('.ml-key-expand'), '收起 Key');
      await check(`document.querySelectorAll('.ml-key-choice-model').length === 5`, '收起恢复');
      await cdp.evaluate(`app._libraryKeys[0].current_model_name = 'Updated model'; app._updateLibraryBindingBar()`);
      await check(`document.querySelector('.ml-key-choice.is-selected .ml-key-choice-model').textContent === 'Updated model' && document.querySelector('#libraryStickyKeyBtn').textContent.includes('Updated model') && document.querySelector('#modelLibraryBindingSummary .binding-model-name').textContent === 'Updated model'`, '绑定更新后按钮、摘要、悬浮栏同步');
      await cdp.evaluate(`app._libraryKeys[0].current_model_name = null; app._renderLibraryKeySelector()`);
      await check(`document.querySelector('.ml-key-choice-model').textContent === 'model-0'`, '缺少模型名称时回退模型 ID');
      await check(`document.querySelectorAll('.ml-key-choice-model')[1].classList.contains('is-unbound') && getComputedStyle(document.querySelectorAll('.ml-key-choice-model')[1]).color !== getComputedStyle(document.querySelector('.ml-key-choice-model')).color`, '未绑定胶囊使用红色');
      await cdp.evaluate(`app.navigateTo('apiKeys')`);
      for (let i = 0; i < 100; i++) {
        if (await cdp.evaluate(`!!document.querySelector('.api-key-group-no-ai')`)) break;
        await sleep(100);
      }
      await check(`document.querySelector('.api-key-group-no-ai').textContent.includes('Non-AI test key') && document.querySelector('.api-key-group-no-ai').textContent.includes('Empty permissions key') && document.querySelectorAll('.api-key-group-no-ai .api-key-card').length === 2`, '密钥管理保留无 AI Key 并单独分类');
      await cdp.evaluate(`app.navigateTo('modelLibrary')`);
      await sleep(1000);
      await check(`app._libraryKeys.length > 0 && !app._libraryKeys.some(key => [99991, 99992].includes(key.id))`, '返回模型库仍过滤无 AI Key');
      await cdp.evaluate(`app._libraryKeysExpanded = true; app._librarySelectedKeyId = null; const nativeFetch = window.fetch; window.fetch = async (...args) => String(args[0]) === '/api/user/api-keys' ? new Response(JSON.stringify([{id: 99991, enabled: true, permissions: []}])) : nativeFetch(...args); app._loadLibraryKeys()`);
      await sleep(500);
      await check(`app._libraryNoAiKeys && !app._libraryAllKeysClosed && app._libraryKeys.length === 0 && document.querySelector('#modelLibraryBindingSummary').textContent.includes('去配置 AI 权限') && !document.querySelector('.ml-key-choice')`, '只有无 AI Key 时显示权限配置空态');
      console.log(`PASS ${width}px: 模型展示、Harness 子菜单与模式切换、移除确认/取消、管理跳转及绑定刷新同步`);
    }
  } finally {
    cdp.ws.close();
    await fetch(`${debugging}/json/close/${target.id}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
