import '/blora/icons-full.js?v=2.1.0';
import { createFormController, createTableController, message, hydrateIcons } from '/blora/index.js?v=2.1.0';

hydrateIcons(document);
window.bloraMessage = message;

// Keep permission/i18n/route definitions in the business layer. The installed
// SidebarNav consumes declarative links and owns its complete rendered tree.
let currentNavigation;
let navigationSignature;
let navigation;
function syncNavigation() {
  const source = document.querySelector('.sidebar-nav');
  if (!source) return;
  if (!source.hidden) source.hidden = true;
  const items = [...source.querySelectorAll('.nav-item')];
  const selectedPage = items.find(item => item.classList.contains('active'))?.dataset.page;
  if (currentNavigation && selectedPage !== currentNavigation) document.getElementById('mobileSidebarDrawer')?.close();
  currentNavigation = selectedPage;
  const visible = items.filter(item => item.style.display !== 'none' && !item.hidden);
  const signature = visible.map(item => `${item.dataset.page || item.id}:${item.textContent.trim()}`).join('|');
  if (signature !== navigationSignature || !navigation?.isConnected) {
    navigationSignature = signature;
    const next = document.createElement('blora-sidebar-nav');
    next.className = 'business-navigation';
    next.setAttribute('label', document.documentElement.lang.startsWith('zh') ? '主导航' : 'Navigation');
    for (const section of source.querySelectorAll('.nav-section')) {
      const group = document.createElement('blora-sidebar-nav-group');
      const title = section.querySelector('.nav-section-title')?.textContent.trim();
      if (title) group.setAttribute('label', title);
      for (const item of visible.filter(item => section.contains(item))) {
        const link = document.createElement('blora-sidebar-nav-link');
        const value = item.dataset.page || item.id || `external-${items.indexOf(item)}`;
        link.setAttribute('label', item.textContent.trim());
        link.setAttribute('value', value);
        link.setAttribute('href', item.dataset.page ? `#${item.dataset.page}` : '#');
        group.appendChild(link);
      }
      if (group.children.length) next.appendChild(group);
    }
    next.addEventListener('click', event => {
      // Preserve SPA routing and external actions through the business source.
      // Modified clicks on normal route links retain browser navigation.
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
    });
    next.addEventListener('blora-change', event => {
      const value = event.detail.value;
      const item = visible.find(item => (item.dataset.page || item.id || `external-${items.indexOf(item)}`) === value);
      item?.click();
    });
    if (selectedPage) next.setAttribute('value', selectedPage);
    if (navigation?.isConnected) navigation.replaceWith(next);
    else source.after(next);
    navigation = next;
  }
  if (navigation && navigation.value !== selectedPage) navigation.value = selectedPage || '';
}
syncNavigation();
const navigationObserver = new MutationObserver(syncNavigation);
navigationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'], characterData: true });
window.dispatchEvent(new Event('blora-services-ready'));
const controllers = new Map();
function mount(root) {
  root.querySelectorAll('form[data-blora-form], [data-blora-table]').forEach((host) => {
    if (controllers.has(host)) return;
    const controller = host.matches('form') ? createFormController(host) : createTableController(host);
    controllers.set(host, controller);
  });
  for (const [host, controller] of controllers) {
    if (!host.isConnected) {
      controller.destroy();
      controllers.delete(host);
    }
  }
}
mount(document);
const observer = new MutationObserver(() => mount(document));
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('pagehide', () => {
  observer.disconnect();
  navigationObserver.disconnect();
  for (const controller of controllers.values()) controller.destroy();
  controllers.clear();
}, { once: true });
