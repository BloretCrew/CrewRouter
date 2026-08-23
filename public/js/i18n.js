/**
 * CrewRouter i18n — client helpers.
 * Pattern ported from Bloret Translation Collector (window.BTC.t).
 * Catalog: source-as-key (Chinese original → translation). Missing key falls back to the key itself.
 */
(function () {
  'use strict';

  var LANG_KEY = 'cr_lang';

  var I18N = {
    lang: 'zh',
    catalog: Object.create(null),

    t: function (key, vars) {
      if (key == null || key === '') return key;
      var cat = this.catalog || Object.create(null);
      var out = cat[key];
      // '' (explicitly set) renders nothing — used for measure-word fragments;
      // only a MISSING key falls back to the Chinese source.
      if (out == null) out = key;
      if (vars && typeof out === 'string') {
        out = out.replace(/\{(\w+)\}/g, function (_, k) {
          return vars[k] != null ? String(vars[k]) : '{' + k + '}';
        });
      }
      return out;
    },

    /** Apply translations to DOM: [data-i18n] textContent, [data-i18n-placeholder], [data-i18n-title]. */
    applyDom: function (root) {
      root = root || document;
      var self = this;
      root.querySelectorAll('[data-i18n]').forEach(function (el) {
        var key = el.getAttribute('data-i18n');
        if (key != null && key !== '') {
          // <title> 的内容只能为纯文本，不能包裹子标签，否则标签串会被当作字面标题；
          // 因此对 <title> 直接设置 document.title，其余元素沿用 textContent。
          if (el.tagName === 'TITLE') {
            document.title = self.t(key);
          } else {
            el.textContent = self.t(key);
          }
        }
      });
      root.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
        var key = el.getAttribute('data-i18n-placeholder');
        if (key != null && key !== '') el.setAttribute('placeholder', self.t(key));
      });
      root.querySelectorAll('[data-i18n-title]').forEach(function (el) {
        var key = el.getAttribute('data-i18n-title');
        if (key != null && key !== '') el.setAttribute('title', self.t(key));
      });
    },

    setLang: function (lang) {
      this.lang = lang;
      try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* ignore */ }
      document.documentElement.setAttribute('lang', lang === 'zh' ? 'zh-CN' : lang);
      this.applyDom();
    },

    /** Load catalog for a language from our server proxy, then apply to DOM. */
    load: function (lang) {
      var self = this;
      lang = lang || this.current();
      return fetch('/api/i18n/catalog?locale=' + encodeURIComponent(lang))
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (cat) {
          if (cat && typeof cat === 'object') {
            self.catalog = cat;
            self.catalog.__loaded = true;
          }
          self.setLang(lang);
          document.dispatchEvent(new CustomEvent('i18n:ready', { detail: { lang: lang } }));
          return lang;
        })
        .catch(function () {
          self.setLang(lang);
          return lang;
        });
    },

    current: function () {
      try {
        var saved = localStorage.getItem(LANG_KEY);
        if (saved) return saved;
      } catch (e) { /* ignore */ }
      return 'zh';
    }
  };

  window.I18N = I18N;
  window.t = function (key, vars) { return I18N.t(key, vars); };

  // Boot: hydrate catalog before app scripts render.
  var cur = I18N.current();
  document.documentElement.setAttribute('lang', cur === 'zh' ? 'zh-CN' : cur);
  I18N.load(cur);

  // Wire up language switchers (sidebar footer + mobile topbar) once DOM is ready.
  function wireSwitchers() {
    ['langToggle', 'langToggleMobile'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el || el.dataset.i18nWired) return;
      el.dataset.i18nWired = '1';
      el.value = I18N.current();
      el.addEventListener('change', function () {
        I18N.load(el.value);
        var other = document.getElementById(id === 'langToggle' ? 'langToggleMobile' : 'langToggle');
        if (other) other.value = el.value;
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireSwitchers);
  } else {
    wireSwitchers();
  }
})();
