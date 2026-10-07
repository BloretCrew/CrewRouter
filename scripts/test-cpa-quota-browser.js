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
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ': ' + response.exceptionDetails.exception?.description);
    return response.result.value;
  }
  async key(key) {
    const codes = { Tab: 9, Escape: 27, Enter: 13, ArrowDown: 40 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: codes[key] });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: codes[key] });
  }
  async click(selector) {
    const found = await this.evaluate(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&!e.disabled);if(!el)return false;el.scrollIntoView({block:'center',behavior:'instant'});return true;})()`);
    if(!found)return false;
    await sleep(160);
    const point = await this.evaluate(`(() => {const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&!e.disabled);if(!el)return null;const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(x<0||x>=innerWidth||y<0||y>=innerHeight||!(hit===el||el.contains(hit)))return null;return {x,y};})()`);
    if(!point)return false;
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(160); return true;
  }
}
// Run with the isolated demo and Chrome from verify-blora-correction-browser.js.
// Provider writes are intercepted and retained only in browser memory.
const { normalizeCpaQuota } = require('../server/utils/cpa-usage');
const q=normalizeCpaQuota({subscription:{plan:'CPA Test'},groups:[{displayName:'Codex',buckets:[{window:'5h',remainingFraction:0.75},{window:'weekly',remainingFraction:0.5}]}]});
(async()=>{
const target=await fetch('http://127.0.0.1:18572/json/new?about:blank',{method:'PUT'}).then(r=>r.json()); const c=new CDP(target.webSocketDebuggerUrl);
async function wait(expr){for(let i=0;i<100;i++){if(await c.evaluate(expr))return;await sleep(100);}throw Error(expr);}
async function click(s){assert.ok(await c.click(s),s);}
try{
await c.send('Page.enable');
for(const width of [1440,390]){
await c.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
await c.send('Page.navigate',{url:'http://127.0.0.1:18571/admin#adminProviders'});await wait("typeof adminApp!=='undefined' && !!customElements.get('blora-select')");await sleep(1100);
await c.evaluate(`(()=>{const orig=fetch;window.testQuota=${JSON.stringify(q)};window.saved='';window.fail=false;window.alerts=[];window.alert=x=>alerts.push(x);window.fetch=async(u,o={})=>{if(String(u)==='/api/admin/providers/cpa-test')return Response.json({id:'cpa-test',name:'CPA',quota_mode:'cpa',quota_script:saved});if(String(u).endsWith('/cpa-test/quota-script')){window.saved=JSON.parse(o.body).script;return Response.json({success:true});}if(String(u).endsWith('/cpa-test/check-quota'))return fail?Response.json({error:'CPA HTTP 502'},{status:502}):Response.json({provider:{name:'CPA'},quota:testQuota});return orig(u,o);};adminApp.providersData.push({id:'cpa-test',quota_mode:'cpa'});adminApp.showAddProviderModal();})()`);
await c.evaluate("document.getElementById('providerQuotaMode').value='cpa';document.getElementById('providerQuotaMode').dispatchEvent(new Event('change',{bubbles:true}))");
assert.ok(await c.evaluate("document.getElementById('providerQuotaModeHint').textContent.includes('CPA_MANAGEMENT_KEY')"));
await c.evaluate("document.getElementById('addProviderModal').close();adminApp.checkProviderQuota('cpa-test')");await wait("document.getElementById('quotaContent').style.display==='block'");assert.equal(await c.evaluate("document.getElementById('quotaRemaining').textContent"),'50');
await click('#quotaEditBtn');await wait("!document.getElementById('quotaScriptText').disabled");assert.deepEqual(JSON.parse(await c.evaluate("document.getElementById('quotaScriptText').value")),{plugin_id:'',auth_index:''});
await click('#quotaSaveBtn');assert.equal(await c.evaluate('alerts.length'),1);assert.equal(await c.evaluate('saved'),'');
await click('#quotaScriptText');await c.evaluate("document.getElementById('quotaScriptText').value=''");await c.send('Input.insertText',{text:'{"plugin_id":"test","auth_index":"account"}'});await click('#quotaSaveBtn');await wait("document.getElementById('quotaContent').style.display==='block'");assert.equal(await c.evaluate('saved'),'{"plugin_id":"test","auth_index":"account"}');
await click('#quotaEditBtn');await wait("!document.getElementById('quotaScriptText').disabled");assert.equal(await c.evaluate("document.getElementById('quotaScriptText').value"),'{"plugin_id":"test","auth_index":"account"}');
await c.evaluate("window.fail=true;adminApp.checkProviderQuota('cpa-test')");await wait("document.getElementById('quotaError').style.display==='block'");assert.ok(await c.evaluate("document.getElementById('quotaError').textContent.includes('502')"));
await c.send('Page.navigate',{url:'http://127.0.0.1:18571/console#modelLibrary'});await wait("typeof app!=='undefined'");await sleep(1500);
await c.evaluate(`(()=>{const orig=fetch;window.testQuota=${JSON.stringify(q)};window.quotaFail=false;window.fetch=async(u,o)=>String(u).includes('/api/user/providers/quota')?Response.json({providers:[{id:'cpa-test',name:'CPA Test',ok:!quotaFail,error:quotaFail?'CPA HTTP 502':undefined,quota:testQuota}]}):orig(u,o);app.loadProviderQuota();})()`);await wait("document.getElementById('providerQuotaGrid').textContent.includes('CPA Test')");
await click('#providerQuotaRefreshBtn');assert.ok(await c.evaluate("document.getElementById('providerQuotaGrid').textContent.includes('weekly')"));
await c.evaluate("window.quotaFail=true");await click('#providerQuotaRefreshBtn');assert.ok(await c.evaluate("document.getElementById('providerQuotaGrid').textContent.includes('查询失败')"));
await c.evaluate("window.quotaFail=false");await click('#providerQuotaRefreshBtn');assert.ok(await c.evaluate("document.getElementById('providerQuotaGrid').textContent.includes('5h')"));
console.log('CPA desktop/mobile admin config, save/reopen, error and console refresh passed: '+width);
}
}finally{c.ws.close();await fetch('http://127.0.0.1:18572/json/close/'+target.id);}
})().catch(e=>{console.error(e);process.exitCode=1});
