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

  function applyThemeStyle(themeId) {
    const el = document.getElementById('crPluginThemeStyle');
    const theme = themeId ? findTheme(themeId) : null;
    if (!theme) {
      if (el) el.remove();
      return;
    }
    // 仅注入样式表，不改任何行为；重复应用先移除旧节点
    if (el && el.href === theme.url) return;
    if (el) el.remove();
    const link = document.createElement('link');
    link.id = 'crPluginThemeStyle';
    link.rel = 'stylesheet';
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
      opts.push(`<option value="${esc(th.id)}" ${selectedId === th.id ? 'selected' : ''}>${esc(th.name)}</option>`);
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
        state.themes.push({ id: th.id, name: th.name, url: th.url, pluginId: p.id });
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

  let manageState = { plugins: [], expanded: {} };

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

    const rows = manageState.plugins.map((pl) => {
      const open = !!manageState.expanded[pl.id];
      const perms = (pl.permissions || []).map(x => `<span style="display:inline-block;padding:1px 8px;border-radius:10px;background:var(--muted);font-size:11px;margin-right:4px;">${esc(x)}</span>`).join('');
      const statusBadge = pl.enabled
        ? `<span style="color:var(--success,#16a34a);">● ${esc(t('已启用'))}</span>`
        : `<span style="color:var(--muted-foreground);">○ ${esc(t('已禁用'))}</span>`;
      const errInfo = pl.lastError
        ? `<div style="margin-top:6px;font-size:12px;color:var(--destructive);">⚠ ${esc(pl.lastError)}（${esc(String(pl.errorCount))}）</div>`
        : '';
      const cfgText = esc(JSON.stringify(pl.config || {}, null, 2));
      const detail = open ? `
        <div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px;">
          <div style="font-size:12px;color:var(--muted-foreground);margin-bottom:4px;">${esc(t('权限声明'))}</div>
          <div>${perms || '<span style="font-size:12px;color:var(--muted-foreground);">-</span>'}</div>
          ${pl.routes?.length ? `<div style="font-size:12px;color:var(--muted-foreground);margin:8px 0 4px;">API: ${pl.routes.map(r => esc(`${(r.method || 'GET').toUpperCase()} /api/plugins/${pl.id}${r.path}`)).join('、')}</div>` : ''}
          <div style="font-size:12px;color:var(--muted-foreground);margin:8px 0 4px;">${esc(t('插件配置'))}(config)</div>
          <textarea data-plugin-cfg="${esc(pl.id)}" rows="5" style="width:100%;font-family:monospace;font-size:12px;background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:8px;padding:8px;">${cfgText}</textarea>
          <div style="margin-top:6px;display:flex;gap:8px;">
            <button class="btn btn-secondary btn-sm" onclick="window.__pluginRT.saveConfig('${esc(pl.id)}')">${esc(t('保存配置'))}</button>
            ${pl.lastError ? `<button class="btn btn-ghost btn-sm" onclick="window.__pluginRT.resetErrors('${esc(pl.id)}')">${esc(t('清除错误并重载'))}</button>` : ''}
          </div>
          <div data-plugin-cfg-msg="${esc(pl.id)}" style="font-size:12px;margin-top:4px;"></div>
        </div>` : '';
      return `
        <div class="content-card" style="padding:14px 16px;border:1px solid var(--border);border-radius:12px;margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <div style="flex:1;min-width:200px;">
              <div style="font-weight:600;">🧩 ${esc(pl.name)} <span style="font-size:12px;color:var(--muted-foreground);">v${esc(pl.version || '-')} · ${esc(pl.id)}</span></div>
              <div style="font-size:12px;color:var(--muted-foreground);margin-top:2px;">${esc(pl.description || '')}</div>
              ${errInfo}
            </div>
            <div style="font-size:13px;">${statusBadge}${pl.onDisk ? '' : ` · <span style="color:var(--destructive);font-size:12px;">${esc(t('磁盘缺失'))}</span>`}</div>
            <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
              <input type="checkbox" ${pl.enabled ? 'checked' : ''} onchange="window.__pluginRT.toggle('${esc(pl.id)}', this.checked)"> ${esc(t('启用'))}
            </label>
            <button class="btn btn-ghost btn-sm" onclick="window.__pluginRT.reload('${esc(pl.id)}')">${esc(t('重载'))}</button>
            <button class="btn btn-ghost btn-sm" onclick="window.__pluginRT.expand('${esc(pl.id)}')">${open ? esc(t('收起')) : esc(t('配置'))}</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--destructive);" onclick="window.__pluginRT.uninstall('${esc(pl.id)}')">${esc(t('卸载'))}</button>
          </div>
          ${detail}
        </div>`;
    }).join('');

    container.innerHTML = `
      <div class="section-header">
        <div>
          <h2>${esc(t('插件管理'))}</h2>
          <p style="font-size:13px;color:var(--muted-foreground);margin:0;">${esc(t('安装方法：将插件目录放入服务器 plugins/ 目录，重启服务后在此启用。'))}</p>
        </div>
        <div><button class="btn btn-secondary btn-sm" onclick="window.__pluginRT.refresh()">${esc(t('刷新'))}</button></div>
      </div>
      ${rows.length ? rows : `<p style="color:var(--muted-foreground);font-size:14px;">${esc(t('暂无插件。将插件目录放入 plugins/ 后重启服务即可在此看到。'))}</p>`}
    `;
  }

  function msg(id, text, ok) {
    const el = document.querySelector(`[data-plugin-cfg-msg="${id}"]`);
    if (el) {
      el.textContent = text;
      el.style.color = ok ? 'var(--success,#16a34a)' : 'var(--destructive)';
    }
  }

  window.__pluginRT = {
    refresh() { renderPluginsAdmin(document.getElementById('adminPluginsContent')); },
    expand(id) { manageState.expanded[id] = !manageState.expanded[id]; this.refresh(); },
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
