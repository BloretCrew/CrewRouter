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






const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18881';
const debug = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18882';
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
  window.layoutCalls = [];
  window.chartInstances = [];
  const OriginalChart = window.Chart;
  window.Chart = class extends OriginalChart { constructor(canvas, config) { super(canvas, config); window.chartInstances.push({ target: canvas.closest('[id$="MultiDimensionResult"]')?.id, config }); } };
  window.layoutMode = 'normal';
  const records = [
    { provider_id:'p1',provider_name:'Command Code GOAT',account_id:'a1',label:'订阅账户',kind:'window',unit:'percent',window_key:'monthly',total:null,used:null,remaining:null,used_percent:89.2059,status:'success',observed_at:'2026-10-12T10:36:04Z',checked_at:'2026-10-12T10:36:04Z',resets_at:'2026-10-17T00:31:57Z',requests:4804,tokens:595815929,cost:4 },
    { provider_id:'p1',provider_name:'Command Code GOAT',account_id:'a1',label:'订阅账户',kind:'balance',unit:'USD',window_key:'',total:200,used:50,remaining:150,status:'success',observed_at:'2026-10-12T10:36:04Z',requests:4804,tokens:595815929,cost:4 },
    { provider_id:'p1',provider_name:'Command Code GOAT',account_id:'a1',label:'订阅账户',kind:'window',unit:'percent',window_key:'weekly',used_percent:9.3395,status:'success',observed_at:'2026-10-12T10:36:04Z',requests:4804,tokens:595815929,cost:4 },
    { provider_id:'p2',provider_name:'AnyRouter',account_id:'a2',label:'Key 1',kind:'balance',unit:'USD',window_key:'',total:100000000,used:2498.7845,remaining:99997501.2155,status:'failed',last_attempt_status:'failed',stale:true,observed_at:'2026-10-12T10:07:40Z',checked_at:'2026-10-12T10:37:40Z',requests:30716,tokens:524589539,cost:1 },
    { provider_id:'p3',provider_name:'Claude Pro',account_id:'a3',label:'订阅账户',kind:'window',unit:'percent',window_key:'five_hour',used_percent:44,observed_at:'2026-10-12T10:06:46Z',status:'partial',resets_at:'2026-10-12T10:59:59Z' },
    ...Array.from({length:6},(_,i)=>({provider_id:'extra'+i,provider_name:'供应商 '+(i+4),account_id:'extra'+i,label:'Key 1',kind:'window',unit:'percent',window_key:'seven_day',used_percent:i*10,status:'success',observed_at:'2026-10-12T10:06:46Z'}))
  ];
  window.fetch = async function(input,options) {
    const url = new URL(typeof input==='string'?input:input.url, location.origin);
    if (url.pathname.endsWith('/providers/quota')) return Response.json({providers:[{id:'p1',name:'Command Code GOAT',quota:{unit:'percent',periods:[{key:'monthly',label:'每月',percent:89.2059}]}}]});
    if (url.pathname.includes('/stats/multi-dimension')) {
      window.layoutCalls.push(url.pathname+url.search);
      if(window.layoutMode==='denied')return new Response('{}',{status:403});
      const dims=(url.searchParams.get('dimensions')||'').split(',');
      const quota=url.searchParams.get('data_source')==='quota';
      if(url.searchParams.get('quota_mode')==='member_estimate') { window.quotaModeGateEntered=true; await window.__quotaModeRequest; await new Promise(resolve => setTimeout(resolve,350)); }
      const valid=quota?['provider','account','kind','unit','window','date']:['user','team','project','source','model','provider','key'];
      if(new Set(dims).size!==dims.length||dims.some(d=>!valid.includes(d)))return Response.json({error:'请选择有效且不同的维度'},{status:400});
      return Response.json({data_source:quota?'quota':url.searchParams.get('data_source'),dimensions:dims,metric:url.searchParams.get('metric'),rows:quota?[{labels:dims.map(d=>d==='provider'?'Command Code GOAT':d==='window'?'monthly':d==='kind'?'window':'订阅账户'),value:89.2059,unit:'percent',kind:'window',account_id:'a1'}]:[{labels:dims.map(d=>d==='user'?'Alice':d==='source'?'codex':'测试模型'),values:dims.map(d=>d==='user'?'1':d==='provider'?'p1':d==='source'?'codex':'测试模型'),requests:4804,tokens:595815929,cost:4},{labels:dims.map(d=>d==='user'?'Bob':d==='source'?'claude_code':'模型二'),values:dims.map(d=>d==='user'?'2':d==='provider'?'p1':d==='source'?'claude_code':'模型二'),requests:2400,tokens:200000000,cost:2}],...(url.searchParams.get('include_quota')==='true'?{provider_quota:{accounts:records.filter(r=>r.requests>0)}}:{}),...(url.searchParams.get('quota_mode')==='member_estimate'?{quota_mode:'member_estimate',quota_estimates:[{user_id:'1',user_name:'Alice',category_dimensions:['user'],category_values:['1'],category_labels:['Alice'],provider_id:'p1',provider_name:'Command Code GOAT',kind:'balance',unit:'USD',estimated_value:40,estimated_percent:40},{user_id:'2',user_name:'Bob',category_dimensions:['user'],category_values:['2'],category_labels:['Bob'],provider_id:'p1',provider_name:'Command Code GOAT',kind:'balance',unit:'USD',estimated_value:10,estimated_percent:10}]}:{})});
    }
    if(url.pathname.includes('/stats/provider-quota')) {
      window.layoutCalls.push(url.pathname+url.search);
      if(window.layoutMode==='denied')return new Response('{}',{status:403});
      if(window.layoutMode==='error')return new Response('{}',{status:500});
      const rows=window.layoutMode==='empty'?[]:records.filter(r=>(!url.searchParams.get('provider_id')||r.provider_id===url.searchParams.get('provider_id'))&&(!url.searchParams.get('account_id')||r.account_id===url.searchParams.get('account_id')));
      if (url.pathname.endsWith('/history')) {
        const historyRows = [{ ...records[0], provider_name: 'Command Code GOAT', checked_at: '2026-10-10T10:00:00Z', used_percent: 22 }, { ...records[0], provider_name: 'Command Code GOAT', checked_at: '2026-10-11T10:00:00Z', used_percent: 47 }, { ...records[1], provider_name: 'Command Code GOAT', checked_at: '2026-10-12T10:00:00Z', remaining: 150, total: 200, status: 'success' }];
        return Response.json({ rows: historyRows, total: historyRows.length, page: 1, limit: 20 });
      }
      return Response.json({summary:{providers:9,accounts:9,success:7,low:1,failed:1,stale:1},accounts:rows,groups:[],trend:rows.map(r=>({...r,date:'2026-10-12',sample_count:2,observed_consumption:r.kind==='balance'?5:null,quality:{last_event:'initial'}})),usage_trend:[{provider_id:'p1',date:'2026-10-12',requests:4804,tokens:595815929,cost:4}],coverage:{started_at:'2026-10-12T10:06:46Z',last_observed_at:'2026-10-12T10:36:04Z',samples:20,usage_complete:false}});
    }
    return original.call(this,input,options);
  };
}
async function waitFor(cdp, expression, description) {
  for(let i=0;i<80;i++){if(await cdp.evaluate(expression))return;await sleep(100);}
  assert.fail(description);
}
async function chooseSource(cdp, multi, source) {
  const selector = multi+' [data-quota-dimension]';
  if(source==='related') { await cdp.evaluate(`document.querySelector('${multi} [name="data_source"]').value='related';document.querySelector('${multi} [name="data_source"]').dispatchEvent(new Event('change',{bubbles:true}))`);return; }
  const wanted=source==='quota';
  await cdp.evaluate(`document.querySelector('${selector}').scrollIntoView({block:'center',behavior:'instant'})`);await sleep(200);
  if(await cdp.evaluate(`document.querySelector('${selector}').checked`)!==wanted){
    const point=await cdp.evaluate(`(()=>{const r=document.querySelector('${selector} input[type="checkbox"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});await sleep(200);
  }
  assert.equal(await cdp.evaluate(`document.querySelector('${selector}').checked`),wanted,'供应商额度维度勾选状态');
}
async function main(){
  for(const scope of ['user','admin']) for(const width of [1440,390]){
    const target=await fetch(`${debug}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());const cdp=new CDP(target.webSocketDebuggerUrl);
    try{
      await cdp.send('Page.enable');await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
      await cdp.send('Page.navigate',{url:`${base}/${scope==='user'?'console':'admin'}?layout=${width}`});
      const app=scope==='user'?'app':'adminApp';
      await waitFor(cdp,`typeof ${app}!=='undefined'&&!!window.CrewRouterQuotaStats&&!!window.CrewRouterMultiDimension`,'页面初始化');
      await cdp.evaluate(`(${fixture.toString()})();${app}.navigateTo('${scope==='user'?'stats':'adminStats'}');${app}.switchStatsTab('overview');CrewRouterQuotaStats.refresh('${scope}')`);
      const root=`[data-quota-scope="${scope}"][data-quota-context="overview"]`;
      await waitFor(cdp,`document.querySelector('${root} .quota-accounts')?.textContent.includes('Command Code GOAT')`,'概览供应商摘要');
      assert.equal(await cdp.evaluate(`document.querySelectorAll('${root} table').length`),0,'总览没有原始大表');
      assert.equal(await cdp.evaluate(`document.querySelectorAll('${root} canvas').length`),0,'趋势按需加载');
      assert.ok(await cdp.evaluate(`!document.querySelector('${root}').textContent.includes('89.2059')&&!document.querySelector('${root}').textContent.includes('window')&&!document.querySelector('${root}').textContent.includes('percent')`),'百分比整数与中文类型');
      assert.ok(await cdp.evaluate(`document.querySelector('${root}').textContent.includes('89%')&&document.querySelector('${root}').textContent.includes('每月')`),'窗口按适用指标展示');
      assert.ok(await cdp.evaluate(`document.querySelector('${root}').textContent.includes('99,997,501.22')`),'金额最多两位');
      assert.ok(await cdp.evaluate(`document.querySelector('${root}').getBoundingClientRect().height<1100`),'总览默认高度受控');
      assert.ok(await cdp.click(root+' [data-quota-action="more"]'),'展开更多供应商');await sleep(150);
      assert.ok(await cdp.click(root+' .quota-trend-details > summary'),'展开趋势');await sleep(250);
      assert.ok(await cdp.evaluate(`document.querySelectorAll('${root} canvas').length>0`),'展开才绘图');
      assert.ok(await cdp.click(root+' .quota-trend-details > summary'),'折叠趋势');
      await cdp.evaluate(`${app}.switchStatsTab('multi')`);await sleep(300);
      const multi=scope==='user'?'#userMultiDimension':'#adminMultiDimension';
      const panel=`[data-quota-scope="${scope}"][data-quota-context="multi"]`;
      assert.ok(await cdp.evaluate(`document.querySelector('${panel}').hidden`),'请求分析隐藏额度上下文');
      assert.ok(await cdp.evaluate(`document.querySelector('${multi}').contains(document.querySelector('${panel}'))`),'额度上下文位于维度分析面板内');
      const sourceSelector = multi+' .multi-dimension-choices:not(.quota-dimension-choices) blora-checkbox[value="source"]';
      await cdp.evaluate(`document.querySelector(${JSON.stringify(sourceSelector)}).scrollIntoView({block:'center',behavior:'instant'})`);await sleep(200);
      const sourcePoint = await cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(sourceSelector)});const control=e.querySelector('input[type="checkbox"]');const r=control.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...sourcePoint});
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...sourcePoint});await sleep(150);
      await choose(cdp,multi+' [name="metric"]','tokens');await sleep(250);
      assert.ok(await cdp.evaluate(`layoutCalls.some(s=>{const u=new URL(s,location.origin);return u.pathname.endsWith('/multi-dimension')&&u.searchParams.get('dimensions')==='source,model'&&u.searchParams.get('metric')==='tokens'})`),'客户端和模型只发送有效请求维度');
      assert.ok(await cdp.evaluate(`!document.querySelector('${multi} .multi-dimension-status').textContent.includes('有效且不同')`),'截图组合正常生成');
      await chooseSource(cdp,multi,'quota');await sleep(250);
      assert.ok(await cdp.evaluate(`document.querySelector('${multi} [name="metric"]').value==='tokens'&&!document.querySelector('${multi} [data-dimension-group="usage"]').hidden&&document.querySelector('${multi} [data-dimension-group="quota"]').hidden`),'勾额度保持请求维度和指标');
      assert.ok(await cdp.evaluate(`layoutCalls.some(s=>{const u=new URL(s,location.origin);return u.pathname.endsWith('/multi-dimension')&&u.searchParams.get('dimensions')==='source,model'&&u.searchParams.get('metric')==='tokens'&&u.searchParams.get('include_quota')==='true'&&u.searchParams.get('data_source')==='usage'})`),'额度仅附加信息');
      assert.ok(await cdp.evaluate(`document.querySelector('#${scope==='user'?'user':'admin'}MultiDimensionResult canvas')`),'请求与额度在同一结果图表绘制');
      assert.ok(await cdp.evaluate(`document.querySelector('#${scope==='user'?'user':'admin'}MultiDimensionResult canvas')?.getAttribute('aria-label').includes('Codex / 测试模型')`),'同一图表标注请求维度类别');
      assert.ok(await cdp.evaluate(`(()=>{const d=chartInstances.filter(x=>x.target==='${scope==='user'?'user':'admin'}MultiDimensionResult').at(-1)?.config.data;return d?.datasets[1].label.includes('Command Code GOAT')&&d.datasets[2].label.includes('Command Code GOAT');})()`),'同一多维图例标注供应商额度账户');
      await chooseSource(cdp,multi,'requests');await sleep(250);
      assert.ok(await cdp.evaluate(`document.querySelector('${multi} [name="metric"]').value==='tokens'&&document.querySelector('${panel}').hidden`),'取消只移除额度');
      if(process.env.QUOTA_ENTRY_ONLY==='1') {
        assert.ok(await cdp.evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'维度行无横向溢出');
        assert.equal(cdp.events.filter(e=>e.method==='Runtime.exceptionThrown').length,0);
        console.log(`PASS additive quota ${scope} ${width}: dimensions and metric unchanged, quota context added/removed, responsive`);
        continue;
      }
      if (scope === 'admin') {
        const userCheckbox = multi+' .multi-dimension-choices:not(.quota-dimension-choices) blora-checkbox[value="user"]';
        await cdp.evaluate(`document.querySelector(${JSON.stringify(userCheckbox)}).scrollIntoView({block:'center',behavior:'instant'})`);await sleep(150);
        const userPoint=await cdp.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(userCheckbox)}).querySelector('input[type="checkbox"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
        await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...userPoint});
        await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...userPoint});await sleep(200);
      }
      await chooseSource(cdp,multi,'quota');await sleep(250);
      const quotaMode = multi+' [name="quota_mode"]';
      if (scope === 'admin') {
        const modeState = await cdp.evaluate(`(()=>({toggle:document.querySelector('${multi} [data-quota-dimension]').checked,user:document.querySelector('${multi} .multi-dimension-choices:not(.quota-dimension-choices) [value="user"]').checked,modeHidden:document.querySelector('${quotaMode}').closest('label').hidden}))()`);
        assert.ok(!modeState.modeHidden,`成员维度显示额度模式选项：${JSON.stringify(modeState)}`);
        await cdp.evaluate(`window.__quotaModeRequest=new Promise(resolve=>window.__resolveQuotaMode=resolve);window.quotaModeGateEntered=false;document.querySelector('${quotaMode}').value='member_estimate';document.querySelector('${quotaMode}').dispatchEvent(new Event('change',{bubbles:true}))`);
        assert.ok(await cdp.evaluate(`layoutCalls.some(s=>new URL(s,location.origin).searchParams.get('quota_mode')==='member_estimate')`),'成员估算模式请求携带显式模式参数');
        await waitFor(cdp,'window.quotaModeGateEntered===true','等待估算请求进入fixture');
        assert.ok(await cdp.evaluate(`document.querySelector('#adminMultiDimensionResult .quota-member-estimate-loading')?.textContent.includes('正在计算成员额度估算')`),'估算查询期间显示独立加载提示');
        await cdp.evaluate('window.__resolveQuotaMode()');
        await waitFor(cdp,`document.querySelector('#adminMultiDimensionResult .quota-member-estimate-loading')===null`,'估算完成并移除加载提示');
      }
      assert.ok(await cdp.evaluate(`!document.querySelector('${panel}').getClientRects().length&&document.querySelector('${multi} #${scope==='user'?'user':'admin'}MultiDimensionResult canvas')`),`额度数据融合进请求图表结果区；状态=${await cdp.evaluate(`document.querySelector('${multi} .multi-dimension-status').textContent`)}`);
      if (scope !== 'admin') assert.ok(await cdp.evaluate(`(()=>{const d=chartInstances.filter(x=>x.target==='${scope==='user'?'user':'admin'}MultiDimensionResult').at(-1)?.config.data;return d?.labels.length===2&&d.datasets[0].data.length===2&&d.datasets[0].data[0]>0&&d.datasets[0].data[1]>0;})()`),'请求用量保持当前多维类别');
      if (scope === 'admin') assert.ok(await cdp.evaluate(`document.querySelector('#quotaMemberEstimateDetails table')&&!document.querySelector('#quotaMemberEstimateDetails canvas')`),'成员估算以可读明细表显示，避免图例挤压图表');
      assert.equal(await cdp.evaluate(`document.querySelectorAll('${multi} #${scope==='user'?'user':'admin'}MultiDimensionResult canvas').length`),1,'请求量和供应商额度使用同一张图表');
      if (scope !== 'admin') assert.ok(await cdp.evaluate(`(()=>{const c=chartInstances.filter(x=>x.target==='${scope==='user'?'user':'admin'}MultiDimensionResult').at(-1)?.config,d=c?.data;return d?.datasets.length===3&&d.labels.length===2&&d.datasets[1].data[0]===d.datasets[1].data[1]&&d.datasets[2].data[0]===d.datasets[2].data[1]&&d.datasets[1].label.includes('窗口额度使用率')&&d.datasets[2].label.includes('余额剩余比例')&&c.options.scales.xQuota0.max===100;})()`),'窗口与余额额度合并成两条清晰参考线');
      if (scope === 'admin') {
        assert.ok(await cdp.evaluate(`document.querySelector('#quotaMemberEstimateDetails').textContent.includes('估算额度使用')`),'成员额度估算明细表显示每人额度');
        assert.ok(await cdp.evaluate(`document.querySelectorAll('#quotaMemberEstimateDetails tbody tr').length>=2`),'估算明细有多成员行');
        assert.ok(await cdp.evaluate(`document.querySelector('#adminMultiDimensionResult .multi-dimension-chart-container').getBoundingClientRect().height>=340`),'图表高度足以区分成员刻度');
      }
      assert.ok(await cdp.evaluate(`document.querySelector('${multi} #${scope==='user'?'user':'admin'}MultiDimensionResult .multi-dimension-chart-container')?.clientHeight>0`),'统一图表在页面内实际渲染');
      if(process.env.CHART_ONLY==='1') continue;
      const dialog='#quotaHistoryDialog';
      await waitFor(cdp,`document.querySelector('${dialog} .quota-history-rows tbody tr')`,'历史加载');
      assert.ok(await cdp.evaluate(`document.querySelector('${dialog} .quota-history-visual .quota-history-chart-card')`),'额度历史展示趋势图表');
      assert.ok(await cdp.evaluate(`document.querySelector('${dialog} .quota-history-table-details')&&!document.querySelector('${dialog} .quota-history-table-details').open`),'原始记录默认收起避免淹没图表');
      assert.ok(await cdp.evaluate(`document.querySelectorAll('${dialog} .quota-history-chart-card .quota-history-series-list span').length>0`),'图例标明供应商和额度系列');
      assert.ok(await cdp.evaluate(`document.querySelectorAll('${dialog} .quota-history-rows th').length<=6`),'历史只保留必要列');
      assert.ok(await cdp.evaluate(`!document.querySelector('${dialog} .quota-history-rows').textContent.includes('Token')&&!document.querySelector('${dialog} .quota-history-rows').textContent.includes('未知')`),'历史无请求字段及不适用未知列');
      assert.ok(await cdp.click(dialog+' [data-quota-action="next"]'),'历史下一页');await sleep(200);
      assert.ok(await cdp.evaluate(`layoutCalls.some(s=>s.includes('/history?')&&s.includes('page=2')&&s.includes('provider_id=p1'))`),'历史真实分页请求');
      assert.ok(await cdp.click(dialog+' .modal-close'),'关闭历史');
      await cdp.evaluate(`CrewRouterQuotaStats.open('${scope}','p2')`);
      await waitFor(cdp,`document.querySelector('#quotaHistoryDialog .quota-history-rows')?.textContent.includes('99,997,501.22')`,'余额历史加载完成');
      assert.ok(await cdp.evaluate(`document.querySelector('#quotaHistoryDialog .quota-history-visual').textContent.includes('当前筛选没有可绘制')`),'没有成功观测时图表给出适用空态');
      await cdp.evaluate(`document.querySelector('#quotaHistoryDialog .quota-history-table-details').open=true`);
      assert.ok(await cdp.click('#quotaHistoryDialog .quota-row-detail > summary'),'展开单条记录详情');
      assert.ok(await cdp.evaluate(`document.querySelector('#quotaHistoryDialog .quota-row-detail').open`),'有效观测时间按需查看');
      assert.ok(await cdp.click('#quotaHistoryDialog .modal-close'));
      if(scope==='admin'){
        await cdp.evaluate(`adminApp.navigateTo('adminProviders');adminApp.checkProviderQuota('p1')`);await sleep(500);
        await waitFor(cdp,`document.querySelector('#quotaLatestObservation').textContent.includes('每月')`,'供应商详情使用适配窗口');
        assert.ok(await cdp.click('#quotaLatestObservation [data-quota-action="history"]'),'供应商详情打开历史');await sleep(250);
        assert.ok(await cdp.click('#quotaHistoryDialog .modal-close'));await cdp.evaluate(`adminApp.closeModals()`);
      }else{
        await cdp.evaluate(`app.navigateTo('modelLibrary');app.renderProviderQuota([{id:'p1',name:'Command Code GOAT',quota:{unit:'percent',used:89.2059,periods:[{key:'monthly',label:'每月',percent:89.2059}]}}])`);await sleep(250);
        assert.ok(await cdp.evaluate(`!document.querySelector('#providerQuotaGrid .quota-library-latest')`),'模型库只保留一份额度展示');
        assert.ok(await cdp.click('#providerQuotaGrid [data-quota-provider="p1"]'),'模型库历史入口');await sleep(250);assert.ok(await cdp.click('#quotaHistoryDialog .modal-close'));
      }
      await cdp.evaluate(`${app}.navigateTo('${scope==='user'?'stats':'adminStats'}');${app}.switchStatsTab('multi')`);await sleep(250);
      await cdp.evaluate(`layoutMode='denied';CrewRouterQuotaStats.refresh('${scope}');CrewRouterMultiDimension.load('${scope}')`);await sleep(300);
      assert.ok(await cdp.evaluate(`document.querySelector('${multi} .multi-dimension-status').textContent.includes('额度数据加载失败')`),'额度请求撤权后图表报告错误');
      await cdp.evaluate(`layoutMode='normal';${app}.switchStatsTab('overview');CrewRouterQuotaStats.refresh('${scope}')`);await sleep(250);
      assert.ok(await cdp.evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),'无页面横向溢出');
      for(const tab of ['daily',scope==='user'?'apikey':'provider','logs']){await cdp.evaluate(`${app}.switchStatsTab('${tab}')`);assert.ok(await cdp.evaluate(`!document.querySelector('${root}').getClientRects().length`),'其他统计标签保持本页职责');}
      assert.equal(cdp.events.filter(e=>e.method==='Runtime.exceptionThrown').length,0,'无未捕获错误');
      console.log(`PASS stats layout ${scope} ${width}: overview compact, lazy trends, dimension isolation, association context, six-column history, pagination, permission, routes, responsive`);
    }finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
