/* Shared instance edition badge. */
(function (root) {
  'use strict';

  function resolveEditionBadge(instance) {
    if (!instance || typeof instance !== 'object') return '';
    if (instance.runtime === 'desktop-local') return 'LOCAL';
    if (instance.edition === 'personal') return 'PERSONAL';
    if (instance.edition === 'team') return 'TEAM';
    return '';
  }

  function mount(instance, selector) {
    var elements = document.querySelectorAll(selector || '[data-edition-badge]');
    var label = resolveEditionBadge(instance);
    elements.forEach(function (element) {
      element.textContent = label;
      element.hidden = !label;
    });
    return label;
  }

  var instancePromise;
  function load() {
    if (!instancePromise) {
      instancePromise = fetch('/api/instance', { credentials: 'same-origin' })
        .then(function (response) { return response.ok ? response.json() : null; })
        .catch(function () { return null; });
    }
    return instancePromise;
  }

  root.CrewRouterEditionBadge = {
    resolve: resolveEditionBadge,
    mount: mount,
    load: load,
  };

  function autoMount() {
    if (!document.querySelector('[data-edition-badge]')) return;
    load().then(function (instance) { mount(instance); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
  else autoMount();
})(window);
