#!/usr/bin/env node
'use strict';
// 前置：独立 BLORA_TEST_URL / BLORA_CDP_URL 的 demo 和 Chrome；额度响应使用浏览器内 fixture。
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
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
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);
    await sleep(350);
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






const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18881';
const debug = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18882';
async function choose(cdp, selector, value) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    await sleep(400);
    const opened = await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).shadowRoot.querySelector('[part="trigger"]').getAttribute('aria-expanded')==='true'`);
    if (!opened) assert.ok(await cdp.click(selector), '打开Blora选择器');
    await sleep(400);
    const point = await cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)});const options=[...e.shadowRoot.querySelectorAll('[part="option"]')];const i=[...e.querySelectorAll('blora-option')].findIndex(o=>o.getAttribute('value')===${JSON.stringify(value)});const o=options[i];if(!o)return null;o.scrollIntoView({block:'nearest',behavior:'instant'});const r=o.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    assert.ok(point, '找到真实选项');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    await sleep(300);
    if (await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`) === value) return;
  }
  console.error(await cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),o=e.shadowRoot.querySelectorAll('[part="option"]')[1],r=o.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {selector:${JSON.stringify(selector)},rect:r.toJSON(),hit:hit?.outerHTML.slice(0,500),open:e.shadowRoot.querySelector('[part="trigger"]').getAttribute('aria-expanded')};})()`));
  assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), value, '真实选项值');
}

function fixture() {
  const original=window.fetch;
  window.configStore={enabled:true,mode:'async',reconciliation_seconds:60,max_tries:5,worker_interval_ms:2000,batch_size:10,lease_seconds:120};
  window.configCalls=[];window.configMode='normal';window.configDelay=0;
  window.fetch=async function(input,options){
    const url=new URL(typeof input==='string'?input:input.url,location.origin);
    if(url.pathname!=='/api/admin/request-quota-config')return original.call(this,input,options);
    const method=options?.method||'GET';configCalls.push({method,body:options?.body});
    if(configDelay)await new Promise(resolve=>setTimeout(resolve,configDelay));
    if(configMode==='denied')return Response.json({error:'无权查看额度'},{status:403});
    if(configMode==='error')return Response.json({error:'配置测试保存失败'},{status:500});
    if(method==='PUT')configStore=JSON.parse(options.body);
    return Response.json(configStore);
  };
}
async function waitFor(cdp,expression,description){for(let i=0;i<80;i++){if(await cdp.evaluate(expression))return;await sleep(100);}assert.fail(description);}
async function type(cdp,selector,text){
  assert.ok(await cdp.click(selector),'真实点击输入');
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await cdp.send('Input.insertText',{text});
}
async function main(){
 for(const width of [1440,390]){
  const target=await fetch(`${debug}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json()),cdp=new CDP(target.webSocketDebuggerUrl);
  try{
   await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
   await cdp.send('Page.navigate',{url:`${base}/admin?config-test=${width}`});
   await waitFor(cdp,`typeof adminApp!=='undefined'&&!!window.CrewRouterRequestQuotaConfig`,'真实配置资源');
   await cdp.evaluate(`(${fixture.toString()})();adminApp.navigateTo('adminSettings')`);
   await waitFor(cdp,`document.querySelector('[data-admin-settings-category="retention"]')?.getClientRects().length`,'设置卡片');
   assert.ok(await cdp.click('[data-admin-settings-category="retention"]'),'真实进入数据保留与采集配置');await sleep(500);
   const form='#requestQuotaConfigForm';
   await cdp.evaluate(`configDelay=700;void CrewRouterRequestQuotaConfig.load()`);
   assert.ok(await cdp.evaluate(`document.querySelector('${form} [type="submit"]').disabled`),'loading禁止保存');
   await waitFor(cdp,`!document.querySelector('${form} [type="submit"]').disabled`,'GET加载完成');await cdp.evaluate('configDelay=0');
   await choose(cdp,form+' [name="mode"]','strict');await type(cdp,form+' [name="max_tries"]','7');
   assert.ok(await cdp.click(form+' [type="submit"]'),'真实保存strict');
   await waitFor(cdp,`document.querySelector('${form} [role="status"]').textContent.includes('已保存')`,'保存提示');
   assert.ok(await cdp.evaluate(`configStore.mode==='strict'&&configStore.max_tries===7&&configCalls.some(c=>c.method==='PUT')`),'strict/maxtries GET PUT store');
   await cdp.evaluate(`adminApp.navigateTo('adminStats');adminApp.navigateTo('adminSettings')`);await sleep(400);
   assert.ok(await cdp.click('[data-admin-settings-category="retention"]'),'真实重新打开设置');await cdp.evaluate('void CrewRouterRequestQuotaConfig.load()');
   await waitFor(cdp,`document.querySelector('${form} [name="mode"]').value==='strict'&&document.querySelector('${form} [name="max_tries"]').value==='7'`,'重开读回存储');
   await cdp.evaluate("configMode='error'");assert.ok(await cdp.click(form+' [type="submit"]'),'真实失败保存');
   await waitFor(cdp,`document.querySelector('${form} [role="status"]').textContent.includes('失败')`,'PUT失败提示');
   assert.ok(await cdp.evaluate(`!document.querySelector('${form} [type="submit"]').disabled`),'失败可重试');
   await cdp.evaluate('void CrewRouterRequestQuotaConfig.load()');await waitFor(cdp,`document.querySelector('${form} [type="submit"]').disabled`,'GET错误禁止保存');
   await cdp.evaluate("configMode='normal';void CrewRouterRequestQuotaConfig.load()");await waitFor(cdp,`!document.querySelector('${form} [type="submit"]').disabled`,'恢复加载');
   await cdp.evaluate("configMode='denied'");assert.ok(await cdp.click(form+' [type="submit"]'),'真实403保存');
   await waitFor(cdp,`document.querySelector('${form} [role="status"]').textContent.includes('无权')`,'PUT403提示');
   await cdp.evaluate('void CrewRouterRequestQuotaConfig.load()');await sleep(250);
   assert.ok(await cdp.evaluate(`document.querySelector('${form} [type="submit"]').disabled`),'GET403禁止保存');
   assert.ok(await cdp.evaluate('document.documentElement.scrollWidth<=innerWidth'),'配置页面无水平溢出');
   console.log(`PASS config ${width}`);
  }finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
