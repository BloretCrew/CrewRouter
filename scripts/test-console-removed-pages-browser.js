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





async function main() {
  const debug = 'http://127.0.0.1:18572', base = 'http://127.0.0.1:18571';
  const target = await fetch(`${debug}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  const waitFor = async expression => {
    for (let i = 0; i < 100; i++) { if (await cdp.evaluate(expression)) return; await sleep(100); }
    throw new Error(`等待失败: ${expression}; ${JSON.stringify(await cdp.evaluate(`({url:location.href, app:typeof app, current:window.app?.currentPage, links:document.querySelectorAll('.business-sidebar-navigation .blora-sidebar-nav__link').length, errors:document.body.innerText.slice(0,300)})`))}; ${JSON.stringify(cdp.events.filter(e => e.method === 'Runtime.exceptionThrown'))}`);
  };
  try {
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    for (const width of [1440, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      for (const hash of ['modelTrace', 'docs', 'docs/chat', 'docs/errors']) {
        await cdp.send('Page.navigate', { url: `${base}/console#${hash}` });
        await waitFor(`typeof app !== 'undefined' && app.currentPage === 'modelLibrary' && location.hash === '#modelLibrary' && document.querySelectorAll('.business-sidebar-navigation .blora-sidebar-nav__link').length > 3`);
        assert.ok(await cdp.evaluate(`!document.querySelector('#modelTracePage, #docsPage, #docsEditorModal, [data-page="modelTrace"], [data-page="docs"], .blora-sidebar-nav__link[data-value="modelTrace"], .blora-sidebar-nav__link[data-value="docs"]')`), '页面及导航已移除');
      }
      const scope = width === 390 ? '#mobileSidebarDrawer' : '.sidebar .business-sidebar-host';
      for (const page of ['apiKeys', 'myUpstream', 'modelLibrary', 'balance', 'modelLibrary']) {
        if (width === 390) assert.ok(await cdp.click('#sidebarToggle'), '打开手机导航');
        assert.ok(await cdp.click(`${scope} .blora-sidebar-nav__link[data-value="${page}"]`), `点击 ${page}`);
        await waitFor(`app.currentPage === '${page}' && document.getElementById('${page}Page').classList.contains('active')`);
        await sleep(300);
        assert.ok(await cdp.evaluate(`document.querySelector('.sidebar .blora-sidebar-nav__link[data-value="${page}"]').getAttribute('aria-current') === 'page'`), '选中项同步');
        if (width === 390) assert.ok(await cdp.evaluate(`!document.getElementById('mobileSidebarDrawer').hasAttribute('open')`), '选中后关闭抽屉');
      }
      for (const hash of ['modelTrace', 'docs/models']) {
        await cdp.evaluate(`location.hash = '${hash}'`);
        await waitFor(`app.currentPage === 'modelLibrary' && document.getElementById('modelLibraryPage').classList.contains('active')`);
        await sleep(300);
        assert.equal(await cdp.evaluate(`app.currentPage`), 'modelLibrary', '运行中访问旧路由回到模型库');
      }
      for (const page of ['docs', 'modelTrace']) {
        await cdp.evaluate(`app.navigateTo('${page}')`);
        assert.equal(await cdp.evaluate(`location.hash`), '#modelLibrary', '旧程序入口回到模型库');
      }
      assert.ok(await cdp.evaluate(`typeof app.openModelTrace === 'function' && typeof window.ModelTrace?.open === 'function'`), '模型归因操作保留');
      assert.equal(cdp.events.filter(e => e.method === 'Runtime.exceptionThrown').length, 0, '无未捕获异常');
      cdp.events = [];
      console.log(`PASS console removed pages and adjacent navigation ${width}px`);
    }
  } finally { cdp.ws.close(); await fetch(`${debug}/json/close/${target.id}`); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
