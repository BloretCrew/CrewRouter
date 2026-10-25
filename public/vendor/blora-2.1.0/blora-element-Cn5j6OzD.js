var p = Object.defineProperty;
var b = (e, t, o) => t in e ? p(e, t, { enumerable: !0, configurable: !0, writable: !0, value: o }) : e[t] = o;
var r = (e, t, o) => b(e, typeof t != "symbol" ? t + "" : t, o);
const y = {
  modal: !0,
  closeOnEscape: !0,
  closeOnOutsidePointer: !0,
  restoreFocus: !0,
  trapFocus: !0,
  lockScroll: !0
}, h = /* @__PURE__ */ new WeakMap(), l = /* @__PURE__ */ new WeakMap(), u = /* @__PURE__ */ new WeakMap(), c = /* @__PURE__ */ new WeakMap();
function w(e) {
  const t = (c.get(e) ?? 0) + 1;
  c.set(e, t), e.documentElement.setAttribute("data-blora-modal-open", "");
}
function m(e) {
  const t = Math.max(0, (c.get(e) ?? 0) - 1);
  t === 0 ? (c.delete(e), e.documentElement.removeAttribute("data-blora-modal-open")) : c.set(e, t);
}
function a(e) {
  let t = h.get(e);
  return t || (t = [], h.set(e, t)), t;
}
function v(e) {
  const t = (l.get(e) ?? 0) + 1;
  if (l.set(e, t), t !== 1) return;
  const o = e.body, n = e.documentElement;
  if (!o) return;
  const s = e.defaultView, i = s ? Math.max(0, s.innerWidth - n.clientWidth) : 0;
  u.set(e, {
    paddingRight: o.style.paddingRight,
    rootOverflow: n.style.overflow
  }), n.dataset.bloraScrollLocked = "1", n.style.overflow = "hidden", i && (o.style.paddingRight = `${i}px`);
}
function g(e) {
  const t = Math.max(0, (l.get(e) ?? 0) - 1);
  if (t > 0) {
    l.set(e, t);
    return;
  }
  l.delete(e);
  const o = u.get(e);
  u.delete(e);
  const n = e.body, s = e.documentElement;
  delete s.dataset.bloraScrollLocked, n && o ? (s.style.overflow = o.rootOverflow, n.style.paddingRight = o.paddingRight) : n && (s.style.overflow = "", n.style.paddingRight = "");
  const i = e.defaultView;
  i && i.navigator.userAgent.includes("jsdom") && E(e, i.scrollY);
}
function E(e, t) {
  const o = e.defaultView;
  if (!o || o.navigator.userAgent.includes("jsdom")) {
    e.documentElement.scrollTop = t;
    return;
  }
  o.scrollTo(0, t);
}
const C = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  "[contenteditable]"
].join(", ");
function k(e) {
  return e.matches("[disabled]") || e.getAttribute("aria-hidden") === "true" || !e.matches(C) ? !1 : e.getClientRects().length > 0 ? !0 : e === e.ownerDocument.activeElement;
}
function f(e) {
  const t = [], o = (n) => {
    if (n instanceof HTMLElement && k(n) && t.push(n), n instanceof HTMLElement && n.shadowRoot) {
      n.shadowRoot.childNodes.forEach(o);
      return;
    }
    if (n instanceof HTMLSlotElement) {
      n.assignedNodes({ flatten: !0 }).forEach(o);
      return;
    }
    n.childNodes.forEach(o);
  };
  return e.shadowRoot ? e.shadowRoot.childNodes.forEach(o) : e.childNodes.forEach(o), t;
}
function d(e, t) {
  var n;
  if (!t) return !1;
  if (e === t || e.contains(t) || t instanceof Element && ((n = e.shadowRoot) != null && n.contains(t))) return !0;
  const o = t.getRootNode();
  if (o instanceof ShadowRoot) {
    let s = o.host;
    for (; s; ) {
      if (s === e) return !0;
      const i = s.getRootNode();
      s = i instanceof ShadowRoot ? i.host : null;
    }
  }
  return !1;
}
function L(e, t) {
  if (e.key !== "Tab") return;
  const o = f(t);
  if (o.length === 0) return;
  const n = o[0], s = o[o.length - 1], i = t.ownerDocument.activeElement;
  e.shiftKey ? (i === n || !d(t, i)) && (e.preventDefault(), s.focus()) : (i === s || !d(t, i)) && (e.preventDefault(), n.focus());
}
class D {
  constructor(t, o = {}) {
    r(this, "entry", null);
    r(this, "overlay");
    r(this, "options");
    r(this, "onKeyDown", (t) => {
      if (!this.entry) return;
      const o = a(this.entry.document);
      o[o.length - 1] === this.entry && (t.key === "Escape" && this.options.closeOnEscape && (t.preventDefault(), t.stopPropagation(), this.overlay.dispatchEvent(
        new CustomEvent("blora-close-request", { bubbles: !0, composed: !0 })
      )), this.options.trapFocus && L(t, this.overlay));
    });
    r(this, "onPointerDown", (t) => {
      t.target === this.overlay && this.overlay.dispatchEvent(
        new CustomEvent("blora-close-request", { bubbles: !0, composed: !0 })
      );
    });
    this.overlay = t, this.options = { ...y, ...o };
  }
  open() {
    var n;
    if (this.entry) return;
    const t = this.overlay.ownerDocument, o = t.activeElement;
    this.entry = {
      overlay: this.overlay,
      document: t,
      options: this.options,
      previousFocus: o,
      scrollLockCount: 0
    }, a(t).push(this.entry), this.options.modal && w(t), this.options.lockScroll && (v(t), this.entry.scrollLockCount = 1), (this.options.trapFocus || this.options.restoreFocus) && ((n = t.defaultView) == null || n.requestAnimationFrame(() => {
      const s = f(this.overlay);
      s.length > 0 ? s[0].focus() : (this.overlay.setAttribute("tabindex", "-1"), this.overlay.focus());
    })), (this.options.closeOnEscape || this.options.trapFocus) && t.addEventListener("keydown", this.onKeyDown), this.options.closeOnOutsidePointer && this.overlay.addEventListener("pointerdown", this.onPointerDown);
  }
  close() {
    var n;
    if (!this.entry) return;
    const t = a(this.entry.document), o = t.indexOf(this.entry);
    if (o >= 0 && t.splice(o, 1), this.entry.scrollLockCount > 0 && g(this.entry.document), this.options.modal && m(this.entry.document), this.entry.document.removeEventListener("keydown", this.onKeyDown), this.overlay.removeEventListener("pointerdown", this.onPointerDown), this.options.restoreFocus && this.entry.previousFocus instanceof HTMLElement) {
      const s = this.entry.previousFocus;
      (n = this.entry.document.defaultView) == null || n.requestAnimationFrame(() => {
        s.dispatchEvent(new Event("focus")), s.focus();
      });
    }
    this.entry = null;
  }
  destroy() {
    this.close();
  }
}
const O = typeof HTMLElement < "u" ? HTMLElement : class {
};
class M extends O {
  constructor() {
    super(...arguments);
    r(this, "abortController", new AbortController());
    r(this, "_isConnected", !1);
    r(this, "_connectScheduled", !1);
    r(this, "_mounted", !1);
  }
  get isConnectedInternal() {
    return this._isConnected;
  }
  get hasMounted() {
    return this._mounted;
  }
  connectedCallback() {
    var o;
    if (!this._isConnected) {
      if (((o = this.ownerDocument) == null ? void 0 : o.readyState) === "loading") {
        if (this._connectScheduled) return;
        this._connectScheduled = !0, setTimeout(() => {
          this._connectScheduled = !1, this.isConnected && !this._isConnected && this.connectNow();
        }, 0);
        return;
      }
      this.connectNow();
    }
  }
  connectNow() {
    this._isConnected = !0, this.abortController = new AbortController(), this.upgradeProperties(), this._mounted ? this.sync() : (this.render(), this._mounted = !0), this.bindEvents(), this.listen(this.ownerDocument, "blora-locale-change", () => this.onLocaleChange());
  }
  disconnectedCallback() {
    this.abortController.abort(), this._isConnected = !1, this.onDisconnect();
  }
  listen(o, n, s, i = {}) {
    o.addEventListener(n, s, {
      ...i,
      signal: this.abortController.signal
    });
  }
  emit(o, n, s = {}) {
    return this.dispatchEvent(
      new CustomEvent(o, {
        detail: n,
        bubbles: !0,
        composed: !0,
        ...s
      })
    );
  }
  /** Patch the existing official tree after reconnect or a non-structural attribute change. */
  sync() {
  }
  /** Chrome strings follow `setLocale` / `html lang` without remounting. */
  onLocaleChange() {
    this._mounted && this.sync();
  }
  onDisconnect() {
  }
  /** Re-attach listeners/controllers without rebuilding the official tree. */
  rebind() {
    this.onDisconnect(), this.abortController.abort(), this.abortController = new AbortController(), this.bindEvents();
  }
  upgradeProperties() {
  }
}
export {
  M as B,
  D as O
};
