#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { cases, corpus } = require('./test-playground-markdown');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv.includes('--server')) {
  startServer();
} else {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

function startServer() {
  const base = process.env.MARKDOWN_FIXTURE_URL;
  const scratch = process.env.MARKDOWN_FIXTURE_SCRATCH;
  assert.ok(base && scratch, 'server must be launched by the isolated runner');
  for (const key of Object.keys(process.env)) {
    if (/^(CR(?:W)?_|DATABASE_URL$|PG(HOST|PORT|USER|PASSWORD|DATABASE|SERVICE|SERVICEFILE)$)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    CR_APP_HOST: '127.0.0.1', CR_APP_PORT: new URL(base).port,
    CR_RUNTIME: 'server', CR_EDITION: 'team', CR_DEMO: 'true',
    CR_CONFIG_PATH: path.join(scratch, 'config.json'), CR_LOGIN_REPORT_ENABLED: 'false',
    CR_STATS_REPORT_ENABLED: 'false', CR_DB_HOST: '127.0.0.1', CR_DB_PORT: '1',
    CR_DB_NAME: 'markdown_browser_isolated', CR_DB_USER: 'isolated',
    CR_DB_PASSWORD: 'isolated-test-only', NODE_ENV: 'test'
  });
  // No outbound TCP is needed by the demo server, including database connections.
  net.Socket.prototype.connect = function () { throw new Error('Fixture server outbound TCP forbidden'); };
  const express = require('express');
  const original = express.application.init;
  let conversations = [], requests = [], release, quotaState = null;
  const vm = require('node:vm');
  const policy = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server/utils/points-deduct.js'), 'utf8'), {
    module: policy, require(id) {
      if (id === '../models/database') return { pool: {} };
      if (id === './quota-data') return { getUserQuotaBuffer: () => [] };
      if (id === './money') return require('../server/utils/money');
      throw new Error('Unexpected policy dependency: ' + id);
    },
  });
  const playground = fs.readFileSync(path.join(root, 'server/routes/playground.js'), 'utf8');
  const preflightStart = playground.indexOf('    const userResult = await pool.query(');
  const preflightEnd = playground.indexOf('    let modelResult', preflightStart);
  assert.ok(preflightStart > 0 && preflightEnd > preflightStart);
  async function preflight(res) {
    return vm.runInNewContext(`(async () => {${playground.slice(preflightStart, preflightEnd)} return true;})()`, {
      userId: 1, pool: { query: async () => ({ rows: [quotaState.account] }) }, res,
      canConsumePoints: args => policy.exports.canConsumePoints(args, { checkQuotaRules: async () => quotaState.rules }),
      notifyUser: async () => {}, NOTIFICATION_TYPES: {},
    });
  }
  express.application.init = function () {
    original.call(this);
    this.use(async (req, res, next) => {
      const pathname = new URL(req.url, base).pathname;
      if (!pathname.startsWith('/__markdown/') && !pathname.startsWith('/api/conversations') && !pathname.startsWith('/api/playground/') && pathname !== '/api/user/models' && pathname !== '/auth/me') return next();
      try {
        let body = {};
        if (['POST', 'PUT'].includes(req.method)) {
          let raw = ''; for await (const chunk of req) raw += chunk;
          body = raw ? JSON.parse(raw) : {};
        }
        requests.push({ path: pathname, method: req.method, body });
        if (pathname === '/__markdown/reset') { conversations = []; requests = []; return res.json({ ok: true }); }
        if (pathname === '/__markdown/state') return res.json({ conversations, requests });
        if (pathname === '/__markdown/release') { release?.(); return res.json({ ok: true }); }
        if (pathname === '/__markdown/quota') { quotaState = body; return res.json({ ok: true }); }
        if (pathname === '/auth/me') return res.json({ id: 1, username: 'Markdown fixture', avatar: '' });
        if (pathname === '/api/user/models') return res.json([{ id: 'fixture-model', name: 'Fixture model', provider: 'Local', model_multiplier: 1 }]);
        if (pathname === '/api/playground/thinking-capabilities') return res.json({ 'fixture-model': { supportsThinking: true } });
        if (pathname === '/api/playground/chat') {
          assert.equal(body.model, 'fixture-model');
          if (quotaState) {
            await preflight(res);
            if (res.headersSent) return;
            res.setHeader('Content-Type', 'text/event-stream');
            return res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Quota request accepted' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n');
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const delta = value => res.write('data: ' + JSON.stringify({ choices: [{ delta: value }] }) + '\n\n');
          delta({ reasoning_content: corpus });
          const middle = Math.floor(corpus.length / 2);
          delta({ content: corpus.slice(0, middle) });
          await new Promise(resolve => { release = resolve; res.on('close', resolve); });
          release = null;
          delta({ content: corpus.slice(middle) });
          res.end('data: [DONE]\n\n'); return;
        }
        if (pathname === '/api/conversations' && req.method === 'GET') return res.json(conversations);
        if (pathname === '/api/conversations' && req.method === 'POST') {
          const item = { ...body, id: conversations.length + 1, updated_at: new Date().toISOString(), messages: [] };
          conversations.push(item); return res.json(item);
        }
        const match = pathname.match(/^\/api\/conversations\/(\d+)(\/messages)?$/);
        if (match) {
          const item = conversations.find(c => c.id === Number(match[1]));
          assert.ok(item);
          if (req.method === 'PUT') Object.assign(item, body);
          return res.json(item);
        }
        return res.status(404).json({ error: 'Unexpected fixture request' });
      } catch (error) { res.status(500).json({ error: error.message }); }
    });
  };
  require('../server/index');
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async wait(expression) {
    for (let i = 0; i < 100; i++) {
      try {
        if (await this.evaluate(expression)) return;
      } catch (error) {
        if (!/Inspected target navigated|Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
      }
      await sleep(100);
    }
    throw new Error(`Timeout: ${expression}`);
  }
  async click(selector) {
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);
    await sleep(180);
    const point = await this.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),x=(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,y=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;const hit=document.elementFromPoint(x,y);return r.width&&r.height&&(hit===e||e.contains(hit))?{x,y}:null;})()`);
    assert.ok(point, `visible, unobstructed click target: ${selector}; ${await this.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});const r=e?.getBoundingClientRect();return JSON.stringify({rect:r,hit:r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,240)});})()`)}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(180);
  }
  async input(selector, text) {
    await this.click(selector);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await this.send('Input.insertText', { text });
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-markdown-browser-'));
  const children = [];
  let cdp, assertions = 0;
  const check = (condition, message) => { assert.ok(condition, message); assertions++; };
  const launch = (command, args, env, name) => {
    const log = fs.openSync(path.join(scratch, `${name}.log`), 'w');
    const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', log, log] });
    fs.closeSync(log); children.push(child);
    child.on('error', error => { child.launchError = error; });
    return child;
  };
  const stop = async () => {
    for (const child of [...children].reverse()) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
    await sleep(400);
    for (const child of [...children].reverse()) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  };
  const interrupted = async () => {
    if (cdp) cdp.ws.close();
    await stop();
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(130);
  };
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
  try {
    const port = await freePort(), chromePort = await freePort();
    const base = `http://127.0.0.1:${port}`, debugging = `http://127.0.0.1:${chromePort}`;
    launch(process.execPath, [__filename, '--server'], { ...process.env, MARKDOWN_FIXTURE_URL: base, MARKDOWN_FIXTURE_SCRATCH: scratch }, 'server');
    launch(process.env.CHROME_BIN || 'google-chrome', ['--headless=new', '--disable-extensions', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-gpu', '--no-proxy-server', '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebRTC', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-crash-reporter', '--disable-breakpad', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${path.join(scratch, 'chrome')}`, 'about:blank'], process.env, 'chrome');
    const ready = async url => {
      for (let i = 0; i < 150; i++) {
        for (const child of children) assert.ok(!child.launchError && child.exitCode === null, `child failed: ${child.launchError || child.exitCode}`);
        try { const response = await fetch(url); if (response.ok) return response.json(); } catch {}
        await sleep(100);
      }
      throw new Error(`Service not ready: ${url}`);
    };
    check((await ready(`${base}/api/config`)).demo === true, 'isolated demo server');
    await ready(`${debugging}/json/version`);
    const pageResponse = await fetch(`${base}/playground`);
    check(pageResponse.ok && (await pageResponse.text()).includes('pgSendBtn'), 'real playground HTML served');
    const target = await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
    cdp = new CDP(target.webSocketDebuggerUrl);
    for (const domain of ['Page', 'Runtime', 'Network']) await cdp.send(`${domain}.enable`);
    await cdp.send('Network.setBlockedURLs', { urls: ['https://*', 'http://localhost:*'] });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `if(location.protocol==='http:'){localStorage.setItem('language','zh');localStorage.setItem('theme','light');}` });
    const request = (route, body) => fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => { assert.ok(r.ok); return r.json(); });
    const browserCheck = async (expression, message) => check(await cdp.evaluate(expression), message);
    const failures = [];
    const verify = async (expression, message) => {
      const ok = await cdp.evaluate(expression);
      assertions++;
      if (!ok) { failures.push(message); console.error('FAIL ' + message); }
      else console.log('PASS ' + message);
    };
    const inspect = async (selector, phase, complete = true) => {
      await verify(`(() => {const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.querySelector('script,svg,img,iframe')&&[...e.querySelectorAll('*')].every(n=>[...n.attributes].every(a=>!/^on/i.test(a.name)));})()`, phase + ' no injected nodes/events');
      for (const item of cases) {
        if (!complete && cases.indexOf(item) > 7) continue;
        await verify(`(() => {const e=document.querySelector(${JSON.stringify(selector)});const a=[...e.querySelectorAll('a')].find(a=>a.textContent===${JSON.stringify(item.label)});return ${item.allowed ? "!!a&&a.target==='_blank'&&a.rel==='noopener noreferrer'&&new URL(a.getAttribute('href'),location.href).href===new URL(" + JSON.stringify(item.url) + ",location.href).href" : '!a'};})()`, phase + ' ' + item.label);
      }
      if (complete) await verify(`!document.querySelector(${JSON.stringify(selector)}).querySelector('code a')`, phase + ' code stays literal');
      await verify('window.__markdownExecuted===0', phase + ' payload not executed');
    };
    const exercise = async selector => {
      for (const label of ['quote', 'single', 'event', 'javascript', 'data']) {
        const target = await cdp.evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});return [...e.querySelectorAll('a,p')].find(n=>n.textContent===${JSON.stringify(label)})?.outerHTML;})()`);
        if (!target) continue;
        const point = await cdp.evaluate(`(() => {const e=[...document.querySelector(${JSON.stringify(selector)}).querySelectorAll('a,p')].find(n=>n.textContent===${JSON.stringify(label)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+Math.min(r.width/2,20),y:r.y+r.height/2};})()`);
        await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...point});
        await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
        await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
      }
      await verify('window.__markdownExecuted===0', 'real hover/click payload not executed');
    };
    await cdp.send('Browser.grantPermissions', {origin:base,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source:`window.__markdownExecuted=0;window.addEventListener('unhandledrejection',e=>{window.__markdownInitError=String(e.reason?.stack||e.reason);});`});
    // Prevent safe link navigation, but leave injected handlers and unsafe schemes observable.
    await cdp.send('Network.setBlockedURLs', {urls:['https://*','http://example.invalid/*','http://localhost:*',base+'/fixture/*']});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source:`document.addEventListener('click',e=>{const a=e.target.closest('a');if(a&&a.closest('.pg-msg-content,.pg-response-content')&&['http:','https:','mailto:'].includes(a.protocol))e.preventDefault();});`});
    for (const width of [1440, 390]) {
      await request('/__markdown/reset', {});
      await cdp.send('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:width===390});
      await cdp.send('Page.navigate', {url:base+'/playground'});
      await cdp.wait("document.readyState==='complete'&&(!!document.querySelector('#pgContextMenu')||!!window.__markdownInitError)");
      const initError = await cdp.evaluate('window.__markdownInitError || null');
      assert.equal(initError, null, 'real playground initialization must succeed without test shims');
      await cdp.wait("typeof pgApp!=='undefined'&&pgApp?.models.length===1&&!!customElements.get('blora-select')");
      await browserCheck("document.querySelector('#pgModel') instanceof customElements.get('blora-select')", 'real Blora select');
      await cdp.input('#pgInput', corpus);
      await cdp.click('#pgSendBtn');
      await cdp.wait("pgApp.streaming&&document.querySelector('.assistant .pg-response-content a')");
      await inspect('.user .pg-msg-content', width+' user');
      await inspect('.assistant .pg-response-content', width+' partial stream', false);
      await request('/__markdown/release', {});
      await cdp.wait("!pgApp.streaming&&pgApp.messages.length===2&&pgApp.activeConvId===1");
      await inspect('.assistant .pg-response-content', width+' complete stream');
      await exercise('.assistant .pg-response-content');
      const state=await request('/__markdown/state');
      check(state.conversations[0].messages[1].content===corpus, 'real send saved exact fixture response');
      if(width===390) await cdp.click('#pgToggleSidebar');
      await cdp.click('#pgNewChatBtn');
      await cdp.wait('pgApp.messages.length===0');
      await cdp.click('#pgHistoryList [data-id="1"]');
      await cdp.wait('pgApp.messages.length===2&&pgApp.activeConvId===1');
      if(width===390) {
        const x=await cdp.evaluate("document.querySelector('#pgHistoryPanel').getBoundingClientRect().right+20");
        await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x,y:450});
        await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x,y:450});
      }
      await inspect('.assistant .pg-msg-content', width+' reopened history');
      await exercise('.assistant .pg-msg-content');
      await cdp.evaluate("document.querySelector('.assistant .pg-msg-content p').scrollIntoView({block:'center',behavior:'instant'})");
      await sleep(200);
      const p=await cdp.evaluate("(() => {const e=document.querySelector('.assistant .pg-msg-content p');const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!document.elementFromPoint(x,y)?.closest('.assistant'))throw Error('right click target obstructed');return {x,y};})()");
      await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',clickCount:1,...p});
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',clickCount:1,...p});
      await cdp.wait("document.querySelector('#pgContextMenu').style.display==='block'");
      await cdp.click('[data-action="copy-rich"]');
      await cdp.wait("document.body.textContent.includes('已复制')");
      const copied=await cdp.evaluate("(async()=>{const items=await navigator.clipboard.read();return await (await items[0].getType('text/html')).text();})()");
      await cdp.evaluate(`(() => {const e=document.createElement('div');e.id='markdownPaste';e.innerHTML=${JSON.stringify(copied)};document.body.appendChild(e);})()`);
      await inspect('#markdownPaste', width+' rich clipboard');
      await cdp.evaluate("document.querySelector('#markdownPaste')?.remove()");
      console.log(`Completed real playground ${width}px`);
    }
    await request('/__markdown/quota', { account: { balance: 0, refund_balance: 50, team_id: 1 }, rules: [{ exceeded: true }, { exceeded: true }] });
    await cdp.input('#pgInput', 'Quota preflight request');
    await cdp.click('#pgSendBtn');
    await cdp.wait("!pgApp.streaming&&!!document.querySelector('.pg-retry-btn')");
    await browserCheck("document.querySelector('.pg-msg-error').textContent.includes('配额已用尽且积分不足')", 'refund currency is not silently spent as points');
    await request('/__markdown/quota', { account: { balance: 0, team_id: 1 }, rules: [{ exceeded: true }, { exceeded: false }] });
    await cdp.click('.pg-retry-btn');
    await cdp.wait("!pgApp.streaming&&document.querySelector('#pgMessages').textContent.includes('Quota request accepted')");
    await browserCheck("!document.querySelector('.pg-msg-error')", 'mixed quota windows permit zero-point retry using production preflight');
    await request('/__markdown/quota', { account: { balance: '0.000001', team_id: 1 }, rules: [{ exceeded: true }] });
    await cdp.input('#pgInput', 'Paid points request');
    await cdp.click('#pgSendBtn');
    await cdp.wait("!pgApp.streaming&&pgApp.messages.at(-1)?.content==='Quota request accepted'");
    await browserCheck("!document.querySelector('.pg-msg-error')", 'positive points allow exhausted quota request');
    check(!cdp.events.some(e=>e.method==='Runtime.exceptionThrown'), 'no uncaught browser exceptions');
    console.log(`Browser: ${assertions} assertions, ${failures.length} failures. In-memory fixtures; no production DB/upstream. Clipboard uses real Chrome clipboard.`);
    if(failures.length) throw new Error('Regression failures: '+failures.join('; '));
  } catch (error) {
    for (const name of ['server', 'chrome']) {
      const file = path.join(scratch, `${name}.log`);
      if (fs.existsSync(file)) console.error(`${name} log (tail):\n${fs.readFileSync(file, 'utf8').slice(-5000)}`);
    }
    if (cdp) console.error('Browser exceptions:', JSON.stringify(cdp.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails)));
    if (cdp) console.error('Recent browser events:', JSON.stringify(cdp.events.slice(-6).map(event => ({ method: event.method, url: event.params?.request?.url, status: event.params?.response?.status }))));
    console.error(`Passed assertions before failure: ${assertions}`);
    throw error;
  } finally {
    if (cdp) cdp.ws.close();
    await stop();
    fs.rmSync(scratch, { recursive: true, force: true });
    process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
    console.log('Cleanup complete: child process groups stopped; temporary scratch removed.');
  }
}
