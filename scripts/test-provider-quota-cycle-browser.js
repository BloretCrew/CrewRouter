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
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);
    await sleep(350);
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
    const point = await cdp.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)});const options=[...e.shadowRoot.querySelectorAll('[part="option"]')];const i=[...e.querySelectorAll('blora-option')].findIndex(o=>o.getAttribute('value')===${JSON.stringify(value)});const o=options[i];if(!o)return null;o.scrollIntoView({block:'nearest',behavior:'instant'});const r=o.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
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
  window.cycleCalls = []; window.cycleMode = 'normal'; window.downloads = []; window.cycleDelay = 0;
  const create = URL.createObjectURL; URL.createObjectURL = function(blob) { if(blob.type==='application/json') blob.text().then(text=>downloads.push(JSON.parse(text))); return create.call(this,blob); };
  const account = {provider_id:'p1',provider_name:'周期测试供应商',account_id:'a1',label:'订阅账户',kind:'window',unit:'percent',window_key:'monthly',used_percent:99,status:'success',requests:401};
  const cycle = {id:'c1',provider_id:'p1',account_id:'a1',window_key:'monthly',state:'complete',version:2,started_at:'2026-10-01T00:00:00Z',ended_at:'2026-10-12T00:00:00Z',initial_snapshot:{observed_at:'2026-10-01T00:00:00Z',used_percent:0,status:'success'},final_snapshot:{observed_at:'2026-10-12T00:00:00Z',used_percent:100,status:'success'}};
  const samples = id => ['baseline','terminal'].map((phase,i)=>({id: id+'-'+phase,phase,quality:{status:i?'failed':'success'},sample_age_ms:12,reused:false,normalized_snapshot:{status:i?'failed':'success',observed_at:'2026-10-11T12:00:00Z',items:[{window_key:'monthly',used_percent:i?92:91,used:100+i,remaining:900-i}]}}));
  const attempts = Array.from({length:401},(_,i)=>({attempt_id:'attempt'+i,relation:i%2?'candidate':'certain',snapshot:{id:'attempt'+i,started_at:'2026-10-11T12:00:00Z',user_id:7,model:'model-'+i,project_id:'project-A',source:'codex',api_key_id:9,session_id:'session-A',status:i%2?'failed':'success',total_tokens:12000,points:3},samples:samples('attempt'+i)}));
  window.fetch = async function(input, options) {
    const url = new URL(typeof input==='string'?input:input.url, location.origin);
    if (!url.pathname.includes('/stats/provider-quota')) return original.call(this,input,options);
    cycleCalls.push(url.pathname+url.search);
    const mode=cycleMode, delay=cycleDelay;
    if(delay) await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,delay);options?.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});});
    if (mode==='denied') return new Response('{}',{status:403});
    if (mode==='changed' && url.pathname.endsWith('/requests') && url.searchParams.get('page')==='2') return Response.json({rows:[],total:402,page:2,limit:200});
    if (mode==='oversize' && url.pathname.endsWith('/requests')) return Response.json({rows:[],total:40001,page:1,limit:200});
    if (mode==='failed') return new Response('{}',{status:500});
    if (!url.pathname.includes('/cycles')) return Response.json({accounts:[account],summary:{success:1},usage_trend:[{provider_id:'p1',requests:401}]});
    const page = Number(url.searchParams.get('page') || 1), limit=Number(url.searchParams.get('limit')||20);
    if(url.pathname.endsWith('/requests')) return Response.json({rows:mode==='empty'?[]:attempts.slice((page-1)*limit,page*limit),total:mode==='empty'?0:401,page,limit});
    if(url.pathname.endsWith('/intervals')) return Response.json({rows:[{event:'consumption',started_at:cycle.started_at,ended_at:cycle.ended_at,observed_consumption:100,summary:{attempts:401}}],total:21,page,limit:20});
    if(/\/c[1-5]$/.test(url.pathname)) {
      const id=url.pathname.split('/').pop(), states={c1:'complete',c2:'partial',c3:'exhausted_pending_reconciliation',c4:'reset_before_exhaustion',c5:'adjusted'};
      const dimensions=Object.fromEntries(['user','team','model','project','client','key','session'].map(d=>[d,[{key:d==='user'?7:d+'-A',attempts:100,total_tokens:1000,points:8,request_share:.25,token_share:.1,points_share:.8},{key:d==='user'?8:d+'-B',attempts:301,total_tokens:9000,points:2,request_share:.75,token_share:.9,points_share:.2}]]));
      return Response.json({cycle:{...cycle,id,state:states[id]},summary:{attempts:401,logical_requests:390,total_tokens:12000,points:3,success:300,failed:100,cancelled:1},quota:{observed_consumption:100,percent_change:100},dimensions,coverage:{platform_requests_complete:false}});
    }
    return Response.json({rows:mode==='empty'?[]:[cycle,...['partial','exhausted_pending_reconciliation','reset_before_exhaustion','adjusted'].map((state,i)=>({...cycle,id:'c'+(i+2),state}))],total:mode==='empty'?0:23,page,limit:20});
  };
}
async function waitFor(cdp, expression, description) {
  for(let i=0;i<80;i++){if(await cdp.evaluate(expression))return;await sleep(100);}
  assert.fail(description);
}
async function main() {
  for(const scope of ['user','admin']) for(const width of [1440,390]) {
    const target = await fetch(`${debug}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());
    const cdp = new CDP(target.webSocketDebuggerUrl);
    try {
      await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});
      await cdp.send('Page.navigate',{url:`${base}/${scope==='user'?'console':'admin'}?cycle-test=${width}`});
      const app = scope==='user'?'app':'adminApp';
      await waitFor(cdp,`typeof ${app}!=='undefined'&&!!window.CrewRouterQuotaStats`,'页面初始化');
      assert.ok(await cdp.evaluate('!!window.CrewRouterQuotaCycleReport'), '真实页面include周期资源');
      await cdp.evaluate(`(${fixture.toString()})();${app}.navigateTo('${scope==='user'?'stats':'adminStats'}');${app}.switchStatsTab('overview');CrewRouterQuotaStats.refresh('${scope}')`);
      const root=`[data-quota-scope="${scope}"][data-quota-context="overview"]`;
      await waitFor(cdp,`document.querySelector('${root} .quota-cycle-summary summary')?.textContent.includes('23')`,'周期摘要');
      await choose(cdp,scope==='user'?'#statsTimeRange':'#adminStatsDays','7');
      await waitFor(cdp,`cycleCalls.some(s=>s.includes('/cycles?')&&s.includes('days=7'))`,'日期筛选同步周期摘要');
      assert.equal(await cdp.evaluate(`document.querySelector('${root} .quota-cycle-summary').open`),false,'摘要默认折叠');
      assert.ok(await cdp.click(root+' .quota-cycle-summary summary'),'真实展开周期摘要');
      assert.ok(await cdp.evaluate(`document.querySelector('${root} .quota-cycle-summary').textContent.includes('完整周期')`),'摘要展示状态');
      assert.ok(await cdp.click(root+' [data-quota-action="cycles"]'),'真实查看周期入口');
      await waitFor(cdp,`document.querySelector('#quotaCycleDialog .cycle-list')?.textContent.includes('待对账')`,'账户周期列表');
      assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="list-next"]'),'周期列表分页');
      await waitFor(cdp,`document.querySelector('#quotaCycleDialog .cycle-pagination')?.textContent.includes('第 2 页')`,'周期列表第二页');
      assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="report"]'),'真实打开周期报告');
      await waitFor(cdp,`document.querySelector('#quotaCycleDialog .cycle-requests')?.textContent.includes('model-0')`,'请求快照字段');
      assert.ok(await cdp.evaluate(`document.querySelector('#quotaCycleDialog .cycle-report').textContent.includes('75%')`),'user贡献百分比');
      assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="intervals-next"]'),'真实时间线下一页');
      await waitFor(cdp,`document.querySelector('#quotaCycleDialog .cycle-intervals').textContent.includes('第 2 页')`,'时间线第二页');
      assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="requests-next"]'),'真实请求下一页');
      await waitFor(cdp,`document.querySelector('#quotaCycleDialog .cycle-requests')?.textContent.includes('model-20')`,'请求第二页');
      assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="attempt-samples"]'),'真实打开当前attempt样本');
      assert.ok(await cdp.evaluate(`document.querySelector('.cycle-attempt-samples').textContent.includes('attempt20')&&document.querySelector('.cycle-attempt-samples').textContent.includes('92%')&&document.querySelector('.cycle-attempt-samples').textContent.includes('查询失败')`),'样本绑定当前行且显示失败阶段');
      for (const dimension of ['model','project','client','key','session','user']) { await choose(cdp,'#quotaCycleDialog [name="contribution_dimension"]',dimension); assert.ok(await cdp.evaluate(`document.querySelector('.cycle-contributors').textContent.includes(${JSON.stringify(dimension==='user'?'7':dimension+'-A')})`),'维度交叉排行'); }
      await choose(cdp,'#quotaCycleDialog [name="contribution_rank"]','points');
      assert.ok(await cdp.evaluate(`document.querySelector('.cycle-contributors tbody tr').textContent.includes('80%')`),'按积分排序');
      assert.ok(await cdp.click('#quotaCycleDialog .cycle-samples summary'),'真实展开样本');
      assert.ok(await cdp.evaluate(`document.querySelector('#quotaCycleDialog .cycle-samples').open`),'样本展开');
      assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="export"]'),'真实导出');
      await waitFor(cdp,`downloads.length===1`,'完整JSON下载');
      assert.ok(await cdp.evaluate(`downloads[0].export_complete&&downloads[0].requests.rows.length===401&&cycleCalls.some(s=>s.includes('/requests?')&&s.includes('page=3')&&s.includes('limit=200'))`),'200分页完整401条导出');
      await cdp.evaluate('cycleDelay=1200');
      assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="export"]'),'开始可取消导出');
      assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="cancel-export"]'),'真实取消导出');
      await sleep(1300); assert.equal(await cdp.evaluate('downloads.length'),1,'取消后不下载'); await cdp.evaluate('cycleDelay=0');
      for(const mode of ['oversize','changed']){await cdp.evaluate(`cycleMode='${mode}'`);assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="export"]'),'异常导出');await waitFor(cdp,`document.querySelector('.cycle-export-status').textContent.includes('${mode==='oversize'?'安全范围':'发生变化'}')`,'导出拒绝不完整下载');assert.equal(await cdp.evaluate('downloads.length'),1,'异常导出不下载');} await cdp.evaluate(`cycleMode='normal'`);
      assert.ok(await cdp.evaluate(`cycleCalls.filter(s=>s.includes('/cycles')).every(s=>!/[?&](user_id|team_id|model_id|request_source|workspace_path|api_key_id|data_source)=/.test(s))`),'周期不携带请求维度');
      assert.ok(await cdp.evaluate(`document.querySelector('#quotaCycleDialog .modal-content').getBoundingClientRect().width<=innerWidth&&document.documentElement.scrollWidth<=innerWidth`),'无水平溢出');
      assert.ok(await cdp.click('#quotaCycleDialog .cycle-report-statistics summary'),'真实展开详尽覆盖质量');
      assert.ok(await cdp.evaluate(`document.querySelector('.cycle-report-statistics').open`),'详尽指标披露');
      await cdp.evaluate(`document.querySelector('.cycle-report-heading').scrollIntoView({block:'start',behavior:'instant'})`);await sleep(250);
      const screenshot=await cdp.send('Page.captureScreenshot',{format:'png'});
      require('node:fs').writeFileSync(`/tmp/quota-cycle-${scope}-${width}.png`,Buffer.from(screenshot.data,'base64'));
      for (const [id,text] of [['c2','部分周期'],['c3','待对账'],['c4','重置前未耗尽']]) {
        assert.ok(await cdp.click(`#quotaCycleDialog [data-cycle-action="report"][data-id="${id}"]`),'真实周期状态钻取');
        await waitFor(cdp,`document.querySelector('.cycle-report-heading').textContent.includes('${text}')`,'报告正确状态');
      }
      await cdp.evaluate("cycleMode='empty'"); assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="apply"]'),'空查询');
      await waitFor(cdp,`document.querySelector('.cycle-list').textContent.includes('暂无周期数据')`,'空态');
      await cdp.evaluate("cycleMode='failed'"); assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="apply"]'),'失败查询');
      await waitFor(cdp,`document.querySelector('.cycle-status').textContent.includes('加载失败')`,'失败态');
      await cdp.evaluate("cycleMode='normal';cycleDelay=1200"); assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="apply"]'),'延迟查询');
      await cdp.evaluate("cycleMode='empty';cycleDelay=0"); assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="apply"]'),'新查询覆盖旧响应');
      await sleep(1300); assert.ok(await cdp.evaluate(`document.querySelector('.cycle-list').textContent.includes('暂无周期数据')`),'竞态旧数据不回写');
      await cdp.evaluate(`cycleMode='denied'`);
      assert.ok(await cdp.click('#quotaCycleDialog [data-cycle-action="apply"]'),'真实权限失败查询');
      await waitFor(cdp,`document.querySelector('#quotaCycleDialog .cycle-status')?.textContent.includes('无权查看额度')`,'403提示');
      assert.equal(await cdp.evaluate(`document.querySelector('#quotaCycleDialog .cycle-report').textContent+document.querySelector('#quotaCycleDialog .cycle-list').textContent+document.querySelector('#quotaCycleDialog .cycle-filters').textContent`),'','403清空旧报告与账户筛选');
      console.log(`PASS cycle ${scope} ${width}`);
    } finally { cdp.ws.close(); await fetch(`${debug}/json/close/${target.id}`); }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
