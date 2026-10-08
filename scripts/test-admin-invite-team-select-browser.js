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
try{await cdp.send('Page.enable');for(const width of [1440,390]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/admin?inviteTeam=${width}#adminUsers`});for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof adminApp!=='undefined'&&!!document.getElementById('inviteGenerateBtn')===false`))break;await sleep(100);}await sleep(350);
await cdp.evaluate(`(()=>{const original=window.fetch.bind(window);window.__invitePayload=null;window.__alerts=[];window.alert=m=>window.__alerts.push(m);window.confirm=()=>true;window.fetch=async(url,options={})=>{const u=String(url);if(u==='/api/admin/teams')return new Response(JSON.stringify([{id:7,name:'Browser Team'}]),{status:200});if(u==='/api/auth-invites'&&options.method==='POST'){window.__invitePayload=JSON.parse(options.body);return new Response(JSON.stringify({id:88,url:'https://invite.test/88',max_uses:1,expires_at:'2026-12-01T00:00:00Z'}),{status:200});}return original(url,options);};})()`);
await cdp.evaluate(`adminApp.openInviteDialog()`);await sleep(400);assert.ok(await cdp.evaluate(`document.getElementById('inviteTeamId')&&document.getElementById('inviteTeamId').shadowRoot`),'弹窗打开');assert.ok(await cdp.evaluate(`(()=>{const e=document.getElementById('inviteTeamId');return !e.classList.contains('input')&&getComputedStyle(e).borderTopWidth==='0px'&&e.shadowRoot.querySelector('[part="trigger"]').textContent.includes(t('不指定 Team'));})()`),'默认文字和单层样式');await cdp.evaluate(`document.getElementById('inviteTeamId').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(250);await cdp.click('#inviteTeamId');await cdp.evaluate(`document.getElementById('inviteTeamId').shadowRoot.querySelector('[data-value="7"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);assert.ok(await cdp.evaluate(`document.getElementById('inviteTeamId').value==='7'`),'选择Team');await cdp.click('#inviteGenerateBtn');await sleep(450);assert.ok(await cdp.evaluate(`window.__invitePayload?.teamId==='7'`),'邀请正确绑定Team');assert.ok(await cdp.evaluate(`window.__alerts.some(x=>x.includes('invite.test/88'))`),'生成结果提示');console.log(`PASS invite Team select ${width}px`);
}}finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}}
main().catch(e=>{console.error(e);process.exitCode=1;});
