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
async function click(s){await sleep(400);assert.ok(await c.click(s),s);}
try{
await c.send('Page.enable');
for(const width of [1440,390]){
await c.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
await c.send('Page.navigate',{url:'http://127.0.0.1:18571/admin#adminProviders'});await wait("typeof adminApp!=='undefined' && !!customElements.get('blora-select')");await sleep(1100);
await c.evaluate(`(()=>{const orig=fetch;window.testQuota=${JSON.stringify(q)};window.savedProvider={id:'cpa-test',name:'CPA',base_url:'https://example.com/v1',format:'openai',enabled:true,quota_mode:'cpa',cpa_management_url:'http://127.0.0.1:8317',has_cpa_management_key:true,quota_script:'{"plugin_id":"old-plugin","auth_index":"old-account"}'};window.writes=[];window.fail=false;window.saveFail=false;window.fetch=async(u,o={})=>{if(String(u)==='/api/admin/providers'&&o.method==='POST'){const body=JSON.parse(o.body);writes.push(body);if(saveFail)return Response.json({error:'Save failed'},{status:500});Object.assign(savedProvider,body);return Response.json({success:true,id:'cpa-test'});}if(String(u)==='/api/admin/providers/cpa-test')return Response.json(savedProvider);if(String(u).endsWith('/cpa-test/check-quota'))return fail?Response.json({error:'CPA HTTP 502'},{status:502}):Response.json({provider:{name:'CPA'},quota:testQuota});return orig(u,o);};adminApp.editProvider(savedProvider);adminApp._setProviderFormSectionsOpen({modelsQuota:true});})()`);
assert.equal(await c.evaluate("document.getElementById('providerCpaPluginId').value"),'old-plugin');
assert.equal(await c.evaluate("document.getElementById('providerCpaManagementUrl').value"),'http://127.0.0.1:8317');
assert.equal(await c.evaluate("document.getElementById('providerCpaManagementKey').value"),'');
assert.ok(await c.evaluate("document.getElementById('cpaQuotaConfigSection').style.display==='block'"));
await c.evaluate("document.getElementById('providerCpaAuthIndex').value=''");await click('#saveProviderBtn');assert.equal(await c.evaluate('writes.length'),0);
async function type(selector,text){await click(selector);await c.evaluate(`document.querySelector(${JSON.stringify(selector)}).value=''`);await c.send('Input.insertText',{text});}
await type('#providerCpaManagementUrl','http://127.0.0.1:8318');await type('#providerCpaManagementKey','isolated-new-key');
await type('#providerCpaPluginId','');await type('#providerCpaAuthIndex','new-account');
await c.evaluate('window.saveFail=true');await click('#saveProviderBtn');assert.ok(await c.evaluate("document.getElementById('addProviderModal').hasAttribute('open')"));
assert.equal(await c.evaluate('JSON.parse(savedProvider.quota_script).plugin_id'),'old-plugin');
await c.evaluate('window.saveFail=false');await click('#saveProviderBtn');await wait("!document.getElementById('addProviderModal').hasAttribute('open')");
assert.equal(await c.evaluate('writes.at(-1).cpa_management_key'),'isolated-new-key');
assert.equal(await c.evaluate('writes.at(-1).cpa_management_url'),'http://127.0.0.1:8318');
assert.deepEqual(JSON.parse(await c.evaluate('savedProvider.quota_script')),{plugin_id:'',auth_index:'new-account'});
await c.evaluate('adminApp.editProvider(savedProvider);adminApp._setProviderFormSectionsOpen({modelsQuota:true})');
assert.equal(await c.evaluate("document.getElementById('providerCpaManagementKey').value"),'');
assert.equal(await c.evaluate("document.getElementById('providerCpaAuthIndex').value"),'new-account');
await click('#saveProviderBtn');await wait("!document.getElementById('addProviderModal').hasAttribute('open')");assert.ok(await c.evaluate("!Object.hasOwn(writes.at(-1),'cpa_management_key')"));
await c.evaluate('adminApp.editProvider(savedProvider);adminApp._setProviderFormSectionsOpen({modelsQuota:true})');
await c.evaluate("document.getElementById('providerQuotaMode').value='script';document.getElementById('providerQuotaMode').dispatchEvent(new Event('change',{bubbles:true}))");
assert.ok(await c.evaluate("document.getElementById('cpaQuotaConfigSection').style.display==='none'"));
await click('#saveProviderBtn');await wait("!document.getElementById('addProviderModal').hasAttribute('open')");assert.ok(await c.evaluate("!Object.hasOwn(writes.at(-1),'quota_script')"));
await c.evaluate("savedProvider.quota_mode='cpa';adminApp.editProvider(savedProvider);adminApp._setProviderFormSectionsOpen({modelsQuota:true})");
assert.equal(await c.evaluate("document.getElementById('providerCpaPluginId').value"),'');
assert.ok(await c.evaluate("document.getElementById('providerCpaAuthIndex').getBoundingClientRect().right<=innerWidth"));
await c.evaluate("document.getElementById('addProviderModal').close();adminApp.providersData.push(savedProvider);adminApp.checkProviderQuota('cpa-test')");await wait("document.getElementById('quotaContent').style.display==='block'");assert.equal(await c.evaluate("document.getElementById('quotaRemaining').textContent"),'50');assert.equal(await c.evaluate("document.getElementById('quotaEditBtn').style.display"),'none');
await c.evaluate("window.fail=true;adminApp.checkProviderQuota('cpa-test')");await wait("document.getElementById('quotaError').style.display==='block'");assert.ok(await c.evaluate("document.getElementById('quotaError').textContent.includes('502')"));
await c.evaluate("document.getElementById('providerQuotaModal').close();adminApp.showAddProviderModal();");assert.equal(await c.evaluate("document.getElementById('providerCpaPluginId').value"),'');assert.equal(await c.evaluate("document.getElementById('providerCpaAuthIndex').value"),'');assert.equal(await c.evaluate("document.getElementById('cpaQuotaConfigSection').style.display"),'none');
await c.send('Page.navigate',{url:'http://127.0.0.1:18571/console#modelLibrary'});await wait("typeof app!=='undefined'");await sleep(1500);
await c.evaluate(`(()=>{const orig=fetch;window.testQuota=${JSON.stringify(q)};window.quotaFail=false;window.fetch=async(u,o)=>String(u).includes('/api/user/providers/quota')?Response.json({providers:[{id:'cpa-test',name:'CPA Test',ok:!quotaFail,error:quotaFail?'CPA HTTP 502':undefined,quota:testQuota}]}):orig(u,o);app.loadProviderQuota();})()`);await wait("document.getElementById('providerQuotaGrid').textContent.includes('CPA Test')");
await click('#providerQuotaRefreshBtn');assert.ok(await c.evaluate("document.getElementById('providerQuotaGrid').textContent.includes('weekly')"));
await c.evaluate("window.quotaFail=true");await click('#providerQuotaRefreshBtn');assert.ok(await c.evaluate("document.getElementById('providerQuotaGrid').textContent.includes('查询失败')"));
await c.evaluate("window.quotaFail=false");await click('#providerQuotaRefreshBtn');assert.ok(await c.evaluate("document.getElementById('providerQuotaGrid').textContent.includes('5h')"));
console.log('CPA desktop/mobile admin config, save/reopen, error and console refresh passed: '+width);
}
}finally{c.ws.close();await fetch('http://127.0.0.1:18572/json/close/'+target.id);}
})().catch(e=>{console.error(e);process.exitCode=1});
