'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function fixture() {
  const calls = [];
  const context = {
    window: { location: { origin: 'http://localhost' } }, URL, URLSearchParams,
    AbortController, setTimeout, clearTimeout,
    fetch: async url => {
      calls.push(url);
      assert.ok(url.startsWith('/api/user/'));
      return { ok: true, json: async () => url.includes('/search?')
        ? { models: [{ model_id: 'model' }], pagination: { page: 2, limit: 24, total: 30 } }
        : { teams: [{ team_id: 1, team_name: 'One', providers: [{ provider_id: 'p1', provider_name: 'Same name', visible_model_count: 3 }] }, { team_id: 2, team_name: 'Two', providers: [{ provider_id: 'p1', provider_name: 'Same name', visible_model_count: 4 }, { provider_id: 'hidden', is_hidden: true }] }], available_series: ['GPT'], total_models: 7 } };
    }
  };
  for (const file of ['admin-model-library.js', 'console-model-library.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8'), context);
  const app = { _instance: { capabilities: {} } };
  const library = new context.window.ConsoleModelLibrary(app);
  return { library, calls, app };
}

test('console reuses admin component, aggregates authorized providers and omits hidden providers', async () => {
  const { library, calls, app } = fixture();
  const data = await library.request(library.query('providers'));
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].model_count, 7);
  assert.equal(library.teams.length, 2);
  assert.equal(app._libraryData.total_models, 7);
  library.teamId = '1';
  const scoped = await library.request(library.query('providers'));
  assert.equal(scoped.items[0].model_count, 3);
  assert.equal(calls.length, 2);
});

test('model pages use exact provider ID, TEAM scope and user-compatible filters', async () => {
  const { library, calls } = fixture();
  library.providers = [{ provider_id: 'p1', provider_name: 'Same name' }];
  library.teamId = '2';
  Object.assign(library.filters, { q: 'a&b', series: 'GPT', tag: '4', test: 'pass', sort: 'test_speed' });
  const data = await library.request(library.query('models', { provider: 'p1', page: '2', limit: '24' }));
  const params = new URL(calls[0], 'http://localhost').searchParams;
  assert.equal(params.get('provider_id'), 'p1');
  assert.equal(params.get('team_id'), '2');
  assert.equal(params.get('q'), 'a&b');
  assert.equal(params.get('sort'), 'test_tps_desc');
  assert.equal(params.get('tag'), '4');
  assert.equal(data.total, 30);
  assert.equal(data.page, 2);
});

test('console rejects management requests and ignores management click actions', async () => {
  const { library, calls } = fixture();
  await assert.rejects(library.request('/api/admin/models'), /操作不可用/);
  library.container = { contains: () => true };
  await library.onClick({ target: { closest: () => ({ dataset: { action: 'toggle-provider', id: 'p1' } }) } });
  assert.equal(calls.length, 0);
});

test('browser renders shared shell, model cards, binding and language redraw without admin actions', async () => {
  const express = require('express');
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const serverApp = express();
  serverApp.use('/js', express.static(path.join(__dirname, '../public/js')));
  serverApp.get('/', (req, res) => res.send(`<!doctype html><div id="library"></div><pre id="result">pending</pre>
    <script src="/js/admin-model-library.js"></script><script src="/js/console-model-library.js"></script><script>
    (async () => {
      try {
        const check = (value, message) => { if (!value) throw new Error(message); };
        let bound = '';
        window.fetch = async url => {
          check(url.startsWith('/api/user/'), 'admin request: ' + url);
          return { ok: true, json: async () => url.includes('/search?')
            ? { models: [{ model_id: 'm1', name: 'Fixture model', enabled: true }], pagination: { page: 1, limit: 24, total: 1 } }
            : { teams: [{ team_id: 1, team_name: 'Fixture TEAM', providers: [{ provider_id: 'p1', provider_name: 'Fixture provider', model_count: 1 }] }], total_models: 1 } };
        };
        const app = { _getSelectedLibraryKey: () => ({ current_model_id: bound }), selectModel: async id => { bound = id; } };
        const library = new ConsoleModelLibrary(app).mount('#library');
        await library.load();
        check(document.querySelector('.aml-provider'), 'provider missing');
        check(!document.querySelector('[data-action="toggle-provider"]'), 'provider switch leaked');
        document.querySelector('[data-action="expand"]').click();
        await new Promise(resolve => setTimeout(resolve, 50));
        check(document.querySelector('.aml-card'), 'model missing');
        check(!document.querySelector('[data-action="toggle-model"]'), 'model switch leaked');
        document.querySelector('[data-action="bind-model"]').click();
        await new Promise(resolve => setTimeout(resolve, 50));
        check(bound === 'm1', 'binding failed');
        document.dispatchEvent(new Event('i18n:ready'));
        check(document.querySelector('.aml-card.is-selected'), 'binding highlight lost');
        check(!document.querySelector('[data-action="manage-teams"]'), 'admin action leaked');
        document.getElementById('result').textContent = 'BROWSER_PASS';
      } catch (error) { document.getElementById('result').textContent = 'BROWSER_FAIL: ' + error.stack; }
    })();</script>`));
  const server = serverApp.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'console-library-'));
  try {
    const browser = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${directory}`, '--dump-dom', '--virtual-time-budget=3000', `http://127.0.0.1:${server.address().port}`]);
    let output = '';
    browser.stdout.on('data', chunk => { output += chunk; });
    const code = await new Promise((resolve, reject) => { browser.once('error', reject); browser.once('exit', resolve); });
    assert.equal(code, 0);
    assert.match(output, /<pre id="result">BROWSER_PASS<\/pre>/, output.match(/<pre id="result">[\s\S]*?<\/pre>/)?.[0]);
  } finally {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
