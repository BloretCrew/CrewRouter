'use strict';
// 全面拦截浏览器请求；后端处理器仅使用内存 SQL fixture。
const fs = require('fs'), path = require('path'), assert = require('assert/strict'), vm = require('vm');
const { chromium } = require('/root/node_modules/playwright');
const root = path.resolve(__dirname, '../public');
const output = process.env.QUICK_TEAM_OUTPUT || '/home/detrital/clawfiles/crewrouter-functional-audit';
const results = [], requests = [], errors = [];
async function backend() {
  const source = fs.readFileSync(path.join(__dirname, '../server/routes/admin.js'), 'utf8');
  const section = source.slice(source.indexOf('// 同步供应商模型（一键'), source.indexOf('// 获取供应商默认额度'));
  assert.match(section, /requireAuth, requireAdmin/);
  const handler = section.slice(section.indexOf('async (req, res) => {'), section.lastIndexOf('});') + 1);
  for (const addOnly of [true, false]) {
    const sql = [], frontier = [];
    const pool = { query: async (query, params) => {
      sql.push({ query, params });
      if (query.startsWith('SELECT id, name')) return { rows: [{ id: 'provider' }] };
      if (query.startsWith('SELECT id, upstream')) return { rows: [{ id: 'db-old', upstream_model_id: 'old', enabled: true }] };
      return { rows: [] };
    } };
    const fn = vm.runInNewContext(`(${handler})`, { pool, crypto: { randomUUID: () => 'db-new' }, addModelsToFrontierTeams: async ids => frontier.push(...ids), Logger: { info() {}, warn() {}, error() {} } });
    let response;
    await fn({ params: { id: 'provider' }, body: { enabledModelIds: ['new', 'new'], ...(addOnly ? { addOnly } : {}) } }, { json: data => { response = data; }, status: () => { throw Error('backend error'); } });
    assert.equal(response.added, 1); assert.deepEqual(JSON.parse(JSON.stringify(response.addedModels)), [{ id: 'db-new', upstream_model_id: 'new' }]);
    assert.equal(sql.some(item => item.query.startsWith('DELETE FROM team_models')), !addOnly);
    assert.equal(response.disabled, addOnly ? 0 : 1);
    results.push({ backend: addOnly ? 'append preserves permissions' : 'legacy sync unchanged', status: 'PASS' });
  }
  const records = [], fixture = { fail: true };
  const retryHandler = vm.runInNewContext(`(${handler})`, {
    pool: { query: async (query, params) => {
      if (query.startsWith('SELECT id, name')) return { rows: [{ id: 'provider' }] };
      if (query.startsWith('SELECT id, upstream')) return { rows: records };
      if (query.includes('INSERT INTO models')) {
        if (params[3] === 'b' && fixture.fail) throw Error('fixture partial insert');
        records.push({ id: params[0], upstream_model_id: params[3], enabled: true });
      }
      return { rows: [] };
    } }, crypto: { randomUUID: () => `db-${records.length}` }, addModelsToFrontierTeams: async () => {}, Logger: { info() {}, warn() {}, error() {} }
  });
  let response, status;
  const req = { params: { id: 'provider' }, body: { enabledModelIds: ['a', 'b'], addOnly: true } };
  const res = { json: data => { response = data; }, status: code => { status = code; return res; } };
  await retryHandler(req, res); assert.equal(status, 500); assert.equal(records.length, 1);
  fixture.fail = false; await retryHandler(req, res);
  assert.equal(response.selectedModels.length, 2); assert.equal(response.added, 1);
  await retryHandler(req, res); assert.equal(response.selectedModels.length, 2); assert.equal(response.added, 0);
  results.push({ backend: 'partial insert and lost response retry returns all selected database IDs', status: 'PASS' });
}
(async () => {
  fs.mkdirSync(output, { recursive: true }); await backend();
  if (process.env.QUICK_TEAM_BACKEND_ONLY === '1') { console.log(JSON.stringify({ status: 'PASS', results }, null, 2)); return; }
  const browser = await chromium.launch({ executablePath: '/usr/sbin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    for (const scenario of ['success', 'multi', 'skip', 'empty', 'save-fail', 'fetch-fail', 'team-list-fail', 'partial', 'no-new', 'personal', 'ordinary', 'capability-false', 'save-retry', 'response-lost', 'busy-close', 'admin-sync']) {
      console.log(`Running ${scenario}`);
      const page = await browser.newPage({ viewport: { width: scenario === 'multi' ? 320 : scenario === 'partial' ? 1440 : 390, height: 900 } });
      page.setDefaultTimeout(20000);
      page.setDefaultNavigationTimeout(60000);
      page.on('pageerror', e => errors.push(e.message));
      let syncs = 0, creates = 0, teamGets = 0, modelGets = 0; const batches = [], existing = { one: ['db-history'], two: ['db-history'] };
      await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.hostname !== 'audit.invalid') return route.abort();
        if (u.pathname.startsWith('/api/')) {
          const body = route.request().postDataJSON(); requests.push({ scenario, path: u.pathname, method: route.request().method(), body });
          let data, status = 200;
          if (u.pathname.endsWith('/quick-add')) { creates++; data = { id: 'provider', name: 'Fixture Provider' }; }
          else if (u.pathname.endsWith('/fetch-models')) { modelGets++; status = scenario === 'fetch-fail' ? 502 : 200; data = status === 200 ? { models: [{ id: 'new-a' }, { id: 'new-b' }, { id: 'old' }], existingModels: [{ id: 'old', enabled: true }, ...(['save-retry', 'response-lost'].includes(scenario) && modelGets > 1 ? [{ id: 'new-a', enabled: true }] : [])] } : { error: 'fixture fetch failed' }; }
          else if (u.pathname.endsWith('/sync-models')) {
            syncs++; assert.equal(body.addOnly, scenario === 'admin-sync' ? undefined : true); assert.deepEqual(body.enabledModelIds, scenario === 'admin-sync' ? ['new-a'] : ['new-a', 'old']);
            status = (scenario === 'save-fail' || (scenario === 'save-retry' && syncs === 1)) ? 500 : 200;
            if (scenario === 'response-lost' && syncs === 1) return route.abort();
            data = status === 200 ? { success: true, selectedModels: scenario === 'no-new' ? [{ id: 'db-old', upstream_model_id: 'old' }] : [{ id: 'db-new-a', upstream_model_id: 'new-a' }, { id: 'db-old', upstream_model_id: 'old' }] } : { error: 'fixture save failed' };
          } else if (u.pathname === '/api/admin/teams') {
            teamGets++; status = scenario === 'team-list-fail' && teamGets === 1 ? 503 : 200;
            data = status === 503 ? { error: 'fixture list failed' } : scenario === 'empty' ? [] : [{ id: 'one', name: 'Fixture Team One · very long team name for mobile wrapping' }, { id: 'two', name: 'Fixture Team Two' }, { id: 'personal', name: 'Personal', is_personal: true }];
          } else if (u.pathname.endsWith('/models/batch')) {
            const team = u.pathname.split('/')[4]; batches.push(team);
            if (scenario === 'busy-close') await new Promise(resolve => setTimeout(resolve, 800));
            assert.deepEqual(body, { enabled: true, modelIds: ['db-new-a'] });
            status = scenario === 'partial' && team === 'two' && batches.filter(id => id === 'two').length === 1 ? 500 : 200;
            if (status === 200) existing[team] = [...new Set([...existing[team], ...body.modelIds])];
            data = status === 200 ? { success: true, modelIds: body.modelIds } : { error: 'fixture team failed' };
          } else throw Error(`Unexpected API ${u.pathname}`);
          return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
        }
        const file = path.resolve(root, '.' + u.pathname);
        if (!file.startsWith(root + '/') || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
        let body = fs.readFileSync(file);
        if (file.endsWith('.html')) body = body.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace('</head>', '<script type="module" src="/vendor/blora-2.0.8/auto.js"></script><script src="/js/dom.js"></script><script src="/js/blora-dialog.js"></script></head>');
        return route.fulfill({ body, contentType: ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' })[path.extname(file)] || 'application/octet-stream' });
      });
      await page.goto('http://audit.invalid/pages/console.html#modelLibrary');
      await page.evaluate(async source => {
        await customElements.whenDefined('blora-dialog'); window.t = s => s;
        (0, eval)(source.replace(/const app = new ConsoleApp\(\);[\s\S]*$/, 'window.app = Object.create(ConsoleApp.prototype);'));
        app.user = { isAdmin: true }; app.instance = { edition: 'team', capabilities: { teamAdmin: true } };
        app.showToast = () => {}; app.loadModelLibrary = async () => { window.libraryRefreshes = (window.libraryRefreshes || 0) + 1; };
        document.querySelectorAll('.page').forEach(el => el.style.display = 'none'); document.querySelector('#modelLibraryPage').style.display = 'block';
      }, fs.readFileSync(path.join(root, 'js/app.js'), 'utf8'));
      if (scenario === 'admin-sync') {
        await page.goto('http://audit.invalid/pages/admin.html#adminProviders');
        await page.evaluate(async source => {
          await customElements.whenDefined('blora-dialog'); window.t = s => s;
          (0, eval)(source.replace(/\/\/ 初始化应用[\s\S]*$/, 'window.adminApp = Object.create(AdminApp.prototype);'));
          adminApp.currentFetchProviderId = 'provider'; adminApp.showToast = () => {}; adminApp.closeModals = () => {};
          adminApp._invalidateAdminProviderModelsCache = () => {}; adminApp._notifyModelsCatalogChanged = () => {}; adminApp.loadModels = () => {};
          document.querySelector('#fetchedModelsList').innerHTML = '<input type="checkbox" value="new-a" checked>';
          document.querySelector('#saveFetchedModelsBtn').style.display = '';
          adminApp.showModal('fetchModelsModal');
          document.querySelector('#saveFetchedModelsBtn').onclick = () => adminApp.saveFetchedModels();
        }, fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8'));
        await page.locator('#saveFetchedModelsBtn').click(); await page.waitForFunction(() => !document.querySelector('#saveFetchedModelsBtn').disabled);
        assert.equal(syncs, 1); assert.equal(teamGets, 0);
      } else if (scenario === 'ordinary') {
        await page.evaluate(() => { app.user.isAdmin = false; app.checkAdminStatus(); app.showQuickAddedProviderModels('provider', 'fixture'); app.showQuickAddedModelsTeams([{ id: 'db-new-a' }]); });
        assert.equal(await page.locator('blora-dialog[open]').count(), 0); assert.equal(await page.locator('#libraryQuickAddSystemProvider').isHidden(), true);
      } else {
        await page.evaluate(scenario => { if (scenario === 'personal') app.instance.edition = 'personal'; if (scenario === 'capability-false') app.instance.capabilities.teamAdmin = false; app.showQuickAddSystemProviderDialog(); }, scenario);
        await page.locator('#quickAddProviderText').fill('Fixture configuration; intercepted only'); await page.locator('#quickAddProviderContinue').click();
        await page.locator('#quickAddedModelsStatus').waitFor();
        if (scenario === 'fetch-fail') {
          await page.locator('#quickAddedModelsStatus').filter({ hasText: 'fixture fetch failed' }).waitFor(); assert(await page.locator('#quickAddedModelsSave').isDisabled()); assert.equal(teamGets, 0);
        } else {
          await page.locator('#quickAddedModelsList input[value="new-a"]').check(); await page.locator('#quickAddedModelsSave').click();
          if (['save-retry', 'response-lost'].includes(scenario)) {
            await page.waitForFunction(() => !document.querySelector('#quickAddedModelsSave').disabled);
            assert.equal(await page.locator('#quickAddedTeamsSave').count(), 0);
            await page.locator('#quickAddedModelsRetry').click();
            await page.locator('#quickAddedModelsRetry').isEnabled();
            await page.locator('#quickAddedModelsList input[value="new-a"]').check();
            await page.locator('#quickAddedModelsSave').click();
          }
          if (scenario === 'save-fail') { await page.locator('#quickAddedModelsStatus').filter({ hasText: 'fixture save failed' }).waitFor(); assert.equal(teamGets, 0); assert.equal(await page.locator('#quickAddedTeamsSave').count(), 0); }
          else if (['personal', 'capability-false'].includes(scenario)) { await page.waitForFunction(() => window.libraryRefreshes === 1); assert.equal(teamGets, 0); assert.equal(await page.locator('#quickAddedTeamsSave').count(), 0); }
          else {
            await page.locator('#quickAddedTeamsStatus').waitFor({ state: 'attached' });
            if (scenario === 'team-list-fail') { await page.locator('#quickAddedTeamsRetry').click(); await page.locator('#quickAddedTeamsList input[value="one"]').waitFor(); assert.equal(teamGets, 2); }
            if (['empty', 'no-new'].includes(scenario)) { assert(await page.locator('#quickAddedTeamsSave').isDisabled()); await page.locator('#quickAddedTeamsSkip').click(); }
            else if (scenario === 'skip') { await page.locator('#quickAddedTeamsSkip').click(); assert.equal(batches.length, 0); }
            else {
              await page.locator('#quickAddedTeamsList input[value="one"]').check();
              if (['multi', 'partial'].includes(scenario)) await page.locator('#quickAddedTeamsList input[value="two"]').check();
              await page.locator('#quickAddedTeamsSave').click();
              if (scenario === 'busy-close') { await page.evaluate(() => document.querySelector('#quickAddedTeamsSave').closest('blora-dialog').close('close-button')); assert.equal(await page.locator('blora-dialog[open]').count(), 1); }
              await page.locator('#quickAddedTeamsStatus').filter({ hasText: scenario === 'partial' ? '部分 Team 添加失败' : '所选 Team 已添加成功' }).waitFor();
              if (scenario === 'partial') { await page.locator('#quickAddedTeamsSave').click(); await page.locator('#quickAddedTeamsStatus').filter({ hasText: '所选 Team 已添加成功' }).waitFor(); assert.deepEqual(batches, ['one', 'two', 'two']); }
              for (const team of new Set(batches)) assert.deepEqual(existing[team], ['db-history', 'db-new-a']);
              assert.equal(await page.locator('#quickAddedTeamsList input[value="personal"]').count(), 0);
              const geometry = await page.locator('blora-dialog[open]').evaluate(el => { const p = el.shadowRoot.querySelector('[part="panel"]') || el; const r = p.getBoundingClientRect(); return { left: r.left, right: r.right, viewport: innerWidth }; });
              assert(geometry.left >= -1 && geometry.right <= geometry.viewport + 1, JSON.stringify(geometry));
              await page.screenshot({ path: path.join(output, `quick-provider-team-${scenario}.png`) });
              await page.locator('#quickAddedTeamsSkip').click();
            }
            await page.locator('blora-dialog[open]').waitFor({ state: 'hidden' });
          }
          assert.equal(syncs, ['save-retry', 'response-lost'].includes(scenario) ? 2 : 1);
        }
        assert.equal(creates, 1);
      }
      results.push({ browser: scenario, status: 'PASS', creates, syncs, teamGets, batches, existing }); await page.close();
    }
    assert.deepEqual(errors, []);
    const report = { status: 'PASS', isolated: true, results, requests, page_errors: errors, online_writes: false };
    fs.writeFileSync(path.join(output, 'quick-provider-team-test.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
