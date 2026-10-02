#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
const phase = process.argv.includes('--focused') ? 'focused' : process.argv.includes('--baseline') ? 'baseline' : process.argv.includes('--theme-calibrate') ? 'theme-calibration' : process.argv.includes('--calibrate') ? 'calibration' : 'final';
const outputArg = process.argv.find(arg => arg.startsWith('--output='));
const output = outputArg ? path.resolve(outputArg.slice('--output='.length)) : path.join(root, 'audit/blora-correction/browser', process.argv.includes('--plugins-only') ? 'focused-plugins' : process.argv.includes('--stable-focused') ? 'focused-stable' : phase);
const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18571';
const debugging = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18572';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pages = fs.readdirSync(path.join(root, 'public/pages')).filter(file => file.endsWith('.html')).map(file => file.slice(0, -5)).sort();
const crypto = require('crypto');
function snapshot() {
  const files = [];
  const walk = dir => { for (const entry of fs.readdirSync(path.join(root, dir), {withFileTypes:true})) {const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(/\.(js|css|html)$/.test(file))files.push(file);} };
  for (const dir of ['public/js','public/css','public/pages']) walk(dir);
  walk('plugins');
  return Object.fromEntries(files.sort().map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
}
const themes = [{id:'default',file:null}, ...['example-theme','theme-linear','theme-paper','theme-terminal','theme-raycast','crewrouter-classic','all-capabilities'].flatMap(id=>{const dir=path.join(root,'plugins',id);const manifest=JSON.parse(fs.readFileSync(path.join(dir,'plugin.json'),'utf8'));return manifest.themes.map(theme=>({id:theme.id,pluginId:id,qualifiedId:`${id}/${theme.id}`,file:path.relative(root,path.join(dir,theme.entry))}));})];
const fixtureDescription = ['Test-wrapper only: demo API keys receive normal key_type; audit logs use items/logs and 123 rows with real query pagination; admin users get 123 searchable rows.', 'Store public listing/detail uses existing plugin manifests; protected store routes remain unauthenticated, with no mocked permissions.', 'Plugin runtime/theme endpoints are isolated metadata fixtures; CSS is served from existing plugins and injected as-is, without synthesized token overrides; existing production palette mapping and official tokens.themes.css are used on pages without plugin runtime.'];
const packageVersion = JSON.parse(fs.readFileSync(require.resolve('@bloret-crew/blora-design/package.json'), 'utf8')).version;

if (process.argv.includes('--server')) {
  for (const key of Object.keys(process.env)) if (/^(CR(?:W)?_|DATABASE_URL$|PG(HOST|PORT|USER|PASSWORD|DATABASE)$)/.test(key)) delete process.env[key];
  Object.assign(process.env, { CR_APP_HOST: '127.0.0.1', CR_APP_PORT: new URL(base).port, CR_RUNTIME: 'server', CR_EDITION: 'team', CR_DEMO: 'true', CR_CONFIG_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blora-correction-demo-')), 'config.json'), CR_LOGIN_REPORT_ENABLED: 'false', CR_STATS_REPORT_ENABLED: 'false', CR_DB_HOST: '127.0.0.1', CR_DB_PORT: '1', CR_DB_NAME: 'blora_browser_isolated', CR_DB_USER: 'blora_browser_isolated', CR_DB_PASSWORD: 'isolated-test-only', NODE_ENV: 'test' });
  console.log(JSON.stringify({ demo: true, configPath: process.env.CR_CONFIG_PATH }));
  installFixtures();
  require('../server/index');
} else if (process.argv.includes('--chrome')) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blora-correction-chrome-'));
  console.log(JSON.stringify({chromeProfile:profile}));
  const child = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${new URL(debugging).port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => process.exit(code || 0));
} else main().catch(error => { console.error(error.stack); process.exitCode = 1; });

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
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ': ' + response.exceptionDetails.exception?.description);
    return response.result.value;
  }
  async key(key) {
    const codes = { Tab: 9, Escape: 27, Enter: 13, ArrowDown: 40 };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: codes[key] });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: codes[key] });
  }
  async click(selector) {
    const found = await this.evaluate(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&!e.disabled);if(!el)return false;el.scrollIntoView({block:'center',behavior:'instant'});return true;})()`);
    if(!found)return false;
    await sleep(160);
    const point = await this.evaluate(`(() => {const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&!e.disabled);if(!el)return null;const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(x<0||x>=innerWidth||y<0||y>=innerHeight||!(hit===el||el.contains(hit)))return null;return {x,y};})()`);
    if(!point)return false;
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(160); return true;
  }
}

function installFixtures() {
  const express = require('express');
  const originalInit = express.application.init;
  express.application.init = function () {
    originalInit.call(this);
    this.use((req, res, next) => {
      const url = new URL(req.url, base);
      if (url.pathname.startsWith('/__blora-test/theme/')) {
        const skin = themes.find(t=>t.id===url.pathname.split('/').pop());
        if(!skin?.file)return res.sendStatus(404);
        return res.type('css').sendFile(path.join(root,skin.file));
      }
      const data = require('../server/demo/data');
      if (/^\/api\/user\/providers\/quota(?:\/refresh)?$/.test(url.pathname)) return res.json(quotaFixture());
      if (req.method === 'GET' && url.pathname === '/api/user/api-keys') return res.json(data.apiKeys().map(key=>({...key,key_type:key.key_type||'normal',is_owner:true})));
      if(req.method==='GET' && /^\/api\/(user|admin)\/audit-logs$/.test(url.pathname)) {
        let items=Array.from({length:123},(_,i)=>({id:i+1,action:i%2?'provider.create':'api_key.create',description:`Browser fixture audit row ${i+1}`,username:'Demo User',resource_type:i%2?'provider':'api_key',resource_id:i+1,created_at:new Date(Date.now()-i*60000).toISOString(),is_admin:true}));
        const q=url.searchParams.get('q');if(q)items=items.filter(item=>item.description.includes(q));const resource=url.searchParams.get('resource_type');if(resource)items=items.filter(item=>item.resource_type===resource);
        const page=Math.max(1,Number(url.searchParams.get('page'))||1),limit=Number(url.searchParams.get('limit'))||50,total=items.length;
        items=items.slice((page-1)*limit,page*limit);return res.json({items,logs:items,total,page,limit});
      }
      if(req.method==='GET' && url.pathname==='/api/admin/users') {
        let items=Array.from({length:123},(_,i)=>({...data.adminUsers()[i%data.adminUsers().length],id:i+1,username:`Fixture User ${i+1}`,email:`fixture-${i+1}@example.invalid`}));
        const q=url.searchParams.get('q');if(q)items=items.filter(u=>(u.username+' '+u.email).toLowerCase().includes(q.toLowerCase()));
        const page=Number(url.searchParams.get('page'))||1,limit=Number(url.searchParams.get('limit'))||50,total=items.length;
        return res.json({items:items.slice((page-1)*limit,page*limit),total,page,limit});
      }
      if(req.method==='GET' && /^\/api\/(user|admin)\/custom-instructions$/.test(url.pathname)) {
        let items=Array.from({length:63},(_,i)=>({fingerprint:String(i+1).padStart(64,'a'),file:`AGENTS-${i+1}.md`,source:'project',chars:420,occurrence_count:18,user_count:1,first_seen:'2026-01-01T00:00:00Z',last_seen:'2026-09-30T00:00:00Z',preview:`GPT isolated fixture prompt ${i+1}`,positions:['system'],truncated:false}));
        const q=url.searchParams.get('search');if(q)items=items.filter(i=>(i.file+i.preview).includes(q));const page=Number(url.searchParams.get('page'))||1,pageSize=20,total=items.length;return res.json({items:items.slice((page-1)*pageSize,page*pageSize),total,page,pageSize});
      }
      if(url.pathname==='/api/plugins/runtime')return res.json({plugins:themes.filter(t=>t.file).map(t=>({id:t.id,name:t.id,version:'test-fixture',enabled:true,themes:[{id:t.qualifiedId,name:t.id,url:`/__blora-test/theme/${t.id}`}],pages:[],slots:[]})),defaultTheme:''});
      if(url.pathname==='/api/plugins/user-theme')return res.json({themeId:''});
      if(req.method==='GET' && url.pathname.startsWith('/store/api/')) {
        if(url.pathname==='/store/api/me')return res.json({loggedIn:false,user:null,config:{configured:false},testFixture:true});
        const plugins=themes.filter(t=>t.file).map(t=>({id:t.id==='ocean'?'example-theme':t.id,name:`Fixture ${t.id}`,version:'1.0.0',author:'Test fixture',description:'Read-only isolated fixture from existing plugin CSS',permissions:['themes:register'],tags:['theme'],ratingCount:0,ratingAvg:0,installCount:0,status:'approved'}));
        if(url.pathname==='/store/api/plugins')return res.json({plugins,total:plugins.length});
        if(url.pathname.endsWith('/ratings'))return res.json({ratings:[],count:0});
        const id=url.pathname.split('/')[4];const plugin=plugins.find(p=>p.id===id);
        if(plugin)return res.json({plugin,related:[]});
      }
      next();
    });
  };
}

async function applySkin(cdp, skin) {
  const read = () => cdp.evaluate(`(() => {const s=getComputedStyle(document.documentElement);return Object.fromEntries(['--primary','--background','--blora-primary','--blora-background','--blora-color-action-primary-default','--blora-color-surface-canvas'].map(k=>[k,s.getPropertyValue(k).trim()]));})()`);
  const before=await read();
  let mode='default';
  if(skin.file) {
    const paletteMap={'ocean':'circuit','linear':'indigo','paper':'coral','terminal':'mono','raycast':'dusk','classic':'graphite','all-capabilities-theme':'coral'};
    const appliedByRuntime=await cdp.evaluate(`(async()=>{if(window.CrewThemes?.list().some(t=>t.id===${JSON.stringify(skin.qualifiedId)})){await window.CrewThemes.apply(${JSON.stringify(skin.qualifiedId)});return true;}return false;})()`);
    if(appliedByRuntime) mode='production-CrewThemes-apply-with-isolated-metadata';
    else {
      await cdp.evaluate(`new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/blora/tokens.themes.css?v=2.1.0';link.onload=()=>resolve(true);link.onerror=reject;document.head.appendChild(link);})`);
      await cdp.evaluate(`document.documentElement.setAttribute('data-blora-theme',${JSON.stringify(paletteMap[skin.id])});document.documentElement.classList.add(${JSON.stringify('theme-'+skin.pluginId+'__'+skin.id)})`);
      await cdp.evaluate(`new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.id='audit-plugin-theme';link.href=${JSON.stringify(`${base}/__blora-test/theme/${skin.id}`)};link.onload=()=>resolve(true);link.onerror=()=>reject(new Error('Theme CSS failed'));document.head.appendChild(link);})`);
      mode='existing-plugin-css-and-official-palette-injection-no-runtime-on-public-page';
    }
    await sleep(100);
  }
  const after=await read();
  const loaded=skin.file?await cdp.evaluate(`[...document.styleSheets].some(s=>s.href&&s.href.includes(${JSON.stringify('/__blora-test/theme/'+skin.id)}))`):true;
  return {id:skin.id,source:skin.file,loaded,before,after,legacyChanged:before['--primary']!==after['--primary']||before['--background']!==after['--background'],officialChanged:Object.keys(before).filter(k=>k.startsWith('--blora-')).some(k=>before[k]!==after[k]),mode,officialPalette:skin.file?await cdp.evaluate(`document.documentElement.getAttribute('data-blora-theme')`):null,permissionsE2E:false};
}

function quotaFixture() {
  const balance = {total:500.1234567890123,used:312.7123456789012,remaining:187.4111111101111,unit:'USD',credits:{balance:12345.678901234567}};
  return {providers:[
    {id:'openai',name:'OpenAI — Production international enterprise provider with an unusually long name',quota:balance,aggregated:balance,keys:[{ok:true,index:0,label:'Production primary international key',quota:balance},{ok:true,index:1,label:'Secondary disaster recovery key',quota:{...balance,remaining:71.71234567890123}}]},
    {id:'anthropic',name:'Anthropic — Long subscription provider name / Command Code GOAT',quota:{...balance,planName:'GOAT enterprise subscription',currentPercent:62.54321098765432,periods:[{key:'current_period',label:'当前周期',percent:62.54321098765432},{key:'weekly',label:'每周额度',percent:87.12345678901234}]}},
    {id:'deepseek',name:'DeepSeek',quota:{total:100,used:28.3,remaining:71.71234567890123}}
  ]};
}

function actualRoutes() {
  const html = name => fs.readFileSync(path.join(root,`public/pages/${name}.html`),'utf8');
  const consoleIds = [...fs.readFileSync(path.join(root,'public/js/app.js'),'utf8').match(/_consolePageIds\(\)\s*\{[\s\S]*?new Set\(\[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);
  const adminIds = [...html('admin').matchAll(/id="([^"]+)Page"/g)].map(m=>m[1]);
  const extra = ['myUpstream/models','myUpstream/providers',...['overview','chat','models','anthropic','user-api','conversations','errors'].map(id=>`docs/${id}`),...['chat','imagine','manage'].map(id=>`bloraAgent/${id}`),'dashboard','myProviders','myTeamModels'];
  return [...new Set([...pages,...consoleIds.concat(extra).map(id=>`console#${id}`),...adminIds.concat(['adminTeams/1','adminUserGroups/1','adminDashboard']).map(id=>`admin#${id}`)])];
}

const inspection = `(() => {
  const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  const nav=[...document.querySelectorAll('.sidebar-nav .nav-item[data-page]')].filter(visible).map(e=>({page:e.dataset.page,rect:rect(e),parent:rect(e.parentElement),active:e.classList.contains('active'),variant:e.dataset.variant,current:e.getAttribute('aria-current'),glyphs:[...e.querySelectorAll('[data-icon],.nav-icon')].map(i=>({name:i.dataset.icon,class:i.className,svg:i.querySelectorAll('svg').length,shapes:i.querySelectorAll('svg path,svg circle,svg line,svg polyline,svg rect,svg polygon').length}))}));
  const glyphs=[...document.querySelectorAll('[data-icon]')].filter(visible).map(e=>({name:e.dataset.icon,tag:e.tagName,svg:e.querySelectorAll('svg').length,shapes:e.querySelectorAll('svg path,svg circle,svg line,svg polyline,svg rect,svg polygon').length}));
  const cards=[...document.querySelectorAll('.blora-card')].filter(visible).map(e=>({class:e.className,variant:e.dataset.variant,ancestors:(()=>{let p=e.parentElement,n=0;while(p){if(p.matches('.blora-card'))n++;p=p.parentElement;}return n;})()}));
  const surfaceSelectors='.model-library-item,.model-library-team,.model-library-team-header,.model-library-provider,.model-library-provider-header,.model-quota-card,.model-quota-key';
  const surfaces=[...document.querySelectorAll(surfaceSelectors)].filter(visible).map((e,index)=>{e.dataset.correctionSurface=String(index);const s=getComputedStyle(e);return {index,selector:e.className,card:e.matches('.blora-card'),listItem:e.getAttribute('role')==='listitem'&&!!e.closest('.blora-list'),background:s.backgroundColor,border:s.borderTop,shadow:s.boxShadow,rect:rect(e),text:e.textContent.slice(0,100)};});
  const quota=document.getElementById('providerQuotaGrid');
  return {href:location.href,scheme:document.documentElement.getAttribute('data-blora-color-scheme'),activePages:[...document.querySelectorAll('.page.active')].map(e=>e.id),nav,glyphs,cards,surfaces,quota:quota?{text:quota.innerText,keys:quota.querySelectorAll('.model-quota-key').length,rect:rect(quota),numbers:[...quota.querySelectorAll('.model-quota-remaining,.model-quota-total,.model-quota-credits,.model-quota-key,.blora-badge')].map(e=>e.innerText)}:null,overflow:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('input,button,select,textarea,[tabindex="0"]')].filter(visible).length,title:document.title,text:document.body.innerText.slice(0,180)};
})()`;

async function surfaceSources(cdp, surfaces) {
  const doc = await cdp.send('DOM.getDocument');
  const results=[];
  for(const surface of surfaces) {
    const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:`[data-correction-surface="${surface.index}"]`});
    const matched=await cdp.send('CSS.getMatchedStylesForNode',{nodeId});
    const rules=(matched.matchedCSSRules||[]).map(({rule})=>({selector:rule.selectorList?.text,origin:rule.origin,styleSheetId:rule.styleSheetId,source:cdp.events.find(e=>e.method==='CSS.styleSheetAdded'&&e.params.header.styleSheetId===rule.styleSheetId)?.params.header.sourceURL,layers:rule.layers?.map(l=>l.text),properties:rule.style.cssProperties.filter(p=>/^(background|border|box-shadow|border-radius)/.test(p.name)&&!p.disabled).map(p=>({name:p.name,value:p.value,important:p.important}))})).filter(r=>r.properties.length);
    results.push({...surface,rules});
  }
  return results;
}

async function main() {
  if(['final','focused'].includes(phase)&&!fs.existsSync('/tmp/blora-correction-ready'))throw new Error('Final acceptance requires /tmp/blora-correction-ready');
  fs.mkdirSync(path.join(output,'screenshots'),{recursive:true});
  if(!(await (await fetch(`${base}/api/config`)).json()).demo)throw new Error('Non-demo server refused');
  const target=await (await fetch(`${debugging}/json/new?about:blank`,{method:'PUT'})).json();
  const cdp=new CDP(target.webSocketDebuggerUrl),results=[],before=snapshot();
  const readyEvidence=['final','focused'].includes(phase)?{path:'/tmp/blora-correction-ready',mtime:fs.statSync('/tmp/blora-correction-ready').mtime.toISOString(),content:fs.readFileSync('/tmp/blora-correction-ready','utf8')}:null;
  let routes=phase==='focused'?['console#apiKeys','console#modelLibrary','console#bloraAgent/chat','console#bloraAgent/imagine','console#bloraAgent/manage','console#sessions','purchase','admin#adminPlugins','console','admin']:phase==='baseline'?['console#modelLibrary','admin#adminProviders']:phase==='calibration'?['console#apiKeys','console#auditLogs','admin#adminAuditLogs','admin#adminUsers','console','admin']:actualRoutes();
  const runs=[...['light','dark'].flatMap(theme=>[1440,390].flatMap(width=>routes.map(route=>({theme,width,route,skin:themes[0]}))))];
  if (process.argv.includes('--ui-sweep')) {
    const selected = ['index','login','register','purchase','console#modelLibrary','console#myUpstream','console#apiKeys','console#stats','console#projectWork','console#leaderboard','console#docs/chat','console#balance','console#auditLogs','console#prompts','console#sessions','console#bloraAgent/chat','console#settings','admin#adminStats','admin#adminProviders','admin#adminModels','admin#adminUsers','admin#adminTeams','admin#adminSettings','admin#adminPlugins'];
    runs.splice(0, runs.length, ...[1440, 390, 620, 768].flatMap(width => selected.map(route => ({theme:'light',width,route,skin:themes[0]}))));
  }
  if (process.argv.includes('--ui-fix')) {
    const selected = ['console#modelLibrary', 'console#bloraAgent/chat', 'admin#adminProviders'];
    routes = selected;
    runs.splice(0, runs.length, ...['light', 'dark'].flatMap(theme => [1440, 390, 620, 768].flatMap(width => selected.map(route => ({theme, width, route, skin: themes[0]})))));
  }
  if(process.argv.includes('--plugins-only')){runs.splice(0,runs.length,...runs.filter(r=>r.route==='admin#adminPlugins'));}
  if(process.argv.includes('--theme-calibrate')){runs.length=0;for(const skin of themes.slice(1))runs.push({skin,theme:'light',width:1440,route:'console#apiKeys'});}
  if(['final','focused'].includes(phase)&&!process.argv.includes('--plugins-only'))for(const skin of themes.slice(1))for(const theme of ['light','dark'])for(const width of [1440,390])runs.push({skin,theme,width,route:'console#apiKeys'});
  const coveredRoutes = [...new Set(runs.map(run => run.route))];
  const coveredThemes = themes.filter(theme => runs.some(run => run.skin.id === theme.id));
  const coverage = process.argv.includes('--ui-fix')
    ? 'Agent chat, model library and admin providers: light/dark at 1440, 390, 620 and 768 pixels; default theme only.'
    : process.argv.includes('--ui-sweep')
      ? 'Selected UI routes: light at 1440, 390, 620 and 768 pixels; additional theme runs, if any, are listed in results.'
      : phase === 'focused'
        ? 'Affected routes only in four combinations; API keys in default plus seven plugin themes four combinations.'
        : 'Routes and themes listed in this manifest are the actual scheduled combinations.';
  fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({phase,readyEvidence,pages,routes:coveredRoutes,themes:coveredThemes,combinations:runs.length,fixture:quotaFixture(),base,debugging,db:'127.0.0.1:1',coverage,limitations:fixtureDescription},null,2));
  try {
    for(const domain of ['Page','Runtime','Network','DOM','CSS','Log'])await cdp.send(`${domain}.enable`);
    await cdp.send('Browser.grantPermissions',{origin:base,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
    await cdp.send('Network.setBlockedURLs',{urls:['https://*','http://localhost:*']});
    for(const run of runs) {
      const {route,width,theme,skin}=run,name=`${skin.id}-${route.replace(/[^a-zA-Z0-9-]/g,'-')}-${theme}-${width}`;
      const row={route,width,theme,skin:skin.id,assertions:[],screenshots:[],interactions:[]};
      const assert=(name,condition,evidence)=>row.assertions.push({name,status:condition?'passed':'failed',evidence});
      const screenshot=async suffix=>{const filename=`screenshots/${suffix}.png`;const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,filename),Buffer.from(shot.data,'base64'));row.screenshots.push(filename);return filename;};
      cdp.events=[];
      let boot;
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
        await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme},{name:'prefers-reduced-motion',value:'reduce'}]});
        boot=await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`if(location.origin===${JSON.stringify(base)}){localStorage.setItem('theme',${JSON.stringify(theme)});localStorage.setItem('language','zh');localStorage.removeItem('crewrouter-theme');}`});
        await cdp.send('Page.navigate',{url:'about:blank'});await sleep(50);cdp.events=[];
        await cdp.send('Page.navigate',{url:`${base}/${route==='index'?'':route}`});
        for(let i=0;i<80;i++){await sleep(100);if(await cdp.evaluate(`document.readyState==='complete' && location.pathname===${JSON.stringify(route==='index'?'/':'/'+route.split('#')[0])}`))break;}
        await sleep(650);
        if(route.split('#')[0]==='console'||route.split('#')[0]==='admin')for(let i=0;i<35;i++){if(await cdp.evaluate(`typeof app!=='undefined'&&app.user || typeof adminApp!=='undefined'&&adminApp.user`))break;await sleep(100);}
        if(route==='console'||route==='console#modelLibrary'||route==='console#home')for(let i=0;i<35;i++){if(await cdp.evaluate(`document.querySelectorAll('#providerQuotaGrid .model-quota-card').length===3`))break;await sleep(100);}
        row.themeEvidence=await applySkin(cdp,skin);
        if(route==='console#modelLibrary'){await cdp.click('.model-library-team:not(.model-library-starred) .model-library-provider-header');await sleep(300);await cdp.evaluate('scrollTo(0,0)');}
        await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:width-2,y:2});await sleep(180);
        row.details=await cdp.evaluate(inspection);
        if(skin.id!=='default')assert('plugin-theme-loaded-official-token-change',row.themeEvidence.loaded&&(row.themeEvidence.officialChanged||['paper','all-capabilities-theme'].includes(skin.id)&&row.themeEvidence.officialPalette==='coral'),{...row.themeEvidence});
        assert('color-scheme',row.details.scheme===theme,{actual:row.details.scheme,expected:theme});
        assert('document-width-supporting-only',row.details.overflow<=width+2,{actual:row.details.overflow,width});
        assert('visible-data-icons-have-svg-shapes',row.details.glyphs.every(g=>g.svg>0&&g.shapes>0),row.details.glyphs);
        if(route.startsWith('console')||route.startsWith('admin')) {
          if(width===1440){const nav=row.details.nav;assert('desktop-nav-full-row-single-column',nav.length>0&&nav.every((n,i)=>Math.abs(n.rect.x-nav[0].rect.x)<2&&n.rect.width>=n.parent.width-3&&(i===0||n.rect.y>=nav[i-1].rect.bottom-1)),nav);assert('desktop-nav-glyphs-filled',nav.every(n=>n.glyphs.length>0&&n.glyphs.every(g=>g.svg>0&&g.shapes>0)),nav);}
          const active=await cdp.evaluate(`[...document.querySelectorAll('.sidebar-nav .nav-item.active')].map(e=>({page:e.dataset.page,variant:e.dataset.variant,current:e.getAttribute('aria-current')}))`);
          assert('active-public-variant-aria-current',active.length===1&&active.every(a=>['primary','secondary','outline','ghost','danger','text'].includes(a.variant)&&a.current==='page'),active);
          if(route.includes('#')){const expected=route.split('#')[1].split('/')[0],aliases={home:'modelLibrary',dashboard:'modelLibrary',myProviders:'myUpstream',myTeamModels:'myUpstream',adminDashboard:'adminStats',adminUserGroups:'adminTeams'};assert('actual-route-active-page',row.details.activePages.includes(`${aliases[expected]||expected}Page`),row.details.activePages);}
        }
        if (route === 'console#bloraAgent/chat') {
          const geometry = await cdp.evaluate(`(() => {const r=document.querySelector('.ba-composer').getBoundingClientRect();const p=document.querySelector('.cr-agent-page');return {bottom:r.bottom, viewport:innerHeight,gap:getComputedStyle(p).gap};})()`);
          assert('agent-composer-inside-viewport', geometry.bottom <= geometry.viewport + 1 && geometry.gap === '0px', geometry);
        }
        if (width === 620 && (route.startsWith('console') || route.startsWith('admin'))) {
          const toggleVisible = await cdp.evaluate(`document.getElementById('sidebarToggle').getClientRects().length > 0`);
          assert('mobile-navigation-620-accessible', toggleVisible, {width});
        }
        assert('card-hierarchy-one-inset-level',row.details.cards.every(c=>c.ancestors===0||(c.ancestors===1&&c.variant==='inset')),row.details.cards);
        if(route.startsWith('console#docs/'))assert('docs-subroute-selected',await cdp.evaluate(`document.querySelector('.doc-page.active')?.id===${JSON.stringify('doc-'+route.split('/')[1])}`),{expected:route.split('/')[1]});
        if(route.startsWith('console#myUpstream/'))assert('upstream-subroute-selected',await cdp.evaluate(`app._myUpstreamTab===${JSON.stringify(route.split('/')[1])}`),{expected:route.split('/')[1]});
        if(route.startsWith('console#bloraAgent/'))assert('agent-subroute-selected',await cdp.evaluate(`app._agentMode===${JSON.stringify(route.split('/')[1])}`),{expected:route.split('/')[1]});
        if(route==='console#apiKeys'){const stats=await cdp.evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};return [...document.querySelectorAll('#usageOverview > .blora-card')].map(e=>({class:e.className,card:rect(e),label:rect(e.querySelector('.blora-stat__label')),value:rect(e.querySelector('.blora-stat__value')),text:e.innerText,display:getComputedStyle(e.parentElement).display}));})()`);row.statGeometry=stats;assert('api-key-stat-grid-readable-width',stats.length===3&&stats.every(s=>s.display==='grid'&&s.card.width>=180),stats);assert('api-key-stat-labels-and-values-inside-card',stats.every(s=>[s.label,s.value].every(r=>r.x>=s.card.x&&r.right<=s.card.right+1&&r.y>=s.card.y&&r.bottom<=s.card.bottom+1)&&s.label.width>=140&&s.label.height<60),stats);}
        if(phase==='focused'&&route==='console#modelLibrary'){const padding=await cdp.evaluate(`[...document.querySelectorAll('.model-quota-card')].map(e=>({class:e.className,size:e.dataset.size,padding:[getComputedStyle(e).paddingTop,getComputedStyle(e).paddingRight,getComputedStyle(e).paddingBottom,getComputedStyle(e).paddingLeft]}))`);assert('quota-card-sm-official-padding-24',padding.length===3&&padding.every(e=>e.size==='sm'&&e.padding.every(p=>p==='24px')),padding);}
        if(phase==='focused'&&route==='admin#adminPlugins'){for(let i=0;i<80;i++){if(await cdp.evaluate(`document.getElementById('adminPluginsContent')?.dataset.bloraState==='success'||document.getElementById('adminPluginsContent')?.dataset.bloraState==='error'`))break;await sleep(100);}row.pluginState=await cdp.evaluate(`({text:document.getElementById('adminPluginsContent')?.innerText,alert:!!document.querySelector('#adminPluginsContent blora-alert'),loading:!!document.querySelector('#adminPluginsContent [data-blora-state="loading"]')})`);assert('plugins-real-loaded-or-error-feedback',!!row.pluginState.text&&!/加载中/.test(row.pluginState.text),row.pluginState);}

        if(row.details.surfaces.length){row.surfaceSources=await surfaceSources(cdp,row.details.surfaces);assert('resource-no-legacy-gray-header',row.surfaceSources.filter(s=>/model-library-(team|provider)-header/.test(s.selector)).every(s=>s.background==='rgba(0, 0, 0, 0)'),row.surfaceSources);const providers=row.details.surfaces.filter(s=>/model-library-provider$/.test(s.selector)||/model-library-provider /.test(s.selector));if(providers.length)assert('resource-provider-public-card-or-list',providers.every(s=>s.card||s.listItem),providers);}
        if(row.details.quota&&/modelLibrary|console$/.test(route)){assert('quota-real-long-fixture-multiple-keys',row.details.quota.keys===2&&row.details.quota.text.includes('Production international'),row.details.quota);assert('quota-visible-decimals-formatted',!/[0-9]+\.[0-9]{5,}/.test(row.details.quota.text),row.details.quota.numbers);assert('quota-real-values-preserved-not-placeholder',row.details.quota.text.includes('187.41')&&row.details.quota.text.includes('71.71')&&row.details.quota.text.includes('62.5%')&&row.details.quota.text.includes('87.1%'),row.details.quota.numbers);}
        await screenshot(name);
        if(route==='console#modelLibrary'){await cdp.evaluate(`document.getElementById('providerQuotaSection').scrollIntoView({block:'start',behavior:'instant'})`);await screenshot(`${name}-quota`);await cdp.evaluate(`document.querySelector('.model-library-team:not(.model-library-starred)')?.scrollIntoView({block:'start',behavior:'instant'})`);await screenshot(`${name}-resources`);await cdp.evaluate('scrollTo(0,0)');}
        await cdp.evaluate(`document.activeElement?.blur();document.body.focus()`);await cdp.key('Tab');
        row.focus=await cdp.evaluate(`(()=>{let e=document.activeElement;while(e.shadowRoot?.activeElement)e=e.shadowRoot.activeElement;const s=getComputedStyle(e);return {tag:e.tagName,id:e.id,visible:e.getClientRects().length>0,focusVisible:e.matches(':focus-visible'),outline:s.outlineStyle,outlineWidth:s.outlineWidth,shadow:s.boxShadow};})()`);
        if(row.details.controls)assert('keyboard-visible-focus',row.focus.tag!=='BODY'&&row.focus.visible&&row.focus.focusVisible&&(row.focus.outline!=='none'&&row.focus.outlineWidth!=='0px'||row.focus.shadow!=='none'),row.focus);
        if(phase!=='baseline')await interactions(cdp,row,name,screenshot,assert);
        row.exceptions=cdp.events.filter(e=>e.method==='Runtime.exceptionThrown');
        assert('no-uncaught-exceptions',row.exceptions.length===0,row.exceptions);
        row.httpErrors=cdp.events.filter(e=>e.method==='Network.responseReceived'&&e.params.response.status>=400).map(e=>({url:e.params.response.url,status:e.params.response.status}));
      }catch(error){row.error=error.stack;}
      finally{if(boot)await cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:boot.identifier});}
      results.push(row);
      fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({phase,before,results},null,2));
      console.log(JSON.stringify({route,width,theme,skin:skin.id,error:row.error,failed:row.assertions.filter(a=>a.status==='failed').map(a=>a.name)}));
    }
    const after=snapshot(),changes=Object.keys(before).filter(f=>before[f]!==after[f]);
    const summary={observations:results.length,pages:new Set(results.map(r=>r.route.split('#')[0])).size,routes:coveredRoutes.length,themes:coveredThemes.map(t=>t.id),screenshots:results.reduce((n,r)=>n+r.screenshots.length,0),passed:results.flatMap(r=>r.assertions).filter(a=>a.status==='passed').length,failed:results.flatMap(r=>r.assertions).filter(a=>a.status==='failed').length,errors:results.filter(r=>r.error).length,sourceChanges:changes,stale:changes.length>0,limitations:['Demo only; mutations may not persist. No real OAuth, payment or inference acceptance.',coverage,'Viewport screenshots and measured surfaces are not a proof of all offscreen visuals.','Surface evidence contains actual matched stylesheet rules, not an assertion that zero overflow means visual correctness.']};
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({phase,generatedAt:new Date().toISOString(),before,after,summary,results},null,2));
    console.log(JSON.stringify(summary));if(summary.failed||summary.errors||summary.stale)process.exitCode=1;
  }finally{await cdp.send('Page.close').catch(()=>{});cdp.ws.close();}
}

async function interactions(cdp,row,name,screenshot,assert) {
  const {route,width}=row;
  if(route==='console#apiKeys') {
    const copied=await cdp.click('blora-copy .blora-copy__btn');let clipboard='';try{clipboard=await cdp.evaluate('navigator.clipboard.readText()');}catch(error){row.interactions.push({type:'copy-blocked',error:error.message});}
    assert('existing-key-copy',copied&&clipboard.startsWith('sk-demo-'),{copied,demoKey:clipboard.startsWith('sk-demo-')});
    const opened=await cdp.click('#createApiKeyBtn');await sleep(150);
    assert('existing-form-opens',opened&&await cdp.evaluate(`document.getElementById('createApiKeyModal').hasAttribute('open')`),{opened});
    if(opened){await cdp.click('#apiKeyName');await cdp.send('Input.insertText',{text:'Correction browser demo key'});await cdp.key('Tab');await screenshot(`${name}-form-focus`);await cdp.key('Escape');await sleep(350);assert('form-escape-restores-focus',await cdp.evaluate(`!document.getElementById('createApiKeyModal').hasAttribute('open')&&document.activeElement.id==='createApiKeyBtn'`),{});await cdp.click('#createApiKeyBtn');await cdp.click('#apiKeyName');await cdp.send('Input.insertText',{text:'Correction browser demo key'});await cdp.click('#confirmCreateApiKey');await sleep(250);assert('form-submit-closes-demo',await cdp.evaluate(`!document.getElementById('createApiKeyModal').hasAttribute('open')`),{persistenceVerified:false});}
    const more=await cdp.click('.api-key-more button');const danger=more&&await cdp.click('.api-key-more-item.danger');await sleep(100);assert('existing-danger-confirm-opens',danger&&await cdp.evaluate(`!!document.querySelector('blora-dialog[open],dialog[open]')`),{more,danger});await screenshot(`${name}-danger`);await cdp.key('Escape');await sleep(120);assert('danger-escape-cancels',await cdp.evaluate(`!document.querySelector('blora-dialog[open],dialog[open]')`),{});
  }
  if(['console#auditLogs','admin#adminAuditLogs','admin#adminUsers'].includes(route)) {
    const next=await cdp.evaluate(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&!e.disabled&&/下一页|Next/.test(e.textContent+' '+e.title+' '+e.getAttribute('aria-label')));if(!e)return false;e.dataset.correctionNext='true';return true;})()`);
    const before=await cdp.evaluate('document.body.innerText');const clicked=next&&await cdp.click('[data-correction-next]');await sleep(400);const changed=before!==await cdp.evaluate('document.body.innerText');assert('existing-pagination-changes-rows',clicked&&changed,{clicked,changed});await screenshot(`${name}-pagination`);
    if(route==='console#auditLogs'){const beforeFilter=await cdp.evaluate('document.body.innerText');const selected=await cdp.evaluate(`(()=>{const e=document.getElementById('auditLogActionFilter');if(!e)return false;e.value='provider';e.dispatchEvent(new Event('change',{bubbles:true}));return e.value==='provider';})()`);await sleep(500);const text=await cdp.evaluate('document.body.innerText');assert('existing-resource-filter-updates-rows',selected&&text!==beforeFilter&&!text.includes('Browser fixture audit row 123'),{selected,text:text.slice(-1000)});await screenshot(`${name}-filter`);return;}
    const filter=await cdp.evaluate(`(()=>{const e=[...document.querySelectorAll('input')].find(e=>e.getClientRects().length&&/搜索|筛选|search/i.test(e.placeholder));if(!e)return false;e.dataset.correctionFilter='true';return true;})()`);
    const filterClicked=filter&&await cdp.click('[data-correction-filter]');if(filterClicked){await cdp.send('Input.insertText',{text:route==='admin#adminUsers'?'Fixture User 123':'Browser fixture audit row 123'});await cdp.key('Enter');await sleep(600);}const body=await cdp.evaluate('document.body.innerText');assert('existing-filter-updates-results',filterClicked&&body.includes('123')&&!body.includes(route==='admin#adminUsers'?'fixture-122@':'Browser fixture audit row 122'),{filterClicked,text:body.slice(-1000)});await screenshot(`${name}-filter`);
  }
  if(width===390&&(route==='console'||route==='admin'||route==='console#modelLibrary'||route==='admin#adminProviders')) {
    const opened=await cdp.click('#sidebarToggle');await sleep(150);assert('mobile-drawer-opens',opened&&await cdp.evaluate(`document.getElementById('mobileSidebarDrawer').hasAttribute('open')`),{opened});await screenshot(`${name}-drawer`);
    const target=await cdp.evaluate(`(()=>{const e=[...document.querySelectorAll('#mobileSidebarDrawer .nav-item[data-page]')].find(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&!e.classList.contains('active'));if(!e)return null;e.dataset.correctionNav='true';return e.dataset.page;})()`);
    const clicked=target&&await cdp.click('[data-correction-nav]');await sleep(250);assert('mobile-navigation-closes-drawer',clicked&&await cdp.evaluate(`!document.getElementById('mobileSidebarDrawer').hasAttribute('open')&&location.hash.includes(${JSON.stringify(target)})`),{clicked,target});
  }
}
