/* Shared Blora bootstrap for public pages. */
(function () {
  'use strict';

  document.documentElement.setAttribute('data-blora-color-scheme',
    document.documentElement.classList.contains('dark') ? 'dark' : 'light');

  function syncScheme() {
    var root = document.documentElement;
    var scheme = root.classList.contains('dark') ? 'dark' : 'light';
    root.setAttribute('data-blora-color-scheme', scheme);
  }

  if (window.MutationObserver) {
    new MutationObserver(syncScheme).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
}());
