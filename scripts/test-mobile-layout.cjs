'use strict';
// 隔离 fixture：使用实际页面、样式、Blora 及生产渲染方法；所有网络请求由本地文件/模拟 API 接管。
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('/root/node_modules/playwright');
const root = path.resolve(process.env.MOBILE_LAYOUT_PUBLIC || path.join(__dirname, '../public'));
const output = process.env.MOBILE_LAYOUT_OUTPUT || '/home/detrital/clawfiles/crewrouter-functional-audit';
const widths = [320, 390, 640, 768, 1440];
const results = [];
const failures = [];
let assertions = 0;
function check(value, message) { assertions++; if (!value) failures.push(message); }
async function geometry(page, selectors) {
  return page.evaluate(selectors => Object.fromEntries(Object.entries(selectors).map(([key, selector]) => {
    const el = document.querySelector(selector);
    const r = el.getBoundingClientRect();
    return [key, { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, scroll: el.scrollWidth, client: el.clientWidth }];
  })), selectors);
}
function separate(a, b) { return a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1; }
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: '/usr/sbin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const requests = [], errors = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(60000);
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.hostname !== 'audit.invalid') return route.abort();
      if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/auth/')) {
        requests.push({ path: u.pathname, method: route.request().method() });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) });
      }
      const file = path.resolve(root, '.' + u.pathname);
      if (!file.startsWith(root + '/') || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
      let body = fs.readFileSync(file);
      if (file.endsWith('.html')) body = body.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace('</head>', '<script type="module" src="/vendor/blora-2.0.8/auto.js"></script><script src="/js/dom.js"></script></head>');
      const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
      return route.fulfill({ contentType: type, body });
    });
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('http://audit.invalid/pages/console.html#modelLibrary');
      await page.evaluate(async () => { await customElements.whenDefined('blora-search'); await customElements.whenDefined('blora-select'); });
      await page.evaluate(source => {
        window.t = s => s;
        (0, eval)(source.replace(/const app = new ConsoleApp\(\);[\s\S]*$/, 'window.app = Object.create(ConsoleApp.prototype);'));
        document.querySelectorAll('.page').forEach(el => el.style.display = 'none');
        document.querySelector('#modelLibraryPage').style.display = 'block';
        document.querySelector('#modelLibraryFilters').style.display = 'flex';
        const bar = document.querySelector('#modelLibraryStickyBar'); bar.classList.add('is-visible'); bar.setAttribute('aria-hidden', 'false');
        document.querySelector('#libraryStickyKeyWrap').style.display = 'block';
        document.querySelector('#libraryStickyKeyBtn').innerHTML = '<span class="sticky-key-name">Fixture Key · 模型选择</span><span class="blora-badge">fixture-model</span>';
        // Key 菜单使用本地交互桩；布局测试不执行在线绑定或保存。
        app.toggleLibraryStickyKeyOrBubble = () => { const b = document.querySelector('#libraryStickyKeyBtn'); b.setAttribute('aria-expanded', b.getAttribute('aria-expanded') !== 'true'); };
        document.querySelector('#libraryStickyProviderFilter').insertAdjacentHTML('beforeend', '<blora-option value="fixture">new.shareachat.cc/codex</blora-option>');
      }, fs.readFileSync(path.join(root, 'js/app.js'), 'utf8'));
      await page.waitForTimeout(350);
      const g = await geometry(page, { search: '#libraryStickySearchInput', select: '#libraryStickyProviderFilter', more: '#libraryStickyMoreFiltersBtn', key: '#libraryStickyKeyWrap', inner: '.model-library-sticky-inner' });
      const components = await page.evaluate(() => {
        const select = document.querySelector('#libraryStickyProviderFilter');
        const search = document.querySelector('#libraryStickySearchInput');
        const trigger = select.shadowRoot.querySelector('[part="trigger"]');
        return { selectHostPadding: getComputedStyle(select).padding, trigger: { height: trigger.getBoundingClientRect().height, x: trigger.getBoundingClientRect().x, right: trigger.getBoundingClientRect().right }, searchMarkup: search.innerHTML };
      });
      check(separate(g.search, g.select) && separate(g.search, g.more) && separate(g.key, g.more) && separate(g.key, g.select), `console ${width}: controls overlap`);
      check(g.inner.scroll <= g.inner.client + 1, `console ${width}: toolbar overflow`);
      if (width <= 640) {
        check(g.search.bottom <= g.select.y + 1 && g.select.bottom <= g.key.y + 1, `console ${width}: three rows`);
        check(Math.abs(g.select.y - g.more.y) <= 1, `console ${width}: second row alignment`);
        check(Math.abs(components.trigger.height - g.more.height) <= 1, `console ${width}: button heights`);
        check(Math.abs(components.trigger.x - g.search.x) <= 1 && Math.abs(g.more.right - g.search.right) <= 1 && Math.abs(g.key.x - g.search.x) <= 1, `console ${width}: horizontal edges`);
      }
      const input = page.locator('#libraryStickySearchInput input');
      await input.fill('fixture-model'); assert.equal(await input.inputValue(), 'fixture-model');
      await page.locator('#libraryStickyProviderFilter [part="trigger"]').click();
      await page.locator('#libraryStickyProviderFilter [part="option"][data-value="fixture"]').click();
      assert.equal(await page.locator('#libraryStickyProviderFilter').evaluate(el => el.value), 'fixture');
      await page.locator('#libraryStickyMoreFiltersBtn').click();
      assert.equal(await page.locator('#libraryStickyAdvancedFilters').getAttribute('aria-hidden'), 'false');
      check(await page.locator('#modelLibraryStickyBar').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `console ${width}: advanced overflow`);
      await page.locator('#libraryStickyMoreFiltersBtn').click();
      assert.equal(await page.locator('#libraryStickyAdvancedFilters').getAttribute('aria-hidden'), 'true');
      await page.locator('#libraryStickyKeyBtn').click();
      assert.equal(await page.locator('#libraryStickyKeyBtn').getAttribute('aria-expanded'), 'true');
      if (width === 390) await page.screenshot({ path: path.join(output, 'model-library-mobile.png') });
      // 普通筛选栏也使用同一组件，确保 scoped sticky 修复没有扩散。
      check(await page.locator('#modelLibraryFilters').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `console ${width}: regular filter overflow`);
      results.push({ surface: 'console', width, geometry: g, component: { selectHostPadding: components.selectHostPadding, trigger: components.trigger } });

      await page.goto('http://audit.invalid/pages/admin.html#adminTeams');
      await page.evaluate(async () => { await customElements.whenDefined('blora-select'); });
      await page.evaluate(source => {
        window.t = s => s;
        (0, eval)(source.replace(/\/\/ 初始化应用[\s\S]*$/, 'window.adminApp = Object.create(AdminApp.prototype);'));
        document.querySelectorAll('.page').forEach(el => el.style.display = 'none');
        const section = document.querySelector('#teamModelsSection');
        for (let el = section; el && el !== document.body; el = el.parentElement) { el.style.display = 'block'; for (const sibling of el.parentElement.children) if (sibling !== el) sibling.style.display = 'none'; }
        adminApp._syncAdminTeamModelsStickyControlsFromMain = () => {};
        window.fixtureModels = ['new.shareachat.cc/codex', 'api.astradink.cyou', 'extremely-long-provider-name.example.com/very-long-path-for-mobile'].flatMap((name, i) => [true, false].map((enabled, j) => ({ provider_id: `p${i}`, provider_name: name, provider_enabled: i !== 2, model_id: `m${i}${j}`, upstream_model_id: `fixture-model-${j}`, enabled: i === 0 ? true : i === 1 ? false : enabled })));
        adminApp.renderTeamModels(1, fixtureModels);
        // 批量按钮复用生产渲染，本地更新 fixture，不写入任何线上数据。
        adminApp.batchToggleTeamModelsByProvider = (key, enabled) => { fixtureModels.forEach(m => { if (m.provider_id === key) m.enabled = enabled; }); adminApp.renderTeamModels(1, fixtureModels); };
      }, fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8'));
      await page.waitForTimeout(200);
      const headers = await page.locator('#teamModelsList .model-library-provider-header').evaluateAll(els => els.map(el => {
        const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        return { header: rect(el), title: rect(el.querySelector('.model-library-provider-title')), actions: rect(el.querySelector('.model-library-provider-actions')), name: rect(el.querySelector('.model-provider-name')), buttons: [...el.querySelectorAll('button')].map(rect), countColor: getComputedStyle(el.querySelector('.provider-model-count')).color, overflow: el.scrollWidth > el.clientWidth + 1 };
      }));
      for (const h of headers) {
        check(separate(h.title, h.actions) && separate(h.name, h.actions), `team ${width}: title/actions overlap`);
        check(!h.overflow && h.name.right <= h.header.right + 1 && h.actions.right <= h.header.right + 1, `team ${width}: header overflow`);
        check(Math.abs(h.buttons[0].height - h.buttons[1].height) <= 1, `team ${width}: button heights`);
        if (width <= 640) check(h.title.bottom <= h.actions.y + 1, `team ${width}: title row`);
      }
      check(new Set(headers.map(h => h.countColor)).size === 3, `team ${width}: enabled count colors`);
      const provider = page.locator('#teamModelsList .model-library-provider').first();
      await provider.locator('.model-library-provider-title').click(); assert.equal(await provider.evaluate(el => el.classList.contains('collapsed')), false);
      await provider.locator('button').filter({ hasText: '全部启用' }).click();
      assert.match(await provider.locator('.provider-model-count').textContent(), /2 启用/);
      assert.equal(await provider.evaluate(el => el.classList.contains('collapsed')), false);
      await provider.locator('button').filter({ hasText: '全部禁用' }).click();
      assert.match(await provider.locator('.provider-model-count').textContent(), /0 启用/);
      await provider.locator('.model-library-provider-title').click(); assert.equal(await provider.evaluate(el => el.classList.contains('collapsed')), true);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `team ${width}: document overflow`);
      if (width === 390) await page.screenshot({ path: path.join(output, 'team-models-mobile.png') });
      await page.evaluate(() => adminApp.renderTeamModels(1, [])); assert.match(await page.locator('#teamModelsList').textContent(), /暂无已启用模型/);
      await page.evaluate(() => { document.querySelector('#teamModelListSearchInput').value = 'missing-fixture'; adminApp.renderTeamModels(1, fixtureModels); });
      assert.match(await page.locator('#teamModelsList').textContent(), /未找到匹配的模型/);
      results.push({ surface: 'team', width, headers });
    }
    check(errors.length === 0, `browser errors: ${errors.join('; ')}`);
    check(requests.length === 0, 'fixture unexpectedly requested business API');
    const report = { fixture: true, status: failures.length ? 'FAIL' : 'PASS', assertions, widths, failures, errors, interceptedApiRequests: requests, results };
    fs.writeFileSync(path.join(output, 'mobile-layout-test.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
    assert.equal(failures.length, 0, failures.join('\n'));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
