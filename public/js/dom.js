/**
 * CrewRouter DOM 工具
 *
 * 规范：
 * - 业务代码不要直接写 element.innerHTML = ...
 * - 用 html`...${value}...` 拼装（value 自动转义）
 * - 用 setHTML(el, html`...`) 写入
 * - 纯文本用 setText(el, text)
 * - 结构节点用 el() / clearChildren()
 *
 * 说明：浏览器最终仍需解析 HTML 字符串才能渲染富结构；
 * 本模块把「唯一允许的解析入口」集中在 setHTML/parseHTML，
 * 并通过标签模板自动 escape，避免 XSS 与散落拼装。
 */
(function (global) {
  'use strict';

  function escapeHtml(str) {
    if (str == null || str === false) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 已信任的 HTML 片段（不会被二次 escape） */
  class SafeHTML {
    constructor(html) {
      this.html = html == null ? '' : String(html);
    }
    toString() {
      return this.html;
    }
    valueOf() {
      return this.html;
    }
  }

  function raw(html) {
    if (html instanceof SafeHTML) return html;
    return new SafeHTML(html == null ? '' : String(html));
  }

  function serializeValue(value) {
    if (value == null || value === false) return '';
    if (value === true) return 'true';
    if (value instanceof SafeHTML) return value.html;
    if (Array.isArray(value)) return value.map(serializeValue).join('');
    if (value instanceof Node) {
      console.warn(t('[dom] html`...` 中插入了 DOM Node，已忽略。请改用 el()/append'));
      return '';
    }
    return escapeHtml(value);
  }

  /**
   * 安全 HTML 标签模板。
   * 插值默认 escape；传入 raw(...) 或 html`...` 结果可保留 HTML。
   */
  function html(strings, ...values) {
    let out = '';
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < values.length) out += serializeValue(values[i]);
    }
    return new SafeHTML(out);
  }

  function toHtmlString(content) {
    if (content instanceof SafeHTML) return content.html;
    if (content == null) return '';
    return String(content);
  }

  function resolveEl(el) {
    if (!el) return null;
    if (typeof el === 'string') return document.querySelector(el);
    return el;
  }

  function getBloraChecked(control) {
    return !!(control && (control.checked === true || control.hasAttribute('checked')));
  }

  function setBloraChecked(control, checked) {
    if (!control) return;
    if ('checked' in control) control.checked = !!checked;
    control.toggleAttribute('checked', !!checked);
  }

  function getBloraValue(control) {
    if (!control) return '';
    if (control.tagName === 'BLORA-RANGE') return control.values?.[0] ?? control.getAttribute('values')?.split(',')[0] ?? '';
    return control.value ?? control.getAttribute('value') ?? '';
  }

  global.getBloraChecked = getBloraChecked;
  global.setBloraChecked = setBloraChecked;
  global.getBloraValue = getBloraValue;
  global.getBloraCheckedControls = (selector, root = document) => [...root.querySelectorAll(selector)].filter(getBloraChecked);

  /** 唯一推荐的 HTML 写入入口（替代 el.innerHTML = ...） */
  let bloraUpgradeDepth = 0;

  function isBloraHost(el) {
    return !!el && typeof el.tagName === 'string' && el.tagName.startsWith('BLORA-');
  }

  function collectMatches(scope, selector) {
    const list = [];
    if (scope.matches?.(selector)) list.push(scope);
    if (scope.querySelectorAll) list.push(...scope.querySelectorAll(selector));
    return list;
  }

  function upgradeBloraControls(root) {
    if (bloraUpgradeDepth > 0) return;
    const scope = root && root.querySelectorAll ? root : document;
    if (scope.nodeType === Node.ELEMENT_NODE && (isBloraHost(scope) && scope.tagName !== 'BLORA-SELECT' && scope.tagName !== 'BLORA-DIALOG')) {
      return;
    }
    bloraUpgradeDepth++;
    try {
      collectMatches(scope, 'input[type="date"]').forEach((input) => {
        if (isBloraHost(input) || input.closest?.('blora-datepicker')) return;
        const replacement = document.createElement('blora-datepicker');
        [...input.attributes].forEach((attr) => replacement.setAttribute(attr.name, attr.name === 'class' ? `${attr.value} blora-input` : attr.value));
        if (input.value) replacement.setAttribute('value', input.value);
        input.replaceWith(replacement);
      });
      collectMatches(scope, 'input[type="time"]').forEach((input) => {
        if (isBloraHost(input) || input.closest?.('blora-timepicker')) return;
        const replacement = document.createElement('blora-timepicker');
        [...input.attributes].forEach((attr) => replacement.setAttribute(attr.name, attr.name === 'class' ? `${attr.value} blora-input` : attr.value));
        if (input.value) replacement.setAttribute('value', input.value);
        input.replaceWith(replacement);
      });
      const enhanceToggle = (input, tagName) => {
        if (isBloraHost(input) || input.closest?.('blora-checkbox, blora-switch')) return;
        const replacement = document.createElement(tagName);
        [...input.attributes].forEach((attr) => {
          if (attr.name === 'type' || attr.name === 'class') return;
          replacement.setAttribute(attr.name, attr.value);
        });
        if (input.checked) replacement.setAttribute('checked', '');
        if (input.value && input.value !== 'on') replacement.setAttribute('value', input.value);
        const parentLabel = input.closest('label');
        const labelText = input.getAttribute('aria-label') || parentLabel?.textContent?.trim() || '';
        if (labelText) replacement.setAttribute('label', labelText);
        if (input.className) replacement.className = input.className;
        replacement.classList.remove('blora-input');
        input.replaceWith(replacement);
      };
      collectMatches(scope, 'input[type="checkbox"]').forEach((input) => {
        enhanceToggle(input, input.closest('label.pg-toggle') ? 'blora-switch' : 'blora-checkbox');
      });
      collectMatches(scope, 'input[type="range"]').forEach((input) => {
        if (isBloraHost(input) || input.closest?.('blora-range')) return;
        const replacement = document.createElement('blora-range');
        [...input.attributes].forEach((attr) => {
          if (!['type', 'class', 'value'].includes(attr.name)) replacement.setAttribute(attr.name, attr.value);
        });
        if (input.min) replacement.setAttribute('min', input.min);
        if (input.max) replacement.setAttribute('max', input.max);
        const value = input.value || input.min || 0;
        replacement.setAttribute('values', `${value},${value}`);
        if (input.id) replacement.id = input.id;
        if (input.getAttribute('oninput')) replacement.setAttribute('data-oninput', input.getAttribute('oninput'));
        replacement.className = input.className;
        replacement.classList.remove('blora-input');
        input.replaceWith(replacement);
      });

      const enhanceButtons = () => {
        collectMatches(scope, 'button').forEach((button) => {
          if (isBloraHost(button) || button.closest?.('blora-select')) return;
          if (button.classList.contains('blora-button') && button.dataset.variant && button.dataset.size) return;
          const legacy = button.classList;
          const variant = button.dataset.variant || (legacy.contains('btn-primary') ? 'primary' : legacy.contains('btn-danger') ? 'danger' : legacy.contains('btn-ghost') ? 'ghost' : legacy.contains('btn-secondary') ? 'secondary' : 'secondary');
          const size = button.dataset.size || (legacy.contains('btn-icon') ? 'icon' : legacy.contains('btn-sm') ? 'sm' : 'md');
          button.classList.add('blora-button');
          ['btn', 'btn-primary', 'btn-danger', 'btn-ghost', 'btn-secondary', 'btn-outline', 'btn-link', 'btn-icon', 'btn-sm', 'btn-lg'].forEach((name) => legacy.remove(name));
          button.dataset.variant = variant;
          button.dataset.size = size;
          if (!button.type) button.type = 'button';
        });
      };

      if (!customElements.get('blora-select')) {
        enhanceButtons();
        return;
      }

      const normalizeOptions = (select) => {
        select.querySelectorAll(':scope > option').forEach((option) => {
          const replacement = document.createElement('blora-option');
          [...option.attributes].forEach((attr) => replacement.setAttribute(attr.name, attr.value));
          replacement.textContent = option.textContent;
          option.replaceWith(replacement);
        });
      };
      collectMatches(scope, 'blora-select').forEach(normalizeOptions);
      collectMatches(scope, 'select:not(blora-select)').forEach((select) => {
        if (isBloraHost(select)) return;
        const replacement = document.createElement('blora-select');
        [...select.attributes].forEach((attr) => replacement.setAttribute(attr.name, attr.value));
        [...select.options].forEach((option) => {
          const item = document.createElement('blora-option');
          [...option.attributes].forEach((attr) => item.setAttribute(attr.name, attr.value));
          item.textContent = option.textContent;
          replacement.appendChild(item);
        });
        if (select.value) replacement.setAttribute('value', select.value);
        select.replaceWith(replacement);
      });
      enhanceButtons();
      collectMatches(scope, 'input').forEach((input) => {
        if (isBloraHost(input)) return;
        input.classList.add('blora-input');
        input.classList.remove('input', 'form-input');
      });
      collectMatches(scope, 'textarea').forEach((textarea) => {
        if (isBloraHost(textarea)) return;
        textarea.classList.add('blora-textarea');
        textarea.classList.remove('input', 'textarea', 'form-input');
      });
      collectMatches(scope, 'blora-select').forEach((select) => select.classList.remove('select', 'form-input'));
      collectMatches(scope, 'table').forEach((table) => table.classList.add('blora-table'));
    } finally {
      bloraUpgradeDepth--;
    }
  }

  function observeBloraControls() {
    if (!window.MutationObserver || document.documentElement.dataset.bloraObserver) return;
    document.documentElement.dataset.bloraObserver = '1';
    new MutationObserver((records) => {
      if (bloraUpgradeDepth > 0) return;
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (isBloraHost(node) || node.closest?.('blora-option, blora-select')) return;
        upgradeBloraControls(node);
      }));
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  observeBloraControls();

  function normalizeBloraMarkup(content) {
    return toHtmlString(content)
      .replace(/<option\b/gi, '<blora-option')
      .replace(/<\/option>/gi, '</blora-option>');
  }

  function isAllowedInlineHandler(value) {
    const code = String(value || '').trim();
    return /^(?:(?:event|this)\.[A-Za-z_$][\w$]*\([^;]*\);\s*)*(?:(?:app|adminApp)\.[A-Za-z_$][\w$]*|(?:showDocPage|saveDocsContent|openDocsEditor)\s*\()/u.test(code);
  }

  function sanitizeHtml(content) {
    const template = document.createElement('template');
    template.innerHTML = normalizeBloraMarkup(content);
    const dangerous = template.content.querySelectorAll('script, iframe, object, embed, link, meta, style');
    dangerous.forEach((el) => el.remove());
    template.content.querySelectorAll('*').forEach((el) => {
      [...el.attributes].forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') && !isAllowedInlineHandler(attr.value)) {
          el.removeAttribute(attr.name);
        } else if ((name === 'href' || name === 'src' || name === 'action') && !/^(https?:|mailto:|#|\/)/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      });
    });
    return template.innerHTML;
  }

  function setHTML(el, content) {
    const node = resolveEl(el);
    if (!node) return null;
    node.innerHTML = sanitizeHtml(content);
    upgradeBloraControls(node);
    return node;
  }

  function appendHTML(el, content) {
    const node = resolveEl(el);
    if (!node) return null;
    node.insertAdjacentHTML('beforeend', normalizeBloraMarkup(content));
    upgradeBloraControls(node);
    return node;
  }

  function setText(el, text) {
    const node = resolveEl(el);
    if (!node) return null;
    node.textContent = text == null ? '' : String(text);
    return node;
  }

  function clearChildren(el) {
    const node = resolveEl(el);
    if (!node) return null;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function parseHTML(content) {
    const tpl = document.createElement('template');
    tpl.innerHTML = toHtmlString(content);
    return tpl.content;
  }

  function replaceChildrenHTML(el, content) {
    const node = resolveEl(el);
    if (!node) return null;
    const frag = parseHTML(normalizeBloraMarkup(content));
    clearChildren(node);
    node.appendChild(frag);
    upgradeBloraControls(node);
    return node;
  }

  /**
   * 创建元素（结构化 API，适合简单节点）
   * el('button', { className: 'btn', onClick: fn }, '保存')
   */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((key) => {
        const val = props[key];
        if (val == null || val === false) return;
        if (key === 'className' || key === 'class') {
          node.className = val;
        } else if (key === 'style' && typeof val === 'object') {
          Object.assign(node.style, val);
        } else if (key === 'dataset' && typeof val === 'object') {
          Object.keys(val).forEach((dk) => {
            if (val[dk] != null) node.dataset[dk] = String(val[dk]);
          });
        } else if (key.startsWith('on') && typeof val === 'function') {
          const evt = key.slice(2).toLowerCase();
          node.addEventListener(evt, val);
        } else if (key === 'html') {
          setHTML(node, val);
        } else if (key === 'text') {
          node.textContent = String(val);
        } else if (key in node) {
          try { node[key] = val; } catch (_) { node.setAttribute(key, String(val)); }
        } else {
          node.setAttribute(key, val === true ? '' : String(val));
        }
      });
    }
    children.flat(Infinity).forEach((child) => {
      if (child == null || child === false) return;
      if (child instanceof Node) node.appendChild(child);
      else if (child instanceof SafeHTML) appendHTML(node, child);
      else node.appendChild(document.createTextNode(String(child)));
    });
    return node;
  }

  /**
   * 圆环 Spinner HTML（对齐 LoadingAnimationDesign）
   * @param {'sm'|'md'|'lg'|''} [size]
   * @returns {string}
   */
  function loadingSpinnerHtml(size) {
    const s = size === 'sm' || size === 'md' || size === 'lg' ? size : '';
    const cls = s ? `loading-spinner ${s}` : 'loading-spinner';
    return `<div class="${cls}" role="status" aria-label="${t('加载中')}"></div>`;
  }

  /**
   * 页面/列表加载占位（垂直居中圆环 + 文案）
   * @param {string} [text='加载中...']
   * @param {{ size?: 'sm'|'md'|'lg'|'', compact?: boolean, minHeight?: string, padding?: string }} [options]
   * @returns {string}
   */
  function pageLoadingHtml(text, options) {
    const opts = options || {};
    const label = text == null || text === '' ? t('加载中...') : String(text);
    const size = opts.size || '';
    const compact = !!opts.compact;
    const minHeight = opts.minHeight || (compact ? '100px' : '180px');
    const padding = opts.padding || (compact ? '20px 12px' : '32px 16px');
    const extraClass = compact ? ' page-loading-compact' : '';
    return (
      `<div class="page-loading${extraClass}" style="min-height:${escapeHtml(minHeight)};padding:${escapeHtml(padding)};">` +
      loadingSpinnerHtml(size) +
      `<div class="page-loading-text">${escapeHtml(label)}</div>` +
      `</div>`
    );
  }

  /**
   * 行内加载（小环 + 文案）
   * @param {string} [text='加载中...']
   * @param {'sm'|'md'|''} [size='sm']
   * @returns {string}
   */
  function inlineLoadingHtml(text, size) {
    const label = text == null ? '' : String(text);
    const s = size === undefined || size === null ? 'sm' : size;
    return (
      `<span class="inline-loading">` +
      loadingSpinnerHtml(s) +
      (label ? `<span class="inline-loading-text">${escapeHtml(label)}</span>` : '') +
      `</span>`
    );
  }

  /**
   * 按钮进入加载态（禁用 + 圆环 + 文案），会缓存原 innerHTML
   * @param {Element|string} btn
   * @param {string} [text='处理中...']
   */
  function setButtonLoading(btn, text) {
    const node = resolveEl(btn);
    if (!node) return null;
    if (node.dataset.loadingOriginalHtml == null) {
      node.dataset.loadingOriginalHtml = node.innerHTML;
    }
    node.disabled = true;
    node.classList.add('is-loading');
    setHTML(node, inlineLoadingHtml(text == null ? t('处理中...') : String(text), 'sm'));
    return node;
  }

  /**
   * 恢复按钮加载态
   * @param {Element|string} btn
   * @param {string} [fallbackText] 无缓存 HTML 时用纯文本回退
   */
  function clearButtonLoading(btn, fallbackText) {
    const node = resolveEl(btn);
    if (!node) return null;
    node.disabled = false;
    node.classList.remove('is-loading');
    if (node.dataset.loadingOriginalHtml != null) {
      setHTML(node, node.dataset.loadingOriginalHtml);
      delete node.dataset.loadingOriginalHtml;
    } else if (fallbackText != null) {
      node.textContent = String(fallbackText);
    }
    return node;
  }

  const api = {
    escapeHtml,
    SafeHTML,
    raw,
    html,
    setHTML,
    appendHTML,
    setText,
    clearChildren,
    parseHTML,
    replaceChildrenHTML,
    el,
    loadingSpinnerHtml,
    pageLoadingHtml,
    inlineLoadingHtml,
    setButtonLoading,
    clearButtonLoading,
    readCssVar,
  };

  /**
   * 读取 :root CSS 变量值（供 canvas / Chart.js 等无法解析 var() 的场景）。
   * 使用：readCssVar('--chart-1') 或 readCssVar('--chart-1', '#0ea5e9')（兜底）。
   */
  function readCssVar(name, fallback) {
    if (!name) return fallback || '';
    const n = name.startsWith('--') ? name : `--${name}`;
    const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return v || (fallback || '');
  }

  // 全局导出（兼容现有非模块脚本）
  global.Dom = api;
  global.escapeHtml = escapeHtml;
  global.html = html;
  global.raw = raw;
  global.setHTML = setHTML;
  global.upgradeBloraControls = upgradeBloraControls;
  global.appendHTML = appendHTML;
  global.setText = setText;
  global.clearChildren = clearChildren;
  global.el = el;
  global.loadingSpinnerHtml = loadingSpinnerHtml;
  global.pageLoadingHtml = pageLoadingHtml;
  global.inlineLoadingHtml = inlineLoadingHtml;
  global.setButtonLoading = setButtonLoading;
  global.clearButtonLoading = clearButtonLoading;
  global.readCssVar = readCssVar;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
