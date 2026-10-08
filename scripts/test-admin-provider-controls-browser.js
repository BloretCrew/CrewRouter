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
 const debugging=process.env.BLORA_CDP_URL||'http://127.0.0.1:18572',base=process.env.BLORA_TEST_URL||'http://127.0.0.1:18571';const target=await fetch(`${debugging}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());const cdp=new CDP(target.webSocketDebuggerUrl);const check=async(e,label)=>assert.ok(await cdp.evaluate(e),label);
  const select = async (id, value) => {
    await cdp.evaluate(`window.scrollTo(0,0);document.getElementById('${id}').scrollIntoView({ block: 'start', behavior: 'instant' })`);
    await sleep(300);
    await cdp.evaluate(`document.getElementById('adminProvidersStickyBar')?.classList.remove('is-visible')`);
    assert.ok(await cdp.click('#' + id), '打开筛选');
    await sleep(350);
    await cdp.evaluate(`(() => {const e=[...document.getElementById('${id}').shadowRoot.querySelectorAll('[part="option"]')].find(e=>e.dataset.value==='${value}');e.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));})()`);
    await sleep(350);
    await check(`document.getElementById('${id}').value === '${value}'`, id + ' '+value+' 选择生效');
  };


 try{await cdp.send('Page.enable');for(const width of [1440,390]){
 await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/admin#adminProviders`});
 for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof adminApp !== 'undefined'&&!!document.querySelector('.provider-select-cb')`))break;await sleep(100);}
 for(const id of ['providerStatusFilter','providerScopeFilter','providerKeyModeFilter'])await check(`(()=>{const e=document.getElementById('${id}');return !e.classList.contains('select')&&getComputedStyle(e).borderTopWidth==='0px'&&e.shadowRoot.querySelector('[part="trigger"]').textContent.trim().length>0;})()`,'筛选单层外观及标签');
 await select('providerStatusFilter','enabled');await select('providerStatusFilter','');await select('providerScopeFilter','global');await select('providerScopeFilter','');await select('providerKeyModeFilter','fixed');await select('providerKeyModeFilter','');
 await cdp.evaluate(`adminApp.setProviderView('card')`);await sleep(300);
 await cdp.evaluate(`(()=>{const cards=[...document.querySelectorAll('#adminProvidersList .admin-card')];if(cards.length<2)return;const menu=cards[0].querySelector('.provider-row-dropdown'),wrap=menu.parentElement;cards[0].classList.add('has-open-provider-menu');wrap.style.position='relative';menu.style.display='block';menu.style.position='absolute';menu.style.top='100%';menu.style.left='0';menu.style.width='190px';menu.style.height='120px';menu.style.background='white';menu.style.zIndex='32';menu.style.border='1px solid black';})();`);
 await check(`(()=>{const cards=[...document.querySelectorAll('#adminProvidersList .admin-card')];if(cards.length<2)return true;const m=cards[0].querySelector('.provider-row-dropdown'),r=m.getBoundingClientRect(),next=cards[1].getBoundingClientRect();const overlap=document.elementFromPoint(r.left+12,next.top+12);return cards[0].classList.contains('has-open-provider-menu')&&getComputedStyle(cards[0]).zIndex==='30'&&getComputedStyle(m).zIndex==='32'&&r.width>=180;})()`,'菜单浮于相邻供应商卡片上方');
 await cdp.evaluate(`adminApp.toggleProviderRowMenu([...document.querySelectorAll('[data-row-menu-btn]')][0].dataset.rowMenuBtn)`);

 await cdp.evaluate(`document.querySelector('.provider-select-cb').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(350);
 assert.ok(await cdp.click('.provider-select-cb'),'单选供应商');await check(`adminApp.selectedProviders.size===1`,'选择状态');
 await check(`(()=>{const bar=document.querySelector('.provider-select-all-bar'),cb=document.getElementById('providerSelectAllPage');return cb.getBoundingClientRect().left-bar.getBoundingClientRect().left>=12&&!cb.parentElement.closest('label');})()`,'全选安全间距与独立标签');
 assert.ok(await cdp.click('#providerSelectAllPage'),'全选');await check(`[...document.querySelectorAll('.provider-select-cb')].every(e=>e.checked)`,'全选同步');
 assert.ok(await cdp.click('#providerSelectAllPage'),'取消全选');await check(`adminApp.selectedProviders.size===0`,'取消全选同步');
 const switchSelector='.provider-row-actions > blora-switch';
 await cdp.evaluate(`(()=>{const original=window.fetch.bind(window);window.fetch=async(url,options={})=>{if(String(url).startsWith('/api/admin/providers/')&&options.method==='POST'){window.__providerUpdate=JSON.parse(options.body);return new Response('{}',{status:200});}return original(url,options);};})()`);
 assert.ok(await cdp.click(switchSelector),'切换供应商启用');await sleep(350);await check(`window.__providerUpdate&&typeof window.__providerUpdate.enabled==='boolean'`,'开关写入');
 await cdp.evaluate(`document.getElementById('adminProvidersFilters').scrollIntoView({block:'start',behavior:'instant'})`);await sleep(300);
 if(process.env.ADMIN_PROVIDER_SCREENSHOT_DIR){const r=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.ADMIN_PROVIDER_SCREENSHOT_DIR}/admin-providers-${width}.png`,Buffer.from(r.data,'base64'));}
 assert.ok(await cdp.click('.provider-row-actions button[onclick*="editProviderById"]'),'打开编辑');await sleep(350);
 await check(`document.getElementById('addProviderModal').hasAttribute('open')`,'编辑弹窗');
 assert.ok(await cdp.click('#addProviderModal .modal-close'),'关闭编辑');await sleep(350);
 await cdp.evaluate(`adminApp.setProviderView('table')`);await sleep(300);
 await cdp.evaluate(`document.querySelector('.provider-select-cb').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(350);
 await cdp.evaluate(`document.querySelector('.provider-select-cb input').focus()`);await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});await sleep(300);await check(`adminApp.selectedProviders.size===1`,'表格状态'+await cdp.evaluate('adminApp.selectedProviders.size'));
 await cdp.evaluate(`adminApp.clearProviderSelection()`);
 console.log(`PASS admin provider controls ${width}px`);
 }}finally{cdp.ws.close();await fetch(`${debugging}/json/close/${target.id}`);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
