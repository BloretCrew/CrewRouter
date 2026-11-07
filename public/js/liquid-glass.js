/* 晶液 Liquid — behaviour layer for CrewRouter.
 * Optics copied from BloraDesign3-ARCHIVE/themes/skins/liquid/liquid.js:
 *  · Wallpaper: the product's 青灰 composition as inline SVG, coloured by --wp-*.
 *  · Lens refraction: per-element SVG displacement maps used as backdrop-filter.
 *    Only Chromium renders url() filters inside backdrop-filter; other engines keep
 *    the CSS blur fallback declared in liquid-glass.css.
 *  · Liquid indicators: the selection droplet stretches along its direction of travel.
 * Geometry sync copied from BloraDesign3-ARCHIVE/themes/core/scaffold.js#updateIndicator.
 */
(() => {
  'use strict';
  const ROOT = document.documentElement;
  const NS = 'http://www.w3.org/2000/svg';
  const LENS = /Chrome\/\d/.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent);
  const reduced = () => ROOT.dataset.reduceMotion === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reduceTransparency = () => matchMedia('(prefers-reduced-transparency: reduce)').matches;
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const $ = (sel, root = document) => root.querySelector(sel);

  function isDark() {
    return ROOT.classList.contains('dark') || ROOT.getAttribute('data-blora-color-scheme') === 'dark' || ROOT.dataset.theme === 'dark';
  }
  function syncTheme() {
    ROOT.dataset.theme = isDark() ? 'dark' : 'light';
    if (!ROOT.getAttribute('data-blora-color-scheme')) {
      ROOT.setAttribute('data-blora-color-scheme', isDark() ? 'dark' : 'light');
    }
  }

  /* ---------- Wallpaper: copied from liquid.js ---------- */
  const paint = v => `style="fill:var(${v})"`;
  const WALLPAPER = `<svg viewBox="0 0 1800 1200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <rect width="1800" height="1200" ${paint('--wp-bg')}/>
    <path d="M-180-100H1120C997 91 844 230 613 332L-180 686Z" ${paint('--wp-1')}/>
    <path d="M-160 1200V884L514 545C835 384 1021 191 1120-100H1287C1207 255 1008 475 666 664L-160 1121Z" ${paint('--wp-2')}/>
    <path d="M-160 1200V1121L666 664C998 480 1203 260 1287-100H1370C1310 272 1112 537 765 743L-20 1200Z" ${paint('--wp-3')}/>
    <path d="M-160 1200H-20L765 743C1061 567 1246 347 1332 68C1283 398 1080 666 790 850L237 1200Z" ${paint('--wp-4')}/>
    <path d="M237 1200 790 850C983 727 1138 566 1236 374C1170 601 1012 792 817 926L419 1200Z" ${paint('--wp-5')}/>
    <path d="M1800 1200H885C1027 1098 1168 992 1311 909C1477 813 1644 774 1800 779Z" ${paint('--wp-6')}/>
  </svg>`;

  /* Wallpaper choice copied from scaffold.js: 主题壁纸 (inline 青灰 SVG) / 原壁纸
   * (product SVGs) plus CrewRouter 自定义图片。UI 色盘仍固定青灰。 */
  const PRODUCT_WALLS = {
    mineral: ['c5b10ba57cdd-wallpaper', '5b4706a8a2f2-wallpaper-dark'],
    ice: ['58170f443f90-ice-wallpaper', '01a5888505fe-ice-wallpaper-dark'],
    sand: ['01c847f8d686-sand', '676e966140f9-sand-dark'],
    sage: ['bb8350728fcc-sage', '60dab627c474-sage-dark'],
    iris: ['8186c09057b9-iris', '19d759680e38-iris-dark'],
    rose: ['1923fad5f421-rose', 'df53c84f18aa-rose-dark'],
  };
  const PRODUCT_LABELS = { mineral: '青灰', ice: '冰蓝', sand: '暖砂', sage: '苔绿', iris: '雾紫', rose: '烟粉' };
  const APPEAR_KEY = 'crewrouter-liquid-appearance';
  const appearance = loadAppearance();

  function loadAppearance() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(APPEAR_KEY) || '{}'); } catch { /* ignore */ }
    const wallpaper = ['theme', 'product', 'custom'].includes(saved.wallpaper) ? saved.wallpaper : 'theme';
    const product = Object.prototype.hasOwnProperty.call(PRODUCT_WALLS, saved.product) ? saved.product : 'mineral';
    const custom = safeWallUrl(saved.custom);
    return { wallpaper: wallpaper === 'custom' && !custom ? 'theme' : wallpaper, product, custom };
  }
  function saveAppearance() {
    try { localStorage.setItem(APPEAR_KEY, JSON.stringify({ v: 1, ...appearance })); } catch { /* quota */ }
  }
  function safeWallUrl(s) {
    if (!s || typeof s !== 'string') return '';
    const v = s.trim();
    if (v.length > 2_000_000) return '';
    if (/^https?:\/\//i.test(v) || /^data:image\//i.test(v) || /^blob:/i.test(v) || v.startsWith('/assets/wallpapers/')) return v;
    return '';
  }
  function productUrl() {
    const pair = PRODUCT_WALLS[appearance.product] || PRODUCT_WALLS.mineral;
    return `/assets/wallpapers/${pair[isDark() ? 1 : 0]}.svg`;
  }
  function applyWallpaper() {
    const host = $('#lg-wallpaper');
    const mode = appearance.wallpaper === 'custom' && appearance.custom
      ? 'custom'
      : appearance.wallpaper === 'product' ? 'product' : 'theme';
    ROOT.dataset.wallpaper = mode;
    ROOT.dataset.wallProduct = appearance.product;
    if (mode === 'product' || mode === 'custom') {
      const src = mode === 'product' ? productUrl() : appearance.custom.replace(/"/g, '');
      const css = `url("${src}")`;
      ROOT.style.setProperty('--lg-wall-image', css);
      ROOT.style.setProperty('--product-wallpaper', css);
    } else {
      ROOT.style.removeProperty('--lg-wall-image');
      ROOT.style.removeProperty('--product-wallpaper');
    }
    if (host) host.dataset.mode = mode;
    syncPickers();
  }
  function setAppearance(patch) {
    if (patch.wallpaper) appearance.wallpaper = patch.wallpaper;
    if (patch.product && PRODUCT_WALLS[patch.product]) appearance.product = patch.product;
    if (Object.prototype.hasOwnProperty.call(patch, 'custom')) appearance.custom = safeWallUrl(patch.custom);
    saveAppearance();
    applyWallpaper();
  }

  /* ---------- Lens engine — copied from liquid.js ----------
   * bezel = width of the refracting rim; depth = how far (px) the rim samples inward at the
   * very edge, so that much of whatever sits under the edge is pushed out of view — kept
   * small enough that a window behind the dock still shows. disp = per-channel depth factors
   * (R, G, B) for the slight chromatic fringe. Blur stays a light touch: clear, not frosted.
   */
  const PROFILES = {
    window: { bezel: 28, depth: 28, blur: 3, sat: 1.8, bright: 1.02, disp: [1, 1.07, 1.14], res: .5 },
    capsule: { bezel: 16, depth: 16, blur: 1.4, sat: 1.9, bright: 1.03, disp: [1, 1.07, 1.14], res: 1 },
    dock: { bezel: 16, depth: 14, blur: 1.4, sat: 2, bright: 1.04, disp: [1, 1.07, 1.14], res: 1 },
    menu: { bezel: 16, depth: 16, blur: 3, sat: 2, bright: 1.03, disp: [1, 1.07, 1.14], res: 1 },
    panel: { bezel: 26, depth: 24, blur: 3, sat: 1.9, bright: 1.02, disp: [1, 1.07, 1.14], res: .5 },
    toast: { bezel: 16, depth: 16, blur: 3, sat: 2, bright: 1.03, disp: [1, 1.07, 1.14], res: 1 },
    // the droplet's rim while it is dragged: a narrow bezel, no blur, no colour split — only
    // what passes under its edge bends
    rim: { bezel: 7, depth: 3, blur: 0, sat: 1.3, bright: 1.03, disp: null, res: 1 },
  };
  const TARGETS = [
    ['.blora-page .app-container > .sidebar', 'capsule'],
    ['.blora-page .mobile-topbar', 'capsule'],
    ['.blora-dropdown__menu', 'menu'],
    ['.blora-select__popup', 'menu'],
    ['.library-key-bubble-menu, #libraryKeyBubbleMenu', 'menu'],
    ['.provider-tag-assign-dropdown, .api-key-tag-assign-dropdown, .api-key-tags-overflow-popover, .api-key-route-queue-tip', 'menu'],
    ['.blora-timepicker__panel', 'menu'],
    ['.blora-tooltip__bubble', 'toast'],
    ['.app-toast', 'toast'],
    ['blora-dialog.lg-scope[open], blora-dialog[open]', 'panel'],
    ['.trace-report-dialog', 'panel'],
    ['#scriptAiModelPickerOverlay > [role="dialog"], .script-ai-model-picker', 'panel'],
    ['blora-navbar.public-navbar > .blora-navbar, .public-navbar .blora-navbar', 'capsule'],
    ['#pgContextMenu, .pg-context-menu', 'menu'],
    // 弹窗通知卡按对话框面板透镜（更宽边缘折射）；气泡列表仍用 toast
    ['.cr-pn-card.is-active', 'panel'],
    ['.cr-pn-bubble', 'toast'],
    ['.auth-card, .login-card, .pi-card, .oc-card, .setup-card, .purchase-card, .plain-card', 'panel'],
    ['.up-toolbar-slot', 'capsule'],
    ['#modelLibraryPage .model-library-binding-bar', 'panel'],
    ['#modelLibraryPage .ml-model-filter-bar', 'capsule'],
    ['#modelLibraryPage .model-library-sticky-bar', 'capsule'],
    ['#modelLibraryPage .ml-library-reorder-toolbar', 'capsule'],
    ['#apiKeysPage #apiKeysStickyBar', 'capsule'],
    ['.store-header', 'capsule'],
    ['.store-modal', 'panel'],
    ['.usage-card', 'panel'],
    ['.admin-library-manager-panel', 'panel'],
    ['.lg-page.admin-model-library .aml-toolbar', 'capsule'],
    ['.lg-page.admin-model-library .aml-filter-panel', 'menu'],
    ['.lg-page.admin-model-library .aml-team-panel', 'menu'],
    ['.lg-page.blora-agent-page .ba-history', 'panel'],
    ['.pg-history-panel, .pg-settings-panel', 'capsule'],
    ['.pg-composer-input, .pg-input-row', 'capsule'],
    ['.pg-mobile-bar', 'capsule'],
    ['blora-drawer.mobile-sidebar-drawer[open], blora-drawer.lg-scope[open]', 'panel'],
    ['.blora-datepicker__panel[data-open]', 'menu'],
    ['.blora-popover[data-open] .blora-popover__panel, .blora-popover__panel', 'menu'],
    ['blora-command[open]', 'panel'],
    ['blora-dialog.pg-history-modal[open], #pgHistoryModal[open]', 'panel'],
    ['.data-nav, .showcase-nav', 'capsule'],
  ];
  const maps = new Map();
  let serial = 0;
  const lenses = new Map();
  let defs = null;
  let resizeObserver = null;

  // Displacement map for a rounded rect: inside the bezel, pixels sample inward along
  // the surface normal (R/G = x/y offset around 128), strongest at the very edge.
  function displacementMap(w, h, r, bezel, res) {
    let usedRes = res;
    let W = Math.max(2, Math.round(w * usedRes)), H = Math.max(2, Math.round(h * usedRes));
    const maxEdge = 360;
    if (W > maxEdge || H > maxEdge) {
      usedRes *= maxEdge / Math.max(W, H);
      W = Math.max(2, Math.round(w * usedRes));
      H = Math.max(2, Math.round(h * usedRes));
    }
    const key = [w, h, r, bezel, usedRes].join('|');
    if (maps.has(key)) return maps.get(key);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
    const hw = w / 2, hh = h / 2, rr = Math.min(r, hw, hh);
    for (let y = 0; y < H; y++) {
      const py = (y + .5) / usedRes - hh, ay = Math.abs(py), sy = py < 0 ? -1 : 1;
      for (let x = 0; x < W; x++) {
        const px = (x + .5) / usedRes - hw, ax = Math.abs(px), sx = px < 0 ? -1 : 1;
        const qx = ax - (hw - rr), qy = ay - (hh - rr);
        let dist, nx, ny;
        if (qx > 0 && qy > 0) { const L = Math.hypot(qx, qy) || 1; dist = rr - L; nx = qx / L; ny = qy / L; }
        else if (qx > qy) { dist = rr - qx; nx = 1; ny = 0; }
        else { dist = rr - qy; nx = 0; ny = 1; }
        let t = 1 - dist / bezel;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const m = Math.pow(t, 1.6);
        const i = (y * W + x) * 4;
        d[i] = 128 - sx * nx * m * 127;
        d[i + 1] = 128 - sy * ny * m * 127;
        d[i + 2] = 128; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = c.toDataURL();
    maps.set(key, url);
    return url;
  }

  // Without disp the lens bends all channels alike: the per-channel split is recombined with
  // screen blends, which assumes an opaque backdrop — inside a window (a translucent backdrop)
  // it would muddy the result.
  function filterMarkup(url, w, h, p) {
    const disp = (k, out) => `<feDisplacementMap in="blur" in2="map" scale="${(2 * p.depth * k).toFixed(2)}" xChannelSelector="R" yChannelSelector="G" result="${out}"/>`;
    const only = (inp, row, out) => `<feColorMatrix in="${inp}" type="matrix" values="${row}" result="${out}"/>`;
    const body = !p.disp ? disp(1, 'disp') : disp(p.disp[0], 'dr') + disp(p.disp[1], 'dg') + disp(p.disp[2], 'db')
      + only('dr', '1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0', 'r') + only('dg', '0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0', 'g') + only('db', '0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0', 'b')
      + '<feBlend in="r" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="b" mode="screen" result="disp"/>';
    return `<feGaussianBlur in="SourceGraphic" stdDeviation="${p.blur}" edgeMode="duplicate" result="blur"/>
      <feImage href="${url}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>
      ${body}
      <feColorMatrix in="disp" type="saturate" values="${p.sat}" result="sat"/>
      <feComponentTransfer in="sat"><feFuncR type="linear" slope="${p.bright}"/><feFuncG type="linear" slope="${p.bright}"/><feFuncB type="linear" slope="${p.bright}"/></feComponentTransfer>`;
  }

  function ensureDefs() {
    if (defs && defs.isConnected) return defs;
    defs = document.createElementNS(NS, 'svg');
    defs.setAttribute('width', '0');
    defs.setAttribute('height', '0');
    defs.setAttribute('aria-hidden', 'true');
    defs.id = 'lg-lens-defs';
    defs.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    document.body.append(defs);
    return defs;
  }

  // blora-dialog / drawer / command hosts fill the viewport; the glass is the inner panel.
  function lensBox(el) {
    if (el.matches && el.matches('blora-dialog, blora-drawer')) {
      const inner = el.querySelector(':scope > .modal-content')
        || (el.shadowRoot && el.shadowRoot.querySelector('[part="panel"]'));
      if (inner && inner.offsetWidth && inner.offsetHeight) return inner;
    }
    if (el.matches && el.matches('blora-command')) {
      const inner = el.querySelector('.blora-command, .blora-cmdk')
        || (el.shadowRoot && el.shadowRoot.querySelector('.blora-command, .blora-cmdk, [part="panel"]'));
      if (inner && inner.offsetWidth && inner.offsetHeight) return inner;
    }
    return el;
  }

  function clearDialogMaskBlur(el) {
    if (!el.matches || !el.matches('blora-dialog, blora-drawer, blora-command')) return;
    el.style.backdropFilter = 'none';
    el.style.webkitBackdropFilter = 'none';
    const root = el.shadowRoot;
    if (!root) return;
    root.querySelectorAll('.blora-dialog__mask, .blora-dialog__backdrop, .blora-drawer__mask, .blora-drawer__backdrop, .blora-command__mask, .blora-command__backdrop').forEach(mask => {
      mask.style.backdropFilter = 'none';
      mask.style.webkitBackdropFilter = 'none';
    });
  }

  function updateLens(el) {
    const lens = lenses.get(el);
    if (!lens) return;
    if (!el.isConnected) {
      lens.filter.remove();
      lenses.delete(el);
      return;
    }
    const box = lensBox(el);
    lens.box = box;
    const w = Math.round(box.offsetWidth || box.getBoundingClientRect().width);
    const h = Math.round(box.offsetHeight || box.getBoundingClientRect().height);
    if (!w || !h) return;
    const dark = isDark();
    if (lens.key && lens.w && Math.abs(lens.w - w) < 2 && Math.abs(lens.h - h) < 2 && lens.dark === dark) return;
    const r = Math.min(parseFloat(getComputedStyle(box).borderTopLeftRadius) || 0, w / 2, h / 2);
    const p = PROFILES[lens.profile];
    const key = [w, h, r, dark].join('|');
    if (lens.key === key) return;
    lens.key = key;
    lens.w = w; lens.h = h; lens.dark = dark;
    const prof = dark ? { ...p, bright: p.bright * .8 } : p;
    lens.filter.setAttribute('width', w);
    lens.filter.setAttribute('height', h);
    lens.filter.innerHTML = filterMarkup(
      displacementMap(w, h, Math.round(r), Math.min(p.bezel, w / 2, h / 2), p.res),
      w, h, prof
    );
    const url = `url(#${lens.filter.id})`;
    el.style.setProperty('--lens', url);
    if (box !== el) box.style.setProperty('--lens', url);
    const root = el.getRootNode && el.getRootNode();
    if (root && root !== document && root.host) root.host.style.setProperty('--lens', url);
  }

  function isVisibleGlass(el) {
    if (!el || !el.isConnected) return false;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.matches && el.matches('blora-dialog, blora-drawer, blora-command')) {
      let popoverOpen = false;
      try { popoverOpen = el.matches(':popover-open'); } catch { /* old engine */ }
      if (!el.hasAttribute('open') && !popoverOpen) return false;
    }
    if (!el.offsetWidth || !el.offsetHeight) return false;
    return el.getClientRects().length > 0;
  }

  function register(el, profile) {
    if (!LENS || reduceTransparency() || !el || lenses.has(el)) return;
    if (!isVisibleGlass(el)) return;
    ensureDefs();
    if (!resizeObserver) {
      resizeObserver = new ResizeObserver(entries => {
        for (const e of entries) {
          if (lenses.has(e.target)) updateLens(e.target);
          else {
            for (const [host, lens] of lenses) {
              if (lens.box === e.target) updateLens(host);
            }
          }
        }
      });
    }
    const filter = document.createElementNS(NS, 'filter');
    filter.id = 'liquid-lens-' + (++serial);
    for (const [k, v] of Object.entries({
      x: 0, y: 0, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB',
    })) filter.setAttribute(k, v);
    defs.append(filter);
    const box = lensBox(el);
    lenses.set(el, { filter, profile, key: '', box });
    resizeObserver.observe(el);
    if (box !== el) resizeObserver.observe(box);
    clearDialogMaskBlur(el);
    updateLens(el);
  }

  let scanQueue = [];
  let scanning = false;
  function registerQueued(el, profile) {
    try { register(el, profile); } catch { /* skip hosts that fail to lens */ }
  }
  function pumpScan() {
    scanning = true;
    try {
      const start = performance.now();
      while (scanQueue.length && performance.now() - start < 8) {
        const [el, profile] = scanQueue.shift();
        registerQueued(el, profile);
      }
    } finally {
      if (scanQueue.length) requestAnimationFrame(pumpScan);
      else scanning = false;
    }
  }
  function flushScan() {
    scanning = true;
    try {
      scanLenses();
      while (scanQueue.length) {
        const [el, profile] = scanQueue.shift();
        registerQueued(el, profile);
      }
    } finally {
      scanning = false;
    }
    scanDroplets();
    updateIndicators();
  }
  function shadowPopups() {
    const out = [];
    $$('blora-select, blora-dropdown, blora-timepicker, blora-datepicker, blora-popover, blora-tooltip').forEach(host => {
      const root = host.shadowRoot;
      if (!root) return;
      const popup = root.querySelector('.blora-select__popup, .blora-dropdown__menu, .blora-timepicker__panel, .blora-datepicker__panel, .blora-popover__panel, .blora-tooltip__bubble, [part="popup"], [part="panel"]');
      if (popup) out.push([popup, 'menu']);
    });
    return out;
  }

  function pageWantsGlass() {
    return !!(document.querySelector('.page.active.lg-page, .lg-page, body.lg-scope') || document.body?.classList.contains('lg-scope'));
  }
  // JS 动态 createElement('blora-dialog') 不会带 lg-scope，透镜和面板皮肤都对不上。
  function adoptGlassHosts() {
    if (!pageWantsGlass()) return;
    $$('blora-dialog, blora-drawer').forEach(el => el.classList.add('lg-scope'));
  }

  function scanLenses() {
    if (!LENS || reduceTransparency()) return;
    adoptGlassHosts();
    TARGETS.forEach(([sel, profile]) => $$(sel).forEach(el => {
      if (!lenses.has(el) && isVisibleGlass(el)) scanQueue.push([el, profile]);
    }));
    shadowPopups().forEach(([el, profile]) => {
      if (!lenses.has(el) && isVisibleGlass(el)) scanQueue.push([el, profile]);
    });
    if (!scanning && scanQueue.length) requestAnimationFrame(pumpScan);
  }

  function invalidateLenses() {
    lenses.forEach((lens, el) => { lens.key = ''; updateLens(el); });
  }

  /* ---------- Selection indicators: copied from scaffold.js + liquid.js ---------- */
  const IND_ITEM = ':scope > :not(.indicator):not(.ind-rim):not(.view-tab-add):not(.blora-sidebar-nav__group-label):not(.blora-tabs__indicator)';
  const IND_SEL = ':scope > [aria-current="page"], :scope > [data-active], :scope > [aria-pressed="true"], :scope > [aria-selected="true"], :scope > .selected';
  const last = new WeakMap();
  const readyBoxes = new Set();
  let indicatorResize = null;
  let indicatorAttrObserver = null;

  function updateIndicator(box) {
    if (!box || !box.isConnected) return;
    const sel = box.querySelector(IND_SEL);
    if (!sel || !sel.offsetWidth) {
      box.style.setProperty('--ind-o', '0');
      return;
    }
    box.style.setProperty('--ind-x', sel.offsetLeft + 'px');
    box.style.setProperty('--ind-y', sel.offsetTop + 'px');
    box.style.setProperty('--ind-w', sel.offsetWidth + 'px');
    box.style.setProperty('--ind-h', sel.offsetHeight + 'px');
    box.style.setProperty('--ind-o', '1');
    if (!box.hasAttribute('data-ind-ready')) requestAnimationFrame(() => box.setAttribute('data-ind-ready', ''));
  }
  function updateIndicators() { readyBoxes.forEach(updateIndicator); }

  function attachRim(box) {
    if (box.querySelector(':scope > .ind-rim')) return;
    const rim = document.createElement('span');
    rim.className = 'ind-rim';
    rim.setAttribute('aria-hidden', 'true');
    box.append(rim);
    register(rim, 'rim');
  }

  function watchBox(box) {
    if (readyBoxes.has(box)) {
      updateIndicator(box);
      return;
    }
    readyBoxes.add(box);
    last.set(box, {
      x: parseFloat(box.style.getPropertyValue('--ind-x')) || 0,
      y: parseFloat(box.style.getPropertyValue('--ind-y')) || 0,
    });
    if (!indicatorResize) {
      indicatorResize = new ResizeObserver(entries => entries.forEach(e => updateIndicator(e.target)));
    }
    indicatorResize.observe(box);
    if (!indicatorAttrObserver) {
      indicatorAttrObserver = new MutationObserver(records => records.forEach(({ target: host }) => {
        const x = parseFloat(host.style.getPropertyValue('--ind-x')) || 0;
        const y = parseFloat(host.style.getPropertyValue('--ind-y')) || 0;
        const prev = last.get(host);
        last.set(host, { x, y });
        if (!prev || !host.hasAttribute('data-ind-ready') || reduced() || host.classList.contains('ind-drag')) return;
        const dx = x - prev.x, dy = y - prev.y;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        host.classList.remove('ind-moving-x', 'ind-moving-y');
        void host.offsetWidth;
        host.classList.add(Math.abs(dx) >= Math.abs(dy) ? 'ind-moving-x' : 'ind-moving-y');
        clearTimeout(host.liquidTimer);
        host.liquidTimer = setTimeout(() => host.classList.remove('ind-moving-x', 'ind-moving-y'), 210);
        host.classList.add('ind-bloom');
        clearTimeout(host.bloomTimer);
        host.bloomTimer = setTimeout(() => host.classList.remove('ind-bloom'), 360);
      }));
    }
    indicatorAttrObserver.observe(box, { attributes: true, attributeFilter: ['style'] });
    attachRim(box);
    updateIndicator(box);
  }

  function ensureIndicatorEl(box) {
    let ind = box.querySelector(':scope > .indicator');
    if (!ind) {
      ind = box.querySelector(':scope > .blora-segmented__indicator, :scope > .blora-tabs__indicator');
      if (ind) ind.classList.add('indicator');
    }
    if (!ind) {
      ind = document.createElement('span');
      ind.className = 'indicator';
      ind.setAttribute('aria-hidden', 'true');
      box.prepend(ind);
    }
    return ind;
  }

  function mountBox(box, vertical) {
    if (!box || !box.offsetWidth || !box.offsetHeight) return;
    box.setAttribute('data-indicator', '');
    if (vertical) box.classList.add('sidebar-list');
    ensureIndicatorEl(box);
    watchBox(box);
  }

  function scanDroplets() {
    $$('.business-sidebar-navigation .blora-sidebar-nav__group, .mobile-sidebar-drawer-content .blora-sidebar-nav__group').forEach(group => {
      mountBox(group, true);
    });
    $$('.blora-segmented, .lg-wall-seg').forEach(el => mountBox(el, false));
    $$('.blora-tabs:not([data-orientation="vertical"]) > .blora-tabs__nav').forEach(el => mountBox(el, false));
    $$('.blora-tabs[data-orientation="vertical"] > .blora-tabs__nav').forEach(el => mountBox(el, true));
    // Drop disconnected boxes so we don't keep updating ghosts.
    for (const box of [...readyBoxes]) {
      if (!box.isConnected) readyBoxes.delete(box);
    }
  }

  /* Dragging the droplet — copied from liquid.js */
  let drag = null, swallowClick = false;
  const geometry = el => ({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });

  function onPointerDown(e) {
    scheduleScan();
    if (e.button !== 0) return;
    const box = e.target.closest('[data-indicator]');
    if (!box || e.target.closest('.view-tab-close, .view-tab-add')) return;
    const items = [...box.querySelectorAll(IND_ITEM)].filter(el => el.offsetWidth && getComputedStyle(el).display !== 'none');
    if (items.length < 2 || !items.some(el => el.contains(e.target))) return;
    drag = {
      box, items, id: e.pointerId, x0: e.clientX, y0: e.clientY,
      vertical: box.classList.contains('sidebar-list') || box.closest('blora-tabs[data-orientation="vertical"]'),
      active: false, v: 0,
    };
  }
  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { box, items, vertical } = drag;
    if (!drag.active) {
      if (Math.abs(vertical ? e.clientY - drag.y0 : e.clientX - drag.x0) < 5) return;
      drag.active = true;
      drag.geo = items.map(geometry);
      drag.centres = drag.geo.map(g => vertical ? g.y + g.h / 2 : g.x + g.w / 2);
      box.classList.remove('ind-moving-x', 'ind-moving-y');
      box.classList.add('ind-drag');
      getSelection()?.removeAllRanges();
    }
    e.preventDefault();
    const r = box.getBoundingClientRect();
    const { geo, centres } = drag;
    const p = vertical ? e.clientY - r.top - box.clientTop : e.clientX - r.left - box.clientLeft;
    const c = Math.min(Math.max(p, centres[0]), centres[centres.length - 1]);
    let i = 0;
    while (i < centres.length - 2 && c > centres[i + 1]) i++;
    const f = (c - centres[i]) / (centres[i + 1] - centres[i] || 1), a = geo[i], b = geo[i + 1];
    const mix = k => a[k] + (b[k] - a[k]) * f, w = mix('w'), h = mix('h');
    box.style.setProperty('--ind-w', w + 'px');
    box.style.setProperty('--ind-h', h + 'px');
    box.style.setProperty('--ind-x', (vertical ? mix('x') : c - w / 2) + 'px');
    box.style.setProperty('--ind-y', (vertical ? c - h / 2 : mix('y')) + 'px');
    const now = performance.now();
    if (drag.t) drag.v = drag.v * .6 + (c - drag.c) / Math.max(8, now - drag.t) * .4;
    drag.c = c; drag.t = now;
    const k = reduced() ? 0 : Math.min(Math.abs(drag.v) * .1, .12);
    box.style.setProperty('--ind-along', 1 + k);
    box.style.setProperty('--ind-across', 1 - k * .5);
  }
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { box, items, active, centres, c } = drag;
    drag = null;
    if (!active) return;
    box.classList.remove('ind-drag');
    box.style.removeProperty('--ind-along');
    box.style.removeProperty('--ind-across');
    let n = 0;
    centres.forEach((v, j) => { if (Math.abs(v - c) < Math.abs(centres[n] - c)) n = j; });
    const target = items[n];
    swallowClick = true;
    setTimeout(() => {
      swallowClick = false;
      if (!target.matches('.selected, [aria-pressed="true"], [aria-current="page"], [data-active], [aria-selected="true"]')) {
        (target.querySelector(':scope > .view-tab-button, :scope > .blora-tabs__tab') || target).click();
      }
      updateIndicator(box);
    });
  }

  /* ---------- Wallpaper host ---------- */
  function mountWallpaper() {
    let host = $('#lg-wallpaper');
    if (!host) {
      host = document.createElement('div');
      host.id = 'lg-wallpaper';
      host.className = 'lg-wallpaper';
      host.setAttribute('aria-hidden', 'true');
      host.innerHTML = WALLPAPER;
      document.body.prepend(host);
    }
    applyWallpaper();
  }

  function pickerMarkup() {
    const thumbs = Object.entries(PRODUCT_LABELS).map(([id, label]) => {
      const file = PRODUCT_WALLS[id][0];
      return `<button type="button" class="lg-wall-thumb" data-product="${id}" aria-pressed="${appearance.product === id}" title="${label}" aria-label="${label}" style="background-image:url('/assets/wallpapers/${file}.svg')"><span>${label}</span></button>`;
    }).join('');
    return `
      <div class="lg-wall-seg" role="group" aria-label="壁纸" data-indicator>
        <span class="indicator" aria-hidden="true"></span>
        <button type="button" data-wall="theme">主题壁纸</button>
        <button type="button" data-wall="product">原壁纸</button>
        <button type="button" data-wall="custom">自定义</button>
      </div>
      <div class="lg-wall-products" ${appearance.wallpaper === 'product' ? '' : 'hidden'}>${thumbs}</div>
      <div class="lg-wall-custom" ${appearance.wallpaper === 'custom' ? '' : 'hidden'}>
        <label class="lg-wall-file blora-button" data-variant="secondary" data-size="sm">
          <input type="file" accept="image/*" hidden>
          <span>选择图片</span>
        </label>
        <input type="url" class="blora-input lg-wall-url" placeholder="https:// 图片地址" value="${appearance.custom && !appearance.custom.startsWith('data:') && !appearance.custom.startsWith('blob:') ? appearance.custom : ''}">
        <button type="button" class="blora-button lg-wall-apply" data-variant="primary" data-size="sm">应用</button>
        <p class="lg-wall-hint">图片保存在本机浏览器，不超过 1.8MB。界面色盘仍是青灰。</p>
        <p class="lg-wall-error" hidden></p>
      </div>`;
  }
  function bindPicker(host) {
    if (!host || host.dataset.lgBound) return;
    host.dataset.lgBound = '1';
    host.classList.add('lg-wall-picker');
    host.innerHTML = pickerMarkup();
    host.addEventListener('click', e => {
      const wall = e.target.closest('[data-wall]');
      if (wall) {
        setAppearance({ wallpaper: wall.dataset.wall });
        scanDroplets();
        updateIndicators();
        return;
      }
      const product = e.target.closest('[data-product]');
      if (product) setAppearance({ wallpaper: 'product', product: product.dataset.product });
    });
    const file = host.querySelector('input[type="file"]');
    const url = host.querySelector('.lg-wall-url');
    const apply = host.querySelector('.lg-wall-apply');
    const err = host.querySelector('.lg-wall-error');
    const showErr = msg => { if (!err) return; err.hidden = !msg; err.textContent = msg || ''; };
    if (file) file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type)) { showErr('请选择图片文件'); file.value = ''; return; }
      if (f.size > 1_800_000) { showErr('图片超过 1.8MB'); file.value = ''; return; }
      showErr('');
      const reader = new FileReader();
      reader.onload = () => setAppearance({ wallpaper: 'custom', custom: String(reader.result || '') });
      reader.readAsDataURL(f);
    });
    const applyUrl = () => {
      const v = (url && url.value || '').trim();
      if (!v) { showErr('请填写图片地址'); return; }
      if (!safeWallUrl(v)) { showErr('只支持 https / http 图片地址'); return; }
      showErr('');
      setAppearance({ wallpaper: 'custom', custom: v });
    };
    if (apply && url) apply.addEventListener('click', applyUrl);
    if (url) url.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyUrl(); } });
    mountBox(host.querySelector('[data-indicator]'), false);
  }
  function syncPickers() {
    $$('.lg-wall-picker').forEach(host => {
      host.querySelectorAll('[data-wall]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.wall === appearance.wallpaper)));
      host.querySelectorAll('[data-product]').forEach(b => {
        b.setAttribute('aria-pressed', String(b.dataset.product === appearance.product));
        const pair = PRODUCT_WALLS[b.dataset.product];
        if (pair) b.style.backgroundImage = `url('/assets/wallpapers/${pair[isDark() ? 1 : 0]}.svg')`;
      });
      const products = host.querySelector('.lg-wall-products');
      const custom = host.querySelector('.lg-wall-custom');
      if (products) products.hidden = appearance.wallpaper !== 'product';
      if (custom) custom.hidden = appearance.wallpaper !== 'custom';
      const box = host.querySelector('[data-indicator]');
      if (box) updateIndicator(box);
    });
  }
  function mountPickers() {
    $$('#lgWallpaperPicker, .lg-wallpaper-picker-host').forEach(bindPicker);
  }

  /* ---------- Boot ---------- */
  let scanTimer = 0;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = requestAnimationFrame(() => {
      scanTimer = 0;
      scanLenses();
      scanDroplets();
      updateIndicators();
    });
  }

  function mount() {
    syncTheme();
    mountWallpaper();
    scanLenses();
    scanDroplets();
    updateIndicators();

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);
    document.addEventListener('click', e => {
      if (swallowClick) { e.stopPropagation(); e.preventDefault(); }
    }, true);

    // Match 晶液: no document-wide / childList observers. Blora foundation already
    // watches html class + subtree; watching childList here fights SidebarNav
    // (we inject .indicator / .ind-rim) and freezes the main thread.
    let lastDark = isDark();
    const onTheme = () => {
      const dark = isDark();
      if (dark === lastDark) return;
      lastDark = dark;
      applyWallpaper();
      invalidateLenses();
    };
    new MutationObserver(onTheme).observe(ROOT, {
      attributes: true,
      attributeFilter: ['data-blora-color-scheme'],
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onTheme);

    const watchNav = () => {
      $$('.business-sidebar-navigation, .mobile-sidebar-drawer-content').forEach(host => {
        if (host.dataset.lgWatch) return;
        host.dataset.lgWatch = '1';
        new MutationObserver(() => updateIndicators()).observe(host, {
          attributes: true,
          subtree: true,
          attributeFilter: ['aria-current', 'data-active', 'aria-selected', 'aria-pressed'],
        });
      });
    };
    watchNav();
    mountPickers();
    toastStack();
    requestAnimationFrame(() => requestAnimationFrame(scheduleScan));
    [400, 1500].forEach(ms => setTimeout(() => { watchNav(); mountPickers(); scheduleScan(); }, ms));
    window.addEventListener('hashchange', () => { scheduleScan(); mountPickers(); });
    window.addEventListener('popstate', scheduleScan);
    document.addEventListener('blora-open', scheduleScan, true);
    document.addEventListener('toggle', scheduleScan, true);
    window.addEventListener('storage', e => {
      if (e.key !== APPEAR_KEY) return;
      Object.assign(appearance, loadAppearance());
      applyWallpaper();
    });
  }

  /* ---------- Toast: copied from scaffold.js + liquid.css .app-toast ---------- */
  const TOAST_TITLE = { info: '提示', success: '已完成', warning: '需要注意', error: '操作结果尚未确认' };
  const toastSvg = (body) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const TOAST_ICO = {
    success: toastSvg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    info: toastSvg('<circle cx="12" cy="12" r="8.5"/><path d="M12 16v-4.5M12 8h.01"/>'),
    warning: toastSvg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/>'),
    error: toastSvg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/>'),
    x: toastSvg('<path d="M17 7 7 17M7 7l10 10"/>'),
  };
  function escToast(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  let toastStackEl = null;
  let toastStackObserver = null;
  function toastStack() {
    if (toastStackEl && toastStackEl.isConnected) return toastStackEl;
    toastStackEl = $('#lg-toast-stack');
    if (!toastStackEl) {
      toastStackEl = document.createElement('div');
      toastStackEl.id = 'lg-toast-stack';
      toastStackEl.className = 'toast-stack';
      toastStackEl.setAttribute('aria-live', 'polite');
      toastStackEl.setAttribute('aria-label', '操作反馈');
      document.body.append(toastStackEl);
    }
    if (!toastStackObserver) {
      toastStackObserver = new MutationObserver(() => {
        $$('.app-toast', toastStackEl).forEach(card => {
          if (!lenses.has(card) && isVisibleGlass(card)) register(card, 'toast');
        });
        lenses.forEach((lens, el) => {
          if (el.isConnected) return;
          lens.filter.remove();
          lenses.delete(el);
        });
      });
      toastStackObserver.observe(toastStackEl, { childList: true });
    }
    return toastStackEl;
  }
  function toast(message, kind = 'info', opts = {}) {
    const k = ['success', 'error', 'warning', 'info'].includes(kind) ? kind : 'info';
    const card = document.createElement('section');
    card.className = 'app-toast';
    card.dataset.kind = k;
    card.setAttribute('role', k === 'error' ? 'alert' : 'status');
    card.innerHTML = `<span class="toast-symbol">${TOAST_ICO[k] || TOAST_ICO.info}</span><div class="toast-body"><strong>${escToast(opts.title || TOAST_TITLE[k])}</strong><p>${escToast(message)}</p></div><button type="button" class="toast-close" aria-label="关闭提示">${TOAST_ICO.x}</button>`;
    const dismiss = () => {
      if (!card.isConnected || card.classList.contains('leaving')) return;
      card.classList.add('leaving');
      setTimeout(() => card.remove(), reduced() ? 0 : 180);
    };
    card.querySelector('.toast-close').addEventListener('click', dismiss);
    const stack = toastStack();
    while (stack.children.length >= 3) stack.firstElementChild.remove();
    stack.append(card);
    if (k !== 'error') setTimeout(dismiss, 5200);
    return card;
  }

  window.CrewRouterLiquid = { mount, updateIndicators, updateLens, register, scan: flushScan, setAppearance, appearance, toast };

  const boot = () => setTimeout(mount, 0);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
