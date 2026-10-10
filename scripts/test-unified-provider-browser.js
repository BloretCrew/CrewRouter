#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const express = require('express');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(__dirname, '..');
const providers = [null, 99].map((created_by, index) => ({
  id: `fixture-provider-${index}`, name: index ? 'Fixture Other User' : 'Fixture System',
  created_by, username: index ? 'Other fixture user' : null,
  base_url: 'https://fixture.invalid/v1', format: 'openai', enabled: true,
  key_mode: 'fixed', api_key: '', api_keys_count: 2, model_count: 0,
  quota_enabled: false, tags: [], key_select_mode: 'order'
}));

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params.exceptionDetails);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    };
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, frame = false) {
    if (frame) expression = `document.getElementById('unifiedProviderManager').contentWindow.eval(${JSON.stringify(expression)})`;
    const response = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  async wait(expression, frame = false) {
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      if (await this.evaluate(expression, frame)) return;
      await sleep(100);
    }
    throw new Error(`等待页面状态超时: ${expression}`);
  }
  async click(selector, frame = false) {
    const find = `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.disabled);
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return true;
    })()`;
    if (frame) await this.evaluate("document.getElementById('unifiedProviderManager').scrollIntoView({block:'center',behavior:'instant'})");
    assert.ok(await this.evaluate(find, frame), `找不到可见入口: ${selector}`);
    await sleep(180);
    let point = await this.evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.disabled);
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && (hit === el || el.contains(hit)) ? { x, y } : null;
    })()`, frame);
    assert.ok(point, `入口被遮挡或超出视口: ${selector}`);
    if (frame) {
      const offset = await this.evaluate("(() => {const r=document.getElementById('unifiedProviderManager').getBoundingClientRect();return {x:r.x,y:r.y};})()");
      point = { x: point.x + offset.x, y: point.y + offset.y };
      const hit = await this.evaluate(`(() => {const el=document.elementFromPoint(${point.x},${point.y});return {ok:el===document.getElementById('unifiedProviderManager'),tag:el?.tagName,id:el?.id,className:el?.className,point:${JSON.stringify(point)}};})()`);
      assert.ok(hit.ok, `父页面遮挡 iframe 入口: ${selector} ${JSON.stringify(hit)}`);
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(250);
  }
  async fill(selector, text, frame = false) {
    await this.click(selector, frame);
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`, frame);
    await this.send('Input.insertText', { text });
  }
  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP 已关闭'));
    }
    this.pending.clear();
    this.ws.close();
  }
}

function fixture() {
  const app = express();
  const state = { mode: 'personal', requests: [], writes: [], unknown: [] };
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/auth/')) return next();
    state.requests.push({ mode: state.mode, method: req.method, url: req.originalUrl });
    res.set('Cache-Control', 'no-store');
    // 模型库会自动刷新额度；只返回内存 fixture，不执行外呼或写入。
    if (req.path === '/api/user/providers/quota/refresh' && req.method === 'POST') return res.json({ providers: [] });
    if (req.method !== 'GET') {
      state.writes.push(req.originalUrl);
      return res.status(405).json({ error: 'Read-only browser fixture' });
    }
    if (req.path === '/auth/me') return res.json({ id: 7, username: 'Fixture personal nonadmin', isAdmin: false, stats_consent: true });
    if (req.path === '/api/instance') return res.json({
      edition: state.mode === 'personal' ? 'personal' : 'team',
      runtime: state.mode === 'local' ? 'desktop-local' : 'server',
      capabilities: { personalProviders: true, teamAdmin: state.mode === 'team', multiUser: state.mode === 'team', teamProjects: state.mode === 'team', teamAuditLogs: state.mode === 'team' }
    });
    if (req.path === '/api/admin/providers/lookup-index') return res.status(503).json({ error: 'Intentional fixture lookup failure' });
    if (req.path === '/api/admin/providers') return res.json({ items: providers, total: 2, page: 1, limit: 20,
      stats: { total: 2, globalCount: 1, userCount: 1, enabledCount: 2, scriptCount: 0 } });
    const provider = providers.find(p => req.path === `/api/admin/providers/${p.id}`);
    if (provider) return res.json({ ...provider, api_keys: [{ key: 'fixture-key-1', label: 'First', enabled: true, weight: 1 }, { key: 'fixture-key-2', label: 'Second', enabled: true, weight: 2 }] });
    if (['/api/user/my-providers', '/api/user/providers'].includes(req.path)) return res.json(providers);
    if (req.path === '/api/user/model-library') return res.json({ teams: [], personalProviders: [] });
    if (req.path === '/api/user/current-model') return res.json({ currentModel: null });
    if (req.path === '/api/user/providers/quota') return res.json({ providers: [] });
    if (req.path === '/api/plugins/runtime') return res.json({ plugins: [], defaultTheme: '' });
    if (req.path === '/api/plugins/user-theme') return res.json({ themeId: '' });
    if (req.path === '/api/user/trace-sessions') return res.json({ sessions: [] });
    if (['/api/user/api-keys', '/api/user/provider-tags', '/api/admin/provider-tags', '/api/admin/teams', '/api/user/teams'].includes(req.path)) return res.json([]);
    if (req.path === '/api/user/docs-content') return res.json({});
    if (req.path === '/api/admin/update/check') return res.json({ available: false });
    if (req.path === '/api/admin/settings') return res.json({ stats_report_enabled: false });
    if (['/api/config', '/api/i18n/catalog', '/api/admin/settings', '/api/user/settings', '/api/user/team-admin-status'].includes(req.path)) return res.json({});
    state.unknown.push(req.originalUrl);
    res.status(404).json({ error: `Unknown fixture endpoint: ${req.path}` });
  });
  app.get('/console', (req, res) => res.sendFile(path.join(root, 'public/pages/console.html')));
  app.get('/admin', (req, res) => res.sendFile(path.join(root, 'public/pages/admin.html')));
  app.use('/blora', require('../server/blora-resources').createBloraResourceRouter());
  app.use(express.static(path.join(root, 'public')));
  return { server: http.createServer(app), state };
}

async function main() {
  assert.equal(typeof WebSocket, 'function', '需要支持原生 WebSocket 的 Node.js（建议 Node 22+）');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-unified-browser-'));
  const { server, state } = fixture();
  let chrome, cdp, chromeLog = '', interrupted = false;
  const stop = () => { interrupted = true; chrome?.kill('SIGTERM'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const failures = [];
  const check = async (label, run) => {
    try { assert.ok(!interrupted, '测试被中断'); await run(); console.log(`PASS ${label}`); }
    catch (error) {
      failures.push(`${label}: ${error.message}`);
      console.error(`FAIL ${label}: ${error.message}`);
      if (cdp) {
        const layout = await cdp.evaluate(`(() => {
          const frame=document.getElementById('unifiedProviderManager');
          const rect=frame?.getBoundingClientRect();
          const doc=frame?.contentDocument;
          return {url:location.href,viewport:[innerWidth,innerHeight],scrollWidth:document.documentElement.scrollWidth,
            frame:rect ? {left:rect.left,right:rect.right,width:rect.width,height:rect.height} : null,
            frameScrollWidth:doc?.documentElement.scrollWidth,
            dialogs:doc ? [...doc.querySelectorAll('blora-dialog[open]')].map(el=>({id:el.id,text:el.textContent.slice(0,160)})) : [],
            sidebarHidden:document.querySelector('.sidebar-nav')?.hidden};
        })()`).catch(() => null);
        console.error(`诊断 ${JSON.stringify(layout)}`);
      }
    }
  };
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--disable-extensions',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      `--user-data-dir=${temp}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let spawnError;
    chrome.on('error', error => { spawnError = error; });
    chrome.stderr.on('data', chunk => { chromeLog = (chromeLog + chunk).slice(-12000); });
    const activePort = path.join(temp, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(activePort) && i < 150; i++) {
      if (spawnError) throw spawnError;
      if (chrome.exitCode !== null) throw new Error(`Chrome 提前退出: ${chromeLog}`);
      await sleep(100);
    }
    assert.ok(fs.existsSync(activePort), `Chrome CDP 未就绪: ${chromeLog}`);
    const debug = `http://127.0.0.1:${fs.readFileSync(activePort, 'utf8').split('\n')[0]}`;
    const target = await fetch(`${debug}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: ['https://*', 'http://*.invalid/*'] });
    console.log(`Fixture ${base}; Chrome CDP ${debug}; public 页面，无实际后端或数据库。`);
    const expect = async (expression, label, frame = true) => assert.ok(await cdp.evaluate(expression, frame), label);
    for (const mode of ['personal', 'local', 'team']) {
      state.mode = mode;
      for (const width of [1024, 390]) {
        const prefix = `${mode} ${width}x720`;
        let ready = false;
        await check(`${prefix} 页面加载`, async () => {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: width === 390 });
          await cdp.send('Page.navigate', { url: 'about:blank' });
          await cdp.wait("location.href === 'about:blank'");
          await cdp.send('Page.navigate', { url: `${base}/console?fixture=${mode}-${width}#myUpstream` });
          await cdp.wait("typeof app !== 'undefined' && !!app.user && !!app.instance && app.currentPage === 'myUpstream'");
          await cdp.wait(`app.instance.edition === '${mode === 'personal' ? 'personal' : 'team'}' && app.instance.runtime === '${mode === 'local' ? 'desktop-local' : 'server'}'`);
          await expect('app.user.isAdmin === false', '必须使用非管理员用户', false);
          if (mode === 'team') {
            await cdp.wait("document.getElementById('myProvidersTable').textContent.includes('Fixture System')");
            await expect("!document.getElementById('unifiedProviderManager') && !document.getElementById('myUpstreamPage').classList.contains('unified-provider-page')", 'Team 不应创建 iframe', false);
            await expect("[...document.querySelectorAll('[data-page=\"myUpstream\"]')].some(e => e.textContent.includes('我的上游'))", 'Team 保留我的上游名称', false);
          } else {
            await cdp.wait("!!document.getElementById('unifiedProviderManager')");
            await cdp.wait("typeof adminApp !== 'undefined' && adminApp?.providersData?.length === 2 && document.querySelectorAll('#adminProvidersList h3').length > 0", true);
            await expect("location.pathname === '/admin' && location.search === '?providerManager=1' && location.hash === '#adminProviders' && adminApp._unifiedProviders && !adminApp.user.isAdmin", 'iframe 应加载完整统一管理页面');
          }
          ready = true;
        });
        if (!ready) continue;
        if (mode !== 'team') {
          await check(`${prefix} 分组、范围与嵌入布局`, async () => {
            await expect("document.querySelectorAll('#adminProvidersList h3').length === 1 && [...document.querySelectorAll('#adminProvidersList h3')].every(e => !/全局供应商|用户供应商/.test(e.textContent))", '不同 created_by 应合并为单组');
            await expect("['providerScopeFilter','adminProvidersStickyScope'].every(id => getComputedStyle(document.getElementById(id)).display === 'none')", '主栏/悬浮栏不能显示范围筛选');
            await expect("[...document.querySelectorAll('.sidebar,.content-header,.mobile-header')].every(el => getComputedStyle(el).display === 'none')", 'iframe 管理侧栏/重复标题应隐藏');
            await expect("(() => {const r=document.getElementById('unifiedProviderManager').getBoundingClientRect();return r.width>0 && r.left>=-1 && r.right<=innerWidth+1 && document.documentElement.scrollWidth<=innerWidth+1;})()", 'console iframe 不应横向溢出', false);
            await expect('document.documentElement.scrollWidth <= innerWidth + 1', '管理页面不应横向溢出');
          });
          await check(`${prefix} 卡片与 table 切换`, async () => {
            for (const view of ['table', 'card']) {
              await cdp.click(view === 'table' ? '#providerViewTableBtn' : '#providerViewCardBtn', true);
              await expect(`adminApp.providerViewMode === '${view}' && document.querySelectorAll('#adminProvidersList h3').length === 1`, `${view} 应保留一组供应商`);
              await expect(view === 'table' ? "document.querySelectorAll('#adminProvidersList tbody tr').length === 2" : "document.querySelectorAll('#adminProvidersList .admin-card').length === 2", `${view} 应显示两个供应商`);
            }
          });
          await check(`${prefix} lookup 失败手动 editor、多 key 与全部 tabs`, async () => {
            await cdp.click('#addProviderBtn', true);
            await cdp.wait("!!document.getElementById('wizardManualFallback')", true);
            await cdp.click('#wizardManualFallback', true);
            await cdp.wait("document.getElementById('addProviderModal').hasAttribute('open')", true);
            await cdp.wait("(() => {const modal=document.getElementById('addProviderModal');const panel=modal.shadowRoot?.querySelector('[part=panel],.blora-dialog__panel');if(!panel)return false;const r=panel.getBoundingClientRect();return Math.abs(r.width-innerWidth)<2 && Math.abs(r.height-innerHeight)<2;})()", true);
            await cdp.fill('#providerName', 'Fixture unsaved provider', true);
            await cdp.fill('#providerBaseUrl', 'https://fixture.invalid/v1', true);
            await cdp.fill('.provider-api-key-input[data-key-index="0"]', 'fixture-unsaved-key-1', true);
            await cdp.click('#addProviderApiKeyBtn', true);
            await cdp.fill('.provider-api-key-input[data-key-index="1"]', 'fixture-unsaved-key-2', true);
            await expect("document.querySelectorAll('#providerApiKeysList .provider-api-key-row').length === 2", '应支持多 Key');
            await cdp.click('.provider-api-key-make-primary[data-key-index="1"]', true);
            await expect("document.querySelector('.provider-api-key-input[data-key-index=\"0\"]').value === 'fixture-unsaved-key-2'", '应可切换主 Key');
            for (let page = 0; page < 7; page++) {
              await cdp.click(`[data-provider-page="${page}"]`, true);
              await expect(`adminApp._providerEditorPage === ${page} && document.querySelectorAll('#addProviderModal .provider-form-basics:not([hidden]),#addProviderModal .provider-form-section:not([hidden])').length === 1`, `tab ${page} 单页内容`);
              await expect('document.documentElement.scrollWidth <= innerWidth + 1', `tab ${page} 不应撑宽 iframe`);
            }
            await cdp.click('[data-provider-page="0"]', true);
            await expect("document.getElementById('providerName').value === 'Fixture unsaved provider' && document.querySelectorAll('.provider-api-key-input').length === 2", '跨页保留未保存表单');
          });
          await check(`${prefix} editor 关闭`, async () => {
            if (await cdp.evaluate("document.getElementById('addProviderModal').hasAttribute('open')", true)) await cdp.click('#addProviderModal .modal-close', true);
            await cdp.wait("!document.getElementById('addProviderModal').hasAttribute('open')", true);
            await expect("!document.querySelector('blora-dialog[open]')", '不应残留向导遮罩');
          });
        }
        await check(`${prefix} 侧栏返回 console 模型库`, async () => {
          if (width === 390) {
            await cdp.click('#sidebarToggle');
            await cdp.wait("document.getElementById('mobileSidebarDrawer').hasAttribute('open')");
            await cdp.click('#mobileSidebarDrawer .blora-sidebar-nav__link[data-value="modelLibrary"], #mobileSidebarDrawer blora-sidebar-nav-link[value="modelLibrary"], #mobileSidebarDrawer [data-page="modelLibrary"]');
          } else await cdp.click('.sidebar .blora-sidebar-nav__link[data-value="modelLibrary"], .sidebar blora-sidebar-nav-link[value="modelLibrary"], .sidebar [data-page="modelLibrary"]');
          await cdp.wait("app.currentPage === 'modelLibrary' && location.hash === '#modelLibrary' && !!app._libraryData");
          await expect("document.getElementById('modelLibraryPage').classList.contains('active') && !document.getElementById('myUpstreamPage').classList.contains('active')", '应回到外层模型库并隐藏上游页', false);
        });
        await check(`${prefix} hash 返回 console 模型库`, async () => {
          await cdp.evaluate("location.hash = 'modelLibrary'");
          await cdp.wait("app.currentPage === 'modelLibrary' && !!app._libraryData");
          await expect("document.getElementById('modelLibraryPage').classList.contains('active') && !document.getElementById('myUpstreamPage').classList.contains('active')", 'hash 返回必须隐藏 iframe 上游页', false);
        });
      }
    }
    await check('只读 fixture 和无范围请求', async () => {
      assert.deepEqual(state.writes, [], '测试不能发送用户数据变更请求');
      assert.ok(state.requests.some(r => r.url === '/api/admin/providers/lookup-index'), '必须实际请求失败的 lookup fixture');
      assert.ok(state.requests.some(r => r.mode === 'team' && r.url === '/api/user/my-providers'), 'Team 必须使用原我的上游接口');
      assert.ok(!state.requests.some(r => r.mode !== 'team' && r.url.startsWith('/api/admin/providers?') && new URL(r.url, base).searchParams.has('scope')), '统一管理不应携带范围 filter');
      assert.equal(cdp.exceptions.length, 0, `页面未捕获异常: ${JSON.stringify(cdp.exceptions)}`);
    });
    if (state.unknown.length) console.log(`未配置的辅助 API: ${[...new Set(state.unknown)].join(', ')}`);
    console.log(`浏览器验收完成，失败 ${failures.length} 项。`);
    assert.equal(failures.length, 0, failures.join('\n'));
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null && chrome.pid) {
      const exited = once(chrome, 'exit');
      chrome.kill('SIGTERM');
      await Promise.race([exited, sleep(3000)]);
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGKILL');
        await exited;
      }
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    console.log('已清理 fixture 服务、Chrome 进程及临时目录。');
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
