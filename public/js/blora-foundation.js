/* Shared Blora bootstrap for public pages. */
(function () {
  'use strict';

  window.setBloraState = function (id, state) {
    var element = document.getElementById(id);
    if (element) element.setAttribute('data-blora-state', state);
    return element;
  };

  var iconNames = {
    'rectangle.grid.2x2': 'layout-grid', 'books.vertical': 'library',
    'antenna.radiowaves.left.and.right': 'radio', 'chart.bar': 'chart-no-axes-combined',
    'document': 'file-text', 'dollarsign.circle': 'circle-dollar-sign',
    'list.bullet.clipboard': 'clipboard-list', 'list.bullet': 'list', 'gearshape': 'settings',
    'person.2': 'users', 'person.3': 'users', 'person.badge.key': 'user-key',
    'person.crop.circle': 'circle-user', 'puzzlepiece.extension': 'puzzle',
    'archivebox': 'archive', 'arrow.backward': 'arrow-left', 'arrow.clockwise': 'refresh-cw',
    'chevron.down': 'chevron-down', 'chevron.left': 'chevron-left', 'cube': 'box',
    'exclamationmark.triangle': 'triangle-alert', 'magnifyingglass': 'search',
    'paintpalette': 'palette', 'text.quote': 'quote', 'desktopcomputer': 'monitor',
    'bubble.left': 'message-square', 'photo': 'image', 'lock.shield': 'shield-check',
    'shippingbox': 'package', 'signature': 'signature', 'bag': 'shopping-bag',
    'checkmark': 'check', 'document.on.document': 'copy', 'arrow.right': 'arrow-right',
    'arrow.turn.down.right': 'corner-down-right', 'brain.head.profile': 'brain',
    'circle.fill': 'circle', 'dot.radiowaves.left.and.right': 'radio',
    'folder.fill': 'folder', 'gearshape.fill': 'settings', 'hammer.fill': 'hammer',
    'line.3.horizontal': 'grip', 'star.fill': 'star', 'text.bubble': 'message-square', 'xmark': 'x'
  };
  function iconName(name) { return iconNames[name] || name; }
  function enhanceIcons(root) {
    var images = Array.from(root.querySelectorAll('img[data-sf-name]'));
    if (root.matches?.('img[data-sf-name]')) images.unshift(root);
    images.forEach(function (image) {
      var icon = document.createElement('span');
      icon.dataset.icon = iconName(image.dataset.sfName);
      icon.className = image.className.replace(/\bsf-icon\b/g, 'app-icon');
      icon.setAttribute('aria-hidden', 'true');
      image.replaceWith(icon);
    });
  }
  window.crewrouterIcons = { name: iconName, enhance: enhanceIcons };

  function syncScheme() {
    var root = document.documentElement;
    var scheme = root.classList.contains('dark') ? 'dark' : 'light';
    root.setAttribute('data-blora-color-scheme', scheme);
  }

  function enhanceLegacyMarkup(root) {
    var scope = root && root.querySelectorAll ? root : document;
    enhanceIcons(scope);
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
    var observer = new MutationObserver(function (records) {
      syncScheme();
      records.forEach(function (record) {
        record.addedNodes.forEach(function (node) {
          if (node.nodeType === Node.ELEMENT_NODE) enhanceLegacyMarkup(node);
        });
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    window.addEventListener('pagehide', function () { observer.disconnect(); }, { once: true });
  }
}());
