#!/usr/bin/env node
'use strict';

// Run: node scripts/test-settings-defaults-browser.js [--signature-only] (Node >= 22, google-chrome).
// Fixtures persist only in this process; they do not exercise SQL, auth, or proxy forwarding.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.argv.includes('--server')) {
  startServer();
} else {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

function startServer() {
  const base = process.env.SETTINGS_FIXTURE_URL;
  const scratch = process.env.SETTINGS_FIXTURE_SCRATCH;
  assert.ok(base && scratch, 'server must be launched by the isolated runner');
  for (const key of Object.keys(process.env)) {
    if (/^(CR(?:W)?_|DATABASE_URL$|PG(HOST|PORT|USER|PASSWORD|DATABASE|SERVICE|SERVICEFILE)$)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    CR_APP_HOST: '127.0.0.1', CR_APP_PORT: new URL(base).port,
    CR_RUNTIME: 'server', CR_EDITION: 'team', CR_DEMO: 'true',
    CR_CONFIG_PATH: path.join(scratch, 'config.json'), CR_LOGIN_REPORT_ENABLED: 'false',
    CR_STATS_REPORT_ENABLED: 'false', CR_DB_HOST: '127.0.0.1', CR_DB_PORT: '1',
    CR_DB_NAME: 'settings_browser_isolated', CR_DB_USER: 'isolated',
    CR_DB_PASSWORD: 'isolated-test-only', NODE_ENV: 'test'
  });
  // No outbound TCP is needed by the demo server, including database connections.
  net.Socket.prototype.connect = function () { throw new Error('Fixture server outbound TCP forbidden'); };
  const express = require('express');
  const original = express.application.init;
  const data = require('../server/demo/data');
  let state;
  const reset = () => {
    const user = { ...data.getUser() };
    delete user.api_signature_enabled;
    delete user.api_signature_template;
    const keys = data.apiKeys().slice(0, 2).map((key, i) => ({ ...key, id: i + 1, name: `Settings fixture ${i + 1}`, key_type: 'normal', is_owner: true }));
    for (const key of keys) { delete key.quota_warning_enabled; delete key.crewrouter_commands; }
    Object.assign(keys[1], { quota_warning_enabled: true, crewrouter_commands: true });
    state = { user, keys, prompts: [{ id: 1, name: 'Disabled fixture', content: 'Local fixture only', enabled: false, bound_key_ids: [], bound_keys: [] }], writes: [], fail: null };
  };
  reset();
  express.application.init = function () {
    original.call(this);
    this.use(async (req, res, next) => {
      const pathname = new URL(req.url, base).pathname;
      const handled = pathname.startsWith('/__settings/') || pathname === '/auth/me' || pathname === '/api/user/settings' || pathname === '/api/user/api-keys' || /^\/api\/user\/api-keys\/\d+\/(quota-warning|swallow-images|crewrouter-commands)$/.test(pathname) || pathname.startsWith('/api/user/inject-prompts');
      if (!handled) return next();
      try {
        let body = {};
        if (['POST', 'PUT'].includes(req.method)) {
          let raw = ''; for await (const chunk of req) raw += chunk;
          body = raw ? JSON.parse(raw) : {};
        }
        if (pathname === '/__settings/reset') { reset(); return res.json({ ok: true }); }
        if (pathname === '/__settings/state') return res.json(state);
        if (pathname === '/__settings/fail') { state.fail = body.kind; return res.json({ ok: true }); }
        if (pathname === '/auth/me') return res.json(state.user);
        if (pathname === '/api/user/settings' && req.method === 'PUT') {
          state.writes.push({ path: pathname, body });
          const failure = state.fail; state.fail = null;
          if (failure === 'http') return res.status(503).json({ success: true, error: 'Fixture HTTP failure' });
          if (failure === 'logical') return res.json({ success: false, error: 'Fixture logical failure' });
          Object.assign(state.user, body); return res.json({ success: true });
        }
        if (pathname === '/api/user/api-keys' && req.method === 'GET') return res.json(state.keys);
        const keyMatch = pathname.match(/^\/api\/user\/api-keys\/(\d+)\/(quota-warning|swallow-images|crewrouter-commands)$/);
        if (keyMatch && req.method === 'PUT') {
          state.writes.push({ path: pathname, body });
          Object.assign(state.keys.find(key => key.id === Number(keyMatch[1])), body);
          return res.json({ success: true });
        }
        if (pathname === '/api/user/inject-prompts/my-keys') return res.json({ items: state.keys });
        if (pathname === '/api/user/inject-prompts' && req.method === 'GET') return res.json({ items: state.prompts });
        if (pathname === '/api/user/inject-prompts' && req.method === 'POST') {
          state.writes.push({ path: pathname, body });
          const item = { ...body, id: state.prompts.length + 1, enabled: body.enabled === true, bound_key_ids: [], bound_keys: [] };
          state.prompts.push(item); return res.json({ item });
        }
        const promptMatch = pathname.match(/^\/api\/user\/inject-prompts\/(\d+)\/(toggle|keys)$/);
        if (promptMatch && req.method === 'PUT') {
          state.writes.push({ path: pathname, body });
          const item = state.prompts.find(prompt => prompt.id === Number(promptMatch[1]));
          if (promptMatch[2] === 'toggle') item.enabled = body.enabled === true;
          else item.bound_key_ids = body.keyIds;
          return res.json({ ok: true });
        }
        return res.status(405).json({ error: 'Unexpected fixture request' });
      } catch (error) { return res.status(500).json({ error: error.message }); }
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60000);
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
    const pointExpression = `(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),x=(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,y=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;const hit=document.elementFromPoint(x,y);return r.width&&r.height&&(hit===e||e.contains(hit))?{x,y}:null;})()`;
    await this.wait(pointExpression);
    const point = await this.evaluate(pointExpression);
    assert.ok(point, `visible, unobstructed click target: ${selector}`);
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-settings-browser-'));
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
    launch(process.execPath, [__filename, '--server'], { ...process.env, SETTINGS_FIXTURE_URL: base, SETTINGS_FIXTURE_SCRATCH: scratch }, 'server');
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
    const pageResponse = await fetch(`${base}/console`);
    check(pageResponse.ok && (await pageResponse.text()).includes('apiSignatureToggle'), 'real console HTML served');
    const target = await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
    cdp = new CDP(target.webSocketDebuggerUrl);
    for (const domain of ['Page', 'Runtime', 'Network']) await cdp.send(`${domain}.enable`);
    await cdp.send('Network.setBlockedURLs', { urls: ['https://*', 'http://localhost:*'] });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `if(location.protocol==='http:'){localStorage.setItem('language','zh');localStorage.setItem('theme','light');}` });
    const request = (route, body) => fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => { assert.ok(r.ok); return r.json(); });
    const browserCheck = async (expression, message) => check(await cdp.evaluate(expression), message);
    const save = '[onclick="app.saveSignatureSettings()"]';
    const optionsSave = '[onclick="app.saveKeyOptions()"]';
    const card = id => `.api-key-card[data-key-id="${id}"]`;
    const badgeCheck = async (id, on) => browserCheck(`(() => {const t=document.querySelector(${JSON.stringify(card(id) + ' .api-key-chips')}).textContent;return t.includes('额度预警')===${on}&&t.includes('@CrewRouter')===${on};})()`, `key ${id} badges ${on}`);
    const openOptions = async id => {
      await cdp.click(`${card(id)} .api-key-more button`);
      await cdp.click(`[onclick="app.showKeyOptions(${id})"]`);
      await cdp.wait("document.querySelector('#keyOptionsModal').hasAttribute('open')");
    };
    const closeOptions = () => cdp.click('#keyOptionsModal [data-variant="secondary"]');
    const navigate = async page => {
      if (await cdp.evaluate('innerWidth < 768')) await cdp.click('#sidebarToggle');
      await cdp.click(`${await cdp.evaluate('innerWidth < 768') ? '#mobileSidebarDrawer' : '.sidebar'} .blora-sidebar-nav__link[data-value="${page}"]`);
      await cdp.wait(`document.querySelector('#${page}Page').classList.contains('active')`);
      if (page === 'settings') await cdp.click('[data-settings-category="signature"]');
    };
    const reload = async page => {
      await cdp.evaluate('window.__settingsBeforeReload=true');
      await cdp.send('Page.reload');
      await cdp.wait(`!window.__settingsBeforeReload&&document.readyState!=='loading'&&typeof app!=='undefined'&&!!app.user&&document.querySelector('#${page}Page').classList.contains('active')`);
      if (page === 'prompts') await cdp.wait("!!document.querySelector('[data-inject-id=\"1\"] blora-switch')");
      if (page === 'apiKeys') await cdp.wait("document.querySelectorAll('.api-key-card').length===2");
      if (page === 'settings') await cdp.click('[data-settings-category="signature"]');
    };
    for (const width of [1440, 390]) {
      const before = assertions;
      await request('/__settings/reset', {});
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: 'about:blank' });
      await cdp.wait("location.href==='about:blank'");
      await cdp.send('Page.navigate', { url: `${base}/console#settings` });
      await cdp.wait("document.readyState!=='loading'&&typeof app!=='undefined'&&!!app.user&&!!customElements.get('blora-switch')&&document.querySelector('#settingsPage').classList.contains('active')");
      await sleep(500);
      await cdp.click('[data-settings-category="signature"]');
      await browserCheck("document.querySelector('#apiSignatureToggle') instanceof customElements.get('blora-switch')&&!document.querySelector('#apiSignatureToggle').checked&&getComputedStyle(document.querySelector('#signatureTemplateGroup')).display==='none'", 'missing signature field defaults off, real Blora switch');
      await cdp.click('#apiSignatureToggle');
      const template = `Browser ${width} {model}`;
      await cdp.input('#apiSignatureTemplate', template);
      await browserCheck(`document.querySelector('#signaturePreview').textContent.includes('Browser ${width} gpt-4o')`, 'template preview responds to real input');
      await cdp.click(save);
      await cdp.wait("document.querySelector('#signatureSaveStatus').textContent==='保存成功'");
      check((await request('/__settings/state')).user.api_signature_enabled === true, 'signature persisted enabled');
      await reload('settings');
      await browserCheck(`document.querySelector('#apiSignatureToggle').checked&&document.querySelector('#apiSignatureTemplate').value===${JSON.stringify(template)}`, 'enabled signature and template survive refresh');
      await cdp.click('#apiSignatureToggle');
      await browserCheck(`!document.querySelector('#apiSignatureToggle').checked&&document.querySelector(${JSON.stringify(save)}).getClientRects().length>0&&getComputedStyle(document.querySelector('#signatureTemplateGroup')).display==='none'`, 'save stays visible when signature disabled');
      await cdp.click(save); await cdp.wait("document.querySelector('#signatureSaveStatus').textContent==='保存成功'");
      await reload('settings');
      await browserCheck("!document.querySelector('#apiSignatureToggle').checked&&app.user.api_signature_enabled===false", 'disabled signature survives refresh');
      for (const kind of ['http', 'logical']) {
        await cdp.click('#apiSignatureToggle');
        await cdp.input('#apiSignatureTemplate', `Retry ${kind} ${width}`);
        const cached = await cdp.evaluate('JSON.stringify(app.user)');
        const persisted = (await request('/__settings/state')).user;
        await sleep(3200);
        await request('/__settings/fail', { kind });
        await cdp.click(save);
        await cdp.wait(`document.querySelector('#signatureSaveStatus').textContent.includes('Fixture')`);
        await browserCheck(`JSON.stringify(app.user)===${JSON.stringify(cached)}`, `${kind} failure does not mutate user cache`);
        check(JSON.stringify((await request('/__settings/state')).user) === JSON.stringify(persisted), `${kind} failure does not persist`);
        await cdp.click(save); await cdp.wait(`app.user.api_signature_enabled===true&&app.user.api_signature_template==='Retry ${kind} ${width}'`);
        await browserCheck(`app.user.api_signature_enabled===true&&app.user.api_signature_template==='Retry ${kind} ${width}'`, `${kind} failure can retry`);
        await cdp.click('#apiSignatureToggle'); await cdp.click(save);
        await cdp.wait("app.user.api_signature_enabled===false");
      }
      if (process.argv.includes('--signature-only')) {
        console.log(`PASS ${width}px signature flow: ${assertions - before} assertions`);
        continue;
      }
      await navigate('apiKeys'); await cdp.wait("document.querySelectorAll('.api-key-card').length===2");
      await badgeCheck(1, false); await badgeCheck(2, true);
      for (const [id, initial] of [[1, false], [2, true]]) {
        await openOptions(id);
        await browserCheck(`document.querySelector('#keyOptionQuotaWarning').checked===${initial}&&document.querySelector('#keyOptionCrewRouterCommands').checked===${initial}`, `key ${id} missing/explicit fields`);
        await cdp.click('#keyOptionQuotaWarning'); await cdp.click('#keyOptionCrewRouterCommands');
        await cdp.click(optionsSave); await cdp.wait("!document.querySelector('#keyOptionsModal').hasAttribute('open')");
        await cdp.wait(`app._lastApiKeys?.find(key=>Number(key.id)===${id})?.quota_warning_enabled===${!initial}&&app._lastApiKeys?.find(key=>Number(key.id)===${id})?.crewrouter_commands===${!initial}`);
        await badgeCheck(id, !initial);
        await openOptions(id);
        await browserCheck(`document.querySelector('#keyOptionQuotaWarning').checked===${!initial}&&document.querySelector('#keyOptionCrewRouterCommands').checked===${!initial}`, `key ${id} save/reopen`);
        await closeOptions();
      }
      await reload('apiKeys'); await cdp.wait("document.querySelectorAll('.api-key-card').length===2");
      await badgeCheck(1, true); await badgeCheck(2, false);
      await navigate('prompts'); await cdp.wait("!!document.querySelector('[data-inject-id=\"1\"] blora-switch')");
      const prompt = '[data-inject-id="1"]';
      await browserCheck(`document.querySelector('${prompt}').textContent.includes('已停用')&&!document.querySelector('${prompt} blora-switch').checked&&!document.querySelector('${prompt}').textContent.includes('全局生效')`, 'disabled prompt badge and operable off switch');
      await cdp.click(`${prompt} blora-switch`);
      await cdp.wait(`document.querySelector('${prompt} blora-switch').checked&&document.querySelector('${prompt}').textContent.includes('全局生效')`);
      await browserCheck(`!document.querySelector('${prompt}').textContent.includes('已停用')&&document.querySelector('${prompt}').textContent.includes('全局生效')`, 'enabling prompt updates scope badge');
      await cdp.click(`${prompt} blora-switch`);
      await cdp.wait(`!document.querySelector('${prompt} blora-switch').checked&&document.querySelector('${prompt}').textContent.includes('已停用')`);
      await reload('prompts');
      await browserCheck(`document.querySelector('${prompt}').textContent.includes('已停用')&&!document.querySelector('${prompt} blora-switch').checked`, 'prompt disable survives reload');
      await cdp.click('[onclick="app.showInjectPromptModal()"]');
      await cdp.wait("document.querySelector('#injectPromptModal').hasAttribute('open')");
      await cdp.input('#injectPromptName', `Created ${width}`);
      await cdp.input('#injectPromptContent', 'Local browser-created prompt');
      await cdp.click('[onclick="app.saveInjectPrompt()"]');
      await cdp.wait("!document.querySelector('#injectPromptModal').hasAttribute('open')&&!!document.querySelector('[data-inject-id=\"2\"]')");
      const state = await request('/__settings/state');
      const creation = state.writes.find(write => write.path === '/api/user/inject-prompts');
      check(creation && !Object.hasOwn(creation.body, 'enabled') && state.prompts[1].enabled === false, 'create omits enabled; fixture applies server disabled default');
      await reload('prompts');
      await cdp.wait("!!document.querySelector('[data-inject-id=\"2\"] blora-switch')");
      await browserCheck("document.querySelector('[data-inject-id=\"2\"]').textContent.includes('已停用')&&!document.querySelector('[data-inject-id=\"2\"] blora-switch').checked", 'created prompt remains disabled after refresh');
      await navigate('settings');
      await browserCheck("!document.querySelector('#apiSignatureToggle').checked", 'navigation returns to persisted disabled signature');
      check(state.writes.filter(write => /api-keys\/\d+\//.test(write.path)).length === 6, 'all six key option writes reached fixture');
      console.log(`PASS ${width}px: ${assertions - before} assertions`);
    }
    const exceptions = cdp.events.filter(event => event.method === 'Runtime.exceptionThrown');
    check(exceptions.length === 0, `no uncaught page exceptions: ${JSON.stringify(exceptions.map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text))}`);
    console.log(`PASS ${assertions} assertions. Real headless Chrome, real console and Blora; desktop 1440px and mobile 390px.`);
    console.log('Fixture limitations: settings/key options/prompts/auth are local in-memory endpoints; persistence is verified across navigation/reload, not server restart. No production SQL, authorization, proxy or external upstream is exercised. Other endpoints use isolated demo data. Prompt creation disabled default is fixture-provided, not production route acceptance.');
  } catch (error) {
    for (const name of ['server', 'chrome']) {
      const file = path.join(scratch, `${name}.log`);
      if (fs.existsSync(file)) console.error(`${name} log (tail):\n${fs.readFileSync(file, 'utf8').slice(-5000)}`);
    }
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
