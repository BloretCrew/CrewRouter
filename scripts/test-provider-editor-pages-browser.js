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
try{await cdp.send('Page.enable');for(const width of [1440,390]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/admin?editor=${width}#adminProviders`});for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof adminApp !== 'undefined'&&!!document.querySelector('.provider-row-actions')`))break;await sleep(100);}
assert.ok(await cdp.click('.provider-row-actions button[onclick*="editProviderById"]'),'编辑入口');await sleep(350);assert.ok(await cdp.evaluate(`(()=>{const r=document.getElementById('addProviderModal').shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect();return Math.abs(r.width-innerWidth)<2&&Math.abs(r.height-innerHeight)<2;})()`),'全屏尺寸');
if(process.env.PROVIDER_EDITOR_SCREENSHOT_DIR){const r=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.PROVIDER_EDITOR_SCREENSHOT_DIR}/provider-editor-${width}.png`,Buffer.from(r.data,'base64'));}
await cdp.evaluate(`document.getElementById('providerName').focus();document.getElementById('providerName').select()`);await cdp.send('Input.insertText',{text:'Browser provider edit'});
for(let i=1;i<7;i++){assert.ok(await cdp.click('#providerEditorNext'),'下一页');assert.ok(await cdp.evaluate(`adminApp._providerEditorPage===${i}&&document.querySelectorAll('#addProviderModal .provider-form-section:not([hidden])').length===1`),'单页展示');}
for(let i=5;i>=0;i--)assert.ok(await cdp.click('#providerEditorPrevious'),'上一页');assert.ok(await cdp.evaluate(`document.getElementById('providerName').value==='Browser provider edit'`),'输入保留');
await cdp.evaluate(`(()=>{window.__toasts=[];adminApp.showToast=(msg)=>window.__toasts.push(msg);const original=window.fetch.bind(window);window.fetch=async(url,options={})=>{if(String(url)==='/api/admin/providers'&&options.method==='POST'){window.__savedProvider=JSON.parse(options.body);return new Response('{}',{status:200});}return original(url,options);};})()`);
assert.ok(await cdp.click('#saveProviderBtn'),'保存编辑');await sleep(500);assert.ok(await cdp.evaluate(`window.__savedProvider?.name==='Browser provider edit'`),'保存跨页表单');
await cdp.evaluate(`adminApp.showAddProviderModal()`);await sleep(350);assert.ok(await cdp.evaluate(`adminApp._providerEditorPage===0`),'新建回到第一页');assert.ok(await cdp.click('#addProviderModal .modal-close'),'取消新建');await sleep(300);console.log(`PASS fullscreen provider pages ${width}px`);
}}finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}}
main().catch(e=>{console.error(e);process.exitCode=1;});
