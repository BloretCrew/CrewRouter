#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18771';
const debugging = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18772';
const output = process.env.MODEL_TRACE_OUTPUT || '/tmp/crewrouter-model-trace-browser';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const malicious = '<img src=x onerror="window.modelTraceXss=1">' + '长模型名'.repeat(12);

if (process.argv.includes('--server')) startServer();
else if (process.argv.includes('--chrome')) startChrome();
else main().catch(error => { console.error(error.stack); process.exitCode = 1; });

function startChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'model-trace-chrome-'));
  const child = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${new URL(debugging).port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => { fs.rmSync(profile, { recursive: true, force: true }); process.exit(code || 0); });
}

function startServer() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'model-trace-demo-'));
  for (const key of Object.keys(process.env)) if (/^(CR(?:W)?_|DATABASE_URL$|PG(HOST|PORT|USER|PASSWORD|DATABASE)$)/.test(key)) delete process.env[key];
  Object.assign(process.env, { CR_APP_HOST: '127.0.0.1', CR_APP_PORT: new URL(base).port, CR_RUNTIME: 'server', CR_EDITION: 'personal', CR_DEMO: 'true', CR_CONFIG_PATH: path.join(scratch, 'config.json'), CR_LOGIN_REPORT_ENABLED: 'false', CR_STATS_REPORT_ENABLED: 'false', CR_DB_HOST: '127.0.0.1', CR_DB_PORT: '1', CR_DB_NAME: 'model_trace_browser_isolated', CR_DB_USER: 'isolated', CR_DB_PASSWORD: 'isolated-test-only', NODE_ENV: 'test' });
  process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
  const nativeFetch = global.fetch;
  global.fetch = (url, options) => {
    const parsed = new URL(typeof url === 'string' ? url : url.url || String(url));
    if (parsed.origin !== base) throw new Error(`Fixture forbids upstream fetch: ${parsed.origin}`);
    return nativeFetch(url, options);
  };
  installFixtures();
  require('../server/index');
}

function installFixtures() {
  const express = require('express');
  const original = express.application.init;
  const state = { jobs: [], requests: [], created: 0, canceled: 0, simulatedProbes: 0, forbidden: 0, failReads: false, nextStatus: 'completed', edition: 'personal', runtime: 'server' };
  const timers = new Set();
  process.on('exit', () => { for (const timer of timers) clearTimeout(timer); });
  express.application.init = function () {
    original.call(this);
    this.use(async (req, res, next) => {
      const url = new URL(req.url, base), route = url.pathname;
      if (route === '/auth/me' && req.headers.referer?.includes('/__model-trace/edition-page')) return res.status(401).json({error:'Isolated logged-out edition fixture'});
      if (route === '/auth/status') return res.json({loggedIn:false,authenticated:false,setupRequired:false,hasAdmin:true,authMode:'password'});
      if (route === '/api/setup/status') return res.json({setupRequired:false,initialized:true});
      if (route === '/__model-trace/edition-page') return res.sendFile(path.join(root,'public/pages/index.html'));
      if (route === '/api/instance') return res.json({ runtime: state.runtime, edition: state.edition, auth: { required: state.edition === 'team', methods: state.edition === 'team' ? ['password', 'feishu'] : [] }, capabilities: { ai: true, modelLibrary: true, models: true, providers: true, personalProviders: true, playground: true, apiKeys: true, usage: true, adminStats: true, auditLogs: true } });
      if (route === '/__model-trace/state') return res.json(state);
      if (route === '/__model-trace/control' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const command = JSON.parse(raw || '{}');
        if (command.reset) { for (const timer of timers) clearTimeout(timer); timers.clear(); Object.assign(state, { jobs: [], requests: [], created: 0, canceled: 0, simulatedProbes: 0, forbidden: 0, failReads: false, nextStatus: 'completed', edition: 'personal', runtime: 'server' }); }
        if (command.edition) state.edition = command.edition;
        if (command.runtime) state.runtime = command.runtime;
        if (command.seedHistory) for (let i = 0; i < 12; i++) state.jobs.push({ id: 'history-' + i, status: i === 0 ? 'partial' : i === 1 ? 'interrupted' : 'completed', target: { model_id: 'gpt-4.1', model_name: 'History ' + i, key_label: 'Fixture key' }, valid_outputs: i === 0 ? 1 : 3, attempted: 3, probes: [], created_at: new Date().toISOString(), error: i === 1 ? 'Fixture restart interruption' : null, result: i === 1 ? null : { results: [{ model: 'History candidate', probability: 0.5 }], family_probabilities: [], used_outputs: i === 0 ? 1 : 3 } });
        if (command.advanceProbe) {
          const job = state.jobs.find(j => j.id === command.advanceProbe);
          if (job?.status === 'running') {
            state.simulatedProbes++; job.attempted++; job.valid_outputs = job.fixtureFinal === 'failed' ? 0 : job.attempted;
            job.probes.push({ ordinal: job.attempted, status: job.fixtureFinal === 'failed' ? 'failed' : 'completed', number_count: 355, expected_count: 320 });
            if (job.attempted === 3) { job.status = job.fixtureFinal; if (job.status === 'failed') job.error = 'Fixture HTTP 429 ' + malicious;
              else job.result = { results: [{ model: malicious, display_name: malicious, probability: 0.75, similarity: 0.8 }], family_probabilities: [{ family: 'Fixture family', display_name: 'Fixture family', probability: 0.75 }], used_outputs: 3 };
            }
          }
        }
        if ('failReads' in command) state.failReads = command.failReads;
        if (command.nextStatus) state.nextStatus = command.nextStatus;
        return res.json({ ok: true });
      }
      if (/^\/v1\//.test(route)) { state.forbidden++; return res.status(503).json({ error: 'Real upstream disabled in browser fixture' }); }
      const match = route.match(/^\/api\/(user|admin)\/model-trace(?:\/(.*))?$/);
      if (req.method === 'GET' && /\/sessions\/[^/]+\/summary$/.test(route)) return res.json({ summary: null });
      if (req.method === 'POST' && /\/sessions\/[^/]+\/summary$/.test(route)) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write('data: ' + JSON.stringify({ type: 'delta', text: 'Fixture summary in progress' }) + '\n\n');
        const timer = setTimeout(() => { timers.delete(timer); res.end('data: ' + JSON.stringify({ type: 'done', summary: 'Fixture summary complete' }) + '\n\n'); }, 20000);
        timers.add(timer); return;
      }
      if (!match) return next();
      state.requests.push({ method: req.method, path: req.url });
      const suffix = match[2] || '';
      if (req.method === 'GET' && state.failReads && suffix.startsWith('jobs')) return res.status(503).json({ error: 'Fixture query temporarily unavailable' });
      if (req.method === 'GET' && suffix === 'targets') return res.json({ targets: require('../server/demo/data').adminModels().map(model => ({ model_id: model.id, model_name: model.name, provider_id: model.provider, provider_name: model.provider_name, keys: [{ id: 'fixture-key', key_id: 'fixture-key', label: 'Fixture key ••••1234', enabled: true }, { id: 'fixture-second', key_id: 'fixture-second', label: 'Second key ••••5678', enabled: true }] })) });
      if (req.method === 'GET' && suffix === 'bank') { const metadata = JSON.parse(fs.readFileSync(path.join(root,'public/vendor/modeltrace/metadata.json'))); const bank = JSON.parse(fs.readFileSync(path.join(root,'public/vendor/modeltrace/data/unified_bank.json'))); return res.json({ ...metadata, version: metadata.algorithm_version, bank_version: metadata.bank_hash, candidates: bank.models.map(m=>({id:m.id,name:m.display_name,family:m.family})), notice: '候选库内概率仅供实验参考' }); }
      if (req.method === 'GET' && suffix === 'jobs') { const page = Number(url.searchParams.get('page') || 1), limit = Number(url.searchParams.get('limit') || 20); return res.json({ jobs: state.jobs.slice((page - 1) * limit, page * limit), total: state.jobs.length, page }); }
      if (req.method === 'GET' && /^jobs\/[^/]+$/.test(suffix)) {
        const job = state.jobs.find(j => String(j.id) === suffix.split('/')[1]);
        return job ? res.json({ job }) : res.status(404).json({ error: 'Unknown fixture job' });
      }
      if (req.method === 'POST' && suffix === 'jobs') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || '{}');
        const job = { id: 'fixture-' + ++state.created, status: 'running', model_id: body.model_id, model_name: malicious, provider_name: 'Fixture provider', key_label: 'Fixture key ••••1234', budget: 3, attempted: 0, valid_outputs: 0, created_at: new Date().toISOString(), probes: [], target: { model_id: body.model_id, model_name: malicious, provider_name: 'Fixture provider', key_label: 'Fixture key ••••1234' } };
        state.jobs.unshift(job);
        job.fixtureFinal = state.nextStatus;
        return res.status(202).json({ job });
      }
      if (req.method === 'POST' && /^jobs\/[^/]+\/cancel$/.test(suffix)) {
        const job = state.jobs.find(j => String(j.id) === suffix.split('/')[1]);
        if (!job) return res.status(404).json({ error: 'Unknown fixture job' });
        state.canceled++; job.status = 'canceled'; return res.json({ job });
      }
      return res.status(501).json({ error: `Unimplemented fixture contract ${req.method} ${suffix}` });
    });
  };
}

class CDP {
  constructor(url) {
    this.id = 0; this.pending = new Map(); this.events = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id) { this.events.push(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
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
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async click(selector) {
    await this.evaluate(`(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&!e.disabled);if(!e)return;const r=e.getBoundingClientRect();if(!e.matches('.blora-dropdown__item')||r.top<0||r.bottom>innerHeight)e.scrollIntoView({block:'center',behavior:'instant'});})()`);
    await sleep(500);
    const point = await this.evaluate(`(() => { const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&!e.disabled); if(!e)return null;const r=e.getBoundingClientRect();const x=(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,y=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;const hit=document.elementFromPoint(x,y);return hit===e||e.contains(hit)?{x,y}:null;})()`);
    if (!point) throw new Error(`Visible, unobstructed click target ${selector}; ` + JSON.stringify(await this.evaluate(`(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length&&!e.disabled);if(!e)return {missing:true};const r=e.getBoundingClientRect();const h=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,r.x+r.width/2)),Math.max(0,Math.min(innerHeight-1,r.y+r.height/2)));return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:h?.outerHTML.slice(0,300)};})()`)));
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(200);
  }
  async input(selector, text) {
    await this.click(selector);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await this.send('Input.insertText', { text });
  }
  async key(key) {
    const code = { Escape: 27, Enter: 13, Tab: 9, ArrowDown: 40 }[key];
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
    await sleep(200);
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  assert.equal((await fetch(`${base}/api/config`).then(r => r.json())).demo, true, 'Refuse non-demo server');
  const target = await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  const results = [];
  try {
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `if(location.origin===${JSON.stringify(base)}){sessionStorage.removeItem('modelTraceDismissed')}` });
    await cdp.send('Browser.grantPermissions', {origin:base,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
    await cdp.send('Network.setBlockedURLs', { urls: ['https://*', 'http://localhost:*'] });
    for (const [width, height] of [[1440, 900], [1024, 720], [390, 844]].filter(([width]) => !process.env.MODEL_TRACE_WIDTHS || process.env.MODEL_TRACE_WIDTHS.split(',').includes(String(width)))) {
      const row = { width, height, assertions: [] };
      const check = async (expression, label) => { const passed = !!await cdp.evaluate(expression); row.assertions.push({ label, passed }); assert.ok(passed, label); };
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width === 390 });
        await cdp.send('Page.navigate', { url: 'about:blank' });
        await wait(cdp, "location.href==='about:blank'");
        await control({ reset: true });
        await cdp.send('Page.navigate', { url: `${base}/console#modelTrace` });
        await wait(cdp, '!!window.ModelTrace');
        await check("!!document.querySelector('script[type=module][src*=model-trace]')", 'HTML loads real ModelTrace module');
        await scenarios(cdp, check, row);
      } catch (error) { row.error = error.stack; row.stateOnError = await fixtureState(); row.exceptions = cdp.events.filter(e=>e.method==='Runtime.exceptionThrown'); try { row.dialogOnError = await cdp.evaluate("document.querySelector('.trace-dialog')?.textContent"); } catch (_) {} console.error(`FAIL ${width}x${height}: ${error.message}`); }
      try { const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, `${width}x${height}.png`), Buffer.from(shot.data, 'base64')); } catch (error) { row.screenshotError = error.message; }
      results.push(row);
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results }, null, 2));
    }
    const summary = { generatedAt: new Date().toISOString(), passed: results.flatMap(r => r.assertions).filter(a => a.passed).length, failed: results.flatMap(r => r.assertions).filter(a => !a.passed).length, errors: results.filter(r => r.error).length, state: await fixtureState(), limitations: ['Frontend fixture only; no production runner, database, billing, real upstream or attribution accuracy is verified.'] };
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, summary }, null, 2));
    console.log(JSON.stringify(summary));
    if (summary.failed || summary.errors) process.exitCode = 1;
  } finally { for (const pending of cdp.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP closed')); } cdp.pending.clear(); cdp.ws.close(); await fetch(`${debugging}/json/close/${target.id}`); }
}
async function wait(cdp, expression, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await cdp.evaluate(expression)) return; await sleep(100); }
  throw new Error(`Timeout: ${expression}`);
}
async function fixtureState() { return fetch(`${base}/__model-trace/state`).then(r => r.json()); }
async function control(command) { return fetch(`${base}/__model-trace/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }).then(r => r.json()); }
async function navigate(cdp, page) {
  await wait(cdp, "!document.querySelector('blora-dialog[open]')");
  await sleep(450);
  const visible = await cdp.evaluate(`!![...document.querySelectorAll('.blora-sidebar-nav__link[data-value="${page}"]')].find(e=>{const r=e.getBoundingClientRect();return e.getClientRects().length&&r.left>=0&&r.right<=innerWidth})`);
  if (!visible) await cdp.click('#sidebarToggle');
  await cdp.click(`.blora-sidebar-nav__link[data-value="${page}"]`);
  await wait(cdp, `document.getElementById('${page}Page')?.classList.contains('active')`);
  await wait(cdp, "!document.getElementById('mobileSidebarDrawer')?.hasAttribute('open')"); await sleep(500);
}
async function confirmation(cdp, yes) {
  await wait(cdp, "!!document.querySelector('blora-dialog[open] [data-dialog-confirm]')");
  await cdp.click(yes ? 'blora-dialog[open] [data-dialog-confirm]' : 'blora-dialog[open] [data-dialog-cancel]');
  await wait(cdp, "!document.querySelector('blora-dialog[open] [data-dialog-confirm]')");
}
async function scenarios(cdp, check, row) {
  await control({ reset: true });
  await cdp.send('Page.reload'); await sleep(1500);
  await wait(cdp, '!!window.ModelTrace');
  await wait(cdp, "!!document.querySelector('#modelTraceContent [data-trace-action=generate]')");
  await wait(cdp, "document.querySelector('#modelTraceHistory')?.textContent.includes('暂无检测历史')");
  await check("document.querySelector('#modelTraceHistory').textContent.includes('暂无检测历史')", 'Empty history actionable state');
  await wait(cdp,"document.querySelector('#modelTraceBank')?.textContent.includes('ModelTrace')");
  await check("document.querySelector('#modelTraceBank').textContent.includes('ModelTrace')", 'Bank API metadata displayed');
  await cdp.click('#modelTraceContent [data-trace-action=generate]');
  await wait(cdp, "document.querySelectorAll('[data-trace-answer]').length===3");
  await cdp.click('[data-trace-action=copy][data-index="0"]');
  await check("document.querySelector('[data-trace-action=copy][data-index=\"0\"]').textContent.includes('已复制')", 'Real challenge copy');
  await cdp.click('#modelTraceContent [data-trace-action=analyze]');
  await check("document.querySelector('#modelTraceManualResult').textContent.includes('请先粘贴')", 'Empty manual answer actionable error');
  await cdp.input('[data-trace-answer="0"]', '拒绝回答 1 2 3'); await cdp.click('#modelTraceContent [data-trace-action=analyze]');
  await check("document.querySelector('#modelTraceManualResult').textContent.includes('没有有效回答')", 'Truncated/refusal answer actionable error');
  const sequence = Array.from({ length: 355 }, (_, i) => i + 1).join(', ');
  for (let count = 1; count <= 3; count++) {
    await cdp.input(`[data-trace-answer="${count - 1}"]`, sequence);
    await cdp.click('#modelTraceContent [data-trace-action=analyze]');
    const passed = await cdp.evaluate(`!!document.querySelector('#modelTraceManualResult .trace-result') && document.querySelector('#modelTraceManualResult').textContent.includes('${count}/3') && document.querySelector('#modelTraceManualResult ol')?.children.length>0`);
    row.assertions.push({ label: `Manual ${count}/3 real ESM attribution`, passed });
    if (!passed) row.manualError = await cdp.evaluate("document.querySelector('#modelTraceManualResult').textContent");
  }
  assert.equal((await fixtureState()).created, 0, 'Manual computation has no API create');
  row.assertions.push({ label: 'Manual mode never POSTs trace API or uploads answers', passed: !(await fixtureState()).requests.some(r => r.method === 'POST') });
  await cdp.click('#modelTraceContent [data-trace-action=generate]'); await confirmation(cdp, false);
  await check("document.querySelector('[data-trace-answer]').value.length>0", 'Regenerate cancel retains answer');
  await cdp.click('#modelTraceContent [data-trace-action=generate]'); await confirmation(cdp, true);
  await check("[...document.querySelectorAll('[data-trace-answer]')].every(e=>!e.value)", 'Regenerate confirmation clears input');
  await cdp.click('#modelTraceContent [data-trace-action=open]');
  await wait(cdp, "!!document.querySelector('[data-trace-model]')");
  await cdp.click('[data-trace-key]'); await cdp.key('ArrowDown'); await cdp.key('Enter');
  await cdp.click('.trace-dialog [data-trace-action=start]'); await confirmation(cdp, false);
  assert.equal((await fixtureState()).created, 0); row.assertions.push({ label: 'Open/select/start-confirm cancellation causes zero create POST', passed: true });
  await cdp.click('.trace-dialog [data-trace-action=start]'); await confirmation(cdp, true);
  await wait(cdp, "!!document.querySelector('.trace-dialog progress')");
  assert.equal((await fixtureState()).created, 1); row.assertions.push({ label: 'Explicit confirmation creates exactly one job', passed: true });
  await cdp.click('.trace-dialog [data-trace-action=close]'); await sleep(500);
  await navigate(cdp, 'modelLibrary');
  await check("document.querySelector('#modelTraceTaskBar').textContent.includes('正在检测')", 'Close leaves background task card running');
  await wait(cdp, "!!document.querySelector('.model-library-item .library-more-trigger')");
  await cdp.click('.model-library-item .library-more-trigger');
  await cdp.click('.blora-dropdown__item[data-value*="openModelTrace"]');
  await sleep(1000);
  const libraryEntry = await cdp.evaluate("!!document.querySelector('.trace-dialog [data-trace-model]')");
  row.assertions.push({ label: 'Real model library operation menu opens attribution target', passed: libraryEntry });
  if (libraryEntry) { await cdp.click('.trace-dialog [data-trace-action=close]'); await sleep(500); } else row.libraryEntryError = 'ModelTrace.open action ignored by app-only menu whitelist';
  assert.equal((await fixtureState()).created, 1);
  await navigate(cdp, 'apiKeys'); await navigate(cdp, 'modelLibrary');
  await cdp.click('#modelTraceTaskBar [data-trace-action=view]'); await cdp.key('Escape');
  await cdp.send('Page.reload');
  await sleep(1500);
  await wait(cdp, "!!document.querySelector('#modelTraceTaskBar [data-trace-action=view]')");
  assert.equal((await fixtureState()).created, 1); row.assertions.push({ label: 'Cross-page reopen/Escape/reload restores without POST', passed: true });
  await cdp.click('#modelTraceTaskBar [data-trace-action=view]');
  for (let i=0;i<3;i++) await control({advanceProbe:'fixture-1'});
  await cdp.click('.trace-dialog [data-trace-action=refresh-job]');
  await wait(cdp, "document.querySelector('.trace-dialog')?.textContent.includes('检测完成')", 45000);
  await check("!window.modelTraceXss && !document.querySelector('.trace-dialog img') && document.querySelector('.trace-dialog').textContent.includes('<img src=x')", 'Malicious target and candidate strings escaped');
  await cdp.click('.trace-dialog [data-trace-action=close]'); await sleep(500);
  await navigate(cdp, 'modelTrace'); await cdp.click('#modelTraceHistory [data-trace-action=view]');
  await wait(cdp,"document.querySelector('.trace-dialog')?.textContent.includes('检测完成')");
  await check("document.querySelector('.trace-dialog').textContent.includes('检测完成')", 'History opens persisted fixture result');
  await cdp.click('.trace-dialog [data-trace-action=retest]'); await wait(cdp, "!!document.querySelector('[data-trace-model]')");
  await cdp.click('.trace-dialog [data-trace-action=start]'); await confirmation(cdp, true);
  await cdp.click('.trace-dialog [data-trace-action=cancel]'); await confirmation(cdp, false);
  assert.equal((await fixtureState()).canceled, 0); row.assertions.push({ label: 'Cancel confirmation declined does not cancel', passed: true });
  await cdp.click('.trace-dialog [data-trace-action=cancel]'); await confirmation(cdp, true);
  await wait(cdp, "document.querySelector('.trace-dialog')?.textContent.includes('已取消')");
  await check("document.querySelector('.trace-dialog').textContent.includes('已取消')", 'Explicit cancel renders canceled status');
  const probeCount = (await fixtureState()).simulatedProbes;
  await control({advanceProbe:'fixture-2'}); assert.equal((await fixtureState()).simulatedProbes, probeCount); row.assertions.push({ label: 'Cancel stops subsequent simulated probes', passed: true });
  await cdp.click('.trace-dialog [data-trace-action=close]'); await sleep(500);
  await control({ nextStatus: 'failed' });
  await cdp.click('#modelTraceContent [data-trace-action=open]'); await wait(cdp, "!!document.querySelector('[data-trace-model]')");
  await cdp.click('.trace-dialog [data-trace-action=start]'); await confirmation(cdp, true);
  await cdp.click('.trace-dialog [data-trace-action=close]'); await sleep(500); await navigate(cdp, 'sessions');
  await wait(cdp, "!!document.querySelector('[data-session-key]')"); await cdp.click('[data-session-key]');
  await cdp.click('#sessionDetailWrap [onclick="app.generateSessionSummary()"]');
  await cdp.key('Escape'); await navigate(cdp, 'modelLibrary');
  await check("document.querySelector('#sessionSummaryTaskBar')?.children.length>0 && document.querySelectorAll('#modelTraceTaskBar .trace-task').length>=3", 'Summary and multiple trace tasks coexist');
  await cdp.click('#modelTraceTaskBar [data-trace-action=view][data-job-id=fixture-3]');
  for(let i=0;i<3;i++) await control({advanceProbe:'fixture-3'});
  await cdp.click('.trace-dialog [data-trace-action=refresh-job]');
  row.failureWaitState = await fixtureState();
  await wait(cdp, "document.querySelector('.trace-dialog')?.textContent.includes('检测失败')", 45000);
  await check("!window.modelTraceXss && !document.querySelector('.trace-dialog img') && document.querySelector('.trace-dialog').textContent.includes('Fixture HTTP 429')", 'Failure visible with escaped detail');
  await cdp.click('.trace-dialog [data-trace-action=close]'); await sleep(500);
  await wait(cdp, "!!document.querySelector('#sessionSummaryTaskBar [onclick*=copySessionSummary]')");
  await cdp.send('Page.bringToFront');
  await cdp.click('#sessionSummaryTaskBar [onclick*=copySessionSummary]');
  await wait(cdp,"Promise.race([navigator.clipboard.readText().then(text=>text.includes('Fixture summary complete')),new Promise(resolve=>setTimeout(()=>resolve(false),300))])",5000);
  await check("navigator.clipboard.readText().then(text=>text.includes('Fixture summary complete'))", 'Summary real copy retains summary content');
  await cdp.click('#sessionSummaryTaskBar [onclick*=showSessionDetail]');
  await check("document.getElementById('sessionDetailWrap').style.display !== 'none'", 'Summary jump opens original session');
  await navigate(cdp, 'modelLibrary');
  await cdp.click('#modelTraceTaskBar [data-trace-action=dismiss][data-job-id=fixture-3]');
  await check("document.querySelector('#sessionSummaryTaskBar')?.children.length>0 && document.querySelectorAll('#modelTraceTaskBar .trace-task').length>=2", 'Dismiss one trace never removes summary or other tasks');
  await control({ failReads: true }); await navigate(cdp, 'apiKeys'); await navigate(cdp, 'modelLibrary');
  await wait(cdp, "document.querySelector('#modelTraceTaskBar')?.textContent.includes('状态暂不可用')");
  assert.equal((await fixtureState()).created, 3); row.assertions.push({ label: 'Read failure does not recreate job', passed: true });
  await control({ failReads: false }); if(await cdp.evaluate("!!document.querySelector('#modelTraceTaskBar [data-trace-action=sync]')")) await cdp.click('#modelTraceTaskBar [data-trace-action=sync]');
  await wait(cdp, "!document.querySelector('#modelTraceTaskBar .trace-error')");
  await check("!document.querySelector('#modelTraceTaskBar .trace-error')", 'Retry query recovers existing jobs');
  await check("document.documentElement.scrollWidth<=innerWidth+1", 'Viewport no horizontal overflow');
  const state = await fixtureState(); assert.equal(state.forbidden, 0); assert.equal(state.created, 3); assert.equal(state.canceled, 1);
  row.assertions.push({ label: 'Only three explicit create POSTs and one cancel POST; no real upstream', passed: true });
  await cdp.send('Page.navigate', { url: `${base}/admin#adminProviders` }); await sleep(1500);
  await wait(cdp, "!!document.querySelector('[data-row-menu-btn]')");
  await cdp.click('[data-row-menu-btn]'); await cdp.click('[data-trace-provider]'); await sleep(1000);
  const adminPassed = await cdp.evaluate("!!document.querySelector('.trace-dialog [data-trace-model]')");
  row.assertions.push({ label: 'Standalone admin provider entry real menu click', passed: adminPassed });
  if (!adminPassed) row.adminError = 'Real provider attribution menu click did not open ModelTrace dialog';
  else await cdp.key('Escape');
  await cdp.send('Page.navigate', { url: `${base}/console#myUpstream` }); await sleep(1500);
  await wait(cdp, "!!document.querySelector('#unifiedProviderManager')?.contentDocument?.querySelector('[data-row-menu-btn]')", 20000);
  const frameClick = async selector => {
    await cdp.evaluate(`(() => {const f=document.querySelector('#unifiedProviderManager');if(!${JSON.stringify(selector)}.includes('data-trace-provider'))f.scrollIntoView({block:'start'});const b=[...f.contentDocument.querySelectorAll(${JSON.stringify(selector)})].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.left<f.clientWidth});if(b && !b.matches('[data-trace-provider]'))b.scrollIntoView({block:'center'});})()`);
    await sleep(500);
    const point = await cdp.evaluate(`(() => {const f=document.querySelector('#unifiedProviderManager');const b=[...f.contentDocument.querySelectorAll(${JSON.stringify(selector)})].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.left<f.clientWidth});if(!b)return null;const r=f.getBoundingClientRect(),p=b.getBoundingClientRect();const x=(Math.max(0,p.left)+Math.min(f.clientWidth,p.right))/2,y=(Math.max(0,p.top)+Math.min(f.clientHeight,p.bottom))/2;const h=f.contentDocument.elementFromPoint(x,y);window.__traceFramePoint={rect:{left:p.left,top:p.top,right:p.right,bottom:p.bottom},frame:{left:r.left,top:r.top},width:f.clientWidth,height:f.clientHeight,hit:h?.outerHTML.slice(0,200)};const px=r.left+x,py=r.top+y;const parentHit=document.elementFromPoint(px,py);return (b===h||b.contains(h))&&parentHit===f?{x:px,y:py}:null;})()`);
    assert.ok(point, 'Real iframe clickable ' + selector + '; ' + JSON.stringify(await cdp.evaluate('window.__traceFramePoint')));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); await sleep(500);
  };
  try {
    await frameClick('[data-row-menu-btn]'); await frameClick('[data-trace-provider]'); await sleep(1000);
    const iframePassed = await cdp.evaluate("!!document.querySelector('#unifiedProviderManager').contentDocument.querySelector('.trace-dialog [data-trace-model]')");
    row.assertions.push({ label: 'Iframe provider entry real menu click', passed: iframePassed });
    if (!iframePassed) row.iframeError = 'Real iframe attribution menu click did not open ModelTrace dialog';
    else {
      await frameClick('.trace-dialog [data-trace-action=start]');
      await wait(cdp,"!!document.querySelector('#unifiedProviderManager').contentDocument.querySelector('[data-dialog-confirm]')");
      await frameClick('blora-dialog[open] [data-dialog-confirm]');
      await wait(cdp, "!!document.querySelector('#unifiedProviderManager').contentDocument.querySelector('.trace-dialog progress')");
      await frameClick('.trace-dialog [data-trace-action=close]'); await sleep(500);
      await navigate(cdp, 'modelLibrary');
      await wait(cdp, "!!document.querySelector('#modelTraceTaskBar [data-job-id=fixture-4]')");
      await check("document.querySelector('#modelTraceTaskBar [data-job-id=fixture-4]').closest('article').textContent.includes('正在检测')", 'Iframe explicitly started task syncs to parent task bar');
      await cdp.click('#modelTraceTaskBar [data-trace-action=cancel][data-job-id=fixture-4]'); await confirmation(cdp,true);
      await wait(cdp, "document.querySelector('#modelTraceTaskBar [data-job-id=fixture-4]').closest('article').textContent.includes('已取消')");
      await check("document.querySelector('#modelTraceTaskBar [data-job-id=fixture-4]').closest('article').textContent.includes('已取消')", 'Parent cancels iframe task');
    }
  } catch (error) { row.iframeError = error.message; row.assertions.push({ label: 'Iframe provider entry real menu click', passed: false }); }
  assert.equal((await fixtureState()).created, 4); assert.equal((await fixtureState()).canceled,2); row.assertions.push({label:'Iframe explicit POST budget counted; parent cancellation counted',passed:true});
  await control({seedHistory:true}); await navigate(cdp,'modelTrace');
  await wait(cdp,"!!document.querySelector('#modelTraceHistory [data-trace-action=next]:not(:disabled)')");
  await cdp.click('#modelTraceHistory [data-trace-action=next]');
  await wait(cdp,"document.querySelector('#modelTraceHistory').textContent.includes('History 6')");
  await check("!document.querySelector('#modelTraceHistory [data-trace-action=previous]').disabled",'History actual next-page read');
  await cdp.click('#modelTraceHistory [data-trace-action=previous]');
  await wait(cdp,"!!document.querySelector('#modelTraceHistory [data-job-id=history-0]')");
  for(const [id,text] of [['history-0','部分有效'],['history-1','执行中断']]) {
    await cdp.click(`#modelTraceHistory [data-trace-action=view][data-job-id=${id}]`);
    await wait(cdp,`document.querySelector('.trace-dialog')?.textContent.includes('${text}')`);
    await check(`document.querySelector('.trace-dialog').textContent.includes('${text}')`,'History '+text+' readable');
    await cdp.click('.trace-dialog [data-trace-action=close]'); await sleep(500);
  }
  await cdp.click('#modelTraceContent [data-trace-action=open]'); await wait(cdp,"!!document.querySelector('[data-trace-model]')");
  const backdrop = await cdp.evaluate("(() => {const d=document.querySelector('blora-dialog[open]');const p=d.shadowRoot.querySelector('[part=panel],.blora-dialog__panel').getBoundingClientRect();return {x:2,y:Math.max(2,p.top/2)};})()");
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...backdrop}); await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...backdrop});
  await wait(cdp,"!document.querySelector('blora-dialog[open]')");
  await check("!document.querySelector('blora-dialog[open]')",'Real backdrop closes only presentation');
  for(const [edition,runtime,label] of [['team','server','TEAM'],['personal','server','PERSONAL'],['personal','desktop-local','LOCAL']]) {
    await cdp.send('Page.navigate',{url:'about:blank'}); await wait(cdp,"location.href==='about:blank'"); await control({edition,runtime}); await cdp.send('Page.navigate',{url:`${base}/__model-trace/edition-page`}); await sleep(1500);
    await wait(cdp,`document.querySelector('[data-edition-badge]')?.textContent==='${label}'`);
    await check(`fetch('/api/instance').then(r=>r.json()).then(instance=>document.querySelector('[data-edition-badge]').textContent==='${label}' && instance.edition==='${edition}' && instance.runtime==='${runtime}')`,'Consistent instance API '+label+' label');
  }
  await check("document.documentElement.scrollWidth<=innerWidth+1",'Final viewport no horizontal overflow');
  assert.equal((await fixtureState()).created,4); assert.equal((await fixtureState()).forbidden,0);
  row.assertions.push({label:'All navigation, history, metadata, edition and backdrop reads cause no extra POST/upstream',passed:true});
}
