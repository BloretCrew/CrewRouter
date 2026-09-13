/* CrewRouter adapter for the vendored Blora Theming add-on. */
(function () {
  'use strict';
  var THEMES = ['coral', 'indigo', 'graphite', 'mono', 'circuit', 'dusk'];
  function resolveColorScheme() {
    var mode = localStorage.getItem('color-scheme') || localStorage.getItem('theme') || 'system';
    return mode === 'dark' || (mode === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  function applyCompat(mode) {
    var root = document.documentElement;
    var scheme = resolveColorScheme();
    root.setAttribute('data-blora-theme', THEMES.includes(mode) ? mode : (localStorage.getItem('blora-theme') || 'graphite'));
    root.setAttribute('data-blora-color-scheme', scheme);
    root.classList.toggle('dark', scheme === 'dark');
    root.classList.toggle('light', scheme !== 'dark');
    root.dir = root.dir || 'ltr';
  }
  function cycleTheme() {
    var current = localStorage.getItem('blora-theme') || 'graphite';
    var next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    localStorage.setItem('blora-theme', next);
    applyCompat(next);
    window.dispatchEvent(new CustomEvent('blora-theme-change', { detail: { theme: next } }));
  }
  window.CrewBloraTheme = { get: function () { return localStorage.getItem('blora-theme') || 'graphite'; }, apply: applyCompat, toggle: cycleTheme, setDirection: function (direction) { document.documentElement.dir = direction === 'rtl' ? 'rtl' : 'ltr'; } };
  applyCompat(window.CrewBloraTheme.get());
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('#themeToggle, #themeToggleMobile').forEach(function (button) {
      button.classList.add('theme-toggle-control');
      button.addEventListener('click', cycleTheme);
    });
  });
}());
