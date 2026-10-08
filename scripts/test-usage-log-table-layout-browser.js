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
try{await cdp.send('Page.enable');for(const width of [1440,390]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/console?usageTable=${width}#stats`});for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof app!=='undefined'&&!!app.user`))break;await sleep(100);}await cdp.evaluate(`app.navigateTo('stats');app.switchStatsTab('logs')`);await sleep(700);
await cdp.evaluate(`(()=>{const host=document.getElementById('usageLogsList');host.innerHTML='<table class="usage-logs-table"><colgroup><col class="usage-col-time"><col class="usage-col-model"><col class="usage-col-series"><col class="usage-col-source"><col class="usage-col-key"><col class="usage-col-tokens"><col class="usage-col-cache"><col class="usage-col-cost"></colgroup><thead><tr>'+Array.from({length:8},(_,i)=>'<th>Header</th>').join('')+'</tr></thead><tbody><tr><td>2026/10/8</td><td><div class="model-identity-summary">gpt-6.1-sol 客户端请求模型 crew-router 路由模型</div><div class="model-identity-summary">gpt-6.1-sol</div></td><td>-</td><td><span class="blora-badge">DeepSeek Harness</span></td><td><code>sk-test-04-38791b9****</code><br>Bloret PassPort</td><td>201.4K</td><td>-</td><td>0</td></tr></tbody></table>';})()`);await sleep(250);
assert.ok(await cdp.evaluate(`(()=>{const table=document.querySelector('#usageLogsList .usage-logs-table'),cols=[...table.querySelectorAll('col')].map(e=>e.getBoundingClientRect().width),model=table.rows[1].cells[1].getBoundingClientRect(),host=document.getElementById('usageLogsList').getBoundingClientRect();return getComputedStyle(table).tableLayout==='fixed'&&cols[1]>=280&&model.width>=280&&table.scrollWidth>host.width&&document.documentElement.scrollWidth<=innerWidth;})()`),'模型列宽、表格内部横滚且页面无横溢');
if(process.env.USAGE_TABLE_SCREENSHOT_DIR){const r=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.USAGE_TABLE_SCREENSHOT_DIR}/usage-table-${width}.png`,Buffer.from(r.data,'base64'));}
console.log(`PASS usage table layout ${width}px`);
}}finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}}
main().catch(e=>{console.error(e);process.exitCode=1;});
