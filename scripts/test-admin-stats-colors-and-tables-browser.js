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
try{await cdp.send('Page.enable');for(const width of [1440,390]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===390});await cdp.send('Page.navigate',{url:`${base}/admin?chartFix=${width}#adminStats`});for(let i=0;i<100;i++){if(await cdp.evaluate(`typeof adminApp!=='undefined'&&!!document.getElementById('statsTabOverview')`))break;await sleep(100);}await cdp.evaluate(`adminApp.navigateTo('adminStats')`);await sleep(600);
await cdp.evaluate(`(()=>{adminApp.stats={bySource:[{request_source:'grok',requests:20,cost:2},{request_source:'codex',requests:10,cost:1},{request_source:'unknown',requests:5,cost:0.5}],dailyBySource:[],byModel:[],byProvider:[],daily:[],byUser:[{user_name:'Browser User',requests:20,tokens:2000,cost:3,avg_latency:120}],byTeam:[{team_name:'Browser Team',requests:10,tokens:1000,cost:2,avg_latency:100}]};adminApp.renderSourceCharts();adminApp.renderMemberStatsCharts();adminApp.renderMemberStatsTables();adminApp.renderMultiStatsTable([{user_name:'A',team_name:'Team',workspace_path:'/very/long/workspace/path',request_source:'grok',model_name:'gpt-6.1-sol',provider_name:'Provider',requests:10,tokens:1000,cost:1,avg_latency:120}]);})()`);await sleep(350);
assert.ok(await cdp.evaluate(`(()=>{const chart=adminApp._adminSourceReqChart;const colors=chart.data.datasets[0].backgroundColor;const acceptable=c=>typeof c==='string'&&!c.includes('var(')&&c!=='#000'&&c!=='black';const table=document.querySelector('#adminStatsCombinationTable .multi-stats-combination-table');return colors.length===3&&colors.every(acceptable)&&getComputedStyle(table).tableLayout==='fixed'&&table.querySelectorAll('col').length===10&&table.scrollWidth>=table.parentElement.clientWidth&&document.documentElement.scrollWidth<=innerWidth;})()`),'来源图表使用有效颜色和组合表列宽');
if(process.env.CHART_FIX_SCREENSHOT_DIR){const r=await cdp.send('Page.captureScreenshot');require('node:fs').writeFileSync(`${process.env.CHART_FIX_SCREENSHOT_DIR}/chart-fix-${width}.png`,Buffer.from(r.data,'base64'));}
assert.ok(await cdp.evaluate(`(()=>{const chart=adminApp._memberCostChart;const colors=chart.data.datasets[0].backgroundColor;const team=document.querySelector('#teamStatsTable tfoot tr td:first-child').textContent;return colors.length>0&&colors.every(c=>typeof c==='string'&&!c.includes('var(')&&c!=='#000')&&team==='合计';})()`),'成员积分颜色和Team合计文案');
await cdp.evaluate(`(()=>{const original=window.fetch.bind(window);window.__messageQuery=null;window.fetch=async(url,options={})=>{if(String(url).startsWith('/api/admin/message-stats?')){window.__messageQuery=String(url);return new Response(JSON.stringify({summary:{analyzed_requests:1},by_source:[],by_block:[],by_workspace:[],daily:[]}),{status:200});}return original(url,options);};})()`);await cdp.evaluate(`adminApp.switchStatsTab('messages')`);await sleep(350);assert.ok(await cdp.evaluate(`(()=>{const a=document.getElementById('messageStatsSourceFilter'),b=document.getElementById('messageStatsBlockFilter');return a.shadowRoot.querySelector('[part="trigger"]').textContent.includes(t('全部客户端'))&&b.shadowRoot.querySelector('[part="trigger"]').textContent.includes(t('全部区块'))&&!a.classList.contains('input')&&!b.classList.contains('input')&&getComputedStyle(a).borderTopWidth==='0px'&&getComputedStyle(b).borderTopWidth==='0px';})()`),'消息筛选默认提示和单层外观');await cdp.evaluate(`document.getElementById('messageStatsSourceFilter').value='codex';document.getElementById('messageStatsBlockFilter').value='git_status'`);await cdp.click('#statsTabMessages button[onclick="adminApp.loadMessageStats()"]');await sleep(350);assert.ok(await cdp.evaluate(`window.__messageQuery?.includes('request_source=codex')&&window.__messageQuery?.includes('block=git_status')`),'消息筛选查询参数');console.log(`PASS stats chart colors, totals and message filters ${width}px`);
}}finally{cdp.ws.close();await fetch(`${debug}/json/close/${target.id}`);}}
main().catch(e=>{console.error(e);process.exitCode=1;});
