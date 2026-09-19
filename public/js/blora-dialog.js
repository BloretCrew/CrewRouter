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
    const content = dialog.querySelector(':scope > .modal-content');
    if (!content) return dialog;

    // Existing pages already provide their own header/body/footer. Keeping the
    // inner panel class would create a second panel inside Blora's shadow panel.
    content.classList.remove('blora-dialog__panel');
    content.style.width = '100%';
    content.style.maxWidth = '100%';
    content.style.maxHeight = '100%';
    content.style.boxSizing = 'border-box';
    content.style.margin = '0';
    dialog.dataset.legacyPrepared = 'true';

    const applyShadowCompatibility = () => {
      const shadow = dialog.shadowRoot;
      if (!shadow) return;
      const header = shadow.querySelector('.blora-dialog__header');
      const footer = shadow.querySelector('.blora-dialog__footer');
      const body = shadow.querySelector('.blora-dialog__body');
      if (header) header.style.setProperty('display', 'none', 'important');
      if (footer) footer.style.setProperty('display', 'none', 'important');
      if (body) {
        body.style.setProperty('display', 'flex', 'important');
        body.style.setProperty('flex-direction', 'column', 'important');
        body.style.setProperty('min-height', '0', 'important');
        body.style.setProperty('overflow', 'hidden', 'important');
        body.style.setProperty('padding', '0', 'important');
        body.style.setProperty('background', 'transparent', 'important');
      }
      const panel = shadow.querySelector('.blora-dialog__panel');
      if (panel) {
        panel.style.setProperty('display', 'flex', 'important');
        panel.style.setProperty('flex-direction', 'column', 'important');
        panel.style.maxWidth = 'none';
        panel.style.width = '100%';
        panel.style.background = 'transparent';
        panel.style.boxShadow = 'none';
        panel.style.borderRadius = '0';
        // 滚动交给内层 .modal-body（见下），面板自身保持 hidden 防止双滚动条
        panel.style.overflow = 'hidden';
      }

      // 宽度：优先用内容节点上的内联 max-width（如 style="max-width:720px"）
      // 高度：绝不要把内容的 "100%" 回写到面板——百分比在未定高父级上会解析为 none，
      // 面板应保留组件 CSS 的 calc(100dvh - …) 上限。
      const contentMaxWidth = content.style.maxWidth;
      if (contentMaxWidth && contentMaxWidth !== '100%' && contentMaxWidth !== 'none') {
        dialog.style.setProperty('--blora-dialog-max-width', contentMaxWidth);
      }

      // 旧版内容自带 header/body/footer。高度链路：
      // 面板（组件 CSS max-height + flex 列）→ shadow body（flex:1, min-height:0）
      // → .modal-content（flex:1）→ .modal-body（overflow-y:auto）滚动。
      if (body) {
        body.style.setProperty('flex', '1 1 auto', 'important');
      }
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      content.style.minHeight = '0';
      content.style.maxHeight = '100%';
      content.style.overflow = 'hidden';
      content.style.flex = '1 1 auto';
      const innerBody = content.querySelector('.modal-body');
      if (innerBody) {
        innerBody.style.setProperty('flex', '1 1 auto', 'important');
        innerBody.style.setProperty('min-height', '0', 'important');
        innerBody.style.setProperty('overflow-y', 'auto', 'important');
        innerBody.style.setProperty('-webkit-overflow-scrolling', 'touch', 'important');
      }
    };

    if (dialog.shadowRoot) applyShadowCompatibility();
    else customElements.whenDefined('blora-dialog').then(applyShadowCompatibility);
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

  function alert(title, message, options = {}) {
    return render({ title, message, confirmText: options.confirmText || t('知道了'), showCancel: false, danger: options.danger || false });
  }

  function confirm(title, message, options = {}) {
    return render({ title, message, confirmText: options.confirmText || t('确认'), cancelText: options.cancelText || t('取消'), showCancel: true, danger: options.danger || false });
  }

  function showModal({ title, content, footer, width }) {
    const dialog = createDialog({ title, content, footer, width });
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
      const remove = removeAfterClose(dialog, () => resolvePromise(value));
      dialog.close('api');
      if (!dialog.hasAttribute('open')) remove();
    };
    dialog.addEventListener('blora-close', () => settle(false));
    dialog.show();
    return { close, promise, element: dialog };
  }

  return { alert, confirm, showModal, prepareAllDialogs };
})();

window.alert = (msg) => Dialog.alert(String(msg));
window.confirm = (msg) => Dialog.confirm(t('确认'), String(msg));

(function installLegacyDialogCompatibility() {
  function scan(root) {
    Dialog.prepareAllDialogs(root);
  }
  scan(document);
  document.addEventListener('DOMContentLoaded', () => scan(document), { once: true });
  if (window.MutationObserver) {
    new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      }));
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
