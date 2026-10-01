import '/blora/icons-full.js?v=2.1.0';
import { createFormController, createTableController, message } from '/blora/index.js?v=2.1.0';

window.bloraMessage = message;
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
  for (const controller of controllers.values()) controller.destroy();
  controllers.clear();
}, { once: true });
