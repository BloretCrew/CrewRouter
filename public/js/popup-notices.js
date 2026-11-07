/**
 * CrewRouter 弹窗通知渲染器
 *
 * 管理员在「系统设置 → 弹窗通知」创建的一次性弹窗；控制台打开时展示，
 * 多条时以叠放卡片呈现，左侧（窄屏为底部）气泡列表可切换当前卡片。
 *
 * 要点：
 *  - 使用原生 <dialog>.showModal() 进入 top layer：与 Blora 弹窗同层，
 *    后打开者在上，避免被 blora-dialog 的 popover 覆盖；不支持时回落 fixed。
 *  - 通知内容全部通过 textContent 写入（不拼 HTML）。
 *  - 上半部分：暖色调动态渐变 + "CrewRouter" 每 50～70ms（随机）切换系统字体。
 *  - 出现/消失：遮罩淡入淡出 + 内容柔和缩放（约 300～340ms）；prefers-reduced-motion 时跳过。
 *  - 已读按服务端记录：每条在激活/关闭时批量上报，幂等。
 *  - 任何异常都不阻塞控制台（静默 console.warn）。
 */
(function (global) {
  'use strict';

  var FONT_SWAP_MS_MIN = 50;
  var FONT_SWAP_MS_MAX = 70;
  var FONT_SWAP_FLASH_MS = 40;
  var SEEN_FLUSH_DELAY_MS = 250;
  var OVERLAY_ENTER_MS = 340;
  var OVERLAY_EXIT_MS = 300;
  var CARD_LEAVE_MS = 300;
  var DEFAULT_CLOSE_TEXT = '知道了';

  function nextFontDelay() {
    return FONT_SWAP_MS_MIN + Math.floor(Math.random() * (FONT_SWAP_MS_MAX - FONT_SWAP_MS_MIN + 1));
  }

  function t(key) {
    if (typeof global.t === 'function') {
      try { return global.t(key); } catch (_) { /* ignore */ }
    }
    return key;
  }  function warn() {
    try { console.warn.apply(console, ['[弹窗通知]'].concat([].slice.call(arguments))); } catch (_) { /* ignore */ }
  }

  function debug() {
    // console.debug 在多数浏览器默认隐藏，必须用 log 级别才「开箱可见」
    try { console.log.apply(console, ['[弹窗通知]'].concat([].slice.call(arguments))); } catch (_) { /* ignore */ }
  }

  function prefersReducedMotion() {
    try { return global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }

  /* ------------------------------------------------------------------ *
   * 字体轮播
   * ------------------------------------------------------------------ */

  // 每项：family 名称 + 通用回退（sans-serif / serif / monospace）
  var FONT_CANDIDATES = [
    ['SF Pro Display', 'sans-serif'], ['SF Pro Text', 'sans-serif'], ['SF Pro Rounded', 'sans-serif'],
    ['Helvetica Neue', 'sans-serif'], ['Avenir Next', 'sans-serif'], ['Avenir', 'sans-serif'],
    ['Futura', 'sans-serif'], ['Gill Sans', 'sans-serif'], ['Optima', 'sans-serif'],
    ['New York', 'serif'], ['Didot', 'serif'], ['Baskerville', 'serif'], ['Georgia', 'serif'],
    ['Times New Roman', 'serif'], ['Palatino', 'serif'], ['Garamond', 'serif'],
    ['Hoefler Text', 'serif'], ['Cochin', 'serif'], ['Songti SC', 'serif'], ['Noto Serif SC', 'serif'],
    ['Noto Serif', 'serif'], ['Cambria', 'serif'], ['Constantia', 'serif'], ['Liberation Serif', 'serif'],
    ['DejaVu Serif', 'serif'], ['Courier New', 'monospace'], ['Menlo', 'monospace'],
    ['Monaco', 'monospace'], ['Consolas', 'monospace'], ['SF Mono', 'monospace'],
    ['DejaVu Sans Mono', 'monospace'], ['Liberation Mono', 'monospace'],
    ['Segoe UI', 'sans-serif'], ['Tahoma', 'sans-serif'], ['Verdana', 'sans-serif'],
    ['Trebuchet MS', 'sans-serif'], ['Calibri', 'sans-serif'], ['Candara', 'sans-serif'],
    ['Corbel', 'sans-serif'], ['Impact', 'sans-serif'], ['Comic Sans MS', 'cursive'],
    ['Brush Script MT', 'cursive'], ['Copperplate', 'fantasy'], ['Papyrus', 'fantasy'],
    ['Zapfino', 'cursive'], ['DejaVu Sans', 'sans-serif'], ['Liberation Sans', 'sans-serif'],
    ['Ubuntu', 'sans-serif'], ['Cantarell', 'sans-serif'], ['Noto Sans', 'sans-serif'],
    ['Noto Sans SC', 'sans-serif'], ['Source Han Sans SC', 'sans-serif'],
    ['WenQuanYi Micro Hei', 'sans-serif'], ['Microsoft YaHei', 'sans-serif'],
    ['PingFang SC', 'sans-serif'], ['Hiragino Sans GB', 'sans-serif'], ['SimHei', 'sans-serif'],
  ];
  var FALLBACK_FAMILIES = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy'];
  var detectedFamilies = null;

  function cssFamily(name, generic) {
    return '"' + name.replace(/"/g, '\\"') + '", ' + (generic || 'sans-serif');
  }

  /** canvas 度量判断字体是否真的可用（与三个通用族宽度都不同的视为已安装） */
  function detectFontFamilies() {
    if (detectedFamilies) return detectedFamilies;
    var families = [];
    // 兜底清单：当检测完全失败时仍有字体可用
    var fallbackList = FONT_CANDIDATES.map(function (entry) { return entry[0]; }).concat(FALLBACK_FAMILIES);
    try {
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d');
      if (!ctx) return (detectedFamilies = fallbackList);
      var sample = 'CrewRouter 0123456789 AGMW';
      ctx.font = '72px monospace';
      var baseline = ctx.measureText(sample).width;
      FONT_CANDIDATES.forEach(function (entry) {
        var name = entry[0];
        var generic = entry[1];
        ctx.font = '72px ' + cssFamily(name, generic);
        var width = ctx.measureText(sample).width;
        // 与自身通用族基线相同 → 说明回退到了通用族，视为未安装
        var fallbackBase = 0;
        try {
          ctx.font = '72px ' + generic;
          fallbackBase = ctx.measureText(sample).width;
        } catch (_) { fallbackBase = baseline; }
        if (Math.abs(width - fallbackBase) > 0.5) families.push(name);
      });
    } catch (error) {
      warn('字体检测失败，使用完整候选清单', error);
      return (detectedFamilies = fallbackList);
    }
    // 通用族本身也是「字体」：追加为轮播项，保证至少能切换出差异
    var list = families.length >= 6 ? families : FONT_CANDIDATES.map(function (entry) { return entry[0]; });
    list = list.concat(FALLBACK_FAMILIES);
    // 按 canvas 度量的宽度间隔排列：宽度相同的相邻字体视觉上无差异，
    // 先排序再「洗牌」为相邻不同宽的序列，保证每一拍都「跳动」
    var widthByName = {};
    list.forEach(function (name) { widthByName[name] = fontFamilyWidth(name); });
    var distinct = list.filter(function (name, index) {
      return index === 0 || widthByName[name] !== widthByName[list[index - 1]];
    });
    if (distinct.length >= 2) {
      list = distinct;
      // 相邻同宽时把后者移到队尾重试一次（小列表很少发生；失败也无妨）
      for (var pass = 0; pass < 3; pass += 1) {
        var moved = false;
        for (var i = 1; i < list.length; i += 1) {
          if (widthByName[list[i]] === widthByName[list[i - 1]]) {
            list.push(list.splice(i, 1)[0]);
            moved = true;
          }
        }
        if (!moved) break;
      }
    }
    debug('字体轮播候选', list.length, '个：', list.slice(0, 12).join(', '), list.length > 12 ? '…' : '');
    detectedFamilies = list;
    return list;
  }

  function familyStackFor(name) {
    var entry = FONT_CANDIDATES.find(function (item) { return item[0] === name; });
    if (entry) return cssFamily(entry[0], entry[1]);
    if (FALLBACK_FAMILIES.indexOf(name) !== -1) return name;
    return '"' + name + '", sans-serif';
  }

  function fontFamilyWidth(name) {
    try {
      var ctx = fontFamilyWidth._ctx || (fontFamilyWidth._ctx = document.createElement('canvas').getContext('2d'));
      ctx.font = '72px ' + familyStackFor(name);
      return ctx.measureText('CrewRouter AGMW 09').width;
    } catch (_) { return 0; }
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function createEl(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function normalizeItems(raw, allowAnyId) {
    if (!Array.isArray(raw)) return [];
    var seen = new Set();
    var out = [];
    raw.forEach(function (item, index) {
      if (!item || typeof item !== 'object') return;
      var id = Number(item.id);
      if (allowAnyId) {
        if (!Number.isSafeInteger(id) || id <= 0) id = -(index + 1);
      } else if (!Number.isSafeInteger(id) || id <= 0) {
        return;
      }
      if (seen.has(id)) return;
      var title = String(item.title == null ? '' : item.title).trim();
      if (!title) return;
      seen.add(id);
      out.push({
        id: id,
        title: title.slice(0, 200),
        body: String(item.body == null ? '' : item.body).slice(0, 4000),
        closeText: String(item.closeText == null ? '' : item.closeText).trim().slice(0, 40) || DEFAULT_CLOSE_TEXT,
      });
    });
    return out;
  }

  var state = {
    dialog: null,
    layout: null,
    bubbles: null,
    stage: null,
    items: [],
    activeId: null,
    closedIds: new Set(),
    pendingSeen: new Set(),
    seenFlushTimer: null,
    exitTimer: null,
    fontTimer: null,
    fontIndex: 0,
    fontList: null,
    preview: false,
    opener: null,
    lockSnapshot: null,
    i18nHandler: null,
    closing: false,
  };

  function remainingItems() {
    return state.items.filter(function (item) { return !state.closedIds.has(item.id); });
  }

  function cardById(id) {
    return state.stage ? state.stage.querySelector('.cr-pn-card[data-id="' + id + '"]') : null;
  }

  function bubbleById(id) {
    return state.bubbles ? state.bubbles.querySelector('.cr-pn-bubble[data-id="' + id + '"]') : null;
  }

  function activeIndex() {
    var list = remainingItems();
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === state.activeId) return i;
    }
    return 0;
  }

  function setActive(id) {
    var list = remainingItems();
    if (!list.length) return;
    if (!list.some(function (item) { return item.id === id; })) id = list[0].id;
    state.activeId = id;
    var total = list.length;
    var current = activeIndex();

    Array.prototype.forEach.call(state.stage.querySelectorAll('.cr-pn-card'), function (card) {
      if (card.classList.contains('is-leaving')) return;
      var cardId = Number(card.dataset.id);
      var index = -1;
      for (var i = 0; i < list.length; i += 1) { if (list[i].id === cardId) index = i; }
      if (index < 0) {
        card.hidden = true;
        return;
      }
      card.hidden = false;
      var d = (index - current + total) % total;
      card.style.setProperty('--d', String(d));
      card.style.setProperty('--d-offset', String(Math.min(d, 3)));
      var isActive = cardId === id;
      card.classList.toggle('is-active', isActive);
      card.setAttribute('aria-hidden', isActive ? 'false' : 'true');
      if (isActive) card.removeAttribute('inert');
      else card.setAttribute('inert', '');
      var counter = card.querySelector('.cr-pn-counter');
      if (counter) {
        counter.textContent = global.t
          ? global.t('{current} / {total}', { current: current + 1, total: total })
          : (current + 1) + ' / ' + total;
      }
    });

    Array.prototype.forEach.call(state.bubbles ? state.bubbles.querySelectorAll('.cr-pn-bubble') : [], function (bubble) {
      var isActive = Number(bubble.dataset.id) === id;
      bubble.classList.toggle('is-active', isActive);
      bubble.setAttribute('aria-current', isActive ? 'true' : 'false');
    });

    if (state.dialog) {
      var activeCard = cardById(id);
      if (activeCard) state.dialog.setAttribute('aria-labelledby', activeCard.querySelector('.cr-pn-title').id);
    }

    queueSeen(id);
    renderBubbles();
    restartFontCycle();
  }

  function ensureActive() {
    var list = remainingItems();
    if (!list.length) { closeAll(); return; }
    if (!list.some(function (item) { return item.id === state.activeId; })) setActive(list[0].id);
  }

  /* ---------------- 已读上报 ---------------- */

  function queueSeen(id) {
    if (state.preview || !id) return;
    state.pendingSeen.add(Number(id));
    if (state.seenFlushTimer) return;
    state.seenFlushTimer = global.setTimeout(function () {
      state.seenFlushTimer = null;
      flushSeen();
    }, SEEN_FLUSH_DELAY_MS);
  }

  function flushSeen() {
    if (state.preview || !state.pendingSeen.size) return;
    var ids = Array.from(state.pendingSeen);
    var body = JSON.stringify({ ids: ids });
    var done = function () {
      ids.forEach(function (id) { state.pendingSeen.delete(id); });
    };
    try {
      var request = global.fetch('/api/user/popup-notices/seen', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: body,
      });
      if (request && typeof request.then === 'function') {
        request.then(function (response) { if (response && response.ok) done(); }).catch(function (error) { warn('上报已读失败', error); });
      }
    } catch (error) {
      warn('上报已读失败', error);
    }
  }

  /* ---------------- 字体轮播 ---------------- */

  function activeWordmark() {
    var card = state.activeId != null ? cardById(state.activeId) : null;
    return card ? card.querySelector('.cr-pn-wordmark span') : null;
  }

  function tickFont() {
    var node = activeWordmark();
    if (!node) return;
    if (!state.fontList) state.fontList = detectFontFamilies();
    if (!state.fontList.length) return;
    state.fontIndex = (state.fontIndex + 1) % state.fontList.length;
    node.style.fontFamily = familyStackFor(state.fontList[state.fontIndex]);
    node.classList.add('is-swapping');
    global.setTimeout(function () { node.classList.remove('is-swapping'); }, FONT_SWAP_FLASH_MS);
    debug('字体切换 →', state.fontList[state.fontIndex]);
  }

  function scheduleFontTick() {
    stopFontCycle();
    state.fontTimer = global.setTimeout(function () {
      state.fontTimer = null;
      if (!state.dialog || !state.dialog.open) return;
      if (!global.document.hidden) tickFont();
      scheduleFontTick();
    }, nextFontDelay());
  }

  function restartFontCycle() {
    stopFontCycle();
    if (prefersReducedMotion()) return;
    var node = activeWordmark();
    if (!node) return;
    if (!state.fontList) state.fontList = detectFontFamilies();
    node.style.fontFamily = 'var(--lg-font-display)';
    scheduleFontTick();
  }

  function stopFontCycle() {
    if (state.fontTimer) {
      global.clearTimeout(state.fontTimer);
      state.fontTimer = null;
    }
  }

  function onVisibilityChange() {
    if (global.document.hidden) return;
    // 回到前台时补一次轮播，避免 interval 被节流后停在原地
    if (state.dialog && state.dialog.open && !prefersReducedMotion()) tickFont();
  }

  /* ---------------- 气泡列表 ---------------- */

  function renderBubbles() {
    if (!state.bubbles) return;
    if (!state.layout) return;
    var list = remainingItems();
    state.layout.classList.toggle('has-bubbles', list.length > 1);
    if (list.length <= 1) {
      state.bubbles.hidden = true;
      state.bubbles.textContent = '';
      return;
    }
    state.bubbles.hidden = false;
    state.bubbles.textContent = '';
    var current = activeIndex();
    list.forEach(function (item, index) {
      var bubble = createEl('button', 'cr-pn-bubble');
      bubble.type = 'button';
      bubble.dataset.id = String(item.id);
      bubble.setAttribute('aria-label', item.title);
      if (index === current) {
        bubble.classList.add('is-active');
        bubble.setAttribute('aria-current', 'true');
      } else {
        bubble.setAttribute('aria-current', 'false');
      }
      var dot = createEl('span', 'cr-pn-bubble-dot');
      dot.setAttribute('aria-hidden', 'true');
      bubble.appendChild(dot);
      bubble.appendChild(createEl('span', 'cr-pn-bubble-index', String(index + 1)));
      bubble.appendChild(createEl('span', 'cr-pn-bubble-title', item.title));
      bubble.style.setProperty('--i', String(index));
      bubble.addEventListener('click', function () { setActive(item.id); });
      state.bubbles.appendChild(bubble);
    });
  }

  /* ---------------- 卡片 ---------------- */

  function buildCard(item, index, total) {
    var card = createEl('article', 'cr-pn-card');
    card.dataset.id = String(item.id);
    card.style.setProperty('--i', String(index));
    card.style.setProperty('--d', '0');
    card.style.setProperty('--d-offset', '0');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-roledescription', global.t ? global.t('通知') : '通知');

    var hero = createEl('div', 'cr-pn-hero');
    hero.setAttribute('aria-hidden', 'true');
    hero.appendChild(createEl('div', 'cr-pn-hero-gradient'));
    hero.appendChild(createEl('div', 'cr-pn-hero-blob cr-pn-hero-blob--a'));
    hero.appendChild(createEl('div', 'cr-pn-hero-blob cr-pn-hero-blob--b'));
    hero.appendChild(createEl('div', 'cr-pn-hero-blob cr-pn-hero-blob--c'));
    hero.appendChild(createEl('div', 'cr-pn-hero-blob cr-pn-hero-blob--d'));
    hero.appendChild(createEl('div', 'cr-pn-hero-sheen'));
    var wordmark = createEl('div', 'cr-pn-wordmark');
    wordmark.appendChild(createEl('span', null, 'CrewRouter'));
    hero.appendChild(wordmark);

    var body = createEl('div', 'cr-pn-card-body');
    var title = createEl('h2', 'cr-pn-title', item.title);
    title.id = 'cr-pn-title-' + item.id;
    body.appendChild(title);
    if (item.body) body.appendChild(createEl('p', 'cr-pn-text', item.body));

    var footer = createEl('div', 'cr-pn-card-footer');
    var counter = createEl('span', 'cr-pn-counter');
    footer.appendChild(counter);
    var closeBtn = createEl('button', 'cr-pn-close');
    closeBtn.type = 'button';
    closeBtn.textContent = item.closeText;
    closeBtn.addEventListener('click', function () { closeCard(item.id); });
    footer.appendChild(closeBtn);

    card.appendChild(hero);
    card.appendChild(body);
    card.appendChild(footer);
    return card;
  }

  function renderCards() {
    state.stage.textContent = '';
    state.items.forEach(function (item, index) {
      state.stage.appendChild(buildCard(item, index, state.items.length));
    });
  }

  /* ---------------- 打开 / 关闭 ---------------- */

  function lockScroll() {
    if (state.lockSnapshot) return;
    var html = global.document.documentElement;
    var body = global.document.body;
    state.lockSnapshot = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPaddingRight: body.style.paddingRight,
    };
    var scrollbar = global.innerWidth - html.clientWidth;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    html.classList.add('cr-pn-lock');
    if (scrollbar > 0) body.style.paddingRight = scrollbar + 'px';
  }

  function unlockScroll() {
    var snapshot = state.lockSnapshot;
    state.lockSnapshot = null;
    if (!snapshot) return;
    var html = global.document.documentElement;
    var body = global.document.body;
    html.style.overflow = snapshot.htmlOverflow || '';
    body.style.overflow = snapshot.bodyOverflow || '';
    body.style.paddingRight = snapshot.bodyPaddingRight || '';
    html.classList.remove('cr-pn-lock');
  }

  function onKeyDown(event) {
    if (!state.dialog) return;
    var list = remainingItems();
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      if (list.length < 2) return;
      event.preventDefault();
      var next = activeIndex() + 1;
      setActive(list[next % list.length].id);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      if (list.length < 2) return;
      event.preventDefault();
      var prev = (activeIndex() - 1 + list.length) % list.length;
      setActive(list[prev].id);
    }
  }

  function clearExitTimer() {
    if (state.exitTimer) {
      global.clearTimeout(state.exitTimer);
      state.exitTimer = null;
    }
  }

  function playEnterAnimation(dialog) {
    if (!dialog) return;
    dialog.classList.remove('is-exiting');
    if (prefersReducedMotion()) {
      dialog.classList.add('is-visible');
      return;
    }
    dialog.classList.remove('is-visible');
    // 强制一次样式结算，确保从缩放/透明起点过渡到可见
    void dialog.offsetWidth;
    var armed = false;
    function arm() {
      if (armed || state.dialog !== dialog || state.closing) return;
      armed = true;
      dialog.classList.add('is-visible');
    }
    // 双 rAF 保证过渡起点落在绘制后；headless/后台页 rAF 可能被节流，用短延时兜底
    if (typeof global.requestAnimationFrame === 'function') {
      global.requestAnimationFrame(function () {
        global.requestAnimationFrame(arm);
      });
    }
    global.setTimeout(arm, 32);
  }

  function teardownOverlay(dialog, opener) {
    clearExitTimer();
    stopFontCycle();
    global.document.removeEventListener('keydown', onKeyDown);
    global.document.removeEventListener('visibilitychange', onVisibilityChange);
    if (state.i18nHandler) {
      global.document.removeEventListener('i18n:ready', state.i18nHandler);
      state.i18nHandler = null;
    }
    if (state.dialog === dialog) {
      state.dialog = null;
      state.layout = null;
      state.bubbles = null;
      state.stage = null;
      state.items = [];
      state.activeId = null;
      state.preview = false;
      state.opener = null;
    }
    state.closing = false;
    if (dialog) {
      try {
        if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      } catch (_) { /* ignore */ }
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
    }
    unlockScroll();
    if (opener && typeof opener.focus === 'function') {
      try { opener.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    }
  }

  function open(items, options) {
    options = options || {};
    var list = normalizeItems(items, options.preview === true);
    if (!list.length) return false;
    if (state.dialog) destroy();
    debug(list.length === 1 ? '打开弹窗通知：' + list[0].title : '打开弹窗通知：' + list.length + ' 条');

    state.items = list;
    state.preview = options.preview === true;
    state.closedIds = new Set();
    state.pendingSeen = new Set();
    state.activeId = list[0].id;
    state.fontIndex = 0;
    state.fontList = null;
    state.closing = false;
    state.opener = global.document.activeElement;

    var dialog = global.document.createElement('dialog');
    dialog.className = 'cr-pn-overlay lg-scope';
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'cr-pn-title-' + list[0].id);
    if (state.preview) dialog.setAttribute('data-preview', 'true');

    var layout = createEl('div', 'cr-pn-layout');
    var bubbles = createEl('nav', 'cr-pn-bubbles');
    bubbles.setAttribute('aria-label', global.t ? global.t('通知列表') : '通知列表');
    bubbles.hidden = true;
    var stage = createEl('div', 'cr-pn-stage');
    layout.appendChild(bubbles);
    layout.appendChild(stage);
    dialog.appendChild(layout);

    state.dialog = dialog;
    state.layout = layout;
    state.bubbles = bubbles;
    state.stage = stage;

    renderCards();
    renderBubbles();

    global.document.body.appendChild(dialog);

    var fallback = typeof dialog.showModal !== 'function';
    if (fallback) {
      dialog.classList.add('is-fallback');
      dialog.setAttribute('open', '');
    } else {
      try { dialog.showModal(); } catch (error) { warn('showModal 失败，回退 fixed 浮层', error); dialog.classList.add('is-fallback'); dialog.setAttribute('open', ''); }
    }

    lockScroll();
    playEnterAnimation(dialog);

    dialog.addEventListener('cancel', function (event) {
      event.preventDefault();
      if (state.closing) return;
      if (state.activeId != null) closeCard(state.activeId);
    });
    dialog.addEventListener('keydown', onKeyDown);
    // 原生 dialog 点击 ::backdrop 时 target 就是 dialog 本身；不在此关闭，避免误触
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) event.stopPropagation();
    });

    global.document.addEventListener('keydown', onKeyDown);
    global.document.addEventListener('visibilitychange', onVisibilityChange);
    state.i18nHandler = function () { renderBubbles(); };
    global.document.addEventListener('i18n:ready', state.i18nHandler);

    setActive(list[0].id);
    // 入场后再聚焦关闭按钮，避免打断缩放淡入
    global.setTimeout(function () {
      if (state.dialog !== dialog || state.closing) return;
      var card = cardById(state.activeId);
      var button = card && card.querySelector('.cr-pn-close');
      if (button) { try { button.focus({ preventScroll: true }); } catch (_) { button.focus(); } }
    }, prefersReducedMotion() ? 30 : Math.min(120, OVERLAY_ENTER_MS));
    return true;
  }

  function closeCard(id) {
    id = Number(id);
    if (state.closing) return;
    if (!state.items.some(function (item) { return item.id === id; })) return;
    state.closedIds.add(id);
    queueSeen(id);
    flushSeen();

    var card = cardById(id);
    if (card) {
      card.classList.add('is-leaving');
      global.setTimeout(function () {
        if (card && card.parentNode) card.parentNode.removeChild(card);
      }, prefersReducedMotion() ? 0 : CARD_LEAVE_MS);
    }
    var list = remainingItems();
    if (!list.length) {
      closeAll();
      return;
    }
    var nextIndex = activeIndex();
    if (nextIndex >= list.length) nextIndex = 0;
    setActive(list[nextIndex].id);
  }

  function closeAll(options) {
    options = options || {};
    var dialog = state.dialog;
    if (!dialog) {
      unlockScroll();
      return;
    }
    if (state.closing && !options.immediate) return;

    flushSeen();
    stopFontCycle();

    var opener = state.opener;
    var immediate = options.immediate === true || prefersReducedMotion();

    if (immediate) {
      teardownOverlay(dialog, opener);
      return;
    }

    state.closing = true;
    dialog.classList.remove('is-visible');
    dialog.classList.add('is-exiting');
    // 离场期间仍保留 dialog 引用，避免重复打开时序错乱；交互已由 is-exiting 关掉
    clearExitTimer();
    state.exitTimer = global.setTimeout(function () {
      state.exitTimer = null;
      teardownOverlay(dialog, opener);
    }, OVERLAY_EXIT_MS);
  }

  function destroy() {
    flushSeen();
    state.closedIds = new Set();
    state.pendingSeen = new Set();
    if (state.seenFlushTimer) {
      global.clearTimeout(state.seenFlushTimer);
      state.seenFlushTimer = null;
    }
    closeAll({ immediate: true });
  }

  /* ---------------- 拉取 ---------------- */

  function mount() {
    var url = '/api/user/popup-notices';
    try {
      if (global.sessionStorage && global.sessionStorage.getItem('crPopupDemo') === '1') {
        url += '?popupDemo=1';
      }
    } catch (_) { /* ignore */ }
    return global.fetch(url, { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) return null;
        return response.json();
      })
      .then(function (items) {
        if (!Array.isArray(items) || !items.length) return false;
        return open(items);
      })
      .catch(function (error) { warn('拉取弹窗通知失败', error); return false; });
  }

  function preview(items) {
    return open(items, { preview: true });
  }

  global.CrewRouterPopupNotices = {
    mount: mount,
    open: open,
    show: function (items) { return open(items); },
    preview: preview,
    isOpen: function () { return !!(state.dialog && state.dialog.isConnected); },
    close: closeAll,
    destroy: destroy,
    _internal: state,
  };
})(window);
