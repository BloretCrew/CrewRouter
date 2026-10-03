/* Shared Blora bootstrap for public pages. */
(function () {
  'use strict';

  function syncScheme() {
    var root = document.documentElement;
    var scheme = root.classList.contains('dark') ? 'dark' : 'light';
    root.setAttribute('data-blora-color-scheme', scheme);
  }

  function enhanceLegacyMarkup(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var elements = scope.querySelectorAll('button, a, input, textarea, select');
    elements.forEach(function (element) {
      var classList = element.classList;
      var legacyButton = classList.contains('btn') && !classList.contains('blora-button');
      if (legacyButton) {
        classList.add('blora-button');
        if (classList.contains('btn-primary')) element.dataset.variant = 'primary';
        else if (classList.contains('btn-danger')) element.dataset.variant = 'danger';
        else if (classList.contains('btn-outline')) element.dataset.variant = 'outline';
        else if (classList.contains('btn-ghost')) element.dataset.variant = 'ghost';
        else if (classList.contains('btn-link')) element.dataset.variant = 'text';
        else if (!element.dataset.variant) element.dataset.variant = 'secondary';
        if (classList.contains('btn-sm')) element.dataset.size = 'sm';
        else if (classList.contains('btn-lg')) element.dataset.size = 'lg';
      }

      if ((element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') && classList.contains('input')) {
        classList.add('blora-input');
      }
      if (element.tagName === 'SELECT' && (classList.contains('select') || classList.contains('input'))) {
        classList.add('blora-input');
      }
    });
  }

  syncScheme();
  enhanceLegacyMarkup(document);

  if (window.MutationObserver) {
    new MutationObserver(function (records) {
      syncScheme();
      records.forEach(function (record) {
        record.addedNodes.forEach(function (node) {
          if (node.nodeType === Node.ELEMENT_NODE) enhanceLegacyMarkup(node);
        });
      });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
  }
}());
