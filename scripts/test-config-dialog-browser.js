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
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
  await cdp.send('Page.navigate',{url:`${base}/console#modelLibrary`});
  for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof app !== 'undefined' && !!app.user`))break;await sleep(100);}
  await cdp.evaluate(`(()=>{const original=window.fetch.bind(window);window.fetch=async(url,options)=>String(url)==='/api/user/api-keys/1/config'?new Response(JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://example.test',ANTHROPIC_AUTH_TOKEN:'test-config-key'}}),{status:200,headers:{'Content-Type':'application/json'}}):original(url,options);})()`);
  for(const tool of ['claude','codex','opencode','grok','deepseek','qwen_code','hermes','openclaw']){
   await cdp.evaluate('app.generateClaudeConfig(1)');await sleep(350);
   await check(`(()=>{const r=document.getElementById('configToolSelectModal').shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect();return r.width<=714&&r.left>=0&&r.right<=innerWidth;})()`,'选择弹窗宽度');
   await check(`(()=>{const e=document.querySelector('#configToolSelectModal button[onclick="app.showCcSwitchSubmenu()"] img'),r=e.getBoundingClientRect();return r.width<=32&&r.height<=32;})()`,'CC Switch 图标大小');
   if(process.env.CONFIG_SCREENSHOT_DIR&&tool==='claude'){const r=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.CONFIG_SCREENSHOT_DIR}/config-${width}.png`,Buffer.from(r.data,'base64'));}
   const selector=`#configToolSelectModal button[onclick="app.generateToolConfig('${tool}')"]`;
   await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await sleep(300);
   assert.ok(await cdp.click(selector),'选择配置工具');await sleep(500);
   await check(`document.getElementById('configOutputModal').hasAttribute('open') && document.getElementById('configOutputContent').value.length>0`,'生成配置内容');
   await check(`document.getElementById('configOutputModal').shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect().width<=714`,'配置结果宽度');
   assert.ok(await cdp.click('#configOutputModal .modal-close'),'关闭结果');await sleep(300);
  }
  await cdp.evaluate('app.generateClaudeConfig(1)');await sleep(300);
  await cdp.evaluate(`document.querySelector('#configToolSelectModal button[onclick="app.showCcSwitchSubmenu()"]').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(300);
  assert.ok(await cdp.click('#configToolSelectModal button[onclick="app.showCcSwitchSubmenu()"]'),'打开CC Switch子菜单');await sleep(300);
  await check(`document.getElementById('ccSwitchSubmenuModal').hasAttribute('open')&&document.getElementById('ccSwitchSubmenuModal').shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect().width<=714`,'子菜单宽度');
  assert.ok(await cdp.click('#ccSwitchSubmenuModal .modal-close'),'关闭子菜单');await sleep(300);
  console.log(`PASS config dialogs ${width}px`);
 }}finally{cdp.ws.close();await fetch(`${debugging}/json/close/${target.id}`);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
