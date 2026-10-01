import '/blora/icons-full.js?v=2.1.0';
import { createFormController, createTableController, message, hydrateIcons } from '/blora/index.js?v=2.1.0';

hydrateIcons(document);
window.bloraMessage = message;

let currentNavigation;
function syncNavigation() {
  const selectedPage = document.querySelector('.sidebar-nav .nav-item.active')?.dataset.page;
  if (currentNavigation && selectedPage !== currentNavigation) document.getElementById('mobileSidebarDrawer')?.close();
  currentNavigation = selectedPage;
  document.querySelectorAll('.sidebar-nav .nav-item').forEach((item) => {
    const selected = item.classList.contains('active');
    const variant = selected ? 'secondary' : 'ghost';
    if (item.dataset.variant !== variant) item.dataset.variant = variant;
    if (selected) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}
syncNavigation();
const navigationObserver = new MutationObserver(syncNavigation);
navigationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
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
