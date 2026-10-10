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
  const debug='http://127.0.0.1:18572', base='http://127.0.0.1:18571';
  const target=await fetch(`${debug}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());
  const cdp=new CDP(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    for(const page of ['console','admin']) for(const width of [1440,390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
      await cdp.send('Page.navigate',{url:`${base}/${page}#${page==='console'?'modelLibrary':'adminStats'}`});
      for(let i=0;i<100;i++){if(await cdp.evaluate(`document.querySelectorAll('.business-sidebar-navigation .blora-sidebar-nav__link').length>3 && typeof ${page==='console'?'app':'adminApp'}!=='undefined'`))break;await sleep(100);}
      await sleep(500);
      if(width===390) assert.ok(await cdp.click('#sidebarToggle'),'手机导航打开');
      const scope=width===390?'#mobileSidebarDrawer':'.sidebar .business-sidebar-host';
      assert.ok(await cdp.evaluate(`(()=>{const links=[...document.querySelectorAll('${scope} .blora-sidebar-nav__link')].filter(e=>!e.hidden);return links.length>3&&links.every(e=>getComputedStyle(e).display==='flex'&&getComputedStyle(e).textDecorationLine==='none'&&e.querySelector('.business-nav-label'))})()`),'导航组件真实样式和标签');
      const value=page==='console'?'apiKeys':'adminUsers';
      assert.ok(await cdp.click(`${scope} .blora-sidebar-nav__link[data-value="${value}"]`),'实际点击导航');
      await sleep(500);
      assert.ok(await cdp.evaluate(`document.getElementById('${value}Page').classList.contains('active')`),'路由切换');
      assert.ok(await cdp.evaluate(`document.querySelector('.sidebar .blora-sidebar-nav__link[data-value="${value}"]').getAttribute('aria-current')==='page'`),'当前项同步');
      if(width===390) assert.ok(await cdp.evaluate(`!document.getElementById('mobileSidebarDrawer').hasAttribute('open')`),'选择后关闭抽屉');
      const errors=cdp.events.filter(e=>e.method==='Runtime.exceptionThrown');assert.equal(errors.length,0,'无未捕获运行时异常');cdp.events=[];
      console.log(`PASS ${page} sidebar ${width}px`);
    }
  } finally {cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}
}
main().catch(e=>{console.error(e);process.exitCode=1});
