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
      item.innerHTML = `<img src="https://img.bloret.net/SF/puzzlepiece?color=white" alt="" width="16" height="16" class="sf-icon" data-sf-name="puzzlepiece">
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
        const pluginPage = state.pages.find(x => x.pageId === page);
        if (pluginPage) {
          setPageTitle(pluginPage.title);
          await renderPluginPageIfAny(page);
          return;
        }
        if (page === 'adminPlugins') {
          renderPluginsAdmin(document.getElementById('adminPluginsContent'));
          return;
        }
        // 设置页渲染主题选择器
        if (page === 'settings') renderUserThemePicker(document.getElementById('pluginThemePicker'));
        if (page === 'adminSettings') renderDefaultThemePicker(document.getElementById('pluginDefaultThemePicker'));
        // 常规页面激活后填充插槽
        await renderSlotsFor(page);
      } catch (e) { console.warn('[plugins] 导航后处理失败', e); }
    };
    appObj.__pluginPatched = true;
  }

  // ---------- 主题 ----------

  function findTheme(id) {
    return state.themes.find(t => t.id === id) || null;
  }

  // 当前挂在 <html> 上的主题 class（切换/取消时移除）
  let activeThemeClass = '';

  function applyThemeClass(themeId) {
    if (activeThemeClass) {
      document.documentElement.classList.remove(activeThemeClass);
      activeThemeClass = '';
    }
    if (themeId) {
      const cls = `theme-${String(themeId).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/\//g, '__')}`;
      document.documentElement.classList.add(cls);
      activeThemeClass = cls;
    }
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

  function applyThemeStyle(themeId) {
    const el = document.getElementById('crPluginThemeStyle');
    const theme = themeId ? findTheme(themeId) : null;
    if (!theme) {
      if (el) el.remove();
      applyThemeScript(null);
      applyThemeClass('');
      return;
    }
    applyThemeClass(theme.id);
    applyThemeScript(theme);
    // 仅注入样式表，不改任何行为；重复应用先移除旧节点
    if (el && el.href === theme.url) return;
    if (el) el.remove();
    const link = document.createElement('link');
    link.id = 'crPluginThemeStyle';
    link.rel = 'stylesheet';
    // 防闪烁：先用 print 媒体加载（不渲染、不阻塞），加载完成后再切换为 all，
    // 避免样式表未就绪时短暂闪回默认主题
    link.media = 'print';
    link.onload = () => { link.media = 'all'; };
    link.href = theme.url;
    document.head.appendChild(link);
  }

  async function initThemes() {
    try {
      const data = await helpers.fetchJSON('/api/plugins/user-theme');
      state.userThemeId = data.themeId || '';
      state.defaultThemeId = data.defaultThemeId || '';
      applyThemeStyle(data.effective || '');
      renderThemePickers();
    } catch { /* 未登录或后端未就绪时静默 */ }
  }

  function themeOptionsHtml(selectedId, includeFollowOption, followLabel) {
    const opts = [];
    if (includeFollowOption) {
      opts.push(`<option value="" ${!selectedId ? 'selected' : ''}>${esc(t('内置默认主题'))}</option>`);
    }
    for (const th of state.themes) {
      opts.push(`<option value="${esc(th.id)}" ${selectedId === th.id ? 'selected' : ''}>${esc(t(th.name))}</option>`);
    }
    return opts.join('');
  }

  function unavailableBadge(selectedId) {
    if (!selectedId || findTheme(selectedId)) return '';
    return `<span style="font-size:12px;color:var(--destructive);margin-left:8px;">${esc(t('该主题的插件已停用，当前显示为默认样式'))}
      <button class="btn btn-ghost btn-sm" style="padding:2px 8px;" onclick="window.CrewThemes.resetStale()">${esc(t('重置'))}</button></span>`;
  }

  function renderUserThemePicker(container) {
    if (!container) return;
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <select id="pluginThemeSelect" class="select" style="min-width:220px;">${themeOptionsHtml(state.userThemeId, true)}</select>
        <span id="pluginThemeStatus" style="font-size:13px;color:var(--muted-foreground);"></span>
      </div>
      <div style="margin-top:6px;">${unavailableBadge(state.userThemeId)}</div>
    `;
    const sel = container.querySelector('#pluginThemeSelect');
    sel.addEventListener('change', async () => {
      const v = sel.value;
      try {
        await helpers.fetchJSON('/api/plugins/user-theme', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ themeId: v }),
        });
        state.userThemeId = v;
        applyThemeStyle(v || state.defaultThemeId || '');
        const st = container.querySelector('#pluginThemeStatus');
        if (st) st.textContent = t('已保存并生效');
      } catch (e) {
        const st = container.querySelector('#pluginThemeStatus');
        if (st) st.textContent = e.message;
      }
    });
  }

  function renderDefaultThemePicker(container) {
    if (!container) return;
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <select id="pluginDefaultThemeSelect" class="select" style="min-width:220px;">${themeOptionsHtml(state.defaultThemeId, true)}</select>
        <span id="pluginDefaultThemeStatus" style="font-size:13px;color:var(--muted-foreground);"></span>
      </div>
      <p style="margin:6px 0 0;font-size:12px;color:var(--muted-foreground);">${esc(t('对未自行选择主题的用户生效；用户可在控制台「用户设置 → 界面主题」中覆盖。'))}</p>
    `;
    const sel = container.querySelector('#pluginDefaultThemeSelect');
    sel.addEventListener('change', async () => {
      const v = sel.value;
      try {
        await helpers.fetchJSON('/api/admin/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ default_theme: v }),
        });
        state.defaultThemeId = v;
        const st = container.querySelector('#pluginDefaultThemeStatus');
        if (st) st.textContent = t('已保存，刷新后对所有用户生效');
      } catch (e) {
        const st = container.querySelector('#pluginDefaultThemeStatus');
        if (st) st.textContent = e.message;
      }
    });
  }

  function renderThemePickers() {
    renderUserThemePicker(document.getElementById('pluginThemePicker'));
    renderDefaultThemePicker(document.getElementById('pluginDefaultThemePicker'));
  }

  window.CrewThemes = {
    list: () => [...state.themes],
    effective: () => state.userThemeId || state.defaultThemeId || '',
    apply: (id) => { state.userThemeId = id; applyThemeStyle(id || state.defaultThemeId || ''); },
    refreshPickers: renderThemePickers,
    resetStale(area, themeId) {
      // 清掉指向已停用插件的无效选择
      this.apply('');
      fetch('/api/plugins/user-theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ themeId: '' }) })
        .then(() => renderThemePickers()).catch(() => {});
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
        if (box) box.innerHTML = `<p style="color:var(--muted-foreground);font-size:13px;">${esc(t('插件服务未就绪：请重启 CrewRouter 使插件系统生效。'))}</p>`;
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
      ? await waitForApp(() => window.app)
      : await waitForApp(() => window.adminApp);
    if (appObj) patchApp(appObj, area);

    state.ready = true;

    // 主题：拉取用户/默认选择并应用（含设置页选择器首渲）
    initThemes();

    // 初始页面若是插件页/常规页，恢复一次渲染（hash 直达场景）
    const cur = currentPage();
    if (cur) {
      if (cur.startsWith('plugin_')) await renderPluginPageIfAny(cur);
      else if (cur === 'adminPlugins') renderPluginsAdmin(document.getElementById('adminPluginsContent'));
      else {
        if (cur === 'settings') renderUserThemePicker(document.getElementById('pluginThemePicker'));
        if (cur === 'adminSettings') renderDefaultThemePicker(document.getElementById('pluginDefaultThemePicker'));
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
    .mstat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin:14px 0;}
    .mstat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 14px;}
    .mstat .v{font-size:22px;font-weight:700;line-height:1.1;}
    .mstat .l{font-size:12px;color:var(--muted-foreground);margin-top:2px;}
    .mstat.err .v{color:var(--destructive);}
    .mstat.warn .v{color:var(--status-warn);}
    .mcard{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px;}
    .mhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
    .mtitle{font-size:15px;font-weight:600;}
    .mtag{font-size:11px;color:var(--muted-foreground);font-family:monospace;background:var(--muted);padding:1px 7px;border-radius:6px;}
    .mdesc{font-size:13px;color:var(--muted-foreground);margin:6px 0 0;}
    .chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border-radius:999px;background:var(--muted);color:var(--muted-foreground);margin-right:6px;border:1px solid transparent;}
    .chip.on{background:color-mix(in srgb,var(--status-success) 12%,transparent);color:var(--status-success);}
    .chip.off{color:var(--muted-foreground);}
    .chip.warn{background:color-mix(in srgb,var(--status-warn) 12%,transparent);color:var(--status-warn);}
    .chip.perm{font-family:monospace;background:var(--muted);cursor:help;}
    .chip.cap{background:var(--brand-blue-bg);color:var(--brand-blue);}
    .msec{font-size:12px;color:var(--muted-foreground);margin:14px 0 4px;text-transform:uppercase;letter-spacing:.04em;}
    .mtable{width:100%;font-size:12px;border-collapse:collapse;}
    .mtable th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--border);color:var(--muted-foreground);font-weight:500;}
    .mtable td{padding:4px 8px;border-bottom:1px solid var(--border);vertical-align:top;word-break:break-all;}
    .msearch{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 14px;}
    .mmut{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;}
  `;

  function statCard(v, label, cls) {
    return `<div class="mstat ${cls || ''}"><div class="v">${esc(String(v))}</div><div class="l">${esc(label)}</div></div>`;
  }

  function permChip(p) {
    const label = PERM_GLOSSARY[p] || p;
    return `<span class="chip perm" title="${esc(label)}">${esc(p)}</span>`;
  }

  function pluginRow(pl) {
    const open = !!manageState.expanded[pl.id];
    const perms = (pl.permissions || []).map(permChip).join('') || '<span class="chip off">-</span>';

    const statusChips = [
      pl.enabled ? '<span class="chip on">● 已启用</span>' : '<span class="chip off">○ 已禁用</span>',
      pl.onDisk ? '' : '<span class="chip warn">磁盘缺失</span>',
      pl.loaded ? '<span class="chip on">运行中</span>' : '',
      pl.errorCount > 0 || pl.lastError ? `<span class="chip warn">错误 ${esc(String(pl.errorCount))}</span>` : '',
      pl.storeUpdateAvailable ? `<span class="chip warn">有更新 v${esc(String(pl.storeLatestVersion || ''))}</span>` : '',
    ].join('');

    const caps = [];
    if (pl.pages?.length) caps.push(`<span class="chip cap">${esc(String(pl.pages.length))} 页面</span>`);
    if (pl.slots?.length) caps.push(`<span class="chip cap">${esc(String(pl.slots.length))} 插槽</span>`);
    if (pl.routes?.length) caps.push(`<span class="chip cap">${esc(String(pl.routes.length))} API</span>`);
    if (pl.cron?.length) caps.push(`<span class="chip cap">${esc(String(pl.cron.length))} 定时任务</span>`);
    if (pl.themes?.length) caps.push(`<span class="chip cap">${esc(String(pl.themes.length))} 主题</span>`);
    const capsHtml = caps.join('') || '<span class="chip off">无能力注册</span>';

    const detail = open ? pluginDetail(pl, perms) : '';
    return `
      <div class="mcard">
        <div class="mhead">
          <div style="flex:1;min-width:260px;">
            <div class="mtitle">🧩 ${esc(pl.name)} <span class="mtag">v${esc(pl.version || '-')} · ${esc(pl.id)}</span></div>
            ${pl.author ? `<div style="font-size:12px;color:var(--muted-foreground);margin-top:2px;">作者：${esc(pl.author)}</div>` : ''}
            ${pl.description ? `<div class="mdesc">${esc(pl.description)}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
            <div>${statusChips}</div>
            <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;"><input type="checkbox" ${pl.enabled ? 'checked' : ''} onchange="window.__pluginRT.toggle('${esc(pl.id)}', this.checked)"> ${esc(t('启用'))}</label>
          </div>
        </div>
        <div style="margin-top:10px;">${capsHtml}</div>
        <div class="mmut">
          ${pl.storeUpdateAvailable && pl.storeSource ? `<button class="btn btn-ghost btn-sm" style="color:var(--primary);" onclick="window.__pluginRT.updateFromStore('${esc(pl.id)}')">${esc(t('更新'))}</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="window.__pluginRT.expand('${esc(pl.id)}')">${open ? esc(t('收起')) : esc(t('配置'))}</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__pluginRT.reload('${esc(pl.id)}')">${esc(t('重载'))}</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--destructive);" onclick="window.__pluginRT.uninstall('${esc(pl.id)}')">${esc(t('卸载'))}</button>
        </div>
        ${detail}
      </div>`;
  }

  function pluginDetail(pl, perms) {
    const routesHtml = (pl.routes || []).map(r =>
      `${esc((r.method || 'GET').toUpperCase())} <code style="font-family:monospace;">/api/plugins/${esc(pl.id)}${esc(r.path)}</code> <span style="color:var(--muted-foreground);font-size:11px;">(${esc(r.auth || 'user')})</span>`
    ).join('<br>');
    const cronHtml = (pl.cron || []).map(c =>
      `<code style="font-family:monospace;">${esc(c.expr || '-')}</code> <span style="color:var(--muted-foreground);font-size:11px;">→ ${esc(c.handler || '-')}</span>`
    ).join('<br>');
    const themesHtml = (pl.themes || []).map(th => esc(th.name || th.id)).join('、');
    const cfgText = esc(JSON.stringify(pl.config || {}, null, 2));

    return `
      <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:4px;">
        <div class="msec">${esc(t('权限声明'))}</div>
        <div>${perms}</div>
        ${pl.routes?.length ? `<div class="msec">${esc(t('自有 API'))}</div><div style="font-size:12px;">${routesHtml}</div>` : ''}
        ${pl.cron?.length ? `<div class="msec">${esc(t('定时任务'))}</div><div style="font-size:12px;">${cronHtml}</div>` : ''}
        ${pl.themes?.length ? `<div class="msec">${esc(t('主题'))}</div><div style="font-size:12px;">${themesHtml}</div>` : ''}
        <div class="msec">${esc(t('插件配置'))}(config)</div>
        <textarea data-plugin-cfg="${esc(pl.id)}" rows="5" style="width:100%;font-family:monospace;font-size:12px;background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:8px;padding:8px;">${cfgText}</textarea>
        <div style="margin-top:6px;display:flex;gap:8px;">
          <button class="btn btn-secondary btn-sm" onclick="window.__pluginRT.saveConfig('${esc(pl.id)}')">${esc(t('保存配置'))}</button>
          <div data-plugin-cfg-msg="${esc(pl.id)}" style="font-size:12px;align-self:center;"></div>
        </div>
        <div class="msec">${esc(t('插件数据'))}(plugin_data)</div>
        <div data-plugin-data="${esc(pl.id)}"><p style="font-size:12px;color:var(--muted-foreground);margin:0;">${esc(t('加载中...'))}</p></div>
        ${pl.lastError ? `<div class="msec">${esc(t('最近错误'))}</div><div style="font-size:12px;color:var(--destructive);">⚠ ${esc(pl.lastError)}</div>
          <div style="margin-top:4px;"><button class="btn btn-ghost btn-sm" onclick="window.__pluginRT.resetErrors('${esc(pl.id)}')">${esc(t('清除错误并重载'))}</button></div>` : ''}
      </div>`;
  }

  async function renderPluginsAdmin(container, keepExpand) {
    if (!container) return;
    if (!keepExpand) container.innerHTML = `<div class="page-loading page-loading-compact"><div class="loading-spinner md" role="status"></div><div class="page-loading-text">${esc(t('加载中...'))}</div></div>`;
    let data;
    try {
      data = await helpers.fetchJSON('/api/admin/plugins');
    } catch (e) {
      container.innerHTML = `<p style="color:var(--destructive)">${esc(t('加载失败'))}: ${esc(e.message)}</p>`;
      return;
    }
    manageState.plugins = data.plugins || [];

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
          <p style="font-size:13px;color:var(--muted-foreground);margin:0;">${esc(t('安装方法：将插件目录放入服务器 plugins/ 目录，重启服务后在此启用。'))}</p>
        </div>
        <div class="mmut" style="margin-top:0;"><button class="btn btn-secondary btn-sm" onclick="window.__pluginRT.refresh()">${esc(t('刷新'))}</button></div>
      </div>
      <div class="mstat-grid">${stats}</div>
      <div class="msearch">
        <input type="search" id="pluginSearchInput" class="input" style="flex:1;min-width:200px;" placeholder="${esc(t('搜索插件名称、ID、作者或描述'))}" value="${esc(manageState.search)}" oninput="window.__pluginRT.search(this.value)">
        <select id="pluginSortSelect" class="select" onchange="window.__pluginRT.sort(this.value)">
          <option value="id" ${manageState.sort === 'id' ? 'selected' : ''}>${esc(t('按名称排序'))}</option>
          <option value="name" ${manageState.sort === 'name' ? 'selected' : ''}>${esc(t('按显示名排序'))}</option>
          <option value="enabled" ${manageState.sort === 'enabled' ? 'selected' : ''}>${esc(t('按状态排序'))}</option>
        </select>
      </div>
      ${rows ? rows : `<p style="color:var(--muted-foreground);font-size:14px;">${q ? esc(t('未找到匹配插件')) : esc(t('暂无插件。将插件目录放入 plugins/ 后重启服务即可在此看到。'))}</p>`}
    `;
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
      if (!window.confirm(t('确定要将插件') + '「' + pl.name + '」' + t('更新到') + ' v' + next + t('吗？'))) return;
      try {
        await helpers.fetchJSON('/api/admin/plugins/install-from-store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plugin: pl.storeId, source: pl.storeSource }),
        });
        this.refresh();
      } catch (e) {
        window.alert(t('更新失败') + '：' + e.message);
      }
    },
    expand(id) { manageState.expanded[id] = !manageState.expanded[id]; this.refresh(); if (manageState.expanded[id]) this.loadData(id); },
    async loadData(id) {
      const box = document.querySelector(`[data-plugin-data="${id}"]`);
      if (!box) return;
      box.innerHTML = `<p style="font-size:12px;color:var(--muted-foreground);margin:0;">${esc(t('加载中...'))}</p>`;
      try {
        const data = await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}/data`);
        const rows = data.keys || [];
        if (!rows.length) {
          box.innerHTML = `<p style="font-size:12px;color:var(--muted-foreground);margin:0;">${esc(t('暂无数据'))}</p>`;
          return;
        }
        box.innerHTML = `<table class="mtable">
          <tr><th>${esc(t('键'))}</th><th>${esc(t('值'))}</th><th>${esc(t('更新时间'))}</th><th></th></tr>
          ${rows.map(r => `<tr>
            <td style="font-family:monospace;">${esc(r.key)}</td>
            <td style="font-family:monospace;max-width:320px;">${esc(JSON.stringify(r.value))}</td>
            <td style="white-space:nowrap;">${esc(String(r.updatedAt || '').slice(0, 19).replace('T', ' '))}</td>
            <td><button class="btn btn-ghost btn-sm" style="font-size:11px;padding:1px 8px;" onclick="window.__pluginRT.deleteData('${esc(id)}', '${esc(r.key)}')">${esc(t('删除'))}</button></td>
          </tr>`).join('')}
        </table>`;
      } catch (e) {
        box.innerHTML = `<p style="font-size:12px;color:var(--destructive);margin:0;">${esc(e.message)}</p>`;
      }
    },
    async deleteData(id, key) {
      if (!confirm(t('确定删除该插件数据键？'))) return;
      try {
        await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}/data/${encodeURIComponent(key)}`, { method: 'DELETE' });
        this.loadData(id);
      } catch (e) { alert(e.message); }
    },
    async toggle(id, enabled) {
      try {
        await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}/toggle`, { method: 'POST' });
        this.refresh();
      } catch (e) { alert(e.message); this.refresh(); }
    },
    async reload(id) {
      try {
        await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}/reload`, { method: 'POST' });
        msg(id, t('已重载'), true);
      } catch (e) { msg(id, e.message, false); }
    },
    async uninstall(id) {
      if (!confirm(t('确定卸载该插件的记录？（需先禁用；插件目录不会被删除）'))) return;
      try {
        await helpers.fetchJSON(`/api/admin/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' });
        this.refresh();
      } catch (e) { alert(e.message); }
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
      } catch (e) { alert(e.message); }
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
