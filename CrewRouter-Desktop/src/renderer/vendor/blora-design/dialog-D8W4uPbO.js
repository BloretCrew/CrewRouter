var _ = Object.defineProperty;
var y = (a, i, t) => i in a ? _(a, i, { enumerable: !0, configurable: !0, writable: !0, value: t }) : a[i] = t;
var l = (a, i, t) => y(a, typeof i != "symbol" ? i + "" : i, t);
import { B as x, O as w } from "./blora-element-Cn5j6OzD.js";
import { t as k } from "./i18n-Duo0HNK5.js";
import { c as C } from "./icons-PjqNgrW5.js";
function E(a) {
  var r;
  const i = (r = a.ownerDocument) == null ? void 0 : r.defaultView;
  if (!i) return 0;
  const t = i.getComputedStyle(a), e = t.transitionDuration.split(","), o = t.transitionDelay.split(",");
  let s = 0;
  for (let n = 0; n < e.length; n++)
    s = Math.max(s, m(e[n]) + m(o[n] ?? o[0] ?? "0s"));
  return s;
}
function m(a) {
  const i = a.trim(), t = Number.parseFloat(i);
  return !Number.isFinite(t) || t <= 0 ? 0 : i.endsWith("ms") ? t : t * 1e3;
}
function T(a, i) {
  let t = !1;
  const e = (n) => {
    n.target === a && o();
  };
  function o() {
    t || (t = !0, a.removeEventListener("transitionend", e), r !== void 0 && clearTimeout(r), i());
  }
  const s = E(a), r = s > 16 ? setTimeout(o, s + 50) : void 0;
  return s <= 16 ? (o(), () => {
    t = !0;
  }) : (a.addEventListener("transitionend", e), () => {
    t = !0, a.removeEventListener("transitionend", e), r !== void 0 && clearTimeout(r);
  });
}
const A = 'blora-dialog{transition-property:overlay,display;transition-duration:var(--blora-duration-base);transition-timing-function:var(--blora-easing-standard);transition-behavior:allow-discrete}blora-dialog:not([open]){display:none}:host{display:none;opacity:0;transition-property:overlay,display,opacity;transition-duration:var(--blora-duration-base);transition-timing-function:var(--blora-easing-standard);transition-behavior:allow-discrete}:host([open]),:host(:popover-open){display:block;position:fixed;top:0;right:0;bottom:0;left:0;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:none;overflow:visible;background:transparent;z-index:var(--blora-z-modal);opacity:1}@starting-style{:host([open]),:host(:popover-open){opacity:0}}.blora-dialog__backdrop{position:absolute;top:0;right:0;bottom:0;left:0;width:auto;height:auto;margin:0;padding:max(var(--blora-space-5),env(safe-area-inset-top,0px)) max(var(--blora-space-5),env(safe-area-inset-inline-end,0px)) max(var(--blora-space-5),env(safe-area-inset-bottom,0px)) max(var(--blora-space-5),env(safe-area-inset-inline-start,0px));border:0;background:transparent;z-index:var(--blora-z-modal);display:flex;align-items:center;justify-content:center;box-sizing:border-box}.blora-dialog__mask{position:absolute;top:0;right:0;bottom:0;left:0;background:var(--blora-color-overlay-modal);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);opacity:0;transition:opacity var(--blora-duration-base) var(--blora-easing-standard)}:host([open]) .blora-dialog__mask,:host(:popover-open) .blora-dialog__mask{opacity:1}@starting-style{:host([open]) .blora-dialog__mask,:host(:popover-open) .blora-dialog__mask{opacity:0}}.blora-dialog__panel{position:relative;min-width:0;background:var(--blora-color-surface-default);border-radius:var(--blora-radius-xl);box-shadow:var(--blora-shadow-4);max-width:var(--blora-dialog-max-width, 520px);width:100%;max-height:calc(100dvh - 2 * var(--blora-space-5));overflow-y:auto;overscroll-behavior:contain;opacity:0;transform:scale(.94) translateY(8px);transition:opacity var(--blora-duration-base) var(--blora-easing-standard),transform var(--blora-duration-base) var(--blora-easing-standard)}:host([open]) .blora-dialog__panel,:host(:popover-open) .blora-dialog__panel{opacity:1;transform:none;transition:opacity var(--blora-duration-base) var(--blora-easing-standard),transform var(--blora-duration-base) var(--blora-easing-overshoot)}@starting-style{:host([open]) .blora-dialog__panel,:host(:popover-open) .blora-dialog__panel{opacity:0;transform:scale(.94) translateY(8px)}}:host([size="sm"]) .blora-dialog__panel{--blora-dialog-max-width: 400px}:host([size="lg"]) .blora-dialog__panel{--blora-dialog-max-width: 800px}.blora-dialog__header{position:relative;display:flex;align-items:center;justify-content:space-between;padding:var(--blora-space-5) var(--blora-space-6)}.blora-dialog__header:after{position:absolute;inset-inline:var(--blora-space-6);inset-block-end:0;border-block-end:var(--blora-border-subtle);content:"";pointer-events:none}.blora-dialog__title{font-family:var(--blora-font-heading);font-size:var(--blora-text-xl);color:var(--blora-color-text-primary);margin:0}.blora-dialog__close-button{color:var(--blora-color-text-subtle);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:.3em;border-radius:var(--blora-radius-sm);border:none;background:none;transition:color var(--blora-duration-fast) var(--blora-easing-standard),background-color var(--blora-duration-fast) var(--blora-easing-standard)}.blora-dialog__close-button:hover{color:var(--blora-color-text-primary);background:var(--blora-color-surface-raised)}.blora-dialog__body{padding:var(--blora-space-6);color:var(--blora-color-text-emphasis);font-size:var(--blora-text-sm)}.blora-dialog__footer{position:relative;padding:var(--blora-space-4) var(--blora-space-6);display:flex;justify-content:flex-end;gap:var(--blora-space-2)}.blora-dialog__footer[hidden]{display:none}.blora-dialog__footer:before{position:absolute;inset-inline:var(--blora-space-6);inset-block-start:0;border-block-start:var(--blora-border-subtle);content:"";pointer-events:none}@media(max-width:560px){.blora-dialog__backdrop{align-items:center;justify-content:center;padding:max(var(--blora-space-4),env(safe-area-inset-top,0px)) max(var(--blora-space-3),env(safe-area-inset-inline-end,0px)) max(var(--blora-space-4),env(safe-area-inset-bottom,0px)) max(var(--blora-space-3),env(safe-area-inset-inline-start,0px))}.blora-dialog__panel{max-height:min(calc(100dvh - 2 * var(--blora-space-5)),90dvh);border-radius:var(--blora-radius-xl);margin-inline:auto}.blora-dialog__header,.blora-dialog__body{padding:var(--blora-space-4)}.blora-dialog__footer{padding:var(--blora-space-3) var(--blora-space-4);flex-wrap:wrap}.blora-dialog__footer .blora-button{flex:1 1 auto;width:auto;min-width:0;max-width:100%}}@media(prefers-reduced-motion:reduce){:host,.blora-dialog__mask,.blora-dialog__panel{transition-duration:.01ms!important}}', f = "blora-dialog";
let L = 0;
class N extends x {
  constructor() {
    super(...arguments);
    l(this, "overlay", null);
    l(this, "cancelCloseMotion", null);
    l(this, "visible", !1);
    l(this, "_backdrop", null);
    l(this, "_closeButton", null);
    l(this, "_footer", null);
    l(this, "_footerSlot", null);
    l(this, "_hostInTopLayer", !1);
    l(this, "relocating", !1);
    l(this, "home", null);
  }
  static get observedAttributes() {
    return ["open", "size", "close-on-escape", "close-on-outside-click"];
  }
  attributeChangedCallback(t, e, o) {
    t === "open" && this.isConnectedInternal && (o !== null ? this.show() : this.close());
  }
  render() {
    if (this.shadowRoot) return;
    const t = this.attachShadow({ mode: "open" }), e = document.createElement("style");
    e.textContent = A, t.appendChild(e), this.setAttribute("popover", "manual");
    const o = document.createElement("div");
    o.className = "blora-dialog__backdrop", o.setAttribute("part", "backdrop");
    const s = document.createElement("div");
    s.className = "blora-dialog__mask";
    const r = document.createElement("div");
    r.className = "blora-dialog__panel", r.setAttribute("part", "panel"), r.setAttribute("role", "dialog"), r.setAttribute("aria-modal", "true");
    const n = document.createElement("div");
    n.className = "blora-dialog__header", n.setAttribute("part", "header");
    const v = document.createElement("slot");
    v.name = "header";
    const c = document.createElement("h2");
    c.className = "blora-dialog__title", c.setAttribute("part", "title"), c.id = `blora-dialog-title-${++L}`;
    const u = document.createElement("slot");
    u.name = "title", c.appendChild(u), n.appendChild(c), r.setAttribute("aria-labelledby", c.id);
    const d = document.createElement("button");
    d.className = "blora-dialog__close-button", d.setAttribute("part", "close-button"), d.setAttribute("aria-label", k("common.closeDialog")), d.type = "button", d.appendChild(C("close", 18, this.ownerDocument)), n.appendChild(d);
    const b = document.createElement("div");
    b.className = "blora-dialog__body", b.setAttribute("part", "body");
    const g = document.createElement("slot");
    b.appendChild(g);
    const p = document.createElement("div");
    p.className = "blora-dialog__footer", p.setAttribute("part", "footer");
    const h = document.createElement("slot");
    h.name = "footer", p.appendChild(h), r.appendChild(n), r.appendChild(b), r.appendChild(p), o.appendChild(s), o.appendChild(r), t.appendChild(o), this._backdrop = o, this._closeButton = d, this._footer = p, this._footerSlot = h;
  }
  bindEvents() {
    this._closeButton && (this.syncFooterVisibility(), this._footerSlot && this.listen(this._footerSlot, "slotchange", () => this.syncFooterVisibility()), this.listen(this._closeButton, "click", () => {
      this.close("close-button");
    }), this._backdrop && this.listen(this._backdrop, "pointerdown", (t) => {
      var e, o;
      this.allowsOutsideClickClose() && (t.target === this._backdrop || (o = (e = t.target) == null ? void 0 : e.classList) != null && o.contains("blora-dialog__mask")) && this.close("outside-click");
    }), this.listen(this, "blora-close-request", () => {
      this.close("request");
    }), this.hasAttribute("open") && (this.visible = !1, this.show()));
  }
  syncFooterVisibility() {
    if (!this._footer || !this._footerSlot) return;
    const t = this._footerSlot.assignedNodes({ flatten: !0 }).some(
      (e) => {
        var o;
        return e.nodeType === Node.ELEMENT_NODE || (((o = e.textContent) == null ? void 0 : o.trim().length) ?? 0) > 0;
      }
    );
    this._footer.hidden = !t;
  }
  /** `close-on-outside-click="false"` (string) must not close; bare attr still true. */
  allowsOutsideClickClose() {
    return this.getAttribute("close-on-outside-click") !== "false";
  }
  show() {
    if (this.visible || !this.emit(
      "blora-before-open",
      {
        source: "api",
        reason: "show"
      },
      { cancelable: !0 }
    )) return;
    this.visible = !0, this.portalToBody(), this.setAttribute("open", ""), this.promoteToTopLayer();
    const e = {
      modal: !0,
      closeOnEscape: this.getAttribute("close-on-escape") !== "false",
      closeOnOutsidePointer: !1,
      restoreFocus: !0,
      trapFocus: !0,
      lockScroll: !0
    };
    this.overlay = new w(this, e), this.overlay.open(), this.emit("blora-open", {
      source: "api",
      reason: "show"
    });
  }
  close(t = "api") {
    var o;
    !this.visible || !this.emit(
      "blora-before-close",
      {
        source: "api",
        reason: t
      },
      { cancelable: !0 }
    ) || (this.visible = !1, (o = this.cancelCloseMotion) == null || o.call(this), this.removeAttribute("open"), this.cancelCloseMotion = T(this, () => {
      var s;
      this.cancelCloseMotion = null, (s = this.overlay) == null || s.close(), this.overlay = null, this.dismissTopLayer(), this.restoreHome(), this.emit("blora-close", {
        source: "api",
        reason: t
      });
    }));
  }
  disconnectedCallback() {
    this.relocating || super.disconnectedCallback();
  }
  portalToBody() {
    const t = this.ownerDocument;
    !this.parentNode || this.parentElement === t.body || (this.home = { parent: this.parentNode, next: this.nextSibling }, this.relocating = !0, t.body.append(this), this.relocating = !1);
  }
  restoreHome() {
    if (!this.home) return;
    const { parent: t, next: e } = this.home;
    this.home = null, t.isConnected && (this.relocating = !0, e && e.parentNode === t ? t.insertBefore(this, e) : t.appendChild(this), this.relocating = !1);
  }
  onDisconnect() {
    var t, e;
    (t = this.cancelCloseMotion) == null || t.call(this), this.cancelCloseMotion = null, (e = this.overlay) == null || e.destroy(), this.overlay = null, this.dismissTopLayer(), this.restoreHome();
  }
  promoteToTopLayer() {
    if (typeof this.showPopover == "function") {
      if (this.matches(":popover-open")) {
        this._hostInTopLayer = !0;
        return;
      }
      try {
        this.showPopover(), this._hostInTopLayer = !0;
      } catch {
        this._hostInTopLayer = !1;
      }
    }
  }
  dismissTopLayer() {
    if (this._hostInTopLayer && typeof this.hidePopover == "function")
      try {
        this.hidePopover();
      } catch {
      }
    this._hostInTopLayer = !1;
  }
}
function M(a = customElements) {
  !a || a.get(f) || a.define(f, N);
}
export {
  f as B,
  N as a,
  M as d,
  T as w
};
