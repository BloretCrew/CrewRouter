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
 const debugging='http://127.0.0.1:18572',base='http://127.0.0.1:18571';const target=await fetch(`${debugging}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());const cdp=new CDP(target.webSocketDebuggerUrl);
 try{await cdp.send('Page.enable');for(const width of [1440,390]){
 await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/console#settings`});
 for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof app !== 'undefined'&&!!app.user`))break;await sleep(100);}
 await cdp.evaluate(`(()=>{const original=window.fetch.bind(window);window.__notifications=[{id:1,title:'请求异常',body:'HTTP 502: '+ 'long error '.repeat(20),created_at:new Date().toISOString()},{id:2,title:'请求异常',body:'Read notification',created_at:new Date().toISOString(),read_at:'read'}];window.fetch=async(url,options={})=>{const u=String(url);if(u.startsWith('/api/user/notifications')){if(options.method==='PUT')window.__notifications[0].read_at='read';if(options.method==='DELETE')window.__notifications=u==='/api/user/notifications'?[]:window.__notifications.filter(e=>e.id!==2);return new Response(JSON.stringify(options.method?{}:window.__notifications),{status:200});}return original(url,options);};return app.loadNotifications();})()`);
 assert.ok(await cdp.click('.notification-card button[onclick="app.markNotificationRead(1)"]'),'标记已读');
 assert.ok(await cdp.evaluate(`document.querySelectorAll('.notification-card.is-unread').length===0`),'已读状态更新');
 assert.ok(await cdp.click('.notification-card button[onclick="app.deleteNotification(2)"]'),'删除通知');
 assert.ok(await cdp.evaluate(`document.querySelectorAll('.notification-card').length===1`),'删除后列表同步');
 assert.ok(await cdp.evaluate(`(()=>{const e=document.querySelector('.notification-card');return e.scrollWidth<=e.clientWidth&&parseFloat(getComputedStyle(e).borderRadius)>0;})()`),'长内容无溢出圆角卡片');
 assert.ok(await cdp.click('#settingsPage button[onclick="app.clearNotifications()"]'),'清空通知');
 assert.ok(await cdp.evaluate(`document.getElementById('notificationsList').textContent.includes(t('暂无通知'))`),'空状态');
 console.log(`PASS notifications ${width}px`);
 }}finally{cdp.ws.close();await fetch(`${debugging}/json/close/${target.id}`);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
