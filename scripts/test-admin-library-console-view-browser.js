'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');

async function main() {
  const serverApp = express();
  const root = path.resolve(__dirname, '../public');
  serverApp.use(express.static(root));
  serverApp.get('/', (req, res) => res.send(`<!doctype html><meta charset="utf-8">
    <link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/model-library-blora.css"><link rel="stylesheet" href="/css/admin-model-library.css">
    <div id="library"></div><pre id="result">pending</pre>
    <script src="/js/admin-library-console-view.js"></script><script src="/js/admin-model-library.js"></script><script>
    (async () => {
      try {
        const check = (value, message) => { if (!value) throw new Error(message); };
        const app = { _instance: { capabilities: { teamAdmin: true } }, _parseAdminHash: () => ({ teamId: 1 }) };
        const library = new AdminModelLibrary(app);
        let enabled = false, writes = 0;
        library.request = async (url, options) => {
          if (options?.method === 'PUT') { enabled = JSON.parse(options.body).enabled; writes++; return { updated: 1 }; }
          if (url === '/api/admin/teams') return [{ id: 1, name: 'Fixture TEAM' }];
          const mode = new URL(url, location.origin).searchParams.get('mode');
          return mode === 'providers'
            ? { items: [{ provider_id: 'p1', provider_name: 'Fixture provider', model_count: 1 }], total: 1, stats: { model_count: 1 } }
            : { items: [{ model_id: 'm1', name: 'Fixture model', system_enabled: true, team_enabled: enabled, test_ok: true, test_latency_ms: 20, test_tokens_per_second: 50 }], page: 1, limit: 24, total: 1 };
        };
        library.mount('#library');
        await library.load();
        const expand = document.querySelector('[data-action=expand]');
        await library.onClick({ target: expand });
        check(document.querySelector('.model-library-item-info .model-library-item-name'), 'console model structure missing');
        check(document.querySelector('.model-library-provider-header'), 'console provider structure missing');
        const checkbox = document.querySelector('[data-select]');
        checkbox.click();
        check(writes === 0 && library.selected.has('m1'), 'selection must not change authorization');
        await library.onClick({ target: document.querySelector('[data-action=toggle-model]') });
        check(writes === 1 && enabled, 'TEAM switch did not authorize');
        check(document.querySelector('[data-action=toggle-model]').getAttribute('aria-checked') === 'true', 'switch not updated');
        document.dispatchEvent(new Event('i18n:ready'));
        check(document.querySelector('.model-library-item.selected'), 'selected model lost on language change');
        check(!document.querySelector('[onclick*="selectModel"]'), 'user binding leaked');
        check(document.documentElement.scrollWidth <= innerWidth + 1, 'horizontal overflow');
        document.getElementById('result').textContent = 'BROWSER_PASS';
      } catch (error) { document.getElementById('result').textContent = 'BROWSER_FAIL: ' + error.stack; }
    })();</script>`));
  const server = serverApp.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    for (const width of [1440, 390]) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-console-view-'));
      try {
        const browser = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${directory}`, `--window-size=${width},900`, '--dump-dom', '--virtual-time-budget=3000', `http://127.0.0.1:${server.address().port}`]);
        let output = '';
        browser.stdout.on('data', chunk => { output += chunk; });
        browser.stderr.resume();
        const timer = setTimeout(() => browser.kill('SIGKILL'), 60000);
        try {
          const code = await new Promise((resolve, reject) => { browser.once('error', reject); browser.once('exit', resolve); });
          assert.equal(code, 0, 'Chrome failed');
          assert.match(output, /<pre id="result">BROWSER_PASS<\/pre>/, output.match(/<pre id="result">[\s\S]*?<\/pre>/)?.[0]);
          console.log('PASS console-to-admin browser layout and authorization: ' + width);
        } finally { clearTimeout(timer); }
      } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
  } finally { server.closeAllConnections(); server.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
