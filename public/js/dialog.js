// Custom confirm/alert dialog — replaces native browser dialogs
// Usage: const result = await Dialog.confirm('标题', '内容', { confirmText, cancelText, danger });
//        await Dialog.alert('标题', '内容');

const Dialog = (() => {
  function getContainer() {
    let el = document.getElementById('global-dialog-container');
    if (!el) {
      el = document.createElement('div');
      el.id = 'global-dialog-container';
      document.body.appendChild(el);
    }
    return el;
  }

  function render({ title, message, confirmText = t('确认'), cancelText = t('取消'), showCancel = true, danger = false }) {
    return new Promise((resolve) => {
      const container = getContainer();
      const id = 'dialog-' + Date.now();

      const confirmBtnClass = danger ? 'dialog-btn dialog-btn-danger' : 'dialog-btn dialog-btn-primary';

      setHTML(container, `
        <div class="dialog-overlay" id="${id}-overlay">
          <div class="dialog-panel" id="${id}-panel">
            <div class="dialog-title">${title}</div>
            <div class="dialog-message">${message}</div>
            <div class="dialog-actions">
              ${showCancel ? `<button class="dialog-btn dialog-btn-cancel" id="${id}-cancel">${cancelText}</button>` : ''}
              <button class="${confirmBtnClass}" id="${id}-confirm">${confirmText}</button>
            </div>
          </div>
        </div>
      `);

      const overlay = document.getElementById(`${id}-overlay`);
      const panel = document.getElementById(`${id}-panel`);
      const confirmBtn = document.getElementById(`${id}-confirm`);
      const cancelBtn = document.getElementById(`${id}-cancel`);

      // Animate in
      requestAnimationFrame(() => {
        overlay.classList.add('dialog-open');
        panel.classList.add('dialog-open');
      });

      function close(value) {
        overlay.classList.remove('dialog-open');
        panel.classList.remove('dialog-open');
        setTimeout(() => { clearChildren(container); }, 200);
        resolve(value);
      }

      if (confirmBtn) confirmBtn.addEventListener('click', () => close(true));
      if (cancelBtn) cancelBtn.addEventListener('click', () => close(false));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(false);
      });
      document.addEventListener('keydown', function handler(e) {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', handler);
          close(false);
        } else if (e.key === 'Enter') {
          document.removeEventListener('keydown', handler);
          close(true);
        }
      });
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
    return render({
      title,
      message,
      confirmText: options.confirmText || t('确认'),
      cancelText: options.cancelText || t('取消'),
      showCancel: true,
      danger: options.danger || false
    });
  }

  function showModal({ title, content, footer, width, panelClass = '' }) {
    const container = getContainer();
    const id = 'modal-' + Date.now();

    // 如果有上一个对话框的清理定时器，先取消
    if (container._closeTimer) {
      clearTimeout(container._closeTimer);
      container._closeTimer = null;
    }

    const extraClass = panelClass ? ` ${panelClass}` : '';
    const widthStyle = width ? `max-width:${typeof width === 'number' ? width + 'px' : width};` : 'max-width:500px;';

    // 去掉 footer 里仅用于关闭的「取消/关闭」文字按钮，统一用右上角叉号
    let cleanFooter = footer || '';
    if (typeof cleanFooter === 'string') {
      cleanFooter = cleanFooter
        .replace(/<button[^>]*class="[^"]*modal-close[^"]*"[^>]*>\s*(取消|关闭)\s*<\/button>/gi, '')
        .replace(/<button[^>]*class="[^"]*dialog-btn-cancel[^"]*"[^>]*>\s*取消\s*<\/button>/gi, '')
        .trim();
    }
    const footerHtml = cleanFooter
      ? `<div class="dialog-actions">${cleanFooter}</div>`
      : '';

    setHTML(container, `
      <div class="dialog-overlay" id="${id}-overlay">
        <div class="dialog-panel${extraClass}" id="${id}-panel" style="${widthStyle}">
          <button type="button" class="modal-close" aria-label="${t('关闭')}">&times;</button>
          <div class="dialog-title">${title}</div>
          <div class="dialog-content">${content}</div>
          ${footerHtml}
        </div>
      </div>
    `);

    const overlay = document.getElementById(`${id}-overlay`);
    const panel = document.getElementById(`${id}-panel`);

    // Animate in
    requestAnimationFrame(() => {
      overlay.classList.add('dialog-open');
      panel.classList.add('dialog-open');
    });

    // Bind close buttons
    container.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => close());
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    function close() {
      // 只移除自己的元素，不误伤后续对话框
      const myOverlay = document.getElementById(`${id}-overlay`);
      const myPanel = document.getElementById(`${id}-panel`);
      if (myOverlay) myOverlay.classList.remove('dialog-open');
      if (myPanel) myPanel.classList.remove('dialog-open');
      container._closeTimer = setTimeout(() => {
        // 仅当容器里仍然是自己的内容时才清空
        if (document.getElementById(`${id}-overlay`)) {
          clearChildren(container);
        }
        container._closeTimer = null;
      }, 200);
    }

    return { close };
  }

  return { alert, confirm, showModal };
})();

// Override native alert and confirm globally
window.alert = (msg) => Dialog.alert(String(msg));
window.confirm = (msg) => Dialog.confirm(t('确认'), String(msg));
