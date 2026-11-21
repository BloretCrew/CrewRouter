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
  const { DEFAULT_TEMPLATE, SIGNATURE_VARIABLES } = require('../server/utils/api-signature');
  let state;
  const reset = () => {
    const user = { ...data.getUser() };
    delete user.api_signature_enabled;
    delete user.api_signature_template;
    const keys = data.apiKeys().slice(0, 2).map((key, i) => ({ ...key, id: i + 1, name: `Settings fixture ${i + 1}`, key_type: 'normal', is_owner: true }));
    for (const key of keys) {
      delete key.quota_warning_enabled; delete key.crewrouter_commands;
      key.signature_enabled = null; key.signature_template = null;
    }
    Object.assign(keys[1], { quota_warning_enabled: true, crewrouter_commands: true });
    state = { user, keys, prompts: [{ id: 1, name: 'Disabled fixture', content: 'Local fixture only', enabled: false, bound_key_ids: [], bound_keys: [] }], writes: [], fail: null };
  };
  reset();
  express.application.init = function () {
    original.call(this);
    this.use(async (req, res, next) => {
      const pathname = new URL(req.url, base).pathname;
      const handled = pathname.startsWith('/__settings/') || pathname === '/auth/me' || pathname === '/api/user/signature' || /^\/api\/user\/api-keys\/\d+\/signature$/.test(pathname) || pathname === '/api/user/settings' || pathname === '/api/user/api-keys' || /^\/api\/user\/api-keys\/\d+\/(quota-warning|swallow-images|crewrouter-commands)$/.test(pathname) || pathname.startsWith('/api/user/inject-prompts');
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
        if (pathname === '/__settings/config') {
          if (body.user) Object.assign(state.user, body.user);
          if (body.key) Object.assign(state.keys.find(key => key.id === body.key.id), body.key);
          return res.json({ ok: true });
        }
        if (pathname === '/api/user/signature' || /^\/api\/user\/api-keys\/\d+\/signature$/.test(pathname)) {
          const key = pathname === '/api/user/signature' ? null : state.keys.find(key => key.id === Number(pathname.split('/')[4]));
          if (req.method === 'PUT') state.writes.push({ path: pathname, body });
          // Chrome may retry a connection closed before headers; keep this fault active until reset.
          const failure = state.fail; if (failure !== 'network') state.fail = null;
          if (failure === 'http') return res.status(503).json({ success: true, error: 'Fixture HTTP failure' });
          if (failure === 'logical') return res.json({ success: false, error: 'Fixture logical failure' });
          if (failure === 'malformed') return res.type('text').send('Fixture invalid JSON');
          if (failure === 'network') return req.socket.destroy();
          if (failure === 'delayed') await sleep(600);
          if (req.method === 'PUT') {
            assert.deepEqual(Object.keys(body).sort(), ['enabled', 'template']);
            assert.ok(typeof body.enabled === 'boolean' || (key && body.enabled === null));
            assert.ok(typeof body.template === 'string' || (key && body.template === null));
            const template = (body.template || '').trim();
            if (template.length > 2000) return res.status(400).json({ error: '签名模板不能超过 2000 个字符' });
            if (key) Object.assign(key, { signature_enabled: body.enabled, signature_template: template || null });
            else Object.assign(state.user, { api_signature_enabled: body.enabled, api_signature_template: template });
          }
          const inherited = { enabled: state.user.api_signature_enabled === true, template: (state.user.api_signature_template || '').trim() };
          if (!key) return res.json({ ...(req.method === 'PUT' ? { success: true } : {}), ...inherited, defaults: { template: DEFAULT_TEMPLATE, variables: SIGNATURE_VARIABLES } });
          const effective = { enabled: inherited.enabled && key.signature_enabled !== false, template: (key.signature_template || '').trim() || inherited.template, source: !inherited.enabled || key.signature_enabled == null ? 'user' : 'key' };
          return res.json(req.method === 'PUT'
            ? { success: true, effective }
            : { enabled: key.signature_enabled, template: key.signature_template, user_signature_enabled: inherited.enabled, user_signature_template: inherited.template, inherited, effective });
        }
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
    // 固定页头和 Liquid Glass 布局会在滚动后一两帧调整，等待真实坐标稳定后点击。
    await this.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await sleep(120);
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
    // 移动端页面导航/滚动的延迟重绘可能抢走首次点击焦点；仍通过真实点击重试。
    for (let i = 0; i < 5 && !await this.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`); i++) await this.click(selector);
    await this.wait(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`);
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
    const appResponse = await fetch(`${base}/js/app.js`);
    check(appResponse.ok && (await appResponse.text()).includes('_signaturePreviewText(enabled, template)'), 'isolated server serves the updated signature implementation');
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
    const keySave = '[onclick="app.saveKeySignature()"]';
    const keyCancel = '#keySignatureModal [data-variant="secondary"]';
    const screenshot = async name => {
      await browserCheck("document.readyState==='complete'&&!!app.user&&document.body.innerText.includes('签名')", 'screenshot is live rendered console');
      const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = `/tmp/cr-signature-${name}-fixed.png`;
      fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
      console.log(`Screenshot: ${file}`);
    };
    const selectMode = async mode => {
      await cdp.click('#keySignatureMode');
      const point = await cdp.evaluate(`(() => {const e=document.querySelector('#keySignatureMode').shadowRoot.querySelector('[data-value="${mode}"]');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
      await cdp.wait(`document.querySelector('#keySignatureMode').value===${JSON.stringify(mode)}`);
    };
    const theme = async value => {
      await cdp.evaluate(`themeManager.theme=${JSON.stringify(value)};themeManager.applyTheme()`);
      await sleep(250);
    };
    const panelCheck = async dark => browserCheck(`(() => {
      const root=document.querySelector('#keySignatureModal').shadowRoot;
      const panel=root.querySelector('[part="panel"]'), backdrop=root.querySelector('[part="backdrop"]');
      if(!panel||!backdrop)return false;
      const p=getComputedStyle(panel),b=getComputedStyle(backdrop);
      const channels=s=>s.match(/[\\d.]+/g).map(Number);
      const bg=channels(p.backgroundColor),fg=channels(getComputedStyle(document.querySelector('#keySignaturePreview')).color);
      const lum=c=>{const a=c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return a[0]*.2126+a[1]*.7152+a[2]*.0722};
      const contrast=(Math.max(lum(bg),lum(fg))+.05)/(Math.min(lum(bg),lum(fg))+.05);
      return (bg.length===3||bg[3]===1)&&Number(p.opacity)===1&&p.backdropFilter==='none'&&channels(b.backgroundColor)[3]>=.45&&contrast>=4.5&&(${dark}?lum(bg)<.1:lum(bg)>.8);
    })()`, `${dark ? 'dark' : 'light'} Key panel is opaque, backdrop dims background and preview contrast >=4.5`);
    const openSignature = async () => {
      await cdp.click(`${card(1)} .api-key-more button`);
      await cdp.click('[onclick="app.showKeySignature(1)"]');
      await cdp.wait("document.querySelector('#keySignatureModal').hasAttribute('open')");
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
      await cdp.wait('app._signatureFormReady');
      await browserCheck("[...document.querySelectorAll('#settingsPage .content-section')].filter(e=>e.getClientRects().length).every(e=>e.classList.contains('settings-category-signature'))&&document.querySelector('#changePasswordForm').getClientRects().length===0&&document.querySelector('#notificationsList').getClientRects().length===0", 'signature category excludes password and notifications, not just marked sections');
      await cdp.evaluate("app.showSettingsCategory('security')");
      await browserCheck("document.querySelector('#changePasswordForm').getClientRects().length>0&&document.querySelector('#apiSignatureToggle').getClientRects().length===0", 'password belongs to security');
      await cdp.evaluate("app.showSettingsCategory('notifications')");
      await browserCheck("document.querySelector('#notificationsList').getClientRects().length>0&&document.querySelector('#changePasswordForm').getClientRects().length===0", 'notification list belongs to notifications');
      await cdp.evaluate("app.showSettingsCategory('signature')");
      await browserCheck("document.querySelector('#apiSignatureToggle') instanceof customElements.get('blora-switch')&&!document.querySelector('#apiSignatureToggle').checked&&document.querySelector('#signaturePreview').textContent.includes('关闭')", 'missing signature field defaults off, disabled preview visible');
      await cdp.click('[onclick="app.resetSignatureTemplate()"]');
      await browserCheck("!document.querySelector('#apiSignatureToggle').checked&&document.querySelector('#apiSignatureTemplate').value===app._signatureDefaults.template", 'fill default never enables signature');
      await cdp.wait("document.querySelector('#signatureSaveStatus').textContent==='自动保存成功'");
      await cdp.click('#apiSignatureToggle');
      await cdp.wait("document.querySelector('#signatureSaveStatus').textContent==='自动保存成功'");
      await browserCheck("document.querySelector('#signaturePreview').textContent.includes('78%')&&!document.querySelector('#signaturePreview').textContent.includes('%%')", 'default percentage is not duplicated');
      const template = `Browser ${width} {model}`;
      await cdp.input('#apiSignatureTemplate', template);
      await browserCheck(`document.querySelector('#signaturePreview').textContent.includes('Browser ${width} gpt-4o')`, 'template preview responds to real input');
      await cdp.click(save);
      await cdp.wait("document.querySelector('#signatureSaveStatus').textContent==='自动保存成功'");
      check((await request('/__settings/state')).user.api_signature_enabled === true, 'signature persisted enabled');
      await reload('settings'); await cdp.wait('app._signatureFormReady');
      await browserCheck(`document.querySelector('#apiSignatureToggle').checked&&document.querySelector('#apiSignatureTemplate').value===${JSON.stringify(template)}`, 'enabled signature and template survive refresh');
      await cdp.input('#apiSignatureTemplate', '   ');
      await browserCheck("document.querySelector('#signaturePreview').textContent.includes('空模板')", 'enabled user empty template injects nothing');
      await cdp.click(save); await cdp.wait("app.signatureConfig.template===''" );
      await reload('settings'); await cdp.wait('app._signatureFormReady');
      await browserCheck("document.querySelector('#apiSignatureTemplate').value===''&&document.querySelector('#signaturePreview').textContent.includes('空模板')", 'user empty template persists without default fallback');
      await cdp.click('#apiSignatureToggle');
      await browserCheck(`!document.querySelector('#apiSignatureToggle').checked&&document.querySelector('#signaturePreview').textContent.includes('关闭')`, 'disabled state remains visible in preview');
      await request('/__settings/fail', { kind: 'http' });
      await cdp.click(save);
      await cdp.wait("!app._signatureSaving&&document.querySelector('#signatureSaveStatus').style.color==='var(--destructive)'");
      await request('/__settings/fail', { kind: null });
      await cdp.click(save); await cdp.wait('app.signatureConfig.enabled===false');
      for (const kind of ['http', 'logical', 'malformed', 'network']) {
        await cdp.click('#apiSignatureToggle');
        await cdp.input('#apiSignatureTemplate', `Retry ${kind} ${width}`);
        const cached = await cdp.evaluate('JSON.stringify(app.signatureConfig)');
        const persisted = (await request('/__settings/state')).user;
        await request('/__settings/fail', { kind });
        await cdp.click(save);
        await cdp.wait("!app._signatureSaving&&document.querySelector('#signatureSaveStatus').style.color==='var(--destructive)'");
        await browserCheck(`JSON.stringify(app.signatureConfig)===${JSON.stringify(cached)}&&document.querySelector('#apiSignatureTemplate').value==='Retry ${kind} ${width}'`, `${kind} failure preserves cache and draft`);
        check(JSON.stringify((await request('/__settings/state')).user) === JSON.stringify(persisted), `${kind} failure does not persist`);
        await request('/__settings/fail', { kind: null });
        await cdp.click(save); await cdp.wait(`app.signatureConfig.enabled===true&&app.signatureConfig.template==='Retry ${kind} ${width}'`);
        await cdp.click('#apiSignatureToggle'); await cdp.click(save);
        await cdp.wait('app.signatureConfig.enabled===false');
      }
      // GET 失败不产生关闭状态的假缓存，重试不丢旧草稿。
      await cdp.evaluate("app._signatureFormReady=false;document.querySelector('#apiSignatureTemplate').value='unsaved draft'");
      await request('/__settings/fail', { kind: 'http' });
      await cdp.evaluate('app.loadSignatureSettings()');
      await browserCheck("!app._signatureFormReady&&!document.querySelector('#signatureLoadRetry').hidden&&document.querySelector('#apiSignatureTemplate').value==='unsaved draft'", 'load failure exposes retry and preserves the unsaved draft');
      await cdp.click('#signatureLoadRetry'); await cdp.wait('app._signatureFormReady');
      await cdp.click('#apiSignatureToggle');
      await cdp.input('#apiSignatureTemplate', 'draft survives navigation');
      await cdp.wait("!app._signatureSaving");
      await navigate('apiKeys'); await navigate('settings');
      await browserCheck("document.querySelector('#apiSignatureTemplate').value==='draft survives navigation'", 'navigation does not replace existing user draft');
      await cdp.input('#apiSignatureTemplate', 'x'.repeat(2001));
      await browserCheck("document.querySelector('#apiSignatureTemplate').value.length===2000", 'user textarea limits typed template to 2000');
      const writesBeforeLength = (await request('/__settings/state')).writes.length;
      await cdp.evaluate("document.querySelector('#apiSignatureTemplate').value='x'.repeat(2001)");
      await cdp.click(save);
      await browserCheck("document.querySelector('#signatureSaveStatus').textContent.includes('2000')", 'user overlength programmatic draft gets validation feedback');
      check((await request('/__settings/state')).writes.length === writesBeforeLength, 'overlength user draft never sent');
      await cdp.input('#apiSignatureTemplate', `User ${width} {cache_hit}% {group_name}`);
      await cdp.click(save); await cdp.wait('!app._signatureSaving');
      await request('/__settings/fail', { kind: 'delayed' });
      await cdp.evaluate("window.__signatureSave=app.saveSignatureSettings();document.querySelector('#apiSignatureTemplate').value='edited while saving';document.querySelector('#apiSignatureTemplate').dispatchEvent(new Event('input',{bubbles:true}))");
      await cdp.evaluate('window.__signatureSave');
      await browserCheck("document.querySelector('#apiSignatureTemplate').value==='edited while saving'", 'save response does not overwrite newer draft');
      await cdp.input('#apiSignatureTemplate', `User ${width} {cache_hit}% {group_name}`);
      await cdp.wait(`!app._signatureSaving&&app.signatureConfig.template.startsWith('User ${width}')`);
      await screenshot(`user-${width}`);
      await theme('dark');
      await screenshot(`user-dark-${width}`);
      await theme('light');
      await request('/__settings/config', { user: { api_signature_enabled: true, api_signature_template: `User ${width} {cache_hit}% {group_name}` } });
      await navigate('apiKeys'); await cdp.wait("document.querySelectorAll('.api-key-card').length===2");
      await openSignature();
      await browserCheck("document.querySelector('#keySignatureMode').value==='inherit'&&document.querySelector('#keySignatureTemplate').getClientRects().length>0&&document.querySelector('#keySignaturePreview').textContent.includes('User')", 'Key inherits current user signature state and leaves template editable');
      await cdp.input('#keySignatureTemplate', `Key ${width} {cache_hit}% {group_name}`);
      await browserCheck(`document.querySelector('#keySignaturePreview').textContent.includes('Key ${width} 78% 我的团队')`, 'inherit mode with enabled user permits a Key template override');
      await cdp.click(keySave); await cdp.wait("!document.querySelector('#keySignatureModal').hasAttribute('open')");
      check((await request('/__settings/state')).keys[0].signature_enabled === null && (await request('/__settings/state')).keys[0].signature_template.startsWith('Key'), 'Key PUT persists enabled null plus nonempty template');
      await openSignature();
      await browserCheck("document.querySelector('#keySignatureTemplate').value.startsWith('Key')", 'Key override survives reopen');
      await panelCheck(false);
      await screenshot(`key-${width}`);
      await theme('dark');
      await panelCheck(true);
      await screenshot(`key-dark-${width}`);
      await theme('light');
      // 全部开关三态 × 用户开关 × 用户/Key 空非空模板，预览必须匹配服务端解析规则。
      for (const userEnabled of [false, true]) for (const userTemplate of ['', 'User {model}']) for (const keyTemplate of [null, '', 'Key {model}']) {
        await cdp.click(keyCancel);
        await request('/__settings/config', { user: { api_signature_enabled: userEnabled, api_signature_template: userTemplate }, key: { id: 1, signature_enabled: null, signature_template: keyTemplate } });
        await openSignature();
        for (const mode of ['inherit', 'enable', 'disable']) {
          await selectMode(mode);
          const expectedEnabled = userEnabled && mode !== 'disable';
          const expectedTemplate = keyTemplate || userTemplate;
          const expected = mode === 'enable' && !userEnabled
            ? 'Key 强制开启，但用户总开关关闭'
            : mode === 'inherit' && !userEnabled
              ? '用户默认签名已关闭'
              : !expectedEnabled ? '关闭' : !expectedTemplate ? '空模板' : expectedTemplate.replace('{model}', 'gpt-4o');
          await browserCheck(`document.querySelector('#keySignaturePreview').textContent.includes(${JSON.stringify(expected)})&&document.querySelector('#keySignatureTemplate').getClientRects().length>0`, `Key semantics user=${userEnabled}/${userTemplate || 'empty'} key=${keyTemplate === null ? 'null' : keyTemplate || 'empty'} mode=${mode}`);
        }
      }
      await selectMode('enable');
      await cdp.input('#keySignatureTemplate', 'x'.repeat(2001));
      await browserCheck("document.querySelector('#keySignatureTemplate').value.length===2000", 'Key textarea typed max length');
      const keyWritesBeforeLength = (await request('/__settings/state')).writes.length;
      await cdp.evaluate("document.querySelector('#keySignatureTemplate').value='x'.repeat(2001)");
      await cdp.click(keySave);
      await browserCheck("document.querySelector('#keySignatureSaveStatus').textContent.includes('2000')", 'Key overlength draft gets validation feedback');
      check((await request('/__settings/state')).writes.length === keyWritesBeforeLength, 'overlength Key draft never sent');
      await cdp.input('#keySignatureTemplate', 'Retry Key');
      for (const kind of ['http', 'logical', 'malformed', 'network']) {
        const previous = JSON.stringify((await request('/__settings/state')).keys[0]);
        await request('/__settings/fail', { kind }); await cdp.click(keySave);
        await browserCheck("document.querySelector('#keySignatureModal').hasAttribute('open')&&document.querySelector('#keySignatureTemplate').value==='Retry Key'&&!!document.querySelector('#keySignatureSaveStatus').textContent", `${kind} Key failure keeps dialog draft and error`);
        check(JSON.stringify((await request('/__settings/state')).keys[0]) === previous, `${kind} Key failure does not persist`);
      }
      await request('/__settings/fail', { kind: null });
      await cdp.click(keySave); await cdp.wait("!document.querySelector('#keySignatureModal').hasAttribute('open')");
      await openSignature(); await selectMode('disable');
      await cdp.click(keySave); await cdp.wait("!document.querySelector('#keySignatureModal').hasAttribute('open')");
      await reload('apiKeys'); await openSignature();
      await browserCheck("document.querySelector('#keySignatureMode').value==='disable'&&document.querySelector('#keySignaturePreview').textContent.includes('关闭')&&document.querySelector('#keySignatureTemplate').value==='Retry Key'", 'Key explicit off persists across page reload without clearing override');
      check((await request('/__settings/state')).keys[0].signature_enabled === false, 'Key force-off PUT sends false rather than null');
      await cdp.input('#keySignatureTemplate', ''); await selectMode('inherit');
      await cdp.click(keySave); await cdp.wait("!document.querySelector('#keySignatureModal').hasAttribute('open')");
      check((await request('/__settings/state')).keys[0].signature_template === null, 'empty Key template PUT normalizes null inheritance');
      const previousKey = await cdp.evaluate('app._currentSignatureKeyId');
      await request('/__settings/fail', { kind: 'http' });
      await cdp.evaluate('app.showKeySignature(2)');
      await browserCheck(`!document.querySelector('#keySignatureModal').hasAttribute('open')&&app._currentSignatureKeyId===${previousKey}`, 'failed Key load never opens stale config or changes save target');
      // 给原脚本非签名部分保持默认关闭初始状态，不运行其余范围测试。
      await request('/__settings/config', { user: { api_signature_enabled: false, api_signature_template: '' } });
      await reload('apiKeys');
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
    console.log('Fixture limitations: signature/settings/key options/prompts/auth are local in-memory endpoints; signature contracts mirror the current routes. Persistence is verified across navigation/reload, not server restart. No production SQL, authorization, proxy or external upstream is exercised. Other endpoints use isolated demo data.');
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
