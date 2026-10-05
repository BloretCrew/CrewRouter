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
 const debugging=process.env.BLORA_CDP_URL||'http://127.0.0.1:18572',base=process.env.BLORA_TEST_URL||'http://127.0.0.1:18571';const target=await fetch(`${debugging}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());const cdp=new CDP(target.webSocketDebuggerUrl);
 try{await cdp.send('Page.enable');for(const width of [1440,390]){
 await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/console#modelLibrary`});
 for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof app !== 'undefined'&&!!document.querySelector('#libraryKeyChips .model-library-key-item')`))break;await sleep(100);}
 await sleep(1000);
 await cdp.evaluate(`(()=>{const list=document.createElement('div');list.className='model-library-list';document.getElementById('modelLibraryContent').prepend(list);list.innerHTML=[false,true,null].map((ok,i)=>app._renderModelLibraryItem({model_id:'test-'+i,name:'Nebius/Qwen3-Embedding-8B',series:'Embedding & Reranker',test_ok:ok,test_latency_ms:123,test_tokens_per_second:12,provider_id:'test'}, {team_id:'test'},null,false,{showProvider:false})).join('');list.querySelector('.model-library-item').scrollIntoView({block:'center',behavior:'instant'});})()`);await sleep(350);
 assert.ok(await cdp.evaluate(`[...document.querySelectorAll('#modelLibraryContent .model-item-badges')].filter(e=>e.textContent.includes('Embedding & Reranker')).every(e=>{const badge=e.querySelector('.blora-badge');return !e.querySelector('.blora-tag')&&badge&&parseFloat(getComputedStyle(badge).borderTopLeftRadius)>0&&e.scrollWidth<=e.clientWidth;})`),'圆角徽章与无溢出');
 assert.ok(await cdp.evaluate(`document.querySelector('.model-test-badge.fail')?.closest('.model-item-badges')&&document.querySelector('.model-test-badge.pass')?.closest('.model-item-badges')`),'成功失败均在标签行');
 if(process.env.BADGE_SCREENSHOT_DIR){const r=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.BADGE_SCREENSHOT_DIR}/badges-${width}.png`,Buffer.from(r.data,'base64'));}
 console.log(`PASS model card badges ${width}px`);
 }}finally{cdp.ws.close();await fetch(`${debugging}/json/close/${target.id}`);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
