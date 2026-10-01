/**
 * CrewRouter 插件前端运行时
 *
 * 职责：
 *  - 拉取 /api/plugins/runtime，为已启用插件注入导航项、hash 页面容器与插槽内容
 *  - 约定：插件前端脚本（frontend/console.js 或 frontend/admin.js）执行时向
 *    window.CrewPluginRegistry[pluginId] 注册渲染函数：
 *      {
 *        pages:   { [renderName]: (container, helpers) => void },
 *        slots:   { [renderName]: (container, helpers) => void },
 *      }
 *  - 内置管理后台「插件管理」页（adminPlugins），无需单独插件提供
 */
(function () {
  'use strict';

  if (!window.CrewPluginRegistry) window.CrewPluginRegistry = {};

  const state = {
    ready: false,
    area: null,            // 'console' | 'admin'
    pages: [],             // { pluginId, pageId, title, render }
    slots: [],             // { pluginId, page, position, render }
    themes: [],            // [{ id, name, url, pluginId }]
    userThemeId: '',       // 用户个人选择（'' = 跟随默认）
    defaultThemeId: '',    // 站点默认主题
    isAdminUser: false,
    failedScripts: new Set(),
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const t = (k) => (typeof window.t === 'function' ? window.t(k) : k);

  const helpers = {
    t,
    esc,
    async fetchJSON(url, options) {
      const r = await fetch(url, options);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      return data;
    },
  };

  function detectArea() {
    if (document.getElementById('statsPage')) return 'console';
    if (document.querySelector('.nav-item[data-page="adminUsers"]')) return 'admin';
    return null;
  }

  function loadScript(src) {
    if (state.failedScripts.has(src)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve(true);
      el.onerror = () => { state.failedScripts.add(src); resolve(false); };
      document.head.appendChild(el);
    });
  }

  function sanitizePageId(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '');
  }

  function currentPage() {
    const active = document.querySelector('.page.active');
    if (!active) return null;
    return active.id.replace(/Page$/, '');
  }

  // ---------- 导航与页面容器 ----------

  function injectNav(area) {
    const navSection = document.querySelector('.sidebar-nav .nav-section');
    if (!navSection || state.pages.length === 0) return;

    for (const p of [...state.pages].reverse()) {
      if (document.querySelector(`.nav-item[data-page="${p.pageId}"]`)) continue;
      const item = document.createElement('div');
      item.className = 'nav-item';
      item.setAttribute('data-page', p.pageId);
      item.innerHTML = `<span data-icon="puzzle" aria-hidden="true"></span>
        <span><span>${esc(p.title)}</span></span>`;
      item.addEventListener('click', () => {
        if (area === 'admin' && window.adminApp) adminApp.navigateTo(p.pageId);
        else if (area === 'console' && window.app) app.navigateTo(p.pageId);
      });
      // 追加到第一个分区内置项之后
      navSection.appendChild(item);
    }
  }

  function injectPageContainers(area) {
    const refPage = document.getElementById('statsPage')
      || document.getElementById('adminStatsPage')
      || document.querySelector('.page');
    if (!refPage || !refPage.parentElement) return;
    const parent = refPage.parentElement;

    for (const p of state.pages) {
      if (document.getElementById(`${p.pageId}Page`)) continue;
      const wrap = document.createElement('div');
      wrap.className = 'page';
      wrap.id = `${p.pageId}Page`;
      wrap.innerHTML = `<div class="content-section" data-plugin-page="${esc(p.pageId)}"></div>`;
      parent.appendChild(wrap);
    }
  }

  // ---------- 插槽 ----------

  async function renderSlotsFor(pageId) {
    if (!state.ready) return;
    const slots = state.slots.filter(s => s.page === pageId);
    if (slots.length === 0) return;
    for (const s of slots) {
      const name = `${s.page}:${s.position}`;
      const container = document.querySelector(`[data-cr-slot="${name}"]`);
      if (!container) continue;
      const regFn = window.CrewPluginRegistry[s.pluginId]?.slots?.[s.render];
      container.innerHTML = '';
      if (typeof regFn === 'function') {
        try { regFn(container, helpers); } catch (e) { console.warn('[plugins] 插槽渲染失败', name, e); }
      }
    }
  }

  async function renderPluginPageIfAny(pageId) {
    const p = state.pages.find(x => x.pageId === pageId);
    if (!p) return false;
    const container = document.querySelector(`[data-plugin-page="${pageId}"]`);
    if (!container) return true;
    const regFn = window.CrewPluginRegistry[p.pluginId]?.pages?.[p.render];
    container.innerHTML = '';
    if (typeof regFn === 'function') {
      try { regFn(container, helpers); } catch (e) {
        console.warn('[plugins] 页面渲染失败', pageId, e);
        container.innerHTML = `<div class="page-loading-text">${esc(t('插件页面加载失败'))}: ${esc(e.message)}</div>`;
      }
    }
    return true;
  }

  // ---------- 应用补丁 ----------

  function setPageTitle(title) {
    const el = document.getElementById('pageTitle');
    if (el) el.textContent = title;
    const m = document.getElementById('mobilePageTitle');
    if (m) m.textContent = title;
  }

  function patchApp(appObj, area) {
    if (!appObj || appObj.__pluginPatched) return;

    // hash 白名单并入插件页面（仅控制台有白名单校验）
    if (typeof appObj._consolePageIds === 'function') {
      const origIds = appObj._consolePageIds.bind(appObj);
      appObj._consolePageIds = function () {
        const s = origIds();
        state.pages.forEach(p => s.add(p.pageId));
        return s;
      };
    }

    const origNavigate = appObj.navigateTo.bind(appObj);
    appObj.navigateTo = async function (page, options) {
      await origNavigate(page, options);
      try {
        const activePage = currentPage() || page;
        const pluginPage = state.pages.find(x => x.pageId === activePage);
        if (pluginPage) {
          setPageTitle(pluginPage.title);
          await renderPluginPageIfAny(activePage);
          return;
        }
        if (activePage === 'adminPlugins') {
          renderPluginsAdmin(document.getElementById('adminPluginsContent'));
          return;
        }
        // 设置页渲染主题选择器
        if (activePage === 'settings') await renderUserThemePicker(document.getElementById('pluginThemePicker'));
        if (activePage === 'adminSettings') await renderDefaultThemePicker(document.getElementById('pluginDefaultThemePicker'));
        // 常规页面激活后填充插槽
        await renderSlotsFor(activePage);
      } catch (e) { console.warn('[plugins] 导航后处理失败', e); }
    };
    appObj.__pluginPatched = true;
  }

  // ---------- 主题 ----------

  function findTheme(id) {
    return state.themes.find(t => t.id === id) || null;
  }

  const palettes = {
    'all-capabilities/all-capabilities-theme': 'dusk',
    'crewrouter-classic/classic': 'graphite',
    'example-theme/ocean': 'circuit',
    'theme-linear/linear': 'indigo',
    'theme-paper/paper': 'coral',
    'theme-raycast/raycast': 'dusk',
    'theme-terminal/terminal': 'mono',
  };
  let activeThemeClass = '';
  let originalPalette;
  let themeLoadSequence = 0;
  let themePaletteStyles;

  async function notifyTheme(variant, text) {
    if (!window.bloraMessage) {
      const { message } = await import('/blora/index.js?v=2.1.0');
      window.bloraMessage = message;
    }
    window.bloraMessage[variant](String(text));
  }

  function applyThemeClass(themeId) {
    const root = document.documentElement;
    if (activeThemeClass) root.classList.remove(activeThemeClass);
    activeThemeClass = '';
    if (themeId) {
      activeThemeClass = `theme-${String(themeId).replace(/\//g, '__').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
      root.classList.add(activeThemeClass);
    }
  }

  function applyThemePalette(themeId) {
    const root = document.documentElement;
    if (originalPalette === undefined) originalPalette = root.getAttribute('data-blora-theme');
    const palette = palettes[themeId];
    if (palette) root.setAttribute('data-blora-theme', palette);
    else if (originalPalette) root.setAttribute('data-blora-theme', originalPalette);
    else root.removeAttribute('data-blora-theme');
  }

  function loadThemeStyles(link) {
    return new Promise((resolve, reject) => {
      link.onload = () => resolve(link);
      link.onerror = () => { link.remove(); reject(new Error(t('主题加载失败'))); };
      document.head.appendChild(link);
    });
  }

  function ensureThemePaletteStyles() {
    if (!themePaletteStyles) {
      const link = document.createElement('link');
      link.id = 'crPluginThemePalettes';
      link.rel = 'stylesheet';
      link.href = '/blora/tokens.themes.css?v=2.1.0';
      themePaletteStyles = loadThemeStyles(link).catch((error) => {
        themePaletteStyles = null;
        throw error;
      });
    }
    return themePaletteStyles;
  }

  function applyThemeScript(theme) {
    const old = document.getElementById('crPluginThemeScript');
    if (old) old.remove();
    if (!theme || !theme.jsUrl) return;
    const script = document.createElement('script');
    script.id = 'crPluginThemeScript';
    script.src = theme.jsUrl;
    document.head.appendChild(script);
  }

  async function applyThemeStyle(themeId) {
    const sequence = ++themeLoadSequence;
    const theme = themeId ? findTheme(themeId) : null;
    if (!theme) {
      document.getElementById('crPluginThemeStyle')?.remove();
      applyThemeScript(null);
      applyThemeClass('');
      applyThemePalette('');
      return;
    }
    await ensureThemePaletteStyles();
    if (sequence !== themeLoadSequence) return;
    const previous = document.getElementById('crPluginThemeStyle');
    if (previous?.href === new URL(theme.url, location.href).href) {
      applyThemePalette(theme.id);
      applyThemeClass(theme.id);
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.media = 'print';
    link.href = theme.url;
    await loadThemeStyles(link);
    if (sequence !== themeLoadSequence) { link.remove(); return; }
    previous?.remove();
    link.id = 'crPluginThemeStyle';
    applyThemePalette(theme.id);
    applyThemeClass(theme.id);
    link.media = 'all';
    applyThemeScript(theme);
  }

  async function initThemes() {
    try {
      const data = await helpers.fetchJSON('/api/plugins/user-theme');
      state.userThemeId = data.themeId || '';
      state.defaultThemeId = data.defaultThemeId || '';
      await applyThemeStyle(data.effective || '');
      await renderThemePickers();
    } catch { /* 未登录或后端未就绪时静默 */ }
  }

  function themeOptionsHtml(selectedId, followLabel) {
    const opts = [`<blora-option value="" ${!selectedId ? 'selected' : ''}>${esc(t(followLabel))}</blora-option>`];
    if (selectedId && !findTheme(selectedId)) {
      opts.push(`<blora-option value="${esc(selectedId)}" selected disabled>${esc(t('该主题的插件已停用，当前显示为默认样式'))}</blora-option>`);
    }
    for (const theme of state.themes) {
      opts.push(`<blora-option value="${esc(theme.id)}" ${selectedId === theme.id ? 'selected' : ''}>${esc(t(theme.name))}</blora-option>`);
    }
    return opts.join('');
  }

  async function renderThemePicker(container, isDefault) {
    if (!container) return;
    const selectedId = isDefault ? state.defaultThemeId : state.userThemeId;
    const id = isDefault ? 'pluginDefaultThemeSelect' : 'pluginThemeSelect';
    container.innerHTML = `<blora-select id="${id}" aria-label="${esc(t('界面主题'))}" style="min-width:220px;">${themeOptionsHtml(selectedId, isDefault ? '内置默认主题' : '跟随默认主题')}</blora-select>`;
    const select = container.querySelector(`#${id}`);
    await customElements.whenDefined('blora-select');
    if (!select.isConnected) return;
    customElements.upgrade(select);
    select.setAttribute('value', selectedId);
    select.addEventListener('change', async () => {
      const value = select.value;
      select.setAttribute('disabled', '');
      try {
        await helpers.fetchJSON(isDefault ? '/api/admin/settings' : '/api/plugins/user-theme', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isDefault ? { default_theme: value } : { themeId: value }),
        });
        if (isDefault) state.defaultThemeId = value;
        else state.userThemeId = value;
        await applyThemeStyle(state.userThemeId || state.defaultThemeId || '');
        await notifyTheme('success', t(isDefault ? '已保存，刷新后对所有用户生效' : '已保存并生效'));
      } catch (error) {
        select.setAttribute('value', isDefault ? state.defaultThemeId : state.userThemeId);
        await notifyTheme('error', error.message);
      } finally {
        select.removeAttribute('disabled');
      }
    });
    if (!isDefault && selectedId && !findTheme(selectedId)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'blora-button';
      button.setAttribute('data-variant', 'outline');
      button.textContent = t('重置');
      button.addEventListener('click', () => window.CrewThemes.resetStale());
      container.appendChild(button);
    }
  }

  function renderUserThemePicker(container) { return renderThemePicker(container, false); }
  function renderDefaultThemePicker(container) { return renderThemePicker(container, true); }

  function renderThemePickers() {
    return Promise.all([
      renderUserThemePicker(document.getElementById('pluginThemePicker')),
      renderDefaultThemePicker(document.getElementById('pluginDefaultThemePicker')),
    ]);
  }

  window.CrewThemes = {
    list: () => [...state.themes],
    effective: () => state.userThemeId || state.defaultThemeId || '',
    apply: async (id) => { state.userThemeId = id; await applyThemeStyle(id || state.defaultThemeId || ''); },
    refreshPickers: renderThemePickers,
    async resetStale() {
      try {
        await helpers.fetchJSON('/api/plugins/user-theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ themeId: '' }) });
        await this.apply('');
        await renderThemePickers();
        await notifyTheme('success', t('已保存并生效'));
      } catch (error) { await notifyTheme('error', error.message); }
    },
  };

  // ---------- 初始化 ----------

  async function fetchRuntime() {
    try {
      const r = await fetch('/api/plugins/runtime');
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  async function waitForApp(getter, tries = 40) {
    for (let i = 0; i < tries; i++) {
      const v = getter();
      if (v) return v;
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }

  async function init() {
    if (state.ready) return;
    const area = detectArea();
    if (!area) return;

    const runtime = await fetchRuntime();
    if (!runtime) {
      // 后端尚未具备插件接口（如待重启的旧进程）：插件页静默退出，
      // 但原生的「插件管理」静态页需要给出明确提示
      if (area === 'admin') {
        const box = document.getElementById('adminPluginsContent');
        if (box) {
          box.dataset.bloraState = 'error';
          box.innerHTML = `<blora-alert variant="warning" title="${esc(t('插件服务未就绪：请重启 CrewRouter 使插件系统生效。'))}"></blora-alert><button type="button" class="blora-button" data-variant="outline" data-plugin-runtime-retry>${esc(t('重试'))}</button>`;
          box.querySelector('[data-plugin-runtime-retry]')?.addEventListener('click', init);
        }
      }
      return;
    }
    const plugins = (runtime && Array.isArray(runtime.plugins)) ? runtime.plugins : [];

    state.area = area;
    for (const p of plugins) {
      for (const th of p.themes || []) {
        state.themes.push({ id: th.id, name: th.name, url: th.url, jsUrl: th.jsUrl || '', pluginId: p.id });
      }
      for (const pg of p.pages || []) {
        if ((pg.area || 'console') !== area) continue;
        const entry = pg.entry ? `${p.assetsBase}/${String(pg.entry).replace(/^\/+/, '')}` : null;
        if (entry) await loadScript(entry + '?v=' + encodeURIComponent(p.version || ''));
        state.pages.push({
          pluginId: p.id,
          pageId: sanitizePageId(`plugin_${p.id}_${pg.id || 'main'}`),
          title: pg.title || p.name,
          render: pg.render || 'renderPage',
        });
      }
      for (const sl of p.slots || []) {
        state.slots.push({ pluginId: p.id, page: sl.page, position: sl.position, render: sl.render || 'render' });
      }
    }

    injectNav(area);
    injectPageContainers(area);

    const appObj = area === 'console'
      ? await waitForApp(() => window.app || (typeof app !== 'undefined' ? app : null))
      : await waitForApp(() => window.adminApp || (typeof adminApp !== 'undefined' ? adminApp : null));
    if (appObj) patchApp(appObj, area);

    state.ready = true;
    let lastPage;
    const pageObserver = new MutationObserver(() => {
      const page = currentPage();
      if (page === lastPage) return;
      lastPage = page;
      if (page === 'adminPlugins') renderPluginsAdmin(document.getElementById('adminPluginsContent'));
    });
    document.querySelectorAll('.page').forEach(page => pageObserver.observe(page, { attributes: true, attributeFilter: ['class'] }));
    window.addEventListener('pagehide', () => pageObserver.disconnect(), { once: true });

    // 主题：拉取用户/默认选择并应用（含设置页选择器首渲）
    await initThemes();

    // 初始页面若是插件页/常规页，恢复一次渲染（hash 直达场景）
    const cur = currentPage();
    if (cur) {
      if (cur.startsWith('plugin_')) await renderPluginPageIfAny(cur);
      else if (cur === 'adminPlugins') renderPluginsAdmin(document.getElementById('adminPluginsContent'));
      else {
        if (cur === 'settings') await renderUserThemePicker(document.getElementById('pluginThemePicker'));
        if (cur === 'adminSettings') await renderDefaultThemePicker(document.getElementById('pluginDefaultThemePicker'));
        await renderSlotsFor(cur);
      }
    }
  }

  // ---------- 内置「插件管理」后台页 ----------

  const PERM_GLOSSARY = {
    'storage': '读写私有 KV 存储',
    'network': '访问外部网络（受限）',
    'gateway:modify': '改写网关请求/输出',
    'provider:register': '注册供应商格式/转换/路由选择',
    'apikey:modify': 'API Key 校验、创建与计费行为',
    'billing:modify': '调整计费',
    'cron:register': '定时任务',
    'pages:register': '页面与插槽扩展',
    'routes:register': '自建 HTTP API',
    'themes:register': '主题扩展',
    'stats:record': '统计维度扩展',
    'models:list': '模型列表改写',
  };

  let manageState = { plugins: [], expanded: {}, search: '', sort: 'id' };

  const mstyle = `
    .mstat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:var(--blora-space-4);}
    .mhead{display:flex;align-items:flex-start;gap:var(--blora-space-3);flex-wrap:wrap;}
    .msearch,.mmut{display:flex;gap:var(--blora-space-2);align-items:center;flex-wrap:wrap;}
    .mcard{min-width:0;}
  `;

  function statCard(v, label, cls) {
    return `<div class="blora-card blora-stat mstat ${cls || ''}" data-size="sm"><div class="blora-stat__value">${esc(String(v))}</div><div class="blora-stat__label">${esc(label)}</div></div>`;
  }

  function permChip(p) {
    const label = PERM_GLOSSARY[p] || p;
    return `<span class="blora-tag" data-variant="neutral" title="${esc(label)}">${esc(p)}</span>`;
  }

  function pluginRow(pl) {
    const open = !!manageState.expanded[pl.id];
    const perms = (pl.permissions || []).map(permChip).join('') || '<span class="blora-badge" data-variant="neutral">-</span>';

    const statusChips = [
      pl.enabled ? '<span class="blora-badge" data-variant="success">已启用</span>' : '<span class="blora-badge" data-variant="neutral">已禁用</span>',
      pl.onDisk ? '' : '<span class="blora-badge" data-variant="warning">磁盘缺失</span>',
      pl.loaded ? '<span class="blora-badge" data-variant="success">运行中</span>' : '',
      pl.errorCount > 0 || pl.lastError ? `<span class="blora-badge" data-variant="warning">错误 ${esc(String(pl.errorCount))}</span>` : '',
      pl.storeUpdateAvailable ? `<span class="blora-badge" data-variant="warning">有更新 v${esc(String(pl.storeLatestVersion || ''))}</span>` : '',
    ].join('');

    const caps = [];
    if (pl.pages?.length) caps.push(`<span class="blora-tag" data-variant="primary">${esc(String(pl.pages.length))} 页面</span>`);
    if (pl.slots?.length) caps.push(`<span class="blora-tag" data-variant="primary">${esc(String(pl.slots.length))} 插槽</span>`);
    if (pl.routes?.length) caps.push(`<span class="blora-tag" data-variant="primary">${esc(String(pl.routes.length))} API</span>`);
    if (pl.cron?.length) caps.push(`<span class="blora-tag" data-variant="primary">${esc(String(pl.cron.length))} 定时任务</span>`);
    if (pl.themes?.length) caps.push(`<span class="blora-tag" data-variant="primary">${esc(String(pl.themes.length))} 主题</span>`);
    const capsHtml = caps.join('') || '<span class="blora-badge" data-variant="neutral">无能力注册</span>';

    const detail = open ? pluginDetail(pl, perms) : '';
    return `
      <div class="blora-card blora-stack mcard" data-size="sm">
        <div class="mhead">
          <div style="flex:1;min-width:260px;">
            <div class="blora-card__title"><span data-icon="puzzle" aria-hidden="true"></span> ${esc(pl.name)} <span class="blora-tag" data-variant="neutral">v${esc(pl.version || '-')} · ${esc(pl.id)}</span></div>
            ${pl.author ? `<div>作者：${esc(pl.author)}</div>` : ''}
            ${pl.description ? `<div class="blora-card__desc">${esc(pl.description)}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
            <div>${statusChips}</div>
            <label><blora-switch ${pl.enabled ? 'checked' : ''} data-plugin-toggle="${esc(pl.id)}" label="${esc(t('启用'))}"></blora-switch> ${esc(t('启用'))}</label>
          </div>
        </div>
        <div style="margin-top:10px;">${capsHtml}</div>
        <div class="mmut">
          ${pl.storeUpdateAvailable && pl.storeSource ? `<button type="button" class="blora-button" data-variant="ghost" data-size="sm" onclick="window.__pluginRT.updateFromStore('${esc(pl.id)}')">${esc(t('更新'))}</button>` : ''}
          <button type="button" class="blora-button" data-variant="ghost" data-size="sm" onclick="window.__pluginRT.expand('${esc(pl.id)}')">${open ? esc(t('收起')) : esc(t('配置'))}</button>
          <button type="button" class="blora-button" data-variant="ghost" data-size="sm" onclick="window.__pluginRT.reload('${esc(pl.id)}')">${esc(t('重载'))}</button>
          <button type="button" class="blora-button" data-variant="danger" data-size="sm" onclick="window.__pluginRT.uninstall('${esc(pl.id)}')">${esc(t('卸载'))}</button>
        </div>
        ${detail}
      </div>`;
  }

  function pluginDetail(pl, perms) {
    const routesHtml = (pl.routes || []).map(r =>
      `${esc((r.method || 'GET').toUpperCase())} <code style="font-family:monospace;">/api/plugins/${esc(pl.id)}${esc(r.path)}</code> <span>(${esc(r.auth || 'user')})</span>`
    ).join('<br>');
    const cronHtml = (pl.cron || []).map(c =>
      `<code style="font-family:monospace;">${esc(c.expr || '-')}</code> <span>→ ${esc(c.handler || '-')}</span>`
    ).join('<br>');
    const themesHtml = (pl.themes || []).map(th => esc(th.name || th.id)).join('、');
    const cfgText = esc(JSON.stringify(pl.config || {}, null, 2));

    return `
      <div>
        <div class="blora-text-muted">${esc(t('权限声明'))}</div>
        <div>${perms}</div>
        ${pl.routes?.length ? `<div class="blora-text-muted">${esc(t('自有 API'))}</div><div>${routesHtml}</div>` : ''}
        ${pl.cron?.length ? `<div class="blora-text-muted">${esc(t('定时任务'))}</div><div>${cronHtml}</div>` : ''}
        ${pl.themes?.length ? `<div class="blora-text-muted">${esc(t('主题'))}</div><div>${themesHtml}</div>` : ''}
        <div class="blora-text-muted">${esc(t('插件配置'))}(config)</div>
        <blora-field label="${esc(t('插件配置'))}"><textarea class="blora-textarea" data-plugin-cfg="${esc(pl.id)}" rows="5">${cfgText}</textarea></blora-field>
        <div style="margin-top:6px;display:flex;gap:8px;">
          <button type="button" class="blora-button" data-variant="outline" data-size="sm" onclick="window.__pluginRT.saveConfig('${esc(pl.id)}')">${esc(t('保存配置'))}</button>
          <div data-plugin-cfg-msg="${esc(pl.id)}"></div>
        </div>
        <div class="blora-text-muted">${esc(t('插件数据'))}(plugin_data)</div>
        <div data-plugin-data="${esc(pl.id)}"><p>${esc(t('加载中...'))}</p></div>
        ${pl.lastError ? `<div class="blora-text-muted">${esc(t('最近错误'))}</div><div><span data-icon="triangle-alert" aria-hidden="true"></span> ${esc(pl.lastError)}</div>
          <div style="margin-top:4px;"><button type="button" class="blora-button" data-variant="ghost" data-size="sm" onclick="window.__pluginRT.resetErrors('${esc(pl.id)}')">${esc(t('清除错误并重载'))}</button></div>` : ''}
      </div>`;
  }

  async function renderPluginsAdmin(container, keepExpand) {
    if (!container) return;
    container.dataset.bloraState = 'loading';
    if (!keepExpand) container.innerHTML = `<div class="page-loading page-loading-compact"><div class="blora-spinner" role="status"></div><div class="page-loading-text">${esc(t('加载中...'))}</div></div>`;
    let data;
    try {
      data = await helpers.fetchJSON('/api/admin/plugins');
    } catch (e) {
      container.dataset.bloraState = 'error';
      container.innerHTML = `<div class="blora-stack"><blora-alert variant="danger" title="${esc(t('加载失败'))}" description="${esc(e.message)}"></blora-alert><button type="button" class="blora-button" data-variant="outline" onclick="window.__pluginRT.refresh()">${esc(t('重试'))}</button></div>`;
      return;
    }
    manageState.plugins = Array.isArray(data) ? data : (data.plugins || []);
    container.dataset.bloraState = 'success';

    const q = manageState.search.trim().toLowerCase();
    const filtered = manageState.plugins.filter(pl =>
      !q || [pl.id, pl.name, pl.description, pl.author].some(x => String(x || '').toLowerCase().includes(q))
    );
    const sorted = [...filtered].sort((a, b) => {
      if (manageState.sort === 'name') return String(a.name).localeCompare(String(b.name));
      if (manageState.sort === 'enabled') return (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0);
      return String(a.id).localeCompare(String(b.id));
    });

    const total = manageState.plugins.length;
    const stats =
      statCard(total, t('插件总数')) +
      statCard(manageState.plugins.filter(p => p.enabled).length, t('已启用'), 'ok') +
      statCard(manageState.plugins.filter(p => !p.enabled).length, t('已禁用')) +
      statCard(manageState.plugins.filter(p => !p.onDisk).length, t('磁盘缺失'), 'warn') +
      statCard(manageState.plugins.filter(p => p.errorCount > 0 || p.lastError).length, t('错误'), 'err');

    const rows = sorted.map(pluginRow).join('');
    container.innerHTML = `
      <style>${mstyle}</style>
      <div class="section-header">
        <div>
          <h2>${esc(t('插件管理'))}</h2>
          <p>${esc(t('安装方法：将插件目录放入服务器 plugins/ 目录，重启服务后在此启用。'))}</p>
        </div>
        <div class="mmut" style="margin-top:0;"><button type="button" class="blora-button" data-variant="outline" data-size="sm" onclick="window.__pluginRT.refresh()">${esc(t('刷新'))}</button></div>
      </div>
      <div class="mstat-grid">${stats}</div>
      <div class="msearch">
        <blora-search id="pluginSearchInput" label="${esc(t('搜索插件名称、ID、作者或描述'))}" placeholder="${esc(t('搜索插件名称、ID、作者或描述'))}" value="${esc(manageState.search)}"></blora-search>
        <blora-select id="pluginSortSelect" aria-label="排序">
          <blora-option value="id" ${manageState.sort === 'id' ? 'selected' : ''}>${esc(t('按名称排序'))}</blora-option>
          <blora-option value="name" ${manageState.sort === 'name' ? 'selected' : ''}>${esc(t('按显示名排序'))}</blora-option>
          <blora-option value="enabled" ${manageState.sort === 'enabled' ? 'selected' : ''}>${esc(t('按状态排序'))}</blora-option>
        </blora-select>
      </div>
      ${rows ? rows : `<blora-empty title="${q ? esc(t('未找到匹配插件')) : esc(t('暂无插件。将插件目录放入 plugins/ 后重启服务即可在此看到。'))}"></blora-empty>`}
    `;
    container.querySelectorAll('[data-plugin-toggle]').forEach(control => control.addEventListener('change', () => window.__pluginRT.toggle(control.dataset.pluginToggle, control.checked)));
    container.querySelector('#pluginSearchInput')?.addEventListener('input', event => window.__pluginRT.search(event.target.value));
    container.querySelector('#pluginSortSelect')?.addEventListener('change', event => window.__pluginRT.sort(event.target.value));
  }

  function msg(id, text, ok) {
    const el = document.querySelector(`[data-plugin-cfg-msg="${id}"]`);
    if (el) {
      el.textContent = text;
      el.style.color = ok ? 'var(--status-success)' : 'var(--destructive)';
    }
  }

  window.__pluginRT = {
    refresh() { renderPluginsAdmin(document.getElementById('adminPluginsContent')); },
    search(v) { manageState.search = v; this.refresh(); },
    sort(v) { manageState.sort = v; this.refresh(); },
    async updateFromStore(id) {
      const pl = manageState.plugins.find(p => p.id === id);
      if (!pl || !pl.storeId || !pl.storeSource) return;
      const next = pl.storeLatestVersion || '最新';
      if (!await Dialog.confirm(esc(t('确定要将插件') + '「' + pl.name + '」' + t('更新到') + ' v' + next + t('吗？')))) return;
      try {
        await helpers.fetchJSON('/api/admin/plugins/install-from-store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plugin: pl.storeId, source: pl.storeSource }),
        });
        this.refresh();
      } catch (e) {
        await Dialog.alert(esc(t('更新失败') + '：' + e.message));
      }
    },
    expand(id) { manageState.expanded[id] = !manageState.expanded[id]; this.refresh(); if (manageState.expanded[id]) this.loadData(id); },
    async loadData(id) {
      const box = document.querySelector(`[data-plugin-data="${id}"]`);
      if (!box) return;
      box.innerHTML = `<p>${esc(t('加载中...'))}</p>`;
      try {
        const data = await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}/data`);
        const rows = data.keys || [];
        if (!rows.length) {
          box.innerHTML = `<p>${esc(t('暂无数据'))}</p>`;
          return;
        }
        box.innerHTML = `<table class="blora-table">
          <tr><th>${esc(t('键'))}</th><th>${esc(t('值'))}</th><th>${esc(t('更新时间'))}</th><th></th></tr>
          ${rows.map(r => `<tr>
            <td style="font-family:monospace;">${esc(r.key)}</td>
            <td style="font-family:monospace;max-width:320px;">${esc(JSON.stringify(r.value))}</td>
            <td style="white-space:nowrap;">${esc(String(r.updatedAt || '').slice(0, 19).replace('T', ' '))}</td>
            <td><button type="button" class="blora-button" data-variant="ghost" data-size="sm" onclick="window.__pluginRT.deleteData('${esc(id)}', '${esc(r.key)}')">${esc(t('删除'))}</button></td>
          </tr>`).join('')}
        </table>`;
      } catch (e) {
        box.innerHTML = `<p>${esc(e.message)}</p>`;
      }
    },
    async deleteData(id, key) {
      if (!await Dialog.confirm(t('确定删除该插件数据键？'))) return;
      try {
        await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}/data/${encodeURIComponent(key)}`, { method: 'DELETE' });
        this.loadData(id);
      } catch (e) { await Dialog.alert(esc(e.message)); }
    },
    async toggle(id, enabled) {
      try {
        await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}/toggle`, { method: 'POST' });
        this.refresh();
      } catch (e) { await Dialog.alert(esc(e.message)); this.refresh(); }
    },
    async reload(id) {
      try {
        await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}/reload`, { method: 'POST' });
        msg(id, t('已重载'), true);
      } catch (e) { msg(id, e.message, false); }
    },
    async uninstall(id) {
      if (!await Dialog.confirm(t('确定卸载该插件的记录？（需先禁用；插件目录不会被删除）'))) return;
      try {
        await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
        this.refresh();
      } catch (e) { await Dialog.alert(esc(e.message)); }
    },
    async saveConfig(id) {
      const el = document.querySelector(`[data-plugin-cfg="${id}"]`);
      if (!el) return;
      let config;
      try { config = JSON.parse(el.value); } catch (e) { msg(id, `JSON 无效: ${e.message}`, false); return; }
      try {
        await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config }),
        });
        msg(id, t('配置已保存'), true);
      } catch (e) { msg(id, e.message, false); }
    },
    async resetErrors(id) {
      try {
        await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}/reset-errors`, { method: 'POST' });
        await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}/reload`, { method: 'POST' });
        this.refresh();
      } catch (e) { await Dialog.alert(esc(e.message)); }
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
