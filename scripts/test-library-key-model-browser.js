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
    for (const width of [1440, 390]) {
      cdp.mobile = width === 390;
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: cdp.mobile });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: `${base}/console#modelLibrary` });
      await sleep(1500);
      for (let i = 0; i < 100; i++) {
        if (await cdp.evaluate(`typeof app !== 'undefined' && !!document.querySelector('.ml-key-choice-model')`)) break;
        await sleep(100);
      }
      await check(`app._libraryKeys.slice(0, 5).every((key, i) => document.querySelectorAll('.ml-key-choice-model')[i]?.textContent === String(key.current_model_name || key.current_model_id || t('未绑定')))`, '初始模型与 Key 绑定一致');
      assert.ok(await cdp.click('#libraryKeyChips .ml-key-choice:not(.ml-key-expand):nth-of-type(2)'), '点击切换 Key');
      await check(`document.querySelector('.ml-key-choice.is-selected .ml-key-choice-model').textContent === String(app._getSelectedLibraryKey().current_model_name || app._getSelectedLibraryKey().current_model_id || t('未绑定'))`, '选中状态与绑定同步');
      assert.ok(await cdp.click('.ml-key-choice.is-selected'), '再次点击打开菜单');
      await check(`app._isLibraryKeyBubbleOpen()`, '工具菜单正常打开');
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
      assert.ok(await cdp.click('.ml-key-expand'), '展开 Key');
      await check(`document.querySelectorAll('.ml-key-choice-model').length === 7`, '展开后所有 Key 显示模型');
      assert.ok(await cdp.click('.ml-key-expand'), '收起 Key');
      await check(`document.querySelectorAll('.ml-key-choice-model').length === 5`, '收起恢复');
      await cdp.evaluate(`app._libraryKeys[0].current_model_name = 'Updated model'; app._updateLibraryBindingBar()`);
      await check(`document.querySelector('.ml-key-choice.is-selected .ml-key-choice-model').textContent === 'Updated model' && document.querySelector('#libraryStickyKeyBtn').textContent.includes('Updated model') && document.querySelector('#modelLibraryBindingSummary .binding-model-name').textContent === 'Updated model'`, '绑定更新后按钮、摘要、悬浮栏同步');
      await cdp.evaluate(`app._libraryKeys[0].current_model_name = null; app._renderLibraryKeySelector()`);
      await check(`document.querySelector('.ml-key-choice-model').textContent === 'model-0'`, '缺少模型名称时回退模型 ID');
      console.log(`PASS ${width}px: 模型展示、Key 切换、工具菜单、展开收起、未绑定、长名称、转义及绑定刷新同步`);
    }
  } finally {
    cdp.ws.close();
    await fetch(`${debugging}/json/close/${target.id}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
