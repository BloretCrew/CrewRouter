// Shared Blora dialog adapter for legacy application call sites.
// The adapter keeps existing promise/call-site APIs while using official dialogs.
const Dialog = (() => {
  let sequence = 0;

  function getContainer() {
    let el = document.getElementById('global-dialog-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'global-dialog-container';
      document.body.appendChild(el);
    }
    return el;
  }

  function createDialog({ title, content, footer, size = '', closeOnOutsideClick = true }) {
    const dialog = document.createElement('blora-dialog');
    dialog.id = `blora-dialog-${Date.now()}-${++sequence}`;
    if (size) dialog.setAttribute('size', size);
    dialog.setAttribute('close-on-outside-click', closeOnOutsideClick ? 'true' : 'false');

    const titleNode = document.createElement('span');
    titleNode.slot = 'title';
    titleNode.innerHTML = title || '';
    const body = document.createElement('div');
    body.innerHTML = content || '';
    dialog.append(titleNode, body);

    if (footer) {
      const footerNode = document.createElement('div');
      footerNode.slot = 'footer';
      footerNode.innerHTML = footer;
      dialog.appendChild(footerNode);
    }

    getContainer().appendChild(dialog);
    return dialog;
  }

  function render({ title, message, confirmText = t('确认'), cancelText = t('取消'), showCancel = true, danger = false }) {
    return new Promise((resolve) => {
      const footer = `${showCancel ? `<button type="button" class="blora-button" data-variant="outline" data-dialog-cancel>${cancelText}</button>` : ''}<button type="button" class="blora-button" data-variant="${danger ? 'danger' : 'primary'}" data-dialog-confirm>${confirmText}</button>`;
      const dialog = createDialog({ title, content: message, footer, size: 'sm' });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        const done = () => { dialog.remove(); resolve(value); };
        dialog.addEventListener('blora-close', done, { once: true });
        dialog.close('result');
        if (!dialog.hasAttribute('open')) done();
      };
      dialog.addEventListener('click', (event) => {
        const target = event.target.closest?.('[data-dialog-confirm], [data-dialog-cancel]');
        if (target) finish(target.hasAttribute('data-dialog-confirm'));
      });
      dialog.addEventListener('blora-close', () => finish(false));
      dialog.show();
    });
  }

  function alert(title, message, options = {}) {
    return render({
      title: t('提示'),
      message: title && message ? `<strong>${title}</strong><br>${message}` : title,
      confirmText: options.confirmText || t('知道了'),
      showCancel: false,
      danger: options.danger || false
    });
  }

  function confirm(title, message, options = {}) {
    return render({ title, message, confirmText: options.confirmText || t('确认'), cancelText: options.cancelText || t('取消'), showCancel: true, danger: options.danger || false });
  }

  function showModal({ title, content, footer, width }) {
    const dialog = createDialog({ title, content, footer, size: width && Number(width) > 700 ? 'lg' : '' });
    if (width) dialog.style.setProperty('--blora-dialog-max-width', typeof width === 'number' ? `${width}px` : width);
    let settled = false;
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const settle = (value) => {
      if (settled) return;
      settled = true;
      dialog.remove();
      resolvePromise(value);
    };
    const close = (value) => {
      if (settled) return;
      dialog.addEventListener('blora-close', () => settle(value), { once: true });
      dialog.close('api');
      if (!dialog.hasAttribute('open')) settle(value);
    };
    dialog.addEventListener('blora-close', () => settle(false));
    dialog.show();
    return { close, promise, element: dialog };
  }

  return { alert, confirm, showModal };
})();

window.alert = (msg) => Dialog.alert(String(msg));
window.confirm = (msg) => Dialog.confirm(t('确认'), String(msg));
