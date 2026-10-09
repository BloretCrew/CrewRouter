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







async function main(){const debug='http://127.0.0.1:18572',base='http://127.0.0.1:18571';const target=await fetch(`${debug}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());const cdp=new CDP(target.webSocketDebuggerUrl);
try{await cdp.send('Page.enable');for(const width of [1440,390]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/admin?defaultTheme=${width}#adminSettings`});for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof adminApp!=='undefined'&&typeof window.CrewThemes!=='undefined'`))break;await sleep(100);}await cdp.evaluate(`adminApp.navigateTo('adminSettings')`);await sleep(500);await cdp.evaluate(`window.__savedTheme=null;const original=window.fetch.bind(window);window.fetch=async(url,options={})=>{if(String(url)==='/api/admin/settings'&&options.method==='PUT'){window.__savedTheme=JSON.parse(options.body).default_theme;return new Response('{}',{status:200});}return original(url,options);};const themeSelect=document.getElementById('pluginDefaultThemeSelect');themeSelect.append(document.createElement('blora-option'));themeSelect.lastElementChild.setAttribute('value','fixture/linear');themeSelect.lastElementChild.textContent='Linear';`);await sleep(400);
const id='pluginDefaultThemeSelect';assert.ok(await cdp.evaluate(`(()=>{const e=document.getElementById('${id}');return e.localName==='blora-select'&&!e.classList.contains('select')&&e.shadowRoot.querySelector('[part="trigger"]').textContent.includes(t('内置默认主题'))&&getComputedStyle(e).borderTopWidth==='0px';})()`),'默认内置主题单层外观');await cdp.evaluate(`document.getElementById('${id}').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(250);await cdp.evaluate(`document.getElementById('${id}').shadowRoot.querySelector('[part="trigger"]').click()`);assert.ok(await cdp.evaluate(`document.getElementById('${id}').shadowRoot.querySelector('[part="popup"]').hasAttribute('data-open')`),'打开主题选择');await cdp.evaluate(`document.getElementById('${id}').shadowRoot.querySelector('[part="option"][data-value="fixture/linear"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);await sleep(300);assert.ok(await cdp.evaluate(`window.__savedTheme==='fixture/linear'`),'保存主题设置');assert.ok(await cdp.evaluate(`document.getElementById('${id}').value==='fixture/linear'`),'选择状态保持');console.log(`PASS admin default theme select ${width}px`);
}}finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}}
main().catch(e=>{console.error(e);process.exitCode=1;});
