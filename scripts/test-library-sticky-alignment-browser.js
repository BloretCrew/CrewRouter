#!/usr/bin/env node
'use strict';
// 前置：verify-blora-correction-browser.js --server / --chrome。
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
    const point = await this.evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.disabled);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight || !(hit === el || el.contains(hit))) return null;
      return { x, y };
    })()`);
    if (!point) return false;
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
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
    for (const width of [1440, 726, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 400, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: `${base}/console#modelLibrary` });
      for (let i = 0; i < 100; i++) {
        if (await cdp.evaluate(`typeof app !== 'undefined' && app._libraryKeys?.length > 0 && !!app._libraryStickyObserver`)) break;
        await sleep(100);
      }
      await check(`!!app._libraryStickyObserver`, '模型库已加载');
      if (await cdp.evaluate(`document.getElementById('libraryAdvancedFilters').style.display !== 'none'`)) {
        assert.ok(await cdp.click('#libraryMoreFiltersBtn'), '恢复收起状态');
      }
      await cdp.evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
      await sleep(600);
      await check(`document.getElementById('modelLibraryStickyBar').classList.contains('is-visible')`, '滚动显示悬浮栏');
      for (const expanded of [true, false]) {
        assert.ok(await cdp.click('#libraryStickyMoreFiltersBtn'), '点击筛选按钮');
        await check(`document.getElementById('libraryStickyAdvancedFilters').getAttribute('aria-hidden') === '${!expanded}'`, '高级筛选展开/收起');
        await cdp.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
        await sleep(350);
        await check(`(() => {
          const a = document.getElementById('libraryStickyMoreFiltersBtn').getBoundingClientRect();
          const b = document.getElementById('libraryStickyKeyBtn').getBoundingClientRect();
          const wrap = document.getElementById('libraryStickyKeyWrap').getBoundingClientRect();
          return Math.abs(a.height - b.height) < 1 && Math.abs(b.y + b.height / 2 - wrap.y - wrap.height / 2) < 1
            && (${width} <= 834 || Math.abs(a.y - b.y) < 1) && b.right <= innerWidth && b.left >= 0;
        })()`, '按钮等高、居中且无越界');
      }
      assert.ok(await cdp.click('#libraryStickyKeyBtn'), '打开 Key 工具浮层');
      await check(`getComputedStyle(document.getElementById('libraryKeyBubbleMenu')).display !== 'none'`, 'Key 浮层可见');
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(350);
      await check(`getComputedStyle(document.getElementById('libraryKeyBubbleMenu')).display === 'none'`, 'Escape 关闭浮层');
      await cdp.evaluate('window.scrollTo(0, 0)');
      await sleep(500);
      await check(`!document.getElementById('modelLibraryStickyBar').classList.contains('is-visible')`, '返回顶部隐藏悬浮栏');
      assert.ok(await cdp.click('#libraryMoreFiltersBtn'), '主筛选按钮仍可操作');
      await check(`document.getElementById('libraryAdvancedFilters').style.display !== 'none'`, '主筛选栏同步展开');
      console.log(`PASS ${width}px: 等高对齐、筛选展开收起、Key 浮层、顶部切换`);
    }
  } finally {
    cdp.ws.close();
    await fetch(`${debugging}/json/close/${target.id}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
