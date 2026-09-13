/* Shared Blora theme bridge. The theming add-on is vendored with blora-design. */
(function () {
  'use strict';
  var THEMES = ['system', 'light', 'dark'];
  function resolve(mode) {
    return mode === 'system' ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
  }
  function apply(mode, persist) {
    mode = THEMES.includes(mode) ? mode : 'system';
    var resolved = resolve(mode);
    var root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    root.classList.toggle('light', resolved !== 'dark');
    root.setAttribute('data-blora-color-scheme', resolved);
    root.setAttribute('data-blora-theme', mode);
    if (persist !== false) localStorage.setItem('theme', mode);
    document.querySelectorAll('.theme-toggle-control').forEach(function (el) {
      el.setAttribute('aria-label', mode === 'dark' ? '当前：深色' : mode === 'light' ? '当前：浅色' : '当前：跟随系统');
    });
  }
  window.CrewBloraTheme = {
    get: function () { return localStorage.getItem('theme') || 'system'; },
    apply: apply,
    toggle: function () { var current = this.get(); apply(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]); },
    setDirection: function (direction) { document.documentElement.dir = direction === 'rtl' ? 'rtl' : 'ltr'; }
  };
  apply(window.CrewBloraTheme.get(), false);
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('#themeToggle, #themeToggleMobile').forEach(function (button) {
      button.classList.add('theme-toggle-control');
      button.addEventListener('click', function () { window.CrewBloraTheme.toggle(); });
    });
    var media = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    media && media.addEventListener && media.addEventListener('change', function () { if (window.CrewBloraTheme.get() === 'system') apply('system', false); });
  });
}());
