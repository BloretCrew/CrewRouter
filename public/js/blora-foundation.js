/* Shared Blora bootstrap for public pages. */
(function () {
  'use strict';
  function syncScheme() {
    var root = document.documentElement;
    var scheme = root.classList.contains('dark') ? 'dark' : 'light';
    root.setAttribute('data-blora-color-scheme', scheme);
  }
  syncScheme();
  if (window.MutationObserver) new MutationObserver(syncScheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}());
