'use strict';

// Run the actual router against a disposable Unix-socket cluster, never deployment config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const { Pool } = require('pg');
const { createIsolatedPostgres } = require('./test-support/isolated-postgres');

async function main() {
  const cluster = createIsolatedPostgres('stats-report');
  const pool = new Pool(cluster.connection);
  let server;
  let browser;
  try {
    await cluster.assertIsolation(pool);
    const filename = path.join(__dirname, '../routes/stats-report.js');
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require(name) {
        if (name === '../config-loader') return { database: {}, statsReport: { token: 'isolated' } };
        if (name === '../logger') return { warn() {}, error() {} };
        if (name === 'pg') return { Pool: function () { return pool; } };
        return localRequire(name);
      },
      module, exports: module.exports, Buffer, process: { env: {} },
    }, { filename });
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json({ limit: '1mb', strict: false }));
    app.use('/api/stats-report', module.exports);
    app.get('/data', (_req, res) => res.sendFile(path.join(__dirname, '../../public/pages/data.html')));
    app.use(express.static(path.join(__dirname, '../../public')));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let sequence = 0;
    async function post(payload, status = 200, token = 'isolated') {
      const response = await fetch(`${origin}/api/stats-report`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-report-token': token, 'x-forwarded-for': `192.0.2.${++sequence}` },
        body: JSON.stringify({ deviceId: 'valid-instance', domain: 'test.invalid', payload }),
      });
      assert.equal(response.status, status, JSON.stringify(payload));
    }
    async function overview() {
      const response = await fetch(`${origin}/api/stats-report/overview`);
      assert.equal(response.status, 200);
      return response.json();
    }
    assert.equal((await overview()).summary.totalReports, 0);
    if (process.argv.includes('--browser')) {
      const { chromium } = require('../../blora-design/node_modules/playwright');
      browser = await chromium.launch({ executablePath: process.env.CR_TEST_CHROME || '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
      const page = await browser.newPage();
      const failures = [];
      page.on('pageerror', error => failures.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && message.text().includes('加载统计数据失败')) failures.push(message.text()); });
      await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      // Accelerate only the real page's existing refresh timer, without replacing API responses.
      await page.addInitScript(() => { const interval = window.setInterval; window.setInterval = (fn, ms, ...args) => interval(fn, ms === 30000 ? 200 : ms, ...args); });
      await page.goto(`${origin}/data`);
      await page.locator('#instancesTable .empty').waitFor();
      await page.locator('#recentTable .empty').waitFor();
      browser.page = page;
      browser.failures = failures;
    }
    const detailed = {
      granularity: 'detailed', stats: {
        requests: { total: 7, success: 7, error: 2 }, tokens: { total: 19, prompt: 11, completion: 8, cached: 3 },
        cost: 0.125, avgLatencyMs: 2, activeUsers: 1, activeKeys: 2, activeModels: 3, activeProviders: 4,
        requestTypes: [{ name: 'chat', requests: 7 }], models: [{ name: 'm', requests: 7, tokens: 19 }], providers: [{ name: 'p', requests: 7, tokens: 19 }],
      },
    };
    await post(detailed, 401, 'wrong');
    await post(detailed);
    await post({ granularity: 'counts', stats: { requests: { total: 3 }, tokens: { total: 5 }, cost: 0, requestTypes: [] } });
    await post({});
    await post({ stats: {} });
    const clean = await overview();
    assert.equal(clean.summary.totalRequests, 10);
    assert.equal(clean.summary.totalTokens, 24);
    assert.equal(clean.summary.totalCost, 0.125);
    assert.equal(clean.instances[0].reportsCount, 4);
    if (browser) {
      await browser.page.waitForFunction(() => document.querySelectorAll('#recentTable tbody tr').length === 4);
      assert((await browser.page.locator('#recentTable').textContent()).includes('chat'));
    }
    const badValues = ['abc', '12', '', null, true, -1, 0.5, 9007199254740992, 1e100, [], {}];
    for (const value of badValues) {
      for (const group of ['requests', 'tokens']) await post({ stats: { [group]: { total: value } } }, 400);
      await post({ stats: { activeUsers: value } }, 400);
    }
    for (const value of ['bad', 'NaN', 'Infinity', null, true, -0.1, 1e100, [], {}]) {
      await post({ stats: { cost: value } }, 400);
      await post({ stats: { avgLatencyMs: value } }, 400);
    }
    for (const stats of [null, [], 1, 'bad', { requests: [] }, { tokens: null }, { requestTypes: {} },
      { requestTypes: [null] }, { models: [1] }, { providers: [{ name: [] }] },
      { requestTypes: [{ requests: -1 }] }, { models: [{ tokens: 0.1 }] }]) await post({ stats }, 400);
    for (const key of ['success', 'error']) await post({ stats: { requests: { [key]: -1 } } }, 400);
    for (const key of ['prompt', 'completion', 'cached']) await post({ stats: { tokens: { [key]: 0.1 } } }, 400);
    for (const key of ['activeKeys', 'activeModels', 'activeProviders']) await post({ stats: { [key]: '1' } }, 400);
    for (const key of ['requestTypes', 'models', 'providers']) {
      await post({ stats: { [key]: 'bad' } }, 400);
      await post({ stats: { [key]: [{ requests: Number.MAX_SAFE_INTEGER + 1 }] } }, 400);
    }
    const nonfinite = await fetch(`${origin}/api/stats-report`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-report-token': 'isolated', 'x-forwarded-for': '198.51.100.1' },
      body: '{"deviceId":"nonfinite","payload":{"stats":{"cost":1e309}}}',
    });
    assert.equal(nonfinite.status, 400);
    await post([], 400);
    await post({ extra: 'x'.repeat(65536) }, 400);
    assert.equal((await overview()).summary.totalReports, 4, 'bad reports must not be inserted');
    const historical = [null, [], 'bad', {}, { stats: [] }, { stats: { requests: [], tokens: { total: '99' }, cost: 'NaN', requestTypes: { length: 1 } } },
      { stats: { requests: { total: -1 }, tokens: { total: 1.5 }, cost: -1, requestTypes: [null, 1, { name: [], requests: 1 }, { name: 'safe', requests: -1 }] } }];
    for (const payload of historical) await pool.query('INSERT INTO stats_reports(device_id,payload) VALUES($1,$2)', ['historical', JSON.stringify(payload)]);
    // JSONB supports numbers much larger than JS and bigint, but they must contribute zero.
    await pool.query(`INSERT INTO stats_reports(device_id,payload) VALUES ('historical', '{"stats":{"requests":{"total":1e1000},"tokens":{"total":9223372036854775808},"cost":1e1000,"requestTypes":[null]}}')`);
    const snapshot = async () => (await pool.query('SELECT id,payload::text FROM stats_reports ORDER BY id')).rows;
    const before = await snapshot();
    const dirty = await overview();
    assert.equal(dirty.summary.totalRequests, 10);
    assert.equal(dirty.summary.totalTokens, 24);
    assert.equal(dirty.summary.totalCost, 0.125);
    assert.equal(dirty.summary.totalReports, 12);
    for (const row of dirty.recent) {
      assert(!Array.isArray(row.stats));
      if (row.stats.requestTypes) assert(Array.isArray(row.stats.requestTypes));
    }
    assert.deepEqual(await snapshot(), before, 'overview must not rewrite historical records');
    if (browser) {
      const page = browser.page;
      await page.waitForFunction(() => document.querySelector('#recentTable')?.textContent.includes('historical'));
      assert.equal(await page.locator('#recentTable tbody tr').count(), 12);
      await page.reload();
      await page.locator('#recentTable tbody tr').first().waitFor();
      await page.locator('#themeToggle').click();
      await page.locator('#langToggle').selectOption('en');
      assert.equal(browser.failures.length, 0, browser.failures.join('\n'));
      console.log('PASS browser: real /data empty state, accepted/rejected reports, corrupted history, timer refresh, reload, theme/language interaction.');
    }
    const max = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < 1025; i++) {
      await pool.query('INSERT INTO stats_reports(device_id,payload) VALUES($1,$2)', ['overflow', JSON.stringify({ stats: { requests: { total: max }, tokens: { total: max }, cost: max } })]);
    }
    const overflow = await overview();
    for (const key of ['totalRequests', 'totalTokens', 'totalCost']) assert.equal(overflow.summary[key], max);
    assert.equal(overflow.instances[0].deviceId, 'overflow');
    assert.equal(overflow.instances[0].requests, max);
    await post({ stats: { requests: { total: max }, tokens: { total: max }, cost: max, avgLatencyMs: 0.5 } });
    assert.equal((await overview()).summary.totalRequests, max);
    console.log('PASS PostgreSQL: POST shapes/ranges, counts/detailed/partial compatibility, malformed history unchanged, bigint aggregate overflow and JS safe-number saturation.');
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await pool.end();
    cluster.stop();
    assert.equal(fs.existsSync(cluster.dataDir), false);
    assert.equal(fs.existsSync(cluster.socketDir), false);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
