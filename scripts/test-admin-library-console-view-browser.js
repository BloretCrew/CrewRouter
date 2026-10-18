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
    <meta name="viewport" content="width=device-width, initial-scale=1"><script type="module" src="/vendor/blora-2.0.8/auto.js"></script>
    <style>@layer legacy-reset, blora.tokens, blora.reset, blora.base, blora.components, blora.utilities;</style>
    <link rel="stylesheet" href="/vendor/blora-2.0.8/blora.css"><link rel="stylesheet" href="/vendor/blora-2.0.8/tokens.dark.css">
    <link rel="stylesheet" href="/css/themes.css"><link rel="stylesheet" href="/css/main.css"><link rel="stylesheet" href="/css/model-library-blora.css"><link rel="stylesheet" href="/css/admin-model-library.css">
    <style>body{padding:24px;background:var(--blora-color-surface-page)}#library{max-width:1120px;margin:auto}</style><div id="library"></div><pre id="result">pending</pre>
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
        await customElements.whenDefined('blora-select');
        check(document.querySelector('blora-search[data-filter="q"]'), 'console search missing');
        check(document.querySelector('blora-select[data-filter="provider"]'), 'console select missing');
        check(getComputedStyle(document.documentElement).getPropertyValue('--blora-space-4').trim(), 'Blora design tokens missing');
        check(parseFloat(getComputedStyle(document.querySelector('[data-action="add-provider"]')).paddingLeft) > 8, 'legacy reset erased button padding');
        check(document.querySelectorAll('.aml-header > .model-library-header-actions > button').length === 2, 'header must keep only two main actions');
        check(document.querySelectorAll('.aml-card-actions > button').length === 1, 'card actions must be condensed');
        check(!document.querySelector('select[data-filter]'), 'native admin select leaked');
        const checkbox = document.querySelector('[data-select]');
        checkbox.click();
        check(writes === 0 && library.selected.has('m1'), 'selection must not change authorization');
        await library.onClick({ target: document.querySelector('[data-action=toggle-model]') });
        check(writes === 1 && enabled, 'TEAM switch did not authorize');
        check(document.querySelector('[data-action=toggle-model]').getAttribute('aria-checked') === 'true', 'switch not updated');
        document.dispatchEvent(new Event('i18n:ready'));
        check(document.querySelector('.model-library-item.selected'), 'selected model lost on language change');
        check(!document.querySelector('[onclick*="selectModel"]'), 'user binding leaked');
        library.filters.provider = 'p1';
        library.updateOptions({ provider_options: [{ provider_id: 'p1', provider_name: 'Fixture provider' }], series: ['GPT'] });
        check(document.querySelector('[data-filter="provider"]').value === 'p1', 'custom select lost filter');
        const dropdown = document.querySelector('.aml-card-actions blora-dropdown');
        await new Promise(resolve => setTimeout(resolve, 100));
        check(dropdown.querySelectorAll('[data-value^="admin-library:"]').length === 4, 'model actions missing');
        const item = dropdown.querySelector('[data-value*="test-model"]');
        let tested = '';
        app.testModel = async id => { tested = id; };
        library.onSelect({ target: dropdown, detail: { value: item.dataset.value } });
        await new Promise(resolve => setTimeout(resolve, 50));
        check(tested === 'm1', 'dropdown action dispatch failed');
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
        const capture = process.env.ADMIN_LIBRARY_SCREENSHOTS ? [`--screenshot=${path.join(process.env.ADMIN_LIBRARY_SCREENSHOTS, 'admin-model-library-' + width + '.png')}`] : [];
        const browser = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${directory}`, `--window-size=${width},900`, ...capture, '--dump-dom', '--virtual-time-budget=5000', `http://127.0.0.1:${server.address().port}`]);
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
