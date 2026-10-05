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



async function main() {
 const debugging = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18572';
 const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18571';
 const target = await fetch(`${debugging}/json/new?about:blank`, {method:'PUT'}).then(r=>r.json());
 const cdp = new CDP(target.webSocketDebuggerUrl);
 const check = async (expression,label) => assert.ok(await cdp.evaluate(expression),label);
  const select = async (id, value) => {
    await cdp.evaluate(`document.getElementById('${id}').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await sleep(300);
    assert.ok(await cdp.click('#' + id), '打开筛选');
    const point = await cdp.evaluate(`(() => {
      const e = [...document.getElementById('${id}').shadowRoot.querySelectorAll('[part="option"]')].find(e => e.dataset.value === '${value}');
      e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(350);
    await check(`document.getElementById('${id}').value === '${value}'`, '选择生效');
  };


 try {
  await cdp.send('Page.enable');
  for (const width of [1440,390]) {
   await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
   await cdp.send('Page.navigate',{url:`${base}/console#auditLogs`});
   for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof app !== 'undefined' && !!app.user && !!document.querySelector('.audit-log-row')`))break;await sleep(100);}
   await check(`document.getElementById('auditLogActionFilter').shadowRoot.querySelector('[part="trigger"]').textContent.includes(t('全部操作'))`,'日志默认标签');
   await check(`!!document.querySelector('.audit-log-action.blora-badge')`,'日志动作徽章');
   await select('auditLogActionFilter','api_key');
   await select('auditLogActionFilter','');
   assert.ok(await cdp.click('#auditLogsPage button[onclick="app.loadAuditLogs(1)"]'),'刷新日志');
   await sleep(500);
   await cdp.evaluate(`document.querySelector('.audit-log-row > div').insertAdjacentHTML('beforeend', '<details><summary>详情</summary><pre>browser log details</pre></details>')`);
   assert.ok(await cdp.click('.audit-log-row summary'),'展开日志详情');
   await check(`!!document.querySelector('.audit-log-row details[open]')`,'日志详情展开');
   await cdp.evaluate(`(() => {
    const original=window.fetch.bind(window);window.__enabled=false;window.__failDetail=false;
    const prompt={fingerprint:'browser-prompt',file:'/project/CLAUDE.md',source:'grok',chars:50,occurrence_count:2,first_seen:'2026-10-01',last_seen:'2026-10-05',preview:'browser prompt'};
    window.fetch=async(url,options={})=>{
     const u=String(url);const json=data=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
     if(u==='/api/user/inject-prompts')return json({items:[{id:1,name:'Browser injection',content:'test content',enabled:window.__enabled,bound_key_ids:[]}]});
     if(u==='/api/user/inject-prompts/1/toggle'){window.__enabled=JSON.parse(options.body).enabled;return json({ok:true});}
     if(u.startsWith('/api/user/custom-instructions?'))return json({items:[prompt],total:1,page:1});
     if(u==='/api/user/custom-instructions/browser-prompt')return window.__failDetail?new Response(JSON.stringify({error:'Test detail failure'}),{status:500}):json({...prompt,content:'browser copy content',positions:['fragment'],recent_refs:[{record_id:1,created_at:'2026-10-05',model_id:'test-model',request_source:'grok'}]});
     return original(url,options);
    };
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text;}}});
   })()`);
   await cdp.evaluate(`app.navigateTo('prompts')`);await sleep(500);
   for(const id of ['promptSourceFilter','promptSortSelect'])await check(`(() => {const e=document.getElementById('${id}');return getComputedStyle(e).borderTopWidth==='0px'&&e.shadowRoot.querySelector('[part="trigger"]').textContent.trim().length>0;})()`,'提示词单层外观及文字');
   await select('promptSourceFilter','grok');await select('promptSortSelect','last_seen');
   assert.ok(await cdp.click('#promptsPage button[onclick="app.loadCustomPrompts(1)"]'),'查询提示词');
   assert.ok(await cdp.click('#promptsPage button[onclick="app.clearPromptFilters()"]'),'清除筛选');
   await check(`document.getElementById('promptSourceFilter').value===''&&document.getElementById('promptSortSelect').value==='count'`,'筛选清除');
   await check(`document.querySelector('#injectPromptsList .blora-badge').textContent.includes(t('已停用'))`,'停用徽章');
   assert.ok(await cdp.click('#injectPromptsList blora-switch'),'启用注入');await sleep(400);
   await check(`window.__enabled && document.querySelector('#injectPromptsList blora-switch').checked`,'注入启用持久读取');
   assert.ok(await cdp.click('#injectPromptsList blora-switch'),'停用注入');await sleep(400);
   await check(`!window.__enabled`,'注入停用');
   await cdp.evaluate(`document.querySelector('#promptsList tr[data-prompt-idx]').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(350);
   assert.ok(await cdp.click('#promptsList tr[data-prompt-idx] td:first-child'),'打开提示词详情');await sleep(500);
   await check(`(() => {const m=document.getElementById('promptDetailModal'),r=m.shadowRoot.querySelector('[part="panel"],.blora-dialog__panel').getBoundingClientRect();return m.hasAttribute('open')&&r.width<=970&&r.left>=0&&r.right<=innerWidth;})()`,'详情宽度约束');
   await check(`document.querySelectorAll('.prompt-refs-table th').length===4&&document.querySelectorAll('.prompt-refs-table tbody tr td').length===4`,'引用表头与内容列对应');
   assert.ok(await cdp.click('#promptDetailContent button[onclick="app.copyPromptContent(this)"]'),'复制内容');
   await check(`window.__copied==='browser copy content'`,'复制完整内容');
   if(process.env.PROMPTS_SCREENSHOT_DIR){const shot=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.PROMPTS_SCREENSHOT_DIR}/prompt-${width}.png`,Buffer.from(shot.data,'base64'));}
   assert.ok(await cdp.click('#promptDetailModal .modal-close'),'关闭详情');await sleep(400);
   await check(`!document.getElementById('promptDetailModal').hasAttribute('open')`,'详情关闭');
   await cdp.evaluate('window.__failDetail=true');
   await cdp.evaluate(`document.querySelector('#promptsList tr[data-prompt-idx]').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(350);
   assert.ok(await cdp.click('#promptsList tr[data-prompt-idx] td:first-child'),'重开详情');await sleep(400);
   await check(`document.getElementById('promptDetailContent').textContent.includes('Test detail failure')`,'详情失败反馈');
   assert.ok(await cdp.click('#promptDetailModal .modal-close'),'关闭错误详情');await sleep(400);
   console.log(`PASS prompts and audit ${width}px`);
  }
 }finally{cdp.ws.close();await fetch(`${debugging}/json/close/${target.id}`);}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
