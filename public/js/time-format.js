'use strict';

/**
 * 全站时间展示工具：数据库 UTC 存储，浏览器本地时区展示，
 * 悬停/聚焦时显示常用时区的对应时间。
 */
(function () {
  if (window.CRTime) return;

  const DEFAULT_ZONES = [
    { key: 'local', labelKey: '本地时间' },
    { key: 'UTC', label: 'UTC' },
    { key: 'Asia/Shanghai', label: 'Asia/Shanghai' },
    { key: 'America/New_York', label: 'America/New_York' },
    { key: 'Europe/London', label: 'Europe/London' },
  ];

  function locale() {
    const lang = window.I18N?.lang || (document.documentElement.lang || 'zh');
    return String(lang).toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
  }

  function toDate(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number') {
      const ms = value < 1e12 ? value * 1000 : value;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const text = String(value).trim();
    if (!text) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function zoneLabel(zone) {
    if (zone.key === 'local') return window.I18N?.t ? window.I18N.t('本地时间') : '本地时间';
    return zone.label || zone.key;
  }

  function formatValue(value, options = {}) {
    const date = toDate(value);
    if (!date) return options.fallback ?? '-';
    const mode = options.mode || 'datetime';
    if (mode === 'relative') return formatRelative(value, options);
    const withSeconds = options.seconds !== false;
    const base = { locale: options.locale || locale(), timeZone: options.timeZone && options.timeZone !== 'local' ? options.timeZone : undefined };
    if (mode === 'date') {
      return new Intl.DateTimeFormat(base.locale, { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: base.timeZone }).format(date);
    }
    if (mode === 'time') {
      return new Intl.DateTimeFormat(base.locale, {
        hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}),
        hour12: false, timeZone: base.timeZone,
      }).format(date);
    }
    return new Intl.DateTimeFormat(base.locale, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}),
      hour12: false, timeZone: base.timeZone,
    }).format(date);
  }

  function formatRelative(value, options = {}) {
    const date = toDate(value);
    if (!date) return options.fallback ?? '-';
    const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
    const abs = Math.abs(diffSeconds);
    const rtf = new Intl.RelativeTimeFormat(options.locale || locale(), { numeric: 'auto' });
    if (abs < 60) return rtf.format(diffSeconds, 'second');
    if (abs < 3600) return rtf.format(Math.round(diffSeconds / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diffSeconds / 3600), 'hour');
    if (abs < 2592000) return rtf.format(Math.round(diffSeconds / 86400), 'day');
    if (abs < 31536000) return rtf.format(Math.round(diffSeconds / 2592000), 'month');
    return rtf.format(Math.round(diffSeconds / 31536000), 'year');
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function formatZones(value, zones = DEFAULT_ZONES) {
    const date = toDate(value);
    if (!date) return [];
    return zones.map(zone => ({
      key: zone.key,
      label: zoneLabel(zone),
      value: formatValue(date, { timeZone: zone.key, seconds: true }),
    }));
  }

  function formatTimeHtml(value, options = {}) {
    const date = toDate(value);
    if (!date) return escapeHtml(options.fallback ?? '-');
    const mode = options.mode || 'datetime';
    const text = formatValue(date, options);
    const iso = date.toISOString();
    return `<time class="cr-time" datetime="${iso}" data-cr-time="${iso}" data-cr-time-mode="${escapeHtml(mode)}" tabindex="0" title="${escapeHtml(formatValue(date, { ...options, mode: 'datetime' }))}">${escapeHtml(text)}</time>`;
  }

  let tooltip = null;
  let tooltipTimer = null;
  let activeEl = null;

  function ensureTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.id = 'cr-time-tooltip';
    tooltip.className = 'cr-time-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function positionTooltip(el) {
    const tip = ensureTooltip();
    const rect = el.getBoundingClientRect();
    const gap = 8;
    tip.style.visibility = 'hidden';
    tip.dataset.visible = 'true';
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    let left = rect.left;
    let top = rect.bottom + gap;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    if (top + height > window.innerHeight - 8) top = rect.top - height - gap;
    if (top < 8) top = 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = 'visible';
  }

  function renderTooltip(el) {
    const tip = ensureTooltip();
    const iso = el.dataset.crTime;
    const mode = el.dataset.crTimeMode || 'datetime';
    const date = toDate(iso);
    if (!date) return;
    const rows = formatZones(date);
    tip.innerHTML = `
      <div class="cr-time-tooltip-title">${escapeHtml(formatValue(date, { mode: 'datetime', seconds: true }))}</div>
      <dl class="cr-time-tooltip-list">
        ${rows.map(row => `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`).join('')}
      </dl>
      <div class="cr-time-tooltip-hint">${escapeHtml(window.I18N?.t ? window.I18N.t('按浏览器时区显示') : '按浏览器时区显示')}</div>
    `;
    positionTooltip(el);
    tip.setAttribute('aria-hidden', 'false');
    if (mode) el.setAttribute('aria-describedby', 'cr-time-tooltip');
  }

  function showFor(el) {
    if (!el || activeEl === el) return;
    clearTimeout(tooltipTimer);
    activeEl = el;
    tooltipTimer = setTimeout(() => renderTooltip(el), 80);
  }

  function hide() {
    clearTimeout(tooltipTimer);
    activeEl = null;
    if (tooltip) {
      tooltip.dataset.visible = 'false';
      tooltip.setAttribute('aria-hidden', 'true');
    }
  }

  function targetFromEvent(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-cr-time]') : null;
    return target;
  }

  function enhance(root = document) {
    if (root instanceof Element && root.matches('[data-cr-time]')) {
      if (!root.getAttribute('title')) root.setAttribute('title', formatValue(root.dataset.crTime));
    }
    root.querySelectorAll?.('[data-cr-time]').forEach(el => {
      if (!el.getAttribute('title')) el.setAttribute('title', formatValue(el.dataset.crTime));
    });
  }

  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener('pointerover', event => {
      const el = targetFromEvent(event);
      if (el) showFor(el);
    }, true);
    document.addEventListener('pointerout', event => {
      const el = targetFromEvent(event);
      if (el && !el.contains(event.relatedTarget)) hide();
    }, true);
    document.addEventListener('focusin', event => {
      const el = targetFromEvent(event);
      if (el) showFor(el);
    }, true);
    document.addEventListener('focusout', event => {
      if (targetFromEvent(event)) hide();
    }, true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') hide();
    });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    if (typeof MutationObserver !== 'undefined') {
      let scheduled = false;
      const observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => { scheduled = false; enhance(); }, 100);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function injectStyle() {
    if (document.getElementById('cr-time-style')) return;
    const style = document.createElement('style');
    style.id = 'cr-time-style';
    style.textContent = `
      .cr-time{text-decoration:underline dotted;text-underline-offset:2px;cursor:help}
      .cr-time-tooltip{position:fixed;z-index:10000;pointer-events:none;max-width:min(380px,92vw);
        padding:10px 12px;border:1px solid var(--border, rgba(120,120,120,.28));border-radius:10px;
        background:var(--popover, var(--card, #fff));color:var(--popover-foreground, var(--foreground, #111));
        box-shadow:0 10px 30px rgba(0,0,0,.18);font-size:12px;line-height:1.5;
        opacity:0;transform:translateY(4px);transition:opacity .12s,transform .12s;visibility:hidden}
      .cr-time-tooltip[data-visible="true"]{opacity:1;transform:translateY(0);visibility:visible}
      .cr-time-tooltip-title{font-weight:600;margin-bottom:6px}
      .cr-time-tooltip-list{display:grid;gap:2px;margin:0}
      .cr-time-tooltip-list>div{display:flex;justify-content:space-between;gap:16px}
      .cr-time-tooltip-list dt{color:var(--muted-foreground,#6b7280);margin:0}
      .cr-time-tooltip-list dd{margin:0;font-variant-numeric:tabular-nums}
      .cr-time-tooltip-hint{margin-top:6px;color:var(--muted-foreground,#6b7280);font-size:11px}
      @media (prefers-reduced-motion: reduce){.cr-time-tooltip{transition:none}}
    `;
    document.head.appendChild(style);
  }

  function init() {
    injectStyle();
    bind();
    enhance();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.CRTime = {
    DEFAULT_ZONES,
    formatTime: formatValue,
    formatDate: (value, options = {}) => formatValue(value, { ...options, mode: 'date' }),
    formatRelative,
    formatZones,
    formatTimeHtml,
    enhance,
  };
})();
