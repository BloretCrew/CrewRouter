var ar = Object.defineProperty;
var ir = (n, l, t) => l in n ? ar(n, l, { enumerable: !0, configurable: !0, writable: !0, value: t }) : n[l] = t;
var A = (n, l, t) => ir(n, typeof l != "symbol" ? l + "" : l, t);
import { i as Ie, c as I } from "./icons-CnJWc0S0.js";
import { enhanceButtons as sr } from "./components/button/index.js";
import { B, O as dt } from "./blora-element-Cn5j6OzD.js";
import { t as v, c as Oe, b as Pe } from "./i18n-Duo0HNK5.js";
import { w as rt } from "./dialog-N9Ob5DI5.js";
function or(n) {
  const l = n.replace(/\s+/g, "");
  return l ? typeof Intl < "u" && "Segmenter" in Intl ? [...new Intl.Segmenter(void 0, { granularity: "grapheme" }).segment(l)].length : [...l].length : 0;
}
function lr(n) {
  const l = n.getAttribute("data-variant");
  if (l === "dot" || l === "pill") {
    n.getAttribute("data-shape") === "circle" && n.removeAttribute("data-shape");
    return;
  }
  const t = [...n.childNodes].filter((a) => a.nodeType === Node.TEXT_NODE).map((a) => a.textContent ?? "").join(""), e = or(t), r = !!n.querySelector(":scope > svg");
  e === 1 && !r ? n.setAttribute("data-shape", "circle") : e > 1 ? n.setAttribute("data-shape", "pill") : n.getAttribute("data-shape") === "circle" && n.removeAttribute("data-shape");
}
function cr(n = document) {
  if (typeof document > "u") return;
  const l = [...n.querySelectorAll(".blora-badge")];
  n instanceof HTMLElement && n.matches(".blora-badge") && l.unshift(n), l.forEach((t) => {
    const e = t.getAttribute("data-icon");
    if (e && Ie(e) && !t.querySelector(":scope > svg[data-blora-icon]")) {
      const r = I(e, 12, t.ownerDocument);
      r.dataset.bloraIcon = e, t.getAttribute("data-icon-position") === "end" ? t.append(r) : t.prepend(r);
    }
    lr(t);
  });
}
const ur = ".blora-button, .blora-badge";
function gt(n) {
  if (n.matches(ur)) return;
  const l = n.getAttribute("data-icon");
  if (!l || !Ie(l)) return;
  const t = n.querySelector(":scope > svg[data-blora-icon]");
  if ((t == null ? void 0 : t.getAttribute("data-blora-icon")) === l || !t && n.childElementCount > 0) return;
  const e = Number(n.getAttribute("data-icon-size")), r = I(l, e > 0 ? e : 16, n.ownerDocument);
  e > 0 || (r.setAttribute("width", "1em"), r.setAttribute("height", "1em")), t ? t.replaceWith(r) : n.append(r), !n.hasAttribute("aria-label") && !n.hasAttribute("role") && n.setAttribute("aria-hidden", "true");
}
function bt(n = document) {
  typeof document > "u" || (sr(n), cr(n), n instanceof Element && n.hasAttribute("data-icon") && gt(n), n.querySelectorAll("[data-icon]").forEach(gt));
}
const ht = /* @__PURE__ */ new WeakMap();
function qa(n = document) {
  if (typeof MutationObserver > "u" || !(n != null && n.documentElement)) return () => {
  };
  const l = ht.get(n);
  if (l) return l;
  const t = () => bt(n);
  n.readyState === "loading" ? n.addEventListener("DOMContentLoaded", t, { once: !0 }) : t();
  const e = new MutationObserver((a) => {
    var i;
    for (const s of a) {
      if (s.type === "attributes") {
        const o = s.target;
        (i = o.querySelector(":scope > svg[data-blora-icon]")) == null || i.remove(), bt(o);
        continue;
      }
      s.addedNodes.forEach((o) => {
        o.nodeType === 1 && bt(o);
      });
    }
  });
  e.observe(n.documentElement, {
    subtree: !0,
    childList: !0,
    attributes: !0,
    attributeFilter: ["data-icon"]
  });
  const r = () => {
    e.disconnect(), ht.delete(n);
  };
  return ht.set(n, r), r;
}
const vt = "blora-collapse";
let dr = 0;
const st = ".blora-collapse__item, .blora-accordion__item", lt = ".blora-collapse__head, .blora-accordion__head", br = ".blora-collapse__body, .blora-accordion__body";
function tt(n) {
  return n.hasAttribute("data-open");
}
function mt(n) {
  return n.querySelector(br);
}
function ct(n) {
  const l = n.firstElementChild, t = n.scrollHeight, e = l ? Math.max(l.scrollHeight, l.offsetHeight, l.getBoundingClientRect().height) : 0;
  return Math.ceil(Math.max(t, e, 1));
}
function ft(n, l) {
  n.style.setProperty("--blora-collapse-h", `${l}px`);
}
function hr(n) {
  n.style.maxHeight = "";
}
function pr(n) {
  const l = mt(n), t = n.querySelector(lt);
  if (!l) return;
  const e = ct(l);
  ft(l, e), n.setAttribute("data-open", ""), t == null || t.setAttribute("aria-expanded", "true"), l.setAttribute("aria-hidden", "false");
  const r = (a) => {
    a.propertyName === "max-height" && (l.removeEventListener("transitionend", r), tt(n) && (l.style.maxHeight = "none"));
  };
  l.addEventListener("transitionend", r);
}
function At(n) {
  const l = mt(n), t = n.querySelector(lt);
  if (!l) return;
  const e = l.style.maxHeight === "none" || !l.style.maxHeight ? ct(l) : l.scrollHeight || ct(l);
  ft(l, e), l.style.maxHeight = `${e}px`, l.offsetHeight, n.removeAttribute("data-open"), t == null || t.setAttribute("aria-expanded", "false"), l.setAttribute("aria-hidden", "true"), requestAnimationFrame(() => {
    l.style.maxHeight = "";
  });
}
function Re(n) {
  if (typeof document > "u") return { destroy: () => {
  } };
  n.querySelectorAll(st).forEach((t) => {
    const e = mt(t);
    if (e)
      if (tt(t)) {
        const r = ct(e);
        ft(e, r), e.style.maxHeight = "none", e.setAttribute("aria-hidden", "false");
      } else
        e.style.removeProperty("--blora-collapse-h"), hr(e), e.setAttribute("aria-hidden", "true");
  });
  const l = (t) => {
    const e = t.target.closest(lt);
    if (!e || !n.contains(e)) return;
    const r = e.closest(st);
    if (!r) return;
    const a = r.closest("[data-blora-accordion]") || (n.hasAttribute("data-blora-accordion") || n.classList.contains("blora-accordion") ? n : null), i = tt(r);
    a && !i && a.querySelectorAll(st).forEach((s) => {
      s !== r && tt(s) && At(s);
    }), i ? At(r) : pr(r);
  };
  return n.addEventListener("click", l), n.querySelectorAll(lt).forEach((t) => {
    const e = t.closest(st);
    t.setAttribute("aria-expanded", String(!!e && tt(e)));
  }), {
    destroy() {
      n.removeEventListener("click", l);
    }
  };
}
class mr extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "instanceId", ++dr);
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((e) => e.localName === "blora-collapse-item").map((e) => ({
      content: Array.from(e.childNodes),
      disabled: e.hasAttribute("disabled"),
      heading: e.getAttribute("heading") ?? e.getAttribute("label") ?? "",
      open: e.hasAttribute("open")
    })));
    const t = document.createElement("div");
    t.className = "blora-collapse", t.dataset.bloraGenerated = "";
    for (const [e, r] of this.definitions.entries()) {
      const a = document.createElement("div");
      a.className = "blora-collapse__item", r.open && (a.dataset.open = "");
      const i = document.createElement("button");
      i.className = "blora-collapse__head", i.type = "button", i.disabled = r.disabled, i.id = `blora-collapse-head-${this.instanceId}-${e}`, i.setAttribute("aria-expanded", String(r.open));
      const s = document.createElement("span");
      s.textContent = r.heading;
      const o = document.createElement("span");
      o.className = "blora-collapse__icon", o.appendChild(I("chevron-right", 14)), i.append(s, o);
      const c = document.createElement("div");
      c.className = "blora-collapse__body", c.id = `blora-collapse-panel-${this.instanceId}-${e}`, c.setAttribute("role", "region"), c.setAttribute("aria-labelledby", i.id), c.setAttribute("aria-hidden", String(!r.open)), i.setAttribute("aria-controls", c.id);
      const u = document.createElement("div");
      u.className = "blora-collapse__content", u.append(...r.content), c.appendChild(u), a.append(i, c), t.appendChild(a);
    }
    this.replaceChildren(t);
  }
  bindEvents() {
    const t = this.querySelector(".blora-collapse");
    t && (this.controller = Re(t));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Ta(n = customElements) {
  !n || n.get(vt) || n.define(vt, mr);
}
const yt = "blora-accordion";
let fr = 0;
class gr extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "instanceId", ++fr);
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((e) => e.localName === "blora-accordion-item").map((e) => ({
      content: Array.from(e.childNodes),
      disabled: e.hasAttribute("disabled"),
      heading: e.getAttribute("heading") ?? e.getAttribute("label") ?? "",
      open: e.hasAttribute("open")
    })));
    const t = document.createElement("div");
    t.className = "blora-accordion", t.dataset.bloraAccordion = "", t.dataset.bloraGenerated = "";
    for (const [e, r] of this.definitions.entries()) {
      const a = document.createElement("div");
      a.className = "blora-accordion__item", r.open && (a.dataset.open = "");
      const i = document.createElement("button");
      i.className = "blora-accordion__head", i.type = "button", i.disabled = r.disabled, i.id = `blora-accordion-head-${this.instanceId}-${e}`, i.setAttribute("aria-expanded", String(r.open));
      const s = document.createElement("span");
      s.textContent = r.heading;
      const o = document.createElement("span");
      o.className = "blora-accordion__icon", o.appendChild(I("chevron-right", 14)), i.append(s, o);
      const c = document.createElement("div");
      c.className = "blora-accordion__body", c.id = `blora-accordion-panel-${this.instanceId}-${e}`, c.setAttribute("role", "region"), c.setAttribute("aria-labelledby", i.id), c.setAttribute("aria-hidden", String(!r.open)), i.setAttribute("aria-controls", c.id);
      const u = document.createElement("div");
      u.className = "blora-accordion__content", u.append(...r.content), c.appendChild(u), a.append(i, c), t.appendChild(a);
    }
    this.replaceChildren(t);
  }
  bindEvents() {
    const t = this.querySelector(".blora-accordion");
    t && (this.controller = Re(t));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Ma(n = customElements) {
  !n || n.get(yt) || n.define(yt, gr);
}
function X(n) {
  const l = n;
  if (typeof l.attachInternals != "function") return null;
  try {
    return l.attachInternals();
  } catch {
    return null;
  }
}
function Y(n, l) {
  typeof (n == null ? void 0 : n.setFormValue) == "function" && n.setFormValue(l);
}
const _t = "blora-search";
function Ge(n) {
  const l = n.querySelector("input"), t = n.querySelector(".blora-search__clear");
  if (!l) return { destroy: () => {
  } };
  const e = () => {
    t && (t.hidden = l.value.length === 0);
  }, r = () => e(), a = (i) => {
    i.preventDefault(), l.value = "", e(), l.focus();
  };
  return l.addEventListener("input", r), t == null || t.addEventListener("click", a), e(), {
    destroy() {
      l.removeEventListener("input", r), t == null || t.removeEventListener("click", a);
    }
  };
}
class $e extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "internals", null);
  }
  /** Submitted under `name` via ElementInternals; inner input stays unnamed. */
  syncFormValue() {
    var e;
    const t = ((e = this.querySelector(".blora-input")) == null ? void 0 : e.value) ?? "";
    Y(this.internals, t === "" ? null : t);
  }
  static get observedAttributes() {
    return ["value", "placeholder", "name", "disabled", "required", "label"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  get value() {
    var t;
    return ((t = this.querySelector(".blora-input")) == null ? void 0 : t.value) ?? "";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  focus(t) {
    var e;
    (e = this.querySelector(".blora-input")) == null || e.focus(t);
  }
  render() {
    this.internals ?? (this.internals = X(this));
    const t = document.createElement("div");
    t.className = "blora-search", t.dataset.bloraGenerated = "";
    const e = document.createElement("button");
    e.className = "blora-search__icon", e.type = "button", e.setAttribute("aria-label", this.getAttribute("label") ?? v("search.label")), e.appendChild(I("search"));
    const r = document.createElement("input");
    r.className = "blora-input", r.type = "search", r.value = this.getAttribute("value") ?? "", r.placeholder = this.getAttribute("placeholder") ?? v("search.placeholder"), r.disabled = this.hasAttribute("disabled"), r.required = this.hasAttribute("required"), r.name = this.internals ? "" : this.getAttribute("name") ?? "";
    const a = document.createElement("button");
    a.className = "blora-search__clear", a.type = "button", a.hidden = r.value.length === 0, a.disabled = r.disabled, a.setAttribute("aria-label", v("common.clear")), a.appendChild(I("close")), t.append(e, r, a), this.replaceChildren(t), this.syncFormValue();
  }
  sync() {
    const t = this.querySelector(".blora-input");
    if (!t) return;
    document.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value), t.placeholder = this.getAttribute("placeholder") ?? v("search.placeholder"), t.disabled = this.hasAttribute("disabled"), t.required = this.hasAttribute("required"), t.name = this.internals ? "" : this.getAttribute("name") ?? "";
    const e = this.querySelector(".blora-search__clear");
    e && (e.hidden = t.value.length === 0, e.disabled = t.disabled);
    const r = this.querySelector(".blora-search__icon");
    r && r.setAttribute("aria-label", this.getAttribute("label") ?? v("search.label")), this.syncFormValue();
  }
  bindEvents() {
    var r;
    const t = this.querySelector(".blora-search");
    (r = this.controller) == null || r.destroy(), this.controller = t ? Ge(t) : null;
    const e = this.querySelector(".blora-input");
    e && this.listen(e, "input", () => this.syncFormValue());
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
A($e, "formAssociated", !0);
function Ba(n = customElements) {
  !n || n.get(_t) || n.define(_t, $e);
}
const Et = "blora-command";
function vr() {
  if (typeof navigator < "u") {
    const n = navigator.platform || "", l = navigator.userAgent || "";
    if (/Mac|iPhone|iPad|iPod/i.test(n) || /Mac OS X/i.test(l)) return "⌘";
  }
  return "Ctrl+";
}
function Ar(n) {
  const l = n.querySelector("input"), t = n.querySelector(".blora-cmdk-results, .blora-command__results") || n, e = () => Array.from(t.querySelectorAll(".blora-cmdk-item, .blora-command__item")), r = vr();
  n.querySelectorAll("kbd[data-keys], .blora-command__kbd, .blora-cmdk-kbd").forEach((c) => {
    const u = c.dataset.keys || c.textContent || "";
    c.textContent = u.replace(/^(⌘|Ctrl\+?|ctrl\+?)/, r === "⌘" ? "⌘" : "Ctrl+"), c.dataset.keys || (c.dataset.keys = u);
  });
  let a = 0;
  const i = () => {
    const c = e().filter((b) => b.style.display !== "none");
    c.forEach((b, d) => {
      b.toggleAttribute("data-active", d === a), b.setAttribute("aria-selected", d === a ? "true" : "false");
    });
    const u = c[a];
    l && (u != null && u.id) && l.setAttribute("aria-activedescendant", u.id);
  }, s = () => {
    const c = ((l == null ? void 0 : l.value) || "").trim().toLowerCase();
    e().forEach((u, b) => {
      const d = (u.textContent || "").toLowerCase(), m = !c || d.includes(c);
      u.style.display = m ? "" : "none";
    }), a = 0, i();
  }, o = (c) => {
    var b;
    const u = e().filter((d) => d.style.display !== "none");
    u.length && (c.key === "ArrowDown" ? (c.preventDefault(), a = Math.min(u.length - 1, a + 1), i()) : c.key === "ArrowUp" ? (c.preventDefault(), a = Math.max(0, a - 1), i()) : c.key === "Enter" && (c.preventDefault(), (b = u[a]) == null || b.click()));
  };
  return e().forEach((c) => {
    c.addEventListener("mouseenter", () => {
      a = e().filter((b) => b.style.display !== "none").indexOf(c), i();
    }), c.addEventListener("click", () => {
      var u;
      n.dispatchEvent(
        new CustomEvent("blora:command", {
          bubbles: !0,
          detail: { label: (u = c.textContent) == null ? void 0 : u.trim() }
        })
      );
    });
  }), l == null || l.addEventListener("input", s), l == null || l.addEventListener("keydown", o), i(), {
    destroy() {
      l == null || l.removeEventListener("input", s), l == null || l.removeEventListener("keydown", o);
    }
  };
}
const yr = /* @__PURE__ */ new Set(["document", "folder", "search", "settings"]);
let _r = 0;
class Er extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "searchController", null);
    A(this, "definitions", null);
    A(this, "relocating", !1);
    A(this, "home", null);
    A(this, "cancelCloseMotion", null);
    A(this, "overlay", null);
    A(this, "hostInTopLayer", !1);
  }
  static get observedAttributes() {
    return ["placeholder", "open"];
  }
  attributeChangedCallback(t) {
    this.isConnectedInternal && t !== "open" && this.sync();
  }
  show() {
    var e, r;
    this.setAttribute("data-overlay", ""), this.setAttribute("role", "dialog"), this.setAttribute("aria-modal", "true"), (e = this.cancelCloseMotion) == null || e.call(this), this.cancelCloseMotion = null, this.removeAttribute("data-exiting"), this.portalToBody(), this.setAttribute("open", ""), this.promoteToTopLayer(), (r = this.overlay) == null || r.close(), this.overlay = new dt(this, {
      modal: !0,
      closeOnEscape: !1,
      closeOnOutsidePointer: !1,
      restoreFocus: !0,
      trapFocus: !0,
      lockScroll: !0
    }), this.overlay.open();
    const t = this.querySelector("input");
    t == null || t.setAttribute("aria-expanded", "true"), t == null || t.focus();
  }
  close() {
    var t, e;
    this.hasAttribute("open") && (this.setAttribute("data-exiting", ""), this.removeAttribute("open"), this.removeAttribute("role"), this.removeAttribute("aria-modal"), (t = this.querySelector("input")) == null || t.setAttribute("aria-expanded", "false"), (e = this.cancelCloseMotion) == null || e.call(this), this.cancelCloseMotion = rt(this, () => {
      var r;
      this.cancelCloseMotion = null, this.removeAttribute("data-exiting"), (r = this.overlay) == null || r.close(), this.overlay = null, this.dismissTopLayer(), this.restoreHome();
    }));
  }
  disconnectedCallback() {
    this.relocating || super.disconnectedCallback();
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((c) => c.localName === "blora-command-item").map((c) => {
      var d;
      const u = c.getAttribute("icon") ?? "document", b = c.getAttribute("label") ?? ((d = c.textContent) == null ? void 0 : d.trim()) ?? "";
      return {
        disabled: c.hasAttribute("disabled"),
        icon: yr.has(u) ? u : "document",
        label: b,
        shortcut: c.getAttribute("shortcut") ?? "",
        value: c.getAttribute("value") ?? b
      };
    }));
    const t = document.createElement("div");
    t.className = "blora-command", t.dataset.bloraGenerated = "";
    const e = document.createElement("div");
    e.className = "blora-command__search";
    const r = document.createElement("div");
    r.className = "blora-search";
    const a = document.createElement("span");
    a.className = "blora-search__icon", a.setAttribute("aria-hidden", "true"), a.appendChild(I("search"));
    const i = document.createElement("input");
    i.className = "blora-input", i.type = "search", i.setAttribute("role", "combobox"), i.setAttribute("aria-autocomplete", "list"), i.setAttribute("aria-expanded", this.hasAttribute("open") ? "true" : "false"), i.placeholder = this.getAttribute("placeholder") ?? v("command.placeholder");
    const s = document.createElement("button");
    s.className = "blora-search__clear", s.type = "button", s.hidden = !0, s.setAttribute("aria-label", v("command.clear")), s.appendChild(I("close")), r.append(a, i, s), e.appendChild(r);
    const o = document.createElement("div");
    o.className = "blora-cmdk-results blora-command__results", o.id = `blora-command-list-${++_r}`, o.setAttribute("role", "listbox"), i.setAttribute("aria-controls", o.id), this.definitions.forEach((c, u) => {
      const b = document.createElement("div");
      b.className = "blora-cmdk-item blora-command__item", b.id = `${o.id}-opt-${u}`, b.setAttribute("role", "option"), b.setAttribute("aria-selected", u === 0 ? "true" : "false"), b.dataset.value = c.value, u === 0 && (b.dataset.active = ""), c.disabled && (b.dataset.disabled = "", b.setAttribute("aria-disabled", "true"));
      const d = document.createElement("span");
      d.appendChild(I(c.icon));
      const m = document.createElement("span");
      if (m.className = "blora-text-sm", m.textContent = c.label, b.append(d, m), c.shortcut) {
        const p = document.createElement("kbd");
        p.className = "blora-command__kbd", p.dataset.keys = c.shortcut, p.textContent = c.shortcut, b.appendChild(p);
      }
      o.appendChild(b);
    }), t.append(e, o), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-search .blora-input, .blora-input");
    t && (t.placeholder = this.getAttribute("placeholder") ?? v("command.placeholder"));
  }
  bindEvents() {
    var r, a;
    const t = this.querySelector(".blora-command"), e = t == null ? void 0 : t.querySelector(".blora-search");
    t && ((r = this.controller) == null || r.destroy(), (a = this.searchController) == null || a.destroy(), this.controller = Ar(t), e && (this.searchController = Ge(e)), this.listen(this, "pointerdown", (i) => {
      i.target === this && this.hasAttribute("open") && this.close();
    }), this.listen(this, "keydown", (i) => {
      i.key === "Escape" && this.hasAttribute("open") && (i.preventDefault(), this.close());
    }));
  }
  onDisconnect() {
    var t, e, r, a;
    (t = this.cancelCloseMotion) == null || t.call(this), this.cancelCloseMotion = null, (e = this.overlay) == null || e.close(), this.overlay = null, this.dismissTopLayer(), (r = this.controller) == null || r.destroy(), (a = this.searchController) == null || a.destroy(), this.controller = null, this.searchController = null, this.restoreHome();
  }
  promoteToTopLayer() {
    if (typeof this.showPopover == "function") {
      if (this.setAttribute("popover", "manual"), this.matches(":popover-open")) {
        this.hostInTopLayer = !0;
        return;
      }
      try {
        this.showPopover(), this.hostInTopLayer = !0;
      } catch {
        this.hostInTopLayer = !1;
      }
    }
  }
  dismissTopLayer() {
    if (this.hostInTopLayer && typeof this.hidePopover == "function")
      try {
        this.hidePopover();
      } catch {
      }
    this.hostInTopLayer = !1, this.getAttribute("popover") === "manual" && this.removeAttribute("popover");
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
}
function Ia(n = customElements) {
  !n || n.get(Et) || n.define(Et, Er);
}
const Ct = "blora-datepicker", wt = () => Oe(), Cr = () => Pe(), xt = (n, l) => {
  n.replaceChildren(
    I(l === "prev" ? "chevron-left" : "chevron-right", 14, n.ownerDocument)
  );
};
function pt(n) {
  return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0");
}
function wr(n) {
  const l = n.split("-");
  if (l.length !== 3) return null;
  const t = new Date(Number(l[0]), Number(l[1]) - 1, Number(l[2]));
  return Number.isNaN(t.getTime()) ? null : t;
}
function xr(n) {
  const l = n.querySelector("input"), t = n.querySelector(".blora-datepicker__btn");
  if (!l) return { destroy: () => {
  } };
  l.type !== "date" && (l.type = "date");
  const e = l.min, r = l.max;
  let a = null, i = (/* @__PURE__ */ new Date()).getFullYear(), s = (/* @__PURE__ */ new Date()).getMonth(), o = "days";
  const c = /* @__PURE__ */ new Date();
  let u = !1, b = n.querySelector(".blora-datepicker__panel");
  b || (b = document.createElement("div"), b.className = "blora-datepicker__panel", n.appendChild(b));
  const d = (_) => {
    const E = pt(_);
    return !(e && E < e || r && E > r);
  }, m = () => {
    if (l.value) {
      const _ = wr(l.value);
      if (_) {
        a = _, i = _.getFullYear(), s = _.getMonth();
        return;
      }
    }
    a = null, i || (i = c.getFullYear(), s = c.getMonth());
  }, p = (_, E, L) => {
    const T = document.createElement(_);
    return E && (T.className = E), L != null && (T.textContent = L), T;
  }, h = () => {
    b.replaceChildren();
    const _ = p("div", "blora-datepicker__head"), E = p("button", "blora-datepicker__nav");
    E.setAttribute("type", "button"), E.setAttribute("data-nav", "prev"), E.setAttribute("aria-label", v("calendar.prev")), xt(E, "prev");
    const L = p("button", "blora-datepicker__nav");
    L.setAttribute("type", "button"), L.setAttribute("data-nav", "next"), L.setAttribute("aria-label", v("calendar.next")), xt(L, "next");
    let T = "", f = null;
    if (o === "days")
      T = v("calendar.monthYear", {
        year: i,
        month: wt()[s] ?? ""
      }), f = "months";
    else if (o === "months")
      T = v("calendar.year", { year: i }), f = "years";
    else {
      const M = Math.floor(i / 10) * 10;
      T = v("calendar.decade", { start: M, end: M + 9 });
    }
    const x = p("span", "blora-datepicker__title", T);
    if (f && x.setAttribute("data-zoom", f), _.append(E, x, L), b.appendChild(_), o === "days") {
      const M = p("div", "blora-datepicker__grid");
      Cr().forEach(($) => M.appendChild(p("div", "blora-datepicker__dow", $)));
      const O = new Date(i, s, 1).getDay(), R = new Date(i, s + 1, 0).getDate(), G = new Date(i, s, 0).getDate();
      for (let $ = O - 1; $ >= 0; $--) {
        const H = p("div", "blora-datepicker__cell", String(G - $));
        H.setAttribute("data-other", ""), M.appendChild(H);
      }
      for (let $ = 1; $ <= R; $++) {
        const H = new Date(i, s, $), V = p("div", "blora-datepicker__cell", String($));
        V.setAttribute("data-day", String($)), H.toDateString() === c.toDateString() && V.setAttribute("data-today", ""), a && H.toDateString() === a.toDateString() && V.setAttribute("data-selected", ""), d(H) || V.setAttribute("disabled", ""), M.appendChild(V);
      }
      const W = (7 - (O + R) % 7) % 7;
      for (let $ = 1; $ <= W; $++) {
        const H = p("div", "blora-datepicker__cell", String($));
        H.setAttribute("data-other", ""), M.appendChild(H);
      }
      b.appendChild(M);
    } else if (o === "months") {
      const M = p("div", "blora-datepicker__grid blora-datepicker__grid--months");
      wt().forEach((P, O) => {
        const R = p("div", "blora-datepicker__cell blora-datepicker__cell--month", P);
        R.setAttribute("data-month", String(O)), a && i === a.getFullYear() && O === a.getMonth() && R.setAttribute("data-selected", ""), i === c.getFullYear() && O === c.getMonth() && R.setAttribute("data-today", ""), M.appendChild(R);
      }), b.appendChild(M);
    } else {
      const M = Math.floor(i / 10) * 10, P = p("div", "blora-datepicker__grid blora-datepicker__grid--years");
      for (let O = M - 1; O <= M + 10; O++) {
        const R = p("div", "blora-datepicker__cell blora-datepicker__cell--year", String(O));
        R.setAttribute("data-year", String(O)), (O < M || O > M + 9) && R.setAttribute("data-other", ""), a && O === a.getFullYear() && R.setAttribute("data-selected", ""), O === c.getFullYear() && R.setAttribute("data-today", ""), P.appendChild(R);
      }
      b.appendChild(P);
    }
    const k = p("div", "blora-datepicker__foot"), N = p("button", "blora-button");
    N.setAttribute("type", "button"), N.setAttribute("data-variant", "ghost"), N.setAttribute("data-size", "sm"), N.setAttribute("data-clear", ""), N.textContent = v("common.clear");
    const q = p("button", "blora-button");
    q.setAttribute("type", "button"), q.setAttribute("data-variant", "ghost"), q.setAttribute("data-size", "sm"), q.setAttribute("data-today", ""), q.textContent = v("common.today"), k.append(N, q), b.appendChild(k);
  }, y = () => {
    m(), o = "days", b.setAttribute("data-open", ""), n.style.zIndex = "var(--blora-z-dropdown)", h();
  }, g = () => {
    b.removeAttribute("data-open"), n.style.zIndex = "";
  }, C = (_) => {
    _.preventDefault(), _.stopPropagation(), b.hasAttribute("data-open") ? g() : (u = !0, y(), queueMicrotask(() => {
      u = !1;
    }));
  }, S = (_) => {
    if (!b.hasAttribute("data-open") || u) return;
    const E = _.target;
    E && !E.isConnected || E && n.contains(E) || g();
  }, D = (_) => {
    _.stopPropagation();
    const E = _.target, L = E.closest("[data-nav]");
    if (L) {
      const N = L.dataset.nav === "prev" ? -1 : 1;
      o === "days" ? (s += N, s < 0 ? (s = 11, i--) : s > 11 && (s = 0, i++)) : o === "months" ? i += N : i += N * 10, h();
      return;
    }
    const T = E.closest("[data-zoom]");
    if (T) {
      T.dataset.zoom === "months" ? o = "months" : T.dataset.zoom === "years" && (o = "years"), h();
      return;
    }
    if (E.closest("[data-today]")) {
      a = /* @__PURE__ */ new Date(), i = a.getFullYear(), s = a.getMonth(), o = "days", l.value = pt(a), l.dispatchEvent(new Event("change", { bubbles: !0 })), g();
      return;
    }
    if (E.closest("[data-clear]")) {
      a = null, l.value = "", l.dispatchEvent(new Event("change", { bubbles: !0 })), g();
      return;
    }
    const f = E.closest(".blora-datepicker__cell[data-day]");
    if (f && !f.hasAttribute("disabled") && !f.hasAttribute("data-other")) {
      a = new Date(i, s, Number(f.dataset.day)), l.value = pt(a), l.dispatchEvent(new Event("change", { bubbles: !0 })), g();
      return;
    }
    const x = E.closest("[data-month]");
    if (x) {
      s = Number(x.dataset.month), o = "days", h();
      return;
    }
    const k = E.closest("[data-year]");
    k && (i = Number(k.dataset.year), o = "months", h());
  }, w = (_) => {
    l.showPicker;
  };
  return t == null || t.addEventListener("click", C), b.addEventListener("click", D), document.addEventListener("click", S), l.addEventListener("click", w), {
    destroy() {
      t == null || t.removeEventListener("click", C), b.removeEventListener("click", D), document.removeEventListener("click", S), l.removeEventListener("click", w);
    }
  };
}
class kr extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
  }
  static get observedAttributes() {
    return ["value", "min", "max", "placeholder", "name", "disabled", "required"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  get value() {
    var t;
    return ((t = this.querySelector(".blora-input")) == null ? void 0 : t.value) ?? "";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  focus(t) {
    var e;
    (e = this.querySelector(".blora-input")) == null || e.focus(t);
  }
  render() {
    const t = document.createElement("div");
    t.className = "blora-datepicker", t.dataset.bloraDatepicker = "", t.dataset.bloraGenerated = "";
    const e = document.createElement("input");
    e.className = "blora-input", e.type = "date", e.value = this.getAttribute("value") ?? "", e.min = this.getAttribute("min") ?? "1900-01-01", e.max = this.getAttribute("max") ?? "2099-12-31", e.placeholder = this.getAttribute("placeholder") ?? "YYYY-MM-DD", e.disabled = this.hasAttribute("disabled"), e.required = this.hasAttribute("required"), this.hasAttribute("name") && (e.name = this.getAttribute("name") ?? "");
    const r = document.createElement("button");
    r.className = "blora-datepicker__btn", r.type = "button", r.tabIndex = -1, r.disabled = e.disabled, r.setAttribute("aria-label", v("datepicker.pick")), r.appendChild(I("calendar")), t.append(e, r), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-input");
    if (!t) return;
    document.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value), t.min = this.getAttribute("min") ?? "1900-01-01", t.max = this.getAttribute("max") ?? "2099-12-31", t.placeholder = this.getAttribute("placeholder") ?? "YYYY-MM-DD", t.disabled = this.hasAttribute("disabled"), t.required = this.hasAttribute("required"), this.hasAttribute("name") && (t.name = this.getAttribute("name") ?? "");
    const e = this.querySelector(".blora-datepicker__btn");
    e && (e.disabled = t.disabled);
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-datepicker");
    (e = this.controller) == null || e.destroy(), this.controller = t ? xr(t) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Oa(n = customElements) {
  !n || n.get(Ct) || n.define(Ct, kr);
}
const kt = "blora-range";
function Sr(n) {
  const l = n.querySelector(".blora-range__track"), t = n.querySelector(".blora-range__fill"), e = Array.from(n.querySelectorAll(".blora-range__thumb")), r = n.querySelector(".blora-range__value");
  if (!l || e.length < 2) return { destroy: () => {
  } };
  const a = Number(n.dataset.min ?? 0), i = Number(n.dataset.max ?? 100), o = n.dataset.tooltip !== "false" ? e.map(() => {
    const d = document.createElement("span");
    return d.className = "blora-range__tip", d.setAttribute("aria-hidden", "true"), n.appendChild(d), d;
  }) : [], c = (d) => (d - a) / (i - a) * 100, u = () => {
    const d = e.map((g) => Number(g.dataset.val ?? a)), m = Math.min(...d), p = Math.max(...d), h = c(m), y = c(p);
    e.forEach((g, C) => {
      const S = Number(g.dataset.val ?? a);
      g.style.left = `${c(S)}%`, o[C] && (o[C].textContent = String(S), o[C].style.left = `${c(S)}%`);
    }), t && (t.style.left = `${h}%`, t.style.width = `${y - h}%`), r && (r.textContent = `${m} – ${p}`);
  }, b = [];
  return e.forEach((d, m) => {
    let p = !1;
    const h = (D) => {
      p = !0, d.setPointerCapture(D.pointerId), o[m] && o[m].setAttribute("data-show", ""), D.preventDefault();
    }, y = (D) => {
      if (!p) return;
      const w = l.getBoundingClientRect();
      let _ = (D.clientX - w.left) / w.width * 100;
      _ = Math.max(0, Math.min(100, _));
      const E = Math.round(a + _ / 100 * (i - a)), L = e.indexOf(d), T = Number(e[1 - L].dataset.val ?? a);
      L === 0 && E > T || L === 1 && E < T || (d.dataset.val = String(E), u());
    }, g = (D) => {
      p = !1, o[m] && o[m].removeAttribute("data-show");
      try {
        d.releasePointerCapture(D.pointerId);
      } catch {
      }
    }, C = () => {
      var D;
      return (D = o[m]) == null ? void 0 : D.setAttribute("data-show", "");
    }, S = () => {
      var D;
      return (D = o[m]) == null ? void 0 : D.removeAttribute("data-show");
    };
    d.addEventListener("pointerdown", h), d.addEventListener("pointermove", y), d.addEventListener("pointerup", g), d.addEventListener("focus", C), d.addEventListener("blur", S), b.push(() => {
      d.removeEventListener("pointerdown", h), d.removeEventListener("pointermove", y), d.removeEventListener("pointerup", g), d.removeEventListener("focus", C), d.removeEventListener("blur", S);
    });
  }), u(), {
    destroy() {
      b.forEach((d) => d()), o.forEach((d) => d.remove());
    }
  };
}
class Fe extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "internals", null);
  }
  static get observedAttributes() {
    return ["min", "max", "values", "tooltip"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  get values() {
    var e, r;
    const t = this.querySelectorAll(".blora-range__thumb");
    return [Number(((e = t[0]) == null ? void 0 : e.dataset.val) ?? 0), Number(((r = t[1]) == null ? void 0 : r.dataset.val) ?? 100)];
  }
  set values(t) {
    this.setAttribute("values", t.join(","));
  }
  /** Submitted as one comma-joined entry matching the `values` attribute format. */
  syncFormValue() {
    const [t, e] = this.values;
    Y(this.internals, `${t},${e}`);
  }
  render() {
    const t = Number(this.getAttribute("min") ?? 0), e = Number(this.getAttribute("max") ?? 100), r = (this.getAttribute("values") ?? "20,75").split(",").slice(0, 2).map((d) => Number(d.trim())), a = Number.isFinite(r[0]) ? Math.max(t, Math.min(e, r[0])) : t, i = Number.isFinite(r[1]) ? Math.max(a, Math.min(e, r[1])) : e, s = document.createElement("div");
    s.className = "blora-range", s.dataset.bloraGenerated = "", s.dataset.min = String(t), s.dataset.max = String(e), this.getAttribute("tooltip") === "false" && (s.dataset.tooltip = "false");
    const o = document.createElement("div");
    o.className = "blora-range__track";
    const c = document.createElement("div");
    c.className = "blora-range__fill", o.appendChild(c);
    const u = (d, m) => {
      const p = document.createElement("div");
      return p.className = "blora-range__thumb", p.dataset.val = String(d), p.tabIndex = 0, p.setAttribute("role", "slider"), p.setAttribute("aria-label", m), p.setAttribute("aria-valuemin", String(t)), p.setAttribute("aria-valuemax", String(e)), p.setAttribute("aria-valuenow", String(d)), p;
    }, b = document.createElement("span");
    b.className = "blora-range__value", b.textContent = `${a} – ${i}`, s.append(o, u(a, v("common.min")), u(i, v("common.max")), b), this.replaceChildren(s), this.internals ?? (this.internals = X(this)), this.syncFormValue();
  }
  sync() {
    const t = this.querySelector(".blora-range");
    if (!t) return;
    const e = this.getAttribute("min"), r = this.getAttribute("max");
    e && (t.dataset.min = e), r && (t.dataset.max = r), this.getAttribute("tooltip") === "false" ? t.dataset.tooltip = "false" : delete t.dataset.tooltip, this.rebind(), this.syncFormValue();
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-range");
    (e = this.controller) == null || e.destroy(), this.controller = t ? Sr(t) : null, t && this.listen(t, "pointerup", () => this.syncFormValue());
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
A(Fe, "formAssociated", !0);
function Pa(n = customElements) {
  !n || n.get(kt) || n.define(kt, Fe);
}
const St = "blora-segmented";
function Nr(n) {
  if (typeof document > "u") return { destroy: () => {
  } };
  const l = n.ownerDocument.defaultView;
  let t = n.querySelector(".blora-segmented__indicator");
  t || (t = n.ownerDocument.createElement("span"), t.className = "blora-segmented__indicator", t.setAttribute("aria-hidden", "true"), n.insertBefore(t, n.firstChild));
  const e = Array.from(n.querySelectorAll(".blora-segmented__item"));
  n.setAttribute("role", "radiogroup");
  const r = (u) => {
    const b = n.getBoundingClientRect(), d = u.getBoundingClientRect();
    t.style.left = `${d.left - b.left}px`, t.style.width = `${d.width}px`;
  }, a = () => e.filter((u) => u.getAttribute("aria-disabled") !== "true"), i = (u, b = !1, d = !0) => {
    var m;
    !u || !a().includes(u) || (e.forEach((p) => {
      const h = p === u;
      p.toggleAttribute("data-active", h), p.setAttribute("aria-checked", String(h)), p.getAttribute("aria-disabled") !== "true" && (p.tabIndex = h ? 0 : -1);
    }), n.dataset.value = u.dataset.value || ((m = u.textContent) == null ? void 0 : m.trim()) || "", r(u), b && u.focus(), d && n.dispatchEvent(
      new CustomEvent("blora-change", {
        bubbles: !0,
        detail: { value: n.dataset.value, item: u }
      })
    ));
  };
  e.forEach((u) => {
    u.setAttribute("role", "radio");
    const b = u.getAttribute("aria-disabled") === "true";
    u.setAttribute("aria-checked", String(u.hasAttribute("data-active"))), u.tabIndex = b ? -1 : u.hasAttribute("data-active") ? 0 : -1, u.addEventListener("click", () => i(u));
  });
  const s = (u) => {
    const b = a();
    if (!b.length) return;
    const d = n.ownerDocument, m = b.indexOf(d.activeElement);
    let p = m < 0 ? 0 : m;
    if (u.key === "ArrowRight" || u.key === "ArrowDown") p = (p + 1) % b.length;
    else if (u.key === "ArrowLeft" || u.key === "ArrowUp")
      p = (p - 1 + b.length) % b.length;
    else if (u.key === "Home") p = 0;
    else if (u.key === "End") p = b.length - 1;
    else if (u.key === "Enter" || u.key === " ") {
      u.preventDefault(), i(d.activeElement);
      return;
    } else return;
    u.preventDefault(), i(b[p], !0);
  };
  n.addEventListener("keydown", s);
  const o = () => {
    const u = e.find((b) => b.hasAttribute("data-active"));
    u && r(u);
  };
  l.addEventListener("resize", o);
  const c = e.find((u) => u.hasAttribute("data-active")) || a()[0];
  return c && (i(c, !1, !1), l.requestAnimationFrame(() => r(c))), {
    destroy() {
      n.removeEventListener("keydown", s), l.removeEventListener("resize", o);
    }
  };
}
class Dr extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
  }
  static get observedAttributes() {
    return ["value", "disabled"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  get value() {
    var t;
    return ((t = this.querySelector(".blora-segmented")) == null ? void 0 : t.dataset.value) ?? "";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  render() {
    var a, i;
    this.definitions || (this.definitions = Array.from(this.children).filter((s) => s.localName === "blora-segment").map((s) => {
      var c;
      const o = s.getAttribute("label") ?? ((c = s.textContent) == null ? void 0 : c.trim()) ?? "";
      return {
        disabled: s.hasAttribute("disabled"),
        label: o,
        selected: s.hasAttribute("selected"),
        value: s.getAttribute("value") ?? o
      };
    }));
    const t = this.getAttribute("value") ?? ((a = this.definitions.find((s) => s.selected)) == null ? void 0 : a.value) ?? ((i = this.definitions.find((s) => !s.disabled)) == null ? void 0 : i.value), e = document.createElement("div");
    e.className = "blora-segmented", e.dataset.bloraGenerated = "";
    const r = document.createElement("span");
    r.className = "blora-segmented__indicator", r.setAttribute("aria-hidden", "true"), e.appendChild(r);
    for (const s of this.definitions) {
      const o = document.createElement("button");
      o.type = "button", o.className = "blora-segmented__item", o.dataset.value = s.value, o.textContent = s.label, o.disabled = s.disabled || this.hasAttribute("disabled"), o.disabled && o.setAttribute("aria-disabled", "true"), s.value === t && (o.dataset.active = ""), e.appendChild(o);
    }
    this.replaceChildren(e);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-segmented");
    t && (this.controller = Nr(t));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Ra(n = customElements) {
  !n || n.get(St) || n.define(St, Dr);
}
const Nt = "blora-tabs", Lr = /* @__PURE__ */ new Set(["ArrowLeft", "ArrowRight", "Home", "End"]), qr = /* @__PURE__ */ new Set(["ArrowUp", "ArrowDown", "Home", "End"]);
let Tr = 0;
function Dt(n) {
  const l = new AbortController(), { signal: t } = l, e = n.querySelector(".blora-tabs__nav");
  if (!e)
    return { select: () => {
    }, destroy: () => {
    } };
  const r = e, a = Array.from(r.querySelectorAll(".blora-tabs__tab")), i = Array.from(n.querySelectorAll(".blora-tabs__panel")), s = typeof window < "u" ? window : void 0, o = (s == null ? void 0 : s.document.createElement("span")) ?? null;
  o && (o.className = "blora-tabs__indicator", o.setAttribute("aria-hidden", "true"), r.appendChild(o)), n.setAttribute("data-tabs-enhanced", "");
  const u = n.getAttribute("data-orientation") === "vertical" ? qr : Lr;
  r.setAttribute("role", "tablist"), a.forEach((g, C) => {
    g.setAttribute("role", "tab");
    const S = g.getAttribute("aria-selected") === "true";
    if (g.hasAttribute("disabled") || g.getAttribute("aria-disabled") === "true" ? (g.setAttribute("aria-disabled", "true"), g.tabIndex = -1) : g.tabIndex = S ? 0 : -1, i[C]) {
      const D = g.id || `blora-tabs-tab-${C}`, w = i[C].id || `blora-tabs-panel-${C}`;
      g.id || (g.id = D), i[C].id || (i[C].id = w), g.setAttribute("aria-controls", w), i[C].setAttribute("role", "tabpanel"), i[C].setAttribute("aria-labelledby", D);
    }
  });
  function b(g, C) {
    if (!o || !g) return;
    C ? o.setAttribute("data-instant", "") : o.removeAttribute("data-instant");
    const S = r.getBoundingClientRect(), D = g.getBoundingClientRect();
    o.style.setProperty("--blora-tab-x", `${D.left - S.left}px`), o.style.setProperty("--blora-tab-y", `${D.top - S.top}px`), o.style.setProperty("--blora-tab-w", `${D.width}px`), o.style.setProperty("--blora-tab-h", `${D.height}px`), C && s && s.requestAnimationFrame(() => {
      o.removeAttribute("data-instant");
    });
  }
  function d(g, C) {
    const S = a.indexOf(g);
    S !== -1 && (g.hasAttribute("disabled") || g.getAttribute("aria-disabled") === "true" || (a.forEach((D, w) => {
      const _ = w === S;
      D.setAttribute("aria-selected", String(_)), !D.hasAttribute("disabled") && D.getAttribute("aria-disabled") !== "true" && (D.tabIndex = _ ? 0 : -1);
    }), i.forEach((D, w) => {
      const _ = w === S;
      D.style.display = _ ? "" : "none", D.setAttribute("aria-hidden", String(!_)), _ && (D.removeAttribute("data-entering"), D.offsetWidth, D.setAttribute("data-entering", ""));
    }), b(g, !1), C && g.focus()));
  }
  function m() {
    const g = a.find((C) => C.getAttribute("aria-selected") === "true");
    return g || a.find(
      (C) => !C.hasAttribute("disabled") && C.getAttribute("aria-disabled") !== "true"
    );
  }
  r.addEventListener(
    "click",
    (g) => {
      const S = g.target.closest(".blora-tabs__tab");
      !S || !r.contains(S) || d(S, !1);
    },
    { signal: t }
  ), r.addEventListener(
    "keydown",
    (g) => {
      if (!u.has(g.key)) return;
      const C = a.filter(
        (w) => !w.hasAttribute("disabled") && w.getAttribute("aria-disabled") !== "true"
      );
      if (C.length === 0) return;
      const S = C.indexOf(document.activeElement);
      let D;
      if (g.key === "Home")
        D = 0;
      else if (g.key === "End")
        D = C.length - 1;
      else {
        const w = g.key === "ArrowRight" || g.key === "ArrowDown" ? 1 : -1;
        D = (Math.max(S, 0) + w + C.length) % C.length;
      }
      g.preventDefault(), d(C[D], !0);
    },
    { signal: t }
  ), b(m(), !0);
  const p = m(), h = p ? a.indexOf(p) : 0;
  i.forEach((g, C) => {
    const S = C === h;
    g.style.display = S ? "" : "none", g.setAttribute("aria-hidden", String(!S));
  });
  let y;
  return s && typeof ResizeObserver < "u" && (y = new s.ResizeObserver(() => {
    const g = a.find((C) => C.getAttribute("aria-selected") === "true");
    b(g, !0);
  }), y.observe(r)), {
    select(g, C = !1) {
      const S = a[g];
      S && d(S, C);
    },
    destroy() {
      l.abort(), y == null || y.disconnect(), o == null || o.remove(), n.removeAttribute("data-tabs-enhanced");
    }
  };
}
class Mr extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "reflecting", !1);
    A(this, "instanceId", ++Tr);
  }
  static get observedAttributes() {
    return ["flush", "value", "variant", "orientation"];
  }
  attributeChangedCallback(t) {
    if (this.isConnectedInternal) {
      if (t === "value") {
        this.reflecting || this.activateFromValue();
        return;
      }
      this.sync();
    }
  }
  select(t, e = !1) {
    var r;
    (r = this.controller) == null || r.select(t, e), this.reflectValueFromIndex(t);
  }
  render() {
    var a, i;
    if (this.definitions || (this.definitions = this.readDefinitions()), !this.definitions.length && this.querySelector(".blora-tabs")) return;
    const t = this.getAttribute("value") ?? ((a = this.definitions.find((s) => s.selected)) == null ? void 0 : a.value) ?? ((i = this.definitions.find((s) => !s.disabled)) == null ? void 0 : i.value), e = document.createElement("div");
    e.className = "blora-tabs", e.dataset.bloraGenerated = "";
    const r = document.createElement("div");
    r.className = "blora-tabs__nav", e.appendChild(r), this.definitions.forEach((s, o) => {
      const c = document.createElement("button");
      c.className = "blora-tabs__tab", c.type = "button", c.id = `blora-tabs-tab-${this.instanceId}-${o}`, c.dataset.value = s.value, c.disabled = s.disabled, c.textContent = s.label, c.setAttribute("aria-selected", String(s.value === t)), r.appendChild(c);
    }), this.definitions.forEach((s, o) => {
      const c = document.createElement("div");
      c.className = "blora-tabs__panel", c.id = `blora-tabs-panel-${this.instanceId}-${o}`, c.append(...s.content), e.appendChild(c);
    }), this.replaceChildren(e), this.syncChrome(e);
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-tabs");
    t && ((e = this.controller) == null || e.destroy(), this.controller = Dt(t), this.listen(t, "click", (r) => {
      var i;
      const a = (i = r.target) == null ? void 0 : i.closest(
        ".blora-tabs__tab"
      );
      !a || !t.contains(a) || a.disabled || this.reflectValue(a.dataset.value ?? "");
    }));
  }
  sync() {
    var e;
    const t = this.querySelector(".blora-tabs");
    t && (this.syncChrome(t), (e = this.controller) == null || e.destroy(), this.controller = Dt(t));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
  readDefinitions() {
    const t = Array.from(this.children).filter((a) => a.localName === "blora-tab");
    if (t.length)
      return t.map((a) => {
        const i = a.getAttribute("label") ?? "";
        return {
          content: Array.from(a.childNodes),
          disabled: a.hasAttribute("disabled"),
          label: i,
          selected: a.hasAttribute("selected"),
          value: a.getAttribute("value") ?? i
        };
      });
    const e = Array.from(this.querySelectorAll(".blora-tabs__tab")), r = Array.from(this.querySelectorAll(".blora-tabs__panel"));
    return e.map((a, i) => {
      var s;
      return {
        content: Array.from(((s = r[i]) == null ? void 0 : s.childNodes) ?? []),
        disabled: a.disabled,
        label: a.textContent ?? "",
        selected: a.getAttribute("aria-selected") === "true",
        value: a.dataset.value ?? a.textContent ?? ""
      };
    });
  }
  syncChrome(t) {
    const e = this.getAttribute("variant"), r = this.getAttribute("orientation");
    e ? t.dataset.variant = e : delete t.dataset.variant, r ? t.dataset.orientation = r : delete t.dataset.orientation, t.toggleAttribute("data-flush", this.hasAttribute("flush"));
  }
  activateFromValue() {
    var a;
    const t = this.getAttribute("value") ?? "", r = Array.from(this.querySelectorAll(".blora-tabs__tab")).findIndex((i) => (i.dataset.value ?? "") === t);
    r >= 0 && ((a = this.controller) == null || a.select(r));
  }
  reflectValueFromIndex(t) {
    const e = this.querySelectorAll(".blora-tabs__tab")[t];
    e && this.reflectValue(e.dataset.value ?? "");
  }
  reflectValue(t) {
    (this.getAttribute("value") ?? "") !== t && (this.reflecting = !0, t ? this.setAttribute("value", t) : this.removeAttribute("value"), this.reflecting = !1, this.emit("blora-change", { value: t }));
  }
}
function Ga(n = customElements) {
  !n || n.get(Nt) || n.define(Nt, Mr);
}
const Lt = "blora-timepicker";
function Br(n) {
  const l = n.querySelector("input"), t = n.querySelector(
    ".blora-timepicker__btn, .blora-datepicker__btn"
  );
  if (!l) return { destroy: () => {
  } };
  l.type !== "time" && (l.type = "time");
  let e = 14, r = 30, a = !1, i = n.querySelector(".blora-timepicker__panel");
  i || (i = document.createElement("div"), i.className = "blora-timepicker__panel", n.appendChild(i));
  const s = (f) => String(f).padStart(2, "0"), o = () => s(e) + ":" + s(r), c = 5, u = Math.floor(c / 2), b = 36, d = [], m = () => {
    if (l.value) {
      const f = l.value.split(":");
      f.length >= 2 && (e = Math.min(23, Math.max(0, Number(f[0]) || 0)), r = Math.min(59, Math.max(0, Number(f[1]) || 0)));
    }
  }, p = (f, x) => {
    f.querySelectorAll(".blora-timepicker__item").forEach((k) => {
      const N = k, q = Number(N.dataset.val);
      N.toggleAttribute("data-selected", q === x);
    });
  }, h = (f, x, k, N = !1) => {
    const M = (u * k + (x % k + k) % k) * b;
    N ? f.scrollTo({ top: M, behavior: "smooth" }) : f.scrollTop = M, p(f, (x % k + k) % k);
  }, y = (f, x) => {
    const k = Math.round(f.scrollTop / b);
    return (Math.max(0, Math.min(k, c * x - 1)) % x + x) % x;
  }, g = (f, x, k, N) => {
    let q = !1, M = null, P = !1;
    const O = () => {
      const F = x * b;
      F <= 0 || (f.scrollTop < F * 1.1 ? (P = !0, f.scrollTop += F, P = !1) : f.scrollTop > F * (c - 2.1) && (P = !0, f.scrollTop -= F, P = !1));
    }, R = () => {
      if (P) return;
      O();
      const F = y(f, x);
      N(F);
      const z = Math.floor((f.scrollTop + b / 2) / (x * b)), it = (Math.min(c - 1, Math.max(0, z)) * x + F) * b;
      Math.abs(f.scrollTop - it) > 0.5 && (P = !0, f.scrollTop = it, P = !1), p(f, F);
    }, G = () => {
      P || (q || (q = !0, requestAnimationFrame(() => {
        if (q = !1, P) return;
        O();
        const F = y(f, x);
        N(F), p(f, F);
      })), M && clearTimeout(M), M = setTimeout(R, 90));
    }, U = (F) => {
      if ($) {
        $ = !1, F.preventDefault(), F.stopPropagation();
        return;
      }
      const z = F.target.closest(".blora-timepicker__item");
      if (!z || !f.contains(z)) return;
      F.stopPropagation();
      const at = Number(z.dataset.val);
      N(at);
      const it = Math.floor((f.scrollTop + b / 2) / (x * b)), nr = (Math.min(c - 1, Math.max(0, it)) * x + at) * b;
      f.scrollTo({ top: nr, behavior: "smooth" }), p(f, at);
    };
    let W = !1, $ = !1, H = 0, V = 0, K = -1;
    const j = (F) => {
      var z;
      F.pointerType === "mouse" && F.button !== 0 || (W = !0, $ = !1, H = F.clientY, V = f.scrollTop, K = F.pointerId, (z = f.setPointerCapture) == null || z.call(f, F.pointerId), f.classList.add("is-dragging"), f.style.scrollSnapType = "none");
    }, J = (F) => {
      if (!W || F.pointerId !== K) return;
      const z = F.clientY - H;
      Math.abs(z) > 3 && ($ = !0), f.scrollTop = V - z, F.preventDefault();
    }, nt = (F) => {
      var z;
      if (!(!W || F.pointerId !== K)) {
        W = !1, K = -1;
        try {
          (z = f.releasePointerCapture) == null || z.call(f, F.pointerId);
        } catch {
        }
        f.classList.remove("is-dragging"), f.style.scrollSnapType = "", R();
      }
    };
    f.addEventListener("scroll", G, { passive: !0 }), f.addEventListener("click", U), f.addEventListener("pointerdown", j), f.addEventListener("pointermove", J), f.addEventListener("pointerup", nt), f.addEventListener("pointercancel", nt), h(f, k(), x, !1), d.push(() => {
      f.removeEventListener("scroll", G), f.removeEventListener("click", U), f.removeEventListener("pointerdown", j), f.removeEventListener("pointermove", J), f.removeEventListener("pointerup", nt), f.removeEventListener("pointercancel", nt), M && clearTimeout(M);
    });
  }, C = (f, x, k) => {
    f.replaceChildren();
    for (let N = 0; N < c; N++)
      for (let q = 0; q < x; q++) {
        const M = document.createElement("div");
        M.className = "blora-timepicker__item", M.dataset.val = String(q), M.dataset.kind = k, M.textContent = s(q), f.appendChild(M);
      }
  }, S = () => {
    var G;
    for (; d.length; ) (G = d.pop()) == null || G();
    i.replaceChildren();
    const f = document.createElement("div");
    f.className = "blora-timepicker__wheel";
    const x = document.createElement("div");
    x.className = "blora-timepicker__highlight", x.setAttribute("aria-hidden", "true");
    const k = document.createElement("div");
    k.className = "blora-timepicker__cols";
    const N = document.createElement("div");
    N.className = "blora-timepicker__scroll", N.setAttribute("data-scroll", "h"), N.setAttribute("role", "listbox"), N.setAttribute("aria-label", v("timepicker.hour")), C(N, 24, "h");
    const q = document.createElement("span");
    q.className = "blora-timepicker__sep", q.textContent = ":", q.setAttribute("aria-hidden", "true");
    const M = document.createElement("div");
    M.className = "blora-timepicker__scroll", M.setAttribute("data-scroll", "m"), M.setAttribute("role", "listbox"), M.setAttribute("aria-label", v("timepicker.minute")), C(M, 60, "m"), k.append(N, q, M), f.append(x, k), i.appendChild(f);
    const P = document.createElement("div");
    P.className = "blora-datepicker__foot";
    const O = document.createElement("button");
    O.type = "button", O.className = "blora-button", O.setAttribute("data-variant", "ghost"), O.setAttribute("data-size", "sm"), O.setAttribute("data-now", ""), O.textContent = v("common.now");
    const R = document.createElement("button");
    R.type = "button", R.className = "blora-button", R.setAttribute("data-variant", "ghost"), R.setAttribute("data-size", "sm"), R.setAttribute("data-confirm", ""), R.textContent = v("common.confirm"), P.append(O, R), i.appendChild(P), requestAnimationFrame(() => {
      g(
        N,
        24,
        () => e,
        (U) => {
          e = U;
        }
      ), g(
        M,
        60,
        () => r,
        (U) => {
          r = U;
        }
      );
    });
  }, D = () => {
    m(), i.setAttribute("data-open", ""), n.style.zIndex = "var(--blora-z-dropdown)", S();
  }, w = () => {
    var f;
    for (i.removeAttribute("data-open"), n.style.zIndex = ""; d.length; ) (f = d.pop()) == null || f();
  }, _ = () => {
    l.value = o(), l.dispatchEvent(new Event("change", { bubbles: !0 }));
  }, E = (f) => {
    f.preventDefault(), f.stopPropagation(), i.hasAttribute("data-open") ? w() : (a = !0, D(), queueMicrotask(() => {
      a = !1;
    }));
  }, L = (f) => {
    if (!i.hasAttribute("data-open") || a) return;
    const x = f.target;
    x && !x.isConnected || x && n.contains(x) || w();
  }, T = (f) => {
    f.stopPropagation();
    const x = f.target;
    if (x.closest("[data-now]")) {
      const k = /* @__PURE__ */ new Date();
      e = k.getHours(), r = k.getMinutes(), _(), w();
      return;
    }
    x.closest("[data-confirm]") && (_(), w());
  };
  return t == null || t.addEventListener("click", E), i.addEventListener("click", T), document.addEventListener("click", L), {
    destroy() {
      var f;
      for (t == null || t.removeEventListener("click", E), i.removeEventListener("click", T), document.removeEventListener("click", L); d.length; ) (f = d.pop()) == null || f();
    }
  };
}
class Ir extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
  }
  static get observedAttributes() {
    return ["value", "placeholder", "name", "disabled", "required", "step"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  get value() {
    var t;
    return ((t = this.querySelector(".blora-input")) == null ? void 0 : t.value) ?? "";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  focus(t) {
    var e;
    (e = this.querySelector(".blora-input")) == null || e.focus(t);
  }
  render() {
    const t = document.createElement("div");
    t.className = "blora-timepicker", t.dataset.bloraTimepicker = "", t.dataset.bloraGenerated = "";
    const e = document.createElement("input");
    e.className = "blora-input", e.type = "time", e.value = this.getAttribute("value") ?? "", e.placeholder = this.getAttribute("placeholder") ?? "HH:MM", e.disabled = this.hasAttribute("disabled"), e.required = this.hasAttribute("required"), this.hasAttribute("name") && (e.name = this.getAttribute("name") ?? ""), this.hasAttribute("step") && (e.step = this.getAttribute("step") ?? "60");
    const r = document.createElement("button");
    r.className = "blora-timepicker__btn", r.type = "button", r.tabIndex = -1, r.disabled = e.disabled, r.setAttribute("aria-label", v("timepicker.pick")), r.appendChild(I("clock")), t.append(e, r), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-input");
    if (!t) return;
    document.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value), t.placeholder = this.getAttribute("placeholder") ?? "HH:MM", t.disabled = this.hasAttribute("disabled"), t.required = this.hasAttribute("required"), this.hasAttribute("name") && (t.name = this.getAttribute("name") ?? ""), this.hasAttribute("step") && (t.step = this.getAttribute("step") ?? "60");
    const e = this.querySelector(".blora-timepicker__btn");
    e && (e.disabled = t.disabled);
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-timepicker");
    (e = this.controller) == null || e.destroy(), this.controller = t ? Br(t) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function $a(n = customElements) {
  !n || n.get(Lt) || n.define(Lt, Ir);
}
const qt = "blora-transfer";
function Or(n) {
  const l = n.querySelectorAll(".blora-transfer__panel"), t = n.querySelectorAll(".blora-transfer__action, [data-transfer]");
  if (l.length < 2 || t.length === 0) return { destroy: () => {
  } };
  const e = l[0], r = l[1], a = e.querySelector(".blora-transfer__list"), i = r.querySelector(".blora-transfer__list"), s = () => {
    const u = e.querySelector(".blora-transfer__head"), b = r.querySelector(".blora-transfer__head");
    if (u) {
      const d = (a == null ? void 0 : a.querySelectorAll(".blora-transfer__row").length) ?? 0;
      u.textContent = v("transfer.sourceCount", { n: d });
    }
    if (b) {
      const d = (i == null ? void 0 : i.querySelectorAll(".blora-transfer__row").length) ?? 0;
      b.textContent = v("transfer.targetCount", { n: d });
    }
  }, o = (u) => {
    u === "right" || u === "to-right" ? Array.from(
      (a == null ? void 0 : a.querySelectorAll(".blora-transfer__row input:checked")) ?? []
    ).forEach((d) => {
      const m = d.closest(".blora-transfer__row");
      m && i && (d.checked = !1, i.appendChild(m));
    }) : Array.from(
      (i == null ? void 0 : i.querySelectorAll(".blora-transfer__row input:checked")) ?? []
    ).forEach((d) => {
      const m = d.closest(".blora-transfer__row");
      m && a && (d.checked = !1, a.appendChild(m));
    }), s();
  }, c = (u) => {
    const b = u.target.closest("[data-transfer]");
    b && (u.preventDefault(), o(b.dataset.transfer ?? "right"));
  };
  return n.addEventListener("click", c), {
    destroy() {
      n.removeEventListener("click", c);
    }
  };
}
class Pr extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
  }
  static get observedAttributes() {
    return ["source-label", "target-label", "disabled"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  get selectedValues() {
    var e;
    const t = this.querySelectorAll(".blora-transfer__panel");
    return Array.from(((e = t[1]) == null ? void 0 : e.querySelectorAll("input[data-value]")) ?? []).map(
      (r) => r.dataset.value ?? r.value
    );
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.querySelectorAll("blora-transfer-item")).map(
      (c) => {
        var u, b;
        return {
          checked: c.hasAttribute("checked"),
          disabled: c.hasAttribute("disabled"),
          label: c.getAttribute("label") ?? ((u = c.textContent) == null ? void 0 : u.trim()) ?? "",
          target: c.hasAttribute("target"),
          value: c.getAttribute("value") ?? ((b = c.textContent) == null ? void 0 : b.trim()) ?? ""
        };
      }
    ));
    const t = this.definitions.filter((c) => !c.target), e = this.definitions.filter((c) => c.target), r = document.createElement("div");
    r.className = "blora-transfer", r.dataset.bloraGenerated = "";
    const a = (c, u) => {
      const b = document.createElement("div");
      b.className = "blora-transfer__panel";
      const d = document.createElement("div");
      d.className = "blora-transfer__head", d.textContent = `${c} · ${u.length}`;
      const m = document.createElement("div");
      m.className = "blora-transfer__list";
      for (const p of u) {
        const h = document.createElement("label");
        h.className = "blora-transfer__row";
        const y = document.createElement("input");
        y.type = "checkbox", y.value = p.value, y.dataset.value = p.value, y.checked = p.checked, y.disabled = p.disabled || this.hasAttribute("disabled");
        const g = document.createElement("span");
        g.className = "blora-transfer__check";
        const C = document.createElement("span");
        C.textContent = p.label, h.append(y, g, C), m.appendChild(h);
      }
      return b.append(d, m), b;
    }, i = document.createElement("div");
    i.className = "blora-transfer__actions";
    const s = document.createElement("button");
    s.className = "blora-button", s.dataset.variant = "outline", s.dataset.size = "icon", s.dataset.transfer = "right", s.type = "button", s.disabled = this.hasAttribute("disabled"), s.setAttribute("aria-label", v("transfer.moveRight")), s.appendChild(I("chevron-right", 18, this.ownerDocument));
    const o = document.createElement("button");
    o.className = "blora-button", o.dataset.variant = "outline", o.dataset.size = "icon", o.dataset.transfer = "left", o.type = "button", o.disabled = this.hasAttribute("disabled"), o.setAttribute("aria-label", v("transfer.moveLeft")), o.appendChild(I("chevron-left", 18, this.ownerDocument)), i.append(s, o), r.append(
      a(this.getAttribute("source-label") ?? v("transfer.source"), t),
      i,
      a(this.getAttribute("target-label") ?? v("transfer.target"), e)
    ), this.replaceChildren(r);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-transfer");
    t && (this.controller = Or(t));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Fa(n = customElements) {
  !n || n.get(qt) || n.define(qt, Pr);
}
const Tt = "blora-statistic";
class Rr extends B {
  constructor() {
    super(...arguments);
    A(this, "initialValue", null);
  }
  static get observedAttributes() {
    return ["label", "value", "suffix", "trend", "direction"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  get value() {
    return this.getAttribute("value") ?? "";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  render() {
    var o;
    this.initialValue === null && (this.initialValue = ((o = this.textContent) == null ? void 0 : o.trim()) ?? "");
    const t = this.ownerDocument, e = t.createElement("div");
    e.className = "blora-stat", e.dataset.bloraGenerated = "";
    const r = this.getAttribute("label");
    if (r) {
      const c = t.createElement("div");
      c.className = "blora-stat__label", c.textContent = r, e.appendChild(c);
    }
    const a = t.createElement("div");
    a.className = "blora-stat__value", a.textContent = this.getAttribute("value") ?? this.initialValue;
    const i = this.getAttribute("suffix");
    if (i) {
      const c = t.createElement("span");
      c.className = "blora-stat__suffix", c.textContent = i, a.appendChild(c);
    }
    e.appendChild(a);
    const s = this.getAttribute("trend");
    if (s) {
      const c = t.createElement("div");
      c.className = "blora-stat__trend", c.textContent = s;
      const u = this.getAttribute("direction");
      (u === "up" || u === "down") && (c.dataset.direction = u), e.appendChild(c);
    }
    this.replaceChildren(e);
  }
  sync() {
    const t = this.querySelector(".blora-stat");
    if (!t) {
      this.render();
      return;
    }
    const e = this.getAttribute("label");
    let r = t.querySelector(".blora-stat__label");
    e ? (r || (r = this.ownerDocument.createElement("div"), r.className = "blora-stat__label", t.prepend(r)), r.textContent = e) : r == null || r.remove();
    const a = t.querySelector(".blora-stat__value");
    if (a) {
      const o = this.getAttribute("suffix");
      if (a.textContent = this.getAttribute("value") ?? this.initialValue ?? "", o) {
        const c = this.ownerDocument.createElement("span");
        c.className = "blora-stat__suffix", c.textContent = o, a.appendChild(c);
      }
    }
    const i = this.getAttribute("trend");
    let s = t.querySelector(".blora-stat__trend");
    if (i) {
      s || (s = this.ownerDocument.createElement("div"), s.className = "blora-stat__trend", t.appendChild(s)), s.textContent = i;
      const o = this.getAttribute("direction");
      o === "up" || o === "down" ? s.dataset.direction = o : delete s.dataset.direction;
    } else
      s == null || s.remove();
  }
  bindEvents() {
  }
}
function Ha(n = customElements) {
  !n || n.get(Tt) || n.define(Tt, Rr);
}
const Mt = "blora-steps";
function Gr(n) {
  if (typeof document > "u")
    return { setCurrent: () => {
    }, getCurrent: () => 0, destroy: () => {
    } };
  n.classList.add("blora-steps");
  const l = () => Array.from(n.querySelectorAll(".blora-step, [data-blora-step]")), t = () => {
    const i = l().findIndex(
      (s) => s.hasAttribute("data-current") || s.getAttribute("data-state") === "active" || s.getAttribute("data-status") === "process"
    );
    return i >= 0 ? i : 0;
  }, e = (a) => {
    l().forEach((s, o) => {
      s.removeAttribute("data-current"), s.removeAttribute("data-status"), o < a ? s.setAttribute("data-state", "done") : o === a ? (s.setAttribute("data-state", "active"), s.setAttribute("data-current", "")) : s.setAttribute("data-state", "pending"), o === a ? s.setAttribute("aria-current", "step") : s.removeAttribute("aria-current");
    }), n.dispatchEvent(new CustomEvent("blora-steps-change", { bubbles: !0, detail: { index: a } }));
  }, r = (a) => {
    if (n.getAttribute("data-clickable") === "false") return;
    const i = a.target.closest(".blora-step, [data-blora-step]");
    if (!i || !n.contains(i)) return;
    const o = l().indexOf(i);
    o >= 0 && e(o);
  };
  return n.addEventListener("click", r), e(t()), {
    setCurrent: e,
    getCurrent: t,
    destroy() {
      n.removeEventListener("click", r);
    }
  };
}
class $r extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
  }
  static get observedAttributes() {
    return ["current", "clickable"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  get current() {
    var t;
    return ((t = this.controller) == null ? void 0 : t.getCurrent()) ?? Number(this.getAttribute("current") ?? 0);
  }
  set current(t) {
    this.setAttribute("current", String(t));
  }
  setCurrent(t) {
    this.current = t;
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((i) => i.localName === "blora-step").map((i) => {
      var c;
      const s = i.getAttribute("state"), o = s === "pending" || s === "active" || s === "done" ? s : null;
      return {
        description: i.getAttribute("description") ?? "",
        icon: i.getAttribute("icon") ?? "",
        state: o,
        title: i.getAttribute("title") ?? ((c = i.textContent) == null ? void 0 : c.trim()) ?? ""
      };
    }));
    const t = this.getAttribute("current"), e = this.definitions.findIndex((i) => i.state === "active"), r = t === null ? Math.max(0, e) : Number(t), a = this.ownerDocument.createElement("div");
    a.className = "blora-steps", a.dataset.bloraGenerated = "", a.dataset.clickable = String(this.getAttribute("clickable") !== "false"), this.definitions.forEach((i, s) => {
      const o = this.ownerDocument.createElement("div");
      o.className = "blora-step";
      const c = this.ownerDocument.createElement("div");
      c.className = "blora-step__head";
      const u = this.ownerDocument.createElement("span");
      u.className = "blora-step__icon", s < r && !i.icon ? u.appendChild(I("check", 16, this.ownerDocument)) : u.textContent = i.icon || String(s + 1);
      const b = this.ownerDocument.createElement("div");
      b.className = "blora-step__line", b.setAttribute("aria-hidden", "true"), c.append(u, b);
      const d = this.ownerDocument.createElement("div");
      if (d.className = "blora-step__title", d.textContent = i.title, o.append(c, d), i.description) {
        const m = this.ownerDocument.createElement("div");
        m.className = "blora-step__desc", m.textContent = i.description, o.appendChild(m);
      }
      s < r ? o.dataset.state = "done" : s === r ? o.dataset.state = "active" : o.dataset.state = "pending", a.appendChild(o);
    }), this.replaceChildren(a);
  }
  sync() {
    var r;
    const t = Number(this.getAttribute("current") ?? 0);
    (r = this.controller) == null || r.setCurrent(t);
    const e = this.querySelector(".blora-steps");
    e && (e.dataset.clickable = String(this.getAttribute("clickable") !== "false"));
  }
  bindEvents() {
    const t = this.querySelector(".blora-steps");
    t && (this.controller = Gr(t), this.listen(t, "blora-steps-change", (e) => {
      const r = e.detail.index;
      this.getAttribute("current") !== String(r) && this.setAttribute("current", String(r));
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Va(n = customElements) {
  !n || n.get(Mt) || n.define(Mt, $r);
}
const Bt = "blora-radio";
class Fr extends B {
  constructor() {
    super(...arguments);
    A(this, "initialLabel", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["name", "value", "checked", "disabled", "required", "label"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get checked() {
    var t;
    return ((t = this.querySelector('input[type="radio"]')) == null ? void 0 : t.checked) ?? !1;
  }
  set checked(t) {
    this.toggleAttribute("checked", t);
  }
  get value() {
    return this.getAttribute("value") ?? "on";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  focus(t) {
    var e;
    (e = this.querySelector('input[type="radio"]')) == null || e.focus(t);
  }
  render() {
    var i;
    this.initialLabel === null && (this.initialLabel = ((i = this.textContent) == null ? void 0 : i.trim()) ?? "");
    const t = this.ownerDocument, e = t.createElement("label");
    e.className = "blora-radio", e.dataset.bloraGenerated = "";
    const r = t.createElement("input");
    r.type = "radio", r.name = this.getAttribute("name") ?? "", r.value = this.value, r.checked = this.hasAttribute("checked"), r.disabled = this.hasAttribute("disabled"), r.required = this.hasAttribute("required");
    const a = t.createElement("span");
    a.className = "blora-radio__dot", a.setAttribute("aria-hidden", "true"), e.append(r, a, t.createTextNode(this.getAttribute("label") ?? this.initialLabel)), this.replaceChildren(e);
  }
  sync() {
    const t = this.querySelector('input[type="radio"]');
    if (!t) return;
    t.name = this.getAttribute("name") ?? "", t.value = this.value, t.checked = this.hasAttribute("checked"), t.disabled = this.hasAttribute("disabled"), t.required = this.hasAttribute("required");
    const e = this.querySelector(".blora-radio");
    if (e) {
      const r = e.lastChild;
      (r == null ? void 0 : r.nodeType) === Node.TEXT_NODE && (r.textContent = this.getAttribute("label") ?? this.initialLabel ?? "");
    }
  }
  bindEvents() {
    const t = this.querySelector('input[type="radio"]');
    t && this.listen(t, "change", () => {
      if (t.checked && t.name)
        for (const e of this.ownerDocument.querySelectorAll(
          'blora-radio input[type="radio"]'
        )) {
          if (e === t || e.name !== t.name || e.form !== t.form) continue;
          const r = e.closest("blora-radio");
          r != null && r.hasAttribute("checked") && r.removeAttribute("checked");
        }
      this.reflecting = !0, this.toggleAttribute("checked", t.checked), this.reflecting = !1;
    });
  }
}
function za(n = customElements) {
  !n || n.get(Bt) || n.define(Bt, Fr);
}
const It = "blora-switch";
class He extends B {
  constructor() {
    super(...arguments);
    A(this, "internals", null);
    A(this, "initialLabel", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["name", "value", "checked", "disabled", "required", "label", "size"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get checked() {
    var t;
    return ((t = this.querySelector('input[type="checkbox"]')) == null ? void 0 : t.checked) ?? !1;
  }
  set checked(t) {
    this.toggleAttribute("checked", t);
  }
  get value() {
    return this.getAttribute("value") ?? "on";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  focus(t) {
    var e;
    (e = this.querySelector('input[type="checkbox"]')) == null || e.focus(t);
  }
  syncFormValue() {
    Y(this.internals, this.checked ? this.value : null);
  }
  render() {
    var s;
    this.internals ?? (this.internals = X(this)), this.initialLabel === null && (this.initialLabel = ((s = this.textContent) == null ? void 0 : s.trim()) ?? "");
    const t = this.ownerDocument, e = t.createElement("label");
    e.className = "blora-switch", e.dataset.bloraGenerated = "";
    const r = this.getAttribute("size");
    (r === "sm" || r === "lg") && (e.dataset.size = r);
    const a = t.createElement("input");
    a.type = "checkbox", a.name = this.internals ? "" : this.getAttribute("name") ?? "", a.value = this.value, a.checked = this.hasAttribute("checked"), a.disabled = this.hasAttribute("disabled"), a.required = this.hasAttribute("required");
    const i = t.createElement("span");
    i.className = "blora-switch__track", i.setAttribute("aria-hidden", "true"), e.append(a, i, t.createTextNode(this.getAttribute("label") ?? this.initialLabel)), this.replaceChildren(e), this.syncFormValue();
  }
  sync() {
    const t = this.querySelector('input[type="checkbox"]'), e = this.querySelector(".blora-switch");
    if (!t || !e) return;
    const r = this.getAttribute("size");
    r === "sm" || r === "lg" ? e.dataset.size = r : delete e.dataset.size, t.name = this.internals ? "" : this.getAttribute("name") ?? "", t.value = this.value, t.checked = this.hasAttribute("checked"), t.disabled = this.hasAttribute("disabled"), t.required = this.hasAttribute("required");
    const a = e.lastChild;
    (a == null ? void 0 : a.nodeType) === Node.TEXT_NODE && (a.textContent = this.getAttribute("label") ?? this.initialLabel ?? ""), this.syncFormValue();
  }
  bindEvents() {
    const t = this.querySelector('input[type="checkbox"]');
    t && this.listen(t, "change", () => {
      this.reflecting = !0, this.toggleAttribute("checked", t.checked), this.reflecting = !1, this.syncFormValue();
    });
  }
}
A(He, "formAssociated", !0);
function Ya(n = customElements) {
  !n || n.get(It) || n.define(It, He);
}
const Ot = "blora-slider";
function Hr(n) {
  const l = n.querySelector(".blora-slider__input, input[type='range']"), t = n.querySelector(".blora-slider__value");
  if (!l) return { destroy: () => {
  } };
  const e = n.hasAttribute("data-tooltip") || n.dataset.tooltip === "true";
  let r = null;
  e && (r = n.querySelector(".blora-slider__tip"), r || (r = document.createElement("span"), r.className = "blora-slider__tip", r.setAttribute("aria-hidden", "true"), n.appendChild(r)));
  const a = () => {
    const o = Number(l.value), c = Number(l.min) || 0, u = Number(l.max) || 100, b = (o - c) / (u - c) * 100;
    n.style.setProperty("--blora-slider-fill", `${b}%`), t && (t.textContent = String(o)), r && (r.textContent = String(o), r.style.left = `${b}%`);
  }, i = () => {
    r && r.setAttribute("data-show", "");
  }, s = () => {
    r && r.removeAttribute("data-show");
  };
  return l.addEventListener("input", a), e && (l.addEventListener("pointerdown", i), l.addEventListener("pointerup", s), l.addEventListener("focus", i), l.addEventListener("blur", s)), a(), {
    destroy() {
      l.removeEventListener("input", a), e && (l.removeEventListener("pointerdown", i), l.removeEventListener("pointerup", s), l.removeEventListener("focus", i), l.removeEventListener("blur", s));
    }
  };
}
class Ve extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "reflecting", !1);
    A(this, "internals", null);
  }
  /** Submitted under `name` via ElementInternals; inner input stays unnamed. */
  syncFormValue() {
    var e;
    const t = ((e = this.querySelector('input[type="range"]')) == null ? void 0 : e.value) ?? "";
    Y(this.internals, t === "" ? null : t);
  }
  static get observedAttributes() {
    return ["min", "max", "step", "value", "name", "disabled", "tooltip", "hide-value"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get value() {
    var t;
    return Number(((t = this.querySelector('input[type="range"]')) == null ? void 0 : t.value) ?? 0);
  }
  set value(t) {
    this.setAttribute("value", String(t));
  }
  focus(t) {
    var e;
    (e = this.querySelector('input[type="range"]')) == null || e.focus(t);
  }
  render() {
    this.internals ?? (this.internals = X(this));
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-slider", t.dataset.bloraGenerated = "", this.hasAttribute("tooltip") && (t.dataset.tooltip = "true");
    const e = this.ownerDocument.createElement("input");
    if (e.className = "blora-slider__input", e.type = "range", e.min = this.getAttribute("min") ?? "0", e.max = this.getAttribute("max") ?? "100", e.step = this.getAttribute("step") ?? "1", e.value = this.getAttribute("value") ?? e.min, e.name = this.internals ? "" : this.getAttribute("name") ?? "", e.disabled = this.hasAttribute("disabled"), t.appendChild(e), !this.hasAttribute("hide-value")) {
      const r = this.ownerDocument.createElement("output");
      r.className = "blora-slider__value", r.textContent = e.value, t.appendChild(r);
    }
    this.replaceChildren(t), this.syncFormValue();
  }
  sync() {
    const t = this.querySelector(".blora-slider"), e = t == null ? void 0 : t.querySelector('input[type="range"]');
    if (!t || !e) return;
    const r = this.hasAttribute("hide-value"), a = t.querySelector("output");
    if (r !== !a) {
      this.render(), this.rebind();
      return;
    }
    this.hasAttribute("tooltip") ? t.dataset.tooltip = "true" : delete t.dataset.tooltip, e.min = this.getAttribute("min") ?? "0", e.max = this.getAttribute("max") ?? "100", e.step = this.getAttribute("step") ?? "1", document.activeElement !== e && (e.value = this.getAttribute("value") ?? e.value), e.name = this.internals ? "" : this.getAttribute("name") ?? "", e.disabled = this.hasAttribute("disabled"), a && (a.textContent = e.value), this.syncFormValue();
  }
  bindEvents() {
    var r;
    const t = this.querySelector(".blora-slider"), e = t == null ? void 0 : t.querySelector('input[type="range"]');
    !t || !e || ((r = this.controller) == null || r.destroy(), this.controller = Hr(t), this.listen(e, "input", () => {
      this.reflecting = !0, this.setAttribute("value", e.value), this.reflecting = !1, this.syncFormValue();
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
A(Ve, "formAssociated", !0);
function Wa(n = customElements) {
  !n || n.get(Ot) || n.define(Ot, Ve);
}
const Pt = "blora-rate";
function Vr(n) {
  const l = Array.from(n.querySelectorAll(".blora-rate__star"));
  if (l.length === 0) return { destroy: () => {
  } };
  const t = n.hasAttribute("data-readonly");
  let e = Number(n.dataset.value ?? 0);
  const r = (c) => {
    const u = c ?? e;
    l.forEach((b, d) => {
      d < u ? b.setAttribute("data-active", "") : b.removeAttribute("data-active");
    });
  };
  if (t)
    return r(null), { destroy: () => {
    } };
  const a = (c) => {
    const u = c.target;
    if (!(u instanceof Element)) return null;
    const b = u.closest(".blora-rate__star");
    return b && l.includes(b) ? b : null;
  }, i = (c) => {
    const u = a(c);
    u && r(l.indexOf(u) + 1);
  }, s = () => r(null), o = (c) => {
    const u = a(c);
    u && (e = l.indexOf(u) + 1, n.dataset.value = String(e), r(null));
  };
  return n.addEventListener("mouseover", i), n.addEventListener("mouseleave", s), n.addEventListener("click", o), r(null), {
    destroy() {
      n.removeEventListener("mouseover", i), n.removeEventListener("mouseleave", s), n.removeEventListener("click", o);
    }
  };
}
class zr extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["value", "max", "readonly", "label"];
  }
  attributeChangedCallback(t) {
    if (!(!this.isConnectedInternal || this.reflecting)) {
      if (t === "max") {
        this.render(), this.rebind();
        return;
      }
      this.sync();
    }
  }
  get value() {
    var t;
    return Number(((t = this.querySelector(".blora-rate")) == null ? void 0 : t.dataset.value) ?? 0);
  }
  set value(t) {
    this.setAttribute("value", String(t));
  }
  render() {
    const t = Math.max(1, Number(this.getAttribute("max") ?? 5)), e = Math.min(t, Math.max(0, Number(this.getAttribute("value") ?? 0))), r = this.ownerDocument.createElement("div");
    r.className = "blora-rate", r.dataset.bloraGenerated = "", r.dataset.value = String(e), r.setAttribute("role", "radiogroup"), r.setAttribute("aria-label", this.getAttribute("label") ?? v("rate.label")), this.hasAttribute("readonly") && (r.dataset.readonly = "");
    for (let a = 1; a <= t; a += 1) {
      const i = this.ownerDocument.createElement("span");
      i.className = "blora-rate__star", i.appendChild(I("star", 20, this.ownerDocument)), i.dataset.value = String(a), i.setAttribute("role", "radio"), i.setAttribute("aria-checked", String(a === e)), i.setAttribute("aria-label", v("rate.of", { n: a, max: t })), i.tabIndex = this.hasAttribute("readonly") ? -1 : a === Math.max(1, e) ? 0 : -1, a <= e && (i.dataset.active = ""), r.appendChild(i);
    }
    this.replaceChildren(r);
  }
  sync() {
    const t = this.querySelector(".blora-rate");
    if (!t) return;
    const e = Math.max(1, Number(this.getAttribute("max") ?? 5)), r = Math.min(e, Math.max(0, Number(this.getAttribute("value") ?? 0)));
    t.dataset.value = String(r), t.setAttribute("aria-label", this.getAttribute("label") ?? v("rate.label")), t.toggleAttribute("data-readonly", this.hasAttribute("readonly")), t.querySelectorAll(".blora-rate__star").forEach((a, i) => {
      const s = i + 1;
      a.setAttribute("aria-checked", String(s === r)), a.tabIndex = this.hasAttribute("readonly") ? -1 : s === Math.max(1, r) ? 0 : -1, a.toggleAttribute("data-active", s <= r);
    });
  }
  bindEvents() {
    var r;
    const t = this.querySelector(".blora-rate");
    if (!t) return;
    (r = this.controller) == null || r.destroy(), this.controller = Vr(t);
    const e = (a) => {
      if (this.hasAttribute("readonly")) return;
      a.click();
      const i = t.dataset.value ?? "0";
      this.reflecting = !0, this.setAttribute("value", i), this.reflecting = !1, t.querySelectorAll(".blora-rate__star").forEach((s) => {
        const o = s === a;
        s.setAttribute("aria-checked", String(o)), s.tabIndex = o ? 0 : -1;
      }), this.emit("blora-change", { value: Number(i) });
    };
    this.listen(t, "click", (a) => {
      const i = a.target.closest(".blora-rate__star");
      if (!i || !t.contains(i)) return;
      const s = t.dataset.value ?? "0";
      this.reflecting = !0, this.setAttribute("value", s), this.reflecting = !1, t.querySelectorAll(".blora-rate__star").forEach((o) => {
        const c = o === i;
        o.setAttribute("aria-checked", String(c)), o.tabIndex = c ? 0 : -1;
      }), this.emit("blora-change", { value: Number(s) });
    }), this.listen(t, "keydown", (a) => {
      const i = a, s = i.target.closest(".blora-rate__star");
      !s || i.key !== "Enter" && i.key !== " " || (i.preventDefault(), e(s));
    });
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Ua(n = customElements) {
  !n || n.get(Pt) || n.define(Pt, zr);
}
const Rt = "blora-otp";
function Yr(n) {
  const l = Array.from(n.querySelectorAll(".blora-otp__input"));
  if (l.length === 0) return { destroy: () => {
  } };
  const t = n.dataset.mode ?? "any", e = n.hasAttribute("data-uppercase"), r = (o) => (e && (o = o.toUpperCase()), t === "numeric" ? /[0-9]/.test(o) ? o : "" : t === "alphanumeric" ? /[a-zA-Z0-9]/.test(o) ? o : "" : o), a = (o) => {
    const c = o.target, u = r(c.value);
    if (c.value = u.slice(-1), c.value) {
      const b = l.indexOf(c);
      b < l.length - 1 && l[b + 1].focus();
    }
  }, i = (o) => {
    const c = o.target, u = l.indexOf(c);
    o.key === "Backspace" && !c.value && u > 0 ? (o.preventDefault(), l[u - 1].focus(), l[u - 1].value = "") : o.key === "ArrowLeft" && u > 0 ? (o.preventDefault(), l[u - 1].focus()) : o.key === "ArrowRight" && u < l.length - 1 && (o.preventDefault(), l[u + 1].focus());
  }, s = (o) => {
    var m;
    o.preventDefault();
    const u = (((m = o.clipboardData) == null ? void 0 : m.getData("text")) ?? "").split("").map(r).filter(Boolean), b = l.indexOf(o.target);
    u.forEach((p, h) => {
      b + h < l.length && (l[b + h].value = p);
    });
    const d = Math.min(b + u.length, l.length - 1);
    l[d].focus();
  };
  return l.forEach((o) => {
    o.addEventListener("input", a), o.addEventListener("keydown", i), o.addEventListener("paste", s);
  }), {
    destroy() {
      l.forEach((o) => {
        o.removeEventListener("input", a), o.removeEventListener("keydown", i), o.removeEventListener("paste", s);
      });
    }
  };
}
class ze extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "reflecting", !1);
    A(this, "internals", null);
  }
  /** Submitted as the joined digits via ElementInternals; empty code submits nothing. */
  syncFormValue() {
    const t = this.value;
    Y(this.internals, t === "" ? null : t);
  }
  static get observedAttributes() {
    return ["length", "mode", "uppercase", "value", "disabled", "label"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get value() {
    return Array.from(this.querySelectorAll(".blora-otp__input")).map((t) => t.value).join("");
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  focus(t) {
    var e;
    (e = this.querySelector(".blora-otp__input")) == null || e.focus(t);
  }
  render() {
    this.internals ?? (this.internals = X(this));
    const t = Math.max(1, Number(this.getAttribute("length") ?? 6)), e = Array.from(this.getAttribute("value") ?? ""), r = this.ownerDocument.createElement("div");
    r.className = "blora-otp", r.dataset.bloraGenerated = "", r.dataset.mode = this.getAttribute("mode") ?? "numeric", r.setAttribute("role", "group"), r.setAttribute("aria-label", this.getAttribute("label") ?? v("otp.label")), this.hasAttribute("uppercase") && (r.dataset.uppercase = "");
    for (let a = 0; a < t; a += 1) {
      const i = this.ownerDocument.createElement("input");
      i.className = "blora-otp__input", i.type = "text", i.maxLength = 1, i.inputMode = r.dataset.mode === "numeric" ? "numeric" : "text", i.autocomplete = a === 0 ? "one-time-code" : "off", i.disabled = this.hasAttribute("disabled"), i.value = e[a] ?? "", i.setAttribute("aria-label", v("otp.char", { n: a + 1, total: t })), r.appendChild(i);
    }
    this.replaceChildren(r), this.syncFormValue();
  }
  sync() {
    const t = this.querySelector(".blora-otp"), e = [...this.querySelectorAll(".blora-otp__input")], r = Math.max(1, Number(this.getAttribute("length") ?? 6));
    if (!t || e.length !== r) {
      this.render(), this.rebind();
      return;
    }
    t.dataset.mode = this.getAttribute("mode") ?? "numeric", t.toggleAttribute("data-uppercase", this.hasAttribute("uppercase")), t.setAttribute("aria-label", this.getAttribute("label") ?? v("otp.label"));
    const a = Array.from(this.getAttribute("value") ?? "");
    e.forEach((i, s) => {
      i.disabled = this.hasAttribute("disabled"), this.ownerDocument.activeElement !== i && (i.value = a[s] ?? "");
    }), this.syncFormValue();
  }
  bindEvents() {
    const t = this.querySelector(".blora-otp");
    t && (this.controller = Yr(t), this.listen(t, "input", () => {
      this.reflecting = !0, this.setAttribute("value", this.value), this.reflecting = !1, this.emit("blora-change", {
        value: this.value,
        complete: this.value.length === t.children.length
      }), this.syncFormValue();
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
A(ze, "formAssociated", !0);
function Ka(n = customElements) {
  !n || n.get(Rt) || n.define(Rt, ze);
}
const Gt = "blora-tags-input";
function Wr(n) {
  const l = n.ownerDocument, t = n.querySelector("input");
  if (!t) return { destroy: () => {
  } };
  const e = (i) => {
    const s = i.trim();
    if (!s) return;
    const o = l.createElement("span");
    o.className = "blora-tag", o.setAttribute("data-variant", "primary"), o.appendChild(l.createTextNode(s));
    const c = l.createElement("button");
    c.type = "button", c.className = "blora-tag__close", c.setAttribute("aria-label", v("tags.removeNamed", { label: s })), o.appendChild(c), n.insertBefore(o, t), t.value = "";
  }, r = (i) => {
    var o;
    const s = i.target.closest(".blora-tag__close");
    s && n.contains(s) && ((o = s.closest(".blora-tag")) == null || o.remove());
  }, a = (i) => {
    if (i.key === "Enter" || i.key === ",")
      i.preventDefault(), e(t.value);
    else if (i.key === "Backspace" && !t.value) {
      const s = t.previousElementSibling;
      s != null && s.classList.contains("blora-tag") && s.remove();
    }
  };
  return t.addEventListener("keydown", a), n.addEventListener("click", r), {
    destroy() {
      t.removeEventListener("keydown", a), n.removeEventListener("click", r);
    }
  };
}
class Ye extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "reflecting", !1);
    A(this, "internals", null);
  }
  /** Submitted as one comma-joined entry matching the `values` attribute format. */
  syncFormValue() {
    const t = this.values.join(",");
    Y(this.internals, t === "" ? null : t);
  }
  static get observedAttributes() {
    return ["values", "placeholder", "disabled", "label"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get values() {
    return Array.from(
      this.querySelectorAll(".blora-tag"),
      (t) => {
        var e;
        return (((e = t.firstChild) == null ? void 0 : e.textContent) ?? "").trim();
      }
    ).filter(Boolean);
  }
  set values(t) {
    this.setAttribute("values", t.join(","));
  }
  focus(t) {
    var e;
    (e = this.querySelector("input")) == null || e.focus(t);
  }
  render() {
    this.internals ?? (this.internals = X(this));
    const t = (this.getAttribute("values") ?? "").split(",").map((a) => a.trim()).filter(Boolean), e = this.ownerDocument.createElement("div");
    e.className = "blora-tags-input", e.dataset.bloraGenerated = "", e.setAttribute("role", "group"), e.setAttribute("aria-label", this.getAttribute("label") ?? v("tags.label"));
    for (const a of t) {
      const i = this.ownerDocument.createElement("span");
      i.className = "blora-tag", i.dataset.variant = "primary", i.appendChild(this.ownerDocument.createTextNode(a));
      const s = this.ownerDocument.createElement("button");
      s.type = "button", s.className = "blora-tag__close", s.setAttribute("aria-label", v("tags.removeNamed", { label: a })), s.disabled = this.hasAttribute("disabled"), i.appendChild(s), e.appendChild(i);
    }
    const r = this.ownerDocument.createElement("input");
    r.type = "text", r.placeholder = this.getAttribute("placeholder") ?? "", r.disabled = this.hasAttribute("disabled"), e.appendChild(r), this.replaceChildren(e), this.syncFormValue();
  }
  sync() {
    const t = this.querySelector(".blora-tags-input");
    t && t.setAttribute("aria-label", this.getAttribute("label") ?? v("tags.label"));
    const e = this.querySelector("input, textarea");
    e && (e.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (e.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== e && (e.value = this.getAttribute("value") ?? e.value)), this.rebind(), this.syncFormValue();
  }
  bindEvents() {
    const t = this.querySelector(".blora-tags-input");
    if (!t) return;
    this.controller = Wr(t);
    const e = () => {
      const r = this.values;
      this.reflecting = !0, this.setAttribute("values", r.join(",")), this.reflecting = !1, this.emit("blora-change", { values: r }), this.syncFormValue();
    };
    this.listen(t, "keydown", (r) => {
      const a = r;
      (a.key === "Enter" || a.key === "," || a.key === "Backspace") && queueMicrotask(e);
    }), this.listen(t, "click", (r) => {
      r.target.closest(".blora-tag__close") && queueMicrotask(e);
    });
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
A(Ye, "formAssociated", !0);
function Xa(n = customElements) {
  !n || n.get(Gt) || n.define(Gt, Ye);
}
const $t = "blora-checkbox";
function Ur(n) {
  const l = n.querySelector(
    "[data-blora-checkall], .blora-checkbox__input[data-blora-checkall]"
  );
  if (!l) return { destroy: () => {
  } };
  const t = () => Array.from(
    n.querySelectorAll('input[type="checkbox"]:not([data-blora-checkall])')
  ), e = () => {
    const i = t(), s = i.filter((o) => o.checked).length;
    l.checked = i.length > 0 && s === i.length, l.indeterminate = s > 0 && s < i.length;
  }, r = () => {
    t().forEach((i) => {
      i.disabled || (i.checked = l.checked);
    }), l.indeterminate = !1;
  }, a = (i) => {
    i.target !== l && e();
  };
  return l.addEventListener("change", r), n.addEventListener("change", a), e(), {
    destroy() {
      l.removeEventListener("change", r), n.removeEventListener("change", a);
    }
  };
}
class We extends B {
  constructor() {
    super(...arguments);
    A(this, "internals", null);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "initialLabel", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["name", "value", "checked", "disabled", "required", "label"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get checked() {
    var t;
    return ((t = this.querySelector('input[type="checkbox"]')) == null ? void 0 : t.checked) ?? !1;
  }
  set checked(t) {
    this.toggleAttribute("checked", t);
  }
  get values() {
    return Array.from(
      this.querySelectorAll(
        'input[type="checkbox"]:checked:not([data-blora-checkall])'
      ),
      (t) => t.value
    );
  }
  focus(t) {
    var e;
    (e = this.querySelector('input[type="checkbox"]')) == null || e.focus(t);
  }
  syncFormValue() {
    if (this.definitions) {
      Y(this.internals, null);
      return;
    }
    Y(this.internals, this.checked ? this.getAttribute("value") ?? "on" : null);
  }
  render() {
    var t;
    if (this.internals ?? (this.internals = X(this)), this.initialLabel === null && (this.initialLabel = ((t = this.textContent) == null ? void 0 : t.trim()) ?? ""), !this.definitions) {
      const e = Array.from(this.children).filter(
        (r) => r.localName === "blora-checkbox-option"
      );
      e.length && (this.definitions = e.map((r) => {
        var a, i;
        return {
          checked: r.hasAttribute("checked"),
          checkAll: r.hasAttribute("check-all"),
          disabled: r.hasAttribute("disabled"),
          label: r.getAttribute("label") ?? ((a = r.textContent) == null ? void 0 : a.trim()) ?? "",
          value: r.getAttribute("value") ?? ((i = r.textContent) == null ? void 0 : i.trim()) ?? "on"
        };
      }));
    }
    if (this.definitions) {
      const e = this.ownerDocument.createElement("div");
      e.className = "blora-stack", e.dataset.bloraGenerated = "", e.setAttribute("role", "group"), this.getAttribute("label") && e.setAttribute("aria-label", this.getAttribute("label")), this.definitions.forEach(
        (r) => e.appendChild(this.createCheckbox(r, this.getAttribute("name") ?? ""))
      ), this.replaceChildren(e), this.dataset.group = "";
      return;
    }
    this.removeAttribute("data-group"), this.replaceChildren(
      this.createCheckbox(
        {
          checked: this.hasAttribute("checked"),
          checkAll: !1,
          disabled: this.hasAttribute("disabled"),
          label: this.getAttribute("label") ?? this.initialLabel,
          value: this.getAttribute("value") ?? "on"
        },
        this.internals ? "" : this.getAttribute("name") ?? ""
      )
    ), this.syncFormValue();
  }
  sync() {
    this.captureLiveState();
    const t = Array.from(this.querySelectorAll('input[type="checkbox"]'));
    if (!t.length) return;
    const e = this.getAttribute("name") ?? "", r = this.hasAttribute("required");
    if (this.definitions) {
      t.forEach((o, c) => {
        const u = this.definitions[c];
        u && (o.name = e, o.required = r, o.disabled = u.disabled);
      });
      const s = this.querySelector("[role='group']");
      s && (this.getAttribute("label") ? s.setAttribute("aria-label", this.getAttribute("label")) : s.removeAttribute("aria-label"));
      return;
    }
    const a = t[0];
    a.name = this.internals ? "" : e, a.value = this.getAttribute("value") ?? "on", a.checked = this.hasAttribute("checked"), a.disabled = this.hasAttribute("disabled"), a.required = r;
    const i = this.querySelector(".blora-checkbox");
    if (i) {
      const s = this.getAttribute("label") ?? this.initialLabel ?? "", o = i.lastChild;
      (o == null ? void 0 : o.nodeType) === Node.TEXT_NODE && (o.textContent = s);
    }
    this.syncFormValue();
  }
  bindEvents() {
    var r;
    const t = this.querySelector("[data-blora-generated]");
    if (!t) return;
    (r = this.controller) == null || r.destroy(), this.controller = Ur(t);
    const e = (a) => {
      this.definitions || (this.reflecting = !0, this.toggleAttribute("checked", a.checked), this.reflecting = !1), this.syncIndeterminate(t), this.syncFormValue();
    };
    this.listen(t, "change", (a) => e(a.target)), this.syncIndeterminate(t);
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
  createCheckbox(t, e) {
    const r = this.ownerDocument.createElement("label");
    r.className = "blora-checkbox", r.dataset.bloraGenerated = "";
    const a = this.ownerDocument.createElement("input");
    a.type = "checkbox", a.name = e, a.value = t.value, a.checked = t.checked, a.disabled = t.disabled, a.required = this.hasAttribute("required"), t.checkAll && (a.dataset.bloraCheckall = "");
    const i = this.ownerDocument.createElement("span");
    return i.className = "blora-checkbox__box", i.setAttribute("aria-hidden", "true"), r.append(a, i, this.ownerDocument.createTextNode(t.label)), r;
  }
  captureLiveState() {
    if (!this.definitions) return;
    const t = Array.from(this.querySelectorAll('input[type="checkbox"]'));
    this.definitions = this.definitions.map((e, r) => {
      var a;
      return {
        ...e,
        checked: ((a = t[r]) == null ? void 0 : a.checked) ?? e.checked
      };
    });
  }
  syncIndeterminate(t) {
    t.querySelectorAll("input[data-blora-checkall]").forEach((e) => {
      var r;
      (r = e.closest(".blora-checkbox")) == null || r.toggleAttribute("data-indeterminate", e.indeterminate);
    });
  }
}
A(We, "formAssociated", !0);
function ja(n = customElements) {
  !n || n.get($t) || n.define($t, We);
}
const Ft = "blora-field", Ht = [
  "autocomplete",
  "inputmode",
  "aria-label",
  "autocapitalize",
  "spellcheck",
  "enterkeyhint"
];
let Kr = 0;
function Xr(n) {
  const l = n.querySelectorAll(
    "[data-limit], [data-blora-limit]"
  ), t = [], e = (r, a) => {
    const i = Array.from(r || "");
    return {
      count: i.length,
      normal: i.slice(0, a).join(""),
      overflow: i.slice(a).join("")
    };
  };
  return l.forEach((r) => {
    var m;
    const a = Number(r.dataset.limit ?? r.dataset.bloraLimit ?? 0);
    if (!Number.isFinite(a) || a < 1) return;
    r.removeAttribute("maxlength");
    let i = r.closest(".blora-limit");
    i || (i = document.createElement("div"), i.className = "blora-limit", (m = r.parentNode) == null || m.insertBefore(i, r), i.appendChild(r)), i.classList.toggle("blora-limit--textarea", r.tagName === "TEXTAREA");
    let s = i.querySelector(".blora-limit__mirror"), o, c, u;
    if (s)
      o = s.querySelector(
        ".blora-limit__mirror-inner > span:not(.blora-limit__overflow)"
      ), c = s.querySelector(".blora-limit__overflow"), u = i.querySelector(".blora-limit__count");
    else {
      s = document.createElement("div"), s.className = "blora-limit__mirror", s.setAttribute("aria-hidden", "true");
      const p = document.createElement("span");
      p.className = "blora-limit__mirror-inner", o = document.createElement("span"), c = document.createElement("span"), c.className = "blora-limit__overflow", p.append(o, c), s.appendChild(p), u = document.createElement("span"), u.className = "blora-limit__count", u.setAttribute("aria-live", "polite"), i.append(s, u);
    }
    const b = () => {
      const p = s.querySelector(".blora-limit__mirror-inner");
      p && (p.style.transform = `translateX(${-r.scrollLeft}px)`), s.scrollTop = r.scrollTop;
    }, d = () => {
      const p = e(r.value, a), h = p.count > a;
      o.textContent = p.normal || "", c.textContent = p.overflow || "", u.textContent = `${p.count}/${a}`, h ? i.setAttribute("data-over-limit", "") : i.removeAttribute("data-over-limit"), h ? r.setAttribute("aria-invalid", "true") : r.removeAttribute("aria-invalid"), b();
    };
    r.addEventListener("input", d), r.addEventListener("scroll", b), d(), t.push(() => {
      r.removeEventListener("input", d), r.removeEventListener("scroll", b);
    });
  }), {
    destroy() {
      t.forEach((r) => r());
    }
  };
}
class jr extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "reflecting", !1);
    A(this, "controlId", `blora-field-${++Kr}`);
    /** True when the author supplied the native input/textarea as a child. */
    A(this, "adopted", !1);
    /** Control attributes currently written from host attributes. */
    A(this, "managed", /* @__PURE__ */ new Set());
  }
  /**
   * An authored `<input>` / `<textarea>` child is adopted instead of being
   * replaced, so attributes written on it (type="password", name,
   * autocomplete, maxlength …) survive. Host attributes still win when set.
   */
  authoredControl() {
    for (const t of Array.from(this.children))
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement && t.type !== "hidden") return t;
    return null;
  }
  /**
   * Write host-driven attributes onto the control. Generated controls mirror
   * the host exactly (previous behaviour); adopted controls only lose an
   * attribute when the host itself had set it earlier.
   */
  applyControlAttributes(t) {
    const e = (i) => !this.adopted || this.managed.has(i), r = (i, s, o) => {
      const c = this.getAttribute(i);
      c !== null ? (s(c), this.managed.add(i)) : e(i) && (o(), this.managed.delete(i));
    }, a = (i, s) => {
      this.hasAttribute(i) ? (t[s] = !0, this.managed.add(i)) : e(i) && (t[s] = !1, this.managed.delete(i));
    };
    t instanceof HTMLInputElement && r(
      "type",
      (i) => t.type = i,
      () => t.type = "text"
    ), r(
      "name",
      (i) => t.name = i,
      () => t.name = ""
    ), r(
      "placeholder",
      (i) => t.placeholder = i,
      () => t.placeholder = ""
    ), a("required", "required"), a("disabled", "disabled"), a("readonly", "readOnly");
    for (const i of Ht)
      r(
        i,
        (s) => t.setAttribute(i, s),
        () => t.removeAttribute(i)
      );
    r(
      "limit",
      (i) => t.dataset.limit = i,
      () => delete t.dataset.limit
    ), r(
      "minlength",
      (i) => t.minLength = Number(i),
      () => t.removeAttribute("minlength")
    ), r(
      "maxlength",
      (i) => t.maxLength = Number(i),
      () => t.removeAttribute("maxlength")
    ), t instanceof HTMLInputElement && r(
      "pattern",
      (i) => t.pattern = i,
      () => t.removeAttribute("pattern")
    );
  }
  static get observedAttributes() {
    return [
      "label",
      "name",
      "type",
      "value",
      "placeholder",
      "hint",
      "error",
      "state",
      "limit",
      "minlength",
      "maxlength",
      "pattern",
      "validate",
      "textarea",
      "required",
      "disabled",
      "readonly",
      "layout",
      ...Ht
    ];
  }
  attributeChangedCallback() {
    var a;
    if (!this.isConnectedInternal || this.reflecting) return;
    const t = this.querySelector("input, textarea"), e = this.hasAttribute("textarea"), r = t instanceof HTMLTextAreaElement;
    if (t && !this.adopted && e !== r) {
      const i = t.value;
      (a = this.controller) == null || a.destroy(), this.render();
      const s = this.querySelector("input, textarea");
      s && i && (s.value = i), this.bindEvents();
      return;
    }
    this.sync();
  }
  get value() {
    var t;
    return ((t = this.querySelector("input, textarea")) == null ? void 0 : t.value) ?? "";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  focus(t) {
    var e;
    (e = this.querySelector("input, textarea")) == null || e.focus(t);
  }
  render() {
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-field", t.dataset.bloraGenerated = "";
    const e = this.getAttribute("state") ?? (this.hasAttribute("error") ? "invalid" : null), r = this.getAttribute("hint") ?? "", a = this.getAttribute("error") ?? "", i = this.authoredControl();
    this.adopted = i !== null, this.managed.clear();
    const s = (i == null ? void 0 : i.id) || (this.id ? `${this.id}-control` : this.controlId), o = `${s}-hint`, c = `${s}-error`;
    (e === "invalid" || e === "valid") && (t.dataset.state = e);
    const u = this.getAttribute("layout");
    u === "horizontal" && (t.dataset.layout = u);
    const b = this.getAttribute("validate");
    b && (t.dataset.bloraValidate = b);
    const d = i ?? (this.hasAttribute("textarea") ? this.ownerDocument.createElement("textarea") : this.ownerDocument.createElement("input"));
    d.id = s, d.classList.add(
      d instanceof HTMLTextAreaElement ? "blora-textarea" : "blora-input"
    );
    const m = this.getAttribute("value");
    (m !== null || !i) && (d.value = m ?? ""), this.applyControlAttributes(d);
    const p = this.getAttribute("label");
    if (p) {
      const g = this.ownerDocument.createElement("label");
      g.className = "blora-field__label", g.htmlFor = s, g.textContent = p, d.required && (g.dataset.required = ""), t.appendChild(g);
    }
    (e === "invalid" || a) && d.setAttribute("aria-invalid", "true");
    const h = [];
    if (r && h.push(o), a && h.push(c), h.length && d.setAttribute("aria-describedby", h.join(" ")), t.appendChild(d), r) {
      const g = this.ownerDocument.createElement("span");
      g.id = o, g.className = "blora-field__help", g.textContent = r, t.appendChild(g);
    }
    const y = this.ownerDocument.createElement("span");
    y.id = c, y.className = "blora-field__error", a ? y.textContent = a : y.hidden = !0, t.appendChild(y), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-field"), e = t == null ? void 0 : t.querySelector("input, textarea");
    if (!t || !e) return;
    const r = this.getAttribute("state") ?? (this.hasAttribute("error") ? "invalid" : null), a = this.getAttribute("hint") ?? "", i = this.getAttribute("error") ?? "", s = e.id || (this.id ? `${this.id}-control` : this.controlId), o = `${s}-hint`, c = `${s}-error`;
    r === "invalid" || r === "valid" ? t.dataset.state = r : delete t.dataset.state;
    const u = this.getAttribute("layout");
    u === "horizontal" ? t.dataset.layout = u : delete t.dataset.layout;
    const b = this.getAttribute("validate");
    b ? t.dataset.bloraValidate = b : delete t.dataset.bloraValidate, document.activeElement !== e && (e.value = this.getAttribute("value") ?? e.value), this.applyControlAttributes(e);
    const d = t.querySelector(".blora-field__label");
    d && (d.textContent = this.getAttribute("label") ?? "", d.toggleAttribute("data-required", e.required)), r === "invalid" || i ? e.setAttribute("aria-invalid", "true") : e.removeAttribute("aria-invalid");
    const m = [];
    a && m.push(o), i && m.push(c), m.length ? e.setAttribute("aria-describedby", m.join(" ")) : e.removeAttribute("aria-describedby");
    let p = t.querySelector(".blora-field__help");
    if (a) {
      if (!p) {
        p = this.ownerDocument.createElement("span"), p.id = o, p.className = "blora-field__help";
        const y = t.querySelector(".blora-field__error");
        y ? t.insertBefore(p, y) : t.appendChild(p);
      }
      p.textContent = a, p.id = o;
    } else
      p == null || p.remove();
    const h = t.querySelector(".blora-field__error");
    h && (h.id = c, h.textContent = i, h.hidden = !i);
  }
  bindEvents() {
    var r;
    const t = this.querySelector(".blora-field"), e = t == null ? void 0 : t.querySelector("input, textarea");
    !t || !e || ((r = this.controller) == null || r.destroy(), this.controller = Xr(t), this.listen(e, "input", () => {
      this.reflecting = !0, this.setAttribute("value", e.value), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Qa(n = customElements) {
  !n || n.get(Ft) || n.define(Ft, jr);
}
const Vt = "blora-upload";
function Qr(n) {
  const l = n.querySelector(
    ".blora-dropzone, .blora-file-picker, .blora-upload__zone"
  );
  if (!l) return { destroy: () => {
  } };
  const t = l.classList.contains("blora-file-picker");
  let e = n.querySelector('input[type="file"]');
  e || (e = document.createElement("input"), e.type = "file", e.className = t ? "blora-file-picker__input" : "blora-dropzone__input", e.setAttribute("aria-hidden", "true"), n.appendChild(e));
  const r = n.querySelector(".blora-upload__list"), a = n.querySelector(".blora-file-picker__empty"), i = n.querySelector(".blora-file-picker__status"), s = n.querySelector(".blora-file-status__name"), o = n.querySelector(".blora-file-clear"), c = n.querySelector(".blora-file-picker__trigger"), u = (_) => {
    const E = _ == null ? void 0 : _[0];
    if (!(!a || !i || !s)) {
      if (!E) {
        a.hidden = !1, i.hidden = !0, s.textContent = "", o && (o.hidden = !0);
        return;
      }
      a.hidden = !0, i.hidden = !1, s.textContent = E.name, o && (o.hidden = !1);
    }
  }, b = (_) => {
    !_ || !_.length || !r || Array.from(_).forEach((E) => {
      const L = document.createElement("div");
      L.className = "blora-upload__row";
      const T = document.createElement("span");
      T.className = "blora-upload__name", T.textContent = E.name;
      const f = document.createElement("span");
      f.className = "blora-upload__size", f.textContent = E.size > 1024 * 1024 ? (E.size / (1024 * 1024)).toFixed(1) + " MB" : Math.round(E.size / 1024) + " KB", L.append(T, f), r.appendChild(L);
    });
  }, d = (_) => {
    t ? u(_) : b(_), n.dispatchEvent(new Event("change", { bubbles: !0 }));
  }, m = () => {
    e.disabled || e.click();
  }, p = () => d(e.files), h = (_) => {
    _.preventDefault(), m();
  }, y = (_) => {
    (_.key === "Enter" || _.key === " ") && (_.preventDefault(), m());
  }, g = (_) => {
    _.preventDefault(), _.stopPropagation(), e.value = "", d(null);
  }, C = t ? [c, a].filter(Boolean) : [l];
  C.forEach((_) => {
    _.addEventListener("click", h), _.addEventListener("keydown", y);
  }), !t && !l.hasAttribute("tabindex") && (l.tabIndex = 0), e.addEventListener("change", p), o == null || o.addEventListener("click", g);
  const S = (_) => {
    _.preventDefault(), l.setAttribute("data-dragover", "");
  }, D = () => l.removeAttribute("data-dragover"), w = (_) => {
    var E;
    _.preventDefault(), l.removeAttribute("data-dragover"), d(((E = _.dataTransfer) == null ? void 0 : E.files) ?? null);
  };
  return l.addEventListener("dragover", S), l.addEventListener("dragleave", D), l.addEventListener("drop", w), {
    destroy() {
      C.forEach((_) => {
        _.removeEventListener("click", h), _.removeEventListener("keydown", y);
      }), e.removeEventListener("change", p), o == null || o.removeEventListener("click", g), l.removeEventListener("dragover", S), l.removeEventListener("dragleave", D), l.removeEventListener("drop", w);
    }
  };
}
class Ue extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "internals", null);
  }
  /** Submitted as File entries under `name` via ElementInternals. */
  syncFormValue() {
    if (!this.internals) return;
    const t = this.querySelector('input[type="file"]'), e = t == null ? void 0 : t.files;
    if (!e || e.length === 0) {
      Y(this.internals, null);
      return;
    }
    const r = this.getAttribute("name") ?? "", a = new FormData();
    for (const i of Array.from(e)) a.append(r, i, i.name);
    Y(this.internals, a);
  }
  static get observedAttributes() {
    return ["prompt", "hint", "accept", "multiple", "name", "disabled", "variant"];
  }
  attributeChangedCallback(t) {
    var e;
    if (this.isConnectedInternal) {
      if (t === "variant") {
        (e = this.controller) == null || e.destroy(), this.render(), this.bindEvents();
        return;
      }
      this.sync();
    }
  }
  get files() {
    var t;
    return ((t = this.querySelector('input[type="file"]')) == null ? void 0 : t.files) ?? null;
  }
  focus(t) {
    var e;
    (e = this.querySelector(".blora-dropzone, .blora-file-picker")) == null || e.focus(t);
  }
  open() {
    var t;
    this.hasAttribute("disabled") || (t = this.querySelector('input[type="file"]')) == null || t.click();
  }
  render() {
    this.internals ?? (this.internals = X(this));
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-upload", t.dataset.bloraGenerated = "";
    const e = this.getAttribute("variant") === "compact", r = this.hasAttribute("disabled"), a = this.getAttribute("prompt") ?? (e ? v("upload.choose") : v("upload.drop")), i = this.getAttribute("hint") ?? (e ? v("upload.hint") : v("upload.drop")), s = this.ownerDocument.createElement("input");
    if (s.className = e ? "blora-file-picker__input" : "blora-dropzone__input", s.type = "file", s.name = this.internals ? "" : this.getAttribute("name") ?? "", s.accept = this.getAttribute("accept") ?? "", s.multiple = this.hasAttribute("multiple"), s.disabled = r, s.setAttribute("aria-hidden", "true"), e) {
      const o = this.ownerDocument.createElement("div");
      o.className = "blora-file-picker";
      const c = this.ownerDocument.createElement("button");
      c.type = "button", c.className = "blora-file-picker__trigger", c.disabled = r;
      const u = I("upload", 18, this.ownerDocument);
      u.setAttribute("stroke-width", "1.8");
      const b = this.ownerDocument.createElement("span");
      b.className = "blora-file-picker__label", b.textContent = a, c.append(u, b);
      const d = this.ownerDocument.createElement("span");
      d.className = "blora-file-picker__empty", d.textContent = i;
      const m = this.ownerDocument.createElement("span");
      m.className = "blora-file-status blora-file-picker__status", m.hidden = !0;
      const p = this.ownerDocument.createElement("span");
      p.className = "blora-file-status__name";
      const h = this.ownerDocument.createElement("button");
      h.type = "button", h.className = "blora-file-clear", h.hidden = !0, h.setAttribute("aria-label", v("file.clear")), h.title = v("file.clear"), h.appendChild(I("close", 14, this.ownerDocument)), m.append(p, h), o.append(s, c, d, m), t.append(o);
    } else {
      const o = this.ownerDocument.createElement("div");
      o.className = "blora-dropzone", o.tabIndex = r ? -1 : 0, o.setAttribute("role", "button"), o.setAttribute("aria-disabled", String(r));
      const c = this.ownerDocument.createElement("div");
      c.className = "blora-dropzone__icon";
      const u = I("upload", 40, this.ownerDocument);
      u.setAttribute("stroke-width", "1.5"), c.appendChild(u);
      const b = this.ownerDocument.createElement("div");
      b.className = "blora-upload__content";
      const d = this.ownerDocument.createElement("strong");
      d.textContent = a;
      const m = this.ownerDocument.createElement("span");
      m.textContent = ` ${v("upload.or")} ${v("upload.browse")}`, b.append(d, m);
      const p = this.ownerDocument.createElement("div");
      p.className = "blora-upload__hint", p.textContent = i, o.append(c, b, p);
      const h = this.ownerDocument.createElement("div");
      h.className = "blora-upload__list", t.append(o, s, h);
    }
    this.replaceChildren(t), this.syncFormValue();
  }
  sync() {
    const t = this.querySelector(".blora-upload");
    if (!t) return;
    const e = this.getAttribute("variant") === "compact", r = this.hasAttribute("disabled"), a = t.querySelector('input[type="file"]');
    a && (a.name = this.internals ? "" : this.getAttribute("name") ?? "", a.accept = this.getAttribute("accept") ?? "", a.multiple = this.hasAttribute("multiple"), a.disabled = r);
    const i = this.getAttribute("prompt") ?? (e ? v("upload.choose") : v("upload.drop")), s = this.getAttribute("hint") ?? (e ? v("upload.hint") : v("upload.drop")), o = t.querySelector(".blora-upload__content strong");
    o && (o.textContent = this.getAttribute("prompt") ?? v("upload.drop"));
    const c = t.querySelector(".blora-upload__hint");
    c && (c.textContent = s);
    const u = t.querySelector(".blora-file-picker__trigger");
    if (u) {
      const m = u.querySelector(".blora-file-picker__label");
      m ? m.textContent = i : u.textContent = i, u.disabled = r;
    }
    const b = t.querySelector(".blora-file-picker__empty");
    b && !b.hidden && (b.textContent = s);
    const d = t.querySelector(".blora-dropzone, .blora-file-picker");
    d && (d.setAttribute("aria-disabled", String(r)), e || (d.tabIndex = r ? -1 : 0));
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-upload");
    (e = this.controller) == null || e.destroy(), this.controller = null, t && !this.hasAttribute("disabled") && (this.controller = Qr(t)), t && this.listen(t, "change", () => this.syncFormValue());
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
A(Ue, "formAssociated", !0);
function Ja(n = customElements) {
  !n || n.get(Vt) || n.define(Vt, Ue);
}
const zt = "blora-tooltip";
function Jr(n) {
  if (typeof document > "u") return { destroy: () => {
  } };
  const l = n.querySelector(".blora-tooltip__bubble");
  if (!l) return { destroy: () => {
  } };
  const t = n.ownerDocument.defaultView, e = () => {
    l.style.setProperty("--blora-float-shift-x", "0px"), l.style.setProperty("--blora-float-shift-y", "0px");
    const r = l.getBoundingClientRect(), a = 12;
    let i = 0, s = 0;
    r.left < a && (i += a - r.left), r.right + i > t.innerWidth - a && (i -= r.right + i - (t.innerWidth - a)), r.top < a && (s += a - r.top), r.bottom + s > t.innerHeight - a && (s -= r.bottom + s - (t.innerHeight - a)), l.style.setProperty("--blora-float-shift-x", `${i}px`), l.style.setProperty("--blora-float-shift-y", `${s}px`);
  };
  return n.addEventListener("pointerenter", e), n.addEventListener("focusin", e), t.addEventListener("resize", e), {
    destroy() {
      n.removeEventListener("pointerenter", e), n.removeEventListener("focusin", e), t.removeEventListener("resize", e);
    }
  };
}
class Zr extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "triggerNodes", null);
  }
  static get observedAttributes() {
    return ["text", "trigger", "placement", "disabled"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  focus(t) {
    var e;
    (e = this.querySelector(".blora-tooltip")) == null || e.focus(t);
  }
  render() {
    if (!this.triggerNodes) {
      const a = this.querySelector(".blora-tooltip");
      this.triggerNodes = a ? Array.from(a.childNodes).filter(
        (i) => !(i instanceof HTMLElement) || !i.classList.contains("blora-tooltip__bubble")
      ) : Array.from(this.childNodes);
    }
    const t = this.ownerDocument.createElement("span");
    t.className = "blora-tooltip", t.dataset.bloraGenerated = "", t.tabIndex = this.hasAttribute("disabled") ? -1 : 0;
    const e = this.getAttribute("trigger");
    e ? t.appendChild(this.ownerDocument.createTextNode(e)) : t.append(...this.triggerNodes);
    const r = this.ownerDocument.createElement("span");
    r.className = "blora-tooltip__bubble", r.setAttribute("role", "tooltip"), r.textContent = this.getAttribute("text") ?? "", t.appendChild(r), this.replaceChildren(t), this.sync();
  }
  sync() {
    const t = this.querySelector(".blora-tooltip");
    if (!t) return;
    t.tabIndex = this.hasAttribute("disabled") ? -1 : 0;
    const e = this.getAttribute("placement");
    e ? t.dataset.placement = e : delete t.dataset.placement;
    const r = t.querySelector(".blora-tooltip__bubble");
    r && (r.textContent = this.getAttribute("text") ?? "");
    const a = this.getAttribute("trigger");
    if (a) {
      const i = t.firstChild;
      (i == null ? void 0 : i.nodeType) === Node.TEXT_NODE && (i.textContent = a);
    }
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-tooltip");
    (e = this.controller) == null || e.destroy(), this.controller = t && !this.hasAttribute("disabled") ? Jr(t) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Za(n = customElements) {
  !n || n.get(zt) || n.define(zt, Zr);
}
const Yt = "blora-popover";
function tn(n, l) {
  if (typeof document > "u")
    return { open: () => {
    }, close: () => {
    }, destroy: () => {
    } };
  const t = n.querySelector("[data-blora-popover], .blora-popover__trigger") || n.querySelector("button"), e = n.querySelector(".blora-popover__panel");
  if (!t || !e)
    return { open: () => {
    }, close: () => {
    }, destroy: () => {
    } };
  const r = n.ownerDocument, a = (u) => {
    u ? n.setAttribute("data-open", "") : n.removeAttribute("data-open"), t.setAttribute("aria-expanded", String(u)), l == null || l(u);
  }, i = (u) => {
    u.stopPropagation(), a(!n.hasAttribute("data-open"));
  }, s = (u) => {
    !n.contains(u.target) && !e.contains(u.target) && a(!1);
  }, o = (u) => {
    u.key === "Escape" && a(!1);
  }, c = () => a(!1);
  return t.setAttribute("aria-haspopup", "dialog"), t.setAttribute("aria-expanded", "false"), t.addEventListener("click", i), r.addEventListener("click", s), r.addEventListener("keydown", o), e.querySelectorAll("[data-blora-close]").forEach((u) => u.addEventListener("click", c)), a(n.hasAttribute("data-open")), {
    open: () => a(!0),
    close: () => a(!1),
    destroy() {
      t.removeEventListener("click", i), r.removeEventListener("click", s), r.removeEventListener("keydown", o), e.querySelectorAll("[data-blora-close]").forEach((u) => u.removeEventListener("click", c));
    }
  };
}
class en extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "reflecting", !1);
    A(this, "contentNodes", null);
  }
  static get observedAttributes() {
    return ["trigger", "content", "close-label", "open", "disabled"];
  }
  attributeChangedCallback(t) {
    var e, r;
    if (!(!this.isConnectedInternal || this.reflecting)) {
      if (t === "open") {
        this.hasAttribute("open") ? (e = this.controller) == null || e.open() : (r = this.controller) == null || r.close();
        return;
      }
      this.sync();
    }
  }
  open() {
    this.setAttribute("open", "");
  }
  close() {
    this.removeAttribute("open");
  }
  render() {
    if (!this.contentNodes) {
      const s = this.querySelector(".blora-popover__content"), o = s ? Array.from(s.childNodes) : Array.from(this.childNodes).filter(
        (c) => {
          var u;
          return c.nodeType === Node.ELEMENT_NODE || (((u = c.textContent) == null ? void 0 : u.trim().length) ?? 0) > 0;
        }
      );
      this.contentNodes = o.length ? o : null;
    }
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-popover", t.dataset.bloraGenerated = "", this.hasAttribute("open") && (t.dataset.open = "");
    const e = this.ownerDocument.createElement("button");
    e.type = "button", e.className = "blora-button blora-popover__trigger", e.dataset.variant = "outline", e.dataset.bloraPopover = "", e.disabled = this.hasAttribute("disabled"), e.textContent = this.getAttribute("trigger") ?? v("popover.trigger");
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-popover__panel", r.setAttribute("role", "dialog");
    const a = this.ownerDocument.createElement("div");
    a.className = "blora-popover__content", this.contentNodes ? a.append(...this.contentNodes) : a.textContent = this.getAttribute("content") ?? "";
    const i = this.ownerDocument.createElement("button");
    i.type = "button", i.className = "blora-button", i.dataset.size = "sm", i.dataset.bloraClose = "", i.textContent = this.getAttribute("close-label") ?? v("common.close"), r.append(a, i), t.append(e, r), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-popover");
    if (!t) return;
    const e = t.querySelector(".blora-popover__trigger");
    e && (e.textContent = this.getAttribute("trigger") ?? v("popover.trigger"), e.disabled = this.hasAttribute("disabled"));
    const r = t.querySelector(".blora-popover__content");
    r && !this.contentNodes && (r.textContent = this.getAttribute("content") ?? "");
    const a = t.querySelector("[data-blora-close]");
    a && (a.textContent = this.getAttribute("close-label") ?? v("common.close"));
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-popover");
    (e = this.controller) == null || e.destroy(), this.controller = t ? tn(t, (r) => {
      this.reflecting = !0, this.toggleAttribute("open", r), this.reflecting = !1;
    }) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function ti(n = customElements) {
  !n || n.get(Yt) || n.define(Yt, en);
}
const Wt = "blora-popconfirm";
function rn(n) {
  if (typeof document > "u") return { destroy: () => {
  } };
  const l = n.querySelector(
    "[data-blora-popconfirm-trigger], .blora-popconfirm__trigger"
  ) || n.querySelector("button"), t = n.querySelector(".blora-popconfirm__panel");
  if (!l || !t) return { destroy: () => {
  } };
  const e = (s) => {
    s ? n.setAttribute("data-open", "") : n.removeAttribute("data-open");
  }, r = (s) => {
    s.stopPropagation(), e(!n.hasAttribute("data-open"));
  }, a = (s) => {
    const o = s.target;
    o.closest("[data-confirm], [data-blora-confirm]") && (n.dispatchEvent(new CustomEvent("blora-confirm", { bubbles: !0 })), e(!1)), o.closest("[data-cancel], [data-blora-cancel], [data-blora-close]") && e(!1);
  }, i = (s) => {
    n.contains(s.target) || e(!1);
  };
  return l.addEventListener("click", r), t.addEventListener("click", a), n.ownerDocument.addEventListener("click", i), {
    destroy() {
      l.removeEventListener("click", r), t.removeEventListener("click", a), n.ownerDocument.removeEventListener("click", i);
    }
  };
}
class nn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
  }
  static get observedAttributes() {
    return ["trigger", "message", "confirm-label", "cancel-label", "open", "disabled"];
  }
  attributeChangedCallback(t) {
    if (this.isConnectedInternal) {
      if (t === "open") {
        this.hasAttribute("open") ? this.open() : this.close();
        return;
      }
      this.sync();
    }
  }
  open() {
    var t;
    (t = this.querySelector(".blora-popconfirm")) == null || t.setAttribute("data-open", "");
  }
  close() {
    var t;
    (t = this.querySelector(".blora-popconfirm")) == null || t.removeAttribute("data-open");
  }
  render() {
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-popconfirm", t.dataset.bloraGenerated = "", this.hasAttribute("open") && (t.dataset.open = "");
    const e = this.ownerDocument.createElement("button");
    e.type = "button", e.className = "blora-button blora-popconfirm__trigger", e.dataset.variant = "danger", e.dataset.bloraPopconfirmTrigger = "", e.disabled = this.hasAttribute("disabled"), e.textContent = this.getAttribute("trigger") ?? v("popconfirm.trigger");
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-popconfirm__panel", r.setAttribute("role", "alertdialog");
    const a = this.ownerDocument.createElement("p");
    a.className = "blora-popconfirm__title", a.textContent = this.getAttribute("message") ?? v("popconfirm.message");
    const i = this.ownerDocument.createElement("div");
    i.className = "blora-popconfirm__actions";
    const s = this.ownerDocument.createElement("button");
    s.type = "button", s.className = "blora-button", s.dataset.size = "sm", s.dataset.variant = "ghost", s.dataset.cancel = "", s.textContent = this.getAttribute("cancel-label") ?? v("common.cancel");
    const o = this.ownerDocument.createElement("button");
    o.type = "button", o.className = "blora-button", o.dataset.size = "sm", o.dataset.variant = "danger", o.dataset.confirm = "", o.textContent = this.getAttribute("confirm-label") ?? v("common.confirm"), i.append(s, o), r.append(a, i), t.append(e, r), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-popconfirm__trigger");
    t && (t.textContent = this.getAttribute("trigger") ?? v("popconfirm.trigger"), t.disabled = this.hasAttribute("disabled"));
    const e = this.querySelector(".blora-popconfirm__title");
    e && (e.textContent = this.getAttribute("message") ?? v("popconfirm.message"));
    const r = this.querySelector("[data-cancel]");
    r && (r.textContent = this.getAttribute("cancel-label") ?? v("common.cancel"));
    const a = this.querySelector("[data-confirm]");
    a && (a.textContent = this.getAttribute("confirm-label") ?? v("common.confirm"));
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-popconfirm");
    (e = this.controller) == null || e.destroy(), this.controller = t ? rn(t) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function ei(n = customElements) {
  !n || n.get(Wt) || n.define(Wt, nn);
}
const Ut = "blora-dropdown";
function an(n) {
  const l = new AbortController(), { signal: t } = l, e = n.querySelector("[data-dropdown-trigger]"), r = n.querySelector(".blora-dropdown__menu");
  if (!e || !r)
    return {
      open: () => {
      },
      close: () => {
      },
      toggle: () => {
      },
      destroy: () => {
      }
    };
  const a = e, i = r, s = !!i.querySelector(".blora-dropdown__item");
  a.setAttribute("aria-haspopup", s ? "menu" : "dialog"), a.id || (a.id = `blora-dropdown-trigger-${Math.random().toString(36).slice(2, 9)}`), i.setAttribute("role", s ? "menu" : "dialog"), i.setAttribute("aria-labelledby", a.id);
  function o() {
    return n.hasAttribute("data-open");
  }
  function c() {
    a.setAttribute("aria-expanded", String(o())), i.setAttribute("aria-hidden", String(!o()));
  }
  function u() {
    document.querySelectorAll(".blora-dropdown[data-open]").forEach((m) => {
      var p, h;
      m !== n && (m.removeAttribute("data-open"), (p = m.querySelector("[data-dropdown-trigger]")) == null || p.setAttribute("aria-expanded", "false"), (h = m.querySelector(".blora-dropdown__menu")) == null || h.setAttribute("aria-hidden", "true"));
    }), n.setAttribute("data-open", ""), c();
  }
  function b() {
    n.removeAttribute("data-open"), c();
  }
  function d() {
    o() ? b() : u();
  }
  return a.addEventListener(
    "click",
    (m) => {
      a.getAttribute("aria-disabled") !== "true" && (m.stopPropagation(), d());
    },
    { signal: t }
  ), a.addEventListener(
    "keydown",
    (m) => {
      a.getAttribute("aria-disabled") !== "true" && (m.key !== "Enter" && m.key !== " " || (m.preventDefault(), m.stopPropagation(), d()));
    },
    { signal: t }
  ), i.addEventListener(
    "click",
    (m) => {
      m.target.closest(".blora-dropdown__item") && b();
    },
    { signal: t }
  ), n.addEventListener(
    "keydown",
    (m) => {
      m.key === "Escape" && o() && (m.stopPropagation(), b(), a.focus());
    },
    { signal: t }
  ), document.addEventListener(
    "click",
    () => {
      o() && b();
    },
    { signal: t }
  ), c(), { open: u, close: b, toggle: d, destroy: () => l.abort() };
}
class sn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "contentNodes", null);
  }
  static get observedAttributes() {
    return ["label", "open", "disabled", "align", "placement", "variant"];
  }
  attributeChangedCallback(t) {
    var e, r;
    if (this.isConnectedInternal) {
      if (t === "open") {
        this.hasAttribute("open") ? (e = this.controller) == null || e.open() : (r = this.controller) == null || r.close();
        return;
      }
      this.sync();
    }
  }
  open() {
    var t;
    (t = this.controller) == null || t.open();
  }
  close() {
    var t;
    (t = this.controller) == null || t.close();
  }
  toggle() {
    var t;
    (t = this.controller) == null || t.toggle();
  }
  alignValue() {
    const t = this.getAttribute("align");
    return t === "center" || t === "end" ? t : "start";
  }
  placementValue() {
    return this.getAttribute("placement") === "top" ? "top" : "bottom";
  }
  isHelper() {
    return this.getAttribute("variant") === "helper";
  }
  render() {
    const t = Array.from(this.children).find(
      (s) => s.getAttribute("slot") === "trigger"
    ), e = Array.from(this.children).filter(
      (s) => s.localName === "blora-dropdown-item"
    );
    if (!this.definitions && !this.contentNodes)
      if (e.length)
        this.definitions = e.map((s) => {
          var o, c;
          return {
            disabled: s.hasAttribute("disabled"),
            href: s.getAttribute("href"),
            label: s.getAttribute("label") ?? ((o = s.textContent) == null ? void 0 : o.trim()) ?? "",
            separator: s.hasAttribute("separator"),
            value: s.getAttribute("value") ?? ((c = s.textContent) == null ? void 0 : c.trim()) ?? ""
          };
        });
      else {
        const s = Array.from(this.childNodes).filter(
          (o) => {
            var c;
            return o !== t && (o.nodeType === Node.ELEMENT_NODE || (((c = o.textContent) == null ? void 0 : c.trim().length) ?? 0) > 0);
          }
        );
        this.contentNodes = s.length ? s : [];
      }
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-dropdown", r.dataset.bloraGenerated = "", r.dataset.align = this.alignValue(), r.dataset.placement = this.placementValue(), r.dataset.trigger = t ? "custom" : "default", this.isHelper() && (r.dataset.variant = "helper"), this.hasAttribute("open") && (r.dataset.open = "");
    const a = t ? t.cloneNode(!0) : this.ownerDocument.createElement("button");
    if (a.dataset.dropdownTrigger = "", a.dataset.trigger = t ? "custom" : "default", t)
      a.hasAttribute("role") || a.setAttribute("role", "button"), a.hasAttribute("tabindex") || a.setAttribute("tabindex", "0"), this.hasAttribute("disabled") && (a.setAttribute("aria-disabled", "true"), a.setAttribute("tabindex", "-1"));
    else {
      const s = a;
      s.type = "button", s.className = "blora-button", s.disabled = this.hasAttribute("disabled");
      const o = this.getAttribute("label") ?? v("dropdown.label");
      if (this.isHelper())
        a.dataset.variant = "ghost", a.dataset.size = "icon", a.setAttribute("aria-label", o), a.append(I("info", 16, this.ownerDocument));
      else {
        a.dataset.variant = "outline";
        const c = this.ownerDocument.createElement("span");
        c.className = "blora-dropdown__label", c.textContent = o, a.append(c, I("chevron-down", 16, this.ownerDocument));
      }
    }
    const i = this.ownerDocument.createElement("div");
    i.className = "blora-dropdown__menu", this.contentNodes && i.append(...this.contentNodes);
    for (const s of this.definitions ?? []) {
      if (s.separator) {
        const c = this.ownerDocument.createElement("div");
        c.className = "blora-dropdown__sep", c.setAttribute("role", "separator"), i.appendChild(c);
      }
      const o = s.href ? this.ownerDocument.createElement("a") : this.ownerDocument.createElement("button");
      o.className = "blora-dropdown__item", o.dataset.value = s.value, o.textContent = s.label, o instanceof HTMLAnchorElement ? o.href = s.href : o.type = "button", s.disabled && (o.setAttribute("aria-disabled", "true"), o instanceof HTMLButtonElement && (o.disabled = !0)), i.appendChild(o);
    }
    r.append(a, i), this.replaceChildren(r);
  }
  sync() {
    const t = this.querySelector(".blora-dropdown"), e = this.querySelector("[data-dropdown-trigger]");
    if (!t || !e) return;
    t.dataset.align = this.alignValue(), t.dataset.placement = this.placementValue(), this.hasAttribute("disabled") ? (e.setAttribute("aria-disabled", "true"), e instanceof HTMLButtonElement && (e.disabled = !0)) : (e.removeAttribute("aria-disabled"), e instanceof HTMLButtonElement && (e.disabled = !1));
    const r = this.getAttribute("label") ?? v("dropdown.label"), a = e.querySelector(".blora-dropdown__label");
    a && (a.textContent = r), t.dataset.trigger !== "custom" && this.isHelper() && e.setAttribute("aria-label", r);
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-dropdown");
    t && ((e = this.controller) == null || e.destroy(), this.controller = an(t), this.listen(t, "click", (r) => {
      const a = r.target.closest(".blora-dropdown__item");
      a && a.getAttribute("aria-disabled") !== "true" && this.emit("blora-select", { value: a.dataset.value ?? "" });
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function ri(n = customElements) {
  !n || n.get(Ut) || n.define(Ut, sn);
}
const Kt = "blora-drawer";
function on(n) {
  if (typeof n.showPopover == "function" && (n.setAttribute("popover", "manual"), !n.matches(":popover-open")))
    try {
      n.showPopover();
    } catch {
    }
}
function Xt(n) {
  if (typeof n.hidePopover == "function")
    try {
      n.hidePopover();
    } catch {
    }
  n.getAttribute("popover") === "manual" && n.removeAttribute("popover");
}
function ln(n, l) {
  if (typeof document > "u")
    return { open: () => {
    }, close: () => {
    }, destroy: () => {
    } };
  const t = l ?? n.closest("blora-drawer") ?? n, e = n.querySelector(".blora-drawer__panel");
  let r = !1, a = null, i = null;
  const s = () => o(!1), o = (u) => {
    if (!r) {
      r = !0;
      try {
        if (u) {
          i == null || i(), i = null, n.setAttribute("data-open", ""), n.setAttribute("open", ""), t !== n && (t.setAttribute("data-open", ""), t.setAttribute("open", "")), e == null || e.setAttribute("tabindex", "-1"), a == null || a.close(), a = new dt(n, {
            modal: !0,
            closeOnEscape: !0,
            closeOnOutsidePointer: !1,
            restoreFocus: !0,
            trapFocus: !0,
            lockScroll: !0
          }), a.open(), n.addEventListener("blora-close-request", s), on(n);
          return;
        }
        n.removeAttribute("data-open"), n.removeAttribute("open"), t !== n && (t.removeAttribute("data-open"), t.removeAttribute("open")), n.removeEventListener("blora-close-request", s);
        const b = a;
        a = null, i == null || i(), i = rt(n, () => {
          i = null, b == null || b.close(), Xt(n);
        });
      } finally {
        r = !1;
      }
    }
  }, c = (u) => {
    const b = u.target;
    (b.closest("[data-blora-close]") || b.classList.contains("blora-drawer__mask")) && o(!1);
  };
  return n.addEventListener("click", c), {
    open: () => o(!0),
    close: () => o(!1),
    destroy() {
      n.removeEventListener("click", c), n.removeEventListener("blora-close-request", s), a == null || a.destroy(), a = null, i == null || i(), Xt(n);
    }
  };
}
class cn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "contentNodes", null);
    A(this, "relocating", !1);
    A(this, "home", null);
  }
  static get observedAttributes() {
    return ["title", "position", "open", "close-label"];
  }
  attributeChangedCallback(t) {
    var e, r;
    if (this.isConnectedInternal) {
      if (t === "open") {
        if (this.hasAttribute("open"))
          this.portalToBody(), (e = this.controller) == null || e.open();
        else {
          (r = this.controller) == null || r.close();
          const a = this.querySelector(".blora-drawer") ?? this;
          rt(a, () => this.restoreHome());
        }
        return;
      }
      this.sync();
    }
  }
  open() {
    this.setAttribute("open", ""), this.setAttribute("data-open", "");
  }
  close() {
    this.removeAttribute("open"), this.removeAttribute("data-open");
  }
  render() {
    if (!this.contentNodes) {
      const u = this.querySelector(".blora-drawer__body");
      this.contentNodes = Array.from(u ? u.childNodes : this.childNodes);
    }
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-drawer", t.dataset.bloraGenerated = "", t.dataset.position = this.getAttribute("position") ?? "right", this.hasAttribute("open") && (t.dataset.open = "", t.setAttribute("open", ""));
    const e = this.ownerDocument.createElement("div");
    e.className = "blora-drawer__mask";
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-drawer__panel", r.setAttribute("role", "dialog"), r.setAttribute("aria-modal", "true");
    const a = this.ownerDocument.createElement("div");
    a.className = "blora-drawer__header";
    const i = this.ownerDocument.createElement("h3");
    i.className = "blora-drawer__title", i.textContent = this.getAttribute("title") ?? v("drawer.title");
    const s = this.ownerDocument.createElement("button");
    s.type = "button", s.className = "blora-drawer__close", s.dataset.bloraClose = "", s.setAttribute("aria-label", this.getAttribute("close-label") ?? v("common.close")), s.appendChild(I("close", 18, this.ownerDocument)), a.append(i, s);
    const o = this.ownerDocument.createElement("div");
    o.className = "blora-drawer__body";
    const c = this.ownerDocument.createElement("div");
    c.className = "blora-drawer__content", c.append(...this.contentNodes), o.appendChild(c), r.append(a, o), t.append(e, r), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-drawer");
    if (!t) return;
    t.dataset.position = this.getAttribute("position") ?? "right";
    const e = t.querySelector(".blora-drawer__title");
    e && (e.textContent = this.getAttribute("title") ?? v("drawer.title"));
    const r = t.querySelector(".blora-drawer__close");
    r && r.setAttribute("aria-label", this.getAttribute("close-label") ?? v("common.close"));
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-drawer");
    (e = this.controller) == null || e.destroy(), this.controller = t ? ln(t, this) : null;
  }
  disconnectedCallback() {
    this.relocating || super.disconnectedCallback();
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null, this.restoreHome();
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
}
function ni(n = customElements) {
  !n || n.get(Kt) || n.define(Kt, cn);
}
const jt = "blora-backtop";
function un(n) {
  if (n.querySelector("svg")) return;
  const l = I("arrow-up", 22, n.ownerDocument);
  l.setAttribute("stroke-width", "2.5"), (n.childNodes.length > 0 && Array.from(n.childNodes).every(
    (e) => e.nodeType === Node.TEXT_NODE || e.nodeType === Node.COMMENT_NODE
  ) || n.childNodes.length === 0) && Array.from(n.childNodes).forEach((e) => {
    e.nodeType === Node.TEXT_NODE && e.remove();
  }), n.appendChild(l);
}
function Ke(n, l) {
  if (typeof document > "u" || typeof window > "u")
    return { show: () => {
    }, hide: () => {
    }, destroy: () => {
    } };
  n.classList.add("blora-backtop"), un(n), n.getAttribute("aria-label") || n.setAttribute("aria-label", v("common.backTop"));
  const t = Number(
    n.getAttribute("data-show-after") || n.getAttribute("data-blora-backtop") || ""
  ), e = Number.isFinite(t) && t > 0 ? t : 400, r = n.getAttribute("data-target");
  let a = window;
  if (r) {
    const d = document.querySelector(r);
    d && (a = d);
  }
  const i = () => a === window ? window.scrollY || document.documentElement.scrollTop || 0 : a.scrollTop, s = () => {
    n.removeAttribute("data-hidden"), n.classList.add("is-visible");
  }, o = () => {
    n.setAttribute("data-hidden", ""), n.classList.remove("is-visible");
  }, c = () => {
    i() >= e ? s() : o();
  }, u = (d) => {
    d.preventDefault(), a === window ? window.scrollTo({ top: 0, behavior: "smooth" }) : a.scrollTo({ top: 0, behavior: "smooth" });
  };
  o(), c();
  const b = a === window ? window : a;
  return b.addEventListener("scroll", c, { passive: !0 }), n.addEventListener("click", u), {
    show: s,
    hide: o,
    destroy() {
      b.removeEventListener("scroll", c), n.removeEventListener("click", u);
    }
  };
}
function ai(n = document) {
  if (typeof document > "u") return () => {
  };
  const l = [];
  return n.querySelectorAll("[data-blora-backtop], .blora-backtop").forEach((t) => {
    t.classList.contains("blora-fab--static") || l.push(Ke(t));
  }), () => l.forEach((t) => t.destroy());
}
class dn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
  }
  static get observedAttributes() {
    return ["show-after", "target", "label"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  show() {
    var t;
    (t = this.controller) == null || t.show();
  }
  hide() {
    var t;
    (t = this.controller) == null || t.hide();
  }
  render() {
    const t = this.ownerDocument.createElement("button");
    t.type = "button", t.className = "blora-backtop", t.dataset.bloraGenerated = "", t.setAttribute("aria-label", this.getAttribute("label") ?? v("common.backTop"));
    const e = this.getAttribute("show-after");
    e && (t.dataset.showAfter = e);
    const r = this.getAttribute("target");
    r && (t.dataset.target = r), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-backtop");
    if (!t) return;
    t.setAttribute("aria-label", this.getAttribute("label") ?? v("common.backTop"));
    const e = this.getAttribute("show-after");
    e ? t.dataset.showAfter = e : delete t.dataset.showAfter;
    const r = this.getAttribute("target");
    r ? t.dataset.target = r : delete t.dataset.target, this.rebind();
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-backtop");
    (e = this.controller) == null || e.destroy(), this.controller = t ? Ke(t) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function ii(n = customElements) {
  !n || n.get(jt) || n.define(jt, dn);
}
const Qt = "blora-copy";
function bn(n) {
  const l = n.ownerDocument, t = l.defaultView, e = n.querySelector(
    ".blora-copy__btn, .blora-typo-copy__btn, [data-copy]"
  );
  if (!e) return { destroy: () => {
  } };
  let r = [], a = null;
  const i = () => I("check", 14, l), s = async (o) => {
    var b;
    o.preventDefault(), o.stopPropagation();
    const c = n.getAttribute("data-blora-copy") || n.dataset.copyText || e.dataset.copyText || ((b = n.textContent) == null ? void 0 : b.trim()) || "";
    let u = !1;
    try {
      await (t == null ? void 0 : t.navigator.clipboard.writeText(c)), u = !0;
    } catch {
      const d = l.createElement("textarea");
      d.value = c, l.body.appendChild(d), d.select();
      try {
        u = l.execCommand("copy");
      } catch {
        u = !1;
      }
      d.remove();
    }
    u && (r = Array.from(e.childNodes), e.replaceChildren(i()), n.setAttribute("data-copied", ""), a && clearTimeout(a), a = setTimeout(() => {
      e.replaceChildren(...r), n.removeAttribute("data-copied");
    }, 1500));
  };
  return e.addEventListener("click", s), {
    destroy() {
      e.removeEventListener("click", s), a && clearTimeout(a);
    }
  };
}
class hn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "initialText", null);
    A(this, "revealed", !1);
  }
  static get observedAttributes() {
    return ["text", "label", "masked"];
  }
  attributeChangedCallback(t) {
    if (this.isConnectedInternal) {
      if (t === "masked") {
        this.revealed = !1, this.render(), this.bindEvents();
        return;
      }
      this.sync();
    }
  }
  copy() {
    var t;
    (t = this.querySelector(".blora-copy__btn")) == null || t.click();
  }
  render() {
    var i;
    this.initialText === null && (this.initialText = ((i = this.textContent) == null ? void 0 : i.trim()) ?? "");
    const t = this.getAttribute("text") ?? this.initialText, e = this.ownerDocument.createElement("span");
    e.className = "blora-copy blora-typo-copy", e.dataset.bloraGenerated = "", e.dataset.bloraCopy = t;
    const r = this.ownerDocument.createElement("code");
    r.className = "blora-code", r.dataset.copyValue = t;
    const a = this.ownerDocument.createElement("button");
    if (a.type = "button", a.className = "blora-copy__btn blora-typo-copy__btn", a.setAttribute("aria-label", this.getAttribute("label") ?? v("common.copy")), a.appendChild(I("copy", 14, this.ownerDocument)), e.append(r, a), this.hasAttribute("masked")) {
      e.dataset.masked = "";
      const s = this.ownerDocument.createElement("button");
      s.type = "button", s.className = "blora-copy__reveal-btn", s.setAttribute("aria-label", v("copy.show")), s.appendChild(I("eye", 16, this.ownerDocument)), e.appendChild(s), this.updateMaskedDisplay(e, t);
    } else
      r.textContent = t;
    this.replaceChildren(e);
  }
  updateMaskedDisplay(t, e) {
    const r = t.querySelector("code");
    if (!r) return;
    r.textContent = this.revealed ? e : "•".repeat(Math.max(1, [...e].length)), t.dataset.revealed = String(this.revealed);
    const a = t.querySelector(".blora-copy__reveal-btn");
    a && (a.setAttribute("aria-label", this.revealed ? v("copy.hide") : v("copy.show")), a.setAttribute("aria-pressed", String(this.revealed)), a.replaceChildren(
      I(this.revealed ? "eye-off" : "eye", 16, this.ownerDocument)
    ));
  }
  sync() {
    const t = this.querySelector(".blora-copy");
    if (!t) return;
    const e = this.getAttribute("text") ?? this.initialText ?? "";
    t.dataset.bloraCopy = e;
    const r = t.querySelector("code");
    r && (r.dataset.copyValue = e), this.hasAttribute("masked") ? this.updateMaskedDisplay(t, e) : r && (r.textContent = e);
    const a = t.querySelector(".blora-copy__btn");
    a && a.setAttribute("aria-label", this.getAttribute("label") ?? v("common.copy"));
  }
  bindEvents() {
    var r;
    const t = this.querySelector(".blora-copy");
    (r = this.controller) == null || r.destroy(), this.controller = t ? bn(t) : null;
    const e = t == null ? void 0 : t.querySelector(".blora-copy__reveal-btn");
    t && e && this.listen(e, "click", (a) => {
      a.preventDefault(), a.stopPropagation(), this.revealed = !this.revealed, this.updateMaskedDisplay(t, this.getAttribute("text") ?? this.initialText ?? "");
    });
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function si(n = customElements) {
  !n || n.get(Qt) || n.define(Qt, hn);
}
const Jt = "blora-progress";
function pn(n) {
  const l = n.querySelector(".blora-progress__fill") ?? n.querySelector(".blora-progress__ring-fill") ?? n.querySelector(".blora-progress__bar") ?? n, t = n.querySelector("[data-progress-label]") ?? n.querySelector(".blora-progress__label"), e = (a) => {
    const i = Math.max(0, Math.min(100, a));
    n.setAttribute("aria-valuenow", String(i)), n.dataset.value = String(i), l.classList.contains("blora-progress__ring-fill") ? l.style.strokeDashoffset = String(100 - i) : l.style.width = `${i}%`, t && (t.textContent = `${Math.round(i)}%`);
  }, r = Number(n.dataset.value || n.getAttribute("aria-valuenow") || 0);
  return Number.isNaN(r) || e(r), {
    setValue: e,
    destroy() {
    }
  };
}
class mn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
  }
  static get observedAttributes() {
    return ["value", "label", "variant", "shape"];
  }
  attributeChangedCallback(t) {
    if (this.isConnectedInternal) {
      if (t === "shape") {
        this.render(), this.rebind();
        return;
      }
      this.sync();
    }
  }
  get value() {
    var t;
    return Number(((t = this.querySelector(".blora-progress")) == null ? void 0 : t.dataset.value) ?? 0);
  }
  set value(t) {
    this.setAttribute("value", String(t));
  }
  setValue(t) {
    this.value = t;
  }
  render() {
    const t = Math.max(0, Math.min(100, Number(this.getAttribute("value") ?? 0))), e = this.ownerDocument.createElement("div");
    e.className = "blora-progress", e.dataset.bloraGenerated = "", e.dataset.value = String(t), e.setAttribute("role", "progressbar"), e.setAttribute("aria-valuemin", "0"), e.setAttribute("aria-valuemax", "100"), e.setAttribute("aria-valuenow", String(t));
    const r = this.getAttribute("shape") ?? "linear";
    if (e.dataset.shape = r, e.setAttribute("aria-label", this.getAttribute("label") ?? v("progress.label")), r === "circular") {
      e.classList.add("blora-progress--circular");
      const b = this.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
      b.setAttribute("class", "blora-progress__ring"), b.setAttribute("viewBox", "0 0 36 36"), b.setAttribute("aria-hidden", "true");
      const d = this.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
      d.setAttribute("class", "blora-progress__ring-track"), d.setAttribute("cx", "18"), d.setAttribute("cy", "18"), d.setAttribute("r", "15.5");
      const m = this.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
      m.setAttribute("class", "blora-progress__ring-fill"), m.setAttribute("cx", "18"), m.setAttribute("cy", "18"), m.setAttribute("r", "15.5"), m.style.strokeDashoffset = String(100 - t);
      const p = this.getAttribute("variant");
      p && (m.dataset.variant = p), b.append(d, m);
      const h = this.ownerDocument.createElement("span");
      h.className = "blora-progress__circular-label", h.dataset.progressLabel = "", h.textContent = `${Math.round(t)}%`, e.append(b, h), this.replaceChildren(e);
      return;
    }
    const a = this.ownerDocument.createElement("div");
    a.className = "blora-progress__label";
    const i = this.ownerDocument.createElement("span");
    i.textContent = this.getAttribute("label") ?? v("progress.label");
    const s = this.ownerDocument.createElement("span");
    s.dataset.progressLabel = "", s.textContent = `${Math.round(t)}%`, a.append(i, s);
    const o = this.ownerDocument.createElement("div");
    o.className = "blora-progress__bar";
    const c = this.ownerDocument.createElement("div");
    c.className = "blora-progress__fill";
    const u = this.getAttribute("variant");
    u && (c.dataset.variant = u), o.appendChild(c), e.append(a, o), this.replaceChildren(e);
  }
  sync() {
    var s;
    const t = this.querySelector(".blora-progress");
    if (!t) return;
    const e = Math.max(0, Math.min(100, Number(this.getAttribute("value") ?? 0)));
    t.setAttribute("aria-label", this.getAttribute("label") ?? v("progress.label"));
    const r = this.getAttribute("variant"), a = t.querySelector(".blora-progress__fill") ?? t.querySelector(".blora-progress__ring-fill");
    a && (r ? a.dataset.variant = r : delete a.dataset.variant);
    const i = t.querySelector(".blora-progress__label span:not([data-progress-label])");
    i && (i.textContent = this.getAttribute("label") ?? v("progress.label")), (s = this.controller) == null || s.setValue(e);
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-progress");
    (e = this.controller) == null || e.destroy(), this.controller = t ? pn(t) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function oi(n = customElements) {
  !n || n.get(Jt) || n.define(Jt, mn);
}
const Zt = "blora-number-input";
class Xe extends B {
  constructor() {
    super(...arguments);
    A(this, "internals", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["name", "value", "min", "max", "step", "label", "disabled"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get value() {
    var t;
    return Number(
      ((t = this.querySelector("input")) == null ? void 0 : t.value) ?? this.getAttribute("value") ?? 0
    );
  }
  set value(t) {
    this.setAttribute("value", String(t));
  }
  focus(t) {
    var e;
    (e = this.querySelector("input")) == null || e.focus(t);
  }
  render() {
    this.internals ?? (this.internals = X(this));
    const t = this.ownerDocument, e = t.createElement("div");
    e.className = "blora-number-input", e.dataset.bloraGenerated = "";
    const r = `blora-number-input-${Math.random().toString(36).slice(2, 9)}`, a = this.getAttribute("label");
    if (a) {
      const b = t.createElement("label");
      b.className = "blora-number-input__label", b.htmlFor = r, b.textContent = a, e.appendChild(b);
    }
    const i = t.createElement("div");
    i.className = "blora-number-input__control";
    const s = t.createElement("input");
    s.id = r, s.className = "blora-input blora-number-input__field", s.type = "number", s.name = this.internals ? "" : this.getAttribute("name") ?? "", s.value = this.getAttribute("value") ?? "0";
    for (const b of ["min", "max", "step"]) {
      const d = this.getAttribute(b);
      d !== null && s.setAttribute(b, d);
    }
    s.disabled = this.hasAttribute("disabled");
    const o = t.createElement("div");
    o.className = "blora-number-input__actions";
    const c = this.makeButton(v("number.decrease"), "minus", -1), u = this.makeButton(v("number.increase"), "plus", 1);
    o.append(c, u), i.append(s, o), e.appendChild(i), this.replaceChildren(e), Y(this.internals, String(this.value));
  }
  makeButton(t, e, r) {
    const a = this.ownerDocument.createElement("button");
    return a.type = "button", a.className = "blora-number-input__button", a.dataset.direction = String(r), a.disabled = this.hasAttribute("disabled"), a.setAttribute("aria-label", t), a.appendChild(I(e, 14, this.ownerDocument)), a;
  }
  sync() {
    const t = this.querySelector("input");
    if (!t) return;
    t.name = this.internals ? "" : this.getAttribute("name") ?? "", document.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value);
    for (const r of ["min", "max", "step"]) {
      const a = this.getAttribute(r);
      a !== null ? t.setAttribute(r, a) : t.removeAttribute(r);
    }
    t.disabled = this.hasAttribute("disabled");
    const e = this.querySelector(".blora-number-input__label");
    e && (e.textContent = this.getAttribute("label") ?? ""), this.querySelectorAll(".blora-number-input__button").forEach((r) => {
      r.disabled = this.hasAttribute("disabled");
    }), Y(this.internals, String(this.value));
  }
  bindEvents() {
    const t = this.querySelector("input");
    t && (this.listen(t, "change", () => this.reflectValue(t)), this.querySelectorAll(".blora-number-input__button").forEach((e) => {
      this.listen(e, "click", () => {
        Number(e.dataset.direction) > 0 ? t.stepUp() : t.stepDown(), this.reflectValue(t);
      });
    }));
  }
  reflectValue(t) {
    this.reflecting = !0, this.setAttribute("value", t.value), this.reflecting = !1, Y(this.internals, t.value), this.dispatchEvent(new Event("change", { bubbles: !0 }));
  }
}
A(Xe, "formAssociated", !0);
function li(n = customElements) {
  !n || n.get(Zt) || n.define(Zt, Xe);
}
const te = "blora-swap";
class fn extends B {
  constructor() {
    super(...arguments);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["name", "checked", "disabled", "on-label", "off-label", "on-icon", "off-icon"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get checked() {
    var t;
    return ((t = this.querySelector("input")) == null ? void 0 : t.checked) ?? !1;
  }
  set checked(t) {
    this.toggleAttribute("checked", t);
  }
  focus(t) {
    var e;
    (e = this.querySelector("input")) == null || e.focus(t);
  }
  render() {
    const t = this.ownerDocument, e = t.createElement("label");
    e.className = "blora-swap", e.dataset.bloraGenerated = "";
    const r = t.createElement("input");
    r.type = "checkbox", r.name = this.getAttribute("name") ?? "", r.checked = this.hasAttribute("checked"), r.disabled = this.hasAttribute("disabled");
    const a = t.createElement("span");
    a.className = "blora-swap__visual", a.setAttribute("aria-hidden", "true");
    const i = this.hasAttribute("checked"), s = this.getAttribute(i ? "on-icon" : "off-icon") ?? (i ? "sun" : "moon");
    a.appendChild(I(s, 18, t));
    const o = t.createElement("span");
    o.className = "blora-swap__label", o.textContent = this.getAttribute(i ? "on-label" : "off-label") ?? (i ? v("swap.on") : v("swap.off")), e.append(r, a, o), this.replaceChildren(e);
  }
  sync() {
    const t = this.querySelector("input");
    if (!t) return;
    t.name = this.getAttribute("name") ?? "", t.checked = this.hasAttribute("checked"), t.disabled = this.hasAttribute("disabled");
    const e = t.checked, r = this.querySelector(".blora-swap__visual");
    r && r.replaceChildren(
      I(
        this.getAttribute(e ? "on-icon" : "off-icon") ?? (e ? "sun" : "moon"),
        18,
        this.ownerDocument
      )
    );
    const a = this.querySelector(".blora-swap__label");
    a && (a.textContent = this.getAttribute(e ? "on-label" : "off-label") ?? (e ? v("swap.on") : v("swap.off")));
  }
  bindEvents() {
    const t = this.querySelector("input");
    t && this.listen(t, "change", () => {
      this.reflecting = !0, this.toggleAttribute("checked", t.checked), this.reflecting = !1, this.sync(), this.dispatchEvent(new Event("change", { bubbles: !0 }));
    });
  }
}
function ci(n = customElements) {
  !n || n.get(te) || n.define(te, fn);
}
const ee = "blora-pagination";
function re(n, l, t = 7) {
  const e = Math.max(1, Math.floor(l)), r = Math.max(1, Math.min(e, Math.floor(n))), a = Math.max(5, Math.floor(t)), i = Array.from({ length: e }, (S, D) => D + 1);
  if (e <= a)
    return {
      windowed: !1,
      items: i,
      inner: i,
      offset: 0,
      windowSize: i.length,
      showStartEllipsis: !1,
      showEndEllipsis: !1
    };
  const s = Math.max(1, a - 2), o = e - 2, c = Math.floor((s - 1) / 2), u = Math.max(2, e - 1 - s + 1);
  let b = Math.min(Math.max(2, r - c), u);
  const d = b + s - 1, m = b > 3, p = d < e - 2;
  if (!m && !p)
    return {
      windowed: !1,
      items: i,
      inner: i,
      offset: 0,
      windowSize: i.length,
      showStartEllipsis: !1,
      showEndEllipsis: !1
    };
  let h = s, y = b - 2;
  m || (h += 1, y = 0, b = 2), p || (h += 1, y = Math.max(0, o - h), b = 2 + y);
  const g = Array.from({ length: h }, (S, D) => b + D).filter(
    (S) => S > 1 && S < e
  ), C = [1];
  return m && C.push("ellipsis"), C.push(...g), p && C.push("ellipsis"), C.push(e), {
    windowed: !0,
    items: C,
    inner: g,
    offset: y,
    windowSize: h,
    showStartEllipsis: m,
    showEndEllipsis: p
  };
}
function gn(n) {
  if (typeof document > "u") return { destroy: () => {
  } };
  const l = () => Array.from(
    n.querySelectorAll(
      ".blora-pagination__item:not(.blora-pagination__nav):not(.blora-pagination__ellipsis)"
    )
  ).filter((a) => a.tagName === "BUTTON"), t = (a) => {
    l().forEach((i) => {
      i.removeAttribute("aria-current");
    }), a.setAttribute("aria-current", "page"), n.dispatchEvent(
      new CustomEvent("blora-change", {
        bubbles: !0,
        detail: { page: Number(a.dataset.page ?? a.textContent) }
      })
    ), e();
  }, e = () => {
    var u, b;
    const a = Number(
      ((u = n.querySelector('[aria-current="page"]')) == null ? void 0 : u.dataset.page) ?? 1
    ), i = Number(n.dataset.total ?? ((b = l().at(-1)) == null ? void 0 : b.dataset.page) ?? 1), s = n.querySelector(
      '.blora-pagination__nav[data-direction="prev"], .blora-pagination__nav:first-of-type'
    ), o = n.querySelectorAll(".blora-pagination__nav"), c = o[o.length - 1];
    s && (s.disabled = a <= 1), c && c !== s && (c.disabled = a >= i);
  }, r = (a) => {
    var m;
    const i = a.target, s = i.closest(
      ".blora-pagination__item:not(.blora-pagination__nav)"
    );
    if (s && n.contains(s) && s.tagName === "BUTTON") {
      t(s);
      return;
    }
    const o = i.closest(".blora-pagination__nav");
    if (!o || !n.contains(o)) return;
    const c = Number(
      ((m = n.querySelector('[aria-current="page"]')) == null ? void 0 : m.dataset.page) ?? 1
    ), u = Number(n.dataset.total ?? 1), d = o.dataset.direction === "prev" || o === n.querySelector(".blora-pagination__nav") ? c - 1 : c + 1;
    d < 1 || d > u || n.dispatchEvent(
      new CustomEvent("blora-change", { bubbles: !0, detail: { page: d } })
    );
  };
  return n.addEventListener("click", r), e(), {
    destroy() {
      n.removeEventListener("click", r);
    }
  };
}
class vn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
  }
  static get observedAttributes() {
    return ["page", "total", "max-visible", "label", "disabled", "variant"];
  }
  layout() {
    return this.getAttribute("variant") === "simple" ? "simple" : "default";
  }
  attributeChangedCallback(t) {
    if (this.isConnectedInternal) {
      if (t === "disabled") {
        this.querySelectorAll("button").forEach((e) => {
          e.disabled = this.hasAttribute("disabled");
        });
        return;
      }
      if ((t === "page" || t === "label") && this.querySelector(".blora-pagination")) {
        this.sync();
        return;
      }
      this.render(), this.rebind();
    }
  }
  get page() {
    const t = this.querySelector("[data-page][aria-current='page']");
    return Number((t == null ? void 0 : t.dataset.page) ?? this.getAttribute("page") ?? 1);
  }
  set page(t) {
    this.setAttribute("page", String(t));
  }
  render() {
    const t = Math.max(1, Number(this.getAttribute("total") ?? 1)), e = Math.max(1, Math.min(t, Number(this.getAttribute("page") ?? 1))), r = re(e, t, Number(this.getAttribute("max-visible") ?? 7)), a = this.ownerDocument.createElement("nav");
    if (a.className = "blora-pagination", a.dataset.bloraGenerated = "", a.dataset.total = String(t), a.dataset.variant = this.layout(), a.setAttribute("aria-label", this.getAttribute("label") ?? v("pagination.nav")), this.layout() === "simple") {
      a.append(
        this.createNav("prev", "chevron-left"),
        this.createStatus(e),
        this.createNav("next", "chevron-right")
      ), this.replaceChildren(a), this.applyWindow(a, r, e, t);
      return;
    }
    if (a.appendChild(this.createNav("prev", "chevron-left")), r.windowed) {
      a.appendChild(this.createPageButton(1, e)), a.appendChild(this.createEllipsis("start"));
      const i = this.ownerDocument.createElement("div");
      i.className = "blora-pagination__window";
      const s = this.ownerDocument.createElement("div");
      s.className = "blora-pagination__track";
      for (let o = 2; o <= t - 1; o += 1)
        s.appendChild(this.createPageButton(o, e));
      i.appendChild(s), a.appendChild(i), a.appendChild(this.createEllipsis("end")), a.appendChild(this.createPageButton(t, e));
    } else
      for (const i of r.items)
        i !== "ellipsis" && a.appendChild(this.createPageButton(i, e));
    a.appendChild(this.createNav("next", "chevron-right")), this.replaceChildren(a), this.applyWindow(a, r, e, t), requestAnimationFrame(() => a.classList.add("is-animated"));
  }
  sync() {
    const t = this.querySelector(".blora-pagination");
    if (!t) return;
    const e = Math.max(1, Number(this.getAttribute("total") ?? 1)), r = Math.max(1, Math.min(e, Number(this.getAttribute("page") ?? 1))), a = re(r, e, Number(this.getAttribute("max-visible") ?? 7));
    if (this.layout() === "simple" != !!t.querySelector(".blora-pagination__status")) {
      this.render(), this.rebind();
      return;
    }
    if (this.layout() === "simple") {
      this.applyWindow(t, a, r, e);
      return;
    }
    if (a.windowed !== !!t.querySelector(".blora-pagination__track")) {
      this.render(), this.rebind();
      return;
    }
    this.applyWindow(t, a, r, e);
  }
  bindEvents() {
    const t = this.querySelector(".blora-pagination");
    t && (this.controller = gn(t), this.listen(t, "blora-change", (e) => {
      const r = e.detail.page;
      this.setAttribute("page", String(r));
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
  applyWindow(t, e, r, a) {
    var c, u;
    t.dataset.total = String(a), t.dataset.variant = this.layout(), t.setAttribute("aria-label", this.getAttribute("label") ?? v("pagination.nav"));
    const i = t.querySelector(".blora-pagination__status");
    i && (i.dataset.page = String(r), i.textContent = v("pagination.page", { n: r })), t.style.setProperty("--blora-pagination-window", String(e.windowSize)), t.style.setProperty("--blora-pagination-offset", String(e.offset)), (c = t.querySelector('[data-edge="start"]')) == null || c.toggleAttribute("data-inactive", !e.showStartEllipsis), (u = t.querySelector('[data-edge="end"]')) == null || u.toggleAttribute("data-inactive", !e.showEndEllipsis), t.querySelectorAll("button[data-page]").forEach((b) => {
      const d = Number(b.dataset.page), m = !e.windowed || d === 1 || d === a || e.inner.includes(d);
      d === r ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"), b.tabIndex = m ? 0 : -1, m ? b.removeAttribute("aria-hidden") : b.setAttribute("aria-hidden", "true");
    });
    const s = t.querySelector(
      '.blora-pagination__nav[data-direction="prev"]'
    ), o = t.querySelector(
      '.blora-pagination__nav[data-direction="next"]'
    );
    s && (s.disabled = this.hasAttribute("disabled") || r <= 1), o && (o.disabled = this.hasAttribute("disabled") || r >= a);
  }
  createStatus(t) {
    const e = this.ownerDocument.createElement("span");
    return e.className = "blora-pagination__status", e.dataset.page = String(t), e.setAttribute("aria-current", "page"), e.textContent = v("pagination.page", { n: t }), e;
  }
  createPageButton(t, e) {
    const r = this.ownerDocument.createElement("button");
    return r.type = "button", r.className = "blora-pagination__item", r.textContent = String(t), r.dataset.page = String(t), r.setAttribute("aria-label", v("pagination.page", { n: t })), r.disabled = this.hasAttribute("disabled"), t === e && r.setAttribute("aria-current", "page"), r;
  }
  createEllipsis(t) {
    const e = this.ownerDocument.createElement("span");
    return e.className = "blora-pagination__ellipsis", e.dataset.edge = t, e.setAttribute("aria-hidden", "true"), e.textContent = "…", e;
  }
  createNav(t, e) {
    const r = this.ownerDocument.createElement("button");
    return r.type = "button", r.className = "blora-pagination__item blora-pagination__nav", r.dataset.direction = t, r.setAttribute(
      "aria-label",
      t === "prev" ? v("pagination.prev") : v("pagination.next")
    ), r.disabled = this.hasAttribute("disabled"), r.appendChild(I(e, 18, this.ownerDocument)), r;
  }
}
function ui(n = customElements) {
  !n || n.get(ee) || n.define(ee, vn);
}
const ne = "blora-color-picker", ae = (n, l, t) => Math.max(l, Math.min(t, n)), et = (n) => {
  let l = String(n || "").trim();
  return l && !l.startsWith("#") && (l = "#" + l), /^#[0-9a-f]{3}$/i.test(l) && (l = "#" + l.slice(1).split("").map((t) => t + t).join("")), /^#[0-9a-f]{6}$/i.test(l) ? l.toUpperCase() : null;
}, ie = (n) => {
  const l = et(n) || "#000000", t = parseInt(l.slice(1, 3), 16) / 255, e = parseInt(l.slice(3, 5), 16) / 255, r = parseInt(l.slice(5, 7), 16) / 255, a = Math.max(t, e, r), i = Math.min(t, e, r), s = a - i;
  let o = 0;
  return s && (a === t ? o = 60 * ((e - r) / s % 6) : a === e ? o = 60 * ((r - t) / s + 2) : o = 60 * ((t - e) / s + 4)), o < 0 && (o += 360), { h: o, s: a ? s / a : 0, v: a };
}, An = ({ h: n, s: l, v: t }) => {
  const e = t * l, r = e * (1 - Math.abs(n / 60 % 2 - 1)), a = t - e;
  return "#" + (n < 60 ? [e, r, 0] : n < 120 ? [r, e, 0] : n < 180 ? [0, e, r] : n < 240 ? [0, r, e] : n < 300 ? [r, 0, e] : [e, 0, r]).map(
    (s) => Math.round((s + a) * 255).toString(16).padStart(2, "0")
  ).join("").toUpperCase();
};
function yn(n) {
  const l = n.querySelector(".blora-color-swatch");
  let t = n.querySelector(".blora-color-panel");
  if (!l) return { destroy: () => {
  } };
  t || (t = document.createElement("div"), t.className = "blora-color-panel", n.appendChild(t));
  let e = t.querySelector(".blora-color-spectrum");
  if (!e) {
    e = document.createElement("div"), e.className = "blora-color-spectrum", e.tabIndex = 0, e.setAttribute("role", "slider"), e.setAttribute("aria-label", v("color.spectrum"));
    const E = document.createElement("span");
    E.className = "blora-color-spectrum__cursor", E.setAttribute("aria-hidden", "true"), e.appendChild(E), t.insertBefore(e, t.firstChild);
  }
  const r = e.querySelector(".blora-color-spectrum__cursor");
  let a = t.querySelector(".blora-color-hue");
  a || (a = document.createElement("input"), a.className = "blora-color-hue", a.type = "range", a.min = "0", a.max = "359", a.step = "1", a.setAttribute("aria-label", v("color.hue")), e.insertAdjacentElement("afterend", a));
  let i = t.querySelector(".blora-color-hex");
  if (!i) {
    const E = document.createElement("div");
    E.className = "blora-color-custom";
    const L = document.createElement("span");
    L.className = "blora-color-preview", i = document.createElement("input"), i.className = "blora-input blora-color-hex", i.type = "text", i.placeholder = "#RRGGBB", E.append(L, i), t.appendChild(E);
  }
  const s = t.querySelector(".blora-color-preview");
  let o = et(l.dataset.color || "") || et(
    getComputedStyle(document.documentElement).getPropertyValue(
      "--blora-color-action-primary-default"
    )
  ) || "#3B82F6", c = ie(o);
  const u = "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)", b = () => {
    const E = Math.round(c.h);
    e.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${E} 100% 50%)`, a.style.background = u;
  }, d = (E = !1) => {
    o = An(c), l.style.background = o, l.dataset.color = o, l.setAttribute("aria-label", v("color.swatch", { color: o })), b(), a.value = String(Math.round(c.h)), r.style.left = c.s * 100 + "%", r.style.top = (1 - c.v) * 100 + "%", s && (s.style.background = o), i && document.activeElement !== i && (i.value = o), E && n.dispatchEvent(
      new CustomEvent("blora:change", {
        bubbles: !0,
        detail: { value: o, hsv: { ...c } }
      })
    );
  }, m = (E, L, T = !0) => {
    const f = e.getBoundingClientRect();
    c.s = ae((E - f.left) / f.width, 0, 1), c.v = 1 - ae((L - f.top) / f.height, 0, 1), d(T);
  }, p = (E) => {
    E.preventDefault(), e.focus(), e.setPointerCapture(E.pointerId), m(E.clientX, E.clientY);
  }, h = (E) => {
    e.hasPointerCapture(E.pointerId) && m(E.clientX, E.clientY);
  }, y = () => {
    c.h = Number(a.value), d(!0);
  }, g = () => {
    const E = et(i.value);
    i.setAttribute("aria-invalid", String(!E)), E && (c = ie(E), d(!0));
  }, C = () => {
    t.removeAttribute("data-align-end"), t.setAttribute("data-open", ""), l.setAttribute("aria-expanded", "true"), t.getBoundingClientRect().right > window.innerWidth - 8 && t.setAttribute("data-align-end", ""), d();
  }, S = () => {
    t.removeAttribute("data-open"), l.setAttribute("aria-expanded", "false");
  }, D = (E) => {
    E.stopPropagation(), t.hasAttribute("data-open") ? S() : C();
  }, w = (E) => {
    n.contains(E.target) || S();
  }, _ = (E) => {
    E.key === "Escape" && S();
  };
  return l.setAttribute("role", "button"), l.tabIndex = 0, l.setAttribute("aria-haspopup", "dialog"), l.setAttribute("aria-expanded", "false"), e.addEventListener("pointerdown", p), e.addEventListener("pointermove", h), a.addEventListener("input", y), i.addEventListener("input", g), l.addEventListener("click", D), document.addEventListener("click", w), document.addEventListener("keydown", _), d(), {
    destroy() {
      e.removeEventListener("pointerdown", p), e.removeEventListener("pointermove", h), a.removeEventListener("input", y), i.removeEventListener("input", g), l.removeEventListener("click", D), document.removeEventListener("click", w), document.removeEventListener("keydown", _);
    }
  };
}
class _n extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["value", "label", "disabled"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get value() {
    var t;
    return ((t = this.querySelector(".blora-color-swatch")) == null ? void 0 : t.dataset.color) ?? "";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  open() {
    var t;
    this.hasAttribute("disabled") || (t = this.querySelector(".blora-color-swatch")) == null || t.click();
  }
  close() {
    const t = this.querySelector(".blora-color-panel"), e = this.querySelector(".blora-color-swatch");
    t == null || t.removeAttribute("data-open"), e == null || e.setAttribute("aria-expanded", "false");
  }
  render() {
    const t = et(this.getAttribute("value") ?? "") ?? "#3B82F6", e = this.ownerDocument.createElement("div");
    e.className = "blora-color-picker", e.dataset.bloraGenerated = "";
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-color-swatch", r.dataset.color = t, r.style.background = t, r.setAttribute(
      "aria-label",
      this.getAttribute("label") ?? v("color.swatch", { color: t })
    ), this.hasAttribute("disabled") && r.setAttribute("aria-disabled", "true");
    const a = this.ownerDocument.createElement("div");
    a.className = "blora-color-panel", a.setAttribute("role", "dialog");
    const i = this.ownerDocument.createElement("div");
    i.className = "blora-color-spectrum", i.tabIndex = 0, i.setAttribute("role", "slider"), i.setAttribute("aria-label", v("color.spectrum"));
    const s = this.ownerDocument.createElement("span");
    s.className = "blora-color-spectrum__cursor", s.setAttribute("aria-hidden", "true"), i.appendChild(s);
    const o = this.ownerDocument.createElement("input");
    o.className = "blora-color-hue", o.type = "range", o.min = "0", o.max = "359", o.step = "1", o.setAttribute("aria-label", v("color.hue"));
    const c = this.ownerDocument.createElement("div");
    c.className = "blora-color-custom";
    const u = this.ownerDocument.createElement("span");
    u.className = "blora-color-preview", u.style.background = t;
    const b = this.ownerDocument.createElement("input");
    b.className = "blora-input blora-color-hex", b.type = "text", b.value = t, b.placeholder = "#RRGGBB", c.append(u, b), a.append(i, o, c), e.append(r, a), this.replaceChildren(e);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-color-picker");
    !t || this.hasAttribute("disabled") || (this.controller = yn(t), this.listen(t, "blora:change", (e) => {
      const r = e.detail.value;
      this.reflecting = !0, this.setAttribute("value", r), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function di(n = customElements) {
  !n || n.get(ne) || n.define(ne, _n);
}
const se = "blora-autocomplete";
function En(n) {
  const l = n.ownerDocument, t = n.querySelector("input");
  if (!t) return { destroy: () => {
  } };
  const e = n.dataset.options ?? "[]";
  let r = [];
  try {
    r = JSON.parse(e);
  } catch {
    r = [];
  }
  let a = n.querySelector(".blora-autocomplete__menu");
  a || (a = l.createElement("div"), a.className = "blora-autocomplete__menu", n.appendChild(a));
  const i = a;
  let s = -1;
  const o = (p) => {
    const h = p ? r.filter((y) => y.toLowerCase().includes(p.toLowerCase())) : r;
    if (h.length === 0 || !p) {
      i.removeAttribute("data-open"), i.replaceChildren();
      return;
    }
    i.setAttribute("data-open", ""), i.replaceChildren(
      ...h.map((y, g) => {
        const C = l.createElement("div");
        return C.className = "blora-autocomplete__option", C.dataset.idx = String(g), C.setAttribute("role", "option"), C.textContent = y, C;
      })
    ), s = -1;
  }, c = (p) => {
    t.value = p, i.removeAttribute("data-open"), i.replaceChildren(), n.dispatchEvent(
      new CustomEvent("blora-autocomplete-change", {
        bubbles: !0,
        detail: { value: p }
      })
    );
  }, u = () => o(t.value), b = (p) => {
    if (!i.hasAttribute("data-open")) return;
    const h = Array.from(i.querySelectorAll(".blora-autocomplete__option"));
    if (p.key === "ArrowDown")
      p.preventDefault(), s = Math.min(s + 1, h.length - 1), h.forEach((y, g) => y.toggleAttribute("data-active", g === s));
    else if (p.key === "ArrowUp")
      p.preventDefault(), s = Math.max(s - 1, 0), h.forEach((y, g) => y.toggleAttribute("data-active", g === s));
    else if (p.key === "Enter") {
      p.preventDefault();
      const y = h[s];
      y && c(y.textContent ?? "");
    } else p.key === "Escape" && i.removeAttribute("data-open");
  }, d = (p) => {
    const h = p.target.closest(".blora-autocomplete__option");
    h && c(h.textContent ?? "");
  }, m = (p) => {
    n.contains(p.target) || i.removeAttribute("data-open");
  };
  return t.addEventListener("input", u), t.addEventListener("keydown", b), a.addEventListener("click", d), l.addEventListener("click", m), {
    destroy() {
      t.removeEventListener("input", u), t.removeEventListener("keydown", b), i.removeEventListener("click", d), l.removeEventListener("click", m);
    }
  };
}
class Cn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["options", "label", "placeholder", "value", "disabled"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get value() {
    var t;
    return ((t = this.querySelector("input")) == null ? void 0 : t.value) ?? this.getAttribute("value") ?? "";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((c) => c.localName === "blora-autocomplete-option").map((c) => {
      var u, b;
      return {
        disabled: c.hasAttribute("disabled"),
        label: c.getAttribute("label") ?? ((u = c.textContent) == null ? void 0 : u.trim()) ?? "",
        value: c.getAttribute("value") ?? ((b = c.textContent) == null ? void 0 : b.trim()) ?? ""
      };
    }).filter((c) => c.value && !c.disabled));
    const t = this.getAttribute("options") ?? this.getAttribute("data-options");
    let e = this.definitions.map((c) => c.label || c.value);
    if (t)
      try {
        const c = JSON.parse(t);
        Array.isArray(c) && (e = c.map(String));
      } catch {
        e = [];
      }
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-autocomplete", r.dataset.bloraGenerated = "", r.dataset.options = JSON.stringify(e);
    const a = this.getAttribute("label");
    if (a) {
      const c = this.ownerDocument.createElement("label");
      c.className = "blora-label", c.textContent = a, r.appendChild(c);
    }
    const i = this.ownerDocument.createElement("div");
    i.className = "blora-autocomplete__control";
    const s = this.ownerDocument.createElement("input");
    s.className = "blora-input", s.type = "search", s.autocomplete = "off", s.placeholder = this.getAttribute("placeholder") ?? "", s.value = this.getAttribute("value") ?? "", s.disabled = this.hasAttribute("disabled"), s.setAttribute("role", "combobox"), s.setAttribute("aria-autocomplete", "list");
    const o = this.ownerDocument.createElement("div");
    o.className = "blora-autocomplete__menu", o.setAttribute("role", "listbox"), i.append(s, o), r.appendChild(i), this.replaceChildren(r);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-autocomplete");
    !t || this.hasAttribute("disabled") || (this.controller = En(t), this.listen(t, "blora-autocomplete-change", (e) => {
      const r = e.detail.value;
      this.reflecting = !0, this.setAttribute("value", r), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function bi(n = customElements) {
  !n || n.get(se) || n.define(se, Cn);
}
const oe = "blora-mentions", wn = [
  { value: "alice", label: "alice" },
  { value: "bob", label: "bob" },
  { value: "carol", label: "carol" },
  { value: "dave", label: "dave" }
], Q = "data-blora-mentions-owner";
let xn = 0;
function je(n) {
  try {
    const l = JSON.parse(n);
    return Array.isArray(l) ? l.map((t) => {
      if (typeof t == "string")
        return { value: t, label: t };
      if (t && typeof t == "object") {
        const e = t, r = String(e.value ?? e.name ?? e.id ?? e.label ?? "").trim();
        if (!r) return null;
        const a = {
          value: r,
          label: String(e.label ?? e.name ?? r)
        };
        return e.initials != null && (a.initials = String(e.initials)), e.avatar != null && (a.avatar = String(e.avatar)), (e.avatarVariant === "primary" || e.avatarVariant === "neutral" || e.avatarVariant === "info" || e.avatarVariant === "success" || e.avatarVariant === "contrast") && (a.avatarVariant = e.avatarVariant), e.tag != null ? a.tag = String(e.tag) : e.description != null && (a.tag = String(e.description)), e.keywords != null && (a.keywords = String(e.keywords)), a;
      }
      return null;
    }).filter((t) => !!t) : [];
  } catch {
    return [];
  }
}
function kn(n) {
  return [n.value, n.label, n.tag, n.keywords, n.initials].filter(Boolean).join(" ");
}
function Sn(n) {
  if (n.initials) return n.initials.slice(0, 2);
  const l = (n.label || n.value).trim();
  return l ? /^[\w.-]+$/.test(l) ? l.slice(0, 2).toUpperCase() : l.slice(0, 2) : "?";
}
function Nn(n, l) {
  n.querySelectorAll(`.blora-mentions__menu[${Q}]`).forEach((t) => {
    const e = t.getAttribute(Q);
    if (l && e === l) return;
    e && n.querySelector(`[data-blora-mentions-id="${CSS.escape(e)}"]`) || t.remove();
  });
}
function Dn(n) {
  const l = n.querySelector("textarea, input");
  if (!l) return { destroy: () => {
  } };
  const t = n.ownerDocument, e = n.getAttribute("data-options") || n.dataset.options || l.getAttribute("data-options") || "[]";
  let r = je(e);
  r.length === 0 && (r = wn.map((f) => ({ ...f })));
  let a = n.getAttribute("data-blora-mentions-id");
  a || (a = `mn-${++xn}-${Date.now().toString(36)}`, n.setAttribute("data-blora-mentions-id", a)), n.setAttribute(Q, a);
  const i = n.__bloraMentionsDestroy;
  if (typeof i == "function")
    try {
      i();
    } catch {
    }
  t.querySelectorAll(`.blora-mentions__menu[${Q}="${a}"]`).forEach((f) => f.remove()), Nn(t, a);
  let s = n.querySelector(".blora-mentions__menu") || t.querySelector(`.blora-mentions__menu[${Q}="${a}"]`);
  s || (s = t.createElement("ul"), s.className = "blora-mentions__menu", s.setAttribute("role", "listbox"));
  const o = s;
  o.setAttribute(Q, a), o.setAttribute("aria-hidden", "true"), o.style.position = "fixed", o.style.left = "-9999px", o.style.top = "-9999px", o.removeAttribute("data-open"), o.parentElement !== t.body && t.body.appendChild(o);
  let c = 0, u = -1, b = !1;
  const d = (f) => {
    b || (f ? (n.setAttribute("data-open", ""), o.setAttribute("aria-hidden", "false")) : (n.removeAttribute("data-open"), o.removeAttribute("data-open"), o.setAttribute("aria-hidden", "true"), o.removeAttribute("data-placement"), o.style.left = "-9999px", o.style.top = "-9999px", o.style.maxHeight = "", o.style.minWidth = "", o.style.visibility = ""));
  }, m = () => {
    const f = l.getBoundingClientRect(), x = getComputedStyle(l), k = Number.parseFloat(x.fontSize) || 14, N = (() => {
      const j = x.lineHeight;
      if (!j || j === "normal") return k * 1.4;
      const J = Number.parseFloat(j);
      return Number.isFinite(J) ? J : k * 1.4;
    })(), q = Number.parseFloat(x.paddingLeft) || 0, M = Number.parseFloat(x.paddingTop) || 0, P = Number.parseFloat(x.borderLeftWidth) || 0, O = Number.parseFloat(x.borderTopWidth) || 0;
    if (u < 0)
      return {
        x: f.left + q + P,
        y: f.top + M + O,
        lineH: N
      };
    const R = t.createElement("div");
    R.setAttribute("aria-hidden", "true");
    const G = R.style;
    G.position = "fixed", G.left = `${f.left}px`, G.top = `${f.top}px`, G.visibility = "hidden", G.pointerEvents = "none", G.zIndex = "-1", G.whiteSpace = "pre-wrap", G.wordWrap = "break-word", G.overflowWrap = "break-word", G.overflow = "hidden", G.boxSizing = "border-box", G.width = `${l.clientWidth}px`, G.height = `${l.clientHeight}px`, G.font = x.font, G.fontSize = x.fontSize, G.fontFamily = x.fontFamily, G.fontWeight = x.fontWeight, G.letterSpacing = x.letterSpacing, G.lineHeight = x.lineHeight, G.padding = x.padding, G.borderStyle = x.borderStyle, G.borderWidth = x.borderWidth, G.borderColor = "transparent", G.textAlign = x.textAlign, G.direction = x.direction;
    const U = l.value.slice(0, Math.max(0, u)), W = t.createTextNode(U), $ = t.createElement("span");
    $.textContent = "​", R.appendChild(W), R.appendChild($), t.body.appendChild(R), R.scrollTop = l.scrollTop, R.scrollLeft = l.scrollLeft;
    const H = $.getBoundingClientRect();
    t.body.removeChild(R);
    let V = H.left, K = H.top;
    return (!Number.isFinite(V) || V < f.left - 2 || V > f.right + 2) && (V = f.left + q + P), (!Number.isFinite(K) || K < f.top - 2 || K > f.bottom + 2) && (K = f.top + M + O), { x: V, y: K, lineH: N };
  }, p = () => {
    if (b || !t.contains(n)) {
      d(!1);
      return;
    }
    const f = 6, x = 8, { x: k, y: N, lineH: q } = m();
    o.style.position = "fixed", o.style.right = "auto", o.style.bottom = "auto", o.style.margin = "0", o.style.zIndex = "var(--blora-z-dropdown)", o.style.visibility = "hidden", o.setAttribute("data-open", "");
    const M = Math.min(Math.max(o.offsetWidth || 160, 160), window.innerWidth - x * 2), P = o.offsetHeight || 120, O = Math.min(P, window.innerHeight * 0.4, 240), R = window.innerHeight - (N + q) - x, G = N - x, U = Math.min(O, 100), W = R >= U || R >= G;
    let $ = W ? N + q + f : N - f - O;
    $ < x && ($ = x), $ + O > window.innerHeight - x && ($ = Math.max(x, window.innerHeight - x - O));
    let H = k;
    H + M > window.innerWidth - x && (H = window.innerWidth - x - M), H < x && (H = x), o.dataset.placement = W ? "below" : "above", o.style.left = `${Math.round(H)}px`, o.style.top = `${Math.round($)}px`;
    const V = o.classList.contains("blora-mentions__menu--rich");
    o.style.minWidth = V ? "16rem" : "10rem", o.style.width = "max-content", o.style.maxWidth = V ? `${Math.min(384, window.innerWidth - x * 2)}px` : `${Math.min(320, window.innerWidth - x * 2)}px`, o.style.maxHeight = `${Math.round(
      Math.max(80, W ? Math.min(O, R) : Math.min(O, G))
    )}px`, o.style.visibility = "visible";
  }, h = (f, x) => {
    const k = t.createElement("li");
    k.className = "blora-mentions__option", x && k.setAttribute("data-active", ""), k.setAttribute("role", "option"), k.dataset.name = f.value;
    const N = t.createElement("span");
    if (N.className = "blora-avatar", N.setAttribute("data-size", "sm"), N.setAttribute("data-variant", f.avatarVariant || "info"), N.setAttribute("aria-hidden", "true"), f.avatar) {
      const P = t.createElement("img");
      P.src = f.avatar, P.alt = "", N.appendChild(P);
    } else
      N.textContent = Sn(f);
    const q = t.createElement("span");
    q.className = "blora-mentions__meta";
    const M = t.createElement("span");
    if (M.className = "blora-mentions__name", M.textContent = f.label || f.value, q.appendChild(M), k.append(N, q), f.tag) {
      const P = t.createElement("span");
      P.className = "blora-tag blora-mentions__tag", P.setAttribute("data-variant", "neutral"), P.textContent = f.tag, k.append(P);
    }
    return k;
  }, y = (f) => {
    if (b) return;
    const x = f.toLowerCase(), k = r.filter((q) => !x || kn(q).toLowerCase().includes(x)).slice(0, 8);
    if (k.length === 0) {
      d(!1), o.replaceChildren();
      return;
    }
    c = Math.min(c, k.length - 1);
    const N = k.some((q) => q.avatar || q.initials || q.tag || q.label !== q.value);
    o.classList.toggle("blora-mentions__menu--rich", N), o.replaceChildren(...k.map((q, M) => h(q, M === c))), d(!0), requestAnimationFrame(() => {
      p(), requestAnimationFrame(() => p());
    });
  }, g = (f) => {
    const x = l.selectionStart ?? l.value.length, k = l.value.substring(0, u), N = l.value.substring(x);
    l.value = `${k}@${f} ${N}`;
    const q = k.length + f.length + 2;
    l.setSelectionRange(q, q), l.focus(), d(!1), l.dispatchEvent(new Event("input", { bubbles: !0 }));
  }, C = () => {
    if (b || !t.contains(n)) {
      d(!1);
      return;
    }
    const f = l.selectionStart ?? 0, k = l.value.substring(0, f).match(/@([\w\u4e00-\u9fa5.-]*)$/);
    if (!k) {
      u = -1, d(!1);
      return;
    }
    u = f - k[0].length;
    const N = k[1] || "";
    c = 0, y(N);
  }, S = () => C(), D = (f) => {
    var N;
    const x = f;
    if (!n.hasAttribute("data-open")) return;
    const k = o.querySelectorAll(".blora-mentions__option");
    if (k.length)
      if (x.key === "ArrowDown")
        x.preventDefault(), c = (c + 1) % k.length, k.forEach((q, M) => q.toggleAttribute("data-active", M === c));
      else if (x.key === "ArrowUp")
        x.preventDefault(), c = (c - 1 + k.length) % k.length, k.forEach((q, M) => q.toggleAttribute("data-active", M === c));
      else if (x.key === "Enter" || x.key === "Tab") {
        x.preventDefault();
        const q = (N = k[c]) == null ? void 0 : N.dataset.name;
        q && g(q);
      } else x.key === "Escape" && (x.preventDefault(), d(!1));
  }, w = (f) => {
    const x = f.target.closest(".blora-mentions__option");
    x != null && x.dataset.name && g(x.dataset.name);
  }, _ = () => {
    n.hasAttribute("data-open") && p();
  }, E = (f) => {
    const x = f;
    (x.key === "ArrowLeft" || x.key === "ArrowRight" || x.key === "Home" || x.key === "End") && C();
  }, L = () => {
    b || (b = !0, l.removeEventListener("input", S), l.removeEventListener("keydown", D), l.removeEventListener("click", C), l.removeEventListener("keyup", E), o.removeEventListener("click", w), window.removeEventListener("scroll", _, !0), window.removeEventListener("resize", _), n.removeAttribute("data-open"), o.remove(), n.__bloraMentionsDestroy === L && delete n.__bloraMentionsDestroy, T.disconnect());
  }, T = new MutationObserver(() => {
    t.contains(n) || L();
  });
  return T.observe(t.body, { childList: !0, subtree: !0 }), l.addEventListener("input", S), l.addEventListener("keydown", D), l.addEventListener("click", C), l.addEventListener("keyup", E), o.addEventListener("click", w), window.addEventListener("scroll", _, !0), window.addEventListener("resize", _), n.__bloraMentionsDestroy = L, { destroy: L };
}
class Ln extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "options", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["options", "label", "placeholder", "rows", "value", "disabled"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get value() {
    var t;
    return ((t = this.querySelector("textarea")) == null ? void 0 : t.value) ?? this.getAttribute("value") ?? "";
  }
  set value(t) {
    const e = this.querySelector("textarea");
    e && (e.value = t), this.reflecting = !0, this.setAttribute("value", t), this.reflecting = !1;
  }
  focus() {
    var t;
    (t = this.querySelector("textarea")) == null || t.focus();
  }
  render() {
    this.options || (this.options = Array.from(this.children).filter((s) => s.localName === "blora-mention").map((s) => {
      var h, y;
      const o = s.getAttribute("value") ?? ((h = s.textContent) == null ? void 0 : h.trim()) ?? "", c = {
        value: o,
        label: s.getAttribute("label") ?? ((y = s.textContent) == null ? void 0 : y.trim()) ?? o
      }, u = s.getAttribute("initials"), b = s.getAttribute("avatar"), d = s.getAttribute(
        "avatar-variant"
      ), m = s.getAttribute("tag"), p = s.getAttribute("keywords");
      return u !== null && (c.initials = u), b !== null && (c.avatar = b), d && (c.avatarVariant = d), m !== null && (c.tag = m), p !== null && (c.keywords = p), c;
    }).filter((s) => s.value));
    const t = this.getAttribute("options") ?? this.getAttribute("data-options");
    let e = this.options;
    if (t) {
      const s = je(t);
      e = s.length ? s : [];
    }
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-mentions", r.dataset.bloraGenerated = "", r.dataset.options = JSON.stringify(e);
    const a = this.getAttribute("label");
    if (a) {
      const s = this.ownerDocument.createElement("label");
      s.className = "blora-label", s.textContent = a, r.appendChild(s);
    }
    const i = this.ownerDocument.createElement("textarea");
    i.className = "blora-textarea", i.rows = Math.max(1, Number(this.getAttribute("rows") ?? 4) || 4), i.placeholder = this.getAttribute("placeholder") ?? "", i.value = this.getAttribute("value") ?? "", i.disabled = this.hasAttribute("disabled"), r.appendChild(i), this.replaceChildren(r);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-mentions"), e = t == null ? void 0 : t.querySelector("textarea");
    !t || !e || this.hasAttribute("disabled") || (this.controller = Dn(t), this.listen(e, "input", () => {
      this.reflecting = !0, this.setAttribute("value", e.value), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function hi(n = customElements) {
  !n || n.get(oe) || n.define(oe, Ln);
}
const le = "blora-cascader";
function qn(n) {
  const l = n.ownerDocument, t = n.dataset.options ?? n.dataset.bloraCascader ?? "[]";
  let e = [];
  try {
    e = JSON.parse(t);
  } catch {
    e = [];
  }
  let r = n.querySelector(".blora-cascader__trigger"), a = n.querySelector(".blora-cascader__panel");
  const i = n.querySelector(".blora-cascader__result");
  r || (r = l.createElement("button"), r.className = "blora-cascader__trigger blora-input", r.type = "button", r.textContent = v("cascader.placeholder"), n.prepend(r)), a || (a = l.createElement("div"), a.className = "blora-cascader__panel", n.appendChild(a));
  const s = [], o = (y) => {
    a.replaceChildren(
      ...y.map((g, C) => {
        const S = l.createElement("div");
        return S.className = "blora-cascader__column", g.forEach((D) => {
          const w = s[C] === D.label, _ = D.children && D.children.length > 0, E = l.createElement("div");
          if (E.className = "blora-cascader__option", w && E.classList.add("blora-cascader__option--active"), E.dataset.col = String(C), E.dataset.label = D.label, E.textContent = D.label, _) {
            const L = l.createElement("span");
            L.className = "blora-cascader__arrow", L.appendChild(I("chevron-right", 14, l)), E.appendChild(L);
          }
          S.appendChild(E);
        }), S;
      })
    );
  }, c = () => {
    r.textContent = s.length ? s.join(" / ") : v("cascader.placeholder"), i && (i.textContent = `${v("cascader.selectedPrefix")}${s.join(" / ")}`);
  }, u = () => {
    a.setAttribute("data-open", ""), s.length = 0, o([e]), c();
  }, b = () => {
    a.removeAttribute("data-open");
  }, d = () => a.hasAttribute("data-open"), m = (y) => {
    y.stopPropagation(), d() ? b() : u();
  }, p = (y) => {
    y.stopPropagation();
    const g = y.target.closest(".blora-cascader__option");
    if (!g) return;
    const C = Number(g.dataset.col), S = g.dataset.label;
    s[C] = S, s.length = C + 1;
    let D = e;
    for (let w = 0; w <= C; w++) {
      const _ = D.find((E) => E.label === s[w]);
      if (!_) return;
      if (w === C) {
        if (_.children && _.children.length > 0) {
          const E = [];
          let L = e;
          for (let T = 0; T <= C; T++) {
            const f = L.find((x) => x.label === s[T]);
            if (!f) break;
            E.push(L), L = f.children ?? [];
          }
          E.push(_.children), o(E);
        } else
          c(), b(), n.dispatchEvent(
            new CustomEvent("blora-cascader-change", {
              bubbles: !0,
              detail: { value: s.join(" / "), path: [...s] }
            })
          );
        return;
      }
      D = _.children ?? [];
    }
  }, h = () => b();
  return r.addEventListener("click", m), a.addEventListener("click", p), l.addEventListener("click", h), {
    destroy() {
      r.removeEventListener("click", m), a.removeEventListener("click", p), l.removeEventListener("click", h);
    }
  };
}
function Qe(n) {
  return n.filter((l) => l.localName === "blora-cascader-option").map((l) => {
    var t;
    return {
      label: l.getAttribute("label") ?? ((t = l.textContent) == null ? void 0 : t.trim()) ?? "",
      children: Qe(Array.from(l.children))
    };
  }).filter((l) => l.label).map((l) => {
    var t;
    return (t = l.children) != null && t.length ? l : { label: l.label };
  });
}
class Tn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "options", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["options", "placeholder", "value", "disabled", "show-result"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get value() {
    return this.getAttribute("value") ?? "";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  open() {
    var t;
    this.hasAttribute("disabled") || (t = this.querySelector(".blora-cascader__trigger")) == null || t.click();
  }
  close() {
    var t;
    (t = this.querySelector(".blora-cascader__panel")) == null || t.removeAttribute("data-open");
  }
  render() {
    this.options || (this.options = Qe(Array.from(this.children)));
    const t = this.getAttribute("options") ?? this.getAttribute("data-options");
    let e = this.options;
    if (t)
      try {
        const s = JSON.parse(t);
        e = Array.isArray(s) ? s : [];
      } catch {
        e = [];
      }
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-cascader", r.dataset.bloraGenerated = "", r.dataset.options = JSON.stringify(e);
    const a = this.ownerDocument.createElement("button");
    a.className = "blora-cascader__trigger blora-input", a.type = "button", a.disabled = this.hasAttribute("disabled"), a.textContent = this.getAttribute("value") || this.getAttribute("placeholder") || v("cascader.placeholder");
    const i = this.ownerDocument.createElement("div");
    if (i.className = "blora-cascader__panel", i.setAttribute("role", "listbox"), r.append(a, i), this.hasAttribute("show-result")) {
      const s = this.ownerDocument.createElement("output");
      s.className = "blora-cascader__result", this.value && (s.textContent = `${v("cascader.selectedPrefix")}${this.value}`), r.appendChild(s);
    }
    this.replaceChildren(r);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-cascader");
    !t || this.hasAttribute("disabled") || (this.controller = qn(t), this.listen(t, "blora-cascader-change", (e) => {
      const r = e.detail.value;
      this.reflecting = !0, this.setAttribute("value", r), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function pi(n = customElements) {
  !n || n.get(le) || n.define(le, Tn);
}
const ce = "blora-tree";
function Mn(n) {
  if (typeof document > "u") return { destroy: () => {
  } };
  n.setAttribute("role", "tree");
  const l = (s) => {
    const o = s.style.maxHeight, c = s.style.overflow;
    s.style.maxHeight = "none", s.style.overflow = "visible";
    const u = Math.ceil(Math.max(s.scrollHeight, s.getBoundingClientRect().height, 1));
    return s.style.maxHeight = o, s.style.overflow = c, u;
  }, t = (s, o) => {
    const c = l(o);
    o.style.maxHeight = "0px", s.setAttribute("data-open", ""), s.setAttribute("aria-expanded", "true"), o.offsetHeight, o.style.maxHeight = `${c}px`, o.style.setProperty("--blora-tree-h", `${c}px`);
    const u = (b) => {
      b.propertyName === "max-height" && (o.removeEventListener("transitionend", u), s.hasAttribute("data-open") && (o.style.maxHeight = "none"));
    };
    o.addEventListener("transitionend", u);
  }, e = (s, o) => {
    const c = o.style.maxHeight && o.style.maxHeight !== "none" ? o.scrollHeight : l(o);
    o.style.maxHeight = `${Math.max(c, 1)}px`, o.style.setProperty("--blora-tree-h", `${Math.max(c, 1)}px`), o.offsetHeight, s.removeAttribute("data-open"), s.setAttribute("aria-expanded", "false"), o.style.maxHeight = "0px";
  }, r = (s) => {
    let o = s.parentElement;
    for (; o && o !== n; ) {
      if (o.classList.contains("blora-tree__children")) {
        const c = o.previousElementSibling;
        if (c instanceof HTMLElement && c.hasAttribute("data-open")) {
          const u = l(o);
          o.style.setProperty("--blora-tree-h", `${u}px`), o.style.maxHeight !== "none" && o.style.maxHeight !== "" && (o.style.maxHeight = `${u}px`);
        }
      }
      o = o.parentElement;
    }
  }, a = (s) => {
    var b, d;
    const o = s.target.closest(".blora-tree__node");
    if (!o || !n.contains(o)) return;
    const c = o.nextElementSibling, u = c instanceof HTMLElement && c.classList.contains("blora-tree__children") ? c : null;
    u && (!o.hasAttribute("data-open") ? t(o, u) : e(o, u), requestAnimationFrame(() => r(u))), n.querySelectorAll(".blora-tree__node[data-selected]").forEach((m) => {
      m !== o && (m.removeAttribute("data-selected"), m.setAttribute("aria-selected", "false"));
    }), o.hasAttribute("data-selected") ? (o.removeAttribute("data-selected"), o.setAttribute("aria-selected", "false")) : (o.setAttribute("data-selected", ""), o.setAttribute("aria-selected", "true")), n.dispatchEvent(
      new CustomEvent("blora-tree-change", {
        bubbles: !0,
        detail: {
          value: o.dataset.value ?? ((b = o.textContent) == null ? void 0 : b.trim()) ?? "",
          label: o.dataset.label ?? ((d = o.textContent) == null ? void 0 : d.trim()) ?? "",
          selected: o.hasAttribute("data-selected")
        }
      })
    );
  }, i = (s) => {
    if (s.key !== "Enter" && s.key !== " ") return;
    const o = s.target.closest(".blora-tree__node");
    !o || !n.contains(o) || (s.preventDefault(), o.click());
  };
  return n.querySelectorAll(".blora-tree__node").forEach((s) => {
    s.setAttribute("role", "treeitem"), s.hasAttribute("tabindex") || (s.tabIndex = 0);
    const o = s.nextElementSibling;
    if (o != null && o.classList.contains("blora-tree__children")) {
      const c = s.hasAttribute("data-open");
      if (s.setAttribute("aria-expanded", String(c)), c) {
        const u = o;
        u.style.maxHeight = "none", u.style.setProperty("--blora-tree-h", `${l(u)}px`);
      }
    }
  }), n.addEventListener("click", a), n.addEventListener("keydown", i), {
    destroy() {
      n.removeEventListener("click", a), n.removeEventListener("keydown", i);
    }
  };
}
function Bn(n) {
  return Array.from(n.childNodes).filter((l) => l.nodeType === Node.TEXT_NODE).map((l) => l.textContent ?? "").join("").trim();
}
function Je(n) {
  return n.filter((l) => l.localName === "blora-tree-node").map((l) => {
    const t = l.getAttribute("label") ?? Bn(l);
    return {
      children: Je(Array.from(l.children)),
      label: t,
      open: l.hasAttribute("open"),
      selected: l.hasAttribute("selected"),
      value: l.getAttribute("value") ?? t
    };
  }).filter((l) => l.label);
}
function In(n, l) {
  l.appendChild(I("chevron-right", 12, n));
}
class On extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["value"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get value() {
    return this.getAttribute("value") ?? "";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  render() {
    this.definitions || (this.definitions = Je(Array.from(this.children)));
    const t = this.getAttribute("value"), e = this.ownerDocument.createElement("div");
    e.className = "blora-tree", e.dataset.bloraGenerated = "";
    const r = (a, i) => {
      i.forEach((s) => {
        const o = this.ownerDocument.createElement("div");
        o.className = "blora-tree__node", o.dataset.value = s.value, o.dataset.label = s.label, s.open && (o.dataset.open = ""), (s.selected || t === s.value) && (o.dataset.selected = "");
        const c = this.ownerDocument.createElement("span");
        c.className = "blora-tree__toggle", s.children.length ? In(this.ownerDocument, c) : c.setAttribute("aria-hidden", "true");
        const u = this.ownerDocument.createElement("span");
        if (u.textContent = s.label, o.append(c, u), a.appendChild(o), s.children.length) {
          const b = this.ownerDocument.createElement("div");
          b.className = "blora-tree__children", r(b, s.children), a.appendChild(b);
        }
      });
    };
    r(e, this.definitions), this.replaceChildren(e);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-tree");
    t && (this.controller = Mn(t), this.listen(t, "blora-tree-change", (e) => {
      const r = e.detail;
      this.reflecting = !0, r.selected ? this.setAttribute("value", r.value) : this.removeAttribute("value"), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function mi(n = customElements) {
  !n || n.get(ce) || n.define(ce, On);
}
const ue = "blora-tree-select";
function Ze(n) {
  try {
    const l = JSON.parse(n || "[]");
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}
function Pn(n) {
  if (typeof document > "u")
    return {
      open: () => {
      },
      close: () => {
      },
      getValue: () => "",
      setValue: () => {
      },
      destroy: () => {
      }
    };
  n.classList.add("blora-treeselect");
  const l = n.ownerDocument, t = n.querySelector(
    "input.blora-input, .blora-treeselect__input, input"
  );
  if (!t)
    return {
      open: () => {
      },
      close: () => {
      },
      getValue: () => "",
      setValue: () => {
      },
      destroy: () => {
      }
    };
  let e = n.querySelector(".blora-treeselect__panel");
  e || (e = l.createElement("div"), e.className = "blora-treeselect__panel", e.setAttribute("role", "listbox"), n.appendChild(e));
  const r = e, a = Ze(n.getAttribute("data-options") || n.dataset.options || "[]");
  t.readOnly = !0, t.setAttribute("role", "combobox"), t.setAttribute("aria-expanded", "false"), t.setAttribute("aria-haspopup", "listbox");
  let i = n.getAttribute("data-value") || "", s = t.value || "";
  const o = (h) => {
    n.toggleAttribute("data-open", h), t.setAttribute("aria-expanded", String(h));
  }, c = (h) => {
    h.disabled || (i = String(h.value ?? h.label ?? ""), s = String(h.label ?? h.value ?? ""), t.value = s, n.setAttribute("data-value", i), o(!1), n.dispatchEvent(
      new CustomEvent("blora-treeselect-change", {
        bubbles: !0,
        detail: { value: i, label: s, item: h }
      })
    ));
  }, u = (h, y) => {
    const g = l.createElement("div");
    g.className = "blora-treeselect__node", g.dataset.depth = String(y), g.toggleAttribute("data-disabled", !!h.disabled);
    const C = !!(h.children && h.children.length), S = l.createElement("span");
    S.className = "blora-treeselect__toggle", S.setAttribute("aria-hidden", "true"), C ? S.appendChild(I("chevron-right", 12, l)) : S.style.visibility = "hidden", g.appendChild(S);
    const D = l.createElement("span");
    D.textContent = h.label || h.value || "", g.appendChild(D);
    const w = l.createElement("div");
    w.className = "blora-treeselect__children", C && h.children.forEach((E) => w.appendChild(u(E, y + 1)));
    const _ = l.createElement("div");
    return _.appendChild(g), C && _.appendChild(w), g.addEventListener("click", (E) => {
      if (E.stopPropagation(), h.disabled) return;
      const L = E.target.closest(".blora-treeselect__toggle");
      if (C && (L || h.selectable === !1)) {
        const T = !w.hasAttribute("data-open");
        w.toggleAttribute("data-open", T), S.toggleAttribute("data-open", T);
        return;
      }
      if (C && h.selectable !== !0) {
        const T = !w.hasAttribute("data-open");
        w.toggleAttribute("data-open", T), S.toggleAttribute("data-open", T);
        return;
      }
      c(h);
    }), _;
  };
  (() => {
    r.replaceChildren(...a.map((h) => u(h, 0)));
  })();
  const d = (h) => {
    h.stopPropagation(), o(!n.hasAttribute("data-open"));
  }, m = (h) => {
    n.contains(h.target) || o(!1);
  }, p = (h) => {
    h.key === "Escape" && o(!1), h.key === "ArrowDown" && !n.hasAttribute("data-open") && (h.preventDefault(), o(!0));
  };
  return t.addEventListener("click", d), t.addEventListener("keydown", p), l.addEventListener("click", m), {
    open: () => o(!0),
    close: () => o(!1),
    getValue: () => i,
    setValue(h, y) {
      i = h, s = y ?? h, t.value = s, n.setAttribute("data-value", i);
    },
    destroy() {
      t.removeEventListener("click", d), t.removeEventListener("keydown", p), l.removeEventListener("click", m), o(!1);
    }
  };
}
function Rn(n) {
  return Array.from(n.childNodes).filter((l) => l.nodeType === Node.TEXT_NODE).map((l) => l.textContent ?? "").join("").trim();
}
function tr(n) {
  return n.filter((l) => l.localName === "blora-tree-select-option").map((l) => {
    const t = l.getAttribute("label") ?? Rn(l), e = l.getAttribute("selectable"), r = {
      label: t,
      value: l.getAttribute("value") ?? t,
      disabled: l.hasAttribute("disabled")
    };
    e !== null && (r.selectable = e !== "false");
    const a = tr(Array.from(l.children));
    return a.length && (r.children = a), r;
  }).filter((l) => l.label);
}
class Gn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "options", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["options", "label", "placeholder", "value", "disabled"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get value() {
    var t;
    return ((t = this.controller) == null ? void 0 : t.getValue()) ?? this.getAttribute("value") ?? "";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  open() {
    var t;
    this.hasAttribute("disabled") || (t = this.controller) == null || t.open();
  }
  close() {
    var t;
    (t = this.controller) == null || t.close();
  }
  render() {
    this.options || (this.options = tr(Array.from(this.children)));
    const t = this.getAttribute("options") ?? this.getAttribute("data-options");
    let e = this.options;
    t && (e = Ze(t));
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-treeselect", r.dataset.bloraGenerated = "", r.dataset.options = JSON.stringify(e);
    const a = this.getAttribute("value") ?? "";
    a && (r.dataset.value = a);
    const i = this.getAttribute("label");
    if (i) {
      const c = this.ownerDocument.createElement("label");
      c.className = "blora-label", c.textContent = i, r.appendChild(c);
    }
    const s = this.ownerDocument.createElement("input");
    s.className = "blora-input blora-treeselect__input", s.type = "text", s.placeholder = this.getAttribute("placeholder") ?? "", s.value = a, s.disabled = this.hasAttribute("disabled");
    const o = this.ownerDocument.createElement("div");
    o.className = "blora-treeselect__panel", o.setAttribute("role", "listbox"), r.append(s, o), this.replaceChildren(r);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-treeselect");
    !t || this.hasAttribute("disabled") || (this.controller = Pn(t), this.listen(t, "blora-treeselect-change", (e) => {
      const r = e.detail.value;
      this.reflecting = !0, this.setAttribute("value", r), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function fi(n = customElements) {
  !n || n.get(ue) || n.define(ue, Gn);
}
const de = "blora-calendar", be = () => Oe(), $n = () => Pe(), he = (n, l) => {
  n.replaceChildren(
    I(l === "prev" ? "chevron-left" : "chevron-right", 14, n.ownerDocument)
  );
};
function Fn(n) {
  const l = n.ownerDocument, t = /* @__PURE__ */ new Date(), e = n.getAttribute("data-value"), r = e ? /* @__PURE__ */ new Date(`${e}T00:00:00`) : null, a = r && !Number.isNaN(r.getTime()) ? r : null;
  let i = (a == null ? void 0 : a.getFullYear()) ?? t.getFullYear(), s = (a == null ? void 0 : a.getMonth()) ?? t.getMonth(), o = "days", c = a ?? new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const u = (p, h, y) => {
    const g = l.createElement(p);
    return h && (g.className = h), y != null && (g.textContent = y), g;
  }, b = () => {
    n.replaceChildren();
    const p = u("div", "blora-calendar__head"), h = u("div", "blora-calendar__navs"), y = u("button", "blora-calendar__nav");
    y.setAttribute("type", "button"), y.setAttribute("data-nav", "prev"), y.setAttribute("aria-label", v("calendar.prev")), he(y, "prev");
    const g = u("button", "blora-calendar__nav");
    g.setAttribute("type", "button"), g.setAttribute("data-nav", "next"), g.setAttribute("aria-label", v("calendar.next")), he(g, "next"), h.append(y, g);
    let C = "", S = null;
    if (o === "days")
      C = v("calendar.monthYear", {
        year: i,
        month: be()[s] ?? ""
      }), S = "months";
    else if (o === "months")
      C = v("calendar.year", { year: i }), S = "years";
    else {
      const _ = Math.floor(i / 10) * 10;
      C = v("calendar.decade", { start: _, end: _ + 9 });
    }
    const D = u("div", "blora-calendar__title", C);
    S && D.setAttribute("data-zoom", S);
    const w = u("button", "blora-button blora-calendar__today");
    if (w.setAttribute("type", "button"), w.setAttribute("data-variant", "outline"), w.setAttribute("data-size", "sm"), w.setAttribute("data-today", ""), w.textContent = v("common.today"), p.append(h, D, w), n.appendChild(p), o === "days") {
      const _ = u("div", "blora-calendar__grid");
      $n().forEach((N) => _.appendChild(u("div", "blora-calendar__dow", N)));
      const L = new Date(i, s, 1).getDay(), T = new Date(i, s + 1, 0).getDate(), f = new Date(i, s, 0).getDate();
      for (let N = L - 1; N >= 0; N--) {
        const q = u("div", "blora-calendar__cell", String(f - N));
        q.setAttribute("data-other", ""), _.appendChild(q);
      }
      for (let N = 1; N <= T; N++) {
        const q = new Date(i, s, N), M = u("div", "blora-calendar__cell", String(N));
        M.setAttribute("data-day", String(N)), q.toDateString() === t.toDateString() && M.setAttribute("data-today", ""), c && q.toDateString() === c.toDateString() && M.setAttribute("data-selected", ""), _.appendChild(M);
      }
      const k = (7 - (L + T) % 7) % 7;
      for (let N = 1; N <= k; N++) {
        const q = u("div", "blora-calendar__cell", String(N));
        q.setAttribute("data-other", ""), _.appendChild(q);
      }
      n.appendChild(_);
    } else if (o === "months") {
      const _ = u("div", "blora-calendar__grid blora-calendar__grid--months");
      be().forEach((E, L) => {
        const T = u("div", "blora-calendar__cell blora-calendar__cell--month", E);
        T.setAttribute("data-month", String(L)), c && i === c.getFullYear() && L === c.getMonth() && T.setAttribute("data-selected", ""), i === t.getFullYear() && L === t.getMonth() && T.setAttribute("data-today", ""), _.appendChild(T);
      }), n.appendChild(_);
    } else {
      const _ = Math.floor(i / 10) * 10, E = u("div", "blora-calendar__grid blora-calendar__grid--years");
      for (let L = _ - 1; L <= _ + 10; L++) {
        const T = u("div", "blora-calendar__cell blora-calendar__cell--year", String(L));
        T.setAttribute("data-year", String(L)), (L < _ || L > _ + 9) && T.setAttribute("data-other", ""), c && L === c.getFullYear() && T.setAttribute("data-selected", ""), L === t.getFullYear() && T.setAttribute("data-today", ""), E.appendChild(T);
      }
      n.appendChild(E);
    }
  }, d = (p) => {
    const h = p.target, y = h.closest("[data-nav]");
    if (y) {
      const w = y.dataset.nav === "prev" ? -1 : 1;
      o === "days" ? (s += w, s < 0 ? (s = 11, i--) : s > 11 && (s = 0, i++)) : o === "months" ? i += w : i += w * 10, b();
      return;
    }
    const g = h.closest("[data-zoom]");
    if (g) {
      g.dataset.zoom === "months" ? o = "months" : g.dataset.zoom === "years" && (o = "years"), b();
      return;
    }
    if (h.closest("button[data-today], .blora-calendar__head [data-today]")) {
      c = /* @__PURE__ */ new Date(), i = c.getFullYear(), s = c.getMonth(), o = "days", b(), m();
      return;
    }
    const C = h.closest(".blora-calendar__cell[data-day]");
    if (C) {
      c = new Date(i, s, Number(C.dataset.day)), b(), m();
      return;
    }
    const S = h.closest(".blora-calendar__cell--month[data-month]");
    if (S) {
      s = Number(S.dataset.month), o = "days", b();
      return;
    }
    const D = h.closest(".blora-calendar__cell--year[data-year]");
    D && (i = Number(D.dataset.year), o = "months", b());
  }, m = () => {
    if (!c) return;
    const p = `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}-${String(c.getDate()).padStart(2, "0")}`;
    n.dispatchEvent(
      new CustomEvent("blora-calendar-change", {
        bubbles: !0,
        detail: { value: p, date: new Date(c) }
      })
    );
  };
  return n.addEventListener("click", d), b(), {
    destroy() {
      n.removeEventListener("click", d);
    }
  };
}
class Hn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["value"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get value() {
    return this.getAttribute("value") ?? "";
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  render() {
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-calendar", t.dataset.bloraGenerated = "";
    const e = this.getAttribute("value");
    e && (t.dataset.value = e), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-calendar");
    if (!t) return;
    const e = this.getAttribute("value");
    e ? t.dataset.value = e : delete t.dataset.value, this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-calendar");
    t && (this.controller = Fn(t), this.listen(t, "blora-calendar-change", (e) => {
      const r = e.detail.value;
      this.reflecting = !0, this.setAttribute("value", r), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function gi(n = customElements) {
  !n || n.get(de) || n.define(de, Hn);
}
const pe = "blora-carousel";
function Vn(n) {
  const l = n.querySelector(".blora-carousel__track"), t = Array.from(n.querySelectorAll(".blora-carousel__slide")), e = Array.from(n.querySelectorAll(".blora-carousel__dot")), r = n.querySelector(".blora-carousel__arrow--prev"), a = n.querySelector(".blora-carousel__arrow--next");
  if (!l || t.length === 0)
    return { destroy: () => {
    }, next: () => {
    }, prev: () => {
    }, goTo: () => {
    } };
  let i = 0, s = null;
  const o = n.hasAttribute("data-autoplay"), c = t.length - 1, u = 0.2, b = 0.35;
  let d = null;
  const m = (k) => {
    l.classList.toggle("is-dragging", !1), l.toggleAttribute("data-dragging", !1), l.style.transform = `translate3d(${-i * 100}%, 0, 0)`, e.forEach((N, q) => {
      q === i ? N.setAttribute("data-active", "") : N.removeAttribute("data-active");
    });
  }, p = (k) => {
    i = (k % t.length + t.length) % t.length, m(), n.dispatchEvent(
      new CustomEvent("blora-carousel-change", { bubbles: !0, detail: { index: i } })
    );
  }, h = () => p(i + 1), y = () => p(i - 1), g = () => {
    o && (C(), s = setInterval(h, 3500));
  }, C = () => {
    s && (clearInterval(s), s = null);
  }, S = () => n.getBoundingClientRect().width || 1, D = (k) => i === 0 && k > 0 || i === c && k < 0 ? k * 0.35 : k, w = (k) => {
    const N = D(k);
    l.classList.add("is-dragging"), l.setAttribute("data-dragging", ""), l.style.transform = `translate3d(calc(${-i * 100}% + ${N}px), 0, 0)`;
  }, _ = (k) => {
    var q;
    if (k.pointerType === "mouse" && k.button !== 0) return;
    const N = k.target;
    if (!((q = N.closest) != null && q.call(
      N,
      ".blora-carousel__arrow, .blora-carousel__dot, a, button, input, textarea, select, label"
    ))) {
      d = {
        x: k.clientX,
        y: k.clientY,
        dx: 0,
        locked: null,
        lx: k.clientX,
        lt: Date.now(),
        vx: 0,
        pointerId: k.pointerId
      };
      try {
        n.setPointerCapture(k.pointerId);
      } catch {
      }
      C();
    }
  }, E = (k) => {
    if (!d || k.pointerId !== d.pointerId) return;
    const N = k.clientX - d.x, q = k.clientY - d.y;
    if (d.locked == null && (Math.abs(N) > 6 || Math.abs(q) > 6) && (d.locked = Math.abs(N) > Math.abs(q) ? "x" : "y", d.locked === "y")) {
      d = null, o && g();
      return;
    }
    if (d.locked !== "x") return;
    k.cancelable && k.preventDefault();
    const M = Date.now(), P = Math.max(1, M - d.lt);
    d.vx = (k.clientX - d.lx) / P, d.lx = k.clientX, d.lt = M, d.dx = N, w(N);
  }, L = (k) => {
    if (!d) return;
    const N = d.dx, q = d.vx, M = d.locked === "x";
    if (d = null, l.classList.remove("is-dragging"), l.removeAttribute("data-dragging"), !M || k)
      m();
    else {
      const P = S();
      let O = i;
      N <= -P * u || q <= -b ? O = i + 1 : (N >= P * u || q >= b) && (O = i - 1), i = Math.max(0, Math.min(c, O)), m();
    }
    o && g();
  }, T = (k) => {
    if (!(!d || k.pointerId !== d.pointerId)) {
      if (d.locked === "x") {
        d.dx = k.clientX - d.x;
        const N = Date.now(), q = Math.max(1, N - d.lt);
        d.vx = (k.clientX - d.lx) / q;
      }
      L(!1);
    }
  }, f = () => L(!0);
  r == null || r.addEventListener("click", y), a == null || a.addEventListener("click", h);
  const x = e.map((k, N) => {
    const q = () => p(N);
    return k.addEventListener("click", q), { dot: k, fn: q };
  });
  return n.addEventListener("pointerdown", _), n.addEventListener("pointermove", E), n.addEventListener("pointerup", T), n.addEventListener("pointercancel", f), n.style.touchAction = "pan-y", o && (n.addEventListener("mouseenter", C), n.addEventListener("mouseleave", g), g()), p(0), {
    destroy() {
      C(), r == null || r.removeEventListener("click", y), a == null || a.removeEventListener("click", h), x.forEach(({ dot: k, fn: N }) => k.removeEventListener("click", N)), n.removeEventListener("pointerdown", _), n.removeEventListener("pointermove", E), n.removeEventListener("pointerup", T), n.removeEventListener("pointercancel", f), n.removeEventListener("mouseenter", C), n.removeEventListener("mouseleave", g);
    },
    next: h,
    prev: y,
    goTo: p
  };
}
function me(n, l) {
  const t = n.createElement("button");
  return t.className = `blora-carousel__arrow blora-carousel__arrow--${l}`, t.type = "button", t.setAttribute("aria-label", l === "prev" ? v("carousel.prev") : v("carousel.next")), t.appendChild(
    I(l === "prev" ? "chevron-left" : "chevron-right", 18, n)
  ), t;
}
class zn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["current", "autoplay", "label"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get current() {
    return Number(this.getAttribute("current") ?? 0);
  }
  set current(t) {
    this.setAttribute("current", String(t));
  }
  next() {
    var t;
    (t = this.controller) == null || t.next();
  }
  prev() {
    var t;
    (t = this.controller) == null || t.prev();
  }
  goTo(t) {
    var e;
    (e = this.controller) == null || e.goTo(t);
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((a) => a.localName === "blora-carousel-slide").map((a) => ({
      label: a.getAttribute("label") ?? "",
      nodes: Array.from(a.childNodes).map((i) => i.cloneNode(!0))
    })));
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-carousel", t.dataset.bloraGenerated = "", t.setAttribute("role", "region"), t.setAttribute("aria-label", this.getAttribute("label") ?? v("carousel.label")), this.hasAttribute("autoplay") && (t.dataset.autoplay = "");
    const e = this.ownerDocument.createElement("div");
    e.className = "blora-carousel__track", this.definitions.forEach((a, i) => {
      const s = this.ownerDocument.createElement("div");
      s.className = "blora-carousel__slide", s.setAttribute("role", "group"), s.setAttribute(
        "aria-label",
        a.label || `${i + 1} / ${this.definitions.length}`
      ), s.append(...a.nodes.map((o) => o.cloneNode(!0))), e.appendChild(s);
    });
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-carousel__dots", this.definitions.forEach((a, i) => {
      const s = this.ownerDocument.createElement("button");
      s.className = "blora-carousel__dot", s.type = "button", s.setAttribute("aria-label", v("carousel.goto", { n: i + 1 })), r.appendChild(s);
    }), t.append(
      e,
      me(this.ownerDocument, "prev"),
      me(this.ownerDocument, "next"),
      r
    ), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-carousel");
    if (!t) return;
    this.controller = Vn(t);
    const e = Number(this.getAttribute("current") ?? 0);
    e && this.controller.goTo(e), this.listen(t, "blora-carousel-change", (r) => {
      const a = r.detail.index;
      this.reflecting = !0, this.setAttribute("current", String(a)), this.reflecting = !1;
    });
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function vi(n = customElements) {
  !n || n.get(pe) || n.define(pe, zn);
}
const fe = "blora-deck";
function Yn(n) {
  const l = () => Array.from(n.children).filter((w) => w.nodeType === 1);
  if (!l().length)
    return {
      destroy: () => {
      },
      next: () => {
      },
      prev: () => {
      },
      goTo: () => {
      },
      getCurrent: () => 0
    };
  n.hasAttribute("tabindex") || (n.tabIndex = 0);
  const t = 0.72, e = 96, r = 2.35, a = (w, _, E) => Math.min(E, Math.max(_, w)), i = (w, _, E) => {
    let L = w - _;
    return L -= E * Math.round(L / E), L;
  }, s = (w) => {
    const _ = Math.abs(w);
    if (_ > r)
      return { y: w > 0 ? -t * r : t * r, scale: 0.88, opacity: 0, z: 0 };
    const E = -w * t, L = 1 - a(_, 0, 3) * 0.04, T = _ <= 0.15 ? 1 : Math.max(0.28, a(1 - (_ - 0.15) / (r - 0.15), 0, 1)), f = Math.round(40 - _ * 10);
    return { y: E, scale: L, opacity: T, z: f };
  };
  let o = (() => {
    let _ = l().findIndex((E) => E.hasAttribute("data-front"));
    return _ < 0 && (_ = 0), _;
  })(), c = null, u = 0, b = 0;
  const d = (w) => {
    const _ = l(), E = _.length;
    if (!E) return;
    n.toggleAttribute("data-dragging", w);
    let L = 0, T = 1 / 0;
    _.forEach((f, x) => {
      const k = i(x, o, E), N = s(k);
      f.style.setProperty("--blora-deck-y", N.y + "rem"), f.style.setProperty("--blora-deck-scale", String(N.scale)), f.style.setProperty("--blora-deck-opacity", String(N.opacity)), f.style.zIndex = String(N.z), Math.abs(k) < T && (T = Math.abs(k), L = x);
    }), _.forEach((f, x) => {
      const k = x === L;
      f.toggleAttribute("data-front", k), f.setAttribute("aria-hidden", String(!k));
    });
  }, m = () => {
    const w = l().length;
    w && (o = Math.round(o), o = (o % w + w) % w, d(!1), n.dispatchEvent(
      new CustomEvent("blora-deck-change", { bubbles: !0, detail: { index: o } })
    ));
  }, p = (w) => {
    l().length && (o = Math.round(o) + w, m());
  }, h = (w) => {
    o = w, m();
  }, y = (w) => {
    if (!(w.pointerType === "mouse" && w.button !== 0)) {
      c = {
        y: w.clientY,
        startOffset: o,
        locked: null,
        ly: w.clientY,
        lt: Date.now(),
        vy: 0,
        pointerId: w.pointerId
      };
      try {
        n.setPointerCapture(w.pointerId);
      } catch {
      }
    }
  }, g = (w) => {
    if (!c || w.pointerId !== c.pointerId) return;
    const _ = w.clientY - c.y;
    if (c.locked == null && (Math.abs(_) > 6 || Math.abs(w.movementX) > 6) && (c.locked = Math.abs(_) >= Math.abs(w.movementX) ? "y" : "x", c.locked === "x")) {
      c = null;
      return;
    }
    if (c.locked !== "y") return;
    w.preventDefault();
    const E = Date.now(), L = Math.max(1, E - c.lt);
    c.vy = (w.clientY - c.ly) / L, c.ly = w.clientY, c.lt = E, o = c.startOffset + _ / e, d(!0);
  }, C = (w) => {
    if (!c || w.pointerId !== c.pointerId) return;
    const _ = c.locked === "y", E = c.vy, L = c.startOffset;
    if (c = null, !_) {
      o = L, d(!1);
      return;
    }
    E <= -0.4 ? o -= 0.55 : E >= 0.4 && (o += 0.55), m();
  }, S = (w) => {
    w.preventDefault();
    const _ = Date.now();
    _ < b || (u += w.deltaY, Math.abs(u) > 40 && (p(u > 0 ? 1 : -1), u = 0, b = _ + 280));
  }, D = (w) => {
    w.key === "ArrowDown" || w.key === "PageDown" ? (w.preventDefault(), p(1)) : (w.key === "ArrowUp" || w.key === "PageUp") && (w.preventDefault(), p(-1));
  };
  return n.addEventListener("pointerdown", y), n.addEventListener("pointermove", g), n.addEventListener("pointerup", C), n.addEventListener("pointercancel", C), n.addEventListener("wheel", S, { passive: !1 }), n.addEventListener("keydown", D), d(!1), {
    destroy() {
      n.removeEventListener("pointerdown", y), n.removeEventListener("pointermove", g), n.removeEventListener("pointerup", C), n.removeEventListener("pointercancel", C), n.removeEventListener("wheel", S), n.removeEventListener("keydown", D);
    },
    next: () => p(1),
    prev: () => p(-1),
    goTo: h,
    getCurrent: () => Math.round(o)
  };
}
class Wn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["current", "label"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get current() {
    var t;
    return ((t = this.controller) == null ? void 0 : t.getCurrent()) ?? Number(this.getAttribute("current") ?? 0);
  }
  set current(t) {
    this.setAttribute("current", String(t));
  }
  next() {
    var t;
    (t = this.controller) == null || t.next();
  }
  prev() {
    var t;
    (t = this.controller) == null || t.prev();
  }
  goTo(t) {
    var e;
    (e = this.controller) == null || e.goTo(t);
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((r) => r.localName === "blora-deck-card").map((r) => ({
      front: r.hasAttribute("front"),
      nodes: Array.from(r.childNodes).map((a) => a.cloneNode(!0)),
      variant: r.getAttribute("variant") ?? "flat"
    })));
    const t = Number(this.getAttribute("current") ?? 0), e = this.ownerDocument.createElement("div");
    e.className = "blora-deck", e.dataset.bloraGenerated = "", e.tabIndex = 0, e.setAttribute("aria-label", this.getAttribute("label") ?? v("deck.label")), this.definitions.forEach((r, a) => {
      const i = this.ownerDocument.createElement("article");
      i.className = "blora-card", i.dataset.variant = r.variant, (r.front || a === t) && (i.dataset.front = ""), i.append(...r.nodes.map((s) => s.cloneNode(!0))), e.appendChild(i);
    }), this.replaceChildren(e);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-deck");
    if (!t) return;
    this.controller = Yn(t);
    const e = Number(this.getAttribute("current") ?? 0);
    e && this.controller.goTo(e), this.listen(t, "blora-deck-change", (r) => {
      const a = r.detail.index;
      this.reflecting = !0, this.setAttribute("current", String(a)), this.reflecting = !1;
    });
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Ai(n = customElements) {
  !n || n.get(fe) || n.define(fe, Wn);
}
const ge = "blora-image";
function er(n) {
  const l = n.getAttribute("data-preview-group") || n.getAttribute("data-blora-preview-group"), t = l ? n.ownerDocument.querySelectorAll(
    `[data-preview-group="${l}"], [data-blora-preview-group="${l}"]`
  ) : [n], e = [];
  let r = 0;
  return Array.from(t).forEach((a, i) => {
    const s = a.matches("img") ? a : a.querySelector("img"), o = a.getAttribute("data-preview-src") || a.getAttribute("href") || (s == null ? void 0 : s.currentSrc) || (s == null ? void 0 : s.src) || "";
    o && ((a === n || a.contains(n) || n.contains(a)) && (r = e.length), e.push({
      src: o,
      alt: (s == null ? void 0 : s.alt) || "",
      caption: a.getAttribute("data-caption") || (s == null ? void 0 : s.alt) || ""
    }));
  }), !e.length && n instanceof HTMLImageElement && e.push({ src: n.src, alt: n.alt, caption: n.alt }), { items: e, start: r };
}
function rr(n, l = 0) {
  if (typeof document > "u" || !n.length) return null;
  const t = document, e = n.map((S) => typeof S == "string" ? { src: S } : S);
  let r = Math.max(0, Math.min(l, e.length - 1));
  const a = t.createElement("div");
  a.className = "blora-image-preview", a.dataset.open = "", a.setAttribute("role", "dialog"), a.setAttribute("aria-modal", "true"), a.setAttribute("aria-label", v("preview.label"));
  const i = t.createElement("div");
  i.className = "blora-image-preview__stage";
  const s = t.createElement("img");
  s.className = "blora-image-preview__img", s.alt = "";
  const o = t.createElement("div");
  o.className = "blora-image-preview__cap";
  const c = t.createElement("div");
  c.className = "blora-image-preview__count";
  const u = t.createElement("button");
  u.type = "button", u.className = "blora-image-preview__close", u.setAttribute("aria-label", v("preview.close")), u.appendChild(I("close", 18));
  const b = t.createElement("button");
  b.type = "button", b.className = "blora-image-preview__btn blora-image-preview__btn--prev", b.setAttribute("aria-label", v("preview.prev")), b.appendChild(I("chevron-left", 20));
  const d = t.createElement("button");
  d.type = "button", d.className = "blora-image-preview__btn blora-image-preview__btn--next", d.setAttribute("aria-label", v("preview.next")), d.appendChild(I("chevron-right", 20)), i.append(s, o), a.append(c, u, b, d, i), t.body.appendChild(a);
  const m = new dt(a, {
    modal: !0,
    closeOnEscape: !1,
    closeOnOutsidePointer: !1,
    restoreFocus: !0,
    trapFocus: !0,
    lockScroll: !0
  });
  m.open();
  const p = () => {
    const S = e[r];
    s.src = S.src, s.alt = S.alt || "", o.textContent = S.caption || "", c.textContent = e.length > 1 ? `${r + 1} / ${e.length}` : "", b.hidden = e.length < 2, d.hidden = e.length < 2;
  }, h = () => {
    a.isConnected && (a.removeAttribute("data-open"), t.removeEventListener("keydown", C), rt(a, () => {
      m.close(), a.remove();
    }));
  }, y = () => {
    r = (r + 1) % e.length, p();
  }, g = () => {
    r = (r - 1 + e.length) % e.length, p();
  }, C = (S) => {
    S.key === "Escape" && h(), S.key === "ArrowRight" && y(), S.key === "ArrowLeft" && g();
  };
  return u.addEventListener("click", h), b.addEventListener("click", (S) => {
    S.stopPropagation(), g();
  }), d.addEventListener("click", (S) => {
    S.stopPropagation(), y();
  }), a.addEventListener("click", (S) => {
    S.target === a && h();
  }), t.addEventListener("keydown", C), p(), { close: h, next: y, prev: g, el: a };
}
function Un(n) {
  if (typeof document > "u") return { destroy: () => {
  } };
  const l = [], t = (a) => {
    const i = a.querySelector("img");
    if (!i) return;
    const s = () => a.removeAttribute("data-loading");
    if (i.complete && i.naturalWidth > 0) {
      s();
      return;
    }
    a.setAttribute("data-loading", ""), i.addEventListener("load", s), i.addEventListener("error", s), l.push(() => {
      i.removeEventListener("load", s), i.removeEventListener("error", s);
    });
  }, e = (a) => {
    if (!a.hasAttribute("data-blora-preview") && !a.classList.contains("blora-image--preview") && a.getAttribute("data-variant") !== "preview")
      return;
    a.setAttribute("tabindex", a.getAttribute("tabindex") || "0"), a.setAttribute("role", a.getAttribute("role") || "button");
    const i = () => {
      const { items: c, start: u } = er(a);
      rr(c, u);
    }, s = () => i(), o = (c) => {
      (c.key === "Enter" || c.key === " ") && (c.preventDefault(), i());
    };
    a.addEventListener("click", s), a.addEventListener("keydown", o), l.push(() => {
      a.removeEventListener("click", s), a.removeEventListener("keydown", o);
    });
  }, r = n.matches(".blora-image") ? [n] : Array.from(n.querySelectorAll(".blora-image, [data-blora-preview]"));
  return r.forEach((a) => {
    (a.classList.contains("blora-image") || a.matches(".blora-image")) && t(a), e(a);
  }), r.length || n.querySelectorAll("img").forEach((a) => {
    const i = a.closest(".blora-image");
    i && (t(i), e(i));
  }), {
    destroy() {
      l.forEach((a) => a());
    }
  };
}
class Kn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "previewHandle", null);
  }
  static get observedAttributes() {
    return ["src", "alt", "caption", "variant", "filter", "preview", "preview-group"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  open() {
    const t = this.querySelector(".blora-image");
    if (!t) return;
    const { items: e, start: r } = er(t);
    this.previewHandle = rr(e, r);
  }
  close() {
    var t;
    (t = this.previewHandle) == null || t.close(), this.previewHandle = null;
  }
  render() {
    const t = this.ownerDocument.createElement("figure");
    t.className = "blora-image", t.dataset.bloraGenerated = "", t.dataset.variant = this.getAttribute("variant") ?? "default", t.dataset.filter = this.getAttribute("filter") ?? "none", (this.hasAttribute("preview") || t.dataset.variant === "preview") && (t.dataset.bloraPreview = "");
    const e = this.getAttribute("preview-group");
    e && (t.dataset.previewGroup = e);
    const r = this.ownerDocument.createElement("img");
    r.src = this.getAttribute("src") ?? "", r.alt = this.getAttribute("alt") ?? "", r.decoding = "async", t.appendChild(r);
    const a = this.getAttribute("caption");
    if (a) {
      const i = this.ownerDocument.createElement("figcaption");
      i.className = "blora-image__cap", i.textContent = a, t.dataset.caption = a, t.appendChild(i);
    }
    this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-image"), e = t == null ? void 0 : t.querySelector("img");
    if (!t || !e) return;
    t.dataset.variant = this.getAttribute("variant") ?? "default", t.dataset.filter = this.getAttribute("filter") ?? "none", t.toggleAttribute(
      "data-blora-preview",
      this.hasAttribute("preview") || t.dataset.variant === "preview"
    );
    const r = this.getAttribute("preview-group");
    r ? t.dataset.previewGroup = r : delete t.dataset.previewGroup, e.src = this.getAttribute("src") ?? "", e.alt = this.getAttribute("alt") ?? "";
    const a = this.getAttribute("caption");
    let i = t.querySelector("figcaption");
    a ? (i || (i = this.ownerDocument.createElement("figcaption"), i.className = "blora-image__cap", t.appendChild(i)), i.textContent = a, t.dataset.caption = a) : (i == null || i.remove(), delete t.dataset.caption);
  }
  bindEvents() {
    const t = this.querySelector(".blora-image");
    t && (this.controller = Un(t));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null, this.close();
  }
}
function yi(n = customElements) {
  !n || n.get(ge) || n.define(ge, Kn);
}
const ve = "blora-dock";
function Xn(n) {
  var u, b, d;
  const l = n.ownerDocument, t = l.defaultView, e = Array.from(n.querySelectorAll(".blora-dock__item"));
  if (!e.length || !t) return { destroy: () => {
  }, getCurrent: () => 0, select: () => {
  } };
  let r = n.querySelector(".blora-dock__indicator");
  r || (r = l.createElement("span"), r.className = "blora-dock__indicator", r.setAttribute("aria-hidden", "true"), n.insertBefore(r, n.firstChild));
  const a = (m) => {
    if (!m || !r) {
      r.style.opacity = "0";
      return;
    }
    const p = n.getBoundingClientRect(), h = m.getBoundingClientRect(), y = h.left - p.left + n.scrollLeft;
    r.style.opacity = "1", r.style.width = `${h.width}px`, r.style.height = `${h.height}px`, r.style.transform = `translate(${y}px, ${h.top - p.top}px)`;
  }, i = (m) => {
    e.forEach((p) => p.removeAttribute("data-active")), m.setAttribute("data-active", ""), a(m), n.dispatchEvent(
      new CustomEvent("blora-dock-change", {
        bubbles: !0,
        detail: { index: e.indexOf(m), value: m.dataset.value ?? "" }
      })
    );
  }, s = (m) => {
    const p = m.target.closest(".blora-dock__item");
    !p || !n.contains(p) || (m.preventDefault(), i(p));
  }, o = e.find((m) => m.hasAttribute("data-active")) ?? e[0];
  o && (i(o), requestAnimationFrame(() => {
    a(o), requestAnimationFrame(() => a(o));
  })), n.addEventListener("click", s);
  const c = () => {
    const m = e.find((p) => p.hasAttribute("data-active"));
    m && a(m);
  };
  return t.addEventListener("resize", c), (d = (b = (u = l.fonts) == null ? void 0 : u.ready) == null ? void 0 : b.then) == null || d.call(b, c), {
    destroy() {
      n.removeEventListener("click", s), t.removeEventListener("resize", c);
    },
    getCurrent: () => e.findIndex((m) => m.hasAttribute("data-active")),
    select(m) {
      const p = e[m];
      p && i(p);
    }
  };
}
class jn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["current", "label", "static"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get current() {
    var t;
    return ((t = this.controller) == null ? void 0 : t.getCurrent()) ?? Number(this.getAttribute("current") ?? 0);
  }
  set current(t) {
    this.setAttribute("current", String(t));
  }
  select(t) {
    var e;
    (e = this.controller) == null || e.select(t);
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((r) => r.localName === "blora-dock-item").map((r) => ({
      active: r.hasAttribute("active"),
      href: r.getAttribute("href") ?? "#",
      icon: r.getAttribute("icon"),
      nodes: Array.from(r.childNodes).map((a) => a.cloneNode(!0)),
      value: r.getAttribute("value") ?? ""
    })));
    const t = Number(this.getAttribute("current") ?? 0), e = this.ownerDocument.createElement("nav");
    e.className = "blora-dock", this.hasAttribute("static") && e.classList.add("blora-dock--static"), e.dataset.bloraGenerated = "", e.setAttribute("aria-label", this.getAttribute("label") ?? v("dock.label")), this.definitions.forEach((r, a) => {
      const i = this.ownerDocument.createElement("a");
      if (i.className = "blora-dock__item", i.href = r.href, i.dataset.value = r.value, (r.active || a === t) && (i.dataset.active = ""), r.icon) {
        const s = I(r.icon, 20, this.ownerDocument);
        s.childElementCount && i.appendChild(s);
      }
      i.append(...r.nodes.map((s) => s.cloneNode(!0))), e.appendChild(i);
    }), this.replaceChildren(e);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-dock");
    t && (this.controller = Xn(t), this.listen(t, "blora-dock-change", (e) => {
      const r = e.detail.index;
      this.reflecting = !0, this.setAttribute("current", String(r)), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function _i(n = customElements) {
  !n || n.get(ve) || n.define(ve, jn);
}
const Ae = "blora-megamenu";
function Qn(n) {
  if (typeof document > "u")
    return { open: () => {
    }, close: () => {
    }, destroy: () => {
    } };
  const l = n.ownerDocument, t = l.defaultView, e = n.querySelector("[data-blora-megamenu-trigger], .blora-megamenu__trigger") || n.querySelector("button"), r = n.querySelector(".blora-megamenu__panel");
  if (!e || !r || !t)
    return { open: () => {
    }, close: () => {
    }, destroy: () => {
    } };
  r.id || (r.id = `blora-megamenu-${Math.random().toString(36).slice(2, 9)}`), e.setAttribute("aria-controls", r.id), e.setAttribute("aria-haspopup", "true"), e.setAttribute("aria-expanded", "false");
  const a = () => {
    if (!n.hasAttribute("data-open") || typeof t.matchMedia == "function" && t.matchMedia("(max-width: 900px)").matches)
      return;
    r.style.setProperty("--blora-megamenu-offset", "0px");
    const d = r.getBoundingClientRect(), m = parseFloat(t.getComputedStyle(r).getPropertyValue("--blora-space-4")) || 16;
    let p = Math.min(0, t.innerWidth - m - d.right);
    d.left + p < m && (p += m - (d.left + p)), r.style.setProperty("--blora-megamenu-offset", `${p}px`);
  }, i = (d, m = !1) => {
    var p;
    d ? (l.querySelectorAll(
      "[data-blora-megamenu][data-open], .blora-megamenu[data-open]"
    ).forEach((h) => {
      if (h === n) return;
      h.removeAttribute("data-open");
      const y = h.querySelector(
        "[data-blora-megamenu-trigger], .blora-megamenu__trigger"
      );
      y == null || y.setAttribute("aria-expanded", "false");
    }), n.setAttribute("data-open", "")) : n.removeAttribute("data-open"), e.setAttribute("aria-expanded", String(d)), n.dispatchEvent(
      new CustomEvent("blora-megamenu-toggle", { bubbles: !0, detail: { open: d } })
    ), d && t.requestAnimationFrame(a), d && m && ((p = r.querySelector("a, button")) == null || p.focus());
  }, s = (d) => {
    d.stopPropagation(), i(!n.hasAttribute("data-open"));
  }, o = (d) => {
    d.key === "ArrowDown" && (d.preventDefault(), i(!0, !0));
  }, c = (d) => {
    d.key === "Escape" && (d.preventDefault(), i(!1), e.focus());
  }, u = (d) => {
    d.target.closest("a") && i(!1);
  }, b = (d) => {
    n.contains(d.target) || i(!1);
  };
  return e.addEventListener("click", s), e.addEventListener("keydown", o), n.addEventListener("keydown", c), r.addEventListener("click", u), l.addEventListener("click", b), t.addEventListener("resize", a), {
    open: () => i(!0),
    close: () => i(!1),
    destroy() {
      e.removeEventListener("click", s), e.removeEventListener("keydown", o), n.removeEventListener("keydown", c), r.removeEventListener("click", u), l.removeEventListener("click", b), t.removeEventListener("resize", a);
    }
  };
}
class Jn extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["label", "open"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  open() {
    var t;
    (t = this.controller) == null || t.open();
  }
  close() {
    var t;
    (t = this.controller) == null || t.close();
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((i) => i.localName === "blora-megamenu-section").map((i) => ({
      nodes: Array.from(i.childNodes).map((s) => s.cloneNode(!0)),
      title: i.getAttribute("title") ?? ""
    })));
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-megamenu", t.dataset.bloraGenerated = "", t.dataset.bloraMegamenu = "";
    const e = this.ownerDocument.createElement("button");
    e.className = "blora-button blora-megamenu__trigger", e.type = "button", e.dataset.variant = "outline", e.dataset.bloraMegamenuTrigger = "", e.textContent = this.getAttribute("label") ?? v("megamenu.label");
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-megamenu__panel";
    const a = this.ownerDocument.createElement("div");
    a.className = "blora-megamenu__grid", this.definitions.forEach((i) => {
      const s = this.ownerDocument.createElement("div"), o = this.ownerDocument.createElement("div");
      o.className = "blora-megamenu__title", o.textContent = i.title, s.appendChild(o), i.nodes.forEach((c) => {
        const u = c.cloneNode(!0);
        u instanceof this.ownerDocument.defaultView.HTMLAnchorElement && u.classList.add("blora-megamenu__link"), s.appendChild(u);
      }), a.appendChild(s);
    }), r.appendChild(a), t.append(e, r), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-megamenu");
    t && (this.controller = Qn(t), this.listen(t, "blora-megamenu-toggle", (e) => {
      const r = e.detail.open;
      this.reflecting = !0, this.toggleAttribute("open", r), this.reflecting = !1;
    }), this.hasAttribute("open") && this.controller.open());
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Ei(n = customElements) {
  !n || n.get(Ae) || n.define(Ae, Jn);
}
const ye = "blora-speed-dial";
function Z(n, l, t) {
  const e = I(l ?? t, 18, n);
  return e.childElementCount ? e : I(t, 18, n);
}
function Zn(n, l = {}) {
  if (typeof document > "u")
    return {
      open: () => {
      },
      close: () => {
      },
      toggle: () => {
      },
      destroy: () => {
      }
    };
  const t = n.ownerDocument, e = n.querySelector(
    "[data-blora-speed-dial-trigger], .blora-speed-dial__trigger"
  ), r = n.querySelector(".blora-speed-dial__actions"), a = n.querySelector(
    "[data-blora-speed-dial-close], .blora-speed-dial__close"
  ), i = n.querySelector(
    "[data-blora-speed-dial-main], .blora-speed-dial__main"
  );
  if (!e || !r)
    return { open: () => {
    }, close: () => {
    }, toggle: () => {
    }, destroy: () => {
    } };
  const s = Array.from(
    r.querySelectorAll(".blora-speed-dial__action")
  );
  r.id || (r.id = `blora-sd-actions-${Math.random().toString(36).slice(2, 9)}`), e.setAttribute("aria-haspopup", "menu"), e.setAttribute("aria-expanded", "false"), e.setAttribute("aria-controls", r.id), r.setAttribute("role", "menu"), r.setAttribute("aria-hidden", "true"), s.forEach((h) => {
    h.setAttribute("role", "menuitem"), h.setAttribute("tabindex", "-1");
  }), a == null || a.setAttribute("tabindex", "-1"), a == null || a.setAttribute("aria-hidden", "true"), i == null || i.setAttribute("tabindex", "-1"), i == null || i.setAttribute("aria-hidden", "true");
  const o = (h, y = !1) => {
    var g;
    h ? n.setAttribute("data-open", "") : n.removeAttribute("data-open"), e.setAttribute("aria-expanded", String(h)), r.setAttribute("aria-hidden", String(!h)), a == null || a.setAttribute("aria-hidden", String(!h)), i && (i.setAttribute("aria-hidden", String(!h)), i.setAttribute("tabindex", h ? "0" : "-1")), s.forEach((C) => C.setAttribute("tabindex", h ? "0" : "-1")), h && y && ((g = i ?? s[0]) == null || g.focus()), h || s.forEach((C) => C.setAttribute("tabindex", "-1")), n.dispatchEvent(
      new CustomEvent("blora-speed-dial-toggle", { bubbles: !0, detail: { open: h } })
    );
  }, c = (h) => {
    h.stopPropagation(), o(!n.hasAttribute("data-open"));
  }, u = (h) => {
    (h.key === "ArrowDown" || h.key === "ArrowUp" || h.key === "ArrowLeft" || h.key === "ArrowRight") && (h.preventDefault(), o(!0, !0));
  }, b = (h) => {
    var C, S, D, w;
    if (h.key === "Escape" && n.hasAttribute("data-open")) {
      h.preventDefault(), o(!1), e.focus();
      return;
    }
    if (!n.hasAttribute("data-open")) return;
    const y = i ? [i, ...s] : s, g = y.indexOf(h.target);
    g < 0 || ((h.key === "ArrowDown" || h.key === "ArrowRight") && (h.preventDefault(), (C = y[(g + 1) % y.length]) == null || C.focus()), (h.key === "ArrowUp" || h.key === "ArrowLeft") && (h.preventDefault(), (S = y[(g - 1 + y.length) % y.length]) == null || S.focus()), h.key === "Home" && (h.preventDefault(), (D = y[0]) == null || D.focus()), h.key === "End" && (h.preventDefault(), (w = y[y.length - 1]) == null || w.focus()));
  }, d = (h) => {
    const y = h.target.closest(".blora-speed-dial__action");
    y && (n.dispatchEvent(
      new CustomEvent("blora-speed-dial-select", {
        bubbles: !0,
        detail: { value: y.dataset.value ?? "" }
      })
    ), o(!1));
  }, m = (h) => {
    n.contains(h.target) || o(!1);
  }, p = (h) => {
    h.stopPropagation(), o(!1), e.focus();
  };
  return l.triggerDelegated || e.addEventListener("click", c), e.addEventListener("keydown", u), n.addEventListener("keydown", b), r.addEventListener("click", d), a == null || a.addEventListener("click", p), i == null || i.addEventListener("click", p), t.addEventListener("click", m), {
    open: () => o(!0),
    close: () => o(!1),
    toggle: () => o(!n.hasAttribute("data-open")),
    destroy() {
      l.triggerDelegated || e.removeEventListener("click", c), e.removeEventListener("keydown", u), n.removeEventListener("keydown", b), r.removeEventListener("click", d), a == null || a.removeEventListener("click", p), i == null || i.removeEventListener("click", p), t.removeEventListener("click", m);
    }
  };
}
class ta extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "reflecting", !1);
    A(this, "dialTreeObserver", null);
    A(this, "lastToggleEvent", null);
  }
  static get observedAttributes() {
    return [
      "label",
      "mode",
      "action-appearance",
      "open",
      "close-button",
      "main-label",
      "main-icon"
    ];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  open() {
    var t;
    (t = this.controller) == null || t.open();
  }
  close() {
    var t;
    (t = this.controller) == null || t.close();
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((o) => o.localName === "blora-speed-dial-action").map((o) => {
      var c;
      return {
        icon: o.getAttribute("icon"),
        label: o.getAttribute("label") ?? ((c = o.textContent) == null ? void 0 : c.trim()) ?? "",
        nodes: Array.from(o.childNodes).map((u) => u.cloneNode(!0)),
        variant: o.getAttribute("variant") ?? "secondary",
        value: o.getAttribute("value") ?? ""
      };
    }));
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-speed-dial";
    const e = this.getAttribute("mode");
    (e === "left" || e === "flower") && t.classList.add(`blora-speed-dial--${e}`), t.dataset.bloraGenerated = "", t.dataset.bloraSpeedDial = "";
    const r = this.ownerDocument.createElement("button");
    if (r.className = "blora-button blora-speed-dial__trigger", r.dataset.size = "icon", r.dataset.variant = "primary", r.dataset.bloraSpeedDialTrigger = "", r.type = "button", r.setAttribute("aria-label", this.getAttribute("label") ?? v("speedDial.label")), r.appendChild(Z(this.ownerDocument, "plus", "plus")), t.appendChild(r), this.hasAttribute("close-button")) {
      const o = this.ownerDocument.createElement("button");
      o.className = "blora-button blora-speed-dial__close", o.dataset.size = "icon", o.dataset.variant = "danger", o.dataset.bloraSpeedDialClose = "", o.type = "button", o.setAttribute("aria-label", v("common.close")), o.appendChild(Z(this.ownerDocument, "close", "close")), t.appendChild(o);
    }
    const a = this.getAttribute("main-label");
    if (a) {
      const o = this.ownerDocument.createElement("button");
      o.className = "blora-button blora-speed-dial__main", o.dataset.size = "icon", o.dataset.variant = "secondary", o.dataset.bloraSpeedDialMain = "", o.type = "button", o.setAttribute("aria-label", a), o.appendChild(Z(this.ownerDocument, this.getAttribute("main-icon"), "plus")), t.appendChild(o);
    }
    const i = this.ownerDocument.createElement("div");
    i.className = "blora-speed-dial__actions";
    const s = this.getAttribute("action-appearance") ?? "icon";
    this.definitions.forEach((o) => {
      const c = this.ownerDocument.createElement("button");
      if (c.className = "blora-button blora-speed-dial__action", c.dataset.size = s === "button" ? "sm" : "icon", c.dataset.variant = o.variant, c.dataset.value = o.value, c.type = "button", c.setAttribute("aria-label", o.label), c.title = o.label, s === "button" ? c.textContent = o.label : o.icon ? c.appendChild(Z(this.ownerDocument, o.icon, "document")) : o.nodes.length ? c.append(...o.nodes.map((u) => u.cloneNode(!0))) : c.appendChild(Z(this.ownerDocument, null, "document")), s === "label") {
        const u = this.ownerDocument.createElement("div");
        u.className = "blora-speed-dial__item";
        const b = this.ownerDocument.createElement("span");
        b.className = "blora-speed-dial__label", b.textContent = o.label, u.append(b, c), i.appendChild(u);
      } else i.appendChild(c);
    }), t.appendChild(i), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    var e, r;
    (e = this.controller) == null || e.destroy(), this.controller = null;
    const t = this.querySelector(".blora-speed-dial");
    t && (this.controller = Zn(t, { triggerDelegated: !0 }), (r = this.dialTreeObserver) == null || r.disconnect(), this.dialTreeObserver = new MutationObserver(() => {
      this.isConnectedInternal && this.rebind();
    }), this.dialTreeObserver.observe(this, { childList: !0 }), this.listen(this, "click", (a) => {
      var s;
      if (this.lastToggleEvent === a) return;
      const i = a.target;
      !i || !i.closest("[data-blora-speed-dial-trigger], .blora-speed-dial__trigger") || this.contains(i) && (this.lastToggleEvent = a, a.stopPropagation(), (s = this.controller) == null || s.toggle());
    }), this.listen(this, "keydown", (a) => {
      var o;
      const i = a;
      if (this.lastToggleEvent === a) return;
      const s = a.target;
      !s || !s.closest("[data-blora-speed-dial-trigger], .blora-speed-dial__trigger") || !this.contains(s) || i.key !== "Enter" && i.key !== " " || (this.lastToggleEvent = a, a.preventDefault(), a.stopPropagation(), (o = this.controller) == null || o.toggle());
    }), this.listen(t, "blora-speed-dial-toggle", (a) => {
      const i = a.detail.open;
      this.reflecting = !0, this.toggleAttribute("open", i), this.reflecting = !1;
    }), this.hasAttribute("open") && this.controller.open());
  }
  onDisconnect() {
    var t, e;
    (t = this.dialTreeObserver) == null || t.disconnect(), this.dialTreeObserver = null, (e = this.controller) == null || e.destroy(), this.controller = null;
  }
}
function Ci(n = customElements) {
  !n || n.get(ye) || n.define(ye, ta);
}
const _e = "blora-splitter";
function ea(n) {
  const l = n.ownerDocument, t = Array.from(n.querySelectorAll(".blora-splitter__pane"));
  if (t.length < 2) return { destroy: () => {
  }, getPosition: () => 50, setPosition: () => {
  } };
  let e = n.querySelector(".blora-splitter__handle");
  if (!e) {
    e = l.createElement("div"), e.className = "blora-splitter__handle";
    const d = l.createElement("span");
    d.className = "blora-splitter__grip", e.appendChild(d), n.insertBefore(e, t[1]);
  }
  const r = Number(n.dataset.min ?? 50);
  let a = !1, i = Number(n.dataset.position ?? 50);
  e.tabIndex = 0, e.setAttribute("role", "separator"), e.setAttribute("aria-orientation", "vertical");
  const s = (d, m = !1) => {
    const p = n.getBoundingClientRect(), h = p.width > 0 ? r / p.width * 100 : 0;
    i = Math.max(h, Math.min(100 - h, d)), t[0].style.flex = `0 0 ${i}%`, t[1].style.flex = "1 1 0%", e.setAttribute("aria-valuenow", String(Math.round(i))), m && n.dispatchEvent(
      new CustomEvent("blora-splitter-change", {
        bubbles: !0,
        detail: { position: i }
      })
    );
  }, o = (d) => {
    a = !0, e.setPointerCapture(d.pointerId), d.preventDefault();
  }, c = (d) => {
    if (!a) return;
    const m = n.getBoundingClientRect(), p = (d.clientX - m.left) / m.width * 100;
    s(p, !0);
  }, u = (d) => {
    d.key !== "ArrowLeft" && d.key !== "ArrowRight" || (d.preventDefault(), s(i + (d.key === "ArrowRight" ? 2 : -2), !0));
  }, b = (d) => {
    a = !1;
    try {
      e.releasePointerCapture(d.pointerId);
    } catch {
    }
  };
  return e.addEventListener("pointerdown", o), e.addEventListener("pointermove", c), e.addEventListener("pointerup", b), e.addEventListener("keydown", u), s(i), {
    destroy() {
      e.removeEventListener("pointerdown", o), e.removeEventListener("pointermove", c), e.removeEventListener("pointerup", b), e.removeEventListener("keydown", u);
    },
    getPosition: () => i,
    setPosition: (d) => s(d, !0)
  };
}
class ra extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["position", "min"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  get position() {
    var t;
    return ((t = this.controller) == null ? void 0 : t.getPosition()) ?? Number(this.getAttribute("position") ?? 50);
  }
  set position(t) {
    this.setAttribute("position", String(t));
  }
  setPosition(t) {
    var e;
    (e = this.controller) == null || e.setPosition(t);
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((e) => e.localName === "blora-splitter-pane").slice(0, 2).map((e) => ({
      nodes: Array.from(e.childNodes).map((r) => r.cloneNode(!0)),
      style: e.getAttribute("style") ?? ""
    })));
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-splitter", t.dataset.bloraGenerated = "", t.dataset.min = this.getAttribute("min") ?? "50", t.dataset.position = this.getAttribute("position") ?? "50", this.definitions.forEach((e) => {
      const r = this.ownerDocument.createElement("div");
      r.className = "blora-splitter__pane", r.style.cssText = e.style, r.append(...e.nodes.map((a) => a.cloneNode(!0))), t.appendChild(r);
    }), this.replaceChildren(t);
  }
  sync() {
    var a;
    const t = this.querySelector(".blora-splitter");
    if (!t) return;
    const e = this.getAttribute("min");
    e && (t.dataset.min = e);
    const r = this.getAttribute("position");
    r && (t.dataset.position = r, (a = this.controller) == null || a.setPosition(Number(r)));
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-splitter");
    t && ((e = this.controller) == null || e.destroy(), this.controller = ea(t), this.listen(t, "blora-splitter-change", (r) => {
      const a = r.detail.position;
      this.reflecting = !0, this.setAttribute("position", String(a)), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function wi(n = customElements) {
  !n || n.get(_e) || n.define(_e, ra);
}
const Ee = "blora-tour";
function na(n, l) {
  const t = n.trim();
  return t ? t.endsWith("%") ? Number.parseFloat(t) / 100 * l : Number.parseFloat(t) || 0 : 0;
}
function aa(n) {
  const l = Array.from(n.children).filter(
    (t) => t instanceof HTMLElement
  );
  return l.length === 1 ? l[0] : n;
}
function ia(n) {
  const l = getComputedStyle(n).getPropertyValue("--blora-tour-pad").trim(), t = Number.parseFloat(l);
  return Number.isFinite(t) && t >= 0 ? t : 4;
}
function ot(n, l, t) {
  return na(n.trim().split(/\s+/)[0] ?? "0px", l) + t;
}
function sa(n, l, t) {
  const e = Math.min(
    1,
    n / Math.max(t.tl + t.tr, 1e-3),
    n / Math.max(t.bl + t.br, 1e-3),
    l / Math.max(t.tl + t.bl, 1e-3),
    l / Math.max(t.tr + t.br, 1e-3)
  );
  return {
    tl: t.tl * e,
    tr: t.tr * e,
    br: t.br * e,
    bl: t.bl * e
  };
}
function oa(n, l) {
  const t = l.getBoundingClientRect(), e = getComputedStyle(l), r = ia(n), a = t.left - r, i = t.top - r, s = Math.max(0, t.width + r * 2), o = Math.max(0, t.height + r * 2), c = sa(s, o, {
    tl: ot(e.borderTopLeftRadius, t.width, r),
    tr: ot(e.borderTopRightRadius, t.width, r),
    br: ot(e.borderBottomRightRadius, t.width, r),
    bl: ot(e.borderBottomLeftRadius, t.width, r)
  }), u = n.querySelector(".blora-tour__ring");
  return u.style.left = `${a}px`, u.style.top = `${i}px`, u.style.width = `${s}px`, u.style.height = `${o}px`, u.style.borderRadius = `${c.tl}px ${c.tr}px ${c.br}px ${c.bl}px`, { pad: r, rect: t };
}
function la(n) {
  const l = n.ownerDocument, t = n.querySelector("[data-tour-start]"), e = Array.from(n.querySelectorAll("[data-tour-step]"));
  if (e.length === 0)
    return { destroy: () => {
    }, end: () => {
    }, next: () => {
    }, prev: () => {
    }, start: () => {
    } };
  let r = -1, a = null, i = null, s = null;
  const o = () => {
    var w;
    a = l.createElement("div"), a.className = "blora-tour__overlay", a.setAttribute("popover", "manual");
    const p = l.createElement("div");
    p.className = "blora-tour__ring", a.appendChild(p), i = l.createElement("div"), i.className = "blora-tour__tooltip", i.setAttribute("role", "dialog"), i.setAttribute("aria-modal", "true");
    const h = l.createElement("div");
    h.className = "blora-tour__title", h.id = "blora-tour-title";
    const y = l.createElement("div");
    y.className = "blora-tour__desc";
    const g = l.createElement("div");
    g.className = "blora-tour__footer";
    const C = l.createElement("span");
    C.className = "blora-tour__counter";
    const S = l.createElement("div");
    S.className = "blora-tour__buttons";
    const D = (_, E, L) => {
      const T = l.createElement("button");
      return T.className = `blora-button ${_}`, T.dataset.variant = L, T.dataset.size = "sm", T.type = "button", T.textContent = E, T;
    };
    S.append(
      D("blora-tour__skip", v("common.skip"), "outline"),
      D("blora-tour__prev", v("common.prev"), "outline"),
      D("blora-tour__next", v("common.next"), "primary")
    ), g.append(C, S), i.append(h, y, g), i.setAttribute("aria-labelledby", h.id), a.appendChild(i), l.body.appendChild(a);
    try {
      (w = a.showPopover) == null || w.call(a);
    } catch {
    }
    i.querySelector(".blora-tour__skip").addEventListener("click", m), i.querySelector(".blora-tour__prev").addEventListener("click", () => b(r - 1)), i.querySelector(".blora-tour__next").addEventListener("click", () => {
      r < e.length - 1 ? b(r + 1) : m();
    }), a.addEventListener("blora-close-request", m);
  }, c = () => {
    var f;
    if (!a || !i || r < 0) return;
    const p = e[r], h = aa(p), y = l.defaultView, g = (f = y == null ? void 0 : y.matchMedia) == null ? void 0 : f.call(y, "(prefers-reduced-motion: reduce)").matches;
    typeof h.scrollIntoView == "function" && h.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: g ? "auto" : "smooth"
    });
    const { pad: C, rect: S } = oa(a, h), D = i.offsetHeight || 140, w = i.offsetWidth || 280, _ = (y == null ? void 0 : y.innerHeight) ?? 800, E = (y == null ? void 0 : y.innerWidth) ?? 1200;
    let L = S.bottom + C + 12;
    L + D > _ - 12 && (L = S.top - C - 12 - D), L < 12 && (L = 12);
    let T = Math.max(8, S.left - C);
    T + w > E - 8 && (T = Math.max(8, E - w - 8)), i.style.top = `${L}px`, i.style.left = `${T}px`;
  }, u = () => c(), b = (p) => {
    r = Math.max(0, Math.min(p, e.length - 1));
    const h = e[r];
    i.querySelector(".blora-tour__title").textContent = h.dataset.tourTitle ?? "", i.querySelector(".blora-tour__desc").textContent = h.dataset.tourDesc ?? "", i.querySelector(".blora-tour__counter").textContent = v("tour.step", {
      current: r + 1,
      total: e.length
    });
    const y = i.querySelector(".blora-tour__next");
    y.textContent = r < e.length - 1 ? v("common.next") : v("common.done"), i.querySelector(".blora-tour__prev").style.visibility = r > 0 ? "visible" : "hidden", c(), a != null && a.hasAttribute("data-open") && i.setAttribute("data-open", ""), n.dispatchEvent(
      new CustomEvent("blora-tour-change", {
        bubbles: !0,
        detail: { index: r, total: e.length }
      })
    );
  }, d = () => {
    m(), o(), l.documentElement.setAttribute("data-blora-tour-open", ""), a && (s = new dt(a, {
      modal: !0,
      closeOnEscape: !0,
      closeOnOutsidePointer: !1,
      restoreFocus: !0,
      trapFocus: !0,
      lockScroll: !0
    }), s.open()), window.addEventListener("resize", u), window.addEventListener("scroll", u, !0), b(0), a == null || a.offsetWidth, i == null || i.offsetWidth;
    const p = l.defaultView, h = () => {
      a == null || a.setAttribute("data-open", ""), i == null || i.setAttribute("data-open", "");
    };
    p ? p.requestAnimationFrame(h) : h();
  }, m = () => {
    const p = r >= 0;
    window.removeEventListener("resize", u), window.removeEventListener("scroll", u, !0), l.documentElement.removeAttribute("data-blora-tour-open");
    const h = a, y = i, g = s;
    a = null, i = null, s = null, r = -1, h == null || h.removeAttribute("data-open"), y == null || y.removeAttribute("data-open");
    const C = () => {
      var S;
      g == null || g.close();
      try {
        (S = h == null ? void 0 : h.hidePopover) == null || S.call(h);
      } catch {
      }
      h == null || h.remove();
    };
    y ? rt(y, C) : C(), p && n.dispatchEvent(new CustomEvent("blora-tour-end", { bubbles: !0 }));
  };
  return t == null || t.addEventListener("click", d), {
    destroy() {
      m(), t == null || t.removeEventListener("click", d);
    },
    end: m,
    next: () => r < e.length - 1 ? b(r + 1) : m(),
    prev: () => b(r - 1),
    start: d
  };
}
class ca extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["label", "open"];
  }
  attributeChangedCallback() {
    !this.isConnectedInternal || this.reflecting || this.sync();
  }
  start() {
    var t;
    (t = this.controller) == null || t.start();
  }
  end() {
    var t;
    (t = this.controller) == null || t.end();
  }
  next() {
    var t;
    (t = this.controller) == null || t.next();
  }
  prev() {
    var t;
    (t = this.controller) == null || t.prev();
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((a) => a.localName === "blora-tour-step").map((a) => ({
      description: a.getAttribute("description") ?? "",
      nodes: Array.from(a.childNodes).map((i) => i.cloneNode(!0)),
      title: a.getAttribute("title") ?? ""
    })));
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-tour", t.dataset.bloraGenerated = "";
    const e = this.ownerDocument.createElement("button");
    e.className = "blora-button", e.dataset.variant = "primary", e.dataset.tourStart = "", e.type = "button", e.textContent = this.getAttribute("label") ?? v("tour.start"), t.appendChild(e);
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-tour__steps", this.definitions.forEach((a) => {
      const i = this.ownerDocument.createElement("div");
      i.dataset.tourStep = "", i.dataset.tourTitle = a.title, i.dataset.tourDesc = a.description, i.append(...a.nodes.map((s) => s.cloneNode(!0))), r.appendChild(i);
    }), t.appendChild(r), this.replaceChildren(t);
  }
  sync() {
    var e, r;
    const t = this.querySelector("[data-tour-start]");
    t && (t.textContent = this.getAttribute("label") ?? v("tour.start")), this.hasAttribute("open") ? (e = this.controller) == null || e.start() : (r = this.controller) == null || r.end();
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-tour");
    t && ((e = this.controller) == null || e.destroy(), this.controller = la(t), this.listen(t, "blora-tour-change", () => {
      this.reflecting = !0, this.setAttribute("open", ""), this.reflecting = !1;
    }), this.listen(t, "blora-tour-end", () => {
      this.reflecting = !0, this.removeAttribute("open"), this.reflecting = !1;
    }), this.hasAttribute("open") && this.controller.start());
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function xi(n = customElements) {
  !n || n.get(Ee) || n.define(Ee, ca);
}
const ua = {
  success: "circle-check",
  danger: "circle-x",
  error: "circle-x",
  warning: "circle-alert",
  info: "info"
};
function ut(n, l, t) {
  return I(ua[l] ?? "info", t, n);
}
const Ce = "blora-alert";
class da extends B {
  static get observedAttributes() {
    return ["variant", "title", "description", "dismissible"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  close() {
    this.emit("blora-alert-close", void 0), this.remove();
  }
  render() {
    const l = this.getAttribute("variant") ?? "info", t = this.ownerDocument.createElement("div");
    t.className = "blora-alert", t.dataset.variant = l, t.dataset.bloraGenerated = "", t.setAttribute("role", l === "danger" || l === "error" ? "alert" : "status");
    const e = this.ownerDocument.createElement("span");
    e.className = "blora-alert__icon", e.appendChild(ut(this.ownerDocument, l, 20));
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-alert__body";
    const a = this.ownerDocument.createElement("div");
    a.className = "blora-alert__title", a.textContent = this.getAttribute("title") ?? "";
    const i = this.ownerDocument.createElement("div");
    if (i.className = "blora-alert__desc", i.textContent = this.getAttribute("description") ?? "", r.append(a, i), t.append(e, r), this.hasAttribute("dismissible")) {
      const s = this.ownerDocument.createElement("button");
      s.className = "blora-alert__close", s.type = "button", s.setAttribute("aria-label", v("common.close")), s.appendChild(I("close", 16, this.ownerDocument)), t.appendChild(s);
    }
    this.replaceChildren(t);
  }
  sync() {
    const l = this.querySelector(".blora-alert");
    if (!l) return;
    const t = this.getAttribute("variant") ?? "info";
    l.dataset.variant = t, l.setAttribute("role", t === "danger" || t === "error" ? "alert" : "status");
    const e = l.querySelector(".blora-alert__icon");
    e && e.replaceChildren(ut(this.ownerDocument, t, 20));
    const r = l.querySelector(".blora-alert__title");
    r && (r.textContent = this.getAttribute("title") ?? "");
    const a = l.querySelector(".blora-alert__desc");
    a && (a.textContent = this.getAttribute("description") ?? "");
    const i = l.querySelector(".blora-alert__close");
    this.hasAttribute("dismissible") && !i ? (this.render(), this.rebind()) : !this.hasAttribute("dismissible") && i && i.remove();
  }
  bindEvents() {
    const l = this.querySelector(".blora-alert__close");
    l && this.listen(l, "click", () => this.close());
  }
}
function ki(n = customElements) {
  !n || n.get(Ce) || n.define(Ce, da);
}
const we = "blora-banner";
class ba extends B {
  constructor() {
    super(...arguments);
    A(this, "definitions", null);
  }
  static get observedAttributes() {
    return ["title", "description"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((s) => s.localName === "blora-banner-action").map((s) => {
      var o;
      return {
        label: s.getAttribute("label") ?? ((o = s.textContent) == null ? void 0 : o.trim()) ?? "",
        value: s.getAttribute("value") ?? "",
        variant: s.getAttribute("variant") ?? "outline"
      };
    }));
    const t = this.ownerDocument.createElement("section");
    t.className = "blora-banner", t.dataset.bloraGenerated = "";
    const e = this.ownerDocument.createElement("div");
    e.className = "blora-banner__body";
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-banner__title", r.textContent = this.getAttribute("title") ?? "";
    const a = this.ownerDocument.createElement("div");
    a.className = "blora-banner__desc", a.textContent = this.getAttribute("description") ?? "", e.append(r, a);
    const i = this.ownerDocument.createElement("div");
    i.className = "blora-banner__actions", this.definitions.forEach((s) => {
      const o = this.ownerDocument.createElement("button");
      o.className = "blora-button", o.dataset.variant = s.variant, o.dataset.size = "sm", o.dataset.value = s.value, o.type = "button", o.textContent = s.label, i.appendChild(o);
    }), t.append(e, i), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-banner__title");
    t && (t.textContent = this.getAttribute("title") ?? "");
    const e = this.querySelector(".blora-banner__desc");
    e && (e.textContent = this.getAttribute("description") ?? "");
  }
  bindEvents() {
    const t = this.querySelector(".blora-banner__actions");
    t && this.listen(t, "click", (e) => {
      const r = e.target.closest("button");
      r && this.emit("blora-banner-action", { value: r.dataset.value ?? "" });
    });
  }
}
function Si(n = customElements) {
  !n || n.get(we) || n.define(we, ba);
}
const xe = "blora-breadcrumb";
class ha extends B {
  constructor() {
    super(...arguments);
    A(this, "definitions", null);
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((e) => e.localName === "blora-breadcrumb-item").map((e) => {
      var r;
      return {
        current: e.hasAttribute("current"),
        href: e.getAttribute("href") ?? "#",
        label: e.getAttribute("label") ?? ((r = e.textContent) == null ? void 0 : r.trim()) ?? ""
      };
    }));
    const t = this.ownerDocument.createElement("nav");
    t.className = "blora-breadcrumb", t.dataset.bloraGenerated = "", t.setAttribute("aria-label", v("breadcrumb.label")), this.definitions.forEach((e, r) => {
      if (r) {
        const a = this.ownerDocument.createElement("span");
        a.className = "blora-breadcrumb__sep", a.setAttribute("aria-hidden", "true"), a.textContent = "/", t.appendChild(a);
      }
      if (e.current || r === this.definitions.length - 1) {
        const a = this.ownerDocument.createElement("span");
        a.className = "blora-breadcrumb__current", a.setAttribute("aria-current", "page"), a.textContent = e.label, t.appendChild(a);
      } else {
        const a = this.ownerDocument.createElement("a");
        a.href = e.href, a.textContent = e.label, t.appendChild(a);
      }
    }), this.replaceChildren(t);
  }
  bindEvents() {
  }
}
function Ni(n = customElements) {
  !n || n.get(xe) || n.define(xe, ha);
}
const ke = "blora-chart-container";
class pa extends B {
  constructor() {
    super(...arguments);
    A(this, "content", null);
  }
  static get observedAttributes() {
    return ["title", "subtitle", "trend", "trend-variant"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  render() {
    this.content || (this.content = Array.from(this.childNodes).map((c) => c.cloneNode(!0)));
    const t = this.ownerDocument.createElement("section");
    t.className = "blora-chart", t.dataset.bloraGenerated = "";
    const e = this.ownerDocument.createElement("div");
    e.className = "blora-chart__header";
    const r = this.ownerDocument.createElement("div"), a = this.ownerDocument.createElement("div");
    a.className = "blora-chart__title", a.textContent = this.getAttribute("title") ?? "";
    const i = this.ownerDocument.createElement("div");
    i.className = "blora-text-xs blora-text-subtle", i.textContent = this.getAttribute("subtitle") ?? "", r.append(a, i), e.appendChild(r);
    const s = this.getAttribute("trend");
    if (s) {
      const c = this.ownerDocument.createElement("span");
      c.className = "blora-tag", c.dataset.variant = this.getAttribute("trend-variant") ?? "success", c.textContent = s, e.appendChild(c);
    }
    const o = this.ownerDocument.createElement("div");
    o.className = "blora-chart__body", o.append(...this.content.map((c) => c.cloneNode(!0))), t.append(e, o), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-chart__title");
    t && (t.textContent = this.getAttribute("title") ?? "");
    const e = this.querySelector(".blora-text-xs");
    e && (e.textContent = this.getAttribute("subtitle") ?? "");
    const r = this.getAttribute("trend"), a = this.querySelector(".blora-tag");
    if (r) {
      if (!a) {
        this.render();
        return;
      }
      a.textContent = r, a.dataset.variant = this.getAttribute("trend-variant") ?? "success";
    } else
      a == null || a.remove();
  }
  bindEvents() {
  }
}
function Di(n = customElements) {
  !n || n.get(ke) || n.define(ke, pa);
}
const Se = "blora-chat";
class ma extends B {
  static get observedAttributes() {
    return ["author", "time", "avatar", "message", "side", "avatar-variant"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  render() {
    const l = this.ownerDocument.createElement("article");
    l.className = "blora-chat", this.getAttribute("side") === "end" && l.classList.add("blora-chat--end"), l.dataset.bloraGenerated = "";
    const t = this.ownerDocument.createElement("span");
    t.className = "blora-avatar blora-chat__avatar", t.dataset.size = "sm", t.dataset.variant = this.getAttribute("avatar-variant") ?? "info", t.textContent = this.getAttribute("avatar") ?? (this.getAttribute("author") ?? "?").slice(0, 1);
    const e = this.ownerDocument.createElement("div");
    e.className = "blora-chat__content";
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-chat__meta";
    const a = this.ownerDocument.createElement("span");
    a.textContent = this.getAttribute("author") ?? "";
    const i = this.ownerDocument.createElement("time");
    i.textContent = this.getAttribute("time") ?? "", r.append(a, i);
    const s = this.ownerDocument.createElement("div");
    s.className = "blora-chat__bubble", s.textContent = this.getAttribute("message") ?? "", e.append(r, s), l.append(t, e), this.replaceChildren(l);
  }
  sync() {
    const l = this.querySelector(".blora-chat");
    if (!l) return;
    l.classList.toggle("blora-chat--end", this.getAttribute("side") === "end");
    const t = l.querySelector(".blora-avatar");
    t && (t.dataset.variant = this.getAttribute("avatar-variant") ?? "info", t.textContent = this.getAttribute("avatar") ?? (this.getAttribute("author") ?? "?").slice(0, 1));
    const e = l.querySelector(".blora-chat__meta span");
    e && (e.textContent = this.getAttribute("author") ?? "");
    const r = l.querySelector("time");
    r && (r.textContent = this.getAttribute("time") ?? "");
    const a = l.querySelector(".blora-chat__bubble");
    a && (a.textContent = this.getAttribute("message") ?? "");
  }
  bindEvents() {
  }
}
function Li(n = customElements) {
  !n || n.get(Se) || n.define(Se, ma);
}
const Ne = "blora-comment";
function fa(n) {
  const l = n.getAttribute("slot");
  return n.localName === "blora-comment" || l === "nested" ? "nested" : l === "time" || l === "meta" ? "meta" : l === "avatar" || l === "author" || l === "actions" ? l : "body";
}
class ga extends B {
  constructor() {
    super(...arguments);
    A(this, "assigned", null);
  }
  render() {
    const t = this.takeAssigned(), e = this.ownerDocument, r = e.createElement("article");
    r.className = "blora-comment", r.dataset.bloraGenerated = "";
    const a = e.createElement("div");
    if (a.className = "blora-comment__main", t.author.length || t.meta.length) {
      const i = e.createElement("div");
      if (i.className = "blora-comment__head", t.author.length) {
        const s = e.createElement("span");
        s.className = "blora-comment__author", s.append(...this.take(t.author)), i.append(s);
      }
      if (t.meta.length) {
        const s = e.createElement("span");
        s.className = "blora-comment__time", s.append(...this.take(t.meta)), i.append(s);
      }
      a.append(i);
    }
    if (t.body.length) {
      const i = e.createElement("div");
      i.className = "blora-comment__body", i.append(...this.take(t.body)), a.append(i);
    }
    if (t.actions.length) {
      const i = e.createElement("div");
      i.className = "blora-comment__actions", i.append(...this.take(t.actions)), a.append(i);
    }
    if (t.nested.length) {
      const i = e.createElement("div");
      i.className = "blora-comment__nested", i.append(...this.take(t.nested)), a.append(i);
    }
    if (t.avatar.length) {
      const i = e.createElement("div");
      i.className = "blora-comment__avatar", i.append(...this.take(t.avatar)), r.append(i, a);
    } else
      r.append(a);
    this.replaceChildren(r);
  }
  bindEvents() {
  }
  takeAssigned() {
    var t;
    if (!this.assigned) {
      const e = {
        avatar: [],
        author: [],
        meta: [],
        body: [],
        actions: [],
        nested: []
      };
      for (const r of Array.from(this.childNodes))
        if (r.nodeType === Node.ELEMENT_NODE) {
          const a = r;
          if (a.hasAttribute("data-blora-generated")) continue;
          e[fa(a)].push(a);
        } else r.nodeType === Node.TEXT_NODE && ((t = r.textContent) != null && t.trim()) && e.body.push(r);
      this.assigned = e;
    }
    return this.assigned;
  }
  take(t) {
    var e;
    for (const r of t) (e = r.parentNode) == null || e.removeChild(r);
    return t;
  }
}
function qi(n = customElements) {
  n.get(Ne) || n.define(Ne, ga);
}
const De = "blora-empty";
class va extends B {
  static get observedAttributes() {
    return ["title", "description", "action-label"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  render() {
    const l = this.ownerDocument.createElement("div");
    l.className = "blora-empty", l.dataset.bloraGenerated = "", l.setAttribute("role", "status");
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-empty__icon";
    const e = I("inbox", 60, this.ownerDocument);
    e.setAttribute("stroke-width", "1.25"), t.appendChild(e);
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-empty__title", r.textContent = this.getAttribute("title") ?? v("empty.title");
    const a = this.ownerDocument.createElement("div");
    a.className = "blora-empty__desc", a.textContent = this.getAttribute("description") ?? "", l.append(t, r, a);
    const i = this.getAttribute("action-label");
    if (i) {
      const s = this.ownerDocument.createElement("button");
      s.className = "blora-button", s.dataset.variant = "primary", s.dataset.size = "sm", s.type = "button", s.textContent = i, s.dataset.emptyAction = "", l.appendChild(s);
    }
    this.replaceChildren(l);
  }
  sync() {
    const l = this.querySelector(".blora-empty__title");
    l && (l.textContent = this.getAttribute("title") ?? v("empty.title"));
    const t = this.querySelector(".blora-empty__desc");
    t && (t.textContent = this.getAttribute("description") ?? "");
    const e = this.getAttribute("action-label"), r = this.querySelector("[data-empty-action]");
    e && r ? r.textContent = e : e && !r ? (this.render(), this.rebind()) : !e && r && r.remove();
  }
  bindEvents() {
    const l = this.querySelector("[data-empty-action]");
    l && this.listen(l, "click", () => this.emit("blora-empty-action", void 0));
  }
}
function Ti(n = customElements) {
  !n || n.get(De) || n.define(De, va);
}
const Le = "blora-mockup";
class Aa extends B {
  constructor() {
    super(...arguments);
    A(this, "content", null);
  }
  static get observedAttributes() {
    return ["variant", "address", "title", "label"];
  }
  attributeChangedCallback(t) {
    if (this.isConnectedInternal) {
      if (t === "variant") {
        this.render();
        return;
      }
      this.sync();
    }
  }
  render() {
    this.content || (this.content = Array.from(this.childNodes).map((r) => r.cloneNode(!0)));
    const t = this.getAttribute("variant") ?? "browser", e = this.ownerDocument.createElement("section");
    if (e.className = `blora-mockup blora-mockup--${t}`, e.dataset.bloraGenerated = "", e.setAttribute("aria-label", this.getAttribute("label") ?? v("mockup.label", { variant: t })), t === "code")
      this.content.forEach((r) => {
        var a;
        if (r instanceof Element && r.localName === "blora-mockup-line") {
          const i = this.ownerDocument.createElement("pre");
          i.className = "blora-mockup__line";
          const s = r.getAttribute("tone");
          ["danger", "highlight", "info", "muted", "success", "warning"].includes(s ?? "") && i.classList.add(`blora-mockup__line--${s}`);
          const o = r.getAttribute("prefix");
          o != null && (i.dataset.prefix = o), i.append(...Array.from(r.childNodes).map((c) => c.cloneNode(!0))), e.appendChild(i);
          return;
        }
        (r.nodeType !== Node.TEXT_NODE || (a = r.textContent) != null && a.trim()) && e.appendChild(r.cloneNode(!0));
      });
    else if (t === "phone") {
      const r = this.ownerDocument.createElement("div");
      r.className = "blora-mockup__camera", r.setAttribute("aria-hidden", "true");
      const a = this.ownerDocument.createElement("div");
      a.className = "blora-mockup__display";
      const i = this.ownerDocument.createElement("div");
      i.className = "blora-mockup__display-body", i.append(...this.content.map((s) => s.cloneNode(!0))), a.appendChild(i), e.append(r, a);
    } else {
      const r = this.ownerDocument.createElement("div");
      r.className = "blora-mockup__toolbar";
      const a = this.ownerDocument.createElement("span");
      a.className = "blora-mockup__dots", a.setAttribute("aria-hidden", "true"), a.appendChild(this.ownerDocument.createElement("span")), r.appendChild(a);
      const i = this.ownerDocument.createElement(t === "browser" ? "div" : "span");
      i.className = t === "browser" ? "blora-mockup__address" : "blora-mockup__title", t === "browser" ? i.append(
        I("search", 16, this.ownerDocument),
        this.ownerDocument.createTextNode(this.getAttribute("address") ?? "about:blank")
      ) : i.textContent = this.getAttribute("title") ?? v("mockup.window"), r.appendChild(i);
      const s = this.ownerDocument.createElement("div");
      s.className = "blora-mockup__body", s.append(...this.content.map((o) => o.cloneNode(!0))), e.append(r, s);
    }
    this.replaceChildren(e);
  }
  sync() {
    const t = this.querySelector(".blora-mockup");
    if (!t) return;
    t.setAttribute(
      "aria-label",
      this.getAttribute("label") ?? v("mockup.label", { variant: this.getAttribute("variant") ?? "browser" })
    );
    const e = t.querySelector(".blora-mockup__address");
    e && e.replaceChildren(
      I("search", 16, this.ownerDocument),
      this.ownerDocument.createTextNode(this.getAttribute("address") ?? "about:blank")
    );
    const r = t.querySelector(".blora-mockup__title");
    r && (r.textContent = this.getAttribute("title") ?? v("mockup.window"));
  }
  bindEvents() {
  }
}
function Mi(n = customElements) {
  !n || n.get(Le) || n.define(Le, Aa);
}
const qe = "blora-navbar";
class ya extends B {
  constructor() {
    super(...arguments);
    A(this, "definitions", null);
  }
  static get observedAttributes() {
    return ["brand-href", "title", "variant"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter(
      (b) => b.localName === "blora-navbar-link" || b.localName === "blora-navbar-action" || b.localName === "blora-navbar-tool"
    ).map((b) => {
      var d;
      return {
        current: b.hasAttribute("current"),
        href: b.getAttribute("href") ?? "#",
        kind: b.localName === "blora-navbar-action" ? "action" : b.localName === "blora-navbar-tool" ? "tool" : "link",
        label: b.getAttribute("label") ?? ((d = b.textContent) == null ? void 0 : d.trim()) ?? "",
        nodes: Array.from(b.childNodes),
        variant: b.getAttribute("variant") ?? "outline"
      };
    }));
    const t = this.ownerDocument.createElement("nav");
    t.className = "blora-navbar", t.dataset.variant = this.getAttribute("variant") ?? "floating", t.dataset.bloraGenerated = "";
    const e = this.getAttribute("brand-href"), r = this.ownerDocument.createElement(e ? "a" : "div");
    r.className = "blora-navbar__brand", r instanceof HTMLAnchorElement && e && (r.href = e);
    const a = this.ownerDocument.createElement("span");
    a.className = "blora-brand-mark";
    const i = this.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    i.setAttribute("width", "20"), i.setAttribute("height", "20"), i.setAttribute("viewBox", "0 0 28 28"), i.setAttribute("fill", "currentColor"), i.setAttribute("aria-hidden", "true");
    for (const b of [
      "M5.564827499008331,11.30073113250122L8.613244389008331,9.55578903250122L7.719039689008332,7.993611832501221L4.670622762008331,9.73855403250122Q3.7145057890083315,10.285843332501221,3.714505549008331,11.38751893250122L3.714505909008331,21.189404032501223Q3.714505909008331,22.29107703250122,4.670622762008331,22.838368032501222L13.24553848900833,27.74672703250122Q14.189421489008332,28.28701603250122,15.133306589008331,27.746726032501222L23.70821758900833,22.838368032501222Q24.664333589008333,22.29107903250122,24.664333589008333,21.189403032501218L24.664333589008333,11.38751893250122Q24.664333589008333,10.285842932501222,23.708221589008332,9.73855403250122L15.144333589008331,4.836507112501221Q14.17949278900833,4.28422363250122,13.225343489008331,4.854777572501221L12.235854489008332,5.44646401250122L13.159642089008331,6.991331832501221L14.149129689008332,6.399646032501221Q14.19934828900833,6.369617032501221,14.250129489008332,6.398684332501221L22.81401458900833,11.30073023250122Q22.864333589008332,11.32953453250122,22.864333589008332,11.38751893250122L22.864333589008332,21.189403032501218Q22.864333589008332,21.24738603250122,22.814012589008332,21.27619003250122L14.23909738900833,26.18455203250122Q14.18942048900833,26.212988032501222,14.139742689008331,26.18455003250122L5.564828579008331,21.27619103250122Q5.514505799008331,21.24738603250122,5.514505799008331,21.189404032501223L5.514505449008332,11.38751893250122Q5.514505449008332,11.329536432501222,5.564827499008331,11.30073113250122Z",
      "M13.676674393811036,9.8286476L13.676419693811035,2.5857831Q13.676392093811035,1.76404774,12.958911393811036,1.3634555L11.142991493811035,0.34957015999999996Q10.464049593811035,-0.02950469999999994,9.783433893811035,0.34655654L7.945791753811035,1.36191076Q7.222857173811035,1.76135367,7.222857173811035,2.5873014000000003L7.222857173811035,19.634758Q7.222857173811035,20.456587,7.940433573811035,20.85717L13.577110793811034,24.003897Q14.267833193811036,24.3895,14.954539293811035,23.996788L20.450968093811035,20.853519Q21.155953093811036,20.450346,21.155953093811036,19.638218L21.155953093811036,13.368428Q21.155953093811036,12.541971,20.432357093811035,12.142673L15.606700893811034,9.4797554Q14.896982193811034,9.0881147,14.203994293811036,9.5086489L13.676674393811036,9.8286476ZM11.876428093811036,2.8206283L10.459485793811035,2.0295045L9.022857013811034,2.8232863L9.022857013811034,19.39995L14.257165393811036,22.322048L19.355953093811035,19.406179L19.355953093811035,13.604559L14.939816993811036,11.167625L14.003004993811036,11.736121Q13.303271793811035,12.160748,12.589999693811034,11.759276Q11.876728293811034,11.357804,11.876699493811035,10.5393085L11.876428093811036,2.8206283Z",
      "M11.361768030889893,4.572254157627869L13.073605530889893,3.6714597976278687L12.235387530889893,2.0785409176278686L10.461767930889893,3.0118460176278687L8.688148500889893,2.0785409176278686L7.849930760889893,3.6714597976278687L9.561768330889892,4.572254157627869L9.561768330889892,13.981741357627868Q9.561768330889892,14.793980357627868,10.267906530889892,15.196923357627869L13.397947330889892,16.98302035762787L13.397947330889892,23.35577235762787L15.197947030889893,23.35577235762787L15.197947030889893,16.97939035762787L20.706725630889892,13.791639357627869L19.805188630889894,12.233682957627869L14.294810730889893,15.422357357627869L11.361768030889893,13.748672357627868L11.361768030889893,4.572254157627869Z"
    ]) {
      const d = this.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
      d.setAttribute("d", b), d.setAttribute("fill-rule", "evenodd"), i.appendChild(d);
    }
    a.appendChild(i);
    const s = this.ownerDocument.createElement("span");
    s.className = "blora-navbar__title", s.textContent = this.getAttribute("title") ?? v("navbar.title"), r.append(a, s);
    const o = this.ownerDocument.createElement("div");
    o.className = "blora-navbar__menu";
    const c = this.ownerDocument.createElement("div");
    c.className = "blora-navbar__actions";
    const u = this.ownerDocument.createElement("div");
    u.className = "blora-navbar__tools", this.definitions.forEach((b) => {
      if (b.kind === "tool") {
        u.append(...b.nodes);
        return;
      }
      const d = this.ownerDocument.createElement("a");
      d.href = b.href, d.textContent = b.label, b.kind === "link" ? (d.className = "blora-navbar__link", b.current && d.setAttribute("aria-current", "page"), o.appendChild(d)) : (d.className = `blora-button blora-navbar__${b.variant === "primary" ? "cta" : "secondary"}`, d.dataset.variant = b.variant, d.dataset.size = "sm", c.appendChild(d));
    }), u.childNodes.length > 0 && c.prepend(u), t.append(r, o, c), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-navbar");
    if (!t) return;
    const e = this.getAttribute("brand-href"), r = t.querySelector(".blora-navbar__brand");
    if (e && !(r instanceof HTMLAnchorElement)) {
      this.render();
      return;
    }
    r instanceof HTMLAnchorElement && e && (r.href = e);
    const a = t.querySelector(".blora-navbar__title");
    a && (a.textContent = this.getAttribute("title") ?? v("navbar.title")), t.dataset.variant = this.getAttribute("variant") ?? "floating";
  }
  bindEvents() {
  }
}
function Bi(n = customElements) {
  !n || n.get(qe) || n.define(qe, ya);
}
const Te = "blora-sidebar-nav";
class _a extends B {
  constructor() {
    super(...arguments);
    A(this, "definitions", null);
    A(this, "reflecting", !1);
  }
  static get observedAttributes() {
    return ["label", "value"];
  }
  attributeChangedCallback(t) {
    var e;
    if (!(!this.isConnectedInternal || this.reflecting)) {
      if (t === "label") {
        (e = this.querySelector(".blora-sidebar-nav")) == null || e.setAttribute(
          "aria-label",
          this.getAttribute("label") ?? v("sidebar.label")
        );
        return;
      }
      this.syncCurrent();
    }
  }
  get value() {
    var t;
    return this.getAttribute("value") ?? ((t = this.querySelector('.blora-sidebar-nav__link[aria-current="page"]')) == null ? void 0 : t.dataset.value) ?? "";
  }
  set value(t) {
    this.select(t);
  }
  select(t) {
    t ? this.setAttribute("value", t) : this.removeAttribute("value"), this.isConnectedInternal && this.syncCurrent();
  }
  render() {
    var r;
    this.definitions || (this.definitions = this.readDefinitions());
    const t = this.getAttribute("value") ?? ((r = this.definitions.flatMap((a) => a.links).find((a) => a.current)) == null ? void 0 : r.value) ?? "";
    t && !this.hasAttribute("value") && (this.reflecting = !0, this.setAttribute("value", t), this.reflecting = !1);
    const e = this.ownerDocument.createElement("nav");
    e.className = "blora-sidebar-nav", e.dataset.bloraGenerated = "", e.setAttribute("aria-label", this.getAttribute("label") ?? v("sidebar.label"));
    for (const a of this.definitions) {
      const i = this.ownerDocument.createElement("div");
      if (i.className = "blora-sidebar-nav__group", i.setAttribute("role", "group"), a.label) {
        i.setAttribute("aria-label", a.label);
        const s = this.ownerDocument.createElement("div");
        s.className = "blora-sidebar-nav__group-label", s.textContent = a.label, s.setAttribute("aria-hidden", "true"), i.appendChild(s);
      }
      for (const s of a.links) {
        const o = this.ownerDocument.createElement("a");
        o.className = "blora-sidebar-nav__link", o.href = s.href, o.textContent = s.label, o.dataset.value = s.value, s.value === t && o.setAttribute("aria-current", "page"), i.appendChild(o);
      }
      e.appendChild(i);
    }
    this.replaceChildren(e);
  }
  bindEvents() {
    const t = this.querySelector(".blora-sidebar-nav");
    t && this.listen(t, "click", (e) => {
      const r = e.target, a = r == null ? void 0 : r.closest(".blora-sidebar-nav__link");
      if (!a || !t.contains(a)) return;
      const i = a.dataset.value ?? "";
      this.select(i), this.emit("blora-change", {
        href: a.getAttribute("href") ?? "",
        value: i
      });
    });
  }
  readDefinitions() {
    const t = [], e = [];
    for (const r of Array.from(this.children))
      r.localName === "blora-sidebar-nav-group" ? t.push({
        label: r.getAttribute("label") ?? "",
        links: Array.from(r.children).filter((a) => a.localName === "blora-sidebar-nav-link").map((a, i) => this.readLink(a, i))
      }) : r.localName === "blora-sidebar-nav-link" && e.push(this.readLink(r, e.length));
    return e.length && t.unshift({ label: "", links: e }), t.filter((r) => r.links.length > 0);
  }
  readLink(t, e) {
    var s;
    const r = t.getAttribute("href") ?? "#", a = t.getAttribute("label") ?? ((s = t.textContent) == null ? void 0 : s.trim()) ?? "", i = t.getAttribute("value") ?? (r.replace(/^#/, "") || `item-${e + 1}`);
    return { current: t.hasAttribute("current"), href: r, label: a, value: i };
  }
  syncCurrent() {
    const t = this.getAttribute("value") ?? "";
    for (const e of this.querySelectorAll(".blora-sidebar-nav__link"))
      t && e.dataset.value === t ? e.setAttribute("aria-current", "page") : e.removeAttribute("aria-current");
  }
}
function Ii(n = customElements) {
  !n || n.get(Te) || n.define(Te, _a);
}
const Me = "blora-result";
class Ea extends B {
  static get observedAttributes() {
    return ["variant", "title", "description"];
  }
  attributeChangedCallback() {
    this.isConnectedInternal && this.sync();
  }
  render() {
    const l = this.getAttribute("variant") ?? "info", t = this.ownerDocument.createElement("div");
    t.className = "blora-result", t.dataset.variant = l, t.dataset.bloraGenerated = "", t.setAttribute("role", "status");
    const e = this.ownerDocument.createElement("div");
    e.className = "blora-result__icon", e.appendChild(ut(this.ownerDocument, l, 48));
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-result__title", r.textContent = this.getAttribute("title") ?? "";
    const a = this.ownerDocument.createElement("div");
    a.className = "blora-result__desc", a.textContent = this.getAttribute("description") ?? "", t.append(e, r, a), this.replaceChildren(t);
  }
  sync() {
    const l = this.querySelector(".blora-result");
    if (!l) return;
    const t = this.getAttribute("variant") ?? "info";
    l.dataset.variant = t;
    const e = l.querySelector(".blora-result__icon");
    e && e.replaceChildren(ut(this.ownerDocument, t, 48));
    const r = l.querySelector(".blora-result__title");
    r && (r.textContent = this.getAttribute("title") ?? "");
    const a = l.querySelector(".blora-result__desc");
    a && (a.textContent = this.getAttribute("description") ?? "");
  }
  bindEvents() {
  }
}
function Oi(n = customElements) {
  !n || n.get(Me) || n.define(Me, Ea);
}
const Be = "blora-timeline";
class Ca extends B {
  constructor() {
    super(...arguments);
    A(this, "definitions", null);
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((e) => e.localName === "blora-timeline-item").map((e) => {
      var a;
      const r = Array.from(e.childNodes).filter(
        (i) => !(i.nodeType === Node.ELEMENT_NODE && i.hasAttribute("data-blora-generated"))
      );
      return {
        description: e.getAttribute("description") ?? "",
        time: e.getAttribute("time") ?? "",
        // Only fall back to textContent for plain text items; items carrying
        // custom child content render that in .blora-timeline__content instead.
        title: e.getAttribute("title") ?? (r.length ? "" : ((a = e.textContent) == null ? void 0 : a.trim()) ?? ""),
        variant: e.getAttribute("variant") ?? "",
        icon: e.getAttribute("icon") ?? "",
        contentLayout: e.getAttribute("content-layout") === "block" ? "block" : "inline",
        nodes: r
      };
    }));
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-timeline", t.dataset.bloraGenerated = "", t.setAttribute("role", "list"), this.definitions.forEach((e) => {
      var i;
      const r = this.ownerDocument.createElement("div");
      r.className = "blora-timeline__item", r.setAttribute("role", "listitem");
      const a = this.ownerDocument.createElement("div");
      if (a.className = "blora-timeline__dot", e.icon ? (a.classList.add("blora-timeline__dot--icon"), a.append(I(e.icon, 14, this.ownerDocument))) : e.variant && (a.dataset.variant = e.variant), r.appendChild(a), e.nodes.length) {
        for (const c of e.nodes) (i = c.parentNode) == null || i.removeChild(c);
        const s = this.ownerDocument.createElement("div");
        s.className = "blora-timeline__row", s.dataset.layout = e.contentLayout;
        const o = this.ownerDocument.createElement("div");
        if (o.className = "blora-timeline__content", o.append(...e.nodes), s.appendChild(o), e.time) {
          const c = this.ownerDocument.createElement("div");
          c.className = "blora-timeline__time", c.textContent = e.time, s.appendChild(c);
        }
        r.appendChild(s);
      } else {
        const s = this.ownerDocument.createElement("div");
        if (s.className = "blora-timeline__time", s.textContent = e.time, r.appendChild(s), e.title) {
          const o = this.ownerDocument.createElement("div");
          o.className = "blora-timeline__title", o.textContent = e.title, r.appendChild(o);
        }
        if (e.description) {
          const o = this.ownerDocument.createElement("div");
          o.className = "blora-timeline__desc", o.textContent = e.description, r.appendChild(o);
        }
      }
      t.appendChild(r);
    }), this.replaceChildren(t);
  }
  bindEvents() {
  }
}
function Pi(n = customElements) {
  !n || n.get(Be) || n.define(Be, Ca);
}
export {
  qi as $,
  ni as A,
  ii as B,
  si as C,
  oi as D,
  li as E,
  ci as F,
  ui as G,
  di as H,
  bi as I,
  hi as J,
  pi as K,
  mi as L,
  fi as M,
  gi as N,
  vi as O,
  Ai as P,
  yi as Q,
  _i as R,
  Ei as S,
  Ci as T,
  wi as U,
  xi as V,
  ki as W,
  Si as X,
  Ni as Y,
  Di as Z,
  Li as _,
  Ta as a,
  ue as a$,
  Ti as a0,
  Mi as a1,
  Bi as a2,
  Ii as a3,
  Oi as a4,
  Pi as a5,
  ut as a6,
  yt as a7,
  Ce as a8,
  se as a9,
  Zt as aA,
  Rt as aB,
  ee as aC,
  Wt as aD,
  Yt as aE,
  Jt as aF,
  Bt as aG,
  kt as aH,
  Pt as aI,
  Me as aJ,
  _t as aK,
  St as aL,
  Te as aM,
  Ot as aN,
  ye as aO,
  _e as aP,
  Tt as aQ,
  Mt as aR,
  te as aS,
  It as aT,
  Nt as aU,
  Gt as aV,
  Be as aW,
  Lt as aX,
  zt as aY,
  Ee as aZ,
  qt as a_,
  jt as aa,
  we as ab,
  xe as ac,
  de as ad,
  pe as ae,
  le as af,
  ke as ag,
  Se as ah,
  $t as ai,
  vt as aj,
  ne as ak,
  Et as al,
  Ne as am,
  Qt as an,
  Ct as ao,
  fe as ap,
  ve as aq,
  Kt as ar,
  Ut as as,
  De as at,
  Ft as au,
  ge as av,
  Ae as aw,
  oe as ax,
  Le as ay,
  qe as az,
  Ia as b,
  ai as b$,
  ce as b0,
  Vt as b1,
  gr as b2,
  da as b3,
  Cn as b4,
  dn as b5,
  ba as b6,
  ha as b7,
  Hn as b8,
  zn as b9,
  mn as bA,
  Fr as bB,
  Fe as bC,
  zr as bD,
  Ea as bE,
  $e as bF,
  Dr as bG,
  _a as bH,
  Ve as bI,
  ta as bJ,
  ra as bK,
  Rr as bL,
  $r as bM,
  fn as bN,
  He as bO,
  Mr as bP,
  Ye as bQ,
  Ca as bR,
  Ir as bS,
  Zr as bT,
  ca as bU,
  Pr as bV,
  On as bW,
  Gn as bX,
  Ue as bY,
  cr as bZ,
  bt as b_,
  Tn as ba,
  pa as bb,
  ma as bc,
  We as bd,
  mr as be,
  _n as bf,
  Er as bg,
  ga as bh,
  hn as bi,
  kr as bj,
  Wn as bk,
  jn as bl,
  cn as bm,
  sn as bn,
  va as bo,
  jr as bp,
  Kn as bq,
  Jn as br,
  Ln as bs,
  Aa as bt,
  ya as bu,
  Xe as bv,
  ze as bw,
  vn as bx,
  nn as by,
  en as bz,
  Oa as c,
  rr as c0,
  Ma as d,
  Pa as e,
  Ba as f,
  Ra as g,
  Ga as h,
  $a as i,
  Fa as j,
  Ha as k,
  Va as l,
  za as m,
  Ya as n,
  qa as o,
  Wa as p,
  Ua as q,
  Ka as r,
  Xa as s,
  ja as t,
  Qa as u,
  Ja as v,
  Za as w,
  ti as x,
  ei as y,
  ri as z
};
