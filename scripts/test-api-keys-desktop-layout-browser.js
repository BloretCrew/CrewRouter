'use strict';
const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
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
 const debug='http://127.0.0.1:18572',base='http://127.0.0.1:18571';
 const target=await fetch(`${debug}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());const cdp=new CDP(target.webSocketDebuggerUrl);
 try{await cdp.send('Page.enable');for(const width of [1024,1440,390]){
 await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:base+'/console#apiKeys'});
 for(let i=0;i<100;i++){if(await cdp.evaluate("typeof app!=='undefined'&&!!document.querySelector('.api-key-card')"))break;await sleep(100);}
 await cdp.evaluate(`app._lastApiKeys.forEach(k=>{k.name='Claude Code 长名称测试客户端';k.signature_enabled=false;k.quota_warning_enabled=true;});app.loadApiKeys();`);await sleep(500);
 await cdp.evaluate(`document.querySelectorAll('.api-key-name').forEach(e=>e.textContent='Claude Code 长名称测试客户端');document.querySelectorAll('.api-key-chips').forEach(e=>e.innerHTML='<span class="api-key-chip">有效</span><span class="api-key-chip">签名继承</span><span class="api-key-chip">额度预警</span>');`);
 assert.ok(await cdp.evaluate(`(()=>{const cards=[...document.querySelectorAll('.api-key-card')];return cards.every(c=>{const r=c.getBoundingClientRect();return c.scrollWidth<=c.clientWidth+1&&r.right<=innerWidth;})})()`),'cards fit '+width);
 if(width===1024)assert.ok(await cdp.evaluate(`(()=>{const n=document.querySelector('.api-key-name');return n.scrollWidth<=n.clientWidth+1&&getComputedStyle(n).whiteSpace==='normal';})()`),'full name');
 const more='.api-key-card .api-key-more > button';assert.ok(await cdp.click(more),'more reachable');
 assert.ok(await cdp.evaluate(`(()=>{const m=document.querySelector('.api-key-more-menu');return m&&getComputedStyle(m).display!=='none';})()`),'menu opens');
 await cdp.evaluate('app.closeModals();document.body.click();window.scrollTo(0,800)');await sleep(350);
 if(width===1024)assert.ok(await cdp.evaluate(`(()=>{const b=document.getElementById('apiKeysStickyBar');return getComputedStyle(b).backgroundColor!=='rgba(0, 0, 0, 0)'&&b.getBoundingClientRect().height<105;})()`),'compact sticky');
 await cdp.evaluate("window.scrollTo(0,0)");await sleep(350);assert.ok(await cdp.click('#createApiKeyBtn'),'create');assert.ok(await cdp.evaluate("document.getElementById('createApiKeyModal').hasAttribute('open')"));await cdp.click('#createApiKeyModal .modal-close');await sleep(350);
 console.log('PASS API Key layout and actions '+width+'x720');
 }}finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}
}main().catch(e=>{console.error(e);process.exitCode=1});
