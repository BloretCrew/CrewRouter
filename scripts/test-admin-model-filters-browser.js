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
try{await cdp.send('Page.enable');for(const width of [1440,390]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/admin#adminModels`});for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof adminApp !== 'undefined'&&!!document.getElementById('modelStatusFilter').shadowRoot`))break;await sleep(100);}await cdp.evaluate(`adminApp.navigateTo('adminModels')`);await sleep(700);
assert.ok(await cdp.evaluate(`['modelProviderFilter','modelStatusFilter','modelSeriesFilter','modelTestFilter'].every(id=>document.getElementById(id).shadowRoot.querySelector('[part="trigger"]').textContent.trim().length>0)`),'默认筛选文字');
await cdp.evaluate(`document.getElementById('modelStatusFilter').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(350);assert.ok(await cdp.click('#modelStatusFilter'),'打开状态筛选');
await cdp.evaluate(`document.getElementById('modelStatusFilter').shadowRoot.querySelector('[data-value="enabled"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);await sleep(350);assert.ok(await cdp.evaluate(`document.getElementById('modelStatusFilter').value==='enabled'&&document.getElementById('adminModelsStickyStatus').value==='enabled'`),'主悬浮筛选同步');
assert.ok(await cdp.click('#adminModelsFilters button[onclick="adminApp.clearModelFilters()"]'),'清除筛选');await sleep(350);assert.ok(await cdp.evaluate(`document.getElementById('modelStatusFilter').value===''`),'恢复全部');
assert.ok(await cdp.click('#adminModelsFilters button[onclick="adminApp.expandAllAdminModelProviders()"]'),'展开');await sleep(400);assert.ok(await cdp.click('#adminModelsFilters button[onclick="adminApp.collapseAllAdminModelProviders()"]'),'折叠');
assert.ok(await cdp.evaluate(`(()=>{const e=document.querySelector('.admin-model-filter-actions');return e.scrollWidth<=e.clientWidth;})()`),'操作行无溢出');assert.ok(await cdp.evaluate(`(()=>{const host=document.querySelector('.blora-admin-models-page .model-library-header-actions');const rows=new Map();[...host.children].filter(e=>e.getClientRects().length).forEach(e=>{const r=e.getBoundingClientRect(),key=Math.round(r.top);const row=rows.get(key)||[];row.push(r);rows.set(key,row);});return [...rows.values()].every(row=>Math.abs(Math.max(...row.map(r=>r.right))-host.getBoundingClientRect().right)<2);})()`),'每行按钮铺满可用宽度');
await cdp.evaluate(`document.querySelector('#adminTestDropdown button').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(350);assert.ok(await cdp.click('#adminTestDropdown button'),'一键测试菜单');assert.ok(await cdp.evaluate(`getComputedStyle(document.getElementById('adminTestDropdownMenu')).display!=='none'`),'菜单打开');assert.ok(await cdp.click('#adminTestDropdown button'),'收起菜单');
console.log(`PASS admin model filters and toolbar ${width}px`);
}}finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}}
main().catch(e=>{console.error(e);process.exitCode=1;});
