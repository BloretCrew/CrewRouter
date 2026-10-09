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
try{await cdp.send('Page.enable');for(const width of [1440,390]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/admin?promptDetail=${width}#adminPrompts`});for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof adminApp!=='undefined'&&!!document.getElementById('adminPromptDetailBody')`))break;await sleep(100);}
await cdp.evaluate(`(()=>{const original=window.fetch.bind(window);window.__copied=null;window.fetch=async(url,options)=>{if(!String(url).includes('/api/admin/custom-instructions/'))return original(url,options);const content=Array.from({length:80},(_,i)=>'long prompt content '+i).join(String.fromCharCode(10));return new Response(JSON.stringify({file:'/data/Blora-Agent/AGENTS.md',source:'grok',chars:450,occurrence_count:6000,user_count:1,positions:['fragment'],first_seen:'2026-09-13T14:47:42Z',last_seen:'2026-10-08T13:30:49Z',content,recent_refs:[{record_id:210925,created_at:'2026-10-08T13:30:49Z',username:'Detrital',user_id:'12345678-abcd-1234-abcd-123456789012',model_id:'gpt-6.1-sol',request_source:'grok'},{record_id:210172,created_at:'2026-10-08T09:09:37Z',username:'Long Team member name',user_id:'ed304079-24cc-4c8b-9629-45d4eaf71136',model_id:'provider/very-long-model-name',request_source:'codex'}]}) ,{status:200});};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async v=>window.__copied=v}});})()`);
await cdp.evaluate(`adminApp.showAdminPromptDetail('fixture')`);await sleep(800);
assert.ok(await cdp.evaluate(`(()=>{const m=document.getElementById('adminPromptDetailModal').shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect();return m.left>=0&&m.right<=innerWidth&&m.width<=1050;})()`),'弹窗适配视口');
assert.ok(await cdp.evaluate(`document.querySelectorAll('#adminPromptDetailBody [role="tab"]').length===3&&document.querySelector('#adminPromptDetailBody .prompt-refs-table tbody tr').cells.length===5`),'三页及表格列对应');
assert.ok(await cdp.click('#adminPromptDetailBody [aria-controls="adminPromptPage-content"]'),'完整内容页');assert.ok(await cdp.evaluate(`document.getElementById('adminPromptPage-content').hidden===false&&document.getElementById('adminPromptDetailPageIndex').textContent==='2 / 3'`),'内容页激活');await cdp.evaluate(`window.__copied=document.getElementById('adminPromptFullContent').textContent`);assert.ok(await cdp.evaluate(`document.getElementById('adminPromptFullContent')?.textContent?.length>1000`),'完整内容页内容');
assert.ok(await cdp.click('#adminPromptDetailBody [aria-controls="adminPromptPage-refs"]'),'引用记录页');assert.ok(await cdp.evaluate(`document.getElementById('adminPromptPage-refs').hidden===false&&document.querySelector('.prompt-refs-scroll').scrollWidth>=document.querySelector('.prompt-refs-scroll').clientWidth`),'表格可横向滚动');assert.ok(await cdp.evaluate(`document.getElementById('adminPromptDetailNext').disabled`),'最后一页禁用下一页');
if(process.env.PROMPT_DETAIL_SCREENSHOT_DIR){const r=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.PROMPT_DETAIL_SCREENSHOT_DIR}/prompt-detail-${width}.png`,Buffer.from(r.data,'base64'));}
await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(350);assert.ok(await cdp.evaluate(`!document.getElementById('adminPromptDetailModal').hasAttribute('open')`),'关闭弹窗');console.log(`PASS prompt detail pages ${width}px`);
}}finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}}
main().catch(e=>{console.error(e);process.exitCode=1;});
