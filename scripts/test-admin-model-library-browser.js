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
      }, 45000);
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
    const until = Date.now() + 25000;
    while (Date.now() < until) {
      if (await this.evaluate(expression, frame)) return;
      await sleep(100);
    }
    throw new Error(`等待页面状态超时: ${expression}`);
  }
  async click(selector, frame = false) {
    const find = `(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.disabled);
      const hidden = document.querySelector(${JSON.stringify(selector)});
      if (!el && hidden?.closest('.aml-provider-menu')) { hidden.closest('.aml-provider-menu').open = true; return false; }
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return true;
    })()`;
    if (frame) await this.evaluate("document.getElementById('unifiedProviderManager').scrollIntoView({block:'center',behavior:'instant'})");
    await this.wait(find, frame);
    await sleep(180);
    let point = await this.evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.disabled);
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, ok: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && (hit === el || el.contains(hit)), hit: hit?.outerHTML.slice(0, 300) };
    })()`, frame);
    assert.ok(point?.ok, `入口被遮挡或超出视口: ${selector} ${JSON.stringify(point)}`);
    point = { x: point.x, y: point.y };
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
  const state = { mode: 'team', requests: [], writes: [], unknown: [], failToggle: false, rules: [], teams: [] };
  state.reset = () => {
    state.teams = [1, 2].map(id => ({ id, name: `TEAM ${id === 1 ? 'A' : 'B'}`, description: '', member_count: 0 }));
    state.models = [{ id: 'fixture-model', model_id: 'fixture-model', name: 'Fixture Alpha', upstream_model_id: 'alpha', alias: '', provider: 'fixture-provider', provider_id: 'fixture-provider', provider_name: 'Fixture Provider', enabled: true, system_enabled: true, provider_enabled: true, series: 'Alpha', description: 'Fixture description', input_price_per_1k_tokens: 1, output_price_per_1k_tokens: 2, model_multiplier: 1, test_ok: true }];
    state.grants = { 1: false, 2: true }; state.rules = []; state.failToggle = false; state.failView = null; state.providerEnabled = true; state.member = false;
  };
  state.reset();
  const providers = () => [{ id: 'fixture-provider', name: 'Fixture Provider', enabled: state.providerEnabled, provider_enabled: state.providerEnabled, quota_enabled: true, model_count: 1, created_by: null, format: 'openai', tags: [], base_url: 'https://fixture.invalid/v1' }, { id: 'fixture-empty', name: 'Fixture Empty', enabled: true, provider_enabled: true, model_count: 0, created_by: null, tags: [], format: 'openai' }];
  app.use(express.json());
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/auth/')) return next();
    const record = { mode: state.mode, method: req.method, url: req.originalUrl, body: req.body };
    state.requests.push(record); res.set('Cache-Control', 'no-store');
    const json = data => res.json(data);
    if (req.path === '/api/user/providers/quota/refresh' && req.method === 'POST') return json({ providers: [] });
    const write = data => { state.writes.push({ ...record, result: data }); return json(data); };
    const match = req.path.match(/^\/api\/admin\/teams\/(\d+)(?:\/(.*))?$/);
    if (req.method !== 'GET') {
      if (match && match[2] === 'models/batch' && req.method === 'POST') {
        assert.deepEqual(req.body.modelIds, ['fixture-model']); state.grants[match[1]] = req.body.enabled;
        return write({ success: true, updated: 1, cleared_keys: req.body.enabled ? 0 : 1 });
      }
      if (req.path === '/api/admin/providers/fixture-provider/toggle-enabled' && req.method === 'POST') {
        state.providerEnabled = req.body.enabled; return write({ success: true });
      }
      if (match && /^models\//.test(match[2] || '') && req.method === 'PUT') {
        if (state.failToggle) { state.failToggle = false; return res.status(503).json({ error: 'Intentional toggle failure' }); }
        assert.equal(match[2], 'models/fixture-model'); state.grants[match[1]] = req.body.enabled;
        return write({ success: true, updated: 1, cleared_keys: req.body.enabled ? 0 : 1 });
      }
      if (req.path === '/api/admin/models/batch-update' && req.method === 'POST') {
        assert.deepEqual(req.body.ids, ['fixture-model']); state.models[0].enabled = state.models[0].system_enabled = req.body.enabled;
        return write({ success: true, updated: 1 });
      }
      if (req.path === '/api/admin/models' && req.method === 'POST') { Object.assign(state.models[0], req.body); return write({ success: true }); }
      if (req.path === '/api/admin/teams' && req.method === 'POST') { const team = { id: 3, ...req.body, member_count: 0 }; state.teams.push(team); return write(team); }
      if (match && !match[2] && req.method === 'PUT') { Object.assign(state.teams.find(t => t.id === Number(match[1])), req.body); return write({ success: true }); }
      if (match && match[2] === 'rules' && req.method === 'POST') { const rule = { id: 1, ...req.body }; state.rules.push(rule); return write(rule); }
      if (match && match[2] === 'rules/1' && req.method === 'DELETE') { state.rules = []; return write({ success: true }); }
      state.unknown.push(record); return res.status(405).json({ error: 'Fixture forbids this mutation' });
    }
    if (req.path === '/auth/me') return json({ id: 7, username: 'Fixture', isAdmin: state.mode === 'team' && !state.member, stats_consent: true });
    if (req.path === '/api/instance') return json({ edition: state.mode === 'local' ? 'team' : state.mode, runtime: state.mode === 'local' ? 'desktop-local' : 'server', capabilities: { personalProviders: true, teamAdmin: state.mode === 'team', multiUser: state.mode === 'team', teamProjects: state.mode === 'team', teamAuditLogs: state.mode === 'team' } });
    if (req.path === '/api/admin/model-library') {
      const q = req.query;
      if (q.sort && !['name', 'name_desc', 'newest', 'test_latency', 'test_speed', 'price_asc', 'price_desc'].includes(q.sort)) return res.status(400).json({ error: 'sort 无效' });
      if (q.test && !['pass', 'fail', 'untested'].includes(q.test)) return res.status(400).json({ error: 'test 无效' });
      if (q.tag && !/^[1-9]\d*$/.test(q.tag)) return res.status(400).json({ error: 'tag 必须是标签 ID' });
      const view = q.view || 'providers';
      if (state.failView === view) { state.failView = null; return res.status(503).json({ error: 'Intentional library failure' }); }
      if (!['models', 'providers'].includes(view)) return res.status(400).json({ error: 'view 必须是 providers 或 models' });
      let models = state.models.map(m => ({ ...m, provider_enabled: state.providerEnabled, team_enabled: q.teamId ? state.grants[q.teamId] ?? false : null }));
      models = models.filter(m => (!q.provider || m.provider_id === q.provider) && (!q.q || `${m.name} ${m.alias} ${m.provider_name}`.toLowerCase().includes(q.q.toLowerCase())) && (!q.series || m.series === q.series) && (!q.systemEnabled || String(m.system_enabled) === q.systemEnabled) && (!q.teamEnabled || String(m.team_enabled) === q.teamEnabled) && (!q.test || (q.test === 'pass' ? m.test_ok === true : q.test === 'fail' ? m.test_ok === false : m.test_ok == null)));
      const ps = providers().filter(p => !q.provider || p.id === q.provider).map(p => ({ id: p.id, name: p.name, provider_enabled: p.enabled, model_count: models.filter(m => m.provider_id === p.id).length, system_enabled_count: models.filter(m => m.provider_id === p.id && m.system_enabled).length, team_enabled_count: q.teamId ? models.filter(m => m.provider_id === p.id && m.team_enabled).length : null }));
      const items = view === 'models' ? models : ps;
      return json({ view, team_id: q.teamId ? Number(q.teamId) : null, items, total: items.length, page: Number(q.page || 1), limit: Number(q.limit || 50), providers: ps, stats: { model_count: models.length, provider_count: ps.length, system_enabled_count: models.filter(m => m.system_enabled).length, team_enabled_count: q.teamId ? models.filter(m => m.team_enabled).length : null, available_count: models.filter(m => m.system_enabled && (!q.teamId || m.team_enabled)).length } });
    }
    if (req.path === '/api/admin/teams') return json(state.mode === 'personal' ? [] : state.teams);
    if (match) return json(match[2] === 'rules' ? state.rules : match[2] === 'models' ? state.models.map(m => ({ ...m, enabled: state.grants[match[1]] })) : []);
    if (req.path === '/api/admin/models') return json(Object.keys(req.query).length ? { items: state.models, total: 1, providers: providers(), series: ['Alpha'], stats: {} } : state.models);
    if (req.path === '/api/admin/providers') return json(Object.keys(req.query).length ? { items: providers(), total: 2, page: 1, limit: 20, stats: {} } : providers());
    if (req.path === '/api/i18n/catalog') return json(JSON.parse(fs.readFileSync(path.join(root, 'lang', req.query.locale === 'en' ? 'en.json' : 'zh.json'), 'utf8')));
    if (req.path === '/api/admin/providers/fixture-provider/ping') return json({ ok: true, latency_ms: 123 });
    if (req.path === '/api/admin/providers/fixture-provider/check-quota') return json({ provider: { name: 'Fixture Provider' }, quota: { total: 100, used: 25, remaining: 75, planName: 'Fixture quota' } });
    const sharedModels = state.grants[1] && state.models[0].system_enabled ? state.models.map(m => ({ ...m, provider_enabled: state.providerEnabled })) : [];
    if (req.path === '/api/user/team/1/provider/fixture-provider/models') return json({ models: sharedModels, pagination: { page: 1, limit: 50, total: sharedModels.length, total_pages: 1, has_next: false, has_prev: false } });
    if (req.path === '/api/user/model-library') return json({ teams: state.member ? [{ team_id: 1, team_name: 'TEAM A', providers: sharedModels.length ? [{ provider_id: 'fixture-provider', provider_name: 'Fixture Provider', provider_enabled: state.providerEnabled, models_loaded: true, model_count: sharedModels.length, models: sharedModels }] : [] }] : [], personalProviders: [] });
    if (req.path === '/api/user/team/1/provider/fixture-provider/models') return json({ models: sharedModels, items: sharedModels, total: sharedModels.length, page: 1, limit: 50 });
    if (req.path === '/api/user/api-keys') return json(state.member ? [{ id: 71, name: 'Fixture Key', key: 'fixture-key', enabled: true, team_id: 1, model_id: sharedModels[0]?.id || null, model_bindings: sharedModels.map(m => ({ model_id: m.id, team_id: 1 })) }] : []);
    if (req.path === '/api/user/current-model') return json({ currentModel: null });
    if (req.path === '/api/plugins/runtime') return json({ plugins: [], defaultTheme: '' });
    if (req.path === '/api/plugins/user-theme') return json({ themeId: '' });
    if (req.path === '/api/admin/update/check') return json({ available: false });
    if (req.path === '/api/admin/settings') return json({ stats_report_enabled: false });
    if (req.path === '/api/user/trace-sessions') return json({ sessions: [] });
    if (req.path === '/api/user/providers/quota') return json({ providers: [] });
    if (['/api/admin/users', '/api/admin/provider-tags', '/api/user/provider-tags', '/api/user/api-keys', '/api/user/teams'].includes(req.path)) return json([]);
    if (['/api/config', '/api/i18n/catalog', '/api/admin/settings', '/api/user/settings', '/api/user/team-admin-status', '/api/user/docs-content'].includes(req.path)) return json({});
    state.unknown.push(record); return res.status(404).json({ error: `Unknown fixture endpoint: ${req.path}` });
  });
  // 同一轮固定前端资源，避免其他 agent 的中途写入污染验收。
  const assets = new Map();
  const snapshot = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) snapshot(file);
      else if (/\.(js|css|html)$/.test(file)) assets.set('/' + path.relative(path.join(root, 'public'), file).split(path.sep).join('/'), fs.readFileSync(file));
    }
  };
  state.snapshot = () => { assets.clear(); snapshot(path.join(root, 'public')); };
  state.snapshot();
  app.get('/admin', (req, res) => res.type('html').send(assets.get('/pages/admin.html')));
  app.get('/console', (req, res) => res.type('html').send(assets.get('/pages/console.html')));
  app.use((req, res, next) => assets.has(req.path) ? res.type(path.extname(req.path)).send(assets.get(req.path)) : next());
  app.use('/blora', require('../server/blora-resources').createBloraResourceRouter());
  app.use(express.static(path.join(root, 'public')));
  return { server: http.createServer(app), state };
}

async function main() {
  assert.equal(typeof WebSocket, 'function', '需要 Node.js 22+');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewrouter-admin-library-'));
  const { server, state } = fixture();
  const results = [];
  let chrome, cdp, chromeLog = '';
  const stop = () => chrome?.kill('SIGTERM');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const check = async (label, run) => {
    try { state.reset(); state.snapshot(); await run(); results.push({ label, pass: true }); console.log(`PASS ${label}`); }
    catch (error) {
      const diagnostic = await cdp?.evaluate(`({url:location.href,viewport:[innerWidth,innerHeight],scrollWidth:document.documentElement.scrollWidth,dialogs:[...document.querySelectorAll('blora-dialog[open]')].map(e=>({id:e.id,text:e.textContent.slice(0,250)})),library:document.querySelector('.aml-directory')?.textContent.slice(0,600)})`).catch(() => null);
      results.push({ label, pass: false, error: error.message, diagnostic }); console.error(`FAIL ${label}: ${error.message}\n${JSON.stringify(diagnostic)}`);
    }
  };
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    chrome = spawn(process.env.CHROME_BIN || 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${temp}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let spawnError; chrome.on('error', error => { spawnError = error; });
    chrome.stderr.on('data', chunk => { chromeLog = (chromeLog + chunk).slice(-12000); });
    const portFile = path.join(temp, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(portFile) && i < 150; i++) { if (spawnError) throw spawnError; if (chrome.exitCode !== null) throw new Error(chromeLog); await sleep(100); }
    assert.ok(fs.existsSync(portFile), chromeLog);
    const debug = `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8').split('\n')[0]}`;
    const target = await fetch(`${debug}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: ['https://*', 'http://*.invalid/*'] });
    const expect = async (expression, message, frame = false) => assert.ok(await cdp.evaluate(expression, frame), message);
    const loaded = frame => cdp.wait("!!document.querySelector('.aml-provider') && document.querySelector('.aml-directory').getAttribute('aria-busy') === 'false'", frame);
    const navigate = async (width, hash = 'adminModelLibrary', mode = 'team') => {
      state.reset();
      state.mode = mode;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      const previousExceptions = cdp.exceptions;
      const previousTarget = await cdp.send('Target.getTargetInfo');
      const fresh = await fetch(`${debug}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
      cdp.close();
      await fetch(`${debug}/json/close/${previousTarget.targetInfo.targetId}`);
      cdp = new CDP(fresh.webSocketDebuggerUrl);
      cdp.exceptions = previousExceptions;
      await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: ['https://*', 'http://*.invalid/*'] });
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: `${base}/${mode !== 'team' ? 'console' : 'admin'}?fixture=${width}&run=${Date.now()}#${hash}` });
      if (mode === 'team') { await cdp.wait("typeof adminApp !== 'undefined' && !!adminApp.modelLibrary"); await loaded(); }
      else { await cdp.wait("!!document.getElementById('unifiedProviderManager')"); await loaded(true); }
    };
    const expand = async (id = 'fixture-provider', frame = false) => {
      const selector = `[data-action="expand"][data-id="${id}"]`;
      if (await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded') !== 'true'`, frame)) await cdp.click(selector, frame);
      await cdp.wait(`!!document.querySelector('[data-provider="${id}"] .aml-card') || document.querySelector('[data-provider="${id}"] .aml-model-grid')?.textContent.includes('暂无')`, frame);
    };
    const switchModel = '[data-action="toggle-model"][data-id="fixture-model"]';
    const confirm = async accept => { await cdp.wait("!!document.querySelector('blora-dialog[open] [data-dialog-confirm]')"); await cdp.click(accept ? '[data-dialog-confirm]' : '[data-dialog-cancel]'); };
    const select = async (selector, steps) => {
      await cdp.click(selector);
      for (const key of ['Home', ...Array(steps).fill('ArrowDown'), 'Enter']) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: { Home: 36, ArrowDown: 40, Enter: 13 }[key] });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: { Home: 36, ArrowDown: 40, Enter: 13 }[key] });
      }
      await sleep(400);
    };
    for (const width of [1440, 1024, 390]) {
      const p = `${width}x900`;
      state.reset();
      await check(`${p} 页面、零模型供应商与布局`, async () => {
        await navigate(width); await expect("document.querySelectorAll('.aml-provider').length === 2", '应显示包括零模型在内的两个供应商');
        await expect("!!document.querySelector('.model-library-header') && !!document.querySelector('.model-filter-bar') && !!document.querySelector('.model-library-provider-header')", '后台应使用控制台模型库区块与供应商结构');
        await expand('fixture-empty'); await expect("document.querySelector('[data-provider=" + JSON.stringify('fixture-empty') + "] .aml-model-grid').textContent.includes('暂无')", '零模型供应商不应被渲染为模型');
        await expect('document.documentElement.scrollWidth <= innerWidth + 1', '页面横向溢出');
      });
      await check(`${p} TEAM A/B 单开关、选择与授权隔离`, async () => {
        await navigate(width); await cdp.click('[data-action="team"][data-team="1"]'); await loaded(); await expand();
        await expect(`!!document.querySelector('${switchModel}')`, '模型展开未返回真实 model_id（检查 view/mode 契约）');
        await expect("!!document.querySelector('.model-library-item .model-library-item-info .model-library-item-name') && !!document.querySelector('.model-library-item-price') && !document.querySelector('[data-action=bind-model]')", '控制台模型条目应适配为后台操作，不提供 Key 绑定');
        await expect(`document.querySelector('${switchModel}').getAttribute('aria-checked') === 'false'`, 'A 未授权应关闭');
        const before = state.writes.length; await cdp.click('[data-select="fixture-model"]'); assert.equal(state.writes.length, before, '勾选不能授权');
        await cdp.click(switchModel); await cdp.wait("document.querySelector('.aml-notice')?.textContent.includes('已启用')"); assert.equal(state.grants[1], true); assert.equal(state.grants[2], true);
        await cdp.click('[data-action="team"][data-team="2"]'); await loaded(); await expand();
        await expect("adminApp.modelLibrary.selected.size === 0", '切换 TEAM 清空批量选择');
        await expect(`document.querySelector('${switchModel}').getAttribute('aria-checked') === 'true'`, 'B 授权不应被 A 操作污染');
      });
      await check(`${p} 关闭确认取消、失败恢复与重试`, async () => {
        await navigate(width);
        state.grants[2] = true;
        await cdp.click('[data-action="team"][data-team="2"]'); await loaded(); await expand();
        const before = state.writes.length; await cdp.click(switchModel); await confirm(false); assert.equal(state.writes.length, before); assert.equal(state.grants[2], true);
        state.failToggle = true; await cdp.click(switchModel); await confirm(true);
        await cdp.wait("document.querySelector('.aml-notice')?.textContent.includes('Intentional toggle failure')");
        await expect(`!document.querySelector('${switchModel}').disabled && document.querySelector('${switchModel}').getAttribute('aria-checked') === 'true'`, '失败保留授权且允许重试');
        await cdp.click(switchModel); await confirm(true); await cdp.wait("document.querySelector('.aml-notice')?.textContent.includes('已关闭')");
        assert.equal(state.grants[2], false); assert.equal(state.grants[1], false, '关闭 B 不应修改 A'); assert.equal(state.writes.at(-1).result.cleared_keys, 1);
      });
      await check(`${p} 搜索与供应商筛选请求`, async () => {
        await navigate(width); const before = state.requests.length; await cdp.fill('[data-filter="q"]', 'missing-model');
        await cdp.wait("document.querySelector('.aml-directory').getAttribute('aria-busy') === 'false' && adminApp.modelLibrary.filters.q === 'missing-model'"); await sleep(350);
        assert.ok(state.requests.slice(before).some(r => r.url.includes('q=missing-model')));
        await cdp.click('.aml-more-filters > summary'); await cdp.click('[data-action="reset"]'); await loaded();
        await select('[data-filter="provider"]', 2); await loaded(); await expect("document.querySelectorAll('.aml-provider').length === 1 && !!document.querySelector('[data-provider=" + JSON.stringify('fixture-empty') + "]')", '供应商筛选应限制目录');
      });
      await check(`${p} 测试筛选与排序符合后端契约`, async () => {
        await navigate(width); await cdp.click('.aml-more-filters > summary'); await select('[data-filter="test"]', 2);
        await expect("!document.querySelector('.aml-directory').textContent.includes('加载失败')", '测试成功筛选传值必须是 pass（不是 ok）');
        await cdp.click('[data-action="reset"]'); await select('[data-filter="sort"]', 2);
        await expect("!document.querySelector('.aml-directory').textContent.includes('加载失败')", '排序值必须在后端允许列表内');
      });
      await check(`${p} 全部模型系统开关`, async () => {
        await navigate(width); await expand(); await cdp.click(switchModel); await confirm(true);
        await cdp.wait("document.querySelector('.aml-notice')?.textContent.includes('已关闭')"); assert.equal(state.models[0].system_enabled, false);
        assert.equal(state.writes.at(-1).url, '/api/admin/models/batch-update');
      });
      await check(`${p} 模型编辑保存`, async () => {
        await navigate(width); await expand(); await cdp.click('[data-action="edit-model"][data-id="fixture-model"]');
        await cdp.wait("document.getElementById('addModelModal').hasAttribute('open')"); await cdp.fill('#modelAlias', `Edited ${width}`); await cdp.click('#saveModelBtn');
        await cdp.wait("!document.getElementById('addModelModal').hasAttribute('open')"); assert.equal(state.models[0].alias, `Edited ${width}`);
        await cdp.click('#adminLibraryManagerClose'); await loaded();
      });
      await check(`${p} 新建 TEAM`, async () => {
        await navigate(width); await cdp.click('.aml-header [data-action="manage-teams"]'); await cdp.wait("!document.getElementById('adminLibraryManager').hidden");
        await cdp.click('#createTeamBtn'); await cdp.wait("!!document.getElementById('teamNameInput')"); await cdp.fill('#teamNameInput', `Created ${width}`); await cdp.fill('#teamDescInput', 'Memory only'); await cdp.click('#confirmCreateTeam');
        await cdp.wait("!document.getElementById('teamNameInput')?.closest('blora-dialog')?.hasAttribute('open')"); assert.ok(state.teams.some(t => t.name === `Created ${width}`)); await cdp.click('#adminLibraryManagerClose');
      });
      await check(`${p} 管理 TEAM 编辑与 rules 添加删除`, async () => {
        await navigate(width); await cdp.click('[data-action="team"][data-team="1"]'); await loaded(); await cdp.click('.aml-toolbar-context [data-action="manage-teams"]');
        await cdp.wait("!!document.querySelector('#adminLibraryTeamRules input[name=rule_value]:not(:disabled)') && !document.querySelector('#adminLibraryManager[hidden]') && !document.querySelector('blora-dialog[open]')");
        await cdp.click('#editTeamBtn'); await cdp.wait("!!document.getElementById('editTeamNameInput')"); await cdp.fill('#editTeamNameInput', `TEAM edited ${width}`); await cdp.click('#confirmEditTeam'); await cdp.wait("!document.getElementById('editTeamNameInput')?.closest('blora-dialog')?.hasAttribute('open')");
        assert.equal(state.teams[0].name, `TEAM edited ${width}`);
        await cdp.wait("!!document.querySelector('#adminLibraryTeamRules input[name=rule_value]:not(:disabled)') && !document.querySelector('#adminLibraryManager[hidden]') && !document.querySelector('blora-dialog[open]')");
        await cdp.fill('#adminLibraryTeamRules [name="rule_value"]', '123'); await cdp.fill('#adminLibraryTeamRules [name="duration_hours"]', '2'); await cdp.click('#adminLibraryTeamRules button[type="submit"]');
        await cdp.wait("document.getElementById('adminLibraryTeamRules').textContent.includes('规则已添加')"); assert.equal(state.rules[0].rule_value, 123);
        await cdp.click('#adminLibraryTeamRules .blora-card .blora-card button'); await confirm(true); await cdp.wait("document.getElementById('adminLibraryTeamRules').textContent.includes('规则已删除')"); assert.deepEqual(state.rules, []);
      });
      for (const hash of ['adminModels', 'adminProviders', 'adminTeams', 'adminTeams/1']) {
        await check(`${p} 旧 hash ${hash}`, async () => { await navigate(width, hash); await expect("adminApp.currentPage === 'adminModelLibrary' && location.hash.startsWith('#adminModelLibrary')", '旧入口应进入新模型库'); });
      }
      await check(`${p} 个人内嵌真实交互`, async () => {
        await navigate(width, 'myUpstream', 'personal');
        if (await cdp.evaluate("!document.getElementById('adminLibraryManager').hidden", true)) await cdp.click('#adminLibraryManagerClose', true);
        await expect("!adminApp.user.isAdmin && adminApp.currentPage === 'adminModelLibrary'", '个人非管理员可访问统一模型库', true);
        await expect("[...document.querySelectorAll('.sidebar,.content-header,.mobile-header')].every(e=>getComputedStyle(e).display==='none')", '嵌入隐藏重复导航', true);
        await cdp.fill('[data-filter="q"]', 'Alpha', true); await sleep(400); await loaded(true); await expand('fixture-provider', true);
        await expect("!!document.querySelector('[data-model=" + JSON.stringify('fixture-model') + "]')", '个人内嵌应可加载真实模型卡', true);
        await expect('document.documentElement.scrollWidth <= innerWidth + 1', '外层不得横向溢出'); await expect('document.documentElement.scrollWidth <= innerWidth + 1', '内嵌不得横向溢出', true);
      });
    }
    for (const width of [1440, 390]) {
      await check(`${width} 批量当前筛选与供应商授权`, async () => {
        await navigate(width); await cdp.click('[data-team="1"]'); await loaded();
        await cdp.fill('[data-filter="q"]', 'Alpha'); await sleep(450); await loaded();
        await cdp.click('[data-action="enable-filtered"]'); await confirm(true);
        await cdp.wait("document.querySelector('.aml-notice')?.textContent.includes('已启用')");
        assert.equal(state.grants[1], true); assert.equal(state.writes.at(-1).url, '/api/admin/teams/1/models/batch');
        await cdp.click('[data-action="disable-provider"][data-id="fixture-provider"]'); await confirm(true);
        await cdp.wait("document.querySelector('.aml-notice')?.textContent.includes('已关闭')"); assert.equal(state.grants[1], false);
        await cdp.click('[data-action="enable-provider"][data-id="fixture-provider"]'); await confirm(true);
        await cdp.wait("document.querySelector('.aml-notice')?.textContent.includes('已启用')"); assert.equal(state.grants[1], true);
      });
      await check(`${width} 系统关闭仍可撤销已有TEAM授权`, async () => {
        await navigate(width); state.models[0].enabled = state.models[0].system_enabled = false;
        await cdp.click('[data-team="2"]'); await loaded(); await expand();
        await expect(`document.querySelector('${switchModel}').getAttribute('aria-checked') === 'true' && !document.querySelector('${switchModel}').disabled`, '系统关闭不能阻止撤销授权');
        await cdp.click(switchModel); await confirm(true); await cdp.wait("document.querySelector('.aml-notice')?.textContent.includes('已关闭')"); assert.equal(state.grants[2], false);
      });
      await check(`${width} 深色布局与真实主题按钮`, async () => {
        await navigate(width);
        const selector = width === 390 ? '#themeToggleMobile' : '#themeToggle';
        for (let i = 0; i < 3 && !await cdp.evaluate("document.documentElement.classList.contains('dark')"); i++) await cdp.click(selector);
        await expect("document.documentElement.classList.contains('dark')", '应通过主题入口进入深色'); await expand();
        await expect('document.documentElement.scrollWidth <= innerWidth + 1', '深色布局横向溢出');
        await cdp.click(selector);
      });
    }
    await check('目录与模型加载失败真实重试', async () => {
      await navigate(1440); state.failView = 'providers'; await cdp.click('[data-action="refresh"]');
      await cdp.wait("document.querySelector('.aml-directory').textContent.includes('Intentional library failure')");
      await cdp.click('.aml-directory [data-action="refresh"]'); await loaded();
      state.failView = 'models'; await cdp.click('[data-action="expand"][data-id="fixture-provider"]');
      await cdp.wait("!!document.querySelector('[data-action=retry-provider]')"); await cdp.click('[data-action="retry-provider"]');
      await cdp.wait("!!document.querySelector('[data-model=fixture-model]')");
    });
    await check('刷新与浏览器back/forward还原scope及开关', async () => {
      await navigate(1440); await cdp.click('[data-team="1"]'); await loaded(); await expand(); await cdp.click(switchModel);
      await cdp.wait("document.querySelector('.aml-notice')?.textContent.includes('已启用')");
      await cdp.send('Page.reload'); await loaded(); await expand();
      await expect(`adminApp.modelLibrary.teamId === '1' && document.querySelector('${switchModel}').getAttribute('aria-checked') === 'true'`, '刷新还原TEAM授权');
      await cdp.click('[data-team="2"]'); await loaded();
      let history = await cdp.send('Page.getNavigationHistory'); await cdp.send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex - 1].id });
      await cdp.wait("adminApp.modelLibrary.teamId === '1'"); await loaded();
      history = await cdp.send('Page.getNavigationHistory'); await cdp.send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex + 1].id });
      await cdp.wait("adminApp.modelLibrary.teamId === '2'"); await loaded();
    });
    await check('语言真实自定义select切换保留scope/filter/selection', async () => {
      await navigate(1440); await cdp.click('[data-team="1"]'); await loaded(); await cdp.fill('[data-filter="q"]', 'Alpha'); await sleep(450); await loaded(); await expand(); await cdp.click('[data-select="fixture-model"]');
      const language = async value => {
        await cdp.evaluate("document.getElementById('langToggle').scrollIntoView({block:'center',behavior:'instant'})");
        const clickPart = async selector => {
          const expression = `(() => {const el=document.getElementById('langToggle').shadowRoot.querySelector(${JSON.stringify(selector)});if(!el)return false;const r=el.getBoundingClientRect();return r.width && r.height ? {x:r.x+r.width/2,y:r.y+r.height/2} : false;})()`;
          await cdp.wait(expression); const point = await cdp.evaluate(expression);
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); await sleep(400);
        };
        await clickPart('[part="trigger"]');
        await clickPart(`.blora-select__option[data-index="${value === 'en' ? 1 : 0}"]`);
        try { await cdp.wait(`I18N.current() === '${value}'`); }
        catch (error) { error.message += ' ' + JSON.stringify(await cdp.evaluate("({value:document.getElementById('langToggle').value, html:document.getElementById('langToggle').outerHTML, active:document.activeElement?.outerHTML, open:document.getElementById('langToggle').isOpen, wired:document.getElementById('langToggle').dataset.i18nWired})")); throw error; }
        await sleep(500);
        await expect("adminApp.modelLibrary.teamId === '1' && adminApp.modelLibrary.filters.q === 'Alpha' && adminApp.modelLibrary.selected.has('fixture-model')", '语言切换不得丢失筛选范围选择');
      };
      await language('en'); await expect("document.querySelector('.aml-header h2').textContent === 'Model Library'", '英文标题'); await language('zh');
      await expect("document.querySelector('.aml-header h2').textContent === '模型库'", '中文标题');
    });
    for (const mode of ['personal', 'local']) await check(`${mode} 内嵌无TEAM入口或API`, async () => {
      const before = state.requests.length; await navigate(390, 'myUpstream', mode);
      if (await cdp.evaluate("!document.getElementById('adminLibraryManager').hidden", true)) await cdp.click('#adminLibraryManagerClose', true);
      await expect("!document.querySelector('[data-action=manage-teams]') && !document.querySelector('.aml-team-tabs [data-team=\"1\"]')", '个人/本地无TEAM入口', true);
      assert.ok(!state.requests.slice(before).some(r => /\/api\/(admin|user)\/teams/.test(r.url)), '个人/本地不应请求TEAM API');
    });
    await check('供应商启停连通性和额度仅fixture响应可见', async () => {
      await navigate(1440); await cdp.click('[data-action="toggle-provider"][data-id="fixture-provider"]'); await confirm(true);
      await cdp.wait("!document.getElementById('adminLibraryManager').hidden"); await sleep(500);
      assert.equal(state.providerEnabled, false);
      await cdp.click('#adminLibraryManagerClose'); await loaded(); await expect("document.querySelector('[data-provider=fixture-provider]').textContent.includes('供应商已关闭')", '关闭状态可见');
      await cdp.click('[data-action="toggle-provider"][data-id="fixture-provider"]'); await cdp.wait("!document.getElementById('adminLibraryManager').hidden"); await sleep(500); assert.equal(state.providerEnabled, true); await cdp.click('#adminLibraryManagerClose'); await loaded();
      await cdp.click('[data-action="test-provider"][data-id="fixture-provider"]'); await cdp.wait("document.getElementById('adminProvidersPage').textContent.includes('123ms')"); await cdp.click('#adminLibraryManagerClose'); await loaded();
      await cdp.click('[data-action="quota-provider"][data-id="fixture-provider"]'); await cdp.wait("document.getElementById('providerQuotaModal').hasAttribute('open') && document.getElementById('quotaRemaining').textContent === '75'");
    });
    await check('授权变更后普通成员console共享读取', async () => {
      await navigate(1440); await cdp.click('[data-team="1"]'); await loaded(); await expand(); await cdp.click(switchModel); await cdp.wait("document.querySelector('.aml-notice')?.textContent.includes('已启用')");
      const memberRead = async expected => {
        state.member = true; await cdp.send('Page.navigate', { url: `${base}/console#modelLibrary` });
        await cdp.wait("typeof app !== 'undefined' && app.currentPage === 'modelLibrary' && !!app._libraryData");
        await expect('app.user.isAdmin === false', '普通成员非管理员');
        assert.equal(await cdp.evaluate("app._libraryData.teams[0].providers.length > 0"), expected);
        if (expected) { await cdp.click('#modelLibraryContent .model-library-provider-header'); await cdp.wait("!!document.querySelector('#modelLibraryContent [data-model-id=fixture-model]')"); }
      };
      await memberRead(true);
      state.member = false; await cdp.send('Page.navigate', { url: `${base}/admin#adminModelLibrary/team/1` }); await loaded(); await expand(); await cdp.click(switchModel); await confirm(true); await cdp.wait("document.querySelector('.aml-notice')?.textContent.includes('已关闭')");
      await memberRead(false);
    });
    await check('隔离、请求记录与运行异常', async () => {
      assert.ok(state.requests.some(r => r.url.startsWith('/api/admin/model-library')));
      assert.equal(cdp.exceptions.length, 0, JSON.stringify(cdp.exceptions));
      assert.deepEqual(state.unknown.filter(r => r.method !== 'GET'), [], '不得执行未声明变更、真实供应商测试或同步');
    });
    console.log(JSON.stringify({ results, requests: state.requests, writes: state.writes, unknown: state.unknown, exceptions: cdp.exceptions }, null, 2));
    if (process.env.ADMIN_LIBRARY_REPORT) fs.writeFileSync(process.env.ADMIN_LIBRARY_REPORT, JSON.stringify({ results, requests: state.requests, writes: state.writes, unknown: state.unknown, exceptions: cdp.exceptions }, null, 2));
    console.log(`验收完成：${results.filter(r => r.pass).length} PASS，${results.filter(r => !r.pass).length} FAIL；${state.requests.length} requests，${state.writes.length} 内存 writes。`);
    assert.equal(results.filter(r => !r.pass).length, 0, '存在未通过的浏览器验收项');
  } finally {
    cdp?.close();
    if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) { const exited = once(chrome, 'exit'); chrome.kill('SIGTERM'); await Promise.race([exited, sleep(3000)]); if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await exited; } }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); console.log('已清理 fixture、Chrome 与临时目录。');
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
