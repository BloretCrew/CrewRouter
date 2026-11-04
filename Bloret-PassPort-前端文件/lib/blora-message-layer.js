'use strict';

/**
 * Lift Blora Message into the browser top layer so it stays above
 * blora-dialog (popover="manual") overlays instead of sitting behind
 * the modal blur.
 *
 * Native popover stacking is last-shown-wins. A dialog that re-enters
 * the top layer after the first showPopover() will cover the toast.
 * Always hide+show to re-assert the top slot, and do it again on rAF
 * after layout.
 */
function restackPopover(root, win) {
    if (!root || typeof root.showPopover !== 'function') return;
    const bump = () => {
        try {
            const open = typeof root.matches === 'function' && root.matches(':popover-open');
            if (open && typeof root.hidePopover === 'function') root.hidePopover();
        } catch (_) { /* matches() may throw on detached nodes */ }
        try { root.showPopover(); } catch (_) { /* unsupported or not connected */ }
    };
    bump();
    if (win && typeof win.requestAnimationFrame === 'function') {
        win.requestAnimationFrame(bump);
    }
}

function promoteBloraMessageLayer(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    let root = doc.querySelector('[data-blora-message-root], .blora-message-container');
    const win = doc.defaultView;
    if (!root) {
        if (typeof doc.createElement !== 'function') return null;
        root = doc.createElement('div');
        root.className = 'blora-message-container blora-portal';
        if (typeof root.setAttribute === 'function') {
            root.setAttribute('data-blora-message-root', '');
            root.setAttribute('popover', 'manual');
        }
        const host = doc.body || doc.documentElement;
        if (host && typeof host.appendChild === 'function') host.appendChild(root);
    } else if (typeof root.setAttribute === 'function') {
        root.setAttribute('popover', 'manual');
    }
    restackPopover(root, win);
    return root;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { promoteBloraMessageLayer, restackPopover };
}
if (typeof globalThis !== 'undefined') {
    globalThis.BloraMessageLayer = { promoteBloraMessageLayer, restackPopover };
}
