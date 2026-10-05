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
 const shot=async name=>{if(!process.env.MODAL_SCREENSHOT_DIR)return;const r=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.MODAL_SCREENSHOT_DIR}/${name}.png`,Buffer.from(r.data,'base64'));};
 try{await cdp.send('Page.enable');for(const width of [1440,390]){
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
  await cdp.send('Page.navigate',{url:`${base}/console#prompts`});
  for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof app !== 'undefined' && !!app.user`))break;await sleep(100);}
  await cdp.evaluate(`(()=>{const original=window.fetch.bind(window);window.__saved=null;window.__keyIds=null;window.__noKeys=false;window.fetch=async(url,options={})=>{const u=String(url),json=data=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});if(u==='/api/user/inject-prompts/my-keys')return json({items:window.__noKeys?[]:[{id:1,name:'Test Key',key_prefix:'sk-test'}]});if(u==='/api/user/inject-prompts'&&options.method==='POST'){window.__saved=JSON.parse(options.body);return json({item:{id:99}});}if(u==='/api/user/inject-prompts/99/keys'){window.__keyIds=JSON.parse(options.body).keyIds;return json({ok:true});}return original(url,options);};})()`);
  await cdp.evaluate(`document.querySelector('#promptsPage button[onclick="app.showInjectPromptModal()"]').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(350);
  assert.ok(await cdp.click('#promptsPage button[onclick="app.showInjectPromptModal()"]'),'新建条目');await sleep(400);
  await check(`document.getElementById('injectPromptModal').shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect().width<=650`,'注入弹窗最大宽度');
  await cdp.evaluate(`document.getElementById('injectPromptName').focus()`);await cdp.send('Input.insertText',{text:'Browser test prompt'});
  await cdp.evaluate(`document.getElementById('injectPromptContent').focus()`);await cdp.send('Input.insertText',{text:'Browser test content'});
  assert.ok(await cdp.click('#injectPromptKeyList blora-checkbox'),'选择Key');await check(`document.querySelector('#injectPromptKeyList blora-checkbox').checked`,'复选框选中');
  await shot(`inject-${width}`);
  assert.ok(await cdp.click('#injectPromptModal button[onclick="app.saveInjectPrompt()"]'),'保存条目');await sleep(500);
  await check(`window.__saved.name==='Browser test prompt' && window.__saved.content==='Browser test content' && window.__keyIds.length===1 && window.__keyIds[0]===1`,'内容与Key绑定正确保存');
  await cdp.evaluate(`window.__noKeys=true`);assert.ok(await cdp.click('#promptsPage button[onclick="app.showInjectPromptModal()"]'),'无Key新建');await sleep(300);
  await check(`document.getElementById('injectPromptKeyList').textContent.includes(t('暂无可用 Key，保存后将对所有 Key 全局生效'))`,'无Key提示');
  assert.ok(await cdp.click('#injectPromptModal button[onclick="app.closeModals()"]'),'取消编辑');await sleep(300);
  await cdp.evaluate(`app.navigateTo('modelLibrary')`);await sleep(800);
  await cdp.evaluate(`app.showModelUptimeDetail('gpt-4.1','GPT-4.1')`);await sleep(300);
  await check(`document.getElementById('modelUptimeModal').shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect().width<=730`,'调用状态宽度');
  await shot(`uptime-${width}`);assert.ok(await cdp.click('#modelUptimeModal .modal-close'),'关闭调用状态');await sleep(300);
  await cdp.evaluate(`window.scrollTo(0,0)`);await sleep(300);
  assert.ok(await cdp.click('#libraryKeyChips .model-library-key-item'),'选择Key');await sleep(300);
  if (!await cdp.evaluate(`document.getElementById('libraryKeyBubbleMenu')?.classList.contains('is-open')`)) { assert.ok(await cdp.click('#libraryKeyChips .model-library-key-item'),'打开Key菜单');await sleep(300); }
  await check(`(()=>{const m=document.getElementById('libraryKeyBubbleMenu'),r=m.getBoundingClientRect();return m.classList.contains('is-open')&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&[...m.querySelectorAll('button')].every(b=>b.dataset.variant==='ghost');})()`,'菜单可见且无越界');
  await shot(`key-menu-${width}`);
  assert.ok(await cdp.click('#libraryKeyBubbleMenu button[onclick="app.onLibraryKeyBubbleHarness(\'claude_code\')"]'),'切换工具绑定');
  await check(`app._libraryBindTarget==='claude_code'`,'工具绑定目标同步');
  await cdp.evaluate(`app.closeLibraryKeyBubble();app.showModal('modelTestModal');app._renderTestResults([{ok:false,model:'Embedding test',error:'HTTP 404: '+ 'Long upstream error '.repeat(100)}],1)`);await sleep(300);
  await check(`document.getElementById('modelTestModal').shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect().width<=842`,'模型测试弹窗宽度');
  assert.ok(await cdp.click('#modelTestModal .model-test-row-error-toggle'),'展开测试错误');
  await check(`!document.querySelector('#modelTestModal .model-test-row-error-full').hidden`,'完整错误可见');
  await shot(`model-test-${width}`);
  assert.ok(await cdp.click('#modelTestModal .model-test-row-error-toggle'),'收起测试错误');
  assert.ok(await cdp.click('#modelTestModal .modal-close'),'关闭测试弹窗');await sleep(300);
  console.log(`PASS inject, uptime, key menu, model test ${width}px`);
 }}finally{cdp.ws.close();await fetch(`${debugging}/json/close/${target.id}`);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
