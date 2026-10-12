#!/usr/bin/env node
'use strict';
// 前置：独立 BLORA_TEST_URL / BLORA_CDP_URL 的 demo 和 Chrome；额度响应使用浏览器内 fixture。
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
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






const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18681';
const debug = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18682';
async function choose(cdp, selector, value) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    await sleep(400);
    const opened = await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).shadowRoot.querySelector('[part="trigger"]').getAttribute('aria-expanded')==='true'`);
    if (!opened) assert.ok(await cdp.click(selector), '打开Blora选择器');
    await sleep(400);
    const point = await cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)});const options=[...e.shadowRoot.querySelectorAll('[part="option"]')];const i=[...e.querySelectorAll('blora-option')].findIndex(o=>o.getAttribute('value')===${JSON.stringify(value)});const o=options[i];if(!o)return null;const r=o.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    assert.ok(point, '找到真实选项');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    await sleep(300);
    if (await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`) === value) return;
  }
  console.error(await cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),o=e.shadowRoot.querySelectorAll('[part="option"]')[1],r=o.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {selector:${JSON.stringify(selector)},rect:r.toJSON(),hit:hit?.outerHTML.slice(0,500),open:e.shadowRoot.querySelector('[part="trigger"]').getAttribute('aria-expanded')};})()`));
  assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), value, '真实选项值');
}

function fixture() {
  const original = window.fetch;
  window.retentionDays=90;window.retentionWrites=[];window.quotaCalls=[]; window.quotaMode='normal';window.quotaSamples=41;
  const rows=[
    {provider_id:'p1',provider_name:'USD provider',account_id:'a1',label:'Account A',kind:'balance',unit:'USD',window_key:'',total:100,used:40,remaining:60,used_percent:null,status:'failed',last_attempt_status:'failed',observed_at:'2026-10-11T08:00:00Z',last_attempt_at:'2026-10-12T08:00:00Z',requests:12,tokens:1200,cost:1.25,stale:true},
    {provider_id:'p2',provider_name:'CNY provider',account_id:'a2',label:'Account B',kind:'balance',unit:'CNY',window_key:'',total:200,used:200,remaining:0,status:'success',observed_at:'2026-10-12T08:00:00Z',requests:4,tokens:100,cost:0.5},
    {provider_id:'p1',provider_name:'USD provider',account_id:'a3',label:'Subscription',kind:'window',unit:'percent',window_key:'5h',total:null,used:null,remaining:null,used_percent:90,status:'partial',observed_at:'2026-10-12T08:00:00Z',resets_at:'2026-10-12T13:00:00Z',requests:12,tokens:1200,cost:1.25}
  ];
  window.fetch=async function(input,options){const url=new URL(typeof input==='string'?input:input.url,location.origin);
    if(url.pathname.endsWith('/retention-config')){if(options?.method==='PUT'){const body=JSON.parse(options.body);window.retentionDays=body.provider_quota_days;window.retentionWrites.push(body);}return Response.json({provider_quota_days:window.retentionDays,compress_days:0,compress_size_gb:0,purge_days:0,purge_size_gb:0,agg_enabled:true});}
    if(url.pathname.endsWith('/stats/multi-dimension')){window.quotaCalls.push(url.pathname+url.search);if(window.quotaMode==='denied')return new Response('{}',{status:403});const quota=url.searchParams.get('data_source')==='quota';const dimensions=url.searchParams.get('dimensions').split(',');return Response.json({data_source:quota?'quota':'association',dimensions,metric:url.searchParams.get('metric'),rows:quota?[{labels:dimensions.map(d=>d==='unit'?'USD':d==='account'?'Account A':d),value:17.25,unit:'USD',quality:{last_event:'reset'}}]:[{labels:dimensions.map(()=> 'Usage'),requests:12,tokens:1200,cost:1}]});}
    if(url.pathname.includes('/stats/provider-quota')){
      window.quotaCalls.push(url.pathname+url.search);
      if(window.quotaMode==='denied')return new Response('{}',{status:403});
      if(window.quotaMode==='error')return new Response('{}',{status:500});
      let filtered=window.quotaMode==='empty'?[]:rows.filter(r=>(!url.searchParams.get('provider_id')||r.provider_id===url.searchParams.get('provider_id'))&&(!url.searchParams.get('account_id')||r.account_id===url.searchParams.get('account_id'))&&(!url.searchParams.get('status')||r.status===url.searchParams.get('status')));
      if(url.pathname.endsWith('/history')){const page=Number(url.searchParams.get('page')||1);return Response.json({rows:filtered,total:window.quotaMode==='empty'?0:window.quotaSamples,page,limit:20});}
      if(url.searchParams.get('status')==='failed')await new Promise(r=>setTimeout(r,350));
      return Response.json({summary:{accounts:filtered.length,success:1,failed:1,stale:1},groups:[{unit:'USD',total:100,used:40,remaining:60,observed_consumption:5},{unit:'CNY',total:200,used:200,remaining:0}],accounts:filtered,usage_trend:[{provider_id:'p1',date:'2026-10-12',requests:12,tokens:1200,cost:1}],trend:filtered.map(r=>({...r,date:'2026-10-12',observed_consumption:5,percent_change:2,sample_count:3,quality:{last_event:'reset'}})),coverage:{started_at:'2026-10-11T08:00:00Z',samples:window.quotaSamples,last_observed_at:'2026-10-12T08:00:00Z',gaps:null,usage_complete:false}});
    }
    if(url.pathname.endsWith('/providers/quota/refresh')){window.quotaSamples++;return Response.json({providers:[{id:'p1',name:'USD provider',error:'failed',quota:{total:100,used:40,remaining:60},checked_at:'2026-10-11T08:00:00Z'}]});}
    if(url.pathname.includes('/providers/')&&url.pathname.endsWith('/check-quota'))return new Response(JSON.stringify({error:'Fixture failure'}),{status:500});
    return original.call(this,input,options);
  };
}
async function main(){
 const target=await fetch(`${debug}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());const cdp=new CDP(target.webSocketDebuggerUrl);
 try{await cdp.send('Page.enable');await cdp.send('Runtime.enable');
 for(const scope of (process.env.QUOTA_TEST_SCOPE ? [process.env.QUOTA_TEST_SCOPE] : ['admin','user']))for(const width of (process.env.QUOTA_TEST_WIDTH ? [Number(process.env.QUOTA_TEST_WIDTH)] : [1440,390])){
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
  await cdp.send('Page.navigate',{url:`${base}/${scope==='admin'?'admin':'console'}?quotaUI=${width}`});await sleep(1500);
  for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof ${scope==='admin'?'adminApp':'app'}!=='undefined' && !!window.CrewRouterQuotaStats`))break;await sleep(100);}
  await cdp.evaluate(`(${fixture.toString()})()`);
  const app=scope==='admin'?'adminApp':'app';
  await cdp.evaluate(`(async () => { await ${app}.navigateTo('${scope==='admin'?'adminStats':'stats'}');${app}.switchStatsTab('overview');CrewRouterQuotaStats.refresh('${scope}'); })()`);await sleep(500);
  const root=`[data-quota-scope="${scope}"][data-quota-context="overview"]`;
  await choose(cdp,scope==='admin'?'#adminStatsDays':'#statsTimeRange','7');await sleep(450);
  assert.ok(await cdp.evaluate(`quotaCalls.some(u=>u.includes('days=7'))`),'日期联动额度查询');
  assert.ok(await cdp.evaluate(`document.querySelector('${root} .quota-accounts').textContent.includes('60')`),'失败保留60有效值');
  assert.ok(await cdp.evaluate(`document.querySelector('${root} .quota-accounts').textContent.includes('未知')`),'null保留未知');
  assert.ok(await cdp.evaluate(`document.querySelector('${root} .quota-summary').textContent.includes('CNY') && document.querySelector('${root} .quota-summary').textContent.includes('USD')`),'币种分组');
  await choose(cdp,root+' [name="provider_id"]','p1');assert.ok(await cdp.click(root+' [data-quota-action="apply"]'));await sleep(350);
  assert.ok(await cdp.evaluate(`quotaCalls.some(u=>u.includes('provider_id=p1'))`),'供应商真实请求筛选');
  await choose(cdp,root+' [name="account_id"]','a1');assert.ok(await cdp.click(root+' [data-quota-action="apply"]'));await sleep(350);
  assert.ok(await cdp.evaluate(`document.querySelectorAll('${root} .quota-accounts tbody tr').length===1`),'账户真实筛选');
  assert.ok(await cdp.click(root+' [data-quota-action="history"]'));await sleep(350);
  assert.ok(await cdp.click(root+' [data-quota-action="next"]'));await sleep(350);
  assert.ok(await cdp.evaluate(`quotaCalls.some(u=>u.includes('/history?')&&u.includes('page=2')&&u.includes('account_id=a1'))`),'服务端历史分页');
  assert.ok(await cdp.click(root+' [data-quota-action="prev"]'));assert.ok(await cdp.click(root+' [data-quota-action="reset"]'));await sleep(400);
  await choose(cdp,root+' [name="trend_metric"]','used_percent');assert.ok(await cdp.evaluate(`document.querySelector('${root} [name="trend_metric"]').value==='used_percent'`),'切换窗口趋势');
  await choose(cdp,root+' [name="status"]','failed');await cdp.click(root+' [data-quota-action="apply"]');await choose(cdp,root+' [name="status"]','success');await cdp.click(root+' [data-quota-action="apply"]');await sleep(600);
  assert.ok(await cdp.evaluate(`!document.querySelector('${root} .quota-accounts').textContent.includes('Account A')`),'快速切换丢弃旧响应');
  await cdp.click(root+' [data-quota-action="reset"]');await sleep(350);
  await cdp.evaluate(`${app}.switchStatsTab('multi')`);await sleep(500);
  const multi=scope==='admin'?'#adminMultiDimension':'#userMultiDimension';
  await choose(cdp,multi+' [name="data_source"]','quota');await sleep(350);
  for(const metric of ['remaining','used','total','used_percent','observed_consumption','percent_change']){
    await choose(cdp,multi+' [name="quota_metric"]',metric);await sleep(250);
    assert.ok(await cdp.evaluate(`quotaCalls.some(u=>u.includes('/multi-dimension?')&&u.includes('data_source=quota')&&u.includes('metric=${metric}'))`),'真实额度指标请求 '+metric);
    assert.ok(await cdp.evaluate(`document.querySelector('${scope==='admin'?'#adminMultiDimensionResult':'#userMultiDimensionResult'}').textContent.includes('17.25')`),'渲染row.value');
  }
  for(const dimension of ['kind','unit','window','date']){
    const selector=multi+' .quota-dimension-choices blora-checkbox[value="'+dimension+'"]';
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await sleep(350);
    for(let attempt=0;attempt<3;attempt++){
      if(await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).hasAttribute('checked')`))break;
      const point=await cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)}),input=e.querySelector('input')||e.shadowRoot?.querySelector('input')||e,r=input.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await sleep(350);
    }
    assert.ok(await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).hasAttribute('checked')`),'实际勾选 '+dimension);
  }
  assert.ok(await cdp.evaluate(`quotaCalls.some(u=>new URL(u,location.origin).searchParams.get('dimensions')==='provider,account,kind,unit,window,date')`),'六种额度维度真实请求');
  await choose(cdp,'[data-quota-context="multi"] [name="trend_metric"]','observed_consumption');
  assert.ok(await cdp.evaluate(`document.querySelectorAll('[data-quota-context="multi"] .quota-trend canvas').length===3`),'额度按USD/CNY/percent独立canvas');
  await choose(cdp,'[data-quota-context="multi"] [name="trend_metric"]','requests');
  assert.ok(await cdp.evaluate(`document.querySelector('[data-quota-context="multi"] .quota-events').textContent.includes('周期重置')`),'观测变化及重置事件');

  await choose(cdp,'[data-quota-context="multi"] [name="provider_id"]','p1');
  await choose(cdp,'[data-quota-context="multi"] [name="account_id"]','a1');
  const queryBefore = await cdp.evaluate('quotaCalls.length');
  assert.ok(await cdp.click('[data-quota-context="multi"] [data-quota-action="apply"]'));await sleep(450);
  assert.ok(await cdp.evaluate(`quotaCalls.slice(${queryBefore}).some(u=>u.includes('/multi-dimension?')&&u.includes('data_source=quota')&&u.includes('provider_id=p1')&&u.includes('account_id=a1'))`),'额度查询同步多维供应商账户筛选');
  await cdp.evaluate(`quotaMode='denied';CrewRouterQuotaStats.refresh('${scope}');CrewRouterMultiDimension.load('${scope}')`);await sleep(450);
  assert.ok(await cdp.evaluate(`document.querySelector('${scope==='admin'?'#adminMultiDimensionResult':'#userMultiDimensionResult'}').textContent===''&&!document.querySelector('${scope==='admin'?'#adminMultiDimensionResult':'#userMultiDimensionResult'} canvas')`),'403清空多维结果与图表');
  assert.ok(await cdp.evaluate(`['overview','multi'].every(context=>{const root=document.querySelector('[data-quota-context="'+context+'"]');return root.querySelector('.quota-events').textContent===''&&root.querySelector('.quota-trend').childElementCount===0&&![...root.querySelectorAll('[name="provider_id"] blora-option,[name="account_id"] blora-option')].some(o=>o.textContent.includes('Account A')||o.textContent.includes('USD provider'));})`),'403清空事件趋势和撤权账户供应商标签');
  await cdp.evaluate(`quotaMode='normal';CrewRouterQuotaStats.refresh('${scope}')`);await sleep(350);
  await choose(cdp,multi+' [name="data_source"]','related');await sleep(500);
  assert.ok(await cdp.evaluate(`quotaCalls.some(u=>u.includes('/multi-dimension?')&&u.includes('data_source=association'))`),'关联模式真实请求');
  if(scope==='admin'){
    assert.ok(await cdp.evaluate(`adminApp._multiStatsParams().get('data_source')==='association'`),'固定组合关联模式');
    await cdp.evaluate(`document.getElementById('multiStatsModel').innerHTML='<blora-option value="">All</blora-option><blora-option value="m1">Model</blora-option>';document.getElementById('multiStatsModel').value='m1';CrewRouterQuotaStats.refresh('admin')`);await sleep(350);
    await cdp.click('[data-quota-context="multi"] .quota-history summary');await sleep(350);
    assert.ok(await cdp.evaluate(`quotaCalls.filter(u=>u.includes('/history?')).every(u=>!u.includes('model_id=')&&!u.includes('user_id=')&&!u.includes('request_source='))`),'历史剥离贡献筛选');
    await cdp.evaluate(`document.getElementById('multiStatsModel').value=''`);
  }

  if(scope==='user'){
    await cdp.evaluate(`(async () => { await app.navigateTo('modelLibrary');app.renderProviderQuota([{id:'p1',name:'USD provider',error:'failed',quota:{total:100,used:40,remaining:60},checked_at:'2026-10-11T08:00:00Z'}]); })()`);await sleep(500);
    assert.ok(await cdp.evaluate(`document.querySelector('#providerQuotaGrid').textContent.includes('60')&&document.querySelector('#providerQuotaGrid').textContent.includes('最近查询失败')`),'模型库有效值/失败状态');
    await cdp.evaluate(`app.renderProviderQuota([{id:'p1',name:'Partial provider',status:'partial',coverage:{successful:1,total:2},history:{recorded:false},last_valid_at:'2026-10-10T08:00:00Z',checked_at:'2026-10-12T08:00:00Z',quota:{currentPercent:null,total:null,used:null,remaining:null},keys:[{ok:false,label:'Retained key',quota:{currentPercent:null,total:100,used:null,remaining:33}},{ok:true,label:'Live key',quota:{currentPercent:null,total:null,used:null,remaining:null}}]}])`);await sleep(350);
    assert.ok(await cdp.evaluate(`document.getElementById('providerQuotaGrid').textContent.includes('33')&&document.getElementById('providerQuotaGrid').textContent.includes('1/2')&&document.getElementById('providerQuotaGrid').textContent.includes('本次查询未保存')&&!document.getElementById('providerQuotaGrid').textContent.includes('已用 0%')`),'部分覆盖/失败key有效额度/null未知/记录失败');
    const samplesBefore = await cdp.evaluate('quotaSamples');
    assert.ok(await cdp.click('#providerQuotaRefreshBtn'));await sleep(450);
    const samplesAfter = await cdp.evaluate('quotaSamples');
    assert.equal(samplesAfter, samplesBefore + 1, '手动刷新新增一个查询样本');
    assert.ok(await cdp.click('#providerQuotaGrid [data-quota-provider="p1"]'));await sleep(400);
    assert.ok(await cdp.evaluate(`document.querySelector('#quotaHistoryDialog .quota-page').textContent.includes('${samplesAfter}')`),'刷新后历史样本一致');
  }else{
    await cdp.evaluate(`adminApp.checkProviderQuota('p1')`);await sleep(450);
    assert.ok(await cdp.evaluate(`document.querySelector('#quotaLatestObservation').textContent.includes('60')`),'供应商失败详情保留有效值');
    assert.ok(await cdp.click('#providerQuotaModal button[onclick*="CrewRouterQuotaStats.open"]'));await sleep(400);
  }
  assert.ok(await cdp.evaluate(`!!document.querySelector('#quotaHistoryDialog[open]')`),'详情打开历史');
  assert.ok(await cdp.click('#quotaHistoryDialog .modal-close'));await sleep(350);
  await cdp.evaluate(`${app}.closeModals();${app}.navigateTo('${scope==='admin'?'adminStats':'stats'}');${app}.switchStatsTab('overview')`);await sleep(400);
  await cdp.evaluate(`quotaMode='empty';CrewRouterQuotaStats.refresh('${scope}')`);await sleep(350);
  assert.ok(await cdp.evaluate(`document.querySelector('${root} .quota-status').textContent.includes('暂无可见')`),'空历史');
  await cdp.evaluate(`quotaMode='denied';CrewRouterQuotaStats.refresh('${scope}')`);await sleep(350);
  assert.ok(await cdp.evaluate(`document.querySelector('${root} .quota-status').textContent.includes('无权')&&document.querySelector('${root} .quota-accounts').textContent===''`),'权限撤回清空数据');
  await cdp.evaluate(`quotaMode='error';CrewRouterQuotaStats.refresh('${scope}')`);await sleep(350);
  assert.ok(await cdp.evaluate(`document.querySelector('${root} .quota-status').textContent.includes('重试')`),'网络错误重试说明');
  await cdp.evaluate(`quotaMode='normal'`);await cdp.click(root+' [data-quota-action="apply"]');await sleep(400);
  assert.ok(await cdp.evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'无页面横向溢出');
  if(process.env.QUOTA_SCREENSHOT_DIR){const fs=require('node:fs');fs.mkdirSync(process.env.QUOTA_SCREENSHOT_DIR,{recursive:true});const image=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(`${process.env.QUOTA_SCREENSHOT_DIR}/${scope}-${width}.png`,Buffer.from(image.data,'base64'));}
  if(scope==='admin'){
    await cdp.evaluate(`adminApp.navigateTo('adminSettings')`);await sleep(500);assert.ok(await cdp.click('[data-admin-settings-category="retention"]'));
    for(const days of [0,90]){
      await cdp.evaluate(`document.getElementById('retentionProviderQuotaDays').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(250);
      assert.ok(await cdp.click('#retentionProviderQuotaDays'));
      await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});await cdp.send('Input.insertText',{text:String(days)});
      assert.ok(await cdp.click('#retentionSaveBtn'));await sleep(350);
      assert.ok(await cdp.evaluate(`retentionWrites.some(r=>r.provider_quota_days===${days})`),'真实输入保存 '+days);
      await cdp.evaluate(`adminApp.navigateTo('adminStats')`);await sleep(150);await cdp.evaluate(`adminApp.navigateTo('adminSettings')`);await sleep(450);assert.ok(await cdp.click('[data-admin-settings-category="retention"]'));
      assert.equal(await cdp.evaluate(`document.getElementById('retentionProviderQuotaDays').value`),String(days),'设置重开读取 '+days);
    }
  }
  const exceptions=cdp.events.filter(e=>e.method==='Runtime.exceptionThrown');assert.equal(exceptions.length,0,'无未捕获异常');
  console.log(`PASS quota UI ${scope} ${width}px: six quota dimensions/metrics, association, unit facets, usage trend, events, history filters, retention 0/90, partial/null/history status, pagination, race, overflow`);
 }
 }finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
