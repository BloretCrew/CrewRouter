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





async function main(){const debug='http://127.0.0.1:18572',base='http://127.0.0.1:18571';const target=await fetch(`${debug}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());const cdp=new CDP(target.webSocketDebuggerUrl);
try{await cdp.send('Page.enable');for(const width of [1440,390]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/console?teamTest=${width}#modelLibrary`});for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof app !== 'undefined'&&!!app.user`))break;await sleep(100);}
await sleep(1500);await cdp.evaluate(`(()=>{app.user.isAdmin=true;app.instance={edition:'team',capabilities:{teamAdmin:true}};const original=window.fetch.bind(window);window.__teamsEmpty=false;window.__batches=[];window.fetch=async(url,options={})=>{const u=String(url);if(u==='/api/admin/teams')return new Response(JSON.stringify(window.__teamsEmpty?[]:[{id:'one',name:'开发组'},{id:'two',name:'长名称 Team Browser'}]),{status:200});if(u.includes('/models/batch')){window.__batches.push({url:u,...JSON.parse(options.body)});return new Response(JSON.stringify({success:true,modelIds:['m1']}),{status:200});}return original(url,options);};return app.showQuickAddedModelsTeams([{id:'m1',upstream_model_id:'test-model'}]);})()`);await sleep(350);
await cdp.evaluate(`document.querySelector('#quickAddedTeamsList input').focus()`);await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});await sleep(300);assert.ok(await cdp.evaluate(`!document.getElementById('quickAddedTeamsSave').disabled`),'启用提交');assert.ok(await cdp.click('#quickAddedTeamsSave'),'提交授权');await sleep(350);assert.ok(await cdp.evaluate(`window.__batches.length===1&&window.__batches[0].modelIds[0]==='m1'&&document.querySelector('#quickAddedTeamsList blora-checkbox').disabled`),'正确提交与成功禁用');assert.ok(await cdp.click('#quickAddedTeamsSkip'),'完成关闭');await sleep(350);
await cdp.evaluate(`window.__teamsEmpty=true;app.showQuickAddedModelsTeams([{id:'m1'}])`);await sleep(350);assert.ok(await cdp.evaluate(`document.getElementById('quickAddedTeamsSave').disabled`),'空Team状态');assert.ok(await cdp.click('#quickAddedTeamsSkip'),'跳过');await sleep(350);
console.log(`PASS Team picker controls ${width}px`);
}}finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}}
main().catch(e=>{console.error(e);process.exitCode=1;});
