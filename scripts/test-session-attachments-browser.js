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
 await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/console#sessions`});
 for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof app !== 'undefined'&&!!app.user`))break;await sleep(100);}
 await cdp.evaluate(`app.navigateTo('sessions')`);await sleep(800);
 await cdp.evaluate(`(()=>{const host=document.getElementById('sessionsPage');const ul=document.createElement('ul');ul.className='timeline-events';ul.id='attachmentTest';ul.innerHTML=app.renderTimelineEvent({type:'text',role:'user',text:'Hello image',attachments:[{type:'image',url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='}]})+app.renderTimelineEvent({type:'text',role:'assistant',text:'First paragraph\\n\\nSecond paragraph'});host.prepend(ul);ul.scrollIntoView({block:'center',behavior:'instant'});})()`);await sleep(350);
 assert.ok(await cdp.click('#attachmentTest summary'),'展开图片附件');
 assert.ok(await cdp.evaluate(`document.querySelector('#attachmentTest details').open&&document.querySelector('#attachmentTest img').complete&&getComputedStyle(document.querySelector('#attachmentTest .role-assistant-text')).whiteSpace==='normal'`),'图片展示和Markdown正常空白');
 assert.ok(await cdp.click('#attachmentTest summary'),'折叠图片');
 assert.ok(await cdp.evaluate(`!document.querySelector('#attachmentTest details').open`),'折叠关闭');
 console.log(`PASS session attachments ${width}px`);
 }}finally{cdp.ws.close();await fetch(`${debugging}/json/close/${target.id}`);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
