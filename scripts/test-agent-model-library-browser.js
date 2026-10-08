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
 try{await cdp.send('Page.enable');for(const width of [1440,390]){
 await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/console#bloraAgent/chat`});
 for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof app !== 'undefined'&&!!app.user&&!!window.BloraAgentPage`))break;await sleep(100);}
 await cdp.evaluate(`app.navigateTo('bloraAgent',{agentMode:'chat'})`);await sleep(1500);
 await cdp.evaluate(`BloraAgentPage.models=[{id:'chat-a',name:'Chat Alpha',provider_name:'Provider A'},{id:'chat-b',name:'Chat Beta',provider_name:'Provider B'},{id:'image-a',name:'Image Alpha',output_kind:'image'}];BloraAgentPage.mode='chat';BloraAgentPage.renderModelSelect()`);
 await cdp.evaluate(`document.getElementById('baSystem').focus();document.getElementById('baSystem').select()`);await cdp.send('Input.insertText',{text:'Browser system prompt'});
 await cdp.evaluate(`document.getElementById('baMaxTokens').focus();document.getElementById('baMaxTokens').select()`);await cdp.send('Input.insertText',{text:'8192'});
 await cdp.evaluate(`document.getElementById('baTemperature').focus()`);await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});
 await check(`document.getElementById('baSystem').value==='Browser system prompt'&&document.getElementById('baMaxTokens').value==='8192'&&document.getElementById('baTempVal').textContent===Number(document.getElementById('baTemperature').value).toFixed(1)`,'参数输入与温度显示');
 await check(`(()=>{const a=document.querySelector('.ba-option--temperature > span').getBoundingClientRect(),b=document.querySelector('.ba-option--tokens > span').getBoundingClientRect();return Math.abs(a.top-b.top)<1&&document.getElementById('baChatOptions').scrollWidth<=document.getElementById('baChatOptions').clientWidth;})()`,'参数标签对齐无溢出');
 assert.ok(await cdp.click('#baModelPicker'),'打开模型库');await sleep(350);
 await check(`document.querySelectorAll('.ba-model-card').length===2`,'聊天只显示对话模型');
 await cdp.evaluate(`document.querySelector('[data-model-search]').focus()`);await cdp.send('Input.insertText',{text:'Beta'});
 await check(`document.querySelectorAll('.ba-model-card').length===1`,'搜索过滤');
 assert.ok(await cdp.click('.ba-model-card'),'选择模型');await sleep(350);
 await check(`BloraAgentPage.selectedModel()==='chat-b'&&document.getElementById('baModelPicker').textContent==='Chat Beta'`,'选择同步');
 await cdp.evaluate(`(() => {const original=BloraAgentPage.sendChat;BloraAgentPage.sendChat=async(text,model)=>{window.__sentModel=model;};document.getElementById('baInput').value='Browser test';BloraAgentPage.send();BloraAgentPage.sendChat=original;})()`);await check(`window.__sentModel==='chat-b'`,'聊天发送使用选中模型');
 await cdp.evaluate(`BloraAgentPage.renderModelSelect()`);await check(`BloraAgentPage.selectedModel()==='chat-b'`,'刷新保留选择');
 await cdp.evaluate(`BloraAgentPage.setModel('chat-a')`);await check(`document.getElementById('baModelPicker').textContent==='Chat Alpha'`,'历史模型同步');
 await cdp.evaluate(`BloraAgentPage.mode='imagine';BloraAgentPage.renderModelSelect()`);assert.ok(await cdp.click('#baModelPicker'),'图像模型库');await sleep(300);
 await check(`document.querySelectorAll('.ba-model-card').length===1&&document.querySelector('.ba-model-card').dataset.modelId==='image-a'`,'图像模式过滤');
 await check(`(()=>{const r=BloraAgentPage.modelLibraryDialog.shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()`,'弹窗无越界');
 if(process.env.AGENT_SCREENSHOT_DIR){const r=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.AGENT_SCREENSHOT_DIR}/agent-picker-${width}.png`,Buffer.from(r.data,'base64'));}
 await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(350);await check(`!BloraAgentPage.modelLibraryDialog`,'Escape关闭');
 await cdp.evaluate(`app.navigateTo('bloraAgent',{agentMode:'chat'})`);await sleep(1500);
 await cdp.evaluate(`BloraAgentPage.models=[];BloraAgentPage.renderModelSelect()`);await check(`document.getElementById('baModelPicker').disabled`,'空模型禁用');
 console.log(`PASS agent model library ${width}px`);
 }}finally{cdp.ws.close();await fetch(`${debugging}/json/close/${target.id}`);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
