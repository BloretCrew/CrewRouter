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
 const debugging=process.env.BLORA_CDP_URL||'http://127.0.0.1:18572',base=process.env.BLORA_TEST_URL||'http://127.0.0.1:18571';
 const target=await fetch(`${debugging}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());const cdp=new CDP(target.webSocketDebuggerUrl);
 const check=async(e,label)=>assert.ok(await cdp.evaluate(e),label);
 try{await cdp.send('Page.enable');for(const width of [1440,390]){
 await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/console#modelLibrary`});
 for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof app !== 'undefined'&&!!app.user`))break;await sleep(100);}
 await cdp.evaluate(`(()=>{const original=window.fetch.bind(window);window.__providerSaved=null;window.fetch=async(url,options={})=>{if(String(url)==='/api/user/providers/lookup-index')return new Response(JSON.stringify([{id:'test',name:'Browser Provider',base_url:'https://example.test/v1'}]),{status:200});if(String(url)==='/api/user/providers'&&options.method==='POST'){window.__providerSaved=JSON.parse(options.body);return new Response('{}',{status:200});}return original(url,options);};})()`);
 for(const route of ['modelLibrary','myUpstream']){
 await cdp.evaluate(`app.navigateTo('${route}')`);await sleep(500);
 const entry='#'+route+'Page button[onclick="app.showAddProviderModal()"]';
 await cdp.evaluate(`document.querySelector(${JSON.stringify(entry)}).scrollIntoView({block:'center',behavior:'instant'})`);await sleep(300);assert.ok(await cdp.click(entry),'添加供应商入口');await sleep(300);
 await check(`(()=>{const r=document.getElementById('addProviderModal').shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect();return r.width<=586&&r.left>=0&&r.right<=innerWidth;})()`,'弹窗宽度');
 await cdp.evaluate(`document.getElementById('providerSearchInput').focus()`);await cdp.send('Input.insertText',{text:'Browser'});await check(`document.querySelectorAll('#providerListContainer .provider-list-item').length===2`,'搜索匹配');
 assert.ok(await cdp.click('#providerListContainer .provider-list-item:not(.custom)'),'选择供应商');await check(`document.getElementById('providerStep2').style.display==='block'&&document.getElementById('selectedProviderDisplay').textContent.includes('Browser Provider')`,'第二步配置');
 assert.ok(await cdp.click('#providerStep2 button[onclick="app.showProviderStep(1)"]'),'返回选择');
 assert.ok(await cdp.click('#providerListContainer .custom'),'手动填写');
 assert.ok(await cdp.click('#providerStep2 button[onclick="app.saveProvider()"]'),'空地址校验');await check(`document.getElementById('addProviderError').style.display==='block'`,'校验错误可见');
 await cdp.evaluate(`document.getElementById('providerBaseUrl').focus()`);await cdp.send('Input.insertText',{text:'https://example.test/v1'});
 await check(`document.getElementById('providerFormat').value==='openai'&&getComputedStyle(document.getElementById('providerFormat')).borderTopWidth==='0px'`,'格式默认值和单层样式');
 if(process.env.PROVIDER_SCREENSHOT_DIR){const r=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.PROVIDER_SCREENSHOT_DIR}/provider-${width}.png`,Buffer.from(r.data,'base64'));}
 assert.ok(await cdp.click('#providerStep2 button[onclick="app.saveProvider()"]'),'保存供应商');await sleep(500);
 await check(`window.__providerSaved.base_url==='https://example.test/v1'&&window.__providerSaved.format==='openai'&&!document.getElementById('addProviderModal').hasAttribute('open')`,'保存及关闭');
 }console.log(`PASS provider wizard ${width}px`);
 }}finally{cdp.ws.close();await fetch(`${debugging}/json/close/${target.id}`);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
