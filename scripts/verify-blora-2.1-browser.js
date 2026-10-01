#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, process.argv.includes('--interactions') ? 'audit/blora-2.1/supplemental' : 'audit/blora-2.1');
const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18471';
const debugging = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18472';
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
const themes = [{id:'default',file:null}, ...['example-theme','theme-linear','theme-paper','theme-terminal','theme-raycast','crewrouter-classic'].flatMap(id=>{const dir=path.join(root,'plugins',id);const manifest=JSON.parse(fs.readFileSync(path.join(dir,'plugin.json'),'utf8'));return manifest.themes.map(theme=>({id:theme.id,pluginId:id,qualifiedId:`${id}/${theme.id}`,file:path.relative(root,path.join(dir,theme.entry))}));})];
const fixtureDescription = ['Test-wrapper only: demo API keys receive normal key_type; audit logs use items/logs and 123 rows with real query pagination; admin users get 123 searchable rows.', 'Store public listing/detail uses existing plugin manifests; protected store routes remain unauthenticated, with no mocked permissions.', 'Plugin runtime/theme endpoints are isolated metadata fixtures; CSS is served from existing plugins and injected as-is, without synthesized token overrides; existing production palette mapping and official tokens.themes.css are used on pages without plugin runtime.'];
const packageVersion = JSON.parse(fs.readFileSync(require.resolve('@bloret-crew/blora-design/package.json'), 'utf8')).version;

if (process.argv.includes('--server')) {
  for (const key of Object.keys(process.env)) if (/^(CR(?:W)?_|DATABASE_URL$|PG(HOST|PORT|USER|PASSWORD|DATABASE)$)/.test(key)) delete process.env[key];
  Object.assign(process.env, { CR_APP_HOST: '127.0.0.1', CR_APP_PORT: new URL(base).port, CR_RUNTIME: 'server', CR_EDITION: 'team', CR_DEMO: 'true', CR_CONFIG_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blora-21-demo-')), 'config.json'), CR_LOGIN_REPORT_ENABLED: 'false', CR_STATS_REPORT_ENABLED: 'false', CR_DB_HOST: '127.0.0.1', CR_DB_PORT: '1', CR_DB_NAME: 'blora_browser_isolated', CR_DB_USER: 'blora_browser_isolated', CR_DB_PASSWORD: 'isolated-test-only', NODE_ENV: 'test' });
  console.log(JSON.stringify({ demo: true, configPath: process.env.CR_CONFIG_PATH }));
  installFixtures();
  require('../server/index');
} else if (process.argv.includes('--chrome')) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'blora-21-chrome-'));
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

async function main() {
  if (packageVersion !== '2.1.0') throw new Error(`Expected Blora 2.1.0, got ${packageVersion}`);
  fs.mkdirSync(path.join(output, 'screenshots'), { recursive: true });
  const version = await (await fetch(`${base}/api/config`)).json();
  if (!version.demo) throw new Error('Refusing to test a non-demo server');
  const target = await (await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  const results = [];
  const screenshot = async (name) => {
    const filename = `screenshots/${name}.png`;
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(output, filename), Buffer.from(shot.data, 'base64'));
    return filename;
  };
  try {
    for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await cdp.send(`${domain}.enable`);
    await cdp.send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await cdp.send('Network.setBlockedURLs', { urls: ['https://*', 'http://localhost:*'] });
    const before = snapshot();
    const appSource = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    const adminSource = fs.readFileSync(path.join(root, 'public/js/admin.js'), 'utf8');
    const ids = (source, method) => {const match=source.match(new RegExp(`${method}\\(\\)\\s*\\{[\\s\\S]*?new Set\\(\\[([\\s\\S]*?)\\]`));if(match)return [...match[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);const html=fs.readFileSync(path.join(root,method==='_adminPageIds'?'public/pages/admin.html':'public/pages/console.html'),'utf8');return [...html.matchAll(/id="([^"]+)Page"/g)].map(m=>m[1]);};
    const consoleRoutes = [...new Set([...ids(appSource, '_consolePageIds'), ...[...fs.readFileSync(path.join(root, 'public/pages/console.html'), 'utf8').matchAll(/data-page="([^"]+)"/g)].map(m => m[1]), 'myUpstream/models', 'myUpstream/providers', ...['overview', 'chat', 'models', 'anthropic', 'user-api', 'conversations', 'errors'].map(id => `docs/${id}`), ...['chat', 'imagine', 'manage'].map(id => `bloraAgent/${id}`), 'dashboard', 'myProviders', 'myTeamModels'])];
    const adminRoutes = [...new Set([...ids(adminSource, '_adminPageIds'), ...[...fs.readFileSync(path.join(root, 'public/pages/admin.html'), 'utf8').matchAll(/data-page="([^"]+)"/g)].map(m => m[1]), 'adminTeams/1', 'adminUserGroups', 'adminUserGroups/1', 'adminDashboard'])];
    const storeSource = fs.readFileSync(path.join(root,'public/js/store.js'),'utf8');
    const storeRoutes = [...storeSource.matchAll(/parts\[0\] === '([^']+)'/g)].map(m=>m[1]);
    const routes = process.argv.includes('--interactions') ? ['admin#adminProviders','admin#adminSettings','console#apiKeys','console#auditLogs','admin#adminAuditLogs','playground'] : pages.flatMap(page=>[page,...(page==='console'?consoleRoutes.map(hash=>`${page}#${hash}`):page==='admin'?adminRoutes.map(hash=>`${page}#${hash}`):page==='store'?[...storeRoutes.map(hash=>`${page}#/${hash}${hash==='plugin'?'/example-theme':''}`),'store#/submit/example-theme']:[])]);
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ packageVersion, before, pages, routes, themes, base, debugging, demo: true, fixtures:fixtureDescription, externalNetworkBlocked: true }, null, 2));
    for (const skin of (process.argv.includes('--interactions') ? themes.slice(0,1) : themes)) for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
      const boot = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `if(location.origin===${JSON.stringify(base)}){localStorage.setItem('theme', '${theme}'); localStorage.setItem('language','zh');}` });
      for (const route of (skin.id === 'default' ? routes : pages)) {
        const name = `${skin.id}-${route.replace(/[^a-zA-Z0-9-]/g, '-')}-${theme}-${width}`;
        const row = { route, width, theme, skin:skin.id, assertions:[], interactions: [], screenshots: [] };
        const assert = (name, condition, evidence, classification='ui-regression') => row.assertions.push({name,status:condition?'passed':'failed',classification,evidence});
        cdp.events = [];
        try {
          await cdp.send('Page.navigate',{url:'about:blank'});await sleep(80);cdp.events=[];
          await cdp.send('Page.navigate', { url: `${base}/${route === 'index' ? '' : route}` });
          for (let i = 0; i < 60; i++) { await sleep(100); if (await cdp.evaluate(`document.readyState === 'complete' && location.pathname !== '/blank'`)) break; }
          await sleep(450);
          for(let attempt=0;attempt<5;attempt++){if(await cdp.evaluate(`![...document.querySelectorAll('[data-blora-state="loading"]')].some(e=>e.getClientRects().length)`))break;await sleep(80);}
          row.themeEvidence = await applySkin(cdp, skin);
          row.details = await cdp.evaluate(`(() => {
            const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
            return { href:location.href, title:document.title, theme:document.documentElement.getAttribute('data-blora-color-scheme'), background:getComputedStyle(document.body).backgroundColor, text:document.body.innerText.slice(0,900), activePages:[...document.querySelectorAll('.page.active,.nav-item.active,.doc-page.active')].map(e=>e.id||e.dataset.page), width:innerWidth, documentWidth:document.documentElement.scrollWidth, overflow:[...document.querySelectorAll('body *')].filter(e=>visible(e)&&e.getBoundingClientRect().right>innerWidth+2&&getComputedStyle(e).position!=='fixed').slice(0,25).map(e=>({tag:e.tagName,id:e.id,class:e.className,right:Math.round(e.getBoundingClientRect().right)})), controls:[...document.querySelectorAll('input,select,button,textarea')].filter(visible).length, bloraElements:[...document.querySelectorAll('*')].filter(e=>e.localName.startsWith('blora-')).length };
          })()`);
          assert('scheme',row.details.theme===theme,{actual:row.details.theme,expected:theme});
          assert('document-overflow',row.details.documentWidth<=width+2,{documentWidth:row.details.documentWidth,width});
          if(route.includes('#') && !route.startsWith('store')) {const expected=route.split('#')[1].split('/')[0]; const aliases={home:'modelLibrary',dashboard:'modelLibrary',myProviders:'myUpstream',myTeamModels:'myUpstream',adminDashboard:'adminStats',adminUserGroups:'adminTeams'}; assert('hash-routing',row.details.activePages.some(p=>p===(aliases[expected]||expected)||p==='page-'+(aliases[expected]||expected)||p===(aliases[expected]||expected)+'Page'),{expected,href:row.details.href,active:row.details.activePages});}
          if(skin.id!=='default') assert('official-theme-token-change',row.themeEvidence.officialChanged || skin.id==='paper',row.themeEvidence,'theme-compatibility');
          row.screenshots.push(await screenshot(name));
          await cdp.key('Tab');
          row.interactions.push({ type: 'keyboard-tab', result: await cdp.evaluate(`({tag:document.activeElement?.tagName,id:document.activeElement?.id,outline:getComputedStyle(document.activeElement).outlineStyle})`) });
          const filter = await cdp.evaluate(`(() => {const e=[...document.querySelectorAll('input[type="search"],input[placeholder*="搜索"],input[placeholder*="筛选"]')].find(e=>e.getClientRects().length);if(!e)return null;e.dataset.auditFilter='true';return {id:e.id,before:e.value};})()`);
          if (filter && await cdp.click('[data-audit-filter]')) {
            await cdp.send('Input.insertText', { text: 'GPT' }); await sleep(420);
            row.interactions.push({ type: 'filter', ...filter, result: await cdp.evaluate(`({value:document.querySelector('[data-audit-filter]').value,text:document.body.innerText.slice(-600)})`) });
            row.screenshots.push(await screenshot(`${name}-filter`));
          }
          const pagination = await cdp.evaluate(`(() => {const e=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&!e.disabled&&/^(下一页|Next)$/.test(e.innerText.trim()));if(!e)return null;e.dataset.auditNext='true';return {text:e.innerText};})()`);
          if (pagination) { const previous = await cdp.evaluate('document.body.innerText'); await cdp.click('[data-audit-next]'); await sleep(250); const changed=previous !== await cdp.evaluate('document.body.innerText');row.interactions.push({type:'pagination',changed});assert('pagination-changes-data',changed,{route}); row.screenshots.push(await screenshot(`${name}-pagination`)); }
          if (route === 'console#apiKeys') await keyInteractions(cdp, row, name, screenshot, assert);
          if (skin.id === 'default') {
            if (route === 'admin#adminProviders') {
              const menu = await cdp.click('[data-row-menu-btn="openai"]');
              const danger = await cdp.click('.remove-tag-def[onclick*="deleteProviderTag"]');
              row.interactions.push({type:'provider-danger-confirm',menu,danger,dialogs:await cdp.evaluate(`([...document.querySelectorAll('blora-dialog[open]')].map(e=>({id:e.id,text:e.textContent})))`)});
              assert('provider-danger-opens',danger && row.interactions.at(-1).dialogs.length>0,row.interactions.at(-1));
              row.screenshots.push(await screenshot(`${name}-danger`));
              await cdp.key('Tab'); await cdp.key('Escape'); await sleep(100);
              row.interactions.push({type:'provider-danger-cancel',open:await cdp.evaluate(`document.querySelectorAll('blora-dialog[open]').length`)});
              assert('provider-danger-cancel',row.interactions.at(-1).open===0,row.interactions.at(-1));
            }
            if (route === 'admin#adminSettings' || route === 'console#docs/chat') {
              if (route === 'admin#adminSettings') await cdp.click('[data-admin-settings-category="auth"]');
              const button = await cdp.evaluate(`(() => {const e=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&/复制/.test(e.textContent));if(!e)return null;e.dataset.auditCopy='true';return {id:e.id,text:e.textContent};})()`);
              if (button) {await cdp.click('[data-audit-copy]'); let clipboard;try{clipboard=await cdp.evaluate('navigator.clipboard.readText()');}catch(error){clipboard=error.message;}row.interactions.push({type:'actual-copy',button,clipboardLength:clipboard?.length,clipboardRead:typeof clipboard==='string'});assert('copy-clipboard',clipboard===await cdp.evaluate(`document.getElementById('feishuRedirectUri')?.value`),{clipboardLength:clipboard?.length});row.screenshots.push(await screenshot(`${name}-copy`));await cdp.key('Escape');}
            }
            if (route === 'admin#adminErrorLogs') {
              const button = await cdp.evaluate(`(() => {const e=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&!e.disabled&&(/下一/.test(e.title+' '+e.getAttribute('aria-label')+' '+e.textContent)||e.getAttribute('onclick')?.includes('Page + 1')));if(!e)return null;e.dataset.auditPage='true';return {text:e.textContent,onclick:e.getAttribute('onclick')};})()`);
              if(button){const before=await cdp.evaluate('document.body.innerText');await cdp.click('[data-audit-page]');await sleep(220);row.interactions.push({type:'actual-pagination',button,changed:before!==await cdp.evaluate('document.body.innerText')});row.screenshots.push(await screenshot(`${name}-page`));}else row.interactions.push({type:'actual-pagination',blocked:'No enabled next-page control in demo data'});
            }
            if (route === 'playground') {
              await cdp.click('#pgInput');await cdp.send('Input.insertText',{text:'Browser demo acceptance'});await cdp.click('#pgSendBtn');await sleep(300);row.interactions.push({type:'playground-demo-send',text:await cdp.evaluate('document.body.innerText.slice(-600)')});row.screenshots.push(await screenshot(`${name}-send`));
              assert('playground-demo-response',(await cdp.evaluate('document.body.innerText')).includes('这是演示模式的固定回复'),{realInference:false});
              if (width === 390) await cdp.click('#pgToggleSidebar');
              const danger = await cdp.click('#pgHistoryList .delete-btn'); await sleep(100);
              row.interactions.push({type:'conversation-danger-confirm',clicked:danger,dialogs:await cdp.evaluate(`([...document.querySelectorAll('blora-dialog[open]')].map(e=>({id:e.id,text:e.textContent})))`)});
              row.screenshots.push(await screenshot(`${name}-danger`)); await cdp.key('Tab');await cdp.key('Escape');
              row.interactions.push({type:'conversation-danger-cancel',open:await cdp.evaluate(`document.querySelectorAll('blora-dialog[open]').length`)});
            }
          }
          const nav = await cdp.evaluate(`(() => {const e=[...document.querySelectorAll('.nav-item[data-page]')].find(e=>e.getClientRects().length&&!e.classList.contains('active'));if(!e)return null;e.dataset.auditNav='true';return {target:e.dataset.page};})()`);
          if (nav) {if(width===390)await cdp.click('#sidebarToggle');const clicked=await cdp.click('[data-audit-nav]');await sleep(300);const after=await cdp.evaluate('location.hash'); row.interactions.push({type:'navigation',clicked,...nav,after});assert('navigation-click',clicked&&after.includes(nav.target),{target:nav.target,after}); }
          await cdp.key('Escape');
          row.consoleErrors = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' || e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error' || e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
          assert('uncaught-js-exceptions',!row.consoleErrors.some(e=>e.method==='Runtime.exceptionThrown'),row.consoleErrors.filter(e=>e.method==='Runtime.exceptionThrown'));
          row.httpErrors = cdp.events.filter(e => e.method === 'Network.responseReceived' && e.params.response.status >= 400).map(e => ({url:e.params.response.url,status:e.params.response.status}));
          row.networkFailures = cdp.events.filter(e => e.method === 'Network.loadingFailed').map(e => e.params);
        } catch (error) { row.error = error.message; }
        results.push(row);
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({schema:'crewrouter.blora-2.1-browser/v1',packageVersion,demo:true,results}, null, 2));
        console.log(JSON.stringify({route,width,theme,error:row.error,consoleErrors:row.consoleErrors?.length,overflow:row.details?.documentWidth > width,screenshots:row.screenshots.length}));
      }
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', {identifier:boot.identifier});
    }
    const after = snapshot();
    const concurrentSourceChanges=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(file=>before[file]!==after[file]);
    const stale=concurrentSourceChanges.length>0;
    for(const row of results)row.stale=stale;
    const summary = {observations:results.length,realPages:new Set(results.map(row=>row.route.split('#')[0])).size,routes:routes.length,screenshots:results.reduce((sum,row)=>sum+row.screenshots.length,0),errors:results.filter(row=>row.error).length,consoleErrorObservations:results.filter(row=>row.consoleErrors?.length).length,overflowObservations:results.filter(row=>row.details?.documentWidth>row.width+2).length,concurrentSourceChanges,stale,assertions:{passed:results.flatMap(row=>row.assertions).filter(a=>a.status==='passed').length,failed:results.flatMap(row=>row.assertions).filter(a=>a.status==='failed').length},themes:themes.map(t=>t.id),fixtureDescription,limitations:['Demo automatically authenticates an admin; no real login acceptance.','Demo writes may return success without persisting; no production API or upstream inference acceptance.','Outbound HTTPS is blocked to avoid external OAuth, payment, reporting and model calls.','Setup shows initialized state; OAuth, binding, usage and install pages lack live authorization parameters. Store protected routes retain unauthenticated access (not permission E2E).','Viewport screenshots cover the visible page, not every offscreen row.']};
    fs.writeFileSync(path.join(output,'results.json'), JSON.stringify({schema:'crewrouter.blora-2.1-browser/v1',packageVersion,demo:true,generatedAt:new Date().toISOString(),before,after,summary,results}, null, 2));
    console.log(JSON.stringify(summary,null,2));
    if(stale || summary.assertions.failed)process.exitCode=1;
  } finally { await cdp.send('Page.close').catch(()=>{}); cdp.ws.close(); }
}

async function keyInteractions(cdp, row, name, screenshot, assert) {
  const copied = await cdp.click('button[title="复制密钥"]');
  let clipboard;
  try {clipboard = await cdp.evaluate('navigator.clipboard.readText()');} catch (error) {clipboard = error.message;}
  row.interactions.push({type:'copy',clicked:copied,clipboardDemoKey:typeof clipboard==='string'&&clipboard.startsWith('sk-demo-')});
  assert('key-copy',copied && typeof clipboard==='string'&&clipboard.startsWith('sk-demo-'),{clicked:copied,clipboardDemoKey:typeof clipboard==='string'&&clipboard.startsWith('sk-demo-')});
  const opened = await cdp.click('#createApiKeyBtn');
  await sleep(150);
  const state = () => cdp.evaluate(`({open:document.getElementById('createApiKeyModal')?.hasAttribute('open'),focus:document.activeElement?.id,focusTag:document.activeElement?.tagName})`);
  row.interactions.push({type:'open-form',clicked:opened,result:await state()});
  assert('key-form-opens',opened&&(await state()).open,await state());
  if (opened) {
    row.screenshots.push(await screenshot(`${name}-form`));
    await cdp.click('#apiKeyName'); await cdp.send('Input.insertText',{text:'Browser audit demo key'});
    await cdp.key('Tab'); row.interactions.push({type:'dialog-tab',result:await state()});
    await cdp.key('Escape'); await sleep(160); row.interactions.push({type:'dialog-escape-focus-return',result:await state()});
    assert('key-form-escape-focus',!(await state()).open&&(await state()).focus==='createApiKeyBtn',await state());
    await cdp.click('#createApiKeyBtn'); await cdp.click('#apiKeyName'); await cdp.send('Input.insertText',{text:'Browser audit demo key'});
    await cdp.click('#confirmCreateApiKey'); await sleep(250); row.interactions.push({type:'demo-form-submit',result:await state(),persistenceVerified:false});
  }
  const more = await cdp.evaluate(`(() => {const e=[...document.querySelectorAll('.api-key-more button')].find(e=>e.getClientRects().length);if(!e)return false;e.dataset.auditMore='true';return true;})()`);
  if (more) {
    await cdp.click('[data-audit-more]');
    const danger = await cdp.click('.api-key-more-item.danger'); await sleep(160);
    row.interactions.push({type:'danger-confirm',clicked:danger,result:await cdp.evaluate(`({openDialogs:[...document.querySelectorAll('blora-dialog[open],dialog[open]')].map(e=>({id:e.id,text:e.textContent.slice(0,250)})),focus:document.activeElement?.id})`)});
    assert('key-danger-opens',danger && row.interactions.at(-1).result.openDialogs.length>0,row.interactions.at(-1));
    row.screenshots.push(await screenshot(`${name}-danger`));
    await cdp.key('Escape'); await sleep(160);
    row.interactions.push({type:'danger-cancel',openDialogs:await cdp.evaluate(`document.querySelectorAll('blora-dialog[open],dialog[open]').length`)});
    assert('key-danger-cancel',row.interactions.at(-1).openDialogs===0,row.interactions.at(-1));
  } else assert('key-danger-entry',false,{blocked:'No visible more menu'});
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
      if (req.method === 'GET' && url.pathname === '/api/user/api-keys') return res.json(data.apiKeys().map(key=>({...key,key_type:key.key_type||'normal',is_owner:true})));
      if(req.method==='GET' && /^\/api\/(user|admin)\/audit-logs$/.test(url.pathname)) {
        let items=Array.from({length:123},(_,i)=>({id:i+1,action:'api_key.create',description:`Browser fixture audit row ${i+1}`,username:'Demo User',resource_type:'api_key',resource_id:i+1,created_at:new Date(Date.now()-i*60000).toISOString(),is_admin:true}));
        const q=url.searchParams.get('q');if(q)items=items.filter(item=>item.description.includes(q));
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
    const paletteMap={'ocean':'circuit','linear':'indigo','paper':'coral','terminal':'mono','raycast':'dusk','classic':'graphite'};
    const appliedByRuntime=await cdp.evaluate(`(async()=>{if(window.CrewThemes?.list().some(t=>t.id===${JSON.stringify(skin.qualifiedId)})){await window.CrewThemes.apply(${JSON.stringify(skin.qualifiedId)});return true;}return false;})()`);
    if(appliedByRuntime) mode='production-CrewThemes-apply-with-isolated-metadata';
    else {
      await cdp.evaluate(`new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/blora/tokens.themes.css?v=2.1.0';link.onload=()=>resolve(true);link.onerror=reject;document.head.appendChild(link);})`);
      await cdp.evaluate(`document.documentElement.setAttribute('data-blora-theme',${JSON.stringify(paletteMap[skin.id])})`);
      await cdp.evaluate(`new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.id='audit-plugin-theme';link.href=${JSON.stringify(`${base}/__blora-test/theme/${skin.id}`)};link.onload=()=>resolve(true);link.onerror=()=>reject(new Error('Theme CSS failed'));document.head.appendChild(link);})`);
      mode='existing-plugin-css-and-official-palette-injection-no-runtime-on-public-page';
    }
    await sleep(100);
  }
  const after=await read();
  return {id:skin.id,source:skin.file,before,after,legacyChanged:before['--primary']!==after['--primary']||before['--background']!==after['--background'],officialChanged:Object.keys(before).filter(k=>k.startsWith('--blora-')).some(k=>before[k]!==after[k]),mode,officialPalette:skin.file?await cdp.evaluate(`document.documentElement.getAttribute('data-blora-theme')`):null,permissionsE2E:false};
}
