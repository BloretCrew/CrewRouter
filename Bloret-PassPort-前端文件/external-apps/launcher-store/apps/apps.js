/**
 * Bloret Launcher Plugin Store — Blora Design UI
 */
(function () {
  'use strict';

  const LOG = (...args) => console.log('[Apps]', ...args);
  const LOG_ERR = (...args) => console.error('[Apps]', ...args);

  const I18n = window.BloretAppsI18n || null;

  function t(key, vars) {
    return I18n && typeof I18n.t === 'function' ? I18n.t(key, vars) : key;
  }

  function starsInlineHtml(avg, opts) {
    const value = Math.max(0, Math.min(5, Number(avg) || 0));
    const rounded = Math.round(value);
    let stars = '';
    for (let i = 1; i <= 5; i++) {
      stars += `<span class="${i <= rounded ? 'is-on' : 'is-off'}">★</span>`;
    }
    const showNum = !opts || opts.showNum !== false;
    const count = opts && opts.count != null ? Number(opts.count) : null;
    const numHtml = showNum
      ? `<span class="apps-detail-hero__score">${escapeHtml(value ? value.toFixed(1) : '—')}</span>`
      : '';
    const countHtml =
      count != null
        ? `<span>(${escapeHtml(t('ratingsCount', { n: formatCount(count) }))})</span>`
        : '';
    return `<span class="apps-stars-inline" aria-hidden="true">${stars}</span>${numHtml}${countHtml}`;
  }

  function rateWidgetHtml(value, readonly, id) {
    const v = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
    // blora-rate forces min value 1 on init — use plain stars for empty readonly
    if (readonly && v === 0) {
      return `<span class="apps-stars-inline" aria-hidden="true"><span class="is-off">★</span><span class="is-off">★</span><span class="is-off">★</span><span class="is-off">★</span><span class="is-off">★</span></span>`;
    }
    let stars = '';
    for (let i = 1; i <= 5; i++) {
      stars += `<span class="blora-rate__star${i <= v ? ' is-on' : ''}" data-star="${i}">★</span>`;
    }
    // interactive widgets default to 5-star UI; 0 means “unset” → start at 0 visuals until click (use data-value 0, init may clamp)
    const dataVal = !readonly && v === 0 ? 0 : Math.max(v, readonly ? v : v || 0);
    return `<div class="blora-rate" data-value="${dataVal || (readonly ? 1 : 0)}" ${readonly ? 'data-readonly' : ''} ${id ? `id="${escapeHtml(id)}"` : ''}>${stars}</div>`;
  }

  function shotUrl(shot, preferWebp) {
    if (!shot) return '';
    if (typeof shot === 'string') return shot;
    if (preferWebp && shot.webpUrl) return shot.webpUrl;
    return shot.url || shot.webpUrl || '';
  }

  async function uploadImageFile(file) {
    const fd = new FormData();
    fd.append('image', file);
    const data = await api('/apps/api/media/upload', { method: 'POST', body: fd });
    return data.data;
  }

  function formatDate(isoStr) {
    if (!isoStr) return '—';
    return String(isoStr).replace('T', ' ').slice(0, 19);
  }

  /** Build bloret://plugin/install?... (store one-click install) */
  function buildBloretInstallUrl(plugin) {
    const q = new URLSearchParams();
    if (!plugin || !plugin.download) return '';
    q.set('download', plugin.download);
    for (const k of ['id', 'name', 'version', 'description', 'sha256']) {
      if (plugin[k]) q.set(k, String(plugin[k]));
    }
    const author = plugin.authorNickname || plugin.author || plugin.authorUsername;
    if (author) q.set('author', String(author));
    q.set('source', 'store');
    return `bloret://plugin/install?${q.toString()}`;
  }

  function toStoreProposePayload(plugin) {
    const payload = {
      download: plugin.download || '',
      id: plugin.id || '',
      name: plugin.name || '',
      version: plugin.version || '',
      author: plugin.authorNickname || plugin.author || plugin.authorUsername || '',
      description: plugin.description || '',
      sha256: plugin.sha256 || '',
      source: 'store'
    };
    Object.keys(payload).forEach((k) => {
      if (k !== 'download' && k !== 'source' && !payload[k]) delete payload[k];
    });
    return payload;
  }

  function trackInstallClick(pluginId) {
    return api('/apps/api/plugins/' + encodeURIComponent(pluginId) + '/install-click', {
      method: 'POST'
    }).catch((e) => LOG_ERR('install-click failed', e));
  }

  /** bloralauncher://plugin/install deep link for Flutter (Blora Launcher) */
  function buildBloraFlutterInstallUrl(plugin) {
    const q = new URLSearchParams();
    if (!plugin || !plugin.id) return '';
    for (const k of ['id', 'name', 'version', 'description', 'download']) {
      if (plugin[k]) q.set(k, String(plugin[k]));
    }
    const author = plugin.authorNickname || plugin.author || plugin.authorUsername;
    if (author) q.set('author', String(author));
    q.set('source', 'store');
    return `bloralauncher://plugin/install?${q.toString()}`;
  }

  /**
   * Flutter propose 载荷：外链 ZIP 传名称/id/描述/ZIP 直链；仅 manifest 直接携带清单内容。
   */
  function toFlutterProposePayload(plugin) {
    const payload = { source: 'flutter-store' };
    if (plugin && plugin.download) {
      payload.id = plugin.id || '';
      payload.name = plugin.name || '';
      payload.description = plugin.description || '';
      payload.download = plugin.download;
      if (plugin.version) payload.version = plugin.version;
      if (plugin.authorNickname || plugin.author || plugin.authorUsername) {
        payload.author = plugin.authorNickname || plugin.author || plugin.authorUsername;
      }
    } else {
      payload.manifest = (plugin && plugin.manifest) || '';
    }
    return payload;
  }

  /**
   * Smart install for Blora Launcher (Flutter 版).
   * 先尝试 localhost propose（127.0.0.1:25253），失败则回退 bloralauncher:// 深链。
   * 仅-manifest 无法通过深链冷启动，需启动器正在运行。
   * @returns {Promise<{path:string,url?:string,data?:object}>}
   */
  async function installToBloraLauncherFlutter(plugin) {
    if (!plugin || !plugin.id) {
      throw new Error(t('installNeedDownload'));
    }
    const manifestOnly = !plugin.download;
    if (manifestOnly && !plugin.manifest) {
      throw new Error(t('flutterInstallNeedManifest'));
    }
    if (!manifestOnly && !String(plugin.download).startsWith('https://')) {
      throw new Error(t('installNeedHttps'));
    }

    const payload = toFlutterProposePayload(plugin);
    const protocolUrl = buildBloraFlutterInstallUrl(plugin);

    // 1) Local propose while the launcher is running
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 800);
      const res = await fetch('http://127.0.0.1:25253/plugin/store/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
        mode: 'cors'
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data && data.ok !== false) {
          LOG('install via flutter localhost propose', plugin.id);
          trackInstallClick(plugin.id);
          return { path: 'localhost', data };
        }
      }
    } catch (e) {
      LOG('flutter propose unavailable', e && e.name);
    }

    // 2) 仅-manifest 无深链可回退，明确提示
    if (manifestOnly) {
      throw new Error(t('flutterInstallNotFound'));
    }

    // 3) Custom protocol (cold start)
    LOG('install via bloralauncher://', protocolUrl.slice(0, 80));
    trackInstallClick(plugin.id);
    window.location.href = protocolUrl;
    return { path: 'protocol', url: protocolUrl };
  }

  /**
   * Smart install: try localhost propose, else bloret:// protocol.
   * @returns {Promise<{path:string,url?:string,data?:object}>}
   */
  async function installToBloretLauncher(plugin) {
    if (!plugin || !plugin.download) {
      throw new Error(t('installNeedHttps'));
    }
    if (!String(plugin.download).startsWith('https://')) {
      throw new Error(t('installNeedHttps'));
    }

    const payload = toStoreProposePayload(plugin);
    const protocolUrl = buildBloretInstallUrl(plugin);

    // 1) Local propose when launcher is already running
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 800);
      const res = await fetch('http://127.0.0.1:25252/plugin/store/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
        mode: 'cors'
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data && data.ok !== false) {
          LOG('install via localhost propose', plugin.id);
          trackInstallClick(plugin.id);
          return { path: 'localhost', data };
        }
      }
    } catch (e) {
      LOG('propose unavailable, fallback protocol', e && e.name);
    }

    // 2) Custom protocol (cold start)
    LOG('install via bloret://', protocolUrl.slice(0, 80));
    trackInstallClick(plugin.id);
    window.location.href = protocolUrl;
    return { path: 'protocol', url: protocolUrl };
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  function isHighRiskPerm(id) {
    if (I18n && typeof I18n.isHighRisk === 'function') return I18n.isHighRisk(id);
    return false;
  }

  const HIGH_RISK_PERMS = I18n && I18n.HIGH_RISK
    ? I18n.HIGH_RISK
    : new Set([
        'launch.hooks',
        'process.exec',
        'config.write',
        'agent.bloriko',
        'agent.blrpe',
        'fs.datapath',
        'web.routes',
        'net.http',
        'download.hooks'
      ]);

  const ALL_PERMS =
    I18n && typeof I18n.allPermissionIds === 'function'
      ? I18n.allPermissionIds()
      : [
          'ui.nav',
          'ui.theme',
          'ui.settings',
          'ui.toolbar',
          'ui.home',
          'ui.tools',
          'launch.hooks',
          'download.hooks',
          'agent.bloriko',
          'agent.blrpe',
          'config.read',
          'config.write',
          'fs.datapath',
          'net.http',
          'process.exec',
          'web.routes'
        ];

  let currentUser = null;

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $all(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(msg, type) {
    if (window.Blora && typeof Blora.toast === 'function') {
      Blora.toast({
        type: type || 'info',
        message: msg,
        duration: 3200
      });
      return;
    }
    LOG('toast fallback', type, msg);
  }

  async function api(path, options = {}) {
    const opts = {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      ...options
    };
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    LOG('API', opts.method || 'GET', path);
    const res = await fetch(path, opts);
    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { success: false, error: text || res.statusText };
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText || '请求失败');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function loadMe() {
    try {
      const data = await api('/apps/api/me');
      currentUser = data.loggedIn ? data.user : null;
      LOG('session', currentUser ? currentUser.username : 'anonymous', currentUser);
      return currentUser;
    } catch (e) {
      LOG_ERR('loadMe failed', e);
      currentUser = null;
      return null;
    }
  }

  function loginUrl(returnTo) {
    const rt = returnTo || window.location.pathname + window.location.search;
    return `/apps/auth/login?return_to=${encodeURIComponent(rt)}`;
  }

  // Product look: Studio shape + Mono palette (minimal). Only light/dark is user-toggleable.
  function ensureStudioTheme() {
    const cfg = window.BloraConfig || {};
    const theme = cfg.defaultTheme || 'studio';
    const palette = cfg.defaultPalette || 'minimal';
    if (window.Blora && typeof Blora.applyTheme === 'function') {
      Blora.applyTheme(theme, document.documentElement, {
        persist: true,
        emit: false,
        applyDefaultPalette: false
      });
      if (typeof Blora.applyPalette === 'function') {
        Blora.applyPalette(palette, document.documentElement, { persist: true, emit: false });
      }
    } else {
      document.documentElement.dataset.bloraThemeStyle = theme;
      document.documentElement.dataset.bloraPalette = palette;
    }
    LOG('theme locked', theme, palette);
  }

  function localeToggleHtml() {
    const nextLabel = t('localeToggle');
    const current = I18n ? I18n.getLocale() : 'zh';
    return `
      <button type="button" class="blora-btn blora-btn--ghost blora-btn--sm apps-locale-btn" data-apps-locale-toggle
        title="${escapeHtml(nextLabel)}" aria-label="${escapeHtml(nextLabel)}" data-locale="${escapeHtml(current)}">
        ${escapeHtml(nextLabel)}
      </button>`;
  }

  function bindLocaleToggle(root) {
    $all('[data-apps-locale-toggle]', root || document).forEach((btn) => {
      if (btn.dataset.boundLocale === '1') return;
      btn.dataset.boundLocale = '1';
      btn.addEventListener('click', () => {
        if (!I18n) return;
        const cur = I18n.getLocale();
        const next = cur === 'zh' ? 'en' : 'zh';
        I18n.setLocale(next);
        LOG('locale switch', next);
        // Full re-render of dynamic chrome
        renderNav();
        applyStaticI18n();
        const page = document.body.dataset.page;
        if (page === 'plugin') pagePlugin({ silent: true });
        else if (page === 'submit') refreshSubmitPermLabels();
        else if (page === 'submit-flutter') refreshFlutterSubmitI18n();
      });
    });
  }

  function refreshFlutterSubmitI18n() {
    refreshSubmitPermLabels();
    const sw = $('#submit-mode-switch');
    const active = sw && sw.querySelector('.apps-switch__item.is-active');
    const mode = active ? active.getAttribute('data-mode') : 'zip';
    const hint = $('#submit-mode-hint');
    if (hint) hint.textContent = t(mode === 'manifest' ? 'manifestOnlyHint' : 'importFromManifestHint');
    const title = $('#manifest-import-title');
    if (title) title.textContent = t(mode === 'manifest' ? 'manifestOnlySection' : 'importFromManifest');
    const tHint = $('#manifest-import-hint');
    if (tHint) tHint.innerHTML = t(mode === 'manifest' ? 'manifestOnlyHint' : 'importFromManifestHint');
  }

  function applyStaticI18n() {
    // Shell strings with data-i18n attributes
    $all('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    $all('[data-i18n-aria]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria');
      if (key) el.setAttribute('aria-label', t(key));
    });
    $all('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (key) el.setAttribute('title', t(key));
    });
  }

  function renderNav() {
    const host = $('#nav-auth-slot');
    if (!host) return;

    const darkToggle = `
      <button type="button" class="blora-btn blora-btn--ghost blora-btn--icon blora-btn--sm" data-blora-theme title="${escapeHtml(t('themeToggle'))}" aria-label="${escapeHtml(t('themeToggle'))}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/>
        </svg>
      </button>`;

    if (!currentUser) {
      host.innerHTML = `
        ${localeToggleHtml()}
        ${darkToggle}
        <a class="blora-btn blora-btn--primary blora-btn--sm" href="${escapeHtml(loginUrl())}">${escapeHtml(t('login'))}</a>
      `;
      if (window.Blora && Blora.init) Blora.init(host);
      bindLocaleToggle(host);
      return;
    }

    const displayName = currentUser.nickname || currentUser.username || '?';
    const avatar = currentUser.avatar
      ? `<span class="blora-avatar blora-avatar--sm"><img src="${escapeHtml(currentUser.avatar)}" alt="" width="28" height="28" style="width:100%;height:100%;object-fit:cover;border-radius:inherit" /></span>`
      : `<span class="blora-avatar blora-avatar--sm blora-avatar--seal">${escapeHtml(displayName[0])}</span>`;

    host.innerHTML = `
      <a class="blora-btn blora-btn--ghost blora-btn--sm" href="/apps/submit">${escapeHtml(t('submit'))}</a>
      <a class="blora-btn blora-btn--ghost blora-btn--sm" href="/apps/mine">${escapeHtml(t('mine'))}</a>
      ${currentUser.admin ? `<a class="blora-btn blora-btn--ghost blora-btn--sm" href="/apps/admin">${escapeHtml(t('admin'))}</a>` : ''}
      <span class="apps-nav-user" title="${escapeHtml(displayName)}">
        ${avatar}
        <span class="apps-nav-username">${escapeHtml(displayName)}</span>
      </span>
      ${localeToggleHtml()}
      ${darkToggle}
      <a class="blora-btn blora-btn--outline blora-btn--sm" href="/apps/auth/logout">${escapeHtml(t('logout'))}</a>
    `;
    if (window.Blora && Blora.init) Blora.init(host);
    bindLocaleToggle(host);
  }

  function statusTag(status) {
    const s = status || 'pending';
    const map = {
      pending: 'blora-tag blora-tag--gold',
      approved: 'blora-tag blora-tag--moss',
      rejected: 'blora-tag blora-tag--seal'
    };
    const labels = {
      pending: t('pending'),
      approved: t('approved'),
      rejected: t('rejected')
    };
    return `<span class="${map[s] || 'blora-tag'}">${escapeHtml(labels[s] || s)}</span>`;
  }

  function updatePendingTag() {
    return `<span class="blora-tag blora-tag--gold">${escapeHtml(t('updatePending'))}</span>`;
  }

  function pluginStatusTags(p) {
    const parts = [];
    if (p.status === 'approved' && p.hasPendingUpdate) {
      parts.push(statusTag('approved'));
      parts.push(updatePendingTag());
    } else {
      parts.push(statusTag(p.status));
    }
    return parts.join(' ');
  }

  function fillFormFromPlugin(src) {
    if (!src) return;
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val != null ? String(val) : '';
    };
    set('field-id', src.id || '');
    set('field-name', src.name || '');
    set('field-version', src.version || '');
    set('field-author', src.author || '');
    set('field-description', src.description || '');
    set('field-long-description', src.longDescription || '');
    set('field-download', src.download || '');
    set('field-sha256', src.sha256 || '');
    set('field-url', src.url || '');
    set('field-icon', src.icon || '');
    set(
      'field-tags',
      Array.isArray(src.tags) ? src.tags.join(', ') : src.tags || ''
    );
    const permHost = $('#perm-checks');
    if (permHost && Array.isArray(src.permissions)) {
      const setPerms = new Set(src.permissions.map(String));
      $all('input[name="perm"]', permHost).forEach((el) => {
        el.checked = setPerms.has(el.value);
      });
    }
  }

  function iconBlock(plugin, size) {
    const isHero = size === 'hero';
    const isDetail = size === 'lg' || isHero;
    const imgClass = isHero
      ? 'apps-detail-hero__icon'
      : isDetail
        ? 'apps-detail__icon'
        : 'apps-plugin-card__icon';
    const fbClass = isHero
      ? 'apps-detail-hero__icon-fallback'
      : isDetail
        ? 'apps-detail__icon-fallback'
        : 'apps-plugin-card__icon-fallback';
    const letter = escapeHtml((plugin.name || plugin.id || '?')[0]);
    if (plugin.icon) {
      return `<img class="${imgClass}" src="${escapeHtml(plugin.icon)}" alt="" loading="lazy"
        onerror="this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex'" />
        <div class="${fbClass}" style="display:none" aria-hidden="true">${letter}</div>`;
    }
    return `<div class="${fbClass}" aria-hidden="true">${letter}</div>`;
  }

  function tagsHtml(plugin) {
    const tags = plugin.tags || [];
    const perms = plugin.permissions || [];
    const risk = perms.some((p) => isHighRiskPerm(p) || HIGH_RISK_PERMS.has(p));
    let html = tags
      .slice(0, 4)
      .map((tag) => `<span class="blora-tag">${escapeHtml(tag)}</span>`)
      .join('');
    if (risk) html += `<span class="blora-tag blora-tag--gold">${escapeHtml(t('highPermTag'))}</span>`;
    return html;
  }

  function permissionsListHtml(perms) {
    if (!perms || !perms.length) {
      return `<p class="blora-text-muted">${escapeHtml(t('noPermissions'))}</p>`;
    }
    const wiki =
      'https://github.com/BloretCrew/Bloret-Launcher/wiki/%E6%8F%92%E4%BB%B6%E5%BC%80%E5%8F%91%E8%A7%84%E8%8C%83';
    const items = perms
      .map((id) => {
        const meta =
          I18n && typeof I18n.permMeta === 'function'
            ? I18n.permMeta(id)
            : { id, risk: HIGH_RISK_PERMS.has(id), name: id, use: '', known: false };
        const risk = meta.risk || isHighRiskPerm(id);
        return `
          <li class="apps-perm-item ${risk ? 'is-risk' : ''}">
            <div class="apps-perm-item__row">
              <code class="apps-perm-item__id">${escapeHtml(id)}</code>
              ${risk ? `<span class="blora-tag blora-tag--gold">${escapeHtml(t('highRisk'))}</span>` : ''}
            </div>
            <div class="apps-perm-item__name">${escapeHtml(meta.name)}</div>
            ${
              meta.use
                ? `<div class="apps-perm-item__use"><span class="apps-perm-item__use-label">${escapeHtml(t('typicalUse'))}</span> ${escapeHtml(meta.use)}</div>`
                : ''
            }
          </li>`;
      })
      .join('');
    return `
      <ul class="apps-perm-list">${items}</ul>
      <p class="blora-hint apps-perm-doc">
        ${escapeHtml(t('permDocNote'))}
        · <a href="${wiki}" target="_blank" rel="noopener">${escapeHtml(t('permDocLink'))}</a>
      </p>`;
  }

  function cardHtml(plugin) {
    const installs = Number(plugin.installCount || 0);
    const ratingCount = Number(plugin.ratingCount || 0);
    const ratingAvg = Number(plugin.ratingAvg || 0);
    const ratingLine =
      ratingCount > 0
        ? `<div class="apps-plugin-card__rating">${starsInlineHtml(ratingAvg, { count: ratingCount })}</div>`
        : `<div class="apps-plugin-card__rating">${escapeHtml(t('noRatings'))}</div>`;
    return `
      <a class="blora-card blora-card--hover apps-plugin-card" href="/apps/plugin/${encodeURIComponent(plugin.id)}" data-id="${escapeHtml(plugin.id)}">
        <div class="apps-plugin-card__head">
          ${iconBlock(plugin)}
          <div>
            <h3 class="apps-plugin-card__title">${escapeHtml(plugin.name)}${plugin.pluginType === 'flutter' ? `<span class="apps-plugin-card__type" title="${escapeHtml(t('submitFlutter'))}">${escapeHtml(t('flutterTag'))}</span>` : ''}</h3>
            <div class="apps-plugin-card__meta">v${escapeHtml(plugin.version)} · ${escapeHtml(plugin.authorNickname || plugin.author || plugin.authorUsername || '')}</div>
            ${ratingLine}
          </div>
        </div>
        <p class="apps-plugin-card__desc">${escapeHtml(plugin.description || t('noDescription'))}</p>
        <div class="apps-plugin-card__tags">
          ${tagsHtml(plugin)}
          ${plugin.status && plugin.status !== 'approved' ? statusTag(plugin.status) : ''}
        </div>
        <div class="apps-plugin-card__foot">
          <span>${formatCount(installs)} ${escapeHtml(t('installsShort'))}</span>
          <span class="apps-plugin-card__foot-cta">${escapeHtml(t('viewCta'))}</span>
        </div>
      </a>
    `;
  }

  function skeletonCards(n) {
    const count = n || 6;
    return Array.from({ length: count }, () => `
      <div class="apps-skeleton-card" aria-hidden="true">
        <div class="apps-skeleton-card__head">
          <span class="blora-skeleton blora-skeleton--circle" style="width:52px;height:52px;border-radius:var(--blora-radius-lg)"></span>
          <div style="flex:1">
            <span class="blora-skeleton blora-skeleton--title" style="width:55%"></span>
            <span class="blora-skeleton blora-skeleton--text" style="width:40%"></span>
          </div>
        </div>
        <span class="blora-skeleton blora-skeleton--text" style="width:100%"></span>
        <span class="blora-skeleton blora-skeleton--text" style="width:88%"></span>
        <span class="blora-skeleton blora-skeleton--text" style="width:64%"></span>
      </div>`).join('');
  }

  function emptyHtml(title, desc, actionHtml) {
    return `
      <div class="blora-empty">
        <div class="blora-empty__icon" aria-hidden="true">◇</div>
        <div class="blora-empty__title">${escapeHtml(title)}</div>
        <div class="blora-empty__desc">${desc || ''}</div>
        ${actionHtml || ''}
      </div>`;
  }

  function formatCount(n) {
    const v = Number(n) || 0;
    if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(v);
  }

  function updateStoreStats(list) {
    const host = $('#store-stats');
    if (!host) return;
    const tagSet = new Set();
    let installs = 0;
    (list || []).forEach((p) => {
      (p.tags || []).forEach((t) => tagSet.add(t));
      installs += Number(p.installCount || 0);
    });
    const set = (key, val) => {
      const el = host.querySelector(`[data-stat="${key}"]`);
      if (el) el.textContent = val;
    };
    set('count', formatCount(list.length));
    set('tags', formatCount(tagSet.size));
    set('installs', formatCount(installs));
    host.hidden = false;
    LOG('store stats', { count: list.length, tags: tagSet.size, installs });
  }

  // ---- store home ----
  async function pageIndex() {
    const grid = $('#plugin-grid');
    const empty = $('#empty-state');
    if (!grid) return;

    const qInput = $('#search-q');
    const tagSelect = $('#filter-tag');

    async function refresh() {
      grid.innerHTML = skeletonCards(6);
      if (empty) empty.style.display = 'none';
      try {
        const params = new URLSearchParams({ public: '1' });
        const q = qInput && qInput.value.trim();
        const tag = tagSelect && tagSelect.value;
        if (q) params.set('q', q);
        if (tag) params.set('tag', tag);
        const data = await api('/apps/api/plugins?' + params.toString());
        const list = (data.plugins || []).filter((p) => p.status === 'approved');
        LOG('store list', list.length);
        if (!q && !tag) updateStoreStats(list);
        if (!list.length) {
          grid.innerHTML = '';
          if (empty) {
            empty.style.display = 'block';
            const titleEl = empty.querySelector('.blora-empty__title');
            const descEl = empty.querySelector('.blora-empty__desc');
            if (titleEl) titleEl.textContent = q || tag ? '没有匹配的插件' : '暂无已上架插件';
            if (descEl) descEl.textContent = q || tag ? '试试其他关键词' : '登录后可提交插件';
          }
          return;
        }
        if (empty) empty.style.display = 'none';
        grid.innerHTML = list.map(cardHtml).join('');
        LOG('rendered cards', list.length);

        if (tagSelect && tagSelect.options.length <= 1) {
          const tagSet = new Set();
          list.forEach((p) => (p.tags || []).forEach((t) => tagSet.add(t)));
          [...tagSet].sort().forEach((t) => {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            tagSelect.appendChild(opt);
          });
        }
      } catch (e) {
        LOG_ERR(e);
        grid.innerHTML = `
          <div class="blora-alert blora-alert--danger" style="grid-column:1/-1">
            <span class="blora-alert__icon">!</span>
            <div class="blora-alert__body">
              <div class="blora-alert__title">加载失败</div>
              <div class="blora-alert__desc">${escapeHtml(e.message)}</div>
            </div>
          </div>`;
      }
    }

    let t;
    if (qInput) {
      qInput.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(refresh, 280);
      });
    }
    if (tagSelect) tagSelect.addEventListener('change', refresh);
    await refresh();
  }

  // Cache last loaded plugin for locale re-render without refetch when possible
  let lastDetailPlugin = null;
  let lastRatingsPayload = null;

  function distributionBarsHtml(distribution, total) {
    const dist = distribution || {};
    const tot = total || Object.values(dist).reduce((a, b) => a + Number(b || 0), 0) || 0;
    let html = '<div class="apps-rating-bars">';
    for (let s = 5; s >= 1; s--) {
      const c = Number(dist[s] || 0);
      const pct = tot ? Math.round((c / tot) * 100) : 0;
      html += `<div class="apps-rating-bar">
        <span>${s}</span>
        <div class="apps-rating-bar__track"><div class="apps-rating-bar__fill" style="width:${pct}%"></div></div>
        <span>${pct}%</span>
      </div>`;
    }
    html += '</div>';
    return html;
  }

  function replyItemHtml(reply) {
    const canDelete =
      currentUser &&
      (currentUser.username === reply.username || currentUser.admin);
    return `<div class="apps-review-reply" data-reply-id="${escapeHtml(reply.id)}">
      <div class="apps-review-reply__head">
        <span class="apps-review-reply__user">${escapeHtml(reply.nickname || reply.username)}</span>
        <span class="apps-review-reply__time">${escapeHtml(formatDate(reply.createdAt))}</span>
        ${
          canDelete
            ? `<button type="button" class="blora-btn blora-btn--ghost blora-btn--sm" data-delete-reply="${escapeHtml(reply.id)}">${escapeHtml(t('deleteReply'))}</button>`
            : ''
        }
      </div>
      <div class="apps-review-reply__body">${escapeHtml(reply.body)}</div>
    </div>`;
  }

  function repliesBlockHtml(rating) {
    const replies = Array.isArray(rating.replies) ? rating.replies : [];
    const list =
      replies.length > 0
        ? replies.map(replyItemHtml).join('')
        : '';
    const replyBtn = currentUser
      ? `<button type="button" class="blora-btn blora-btn--ghost blora-btn--sm" data-toggle-reply="${escapeHtml(rating.username)}">${escapeHtml(t('reply'))}</button>`
      : `<a class="blora-btn blora-btn--ghost blora-btn--sm" href="${escapeHtml(loginUrl(location.pathname))}">${escapeHtml(t('replyLogin'))}</a>`;
    const form = currentUser
      ? `<form class="apps-review-reply-form" data-reply-form="${escapeHtml(rating.username)}">
          <textarea class="blora-textarea" rows="2" maxlength="500" placeholder="${escapeHtml(t('replyPh'))}" data-reply-body></textarea>
          <div class="blora-row blora-row--tight">
            <button type="submit" class="blora-btn blora-btn--primary blora-btn--sm">${escapeHtml(t('submitReply'))}</button>
            <button type="button" class="blora-btn blora-btn--ghost blora-btn--sm" data-cancel-reply="${escapeHtml(rating.username)}">${escapeHtml(t('cancelReply'))}</button>
          </div>
        </form>`
      : '';
    return `<div class="apps-review-item__actions">${replyBtn}${
      replies.length
        ? `<span class="blora-text-muted" style="font-size:var(--blora-text-xs)">${escapeHtml(t('repliesCount', { n: replies.length }))}</span>`
        : ''
    }</div>
    ${form}
    ${replies.length ? `<div class="apps-review-replies">${list}</div>` : ''}`;
  }

  function reviewsListHtml(ratings) {
    if (!ratings || !ratings.length) {
      return `<p class="blora-text-muted">${escapeHtml(t('noRatings'))}</p>`;
    }
    return `<div class="apps-review-list">${ratings
      .map((r) => {
        const body = r.comment
          ? `<div class="apps-review-item__body">${escapeHtml(r.comment)}</div>`
          : '';
        return `<article class="apps-review-item" data-rating-user="${escapeHtml(r.username)}">
          <div class="apps-review-item__head">
            <span class="apps-review-item__user">${escapeHtml(r.nickname || r.username)}</span>
            ${rateWidgetHtml(r.stars, true)}
            <span class="apps-review-item__time">${escapeHtml(formatDate(r.updatedAt || r.createdAt))}</span>
          </div>
          ${body}
          ${repliesBlockHtml(r)}
        </article>`;
      })
      .join('')}</div>`;
  }

  function screenshotsHtml(shots) {
    if (!shots || !shots.length) return '';
    const items = shots
      .map((shot, i) => {
        const full = shotUrl(shot, false);
        const thumb = shotUrl(shot, true) || full;
        return `<button type="button" class="apps-shots__item" data-shot-index="${i}" data-full="${escapeHtml(full)}">
          <img src="${escapeHtml(thumb)}" alt="" loading="lazy" />
        </button>`;
      })
      .join('');
    return `<section class="apps-shots" aria-label="${escapeHtml(t('screenshots'))}">
      <h2 class="apps-shots__title">${escapeHtml(t('screenshots'))}</h2>
      <div class="apps-shots__scroller">${items}</div>
    </section>`;
  }

  function openLightbox(src) {
    let box = document.getElementById('apps-lightbox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'apps-lightbox';
      box.className = 'apps-lightbox';
      box.hidden = true;
      box.innerHTML = `
        <button type="button" class="blora-btn blora-btn--ghost apps-lightbox__close" data-lightbox-close>${escapeHtml(t('lightboxClose'))}</button>
        <img alt="" />`;
      document.body.appendChild(box);
      box.addEventListener('click', (ev) => {
        if (ev.target === box || ev.target.closest('[data-lightbox-close]')) {
          box.hidden = true;
          box.querySelector('img').removeAttribute('src');
        }
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && box && !box.hidden) {
          box.hidden = true;
        }
      });
    }
    const img = box.querySelector('img');
    img.src = src;
    box.hidden = false;
  }

  function bindDetailInteractions(root, p) {
    $all('[data-full]', root).forEach((btn) => {
      btn.addEventListener('click', () => {
        const full = btn.getAttribute('data-full');
        if (full) openLightbox(full);
      });
    });

    const installBtn = $('#btn-install-launcher', root);
    if (installBtn) {
      installBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (installBtn.dataset.busy === '1') return;
        installBtn.dataset.busy = '1';
        const tip = $('#install-tip', root);
        if (tip) tip.textContent = t('installOpening');
        toast(t('installOpening'), 'info');
        try {
          const result = await installToBloretLauncher(p);
          if (result.path === 'localhost') {
            if (tip) tip.textContent = t('installProposed');
            toast(t('installProposed'), 'success');
          } else {
            if (tip) tip.textContent = t('installOpening');
            setTimeout(() => {
              if (tip) tip.textContent = t('installFallback');
              toast(t('installFallback'), 'info');
            }, 2500);
          }
        } catch (e) {
          LOG_ERR('install failed', e);
          if (tip) tip.textContent = e.message || t('installNeedDownload');
          toast(e.message || t('installNeedDownload'), 'danger');
        } finally {
          installBtn.dataset.busy = '0';
        }
      });
    }

    const flutterBtn = $('#btn-install-blora-launcher', root);
    if (flutterBtn) {
      flutterBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        if (flutterBtn.disabled || flutterBtn.dataset.busy === '1') return;
        flutterBtn.dataset.busy = '1';
        const tip = $('#install-tip', root);
        if (tip) tip.textContent = t('flutterInstallOpening');
        toast(t('flutterInstallOpening'), 'info');
        try {
          const result = await installToBloraLauncherFlutter(p);
          if (result.path === 'localhost') {
            if (tip) tip.textContent = t('flutterInstallProposed');
            toast(t('flutterInstallProposed'), 'success');
          }
        } catch (e) {
          LOG_ERR('flutter install failed', e);
          if (tip) tip.textContent = e.message || t('flutterInstallNotFound');
          toast(e.message || t('flutterInstallNotFound'), 'danger');
        } finally {
          flutterBtn.dataset.busy = '0';
        }
      });
    }

    const form = $('#rating-form', root);
    if (form) {
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const rateEl = $('#rating-input', root);
        const stars = rateEl ? Number(rateEl.dataset.value || 0) : 0;
        const comment = ($('#rating-comment', root) || {}).value || '';
        if (!stars) {
          toast(t('yourRating'), 'warning');
          return;
        }
        try {
          const result = await api('/apps/api/plugins/' + encodeURIComponent(p.id) + '/ratings', {
            method: 'PUT',
            body: { stars, comment }
          });
          toast(t('ratingThanks'), 'success');
          if (lastDetailPlugin && lastDetailPlugin.id === p.id) {
            lastDetailPlugin.ratingAvg = result.ratingAvg;
            lastDetailPlugin.ratingCount = result.ratingCount;
            lastDetailPlugin.myRating = result.rating;
          }
          lastRatingsPayload = null;
          await pagePlugin({ silent: false });
        } catch (e) {
          LOG_ERR('rating submit', e);
          toast(e.message || t('uploadFail'), 'danger');
        }
      });
    }

    const delBtn = $('#btn-delete-rating', root);
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        try {
          const result = await api('/apps/api/plugins/' + encodeURIComponent(p.id) + '/ratings', {
            method: 'DELETE'
          });
          if (lastDetailPlugin && lastDetailPlugin.id === p.id) {
            lastDetailPlugin.ratingAvg = result.ratingAvg;
            lastDetailPlugin.ratingCount = result.ratingCount;
            lastDetailPlugin.myRating = null;
          }
          lastRatingsPayload = null;
          toast(t('deleteRating'), 'info');
          await pagePlugin({ silent: false });
        } catch (e) {
          toast(e.message || t('uploadFail'), 'danger');
        }
      });
    }

    function findReplyForm(ratingUser) {
      return $all('[data-reply-form]', root).find(
        (el) => el.getAttribute('data-reply-form') === ratingUser
      );
    }

    $all('[data-toggle-reply]', root).forEach((btn) => {
      btn.addEventListener('click', () => {
        const user = btn.getAttribute('data-toggle-reply');
        const form = findReplyForm(user);
        if (!form) return;
        form.classList.add('is-open');
        const ta = form.querySelector('[data-reply-body]');
        if (ta) ta.focus();
      });
    });

    $all('[data-cancel-reply]', root).forEach((btn) => {
      btn.addEventListener('click', () => {
        const user = btn.getAttribute('data-cancel-reply');
        const form = findReplyForm(user);
        if (!form) return;
        form.classList.remove('is-open');
        const ta = form.querySelector('[data-reply-body]');
        if (ta) ta.value = '';
      });
    });

    $all('[data-reply-form]', root).forEach((form) => {
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const ratingUser = form.getAttribute('data-reply-form');
        const ta = form.querySelector('[data-reply-body]');
        const body = (ta && ta.value) || '';
        if (!String(body).trim()) {
          toast(t('replyPh'), 'warning');
          return;
        }
        try {
          await api(
            '/apps/api/plugins/' +
              encodeURIComponent(p.id) +
              '/ratings/' +
              encodeURIComponent(ratingUser) +
              '/replies',
            { method: 'POST', body: { body: String(body).trim() } }
          );
          toast(t('replyThanks'), 'success');
          lastRatingsPayload = null;
          await pagePlugin({ silent: false });
        } catch (e) {
          LOG_ERR('reply submit', e);
          toast(e.message || t('uploadFail'), 'danger');
        }
      });
    });

    $all('[data-delete-reply]', root).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const replyId = btn.getAttribute('data-delete-reply');
        if (!replyId) return;
        try {
          await api(
            '/apps/api/plugins/' +
              encodeURIComponent(p.id) +
              '/ratings/replies/' +
              encodeURIComponent(replyId),
            { method: 'DELETE' }
          );
          toast(t('deleteReply'), 'info');
          lastRatingsPayload = null;
          await pagePlugin({ silent: false });
        } catch (e) {
          toast(e.message || t('uploadFail'), 'danger');
        }
      });
    });

    if (window.Blora && Blora.init) Blora.init(root);
  }

  // ---- detail ----
  async function pagePlugin(opts) {
    const root = $('#plugin-detail');
    if (!root) return;

    const id = root.dataset.pluginId || decodeURIComponent(location.pathname.split('/').pop() || '');
    LOG('detail id=', id, 'silent=', !!(opts && opts.silent));

    try {
      let p = lastDetailPlugin;
      if (!p || p.id !== id || !(opts && opts.silent)) {
        const data = await api(
          '/apps/api/plugins/' + encodeURIComponent(id) + '?include=related'
        );
        p = data.plugin;
        lastDetailPlugin = p;
      }

      let ratingsData = lastRatingsPayload;
      if (!ratingsData || ratingsData.pluginId !== id || !(opts && opts.silent)) {
        try {
          ratingsData = await api('/apps/api/plugins/' + encodeURIComponent(id) + '/ratings?limit=20');
          ratingsData.pluginId = id;
          lastRatingsPayload = ratingsData;
        } catch (e) {
          LOG_ERR('ratings load', e);
          ratingsData = {
            avg: p.ratingAvg || 0,
            count: p.ratingCount || 0,
            distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
            ratings: [],
            myRating: p.myRating || null
          };
        }
      }

      const origin = window.location.origin;
      const installLinkApi = `${origin}/apps/api/plugins/${encodeURIComponent(p.id)}/install-link`;
      const bloretInstallUrl = buildBloretInstallUrl(p);
      const manifestApi = `${origin}/apps/api/plugins/${encodeURIComponent(p.id)}/manifest.json`;
      const flutterInstallUrl = buildBloraFlutterInstallUrl(p);
      const isFlutter = p.pluginType === 'flutter';
      const isManifestOnly = isFlutter && !p.download;
      const canOneClick =
        p.status === 'approved' && p.download && String(p.download).startsWith('https://');
      const flutterCanInstall =
        p.status === 'approved' &&
        (isManifestOnly ? !!p.manifest : p.download && String(p.download).startsWith('https://'));

      const perms = p.permissions || [];
      const permHtml = permissionsListHtml(perms);
      const shots = p.screenshots || [];
      const related = p.related || [];
      const avg = Number(ratingsData.avg != null ? ratingsData.avg : p.ratingAvg) || 0;
      const count = Number(ratingsData.count != null ? ratingsData.count : p.ratingCount) || 0;
      const my = ratingsData.myRating || p.myRating || null;

      const crumb = $('#crumb-name');
      if (crumb) crumb.textContent = p.name || t('detail');
      document.title = `${p.name} · ${t('titleSuffix')}`;

      const installActions =
        p.status === 'approved'
          ? isFlutter
            ? `<div class="apps-detail-hero__actions">
                ${
                  flutterCanInstall
                    ? `<button type="button" class="blora-btn blora-btn--primary" id="btn-install-blora-launcher">${escapeHtml(t('installBloraLauncher'))}</button>`
                    : `<button type="button" class="blora-btn blora-btn--primary" id="btn-install-blora-launcher" disabled title="${escapeHtml(t('installNeedHttps'))}">${escapeHtml(t('installBloraLauncher'))}</button>`
                }
                <a class="blora-btn blora-btn--outline" href="${escapeHtml(isManifestOnly ? manifestApi : p.download)}" target="_blank" rel="noopener">${escapeHtml(isManifestOnly ? t('dlManifest') : t('downloadZip'))}</a>
                <p class="blora-hint" id="install-tip" style="margin:var(--blora-space-2) 0 0;text-align:center">${escapeHtml(t('flutterAwakeNote'))}</p>
              </div>`
            : `<div class="apps-detail-hero__actions">
                ${
                  canOneClick
                    ? `<button type="button" class="blora-btn blora-btn--primary" id="btn-install-launcher">${escapeHtml(t('installLauncher'))}</button>`
                    : `<button type="button" class="blora-btn blora-btn--primary" disabled title="${escapeHtml(t('installNeedHttps'))}">${escapeHtml(t('installLauncher'))}</button>`
                }
                <a class="blora-btn blora-btn--outline" href="${escapeHtml(p.download || '#')}" target="_blank" rel="noopener">${escapeHtml(t('downloadZip'))}</a>
                <p class="blora-hint" id="install-tip" style="margin:var(--blora-space-2) 0 0;text-align:center">${escapeHtml(t('installHint'))}</p>
              </div>`
          : `<div class="apps-detail-hero__actions">
              <p class="blora-text-muted">${escapeHtml(t('statusPrefix'))}${statusTag(p.status)}${escapeHtml(t('statusSuffix'))}</p>
            </div>`;

      const writeForm =
        p.status !== 'approved'
          ? ''
          : currentUser
            ? `<form class="apps-review-form" id="rating-form">
                <div class="blora-label">${escapeHtml(my ? t('updateRating') : t('writeReview'))}</div>
                <div style="margin:var(--blora-space-2) 0">${rateWidgetHtml(my ? my.stars : 0, false, 'rating-input')}</div>
                <textarea class="blora-textarea" id="rating-comment" rows="3" maxlength="500" placeholder="${escapeHtml(t('ratingCommentPh'))}">${escapeHtml(my && my.comment ? my.comment : '')}</textarea>
                <div class="blora-row blora-row--tight" style="margin-top:var(--blora-space-3)">
                  <button type="submit" class="blora-btn blora-btn--primary blora-btn--sm">${escapeHtml(my ? t('updateRating') : t('submitRating'))}</button>
                  ${my ? `<button type="button" class="blora-btn blora-btn--ghost blora-btn--sm" id="btn-delete-rating">${escapeHtml(t('deleteRating'))}</button>` : ''}
                </div>
              </form>`
            : `<div class="apps-review-form">
                <p class="blora-text-muted">${escapeHtml(t('ratingLogin'))}</p>
                <a class="blora-btn blora-btn--primary blora-btn--sm" style="margin-top:var(--blora-space-3)" href="${escapeHtml(loginUrl(location.pathname))}">${escapeHtml(t('login'))}</a>
              </div>`;

      const longDesc = (p.longDescription || '').trim();
      const relatedHtml = related.length
        ? `<section class="apps-related">
            <h2 class="apps-related__title">${escapeHtml(t('related'))}</h2>
            <div class="apps-related__grid">${related.map(cardHtml).join('')}</div>
          </section>`
        : '';

      root.innerHTML = `
        <div class="apps-detail-page">
          <header class="apps-detail-hero">
            <div class="apps-detail-hero__main">
              ${iconBlock(p, 'hero')}
              <div style="min-width:0">
                <h1 class="blora-h1 apps-detail-hero__title">${escapeHtml(p.name)}</h1>
                <div class="apps-detail-hero__sub">
                  ${escapeHtml(p.authorNickname || p.author || p.authorUsername || '')}
                  · v${escapeHtml(p.version)}
                  · ${escapeHtml(p.id)}
                </div>
                <div class="apps-detail-hero__rating">
                  ${starsInlineHtml(avg, { count })}
                  <span>· ${formatCount(p.installCount || 0)} ${escapeHtml(t('installsShort'))}</span>
                </div>
                <div class="apps-plugin-card__tags">
                  ${tagsHtml(p)}
                  ${isFlutter ? `<span class="apps-detail-hero__type">${escapeHtml(t('flutterTag'))}</span>` : ''}
                  ${p.status !== 'approved' ? statusTag(p.status) : ''}
                  ${p.hasPendingUpdate ? updatePendingTag() : ''}
                </div>
                ${
                  p.hasPendingUpdate &&
                  currentUser &&
                  (currentUser.admin || currentUser.username === p.authorUsername)
                    ? `<div class="blora-alert blora-alert--info" style="margin-top:var(--blora-space-3)">
                        <div class="blora-alert__body">
                          <div class="blora-alert__desc">${escapeHtml(t('pendingUpdateBanner'))}
                            <a href="${isFlutter ? '/apps/submit-flutter' : '/apps/submit'}?edit=${encodeURIComponent(p.id)}" style="margin-left:var(--blora-space-2)">${escapeHtml(t('editPlugin'))}</a>
                          </div>
                        </div>
                      </div>`
                    : ''
                }
              </div>
            </div>
            ${installActions}
          </header>

          ${
            p.rejectReason
              ? `<div class="blora-alert blora-alert--danger" style="margin-bottom:var(--blora-space-5)">
                  <span class="blora-alert__icon">!</span>
                  <div class="blora-alert__body">
                    <div class="blora-alert__title">${escapeHtml(t('rejectTitle'))}</div>
                    <div class="blora-alert__desc">${escapeHtml(p.rejectReason)}</div>
                  </div>
                </div>`
              : ''
          }

          ${screenshotsHtml(shots)}

          <div class="apps-detail-body">
            <div class="apps-detail-main">
              <section class="apps-detail-section">
                <h2 class="apps-detail-section__title">${escapeHtml(t('about'))}</h2>
                <div class="apps-detail-prose">${escapeHtml(p.description || t('noDescription'))}</div>
              </section>
              ${
                longDesc
                  ? `<section class="apps-detail-section">
                      <h2 class="apps-detail-section__title">${escapeHtml(t('longDescription'))}</h2>
                      <div class="apps-detail-prose">${escapeHtml(longDesc)}</div>
                    </section>`
                  : ''
              }
              <section class="apps-detail-section">
                <h2 class="apps-detail-section__title">${escapeHtml(t('ratings'))}</h2>
                <div class="apps-rating-panel">
                  <div class="apps-rating-summary">
                    <div class="apps-rating-summary__avg">${count ? avg.toFixed(1) : '—'}</div>
                    <div style="display:flex;justify-content:center;margin-top:var(--blora-space-2)">${rateWidgetHtml(avg, true)}</div>
                    <div class="apps-rating-summary__count">${escapeHtml(t('ratingsCount', { n: formatCount(count) }))}</div>
                    ${distributionBarsHtml(ratingsData.distribution, count)}
                  </div>
                  <div>
                    ${writeForm}
                    ${reviewsListHtml(ratingsData.ratings)}
                  </div>
                </div>
              </section>
              <section class="apps-detail-section">
                <h2 class="apps-detail-section__title">${escapeHtml(t('permissions'))}</h2>
                ${permHtml}
              </section>
            </div>

            <aside class="apps-detail-aside blora-stack">
              <div class="blora-card">
                <h3 class="blora-card__title">${escapeHtml(t('info'))}</h3>
                <div class="blora-card__body">
                  <ul class="apps-info-list">
                    <li><span class="apps-info-list__k">${escapeHtml(t('version'))}</span><span class="apps-info-list__v">${escapeHtml(p.version)}</span></li>
                    <li><span class="apps-info-list__k">${escapeHtml(t('author'))}</span><span class="apps-info-list__v">${escapeHtml(p.authorNickname || p.author || p.authorUsername || '—')}</span></li>
                    <li><span class="apps-info-list__k">${escapeHtml(t('updatedAt'))}</span><span class="apps-info-list__v">${escapeHtml(formatDate(p.updatedAt))}</span></li>
                    <li><span class="apps-info-list__k">${escapeHtml(t('installClicks'))}</span><span class="apps-info-list__v">${formatCount(p.installCount || 0)}</span></li>
                    <li><span class="apps-info-list__k">${escapeHtml(t('permCount'))}</span><span class="apps-info-list__v">${formatCount(perms.length)}</span></li>
                    <li><span class="apps-info-list__k">${escapeHtml(t('rating'))}</span><span class="apps-info-list__v">${count ? avg.toFixed(1) + ' / 5' : '—'}</span></li>
                  </ul>
                  ${
                    p.url
                      ? `<a class="blora-btn blora-btn--outline blora-btn--sm" style="margin-top:var(--blora-space-4);width:100%;justify-content:center" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(t('homepage'))}</a>`
                      : ''
                  }
                  ${
                    p.status === 'approved'
                      ? isFlutter
                        ? `<p class="blora-hint" style="margin-top:var(--blora-space-4)">${escapeHtml(t('flutterAwakeNote'))}</p>
                           ${
                             !isManifestOnly && p.sha256
                               ? `<p class="apps-manifest-url" style="margin-top:var(--blora-space-2);font-size:var(--blora-text-xs);word-break:break-all"><span class="apps-info-list__k">${escapeHtml(t('sha256'))}</span> <code>${escapeHtml(p.sha256)}</code></p>`
                               : ''
                           }
                           <p class="apps-flutter-meta">${escapeHtml(t('flutterWakeLink'))}：<code style="word-break:break-all">${escapeHtml(flutterInstallUrl)}</code></p>
                           <p class="apps-manifest-url" style="margin-top:var(--blora-space-2);font-size:var(--blora-text-xs);word-break:break-all">${escapeHtml(t('manifest'))}：<a href="${escapeHtml(isManifestOnly ? manifestApi : p.download)}" target="_blank" rel="noopener">${escapeHtml(isManifestOnly ? manifestApi : p.download)}</a></p>`
                        : `<p class="blora-hint" style="margin-top:var(--blora-space-4)">${escapeHtml(t('installHint'))}</p>
                           ${
                             p.sha256
                               ? `<p class="apps-manifest-url" style="margin-top:var(--blora-space-2);font-size:var(--blora-text-xs);word-break:break-all"><span class="apps-info-list__k">${escapeHtml(t('sha256'))}</span> <code>${escapeHtml(p.sha256)}</code></p>`
                               : ''
                           }
                           ${
                             canOneClick
                               ? `<p class="apps-manifest-url" style="margin-top:var(--blora-space-2);font-size:var(--blora-text-xs);word-break:break-all">${escapeHtml(t('manifest'))}：<a href="${escapeHtml(installLinkApi)}" target="_blank" rel="noopener">${escapeHtml(installLinkApi)}</a></p>
                                  <p class="apps-manifest-url" style="margin-top:var(--blora-space-2);font-size:var(--blora-text-xs);word-break:break-all;opacity:.85"><code style="user-select:all">${escapeHtml(bloretInstallUrl)}</code></p>`
                               : `<p class="blora-hint" style="margin-top:var(--blora-space-2)">${escapeHtml(t('installNeedHttps'))}</p>`
                           }`
                      : ''
                  }
                </div>
              </div>
            </aside>
          </div>

          ${relatedHtml}
        </div>
      `;

      bindDetailInteractions(root, p);
      LOG('detail rendered', p.id, 'locale=', I18n ? I18n.getLocale() : '-');
    } catch (e) {
      LOG_ERR(e);
      root.innerHTML = `
        <div class="blora-result blora-result--error">
          <div class="blora-result__icon">×</div>
          <div class="blora-result__title">${escapeHtml(t('loadError'))}</div>
          <div class="blora-result__desc">${escapeHtml(e.message)}</div>
          <a class="blora-btn blora-btn--outline" href="/apps" style="margin-top:var(--blora-space-4)">${escapeHtml(t('backStore'))}</a>
        </div>`;
    }
  }

  function renderSubmitPermChecks(permHost) {
    if (!permHost) return;
    const checked = new Set(
      $all('input[name="perm"]:checked', permHost).map((el) => el.value)
    );
    permHost.innerHTML = ALL_PERMS.map((p) => {
      const risk = isHighRiskPerm(p) || HIGH_RISK_PERMS.has(p);
      const meta =
        I18n && typeof I18n.permMeta === 'function'
          ? I18n.permMeta(p)
          : { name: p, use: '' };
      const isOn = checked.has(p);
      return `<label class="blora-checkbox apps-perm-check ${risk ? 'is-risk' : ''}" title="${escapeHtml(meta.use || '')}">
          <input type="checkbox" name="perm" value="${escapeHtml(p)}" ${isOn ? 'checked' : ''} />
          <span class="blora-checkbox__box"></span>
          <span class="apps-perm-check__text">
            <span class="apps-perm-check__id">${escapeHtml(p)}</span>
            <span class="apps-perm-check__name">${escapeHtml(meta.name)}${risk ? ` · ${escapeHtml(t('highRisk'))}` : ''}</span>
          </span>
        </label>`;
    }).join('');
    LOG('submit perm checks rendered', ALL_PERMS.length, 'locale=', I18n ? I18n.getLocale() : '-');
  }

  function refreshSubmitPermLabels() {
    const permHost = $('#perm-checks');
    if (permHost) renderSubmitPermChecks(permHost);
  }

  /**
   * Parse plugin.json / manifest.json and map to store form fields.
   * @param {string} raw
   * @param {{ overwrite?: boolean, label?: string }} [opts]
   * @returns {{ filled: string[], warnings: string[], manifest: object }}
   */
  function applyPluginJsonToForm(raw, opts) {
    const options = opts || {};
    const overwrite = options.overwrite !== false;
    const label = options.label || 'plugin.json';
    let text = String(raw || '').trim();
    if (!text) throw new Error('请粘贴 ' + label + ' 内容或选择文件');

    // strip UTF-8 BOM
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch (e) {
      throw new Error('JSON 解析失败：' + (e.message || '格式无效'));
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(label + ' 根节点必须是对象');
    }

    const filled = [];
    const warnings = [];

    function setInput(id, value, label) {
      const el = document.getElementById(id);
      if (!el) return;
      const next = value == null ? '' : String(value).trim();
      if (!next) return;
      if (!overwrite && el.value && el.value.trim()) return;
      el.value = next;
      filled.push(label || id);
      if (id === 'field-icon') {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    // Common aliases from plugin.json / packaging tooling
    const id = manifest.id || manifest.plugin_id || manifest.pluginId;
    const name = manifest.name || manifest.title || manifest.displayName;
    const version = manifest.version || manifest.ver;
    const author =
      manifest.author ||
      manifest.master ||
      (manifest.authors && Array.isArray(manifest.authors) ? manifest.authors.join(', ') : '') ||
      manifest.developer;
    const description =
      manifest.description || manifest.summary || manifest.desc || manifest.about || '';
    const longDescription =
      manifest.longDescription ||
      manifest.long_description ||
      manifest.readme ||
      manifest.details ||
      '';

    setInput('field-id', id, 'id');
    setInput('field-name', name, 'name');
    setInput('field-version', version, 'version');
    setInput('field-author', author, 'author');
    setInput('field-description', description, 'description');
    setInput('field-long-description', longDescription, 'longDescription');

    // Optional store-ish fields if authors put them in plugin.json
    const download = manifest.download || manifest.zip || manifest.package || manifest.url_zip;
    const homepage = manifest.homepage || manifest.url || manifest.repo || manifest.repository || manifest.home;
    const icon = manifest.icon || manifest.iconUrl || manifest.icon_url || manifest.logo;
    const sha256 = manifest.sha256 || manifest.sha || manifest.hash;
    setInput('field-download', download, 'download');
    // homepage goes to field-url; if download already used url, prefer homepage keys only
    if (homepage && homepage !== download) setInput('field-url', homepage, 'url');
    setInput('field-icon', icon, 'icon');
    setInput('field-sha256', sha256, 'sha256');

    // tags
    let tags = manifest.tags || manifest.categories || manifest.category;
    if (typeof tags === 'string') tags = tags.split(/[,，\s]+/).filter(Boolean);
    if (Array.isArray(tags) && tags.length) {
      setInput('field-tags', tags.map((t) => String(t).trim()).filter(Boolean).join(', '), 'tags');
    }

    // permissions
    let perms = manifest.permissions || manifest.permission || [];
    if (typeof perms === 'string') {
      perms = perms.split(/[,，\s]+/).filter(Boolean);
    }
    if (!Array.isArray(perms)) perms = [];
    perms = perms.map((p) => String(p).trim()).filter(Boolean);

    const permHost = $('#perm-checks');
    if (permHost) {
      // ensure boxes exist
      renderSubmitPermChecks(permHost);
      const known = new Set(ALL_PERMS);
      const unknown = [];
      $all('input[name="perm"]', permHost).forEach((el) => {
        el.checked = perms.includes(el.value);
      });
      perms.forEach((p) => {
        if (!known.has(p)) unknown.push(p);
      });
      if (perms.length) filled.push('permissions(' + perms.length + ')');
      if (unknown.length) {
        warnings.push('未知权限（商店未列出，仍会提交）：' + unknown.join(', '));
      }
    }

    if (!id) warnings.push('manifest 缺少 id');
    if (!name) warnings.push('manifest 缺少 name');
    if (!version) warnings.push('manifest 缺少 version');
    if (!filled.length) warnings.push('未识别到可填充字段');

    // keep raw JSON pretty in textarea
    const ta = $('#field-plugin-json');
    if (ta) {
      try {
        ta.value = JSON.stringify(manifest, null, 2);
      } catch (_) {}
    }

    return { filled, warnings, manifest };
  }

  // ---- submit ----
  async function pageSubmit() {
    const form = $('#submit-form');
    if (!form) return;

    const editParams = new URLSearchParams(location.search);
    const editId = (editParams.get('edit') || '').trim();
    let editMode = false;
    let editPluginLive = null;

    if (!currentUser) {
      LOG('submit requires login — show gate, no hard redirect');
      form.style.display = 'none';
      const gate = document.createElement('div');
      gate.className = 'blora-result blora-result--info';
      const returnPath = editId
        ? '/apps/submit?edit=' + encodeURIComponent(editId)
        : '/apps/submit';
      gate.innerHTML = `
        <div class="blora-result__icon">i</div>
        <div class="blora-result__title">请先登录</div>
        <div class="blora-result__desc">提交插件需要 Bloret PassPort 账号。</div>
        <div class="blora-row" style="margin-top:var(--blora-space-5);justify-content:center">
          <a class="blora-btn blora-btn--primary" href="${escapeHtml(loginUrl(returnPath))}">PassPort 登录</a>
          <a class="blora-btn blora-btn--outline" href="/apps">返回商店</a>
        </div>`;
      form.parentNode.insertBefore(gate, form);
      return;
    }

    const authorInput = $('#field-author');
    if (authorInput && !authorInput.value) authorInput.value = currentUser.nickname || currentUser.username;

    const permHost = $('#perm-checks');
    if (permHost) {
      renderSubmitPermChecks(permHost);
    }

    function setPluginJsonStatus(msg, kind) {
      const el = $('#plugin-json-status');
      if (!el) return;
      el.textContent = msg || '';
      el.style.color =
        kind === 'danger'
          ? 'var(--blora-danger)'
          : kind === 'success'
            ? 'var(--blora-moss, var(--blora-seal))'
            : '';
    }

    function runApplyPluginJson(raw) {
      try {
        const result = applyPluginJsonToForm(raw, { overwrite: true });
        const msg =
          '已填充：' +
          (result.filled.length ? result.filled.join(', ') : '无') +
          (result.warnings.length ? ' · ' + result.warnings.join('；') : '');
        setPluginJsonStatus(msg, result.warnings.length && !result.filled.length ? 'danger' : 'success');
        toast(
          result.filled.length ? '已从 plugin.json 填充表单' : '未能填充字段',
          result.filled.length ? 'success' : 'warning'
        );
        LOG('plugin.json applied', result.filled, result.warnings);
        return result;
      } catch (e) {
        LOG_ERR('plugin.json apply failed', e);
        setPluginJsonStatus(e.message || '导入失败', 'danger');
        toast(e.message || '导入失败', 'danger');
        return null;
      }
    }

    const applyJsonBtn = $('#btn-apply-plugin-json');
    if (applyJsonBtn) {
      applyJsonBtn.addEventListener('click', () => {
        const raw = ($('#field-plugin-json') || {}).value || '';
        runApplyPluginJson(raw);
      });
    }

    const clearJsonBtn = $('#btn-clear-plugin-json');
    if (clearJsonBtn) {
      clearJsonBtn.addEventListener('click', () => {
        const ta = $('#field-plugin-json');
        if (ta) ta.value = '';
        setPluginJsonStatus('');
      });
    }

    const jsonFile = $('#field-plugin-json-file');
    if (jsonFile) {
      jsonFile.addEventListener('change', async () => {
        const file = jsonFile.files && jsonFile.files[0];
        jsonFile.value = '';
        if (!file) return;
        try {
          const text = await file.text();
          const ta = $('#field-plugin-json');
          if (ta) ta.value = text;
          setPluginJsonStatus('已读取 ' + file.name + '，正在填充…');
          runApplyPluginJson(text);
        } catch (e) {
          setPluginJsonStatus(e.message || '读取文件失败', 'danger');
          toast(e.message || '读取文件失败', 'danger');
        }
      });
    }

    /** @type {{url:string,webpUrl?:string}[]} */
    let submitShots = [];

    function renderIconPreview(url) {
      const prev = $('#icon-preview');
      if (!prev) return;
      if (url) {
        prev.style.backgroundImage = `url("${url.replace(/"/g, '\"')}")`;
      } else {
        prev.style.backgroundImage = '';
      }
    }

    async function loadEditPlugin() {
      if (!editId) return false;
      try {
        const data = await api('/apps/api/plugins/' + encodeURIComponent(editId));
        const p = data.plugin;
        if (!p) throw new Error(t('editLoadFail'));
        if (
          !currentUser.admin &&
          p.authorUsername &&
          p.authorUsername !== currentUser.username
        ) {
          throw new Error(t('editNotOwner'));
        }
        editMode = true;
        editPluginLive = p;
        const src = p.pendingUpdate
          ? { ...p, ...p.pendingUpdate, id: p.id }
          : p;
        fillFormFromPlugin(src);
        const idField = $('#field-id');
        if (idField) {
          idField.readOnly = true;
          idField.setAttribute('aria-readonly', 'true');
        }
        submitShots = Array.isArray(src.screenshots)
          ? src.screenshots.map((s) =>
              typeof s === 'string'
                ? { url: s, webpUrl: '' }
                : { url: s.url || '', webpUrl: s.webpUrl || '' }
            )
          : [];
        renderShotsEditor();
        renderIconPreview(src.icon || '');

        const title = $('#submit-title');
        const kicker = $('#submit-kicker');
        const lead = $('#submit-lead');
        const btn = $('#submit-btn');
        const meta = $('#submit-meta');
        if (kicker) kicker.textContent = 'Edit';
        if (title) title.textContent = t('publishUpdate');
        if (lead) {
          if (p.status === 'approved') {
            lead.textContent = t('liveVersionStays') + ' 审核期间可继续修改。';
          } else {
            lead.textContent = '修改后将重新进入审核；审核期间可继续修改。';
          }
        }
        if (btn) btn.textContent = t('editAndResubmit');
        if (meta) {
          meta.innerHTML =
            pluginStatusTags(p) +
            (p.hasPendingUpdate
              ? ` <span class="blora-tag">${escapeHtml(t('draftVsLive'))}</span>`
              : '');
        }
        document.title = `${t('publishUpdate')} · ${p.id}`;
        LOG('edit mode loaded', p.id, 'hasPending=', !!p.hasPendingUpdate);
        return true;
      } catch (e) {
        LOG_ERR('edit load failed', e);
        form.style.display = 'none';
        const err = document.createElement('div');
        err.className = 'blora-result blora-result--warning';
        err.innerHTML = `
          <div class="blora-result__icon">!</div>
          <div class="blora-result__title">${escapeHtml(t('editLoadFail'))}</div>
          <div class="blora-result__desc">${escapeHtml(e.message || '')}</div>
          <div class="blora-row" style="margin-top:var(--blora-space-5);justify-content:center">
            <a class="blora-btn blora-btn--primary" href="/apps/mine">${escapeHtml(t('mine'))}</a>
            <a class="blora-btn blora-btn--outline" href="/apps/submit">${escapeHtml(t('submit'))}</a>
          </div>`;
        form.parentNode.insertBefore(err, form);
        return false;
      }
    }

    function renderShotsEditor() {
      const host = $('#shots-editor');
      if (!host) return;
      if (!submitShots.length) {
        host.innerHTML = `<p class="blora-text-muted" style="grid-column:1/-1">${escapeHtml(t('noScreenshots'))}</p>`;
        return;
      }
      host.innerHTML = submitShots
        .map((shot, i) => {
          const thumb = shotUrl(shot, true) || shot.url;
          return `<div class="apps-shot-chip" data-shot-i="${i}">
            <div class="apps-shot-chip__img" style="background-image:url('${escapeHtml(thumb)}')"></div>
            <div class="apps-shot-chip__actions">
              <button type="button" class="blora-btn blora-btn--ghost blora-btn--sm" data-shot-up ${i === 0 ? 'disabled' : ''}>${escapeHtml(t('moveUp'))}</button>
              <button type="button" class="blora-btn blora-btn--ghost blora-btn--sm" data-shot-down ${i === submitShots.length - 1 ? 'disabled' : ''}>${escapeHtml(t('moveDown'))}</button>
              <button type="button" class="blora-btn blora-btn--outline blora-btn--sm" data-shot-remove>${escapeHtml(t('removeShot'))}</button>
            </div>
          </div>`;
        })
        .join('');

      $all('[data-shot-i]', host).forEach((chip) => {
        const i = Number(chip.getAttribute('data-shot-i'));
        const up = chip.querySelector('[data-shot-up]');
        const down = chip.querySelector('[data-shot-down]');
        const rem = chip.querySelector('[data-shot-remove]');
        if (up) {
          up.addEventListener('click', () => {
            if (i <= 0) return;
            const tmp = submitShots[i - 1];
            submitShots[i - 1] = submitShots[i];
            submitShots[i] = tmp;
            renderShotsEditor();
          });
        }
        if (down) {
          down.addEventListener('click', () => {
            if (i >= submitShots.length - 1) return;
            const tmp = submitShots[i + 1];
            submitShots[i + 1] = submitShots[i];
            submitShots[i] = tmp;
            renderShotsEditor();
          });
        }
        if (rem) {
          rem.addEventListener('click', () => {
            submitShots.splice(i, 1);
            renderShotsEditor();
          });
        }
      });
    }

    renderShotsEditor();

    // Load existing plugin when ?edit=<id>
    if (editId) {
      const ok = await loadEditPlugin();
      if (!ok) return;
    }

    const iconInput = $('#field-icon');
    if (iconInput) {
      iconInput.addEventListener('input', () => renderIconPreview(iconInput.value.trim()));
      renderIconPreview(iconInput.value.trim());
    }

    const iconFile = $('#field-icon-file');
    if (iconFile) {
      iconFile.addEventListener('change', async () => {
        const file = iconFile.files && iconFile.files[0];
        iconFile.value = '';
        if (!file) return;
        const status = $('#icon-upload-status');
        if (status) status.textContent = t('uploading');
        try {
          const data = await uploadImageFile(file);
          if (iconInput) iconInput.value = data.url;
          renderIconPreview(data.url);
          if (status) status.textContent = t('uploadOk');
          toast(t('uploadOk'), 'success');
        } catch (e) {
          LOG_ERR('icon upload', e);
          if (status) status.textContent = e.message || t('uploadFail');
          toast(e.message || t('uploadFail'), 'danger');
        }
      });
    }

    const shotsFile = $('#field-shots-file');
    if (shotsFile) {
      shotsFile.addEventListener('change', async () => {
        const files = shotsFile.files ? Array.from(shotsFile.files) : [];
        shotsFile.value = '';
        if (!files.length) return;
        const status = $('#shots-upload-status');
        const room = 8 - submitShots.length;
        if (room <= 0) {
          toast(t('maxShots'), 'warning');
          return;
        }
        const batch = files.slice(0, room);
        if (status) status.textContent = t('uploading');
        try {
          for (const file of batch) {
            const data = await uploadImageFile(file);
            submitShots.push({ url: data.url, webpUrl: data.webpUrl || '' });
          }
          renderShotsEditor();
          if (status) status.textContent = t('uploadOk');
          toast(t('uploadOk'), 'success');
        } catch (e) {
          LOG_ERR('shots upload', e);
          if (status) status.textContent = e.message || t('uploadFail');
          toast(e.message || t('uploadFail'), 'danger');
        }
      });
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const msg = $('#form-msg');
      const msgText = $('#form-msg-text');
      const perms = $all('input[name="perm"]:checked').map((el) => el.value);
      const body = {
        name: $('#field-name').value.trim(),
        version: $('#field-version').value.trim(),
        author: $('#field-author').value.trim(),
        description: $('#field-description').value.trim(),
        longDescription: ($('#field-long-description') || {}).value
          ? $('#field-long-description').value.trim()
          : '',
        download: $('#field-download').value.trim(),
        sha256: ($('#field-sha256') || {}).value ? $('#field-sha256').value.trim() : '',
        url: $('#field-url').value.trim(),
        icon: $('#field-icon').value.trim(),
        tags: $('#field-tags').value.trim(),
        permissions: perms,
        screenshots: submitShots
      };
      if (!editMode) {
        body.id = $('#field-id').value.trim();
      }
      LOG(editMode ? 'update payload' : 'submit payload', body);
      try {
        let data;
        if (editMode) {
          const id = editId || $('#field-id').value.trim();
          data = await api('/apps/api/plugins/' + encodeURIComponent(id), {
            method: 'PATCH',
            body
          });
          const wasApproved =
            (editPluginLive && editPluginLive.status === 'approved') ||
            (data.plugin && data.plugin.status === 'approved');
          const okMsg = wasApproved ? t('updateSubmitted') : t('resubmitOk');
          if (msg && msgText) {
            msg.style.display = 'flex';
            msg.className = 'blora-alert blora-alert--success';
            msgText.textContent = okMsg;
          }
          toast(okMsg, 'success');
          editPluginLive = data.plugin;
          if (data.plugin) {
            const meta = $('#submit-meta');
            if (meta) meta.innerHTML = pluginStatusTags(data.plugin);
          }
        } else {
          data = await api('/apps/api/plugins', { method: 'POST', body });
          if (msg && msgText) {
            msg.style.display = 'flex';
            msg.className = 'blora-alert blora-alert--success';
            msgText.textContent = `已提交 ${data.plugin.id}，状态 pending，等待管理员审核。`;
          }
          toast('提交成功，等待审核', 'success');
          form.reset();
          submitShots = [];
          renderShotsEditor();
          renderIconPreview('');
          if (authorInput) authorInput.value = currentUser.nickname || currentUser.username;
          if (permHost) {
            $all('input[name="perm"]', permHost).forEach((el) => {
              el.checked = false;
            });
          }
        }
      } catch (e) {
        LOG_ERR('submit failed', e);
        if (msg && msgText) {
          msg.style.display = 'flex';
          msg.className = 'blora-alert blora-alert--danger';
          msgText.textContent = e.message || '提交失败';
        }
        toast(e.message || '提交失败', 'danger');
      }
    });
  }

  // ---- flutter submit ----
  async function pageFlutterSubmit() {
    const form = $('#submit-form');
    if (!form) return;

    const editParams = new URLSearchParams(location.search);
    const editId = (editParams.get('edit') || '').trim();
    let editMode = false;
    let editPluginLive = null;
    let submitMode = 'zip';

    if (!currentUser) {
      LOG('flutter submit requires login — show gate, no hard redirect');
      form.style.display = 'none';
      const gate = document.createElement('div');
      gate.className = 'blora-result blora-result--info';
      const returnPath = editId
        ? '/apps/submit-flutter?edit=' + encodeURIComponent(editId)
        : '/apps/submit-flutter';
      gate.innerHTML = `
        <div class="blora-result__icon">i</div>
        <div class="blora-result__title">请先登录</div>
        <div class="blora-result__desc">提交 Flutter 版插件需要 Bloret PassPort 账号。</div>
        <div class="blora-row" style="margin-top:var(--blora-space-5);justify-content:center">
          <a class="blora-btn blora-btn--primary" href="${escapeHtml(loginUrl(returnPath))}">PassPort 登录</a>
          <a class="blora-btn blora-btn--outline" href="/apps">返回商店</a>
        </div>`;
      form.parentNode.insertBefore(gate, form);
      return;
    }

    const authorInput = $('#field-author');
    if (authorInput && !authorInput.value) authorInput.value = currentUser.nickname || currentUser.username;

    const permHost = $('#perm-checks');
    if (permHost) renderSubmitPermChecks(permHost);

    const switchHost = $('#submit-mode-switch');
    const distDownload = $('#distribution-download');
    const distSection = $('#distribution-section');
    const importTitle = $('#manifest-import-title');
    const importHint = $('#manifest-import-hint');
    const switchHint = $('#submit-mode-hint');
    const manifestSection = $('#manifest-import-section');

    function setSwitchMode(mode, emit) {
      submitMode = mode === 'manifest' ? 'manifest' : 'zip';
      const items = $all('.apps-switch__item', switchHost);
      items.forEach((it) => {
        const active = it.getAttribute('data-mode') === submitMode;
        it.classList.toggle('is-active', active);
        it.setAttribute('aria-selected', String(active));
      });
      moveSwitchIndicator(items.find((it) => it.getAttribute('data-mode') === submitMode));
      applyModeVisibility();
      if (emit !== false) {
        const hint = $('#submit-mode-hint');
        if (hint) hint.textContent = t(submitMode === 'manifest' ? 'manifestOnlyHint' : 'importFromManifestHint');
      }
    }

    function moveSwitchIndicator(activeItem) {
      if (!switchHost) return;
      const indicator = switchHost.querySelector('.apps-switch__indicator');
      if (!indicator || !activeItem) return;
      const sRect = switchHost.getBoundingClientRect();
      const iRect = activeItem.getBoundingClientRect();
      indicator.style.left = iRect.left - sRect.left + 'px';
      indicator.style.width = iRect.width + 'px';
    }

    function applyModeVisibility() {
      const manifestOnly = submitMode === 'manifest';
      if (distDownload) distDownload[manifestOnly ? 'setAttribute' : 'removeAttribute']('hidden', '');
      if (importTitle) importTitle.textContent = t(manifestOnly ? 'manifestOnlySection' : 'importFromManifest');
      if (importHint) importHint.innerHTML = t(manifestOnly ? 'manifestOnlyHint' : 'importFromManifestHint');
      if (manifestSection) manifestSection.classList.toggle('apps-form__section--manifest', manifestOnly);
    }

    function setPluginJsonStatus(msg, kind) {
      const el = $('#plugin-json-status');
      if (!el) return;
      el.textContent = msg || '';
      el.style.color =
        kind === 'danger'
          ? 'var(--blora-danger)'
          : kind === 'success'
            ? 'var(--blora-moss, var(--blora-seal))'
            : '';
    }

    function runApplyPluginJson(raw) {
      try {
        const result = applyPluginJsonToForm(raw, { overwrite: true, label: 'manifest.json' });
        const msg =
          '已填充：' +
          (result.filled.length ? result.filled.join(', ') : '无') +
          (result.warnings.length ? ' · ' + result.warnings.join('；') : '');
        setPluginJsonStatus(msg, result.warnings.length && !result.filled.length ? 'danger' : 'success');
        toast(
          result.filled.length ? '已从 manifest.json 填充表单' : '未能填充字段',
          result.filled.length ? 'success' : 'warning'
        );
        LOG('manifest.json applied', result.filled, result.warnings);
        return result;
      } catch (e) {
        LOG_ERR('manifest.json apply failed', e);
        setPluginJsonStatus(e.message || '导入失败', 'danger');
        toast(e.message || '导入失败', 'danger');
        return null;
      }
    }

    const applyJsonBtn = $('#btn-apply-plugin-json');
    if (applyJsonBtn) {
      applyJsonBtn.addEventListener('click', () => {
        const raw = ($('#field-plugin-json') || {}).value || '';
        runApplyPluginJson(raw);
      });
    }

    const clearJsonBtn = $('#btn-clear-plugin-json');
    if (clearJsonBtn) {
      clearJsonBtn.addEventListener('click', () => {
        const ta = $('#field-plugin-json');
        if (ta) ta.value = '';
        setPluginJsonStatus('');
      });
    }

    const jsonFile = $('#field-plugin-json-file');
    if (jsonFile) {
      jsonFile.addEventListener('change', async () => {
        const file = jsonFile.files && jsonFile.files[0];
        jsonFile.value = '';
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
          setPluginJsonStatus(t('manifestTooLarge'), 'danger');
          toast(t('manifestTooLarge'), 'danger');
          return;
        }
        try {
          const text = await file.text();
          const ta = $('#field-plugin-json');
          if (ta) ta.value = text;
          setPluginJsonStatus('已读取 ' + file.name + '，正在填充…');
          runApplyPluginJson(text);
        } catch (e) {
          setPluginJsonStatus(e.message || '读取文件失败', 'danger');
          toast(e.message || '读取文件失败', 'danger');
        }
      });
    }

    /** @type {{url:string,webpUrl?:string}[]} */
    let submitShots = [];

    function renderIconPreview(url) {
      const prev = $('#icon-preview');
      if (!prev) return;
      if (url) {
        prev.style.backgroundImage = `url("${url.replace(/"/g, '\"')}")`;
      } else {
        prev.style.backgroundImage = '';
      }
    }

    async function loadEditPlugin() {
      if (!editId) return false;
      try {
        const data = await api('/apps/api/plugins/' + encodeURIComponent(editId));
        const p = data.plugin;
        if (!p) throw new Error(t('editLoadFail'));
        if (!currentUser.admin && p.authorUsername && p.authorUsername !== currentUser.username) {
          throw new Error(t('editNotOwner'));
        }
        editMode = true;
        editPluginLive = p;
        const src = p.pendingUpdate ? { ...p, ...p.pendingUpdate, id: p.id } : p;
        fillFormFromPlugin(src);
        const idField = $('#field-id');
        if (idField) {
          idField.readOnly = true;
          idField.setAttribute('aria-readonly', 'true');
        }
        submitShots = Array.isArray(src.screenshots)
          ? src.screenshots.map((s) =>
              typeof s === 'string'
                ? { url: s, webpUrl: '' }
                : { url: s.url || '', webpUrl: s.webpUrl || '' }
            )
          : [];
        renderShotsEditor();
        renderIconPreview(src.icon || '');

        // 依据提交方式还原开关与 manifest 内容
        const manifestOnly = !(src.download || '') && !!src.manifest;
        setSwitchMode(manifestOnly ? 'manifest' : 'zip');
        const ta = $('#field-plugin-json');
        if (ta) ta.value = src.manifest || '';

        const title = $('#submit-title');
        const kicker = $('#submit-kicker');
        const lead = $('#submit-lead');
        const btn = $('#submit-btn');
        const meta = $('#submit-meta');
        if (kicker) kicker.textContent = 'EDIT - FLUTTER';
        if (title) title.textContent = t('flutterSubmitEditTitle');
        if (lead) {
          if (p.status === 'approved') {
            lead.textContent = t('liveVersionStays') + ' 审核期间可继续修改。';
          } else {
            lead.textContent = '修改后将重新进入审核；审核期间可继续修改。';
          }
        }
        if (btn) btn.textContent = t('editAndResubmit');
        if (meta) {
          meta.innerHTML =
            pluginStatusTags(p) +
            (p.hasPendingUpdate
              ? ` <span class="blora-tag">${escapeHtml(t('draftVsLive'))}</span>`
              : '');
        }
        document.title = `${t('flutterSubmitEditTitle')} · ${p.id}`;
        LOG('flutter edit mode loaded', p.id, 'mode=', submitMode, 'hasPending=', !!p.hasPendingUpdate);
        return true;
      } catch (e) {
        LOG_ERR('flutter edit load failed', e);
        form.style.display = 'none';
        const err = document.createElement('div');
        err.className = 'blora-result blora-result--warning';
        err.innerHTML = `
          <div class="blora-result__icon">!</div>
          <div class="blora-result__title">${escapeHtml(t('editLoadFail'))}</div>
          <div class="blora-result__desc">${escapeHtml(e.message || '')}</div>
          <div class="blora-row" style="margin-top:var(--blora-space-5);justify-content:center">
            <a class="blora-btn blora-btn--primary" href="/apps/mine">${escapeHtml(t('mine'))}</a>
            <a class="blora-btn blora-btn--outline" href="/apps/submit-flutter">${escapeHtml(t('submitFlutter'))}</a>
          </div>`;
        form.parentNode.insertBefore(err, form);
        return false;
      }
    }

    function renderShotsEditor() {
      const host = $('#shots-editor');
      if (!host) return;
      if (!submitShots.length) {
        host.innerHTML = `<p class="blora-text-muted" style="grid-column:1/-1">${escapeHtml(t('noScreenshots'))}</p>`;
        return;
      }
      host.innerHTML = submitShots
        .map((shot, i) => {
          const thumb = shotUrl(shot, true) || shot.url;
          return `<div class="apps-shot-chip" data-shot-i="${i}">
            <div class="apps-shot-chip__img" style="background-image:url('${escapeHtml(thumb)}')"></div>
            <div class="apps-shot-chip__actions">
              <button type="button" class="blora-btn blora-btn--ghost blora-btn--sm" data-shot-up ${i === 0 ? 'disabled' : ''}>${escapeHtml(t('moveUp'))}</button>
              <button type="button" class="blora-btn blora-btn--ghost blora-btn--sm" data-shot-down ${i === submitShots.length - 1 ? 'disabled' : ''}>${escapeHtml(t('moveDown'))}</button>
              <button type="button" class="blora-btn blora-btn--outline blora-btn--sm" data-shot-remove>${escapeHtml(t('removeShot'))}</button>
            </div>
          </div>`;
        })
        .join('');

      $all('[data-shot-i]', host).forEach((chip) => {
        const i = Number(chip.getAttribute('data-shot-i'));
        const up = chip.querySelector('[data-shot-up]');
        const down = chip.querySelector('[data-shot-down]');
        const rem = chip.querySelector('[data-shot-remove]');
        if (up) {
          up.addEventListener('click', () => {
            if (i <= 0) return;
            const tmp = submitShots[i - 1];
            submitShots[i - 1] = submitShots[i];
            submitShots[i] = tmp;
            renderShotsEditor();
          });
        }
        if (down) {
          down.addEventListener('click', () => {
            if (i >= submitShots.length - 1) return;
            const tmp = submitShots[i + 1];
            submitShots[i + 1] = submitShots[i];
            submitShots[i] = tmp;
            renderShotsEditor();
          });
        }
        if (rem) {
          rem.addEventListener('click', () => {
            submitShots.splice(i, 1);
            renderShotsEditor();
          });
        }
      });
    }

    // bind switch
    if (switchHost) {
      const items = $all('.apps-switch__item', switchHost);
      items.forEach((it) => {
        it.addEventListener('click', () => {
          if (it.getAttribute('data-mode') === submitMode) return;
          setSwitchMode(it.getAttribute('data-mode'), true);
        });
      });
      // init indicator after layout
      requestAnimationFrame(() => moveSwitchIndicator(items.find((x) => x.getAttribute('data-mode') === submitMode)));
      applyModeVisibility();
      if (switchHint) switchHint.textContent = t('importFromManifestHint');
    }

    renderShotsEditor();
    applyModeVisibility();

    if (editId) {
      const ok = await loadEditPlugin();
      if (!ok) return;
    } else {
      if (switchHint) switchHint.textContent = t('importFromManifestHint');
    }

    const iconInput = $('#field-icon');
    if (iconInput) {
      iconInput.addEventListener('input', () => renderIconPreview(iconInput.value.trim()));
      renderIconPreview(iconInput.value.trim());
    }

    const iconFile = $('#field-icon-file');
    if (iconFile) {
      iconFile.addEventListener('change', async () => {
        const file = iconFile.files && iconFile.files[0];
        iconFile.value = '';
        if (!file) return;
        const status = $('#icon-upload-status');
        if (status) status.textContent = t('uploading');
        try {
          const data = await uploadImageFile(file);
          if (iconInput) iconInput.value = data.url;
          renderIconPreview(data.url);
          if (status) status.textContent = t('uploadOk');
          toast(t('uploadOk'), 'success');
        } catch (e) {
          LOG_ERR('icon upload', e);
          if (status) status.textContent = e.message || t('uploadFail');
          toast(e.message || t('uploadFail'), 'danger');
        }
      });
    }

    const shotsFile = $('#field-shots-file');
    if (shotsFile) {
      shotsFile.addEventListener('change', async () => {
        const files = shotsFile.files ? Array.from(shotsFile.files) : [];
        shotsFile.value = '';
        if (!files.length) return;
        const status = $('#shots-upload-status');
        const room = 8 - submitShots.length;
        if (room <= 0) {
          toast(t('maxShots'), 'warning');
          return;
        }
        const batch = files.slice(0, room);
        if (status) status.textContent = t('uploading');
        try {
          for (const file of batch) {
            const data = await uploadImageFile(file);
            submitShots.push({ url: data.url, webpUrl: data.webpUrl || '' });
          }
          renderShotsEditor();
          if (status) status.textContent = t('uploadOk');
          toast(t('uploadOk'), 'success');
        } catch (e) {
          LOG_ERR('shots upload', e);
          if (status) status.textContent = e.message || t('uploadFail');
          toast(e.message || t('uploadFail'), 'danger');
        }
      });
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const msg = $('#form-msg');
      const msgText = $('#form-msg-text');
      const perms = $all('input[name="perm"]:checked').map((el) => el.value);
      const body = {
        pluginType: 'flutter',
        submitMode,
        name: $('#field-name').value.trim(),
        version: $('#field-version').value.trim(),
        author: $('#field-author').value.trim(),
        description: $('#field-description').value.trim(),
        longDescription: ($('#field-long-description') || {}).value
          ? $('#field-long-description').value.trim()
          : '',
        url: $('#field-url').value.trim(),
        icon: $('#field-icon').value.trim(),
        tags: $('#field-tags').value.trim(),
        permissions: perms,
        screenshots: submitShots
      };
      if (submitMode === 'manifest') {
        const manifestContent = ($('#field-plugin-json') || {}).value || '';
        if (!manifestContent.trim()) {
          toast(t('manifestMissing'), 'danger');
          return;
        }
        if (new Blob([manifestContent]).size > 5 * 1024 * 1024) {
          toast(t('manifestTooLarge'), 'danger');
          return;
        }
        body.manifest = manifestContent;
      } else {
        body.download = $('#field-download').value.trim();
        body.sha256 = ($('#field-sha256') || {}).value ? $('#field-sha256').value.trim() : '';
      }
      if (!editMode) {
        body.id = $('#field-id').value.trim();
      }
      LOG('flutter submit payload', submitMode, body);
      try {
        let data;
        if (editMode) {
          const id = editId || $('#field-id').value.trim();
          data = await api('/apps/api/plugins/' + encodeURIComponent(id), {
            method: 'PATCH',
            body
          });
          const wasApproved =
            (editPluginLive && editPluginLive.status === 'approved') ||
            (data.plugin && data.plugin.status === 'approved');
          const okMsg = wasApproved ? t('updateSubmitted') : t('resubmitOk');
          if (msg && msgText) {
            msg.style.display = 'flex';
            msg.className = 'blora-alert blora-alert--success';
            msgText.textContent = okMsg;
          }
          toast(okMsg, 'success');
          editPluginLive = data.plugin;
          if (data.plugin) {
            const meta = $('#submit-meta');
            if (meta) meta.innerHTML = pluginStatusTags(data.plugin);
          }
        } else {
          data = await api('/apps/api/plugins', { method: 'POST', body });
          if (msg && msgText) {
            msg.style.display = 'flex';
            msg.className = 'blora-alert blora-alert--success';
            msgText.textContent = `已提交 ${data.plugin.id}，状态 pending，等待管理员审核。`;
          }
          toast(t('flutterSubmitOk'), 'success');
          form.reset();
          submitShots = [];
          renderShotsEditor();
          renderIconPreview('');
          if (authorInput) authorInput.value = currentUser.nickname || currentUser.username;
          if (permHost) {
            $all('input[name="perm"]', permHost).forEach((el) => {
              el.checked = false;
            });
          }
          if (switchHint) switchHint.textContent = t('importFromManifestHint');
        }
      } catch (e) {
        LOG_ERR('flutter submit failed', e);
        if (msg && msgText) {
          msg.style.display = 'flex';
          msg.className = 'blora-alert blora-alert--danger';
          msgText.textContent = e.message || '提交失败';
        }
        toast(e.message || '提交失败', 'danger');
      }
    });
  }

  // ---- mine ----
  async function pageMine() {
    const host = $('#mine-list');
    if (!host) return;

    if (!currentUser) {
      host.innerHTML = emptyHtml(
        '尚未登录',
        '登录后可查看你的提交',
        `<a class="blora-btn blora-btn--primary" style="margin-top:var(--blora-space-4)" href="${escapeHtml(loginUrl('/apps/mine'))}">PassPort 登录</a>`
      );
      return;
    }

    try {
      const data = await api('/apps/api/plugins?scope=mine');
      const list = data.plugins || [];
      LOG('mine', list.length);
      if (!list.length) {
        host.innerHTML = emptyHtml(
          '暂无提交',
          '你还没有提交过插件',
          `<a class="blora-btn blora-btn--primary" style="margin-top:var(--blora-space-4)" href="/apps/submit">去提交</a>`
        );
        return;
      }
      host.innerHTML = list
        .map(
          (p) => `
        <article class="apps-list-card">
          <div>
            <h3 class="apps-list-card__title">${escapeHtml(p.name)}</h3>
            <div class="apps-list-card__id">${escapeHtml(p.id)} · v${escapeHtml(p.version)}${
              p.hasPendingUpdate && p.pendingUpdate && p.pendingUpdate.version
                ? ` → <span title="${escapeHtml(t('draftVersion'))}">v${escapeHtml(p.pendingUpdate.version)}</span>`
                : ''
            }</div>
            ${
              p.rejectReason
                ? `<p class="apps-list-card__desc" style="color:var(--blora-danger)">${escapeHtml(p.rejectReason)}</p>`
                : p.description
                  ? `<p class="apps-list-card__desc">${escapeHtml(p.description.slice(0, 120))}</p>`
                  : ''
            }
            <div class="apps-list-card__meta">
              ${pluginStatusTags(p)}
              <span class="blora-text-muted" style="font-size:var(--blora-text-xs)">${escapeHtml((p.updatedAt || '').replace('T', ' ').slice(0, 19))}</span>
            </div>
          </div>
          <div class="apps-list-card__side">
            <a class="blora-btn blora-btn--primary blora-btn--sm" href="${p.pluginType === 'flutter' ? '/apps/submit-flutter' : '/apps/submit'}?edit=${encodeURIComponent(p.id)}">${escapeHtml(t('editPlugin'))}</a>
            <a class="blora-btn blora-btn--outline blora-btn--sm" href="/apps/plugin/${encodeURIComponent(p.id)}">查看</a>
          </div>
        </article>`
        )
        .join('');
      LOG('mine cards rendered', list.length);
    } catch (e) {
      LOG_ERR(e);
      host.innerHTML = `
        <div class="blora-alert blora-alert--danger">
          <span class="blora-alert__icon">!</span>
          <div class="blora-alert__body"><div class="blora-alert__desc">${escapeHtml(e.message)}</div></div>
        </div>`;
    }
  }

  // ---- admin ----
  async function pageAdmin() {
    const host = $('#admin-list');
    if (!host) return;

    if (!currentUser) {
      host.innerHTML = emptyHtml(
        '尚未登录',
        '管理员请先登录',
        `<a class="blora-btn blora-btn--primary" style="margin-top:var(--blora-space-4)" href="${escapeHtml(loginUrl('/apps/admin'))}">PassPort 登录</a>`
      );
      return;
    }
    if (!currentUser.admin) {
      host.innerHTML = `
        <div class="blora-result blora-result--warning">
          <div class="blora-result__icon">!</div>
          <div class="blora-result__title">需要管理员权限</div>
          <div class="blora-result__desc">PassPort admin 或 config.passport.adminUsernames</div>
        </div>`;
      return;
    }

    let allList = [];
    let statusFilter = '';
    const filterBar = $('#admin-filter-bar');
    const statsHost = $('#admin-stats');
    const filterHost = $('#admin-status-filter');

    function updateAdminStats(list) {
      if (!statsHost) return;
      let pending = 0;
      let approved = 0;
      let rejected = 0;
      list.forEach((p) => {
        if (p.status === 'rejected') rejected += 1;
        else if (p.status === 'pending') pending += 1;
        else if (p.status === 'approved') {
          approved += 1;
          if (p.hasPendingUpdate) pending += 1;
        }
      });
      const set = (key, val) => {
        const el = statsHost.querySelector(`[data-stat="${key}"]`);
        if (el) el.textContent = formatCount(val);
      };
      set('pending', pending);
      set('approved', approved);
      set('rejected', rejected);
      statsHost.hidden = false;
      LOG('admin stats', { pending, approved, rejected });
    }

    function renderAdminList() {
      let list;
      if (statusFilter === 'pending') {
        list = allList.filter((p) => p.status === 'pending' || p.hasPendingUpdate);
      } else if (statusFilter) {
        list = allList.filter((p) => p.status === statusFilter);
      } else {
        list = allList;
      }
      LOG('admin filter', statusFilter || 'all', list.length);
      if (!list.length) {
        host.innerHTML = emptyHtml(
          statusFilter ? '该状态下暂无插件' : '暂无插件记录',
          statusFilter ? '试试其他筛选' : '还没有用户提交插件'
        );
        return;
      }
      host.innerHTML = list
        .map((p) => {
          const draft = p.pendingUpdate;
          const draftBlock =
            draft && p.hasPendingUpdate
              ? `<div class="apps-list-card__desc" style="margin-top:var(--blora-space-2)">
                  <strong>${escapeHtml(t('draftVsLive'))}</strong>：
                  ${escapeHtml(t('liveVersion'))} v${escapeHtml(p.version)}
                  → ${escapeHtml(t('draftVersion'))} v${escapeHtml(draft.version || '—')}
                  ${
                    draft.download && draft.download !== p.download
                      ? `<br/><span class="blora-text-muted">download 已变更</span>`
                      : ''
                  }
                  ${
                    draft.name && draft.name !== p.name
                      ? `<br/><span class="blora-text-muted">名称：${escapeHtml(p.name)} → ${escapeHtml(draft.name)}</span>`
                      : ''
                  }
                </div>`
              : '';
          const needsReview = p.status === 'pending' || p.hasPendingUpdate;
          return `
        <article class="apps-list-card" data-id="${escapeHtml(p.id)}">
          <div>
            <h3 class="apps-list-card__title">${escapeHtml(
              draft && draft.name ? draft.name : p.name
            )}</h3>
            <div class="apps-list-card__id">${escapeHtml(p.id)} · v${escapeHtml(p.version)} · ${escapeHtml(p.authorNickname || p.author || p.authorUsername || '')}</div>
            <p class="apps-list-card__desc">${escapeHtml(
              ((draft && draft.description) || p.description || '暂无简介').slice(0, 140)
            )}</p>
            ${draftBlock}
            <div class="apps-list-card__meta">
              ${pluginStatusTags(p)}
              ${
                p.status === 'pending' && !p.hasPendingUpdate
                  ? `<span class="blora-tag blora-tag--gold">${escapeHtml(t('firstPending'))}</span>`
                  : ''
              }
              ${((draft && draft.permissions) || p.permissions || [])
                .slice(0, 4)
                .map(
                  (x) =>
                    `<span class="blora-tag ${HIGH_RISK_PERMS.has(x) ? 'blora-tag--gold' : ''}">${escapeHtml(x)}</span>`
                )
                .join('')}
              ${
                ((draft && draft.permissions) || p.permissions || []).length > 4
                  ? `<span class="blora-tag">+${((draft && draft.permissions) || p.permissions || []).length - 4}</span>`
                  : ''
              }
            </div>
            <div class="apps-list-card__meta">
              ${
                (draft && draft.download) || p.download
                  ? `<a href="${escapeHtml((draft && draft.download) || p.download)}" target="_blank" rel="noopener" class="blora-btn blora-btn--ghost blora-btn--sm">ZIP</a>`
                  : `<a href="/apps/api/plugins/${encodeURIComponent(p.id)}/manifest.json" target="_blank" rel="noopener" class="blora-btn blora-btn--ghost blora-btn--sm">${escapeHtml(t('dlManifest'))}</a>`
              }
              <a href="/apps/plugin/${encodeURIComponent(p.id)}" class="blora-btn blora-btn--ghost blora-btn--sm">详情</a>
            </div>
          </div>
          <div class="apps-list-card__side">
            <div class="apps-table-actions">
              ${
                needsReview || p.status !== 'approved'
                  ? `<button type="button" class="blora-btn blora-btn--primary blora-btn--sm" data-action="approve">通过</button>`
                  : ''
              }
              ${
                needsReview || p.status !== 'rejected'
                  ? `<button type="button" class="blora-btn blora-btn--danger blora-btn--sm" data-action="reject">拒绝</button>`
                  : ''
              }
            </div>
          </div>
        </article>`;
        })
        .join('');

      host.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const card = btn.closest('[data-id]');
          const id = card && card.dataset.id;
          const action = btn.dataset.action;
          let reason = '';
          if (action === 'reject') {
            reason = window.prompt('拒绝原因（可选）', '') || '';
          }
          try {
            LOG('review', action, id);
            btn.disabled = true;
            await api('/apps/api/plugins/' + encodeURIComponent(id) + '/review', {
              method: 'POST',
              body: { action, reason }
            });
            toast(action === 'approve' ? '已通过' : '已拒绝', action === 'approve' ? 'success' : 'warning');
            await refresh();
          } catch (e) {
            LOG_ERR(e);
            toast(e.message, 'danger');
            btn.disabled = false;
          }
        });
      });
    }

    if (filterHost) {
      filterHost.querySelectorAll('[data-status]').forEach((item) => {
        item.addEventListener('click', () => {
          statusFilter = item.dataset.status || '';
          filterHost.querySelectorAll('[data-status]').forEach((el) => {
            el.classList.toggle('is-active', el === item);
          });
          LOG('admin status filter change', statusFilter || 'all');
          renderAdminList();
        });
      });
    }

    async function refresh() {
      try {
        const data = await api('/apps/api/plugins?scope=admin');
        allList = data.plugins || [];
        LOG('admin list', allList.length);
        updateAdminStats(allList);
        if (filterBar) filterBar.hidden = !allList.length;
        renderAdminList();
      } catch (e) {
        LOG_ERR(e);
        host.innerHTML = `
          <div class="blora-alert blora-alert--danger">
            <span class="blora-alert__icon">!</span>
            <div class="blora-alert__body"><div class="blora-alert__desc">${escapeHtml(e.message)}</div></div>
          </div>`;
      }
    }

    await refresh();
  }

  function handleAuthQuery() {
    const params = new URLSearchParams(location.search);
    const auth = params.get('auth');
    if (!auth) return;
    if (auth === 'ok') toast('登录成功', 'success');
    if (auth === 'denied') toast('已取消授权', 'warning');
    if (auth === 'error') toast('登录失败，请检查 PassPort 配置', 'danger');
    if (auth === 'logout') toast('已退出', 'info');
    params.delete('auth');
    const qs = params.toString();
    const clean = location.pathname + (qs ? '?' + qs : '') + location.hash;
    window.history.replaceState({}, '', clean);
  }

  async function init() {
    LOG('init page=', document.body.dataset.page, location.pathname, 'locale=', I18n ? I18n.getLocale() : '-');
    if (window.Blora && Blora.configure) {
      Blora.configure(window.BloraConfig || {});
    }
    ensureStudioTheme();
    if (I18n) I18n.setLocale(I18n.getLocale());
    applyStaticI18n();
    await loadMe();
    renderNav();
    handleAuthQuery();

    const page = document.body.dataset.page;
    if (page === 'index') await pageIndex();
    else if (page === 'plugin') await pagePlugin();
    else if (page === 'submit') await pageSubmit();
    else if (page === 'submit-flutter') await pageFlutterSubmit();
    else if (page === 'mine') await pageMine();
    else if (page === 'admin') await pageAdmin();

    if (window.Blora && Blora.init) {
      Blora.init(document.body);
    }
    // Re-assert Studio after Blora boot (in case localStorage had another theme)
    ensureStudioTheme();
    applyStaticI18n();
    bindLocaleToggle(document);
  }

  window.BloretApps = {
    api,
    loadMe,
    HIGH_RISK_PERMS,
    I18n,
    buildBloretInstallUrl,
    buildBloraFlutterInstallUrl,
    get user() {
      return currentUser;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
