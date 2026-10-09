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
try{await cdp.send('Page.enable');for(const width of [1440,390]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/admin?userTeamTest=${width}#adminUsers`});for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof adminApp !== 'undefined'&&!!adminApp.user`))break;await sleep(100);}await cdp.evaluate(`adminApp.loadUsers()`);for(let i=0;i<100;i++){if(await cdp.evaluate(`!!document.querySelector('button[onclick*="editUserById"]')`))break;await sleep(100);}await sleep(200);
const button='button[onclick*="editUserById"]';await cdp.evaluate(`document.querySelector('${button}').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(350);assert.ok(await cdp.click(button),'编辑用户');await sleep(350);assert.ok(await cdp.evaluate(`document.getElementById('editUserModal').hasAttribute('open')`),'用户弹窗');assert.ok(await cdp.click('#editUserModal .modal-close'),'取消编辑');await sleep(350);
await cdp.evaluate(`(()=>{const original=window.fetch.bind(window);window.fetch=async(url,options)=>String(url)==='/api/admin/teams'?new Response(JSON.stringify([{id:1,name:'Browser Team',description:'Long description '.repeat(10),member_count:2,created_at:'2026-01-01',is_personal:false}]),{status:200}):original(url,options);adminApp.navigateTo('adminTeams');})()`);await sleep(800);assert.ok(await cdp.evaluate(`[...document.querySelectorAll('.team-card')].every(e=>getComputedStyle(e).display==='flex'&&e.scrollWidth<=e.clientWidth)`),'Team卡片无溢出');
const manage='.team-card button[onclick*="showTeamDetail"]';await cdp.evaluate(`document.querySelector('${manage}').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(350);assert.ok(await cdp.click(manage),'管理Team');await sleep(500);assert.ok(await cdp.evaluate(`!!adminApp.currentTeamId`),'Team详情状态');
console.log(`PASS admin users and teams ${width}px`);
}}finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}}
main().catch(e=>{console.error(e);process.exitCode=1;});
