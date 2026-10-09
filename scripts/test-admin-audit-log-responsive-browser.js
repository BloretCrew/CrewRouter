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
try{await cdp.send('Page.enable');for(const width of [1440,390]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/admin?auditResponsive=${width}#adminAuditLogs`});for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof adminApp!=='undefined'&&!!document.getElementById('adminAuditLogsList')`))break;await sleep(100);}
await cdp.evaluate(`(()=>{const list=document.getElementById('adminAuditLogsList');list.innerHTML='<div class="audit-log-row" style="display:flex;align-items:flex-start;gap:12px;padding:12px;border:1px solid;border-radius:8px"><div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px"><span class="blora-badge" data-variant="info">plugin.action</span><span class="blora-badge" data-variant="danger">管理员</span><strong>Browser User</strong><span>Long audit description '.repeat(8)+'</span></div><div class="api-key-sub-muted">plugin:all-capabilities · HTTP 200</div><details style="margin-top:4px"><summary>详情</summary><pre>'+('raw detail '.repeat(40))+'</pre></details></div><div style="white-space:nowrap">1分钟前</div></div>';})()`);await sleep(250);
assert.ok(await cdp.evaluate(`(()=>{const page=document.querySelector('.blora-admin-audit-page'),card=document.querySelector('.audit-log-row'),badges=[...card.querySelectorAll('.blora-badge')];return page.scrollWidth<=page.clientWidth&&card.scrollWidth<=card.clientWidth&&badges.every(e=>parseFloat(getComputedStyle(e).borderTopLeftRadius)>0);})()`),'日志卡片不溢出且徽章圆角');await cdp.evaluate(`(()=>{const d=document.createElement('details'),s=document.createElement('summary'),p=document.createElement('pre');s.textContent='详情';p.textContent='raw detail';d.append(s,p);document.querySelector('.audit-log-row > div').append(d);})()`);assert.ok(await cdp.click('.audit-log-row details summary'),'详情交互');assert.ok(await cdp.evaluate(`document.querySelector('.audit-log-row details').open&&document.querySelector('.audit-log-row pre').textContent==='raw detail'`),'详情展开');if(process.env.AUDIT_RESPONSIVE_SCREENSHOT_DIR){const r=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.AUDIT_RESPONSIVE_SCREENSHOT_DIR}/audit-responsive-${width}.png`,Buffer.from(r.data,'base64'));}console.log(`PASS audit log responsive ${width}px`);
}}finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}}
main().catch(e=>{console.error(e);process.exitCode=1;});
