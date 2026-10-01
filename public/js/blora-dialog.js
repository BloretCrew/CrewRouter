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

  function setContent(target, content) {
    if (!target) return;
    target.innerHTML = content || '';
  }

  function prepareLegacyDialog(dialog) {
    if (!dialog || dialog.dataset.legacyPrepared === 'true') return dialog;
    dialog.querySelectorAll(':scope > .modal-overlay').forEach((overlay) => overlay.remove());
    const content = dialog.querySelector(':scope > .modal-content');
    if (!content) return dialog;

    const maxWidth = content.style.maxWidth;
    if (maxWidth && maxWidth !== '100%' && maxWidth !== 'none') {
      dialog.style.setProperty('--blora-dialog-max-width', maxWidth);
    }
    const header = content.querySelector(':scope > .modal-header');
    const footer = content.querySelector(':scope > .modal-footer');
    if (header) {
      header.slot = 'title';
      header.querySelectorAll('.modal-close').forEach((button) => { button.hidden = true; });
      dialog.prepend(header);
    }
    if (footer) {
      footer.slot = 'footer';
      dialog.append(footer);
    }
    content.style.width = '100%';
    content.style.maxWidth = '100%';
    content.style.margin = '0';
    dialog.dataset.legacyPrepared = 'true';

    return dialog;
  }

  function prepareAllDialogs(root) {
    const scope = root && root.querySelectorAll ? root : document;
    if (scope.matches?.('blora-dialog')) prepareLegacyDialog(scope);
    scope.querySelectorAll('blora-dialog').forEach(prepareLegacyDialog);
  }

  function createDialog({ title, content, footer, width, closeOnOutsideClick = true }) {
    const dialog = document.createElement('blora-dialog');
    dialog.id = `blora-dialog-${Date.now()}-${++sequence}`;
    dialog.setAttribute('close-on-outside-click', closeOnOutsideClick ? 'true' : 'false');
    if (width) dialog.style.setProperty('--blora-dialog-max-width', typeof width === 'number' ? `${width}px` : width);

    const titleNode = document.createElement('span');
    titleNode.slot = 'title';
    setContent(titleNode, title);

    const body = document.createElement('div');
    setContent(body, content);
    dialog.append(titleNode, body);

    if (footer) {
      const footerNode = document.createElement('div');
      footerNode.slot = 'footer';
      setContent(footerNode, footer);
      dialog.appendChild(footerNode);
    }

    getContainer().appendChild(dialog);
    return dialog;
  }

  function removeAfterClose(dialog, callback) {
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      dialog.remove();
      if (callback) callback();
    };
    dialog.addEventListener('blora-close', remove, { once: true });
    return remove;
  }

  function render({ title, message, confirmText = t('确认'), cancelText = t('取消'), showCancel = true, danger = false }) {
    return new Promise((resolve) => {
      const footer = `${showCancel ? `<button type="button" class="blora-button" data-variant="outline" data-dialog-cancel>${cancelText}</button>` : ''}<button type="button" class="blora-button" data-variant="${danger ? 'danger' : 'primary'}" data-dialog-confirm>${confirmText}</button>`;
      const dialog = createDialog({
        title: t('提示'),
        content: title && message ? `<strong>${title}</strong><br>${message}` : title,
        footer,
        width: 400,
      });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        const remove = removeAfterClose(dialog, () => resolve(value));
        dialog.close('result');
        if (!dialog.hasAttribute('open')) remove();
      };
      dialog.addEventListener('click', (event) => {
        const target = event.target.closest?.('[data-dialog-confirm], [data-dialog-cancel]');
        if (target) finish(target.hasAttribute('data-dialog-confirm'));
      });
      dialog.addEventListener('blora-close', () => finish(false));
      dialog.show();
    });
  }

  function showAlert(title, message, options = {}) {
    return render({ title, message, confirmText: options.confirmText || t('知道了'), showCancel: false, danger: options.danger || false });
  }

  function showConfirm(title, message, options = {}) {
    return render({ title, message, confirmText: options.confirmText || t('确认'), cancelText: options.cancelText || t('取消'), showCancel: true, danger: options.danger !== false });
  }

  function showModal({ title, content, footer, width }) {
    const dialog = createDialog({ title, content, footer, width });
    let settled = false;
    let result = false;
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const settle = () => {
      if (settled) return;
      settled = true;
      dialog.remove();
      resolvePromise(result);
    };
    const close = (value) => {
      if (settled) return;
      result = value;
      dialog.close('api');
      if (!dialog.hasAttribute('open')) settle();
    };
    dialog.addEventListener('blora-close', settle, { once: true });
    dialog.show();
    return { close, promise, element: dialog };
  }

  return { alert: showAlert, confirm: showConfirm, showModal, prepareAllDialogs };
})();


(function installLegacyDialogCompatibility() {
  function scan(root) {
    Dialog.prepareAllDialogs(root);
  }
  scan(document);
  document.addEventListener('DOMContentLoaded', () => scan(document), { once: true });
  if (window.MutationObserver) {
    const observer = new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      }));
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }
})();
