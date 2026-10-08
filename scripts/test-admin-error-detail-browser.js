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
try{await cdp.send('Page.enable');for(const width of [1440,390]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/admin?errorDialog=${width}#adminErrorLogs`});for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof adminApp !== 'undefined'`))break;await sleep(100);}
await cdp.evaluate(`(()=>{adminApp._errorLogCache=[{created_at:'2026-10-08T16:12:58Z',username:'Browser User',model_name:'gpt-6.1-sol',series:'-',upstream_model_id:'gpt-6.1-sol',provider_name:'GPT Pro',request_type:'chat',status_code:502,error_type:'server_error',is_final:true,latency_ms:1845,ip_address:'192.0.2.1',key_prefix:'sk-test',key_name:'fixture',error_message:'upstream_error',error_body:JSON.stringify({error:{message:'fixture error'},long:'x'.repeat(1000)},null,2)}];adminApp.showErrorDetail(0)})()`);await sleep(300);
assert.ok(await cdp.evaluate(`(()=>{const p=document.getElementById('errorDetailModal').shadowRoot.querySelector('.blora-dialog__panel').getBoundingClientRect();return p.width<=1050&&p.left>=0&&p.right<=innerWidth;})()`),'详情弹窗宽度');assert.ok(await cdp.evaluate(`document.querySelectorAll('#errorDetailContent .error-detail-row').length===13&&document.querySelector('#errorDetailContent .error-detail-pre--body').textContent.includes('fixture error')&&document.querySelector('#errorDetailContent .error-detail-pre--body').scrollWidth<=document.querySelector('#errorDetailContent .error-detail-pre--body').clientWidth`),'字段、原始响应及长文本');if(process.env.ERROR_DETAIL_SCREENSHOT_DIR){const r=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.ERROR_DETAIL_SCREENSHOT_DIR}/error-detail-${width}.png`,Buffer.from(r.data,'base64'));}
assert.ok(await cdp.click('#errorDetailContent [role="tab"][aria-controls="errorDetailPage-error"]'),'切换错误信息页');assert.ok(await cdp.evaluate(`document.getElementById('errorDetailPage-error').hidden===false&&document.getElementById('errorDetailPage-overview').hidden===true`),'错误信息页激活');assert.ok(await cdp.click('#errorDetailContent [role="tab"][aria-controls="errorDetailPage-response"]'),'切换原始响应页');assert.ok(await cdp.evaluate(`document.getElementById('errorDetailPage-response').hidden===false&&document.getElementById('errorDetailPage-error').hidden===true`),'原始响应页激活');assert.ok(await cdp.click('#errorDetailPrevious'),'上一页');assert.ok(await cdp.evaluate(`document.getElementById('errorDetailPage-error').hidden===false`),'分页按钮切换');
assert.ok(await cdp.click('#errorDetailModal .modal-close'),'关闭详情');await sleep(300);assert.ok(await cdp.evaluate(`!document.getElementById('errorDetailModal').hasAttribute('open')`),'关闭完成');console.log(`PASS error detail ${width}px`);
}}finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}}
main().catch(e=>{console.error(e);process.exitCode=1;});
