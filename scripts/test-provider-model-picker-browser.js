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

// Start the isolated demo and Chrome with verify-blora-correction-browser.js
// --server and --chrome, then run this script. Provider writes stay in memory.
const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18571';
const debugging = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18572';
async function main() {
  let assertions = 0;
  const target = await fetch(`${debugging}/json/new?about:blank`, {method:'PUT'}).then(res => res.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  const check = async (expression, message) => { assert.ok(await cdp.evaluate(expression), message); assertions++; };
  const click = async selector => { assert.ok(await cdp.click(selector), `click ${selector}`); assertions++; };
  async function wait(expression) { for (let i=0;i<100;i++) { if(await cdp.evaluate(expression)) return; await sleep(100); } throw Error(`timeout ${expression}: ${JSON.stringify(await cdp.evaluate("({status:document.querySelector('[data-model-status]')?.textContent,requests:window.pickerTest?.requests,dialogs:[...document.querySelectorAll('blora-dialog[open]')].map(el=>el.textContent.slice(0,200))})"))}`); }
  const fixture = `(() => {
    const original=window.fetch.bind(window);
    window.pickerTest={requests:[],fail:false,empty:false,saveFail:false,cleaned:false};
    window.fetch=async (url, options={})=>{
      const test=window.pickerTest;
      if(String(url)==='/api/admin/providers/quick-add') return new Response(JSON.stringify({id:'picker-fixture',name:'Fixture Provider'}),{status:200});
      if(!/\\/api\\/admin\\/providers\\/[^/]+\\/(fetch-models|sync-models|cleanup-stale-models)$/.test(String(url)))return original(url,options);
      test.requests.push({url:String(url),body:options.body?JSON.parse(options.body):null});
      if(String(url).endsWith('fetch-models')) {
        if(test.fail)return new Response(JSON.stringify({error:'Fixture fetch failed'}),{status:502});
        const models=test.empty?[]:[{id:'enabled',name:'Enabled Model'},{id:'disabled',name:'Disabled Model'},{id:'new',name:'New Model'},...Array.from({length:125},(_,i)=>({id:'long-model-'+i+'-'.repeat(70),name:'Long model '+i}))];
        const existingModels=test.empty?[]:[{id:'enabled',enabled:true,systemId:'system-enabled'},{id:'disabled',enabled:false,systemId:'system-disabled'},...test.cleaned?[]:[{id:'stale',name:'Stale Model',enabled:true,systemId:'system-stale'}]];
        return new Response(JSON.stringify({models,existingModels,provider_name:'Fixture Provider'}),{status:200});
      }
      if(String(url).endsWith('sync-models')&&test.saveFail)return new Response(JSON.stringify({error:'Fixture save failed'}),{status:500});
      if(String(url).endsWith('cleanup-stale-models'))test.cleaned=true;
      if(String(url).endsWith('sync-models')&&options.body){const body=JSON.parse(options.body);if(body.addOnly)return new Response(JSON.stringify({success:true,selectedModels:body.enabledModelIds.map((id,index)=>({id:'fixture-system-'+index,upstream_model_id:id,name:id}))}),{status:200});}
      return new Response(JSON.stringify({added:1,deleted:1}),{status:200});
    };
  })()`;
  try {
    await cdp.send('Page.enable');
    for (const width of [1440,390]) for (const page of ['console','admin']) {
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
      await cdp.send('Page.navigate',{url:`${base}/${page}#${page==='admin'?'adminProviders':'modelLibrary'}`});
      await wait(`typeof ${page==='admin'?'adminApp':'app'} !== 'undefined' && typeof ProviderModelPicker !== 'undefined' && !!customElements.get('blora-checkbox')`);
      await sleep(900); await cdp.evaluate(fixture);
      if(page==='console') {
        await cdp.evaluate("app.user.isAdmin=true; document.getElementById('libraryQuickAddSystemProvider').hidden=false");
        await click('[onclick="app.showQuickAddSystemProviderDialog()"]');
        await click('#quickAddProviderContinue');
        await check("document.getElementById('quickAddProviderError').textContent.includes('请粘贴')",'empty quick-add validation');
        await click('#quickAddProviderText');
        await cdp.send('Input.insertText',{text:'Fixture Provider https://example.invalid/v1 key: fixture-only'});
        await click('#quickAddProviderContinue');
      } else {
        await wait("!!document.querySelector('[onclick*=\"fetchProviderModels\"]')");
        await click('[onclick*="fetchProviderModels"]');
      }
      await wait("document.querySelectorAll('.provider-model-picker [data-model-list] > div').length===129");
      await check("!!document.querySelector('[data-model-id=enabled] blora-checkbox')?.checked && !!document.querySelector('[data-model-id=stale] blora-checkbox')?.checked",'enabled and stale preselection');
      await check("document.querySelectorAll('[data-model-list] blora-checkbox').length===129",'all models available before saving');
      await click('[data-filter=disabled]');
      await click('[data-model-search]'); await cdp.send('Input.insertText',{text:'New Model'});
      await check("[...document.querySelectorAll('[data-model-list] > div')].filter(el=>!el.hidden).length===1",'search and status intersection');
      await click('[data-select-all]');
      await check("document.querySelector('[data-model-id=new] blora-checkbox')?.checked && document.querySelector('[data-model-id=enabled] blora-checkbox')?.checked",'filtered select-all preserves hidden selection');
      await click('[data-model-id=new] blora-checkbox');
      await check("!document.querySelector('[data-model-id=new] blora-checkbox')?.checked",'Blora Checkbox public state toggles once');
      await click('[data-model-id=new] blora-checkbox');
      await check("document.querySelector('[data-model-id=new] blora-checkbox')?.checked",'Blora checkbox click restores selection');
      await cdp.evaluate("pickerTest.saveFail=true"); await click('[data-save]');
      await wait("document.querySelector('[data-model-status]').textContent.includes('Fixture save failed')");
      await check("!document.querySelector('[data-save]').disabled",'save failure can retry');
      await cdp.evaluate("pickerTest.saveFail=false"); await click('[data-save]');
      await wait("!document.querySelector('.provider-model-picker-dialog')");
      await check("pickerTest.requests.filter(r=>r.url.endsWith('sync-models')).at(-1).body.enabledModelIds.sort().join(',')==='enabled,new,stale'",'save includes hidden selected models');
      const addOnly = page === 'console';
      const reopen=page==='admin'?"adminApp.fetchProviderModels('picker-fixture')":"app.showQuickAddedProviderModels('picker-fixture','Fixture Provider')";
      await cdp.evaluate(`void ${reopen}`); await wait("document.querySelectorAll('[data-model-list] > div').length===129");
      await check(`(() => {const d=document.querySelector('.provider-model-picker-dialog');const p=d.shadowRoot.querySelector('[part=panel]').getBoundingClientRect();return p.x>=0&&p.right<=innerWidth+1&&p.bottom<=innerHeight+1&&d.querySelector('[data-model-list]').clientHeight<d.querySelector('[data-model-list]').scrollHeight;})()`,'responsive panel and inner list scroll');
      if (!addOnly) await wait("document.querySelector('[data-cleanup]') && !document.querySelector('[data-cleanup]').hidden");
      else await check("document.querySelector('[data-cleanup]').hidden",'add-only picker hides destructive stale cleanup');
      if (process.env.PICKER_SCREENSHOT_DIR) {
        const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
        require('node:fs').writeFileSync(require('node:path').join(process.env.PICKER_SCREENSHOT_DIR,`${page}-${width}.png`),Buffer.from(shot.data,'base64'));
      }
      if (!addOnly) {
        await click('[data-cleanup]'); await click('[data-dialog-cancel]');
        await check("!pickerTest.requests.some(r=>r.url.endsWith('cleanup-stale-models'))",'cleanup cancellation');
        await click('[data-cleanup]'); await click('[data-dialog-confirm]');
        await wait("document.querySelectorAll('[data-model-list] > div').length===128");
        await check("pickerTest.requests.find(r=>r.url.endsWith('cleanup-stale-models')).body.modelIds[0]==='system-stale'",'cleanup uses system IDs');
      }
      await cdp.evaluate("pickerTest.fail=true"); await click('[data-retry]');
      await wait("document.querySelector('[data-model-status]').textContent.includes('Fixture fetch failed')");
      await check("document.querySelector('[data-save]').disabled",'failed fetch disables save');
      await cdp.evaluate("pickerTest.fail=false;pickerTest.empty=true"); await click('[data-retry]');
      await wait("document.querySelector('[data-model-status]').textContent.includes('未获取到模型')");
      await check("document.querySelector('[data-save]').disabled && document.querySelectorAll('[data-model-list] > div').length===0",'empty response');
      await cdp.evaluate("pickerTest.empty=false"); await click('[data-retry]');
      await wait(`document.querySelectorAll('[data-model-list] > div').length===${addOnly?129:128}`);
      if (page === 'admin') {
        await click('[data-select-all]'); await click('[data-select-all]');
        await click('[data-save]'); await click('[data-dialog-cancel]');
        await check("!!document.querySelector('.provider-model-picker-dialog')",'disable all cancellation keeps picker');
        await click('[data-save]'); await click('[data-dialog-confirm]');
        await wait("!document.querySelector('.provider-model-picker-dialog')");
        await check("pickerTest.requests.filter(r=>r.url.endsWith('sync-models')).at(-1).body.enabledModelIds.length===0",'confirmed disable all');
      } else {
        await click('[data-select-all]'); await click('[data-save]');
        await wait("!document.querySelector('.provider-model-picker-dialog')");
        await check("pickerTest.requests.filter(r=>r.url.endsWith('sync-models')).at(-1).body.enabledModelIds.length===129",'add-only saves selected models without disable-all confirmation');
      }
      const routes=page==='admin'?['adminModels','adminTeams','adminProviders']:['apiKeys','modelLibrary'];
      for(const route of routes){await cdp.evaluate(`location.hash=${JSON.stringify(route)}`);await sleep(350);await check(`location.hash===${JSON.stringify('#'+route)} && !document.querySelector('.provider-model-picker-dialog')`,'surrounding route '+route);}
      console.log(`PASS ${page} ${width}px`);
    }
    console.log(`PASS ${assertions} browser assertions`);
  } finally {cdp.ws.close(); await fetch(`${debugging}/json/close/${target.id}`);}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
