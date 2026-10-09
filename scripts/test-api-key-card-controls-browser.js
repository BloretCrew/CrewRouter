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






async function main(){
 const debugging='http://127.0.0.1:18572',base='http://127.0.0.1:18571';const target=await fetch(`${debugging}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());const cdp=new CDP(target.webSocketDebuggerUrl);
 try{await cdp.send('Page.enable');for(const width of [1440,390]){
 await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/console#apiKeys`});
 for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof app !== 'undefined'&&!!document.querySelector('.api-key-card blora-switch')`))break;await sleep(100);}
 await cdp.evaluate(`(()=>{const original=window.fetch.bind(window);window.fetch=async(url,options={})=>{if(String(url).includes('/enabled')&&options.method==='PUT'){window.__keyEnabled=JSON.parse(options.body).enabled;return new Response('{}',{status:200});}return original(url,options);};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedKey=text;}}});})()`);
 assert.ok(await cdp.evaluate(`[...document.querySelectorAll('.api-key-chip')].every(e=>parseFloat(getComputedStyle(e).borderRadius)>0)`),'状态标签圆角');
 assert.ok(await cdp.click('.api-key-card blora-switch'),'切换启停');await assert.ok(await cdp.evaluate(`typeof window.__keyEnabled==='boolean'`),'启停请求');
 const createDialog=await cdp.evaluate(`(()=>{const d=document.getElementById('createApiKeyModal');d.show();return d.hasAttribute('open')})()`);assert.ok(createDialog,'创建密钥弹窗打开');await sleep(250);assert.ok(await cdp.evaluate(`(()=>{const r=document.getElementById('createApiKeyModal').shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect();return r.width<=500&&r.left>=0&&r.right<=innerWidth})()`),'创建密钥弹窗保持内容宽度');await cdp.evaluate(`document.getElementById('createApiKeyModal').close()`);await sleep(250);
 const card='.api-key-card';await cdp.evaluate(`document.querySelector('${card}').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(350);
 assert.ok(await cdp.click('.api-key-card .copy-btn[onclick*="copyFullKey"]'),'复制Key');assert.ok(await cdp.evaluate(`!!window.__copiedKey`),'复制完成');
 assert.ok(await cdp.click('.api-key-card button[onclick*="showKeyModels"]'),'模型队列');await sleep(400);assert.ok(await cdp.evaluate(`document.getElementById('keyModelsModal').hasAttribute('open')`),'队列打开');
 await cdp.evaluate(`app.closeModals()`);await sleep(350);
 console.log(`PASS API Key card controls ${width}px`);
 }}finally{cdp.ws.close();await fetch(`${debugging}/json/close/${target.id}`);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
