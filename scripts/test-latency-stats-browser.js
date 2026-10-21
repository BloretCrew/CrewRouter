#!/usr/bin/env node
'use strict';
// 前置：verify-blora-correction-browser.js --server / --chrome。
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CDP {
  constructor(url) {
    this.id = 0; this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
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
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ': ' + (response.exceptionDetails.exception?.description || ''));
    return response.result.value;
  }
}

async function waitFor(cdp, expression, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    if (await cdp.evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  const debugging = process.env.BLORA_CDP_URL || 'http://127.0.0.1:18572';
  const base = process.env.BLORA_TEST_URL || 'http://127.0.0.1:18571';
  const target = await fetch(`${debugging}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  const cdp = new CDP(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');

    for (const width of [1440, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: `${base}/console#stats` });
      await waitFor(cdp, `typeof app !== 'undefined' && app._statsFiltersLoaded`, 'console stats');
      await cdp.evaluate(`app.switchStatsTab('latency')`);
      await waitFor(cdp, `document.querySelectorAll('#latencySummaryCards .stats-overview-card').length >= 6`, 'console latency cards');
      const state = await cdp.evaluate(`(() => ({
        cards: document.querySelectorAll('#latencySummaryCards .stats-overview-card').length,
        modelRows: document.querySelectorAll('#latencyModelTableBody tr').length,
        limitRows: document.querySelectorAll('#latencyRateLimitTableBody tr').length,
        notice: document.getElementById('latencyStatsNotice').textContent,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        ttftChart: document.getElementById('userLatencyTtftChart').width > 0,
        tpsChart: document.getElementById('userLatencyTpsChart').width > 0
      }))()`);
      assert.ok(state.cards >= 6, `console ${width}: cards`);
      assert.ok(state.modelRows >= 3, `console ${width}: model rows`);
      assert.ok(state.limitRows >= 1, `console ${width}: rate limit rows`);
      assert.ok(state.notice.includes('已采集'), `console ${width}: coverage`);
      assert.ok(state.ttftChart && state.tpsChart, `console ${width}: charts`);
      assert.equal(state.overflow, false, `console ${width}: no horizontal overflow`);

      if (width === 1440) {
        const filtered = await cdp.evaluate(`(async () => {
          const select = document.getElementById('statsModelFilter');
          const option = [...select.querySelectorAll('blora-option')].find(o => o.getAttribute('value'));
          select.value = option.getAttribute('value');
          await app.loadLatencyStats();
          return performance.getEntriesByType('resource')
            .filter(entry => entry.name.includes('/api/user/stats/latency'))
            .map(entry => entry.name);
        })()`);
        assert.ok(filtered.some(url => url.includes('model_id=')), 'model filter is sent to the latency API');

        const empty = await cdp.evaluate(`(async () => {
          const original = window.fetch;
          window.fetch = async (url, options) => {
            if (String(url).includes('/api/user/stats/latency')) {
              return new Response(JSON.stringify({
                window: { start: '2026-10-15', end: '2026-10-21', days: 7, requestedDays: 7, clipped: true, maxDays: 90, timezone: 'Asia/Shanghai' },
                coverage: { totalRequests: 0, measuredRequests: 0, rate: 0 },
                summary: { requests: 0, measuredRequests: 0, coverage: 0, ttft: {}, e2e: {}, tpot: {}, outputTps: {}, tpsThresholds: {} },
                byModel: [], byProvider: [], daily: [], rateLimits: [], rateLimitNote: null
              }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return original(url, options);
          };
          try {
            await app.loadLatencyStats();
            return {
              notice: document.getElementById('latencyStatsNotice').textContent,
              modelText: document.getElementById('latencyModelTableBody').textContent,
              limitText: document.getElementById('latencyRateLimitTableBody').textContent
            };
          } finally { window.fetch = original; }
        })()`);
        assert.ok(empty.notice.includes('尚未包含延迟指标'), 'empty coverage note');
        assert.ok(empty.notice.includes('裁剪'), 'clipped range note');
        assert.ok(empty.modelText.includes('暂无数据'), 'empty model table');
        assert.ok(empty.limitText.includes('暂无数据'), 'empty rate-limit table');

        const failed = await cdp.evaluate(`(async () => {
          const original = window.fetch;
          window.fetch = async (url, options) => {
            if (String(url).includes('/api/user/stats/latency')) {
              return new Response(JSON.stringify({ error: '延迟统计查询超时，请缩小时间范围' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
            }
            return original(url, options);
          };
          try {
            await app.loadLatencyStats();
            return { notice: document.getElementById('latencyStatsNotice').textContent, modelText: document.getElementById('latencyModelTableBody').textContent };
          } finally { window.fetch = original; }
        })()`);
        assert.ok(failed.notice.includes('缩小时间范围'), 'error note');
        assert.ok(failed.modelText.includes('缩小时间范围'), 'error table');
      }

      await cdp.evaluate(`app.switchStatsTab('logs')`);
      await waitFor(cdp, `document.querySelectorAll('#usageLogsList tr[onclick]').length > 0`, 'console usage logs');
      await cdp.evaluate(`app.showUsageDetail(0)`);
      await waitFor(cdp, `!!document.querySelector('.modal-body')`, 'console usage detail');
      const detail = await cdp.evaluate(`document.body.innerText`);
      for (const label of ['首字延迟（TTFT）', '端到端延迟', '限流状态', '服务层级']) {
        assert.ok(detail.includes(label), `console detail includes ${label}`);
      }
      await cdp.evaluate(`document.querySelector('.modal-close, [onclick*="closeModal"], [onclick*="hide"]')?.click()`);
      await sleep(200);
    }

    for (const width of [1440, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp.send('Page.navigate', { url: `${base}/admin#adminStats` });
      await waitFor(cdp, `typeof adminApp !== 'undefined'`, 'admin app');
      await cdp.evaluate(`adminApp.switchStatsTab('latency')`);
      await waitFor(cdp, `document.querySelectorAll('#adminLatencySummaryCards .stats-overview-card').length >= 6`, 'admin latency cards');
      const state = await cdp.evaluate(`(() => ({
        cards: document.querySelectorAll('#adminLatencySummaryCards .stats-overview-card').length,
        modelRows: document.querySelectorAll('#adminLatencyModelTableBody tr').length,
        providerRows: document.querySelectorAll('#adminLatencyProviderTableBody tr').length,
        limitRows: document.querySelectorAll('#adminLatencyRateLimitTableBody tr').length,
        notice: document.getElementById('adminLatencyNotice').textContent,
        overflow: document.documentElement.scrollWidth > innerWidth + 1
      }))()`);
      assert.ok(state.cards >= 6, `admin ${width}: cards`);
      assert.ok(state.modelRows >= 3, `admin ${width}: model rows`);
      assert.ok(state.providerRows >= 3, `admin ${width}: provider rows`);
      assert.ok(state.limitRows >= 1, `admin ${width}: rate limit rows`);
      assert.ok(state.notice.includes('已采集'), `admin ${width}: coverage`);
      assert.equal(state.overflow, false, `admin ${width}: no horizontal overflow`);

      await cdp.evaluate(`adminApp.switchStatsTab('logs')`);
      await waitFor(cdp, `document.querySelectorAll('#usageLogsList tr[data-usage-log-idx]').length > 0`, 'admin usage logs');
      await cdp.evaluate(`(() => { const tr = document.querySelector('#usageLogsList tr[data-usage-log-idx]'); const idx = parseInt(tr.getAttribute('data-usage-log-idx'), 10); adminApp.showUsageDetail(adminApp._usageLogCache[idx]); })()`);
      await waitFor(cdp, `!!document.getElementById('usageDetailContent') && document.getElementById('usageDetailContent').textContent.length > 50`, 'admin usage detail');
      const detail = await cdp.evaluate(`document.getElementById('usageDetailContent').textContent`);
      for (const label of ['首字延迟（TTFT）', '端到端延迟', '限流状态', '服务层级']) {
        assert.ok(detail.includes(label), `admin detail includes ${label}`);
      }
      await cdp.evaluate(`document.getElementById('usageDetailModal')?.close?.()`);
      await sleep(200);
    }

    console.log('latency stats browser checks passed');
  } finally {
    await cdp.send('Page.close').catch(() => {});
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
