'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18671';
const debugging = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18672';
process.env.BLORA_TEST_URL = base;
process.env.BLORA_CDP_URL = debugging;

if (process.argv.includes('--server')) {
  const express = require('express');
  const http = require('node:http');
  const records = Array.from({ length: 51 }, (_, i) => ({
    id: i + 1, model_name: 'Fixture main model', model_id: 'fixture', upstream_model_id: 'current-config-not-history',
    requested_model: i === 3 ? undefined : i === 4 ? '<img src=x onerror="window.identityXss=1">&' + '长模型'.repeat(160) : 'client-alias',
    resolved_model: i === 3 ? undefined : 'route-model',
    response_model: i === 2 ? null : i === 3 ? undefined : i === 0 ? 'route-model' : 'response-model',
    created_at: new Date(Date.now() - i * 60000).toISOString(), username: 'Fixture user', user_id: 1,
    tokens_used: 30, prompt_tokens: 20, completion_tokens: 10, cached_tokens: 0, cost: 0.001,
    request_type: 'chat', request_source: 'claude-code', latency_ms: 10, key_prefix: 'fixture'
  }));
  const requests = [];
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'response-from-mock-upstream', choices: [{ message: { role: 'assistant', content: 'Mock reply' } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
  });
  upstream.listen(0, '127.0.0.1');
  const original = express.application.init;
  express.application.init = function () {
    original.call(this);
    this.use(async (req, res, next) => {
      const url = new URL(req.url, base);
      const pathname = url.pathname;
      if (pathname === '/__identity/requests') return res.json(requests);
      if (pathname === '/__identity/reset' && req.method === 'POST') {
        while (records[0]?.id === 100) records.shift();
        requests.length = 0;
        return res.json({ ok: true });
      }
      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        const response = await fetch(`http://127.0.0.1:${upstream.address().port}/chat`, { method: 'POST', body: raw }).then(r => r.json());
        records.unshift({ ...records[0], id: 100, requested_model: body.model, resolved_model: 'route-to-mock', response_model: response.model });
        return res.json(response);
      }
      if (/^\/api\/(user|admin)\/usage-logs(?:\/.*)?$/.test(pathname)) {
        requests.push(req.url);
        if (url.searchParams.get('model_q') === 'error') return res.status(502).json({ error: 'Fixture failure' });
        const filtered = url.searchParams.get('model_q') === 'empty' ? [] : records;
        if (pathname.endsWith('/export')) {
          res.setHeader('Content-Disposition', 'attachment; filename="identity-fixture.csv"');
          return res.type('text/csv').send('requested_model,resolved_model,response_model\n' + filtered.map(r => [r.requested_model, r.resolved_model, r.response_model].map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n'));
        }
        const id = pathname.match(/\/(\d+)$/)?.[1];
        if (id) return res.json({ log: { ...records.find(r => r.id === Number(id)), messages: [], response: 'Mock reply' } });
        const page = Number(url.searchParams.get('page') || 1), limit = Number(url.searchParams.get('limit') || 50);
        return res.json({ logs: filtered.slice((page - 1) * limit, page * limit), total: filtered.length, page });
      }
      if (pathname === '/api/user/sessions') return res.json({ items: [{ sessionKey: 'identity-fixture', harness: 'claude-code', firstSeen: records[0].created_at, lastSeen: records[0].created_at, requestCount: 5, totalTokens: 150, lastMessagePreview: 'Model identity fixture' }], total: 1, pageSize: 20 });
      if (pathname === '/api/user/sessions/identity-fixture/messages') return res.json({ records: records.slice(0, 5).map(r => ({ ...r, model: r.model_name, ts: r.created_at, tokens: r.tokens_used, harness: r.request_source, events: [{ type: 'text', role: 'user', text: 'Fixture prompt' }] })), total: 5, nextCursor: null });
      next();
    });
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => upstream.close(() => process.exit(0)));
  require('./verify-blora-correction-browser');
} else if (process.argv.includes('--chrome')) {
  require('./verify-blora-correction-browser');
} else main().catch(error => { console.error(error); process.exitCode = 1; });

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
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);
    await sleep(150);
    const point = await this.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return null;const r=e.getBoundingClientRect();const x=(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,y=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;const hit=document.elementFromPoint(x,y);return hit===e||e.contains(hit)?{x,y}:null;})()`);
    assert.ok(point, `visible click target ${selector}`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await sleep(200);
  }
}
async function main() {
  const reset = await fetch(`${base}/__identity/reset`, { method: 'POST' });
  assert.ok(reset.ok, 'reset isolated fixture');
  const target = await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  let assertions = 0;
  const check = async (expression, message) => { assert.ok(await cdp.evaluate(expression), message); assertions++; };
  const wait = async expression => { for (let i = 0; i < 100; i++) { if (await cdp.evaluate(expression)) return; await sleep(100); } throw new Error(`Timeout: ${expression}`); };
  const shots = process.env.IDENTITY_SCREENSHOT_DIR;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  try {
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: process.env.IDENTITY_DOWNLOAD_DIR || '/tmp/crewrouter-identity-downloads' });
    for (const width of (process.env.IDENTITY_WIDTHS || '1440,390').split(',').map(Number)) for (const mode of ['light', 'dark']) for (const page of ['console', 'admin']) {
      const app = page === 'console' ? 'app' : 'adminApp';
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: `${base}/${page}#${page === 'console' ? 'stats' : 'adminStats'}` });
      await wait(`typeof ${app} !== 'undefined' && typeof ModelIdentity !== 'undefined' && !!customElements.get('blora-dialog')`);
      await sleep(1000);
      await cdp.evaluate(`window.themeManager.theme='${mode}';window.themeManager.applyTheme();`);
      await check(`document.documentElement.classList.contains('${mode}') && getComputedStyle(document.documentElement).colorScheme==='${mode}'`, 'real theme mode');
      await cdp.click(`[onclick="${app}.switchStatsTab('logs')"]`);
      await wait("document.querySelectorAll('#usageLogsList tbody tr').length===50");
      await check("document.querySelector('#usageLogsList').textContent.includes('客户端请求模型') && document.querySelector('#usageLogsList').textContent.includes('模型名称不一致')", 'list fields and mismatch');
      await check("!window.identityXss && !document.querySelector('#usageLogsList img')", 'list names are escaped');
      for (const [index, expected] of [[0, '模型名称一致'], [1, '模型名称不一致'], [2, '上游未提供'], [3, '历史记录'], [4, '<img src=x']]) {
        await cdp.click(`#usageLogsList tbody tr:nth-child(${index + 1})`);
        await wait("!!document.querySelector('#usageDetailContent .model-identity-detail')");
        await check(`document.querySelector('#usageDetailContent .model-identity-detail').textContent.includes(${JSON.stringify(expected)})`, `detail ${expected}`);
        await check("!window.identityXss && !document.querySelector('#usageDetailContent img')", 'detail names escaped');
        await check("(() => {const d=document.querySelector('#usageDetailContent .model-identity-detail');return d.scrollWidth<=d.clientWidth+1;})()", 'identity detail wraps');
        if (shots && index === 4) { const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, `${page}-${width}-${mode}.png`), Buffer.from(shot.data, 'base64')); }
        await cdp.click(`#usageDetailModal .modal-close`);
        await wait("!document.querySelector('#usageDetailModal').hasAttribute('open')");
      }
      await cdp.click('#usageLogNextBtn'); await wait("document.querySelectorAll('#usageLogsList tbody tr').length===1");
      await cdp.click('#usageLogPrevBtn'); await wait("document.querySelectorAll('#usageLogsList tbody tr').length===50");
      for (const value of ['empty', 'error', '']) {
        await cdp.evaluate(`document.querySelector('#usageLogModelFilter').value=${JSON.stringify(value)}`);
        await cdp.click(`[onclick="${app}.loadUsageLogs(${page === 'console' ? '' : '1'})"]`);
        await wait(value === 'empty' ? "document.querySelector('#usageLogsList').textContent.includes('暂无调用记录')" : value === 'error' ? "!document.querySelector('#usageLogsList table') && !document.querySelector('#usageLogsList').textContent.includes('暂无调用记录')" : "document.querySelectorAll('#usageLogsList tbody tr').length===50");
        assertions++;
      }
      await cdp.click('#usageLogExportBtn');
      await check(`!document.querySelector('#usageLogExportBtn').disabled`, 'export restored button');
      await check("document.documentElement.scrollWidth<=innerWidth+1", 'page has no horizontal overflow');
      if (page === 'console') {
        await cdp.evaluate("location.hash='sessions'"); await wait("!!document.querySelector('[data-session-key=identity-fixture]')");
        await cdp.click('[data-session-key=identity-fixture]'); await wait("document.querySelectorAll('.model-identity-session').length===5");
        await cdp.click('.model-identity-session:nth-of-type(1) summary');
        await check("document.querySelector('.model-identity-session').open && document.querySelector('.model-identity-session').textContent.includes('客户端请求模型')", 'session per-call details');
        for (const route of ['modelLibrary', 'bloraAgent/chat', 'stats']) { await cdp.evaluate(`location.hash=${JSON.stringify(route)}`); await sleep(600); await check(`location.hash===${JSON.stringify('#' + route)}`, 'surrounding route ' + route); }
      } else {
        for (const route of ['adminModels', 'adminProviders', 'adminStats']) { await cdp.evaluate(`location.hash=${JSON.stringify(route)}`); await sleep(600); await check(`location.hash===${JSON.stringify('#' + route)}`, 'surrounding route ' + route); }
      }
      console.log(`PASS ${page} ${width}px ${mode}`);
    }
    await cdp.send('Page.navigate', { url: `${base}/console#stats` }); await wait("typeof app !== 'undefined' && !!window.themeManager"); await sleep(1500);
    await cdp.evaluate("fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'browser-request-alias',messages:[{role:'user',content:'test'}]})}).then(r=>r.json())");
    await cdp.evaluate("app.switchStatsTab('logs');app.loadUsageLogs(1)"); await wait("document.querySelector('#usageLogsList').textContent.includes('response-from-mock-upstream')");
    await cdp.send('Page.reload'); await wait("typeof app !== 'undefined' && !!window.themeManager"); await sleep(1500); await cdp.evaluate("app.switchStatsTab('logs');app.loadUsageLogs(1)");
    await wait("document.querySelector('#usageLogsList').textContent.includes('browser-request-alias')");
    await cdp.click('#usageLogsList tbody tr'); await wait("document.querySelector('#usageDetailContent').textContent.includes('response-from-mock-upstream')");
    await check("document.querySelector('#usageDetailContent').textContent.includes('route-to-mock')", 'mock call list/detail/reload identities');
    await cdp.click('#usageDetailModal .modal-close'); await cdp.click('#usageLogExportBtn');
    const csv = await cdp.evaluate("fetch('/api/user/usage-logs/export').then(r=>r.text())");
    assert.ok(csv.includes('browser-request-alias') && csv.includes('route-to-mock') && csv.includes('response-from-mock-upstream')); assertions++;
    const exceptions = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown');
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    console.log(`PASS ${assertions} browser assertions; no uncaught exceptions. Mock transport is a frontend fixture, not the production proxy/database.`);
  } finally { cdp.ws.close(); await fetch(`${debugging}/json/close/${target.id}`); }
}
