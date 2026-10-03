var er = Object.defineProperty;
var rr = (a, l, t) => l in a ? er(a, l, { enumerable: !0, configurable: !0, writable: !0, value: t }) : a[l] = t;
var A = (a, l, t) => rr(a, typeof l != "symbol" ? l + "" : l, t);
import { B, O as dt } from "./blora-element-Cn5j6OzD.js";
import { c as I } from "./icons-PjqNgrW5.js";
import { t as g, c as Te, b as Me } from "./i18n-Duo0HNK5.js";
import { w as rt } from "./dialog-D8W4uPbO.js";
const mt = "blora-collapse";
let nr = 0;
const st = ".blora-collapse__item, .blora-accordion__item", lt = ".blora-collapse__head, .blora-accordion__head", ar = ".blora-collapse__body, .blora-accordion__body";
function tt(a) {
  return a.hasAttribute("data-open");
}
function ht(a) {
  return a.querySelector(ar);
}
function ct(a) {
  const l = a.firstElementChild, t = a.scrollHeight, e = l ? Math.max(l.scrollHeight, l.offsetHeight, l.getBoundingClientRect().height) : 0;
  return Math.ceil(Math.max(t, e, 1));
}
function pt(a, l) {
  a.style.setProperty("--blora-collapse-h", `${l}px`);
}
function ir(a) {
  a.style.maxHeight = "";
}
function sr(a) {
  const l = ht(a), t = a.querySelector(lt);
  if (!l) return;
  const e = ct(l);
  pt(l, e), a.setAttribute("data-open", ""), t == null || t.setAttribute("aria-expanded", "true"), l.setAttribute("aria-hidden", "false");
  const r = (n) => {
    n.propertyName === "max-height" && (l.removeEventListener("transitionend", r), tt(a) && (l.style.maxHeight = "none"));
  };
  l.addEventListener("transitionend", r);
}
function ft(a) {
  const l = ht(a), t = a.querySelector(lt);
  if (!l) return;
  const e = l.style.maxHeight === "none" || !l.style.maxHeight ? ct(l) : l.scrollHeight || ct(l);
  pt(l, e), l.style.maxHeight = `${e}px`, l.offsetHeight, a.removeAttribute("data-open"), t == null || t.setAttribute("aria-expanded", "false"), l.setAttribute("aria-hidden", "true"), requestAnimationFrame(() => {
    l.style.maxHeight = "";
  });
}
function Be(a) {
  if (typeof document > "u") return { destroy: () => {
  } };
  a.querySelectorAll(st).forEach((t) => {
    const e = ht(t);
    if (e)
      if (tt(t)) {
        const r = ct(e);
        pt(e, r), e.style.maxHeight = "none", e.setAttribute("aria-hidden", "false");
      } else
        e.style.removeProperty("--blora-collapse-h"), ir(e), e.setAttribute("aria-hidden", "true");
  });
  const l = (t) => {
    const e = t.target.closest(lt);
    if (!e || !a.contains(e)) return;
    const r = e.closest(st);
    if (!r) return;
    const n = r.closest("[data-blora-accordion]") || (a.hasAttribute("data-blora-accordion") || a.classList.contains("blora-accordion") ? a : null), i = tt(r);
    n && !i && n.querySelectorAll(st).forEach((s) => {
      s !== r && tt(s) && ft(s);
    }), i ? ft(r) : sr(r);
  };
  return a.addEventListener("click", l), a.querySelectorAll(lt).forEach((t) => {
    const e = t.closest(st);
    t.setAttribute("aria-expanded", String(!!e && tt(e)));
  }), {
    destroy() {
      a.removeEventListener("click", l);
    }
  };
}
class or extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "instanceId", ++nr);
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
      const n = document.createElement("div");
      n.className = "blora-collapse__item", r.open && (n.dataset.open = "");
      const i = document.createElement("button");
      i.className = "blora-collapse__head", i.type = "button", i.disabled = r.disabled, i.id = `blora-collapse-head-${this.instanceId}-${e}`, i.setAttribute("aria-expanded", String(r.open));
      const s = document.createElement("span");
      s.textContent = r.heading;
      const o = document.createElement("span");
      o.className = "blora-collapse__icon", o.appendChild(I("chevron-right", 14)), i.append(s, o);
      const c = document.createElement("div");
      c.className = "blora-collapse__body", c.id = `blora-collapse-panel-${this.instanceId}-${e}`, c.setAttribute("role", "region"), c.setAttribute("aria-labelledby", i.id), c.setAttribute("aria-hidden", String(!r.open)), i.setAttribute("aria-controls", c.id);
      const u = document.createElement("div");
      u.className = "blora-collapse__content", u.append(...r.content), c.appendChild(u), n.append(i, c), t.appendChild(n);
    }
    this.replaceChildren(t);
  }
  bindEvents() {
    const t = this.querySelector(".blora-collapse");
    t && (this.controller = Be(t));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Ea(a = customElements) {
  !a || a.get(mt) || a.define(mt, or);
}
const gt = "blora-accordion";
let lr = 0;
class cr extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "instanceId", ++lr);
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
      const n = document.createElement("div");
      n.className = "blora-accordion__item", r.open && (n.dataset.open = "");
      const i = document.createElement("button");
      i.className = "blora-accordion__head", i.type = "button", i.disabled = r.disabled, i.id = `blora-accordion-head-${this.instanceId}-${e}`, i.setAttribute("aria-expanded", String(r.open));
      const s = document.createElement("span");
      s.textContent = r.heading;
      const o = document.createElement("span");
      o.className = "blora-accordion__icon", o.appendChild(I("chevron-right", 14)), i.append(s, o);
      const c = document.createElement("div");
      c.className = "blora-accordion__body", c.id = `blora-accordion-panel-${this.instanceId}-${e}`, c.setAttribute("role", "region"), c.setAttribute("aria-labelledby", i.id), c.setAttribute("aria-hidden", String(!r.open)), i.setAttribute("aria-controls", c.id);
      const u = document.createElement("div");
      u.className = "blora-accordion__content", u.append(...r.content), c.appendChild(u), n.append(i, c), t.appendChild(n);
    }
    this.replaceChildren(t);
  }
  bindEvents() {
    const t = this.querySelector(".blora-accordion");
    t && (this.controller = Be(t));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Ca(a = customElements) {
  !a || a.get(gt) || a.define(gt, cr);
}
function X(a) {
  const l = a;
  if (typeof l.attachInternals != "function") return null;
  try {
    return l.attachInternals();
  } catch {
    return null;
  }
}
function Y(a, l) {
  typeof (a == null ? void 0 : a.setFormValue) == "function" && a.setFormValue(l);
}
const vt = "blora-search";
function Ie(a) {
  const l = a.querySelector("input"), t = a.querySelector(".blora-search__clear");
  if (!l) return { destroy: () => {
  } };
  const e = () => {
    t && (t.hidden = l.value.length === 0);
  }, r = () => e(), n = (i) => {
    i.preventDefault(), l.value = "", e(), l.focus();
  };
  return l.addEventListener("input", r), t == null || t.addEventListener("click", n), e(), {
    destroy() {
      l.removeEventListener("input", r), t == null || t.removeEventListener("click", n);
    }
  };
}
class Oe extends B {
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
    e.className = "blora-search__icon", e.type = "button", e.setAttribute("aria-label", this.getAttribute("label") ?? g("search.label")), e.appendChild(I("search"));
    const r = document.createElement("input");
    r.className = "blora-input", r.type = "search", r.value = this.getAttribute("value") ?? "", r.placeholder = this.getAttribute("placeholder") ?? g("search.placeholder"), r.disabled = this.hasAttribute("disabled"), r.required = this.hasAttribute("required"), r.name = this.internals ? "" : this.getAttribute("name") ?? "";
    const n = document.createElement("button");
    n.className = "blora-search__clear", n.type = "button", n.hidden = r.value.length === 0, n.disabled = r.disabled, n.setAttribute("aria-label", g("common.clear")), n.appendChild(I("close")), t.append(e, r, n), this.replaceChildren(t), this.syncFormValue();
  }
  sync() {
    const t = this.querySelector(".blora-input");
    if (!t) return;
    document.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value), t.placeholder = this.getAttribute("placeholder") ?? g("search.placeholder"), t.disabled = this.hasAttribute("disabled"), t.required = this.hasAttribute("required"), t.name = this.internals ? "" : this.getAttribute("name") ?? "";
    const e = this.querySelector(".blora-search__clear");
    e && (e.hidden = t.value.length === 0, e.disabled = t.disabled);
    const r = this.querySelector(".blora-search__icon");
    r && r.setAttribute("aria-label", this.getAttribute("label") ?? g("search.label")), this.syncFormValue();
  }
  bindEvents() {
    var r;
    const t = this.querySelector(".blora-search");
    (r = this.controller) == null || r.destroy(), this.controller = t ? Ie(t) : null;
    const e = this.querySelector(".blora-input");
    e && this.listen(e, "input", () => this.syncFormValue());
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
A(Oe, "formAssociated", !0);
function wa(a = customElements) {
  !a || a.get(vt) || a.define(vt, Oe);
}
const At = "blora-command";
function ur() {
  if (typeof navigator < "u") {
    const a = navigator.platform || "", l = navigator.userAgent || "";
    if (/Mac|iPhone|iPad|iPod/i.test(a) || /Mac OS X/i.test(l)) return "⌘";
  }
  return "Ctrl+";
}
function dr(a) {
  const l = a.querySelector("input"), t = a.querySelector(".blora-cmdk-results, .blora-command__results") || a, e = () => Array.from(t.querySelectorAll(".blora-cmdk-item, .blora-command__item")), r = ur();
  a.querySelectorAll("kbd[data-keys], .blora-command__kbd, .blora-cmdk-kbd").forEach((c) => {
    const u = c.dataset.keys || c.textContent || "";
    c.textContent = u.replace(/^(⌘|Ctrl\+?|ctrl\+?)/, r === "⌘" ? "⌘" : "Ctrl+"), c.dataset.keys || (c.dataset.keys = u);
  });
  let n = 0;
  const i = () => {
    const c = e().filter((b) => b.style.display !== "none");
    c.forEach((b, d) => {
      b.toggleAttribute("data-active", d === n), b.setAttribute("aria-selected", d === n ? "true" : "false");
    });
    const u = c[n];
    l && (u != null && u.id) && l.setAttribute("aria-activedescendant", u.id);
  }, s = () => {
    const c = ((l == null ? void 0 : l.value) || "").trim().toLowerCase();
    e().forEach((u, b) => {
      const d = (u.textContent || "").toLowerCase(), m = !c || d.includes(c);
      u.style.display = m ? "" : "none";
    }), n = 0, i();
  }, o = (c) => {
    var b;
    const u = e().filter((d) => d.style.display !== "none");
    u.length && (c.key === "ArrowDown" ? (c.preventDefault(), n = Math.min(u.length - 1, n + 1), i()) : c.key === "ArrowUp" ? (c.preventDefault(), n = Math.max(0, n - 1), i()) : c.key === "Enter" && (c.preventDefault(), (b = u[n]) == null || b.click()));
  };
  return e().forEach((c) => {
    c.addEventListener("mouseenter", () => {
      n = e().filter((b) => b.style.display !== "none").indexOf(c), i();
    }), c.addEventListener("click", () => {
      var u;
      a.dispatchEvent(
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
const br = /* @__PURE__ */ new Set(["document", "folder", "search", "settings"]);
let hr = 0;
class pr extends B {
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
        icon: br.has(u) ? u : "document",
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
    const n = document.createElement("span");
    n.className = "blora-search__icon", n.setAttribute("aria-hidden", "true"), n.appendChild(I("search"));
    const i = document.createElement("input");
    i.className = "blora-input", i.type = "search", i.setAttribute("role", "combobox"), i.setAttribute("aria-autocomplete", "list"), i.setAttribute("aria-expanded", this.hasAttribute("open") ? "true" : "false"), i.placeholder = this.getAttribute("placeholder") ?? g("command.placeholder");
    const s = document.createElement("button");
    s.className = "blora-search__clear", s.type = "button", s.hidden = !0, s.setAttribute("aria-label", g("command.clear")), s.appendChild(I("close")), r.append(n, i, s), e.appendChild(r);
    const o = document.createElement("div");
    o.className = "blora-cmdk-results blora-command__results", o.id = `blora-command-list-${++hr}`, o.setAttribute("role", "listbox"), i.setAttribute("aria-controls", o.id), this.definitions.forEach((c, u) => {
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
    t && (t.placeholder = this.getAttribute("placeholder") ?? g("command.placeholder"));
  }
  bindEvents() {
    var r, n;
    const t = this.querySelector(".blora-command"), e = t == null ? void 0 : t.querySelector(".blora-search");
    t && ((r = this.controller) == null || r.destroy(), (n = this.searchController) == null || n.destroy(), this.controller = dr(t), e && (this.searchController = Ie(e)), this.listen(this, "pointerdown", (i) => {
      i.target === this && this.hasAttribute("open") && this.close();
    }), this.listen(this, "keydown", (i) => {
      i.key === "Escape" && this.hasAttribute("open") && (i.preventDefault(), this.close());
    }));
  }
  onDisconnect() {
    var t, e, r, n;
    (t = this.cancelCloseMotion) == null || t.call(this), this.cancelCloseMotion = null, (e = this.overlay) == null || e.close(), this.overlay = null, this.dismissTopLayer(), (r = this.controller) == null || r.destroy(), (n = this.searchController) == null || n.destroy(), this.controller = null, this.searchController = null, this.restoreHome();
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
function xa(a = customElements) {
  !a || a.get(At) || a.define(At, pr);
}
const yt = "blora-datepicker", _t = () => Te(), mr = () => Me(), Et = (a, l) => {
  a.replaceChildren(
    I(l === "prev" ? "chevron-left" : "chevron-right", 14, a.ownerDocument)
  );
};
function bt(a) {
  return a.getFullYear() + "-" + String(a.getMonth() + 1).padStart(2, "0") + "-" + String(a.getDate()).padStart(2, "0");
}
function fr(a) {
  const l = a.split("-");
  if (l.length !== 3) return null;
  const t = new Date(Number(l[0]), Number(l[1]) - 1, Number(l[2]));
  return Number.isNaN(t.getTime()) ? null : t;
}
function gr(a) {
  const l = a.querySelector("input"), t = a.querySelector(".blora-datepicker__btn");
  if (!l) return { destroy: () => {
  } };
  l.type !== "date" && (l.type = "date");
  const e = l.min, r = l.max;
  let n = null, i = (/* @__PURE__ */ new Date()).getFullYear(), s = (/* @__PURE__ */ new Date()).getMonth(), o = "days";
  const c = /* @__PURE__ */ new Date();
  let u = !1, b = a.querySelector(".blora-datepicker__panel");
  b || (b = document.createElement("div"), b.className = "blora-datepicker__panel", a.appendChild(b));
  const d = (_) => {
    const C = bt(_);
    return !(e && C < e || r && C > r);
  }, m = () => {
    if (l.value) {
      const _ = fr(l.value);
      if (_) {
        n = _, i = _.getFullYear(), s = _.getMonth();
        return;
      }
    }
    n = null, i || (i = c.getFullYear(), s = c.getMonth());
  }, p = (_, C, L) => {
    const T = document.createElement(_);
    return C && (T.className = C), L != null && (T.textContent = L), T;
  }, h = () => {
    b.replaceChildren();
    const _ = p("div", "blora-datepicker__head"), C = p("button", "blora-datepicker__nav");
    C.setAttribute("type", "button"), C.setAttribute("data-nav", "prev"), C.setAttribute("aria-label", g("calendar.prev")), Et(C, "prev");
    const L = p("button", "blora-datepicker__nav");
    L.setAttribute("type", "button"), L.setAttribute("data-nav", "next"), L.setAttribute("aria-label", g("calendar.next")), Et(L, "next");
    let T = "", f = null;
    if (o === "days")
      T = g("calendar.monthYear", {
        year: i,
        month: _t()[s] ?? ""
      }), f = "months";
    else if (o === "months")
      T = g("calendar.year", { year: i }), f = "years";
    else {
      const M = Math.floor(i / 10) * 10;
      T = g("calendar.decade", { start: M, end: M + 9 });
    }
    const k = p("span", "blora-datepicker__title", T);
    if (f && k.setAttribute("data-zoom", f), _.append(C, k, L), b.appendChild(_), o === "days") {
      const M = p("div", "blora-datepicker__grid");
      mr().forEach(($) => M.appendChild(p("div", "blora-datepicker__dow", $)));
      const O = new Date(i, s, 1).getDay(), R = new Date(i, s + 1, 0).getDate(), G = new Date(i, s, 0).getDate();
      for (let $ = O - 1; $ >= 0; $--) {
        const H = p("div", "blora-datepicker__cell", String(G - $));
        H.setAttribute("data-other", ""), M.appendChild(H);
      }
      for (let $ = 1; $ <= R; $++) {
        const H = new Date(i, s, $), V = p("div", "blora-datepicker__cell", String($));
        V.setAttribute("data-day", String($)), H.toDateString() === c.toDateString() && V.setAttribute("data-today", ""), n && H.toDateString() === n.toDateString() && V.setAttribute("data-selected", ""), d(H) || V.setAttribute("disabled", ""), M.appendChild(V);
      }
      const W = (7 - (O + R) % 7) % 7;
      for (let $ = 1; $ <= W; $++) {
        const H = p("div", "blora-datepicker__cell", String($));
        H.setAttribute("data-other", ""), M.appendChild(H);
      }
      b.appendChild(M);
    } else if (o === "months") {
      const M = p("div", "blora-datepicker__grid blora-datepicker__grid--months");
      _t().forEach((P, O) => {
        const R = p("div", "blora-datepicker__cell blora-datepicker__cell--month", P);
        R.setAttribute("data-month", String(O)), n && i === n.getFullYear() && O === n.getMonth() && R.setAttribute("data-selected", ""), i === c.getFullYear() && O === c.getMonth() && R.setAttribute("data-today", ""), M.appendChild(R);
      }), b.appendChild(M);
    } else {
      const M = Math.floor(i / 10) * 10, P = p("div", "blora-datepicker__grid blora-datepicker__grid--years");
      for (let O = M - 1; O <= M + 10; O++) {
        const R = p("div", "blora-datepicker__cell blora-datepicker__cell--year", String(O));
        R.setAttribute("data-year", String(O)), (O < M || O > M + 9) && R.setAttribute("data-other", ""), n && O === n.getFullYear() && R.setAttribute("data-selected", ""), O === c.getFullYear() && R.setAttribute("data-today", ""), P.appendChild(R);
      }
      b.appendChild(P);
    }
    const S = p("div", "blora-datepicker__foot"), N = p("button", "blora-button");
    N.setAttribute("type", "button"), N.setAttribute("data-variant", "ghost"), N.setAttribute("data-size", "sm"), N.setAttribute("data-clear", ""), N.textContent = g("common.clear");
    const q = p("button", "blora-button");
    q.setAttribute("type", "button"), q.setAttribute("data-variant", "ghost"), q.setAttribute("data-size", "sm"), q.setAttribute("data-today", ""), q.textContent = g("common.today"), S.append(N, q), b.appendChild(S);
  }, E = () => {
    m(), o = "days", b.setAttribute("data-open", ""), a.style.zIndex = "var(--blora-z-dropdown)", h();
  }, y = () => {
    b.removeAttribute("data-open"), a.style.zIndex = "";
  }, v = (_) => {
    _.preventDefault(), _.stopPropagation(), b.hasAttribute("data-open") ? y() : (u = !0, E(), queueMicrotask(() => {
      u = !1;
    }));
  }, w = (_) => {
    if (!b.hasAttribute("data-open") || u) return;
    const C = _.target;
    C && !C.isConnected || C && a.contains(C) || y();
  }, D = (_) => {
    _.stopPropagation();
    const C = _.target, L = C.closest("[data-nav]");
    if (L) {
      const N = L.dataset.nav === "prev" ? -1 : 1;
      o === "days" ? (s += N, s < 0 ? (s = 11, i--) : s > 11 && (s = 0, i++)) : o === "months" ? i += N : i += N * 10, h();
      return;
    }
    const T = C.closest("[data-zoom]");
    if (T) {
      T.dataset.zoom === "months" ? o = "months" : T.dataset.zoom === "years" && (o = "years"), h();
      return;
    }
    if (C.closest("[data-today]")) {
      n = /* @__PURE__ */ new Date(), i = n.getFullYear(), s = n.getMonth(), o = "days", l.value = bt(n), l.dispatchEvent(new Event("change", { bubbles: !0 })), y();
      return;
    }
    if (C.closest("[data-clear]")) {
      n = null, l.value = "", l.dispatchEvent(new Event("change", { bubbles: !0 })), y();
      return;
    }
    const f = C.closest(".blora-datepicker__cell[data-day]");
    if (f && !f.hasAttribute("disabled") && !f.hasAttribute("data-other")) {
      n = new Date(i, s, Number(f.dataset.day)), l.value = bt(n), l.dispatchEvent(new Event("change", { bubbles: !0 })), y();
      return;
    }
    const k = C.closest("[data-month]");
    if (k) {
      s = Number(k.dataset.month), o = "days", h();
      return;
    }
    const S = C.closest("[data-year]");
    S && (i = Number(S.dataset.year), o = "months", h());
  }, x = (_) => {
    l.showPicker;
  };
  return t == null || t.addEventListener("click", v), b.addEventListener("click", D), document.addEventListener("click", w), l.addEventListener("click", x), {
    destroy() {
      t == null || t.removeEventListener("click", v), b.removeEventListener("click", D), document.removeEventListener("click", w), l.removeEventListener("click", x);
    }
  };
}
class vr extends B {
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
    r.className = "blora-datepicker__btn", r.type = "button", r.tabIndex = -1, r.disabled = e.disabled, r.setAttribute("aria-label", g("datepicker.pick")), r.appendChild(I("calendar")), t.append(e, r), this.replaceChildren(t);
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
    (e = this.controller) == null || e.destroy(), this.controller = t ? gr(t) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function ka(a = customElements) {
  !a || a.get(yt) || a.define(yt, vr);
}
const Ct = "blora-range";
function Ar(a) {
  const l = a.querySelector(".blora-range__track"), t = a.querySelector(".blora-range__fill"), e = Array.from(a.querySelectorAll(".blora-range__thumb")), r = a.querySelector(".blora-range__value");
  if (!l || e.length < 2) return { destroy: () => {
  } };
  const n = Number(a.dataset.min ?? 0), i = Number(a.dataset.max ?? 100), o = a.dataset.tooltip !== "false" ? e.map(() => {
    const d = document.createElement("span");
    return d.className = "blora-range__tip", d.setAttribute("aria-hidden", "true"), a.appendChild(d), d;
  }) : [], c = (d) => (d - n) / (i - n) * 100, u = () => {
    const d = e.map((y) => Number(y.dataset.val ?? n)), m = Math.min(...d), p = Math.max(...d), h = c(m), E = c(p);
    e.forEach((y, v) => {
      const w = Number(y.dataset.val ?? n);
      y.style.left = `${c(w)}%`, o[v] && (o[v].textContent = String(w), o[v].style.left = `${c(w)}%`);
    }), t && (t.style.left = `${h}%`, t.style.width = `${E - h}%`), r && (r.textContent = `${m} – ${p}`);
  }, b = [];
  return e.forEach((d, m) => {
    let p = !1;
    const h = (D) => {
      p = !0, d.setPointerCapture(D.pointerId), o[m] && o[m].setAttribute("data-show", ""), D.preventDefault();
    }, E = (D) => {
      if (!p) return;
      const x = l.getBoundingClientRect();
      let _ = (D.clientX - x.left) / x.width * 100;
      _ = Math.max(0, Math.min(100, _));
      const C = Math.round(n + _ / 100 * (i - n)), L = e.indexOf(d), T = Number(e[1 - L].dataset.val ?? n);
      L === 0 && C > T || L === 1 && C < T || (d.dataset.val = String(C), u());
    }, y = (D) => {
      p = !1, o[m] && o[m].removeAttribute("data-show");
      try {
        d.releasePointerCapture(D.pointerId);
      } catch {
      }
    }, v = () => {
      var D;
      return (D = o[m]) == null ? void 0 : D.setAttribute("data-show", "");
    }, w = () => {
      var D;
      return (D = o[m]) == null ? void 0 : D.removeAttribute("data-show");
    };
    d.addEventListener("pointerdown", h), d.addEventListener("pointermove", E), d.addEventListener("pointerup", y), d.addEventListener("focus", v), d.addEventListener("blur", w), b.push(() => {
      d.removeEventListener("pointerdown", h), d.removeEventListener("pointermove", E), d.removeEventListener("pointerup", y), d.removeEventListener("focus", v), d.removeEventListener("blur", w);
    });
  }), u(), {
    destroy() {
      b.forEach((d) => d()), o.forEach((d) => d.remove());
    }
  };
}
class Pe extends B {
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
    const t = Number(this.getAttribute("min") ?? 0), e = Number(this.getAttribute("max") ?? 100), r = (this.getAttribute("values") ?? "20,75").split(",").slice(0, 2).map((d) => Number(d.trim())), n = Number.isFinite(r[0]) ? Math.max(t, Math.min(e, r[0])) : t, i = Number.isFinite(r[1]) ? Math.max(n, Math.min(e, r[1])) : e, s = document.createElement("div");
    s.className = "blora-range", s.dataset.bloraGenerated = "", s.dataset.min = String(t), s.dataset.max = String(e), this.getAttribute("tooltip") === "false" && (s.dataset.tooltip = "false");
    const o = document.createElement("div");
    o.className = "blora-range__track";
    const c = document.createElement("div");
    c.className = "blora-range__fill", o.appendChild(c);
    const u = (d, m) => {
      const p = document.createElement("div");
      return p.className = "blora-range__thumb", p.dataset.val = String(d), p.tabIndex = 0, p.setAttribute("role", "slider"), p.setAttribute("aria-label", m), p.setAttribute("aria-valuemin", String(t)), p.setAttribute("aria-valuemax", String(e)), p.setAttribute("aria-valuenow", String(d)), p;
    }, b = document.createElement("span");
    b.className = "blora-range__value", b.textContent = `${n} – ${i}`, s.append(o, u(n, g("common.min")), u(i, g("common.max")), b), this.replaceChildren(s), this.internals ?? (this.internals = X(this)), this.syncFormValue();
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
    (e = this.controller) == null || e.destroy(), this.controller = t ? Ar(t) : null, t && this.listen(t, "pointerup", () => this.syncFormValue());
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
A(Pe, "formAssociated", !0);
function Sa(a = customElements) {
  !a || a.get(Ct) || a.define(Ct, Pe);
}
const wt = "blora-segmented";
function yr(a) {
  if (typeof document > "u") return { destroy: () => {
  } };
  const l = a.ownerDocument.defaultView;
  let t = a.querySelector(".blora-segmented__indicator");
  t || (t = a.ownerDocument.createElement("span"), t.className = "blora-segmented__indicator", t.setAttribute("aria-hidden", "true"), a.insertBefore(t, a.firstChild));
  const e = Array.from(a.querySelectorAll(".blora-segmented__item"));
  a.setAttribute("role", "radiogroup");
  const r = (u) => {
    const b = a.getBoundingClientRect(), d = u.getBoundingClientRect();
    t.style.left = `${d.left - b.left}px`, t.style.width = `${d.width}px`;
  }, n = () => e.filter((u) => u.getAttribute("aria-disabled") !== "true"), i = (u, b = !1, d = !0) => {
    var m;
    !u || !n().includes(u) || (e.forEach((p) => {
      const h = p === u;
      p.toggleAttribute("data-active", h), p.setAttribute("aria-checked", String(h)), p.getAttribute("aria-disabled") !== "true" && (p.tabIndex = h ? 0 : -1);
    }), a.dataset.value = u.dataset.value || ((m = u.textContent) == null ? void 0 : m.trim()) || "", r(u), b && u.focus(), d && a.dispatchEvent(
      new CustomEvent("blora-change", {
        bubbles: !0,
        detail: { value: a.dataset.value, item: u }
      })
    ));
  };
  e.forEach((u) => {
    u.setAttribute("role", "radio");
    const b = u.getAttribute("aria-disabled") === "true";
    u.setAttribute("aria-checked", String(u.hasAttribute("data-active"))), u.tabIndex = b ? -1 : u.hasAttribute("data-active") ? 0 : -1, u.addEventListener("click", () => i(u));
  });
  const s = (u) => {
    const b = n();
    if (!b.length) return;
    const d = a.ownerDocument, m = b.indexOf(d.activeElement);
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
  a.addEventListener("keydown", s);
  const o = () => {
    const u = e.find((b) => b.hasAttribute("data-active"));
    u && r(u);
  };
  l.addEventListener("resize", o);
  const c = e.find((u) => u.hasAttribute("data-active")) || n()[0];
  return c && (i(c, !1, !1), l.requestAnimationFrame(() => r(c))), {
    destroy() {
      a.removeEventListener("keydown", s), l.removeEventListener("resize", o);
    }
  };
}
class _r extends B {
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
    var n, i;
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
    const t = this.getAttribute("value") ?? ((n = this.definitions.find((s) => s.selected)) == null ? void 0 : n.value) ?? ((i = this.definitions.find((s) => !s.disabled)) == null ? void 0 : i.value), e = document.createElement("div");
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
    t && (this.controller = yr(t));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Na(a = customElements) {
  !a || a.get(wt) || a.define(wt, _r);
}
const xt = "blora-tabs", Er = /* @__PURE__ */ new Set(["ArrowLeft", "ArrowRight", "Home", "End"]), Cr = /* @__PURE__ */ new Set(["ArrowUp", "ArrowDown", "Home", "End"]);
let wr = 0;
function kt(a) {
  const l = new AbortController(), { signal: t } = l, e = a.querySelector(".blora-tabs__nav");
  if (!e)
    return { select: () => {
    }, destroy: () => {
    } };
  const r = e, n = Array.from(r.querySelectorAll(".blora-tabs__tab")), i = Array.from(a.querySelectorAll(".blora-tabs__panel")), s = typeof window < "u" ? window : void 0, o = (s == null ? void 0 : s.document.createElement("span")) ?? null;
  o && (o.className = "blora-tabs__indicator", o.setAttribute("aria-hidden", "true"), r.appendChild(o)), a.setAttribute("data-tabs-enhanced", "");
  const u = a.getAttribute("data-orientation") === "vertical" ? Cr : Er;
  r.setAttribute("role", "tablist"), n.forEach((y, v) => {
    y.setAttribute("role", "tab");
    const w = y.getAttribute("aria-selected") === "true";
    if (y.hasAttribute("disabled") || y.getAttribute("aria-disabled") === "true" ? (y.setAttribute("aria-disabled", "true"), y.tabIndex = -1) : y.tabIndex = w ? 0 : -1, i[v]) {
      const D = y.id || `blora-tabs-tab-${v}`, x = i[v].id || `blora-tabs-panel-${v}`;
      y.id || (y.id = D), i[v].id || (i[v].id = x), y.setAttribute("aria-controls", x), i[v].setAttribute("role", "tabpanel"), i[v].setAttribute("aria-labelledby", D);
    }
  });
  function b(y, v) {
    if (!o || !y) return;
    v ? o.setAttribute("data-instant", "") : o.removeAttribute("data-instant");
    const w = r.getBoundingClientRect(), D = y.getBoundingClientRect();
    o.style.setProperty("--blora-tab-x", `${D.left - w.left}px`), o.style.setProperty("--blora-tab-y", `${D.top - w.top}px`), o.style.setProperty("--blora-tab-w", `${D.width}px`), o.style.setProperty("--blora-tab-h", `${D.height}px`), v && s && s.requestAnimationFrame(() => {
      o.removeAttribute("data-instant");
    });
  }
  function d(y, v) {
    const w = n.indexOf(y);
    w !== -1 && (y.hasAttribute("disabled") || y.getAttribute("aria-disabled") === "true" || (n.forEach((D, x) => {
      const _ = x === w;
      D.setAttribute("aria-selected", String(_)), !D.hasAttribute("disabled") && D.getAttribute("aria-disabled") !== "true" && (D.tabIndex = _ ? 0 : -1);
    }), i.forEach((D, x) => {
      const _ = x === w;
      D.style.display = _ ? "" : "none", D.setAttribute("aria-hidden", String(!_)), _ && (D.removeAttribute("data-entering"), D.offsetWidth, D.setAttribute("data-entering", ""));
    }), b(y, !1), v && y.focus()));
  }
  function m() {
    const y = n.find((v) => v.getAttribute("aria-selected") === "true");
    return y || n.find(
      (v) => !v.hasAttribute("disabled") && v.getAttribute("aria-disabled") !== "true"
    );
  }
  r.addEventListener(
    "click",
    (y) => {
      const w = y.target.closest(".blora-tabs__tab");
      !w || !r.contains(w) || d(w, !1);
    },
    { signal: t }
  ), r.addEventListener(
    "keydown",
    (y) => {
      if (!u.has(y.key)) return;
      const v = n.filter(
        (x) => !x.hasAttribute("disabled") && x.getAttribute("aria-disabled") !== "true"
      );
      if (v.length === 0) return;
      const w = v.indexOf(document.activeElement);
      let D;
      if (y.key === "Home")
        D = 0;
      else if (y.key === "End")
        D = v.length - 1;
      else {
        const x = y.key === "ArrowRight" || y.key === "ArrowDown" ? 1 : -1;
        D = (Math.max(w, 0) + x + v.length) % v.length;
      }
      y.preventDefault(), d(v[D], !0);
    },
    { signal: t }
  ), b(m(), !0);
  const p = m(), h = p ? n.indexOf(p) : 0;
  i.forEach((y, v) => {
    const w = v === h;
    y.style.display = w ? "" : "none", y.setAttribute("aria-hidden", String(!w));
  });
  let E;
  return s && typeof ResizeObserver < "u" && (E = new s.ResizeObserver(() => {
    const y = n.find((v) => v.getAttribute("aria-selected") === "true");
    b(y, !0);
  }), E.observe(r)), {
    select(y, v = !1) {
      const w = n[y];
      w && d(w, v);
    },
    destroy() {
      l.abort(), E == null || E.disconnect(), o == null || o.remove(), a.removeAttribute("data-tabs-enhanced");
    }
  };
}
class xr extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "definitions", null);
    A(this, "reflecting", !1);
    A(this, "instanceId", ++wr);
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
    var n, i;
    if (this.definitions || (this.definitions = this.readDefinitions()), !this.definitions.length && this.querySelector(".blora-tabs")) return;
    const t = this.getAttribute("value") ?? ((n = this.definitions.find((s) => s.selected)) == null ? void 0 : n.value) ?? ((i = this.definitions.find((s) => !s.disabled)) == null ? void 0 : i.value), e = document.createElement("div");
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
    t && ((e = this.controller) == null || e.destroy(), this.controller = kt(t), this.listen(t, "click", (r) => {
      var i;
      const n = (i = r.target) == null ? void 0 : i.closest(
        ".blora-tabs__tab"
      );
      !n || !t.contains(n) || n.disabled || this.reflectValue(n.dataset.value ?? "");
    }));
  }
  sync() {
    var e;
    const t = this.querySelector(".blora-tabs");
    t && (this.syncChrome(t), (e = this.controller) == null || e.destroy(), this.controller = kt(t));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
  readDefinitions() {
    const t = Array.from(this.children).filter((n) => n.localName === "blora-tab");
    if (t.length)
      return t.map((n) => {
        const i = n.getAttribute("label") ?? "";
        return {
          content: Array.from(n.childNodes),
          disabled: n.hasAttribute("disabled"),
          label: i,
          selected: n.hasAttribute("selected"),
          value: n.getAttribute("value") ?? i
        };
      });
    const e = Array.from(this.querySelectorAll(".blora-tabs__tab")), r = Array.from(this.querySelectorAll(".blora-tabs__panel"));
    return e.map((n, i) => {
      var s;
      return {
        content: Array.from(((s = r[i]) == null ? void 0 : s.childNodes) ?? []),
        disabled: n.disabled,
        label: n.textContent ?? "",
        selected: n.getAttribute("aria-selected") === "true",
        value: n.dataset.value ?? n.textContent ?? ""
      };
    });
  }
  syncChrome(t) {
    const e = this.getAttribute("variant"), r = this.getAttribute("orientation");
    e ? t.dataset.variant = e : delete t.dataset.variant, r ? t.dataset.orientation = r : delete t.dataset.orientation, t.toggleAttribute("data-flush", this.hasAttribute("flush"));
  }
  activateFromValue() {
    var n;
    const t = this.getAttribute("value") ?? "", r = Array.from(this.querySelectorAll(".blora-tabs__tab")).findIndex((i) => (i.dataset.value ?? "") === t);
    r >= 0 && ((n = this.controller) == null || n.select(r));
  }
  reflectValueFromIndex(t) {
    const e = this.querySelectorAll(".blora-tabs__tab")[t];
    e && this.reflectValue(e.dataset.value ?? "");
  }
  reflectValue(t) {
    (this.getAttribute("value") ?? "") !== t && (this.reflecting = !0, t ? this.setAttribute("value", t) : this.removeAttribute("value"), this.reflecting = !1, this.emit("blora-change", { value: t }));
  }
}
function Da(a = customElements) {
  !a || a.get(xt) || a.define(xt, xr);
}
const St = "blora-timepicker";
function kr(a) {
  const l = a.querySelector("input"), t = a.querySelector(
    ".blora-timepicker__btn, .blora-datepicker__btn"
  );
  if (!l) return { destroy: () => {
  } };
  l.type !== "time" && (l.type = "time");
  let e = 14, r = 30, n = !1, i = a.querySelector(".blora-timepicker__panel");
  i || (i = document.createElement("div"), i.className = "blora-timepicker__panel", a.appendChild(i));
  const s = (f) => String(f).padStart(2, "0"), o = () => s(e) + ":" + s(r), c = 5, u = Math.floor(c / 2), b = 36, d = [], m = () => {
    if (l.value) {
      const f = l.value.split(":");
      f.length >= 2 && (e = Math.min(23, Math.max(0, Number(f[0]) || 0)), r = Math.min(59, Math.max(0, Number(f[1]) || 0)));
    }
  }, p = (f, k) => {
    f.querySelectorAll(".blora-timepicker__item").forEach((S) => {
      const N = S, q = Number(N.dataset.val);
      N.toggleAttribute("data-selected", q === k);
    });
  }, h = (f, k, S, N = !1) => {
    const M = (u * S + (k % S + S) % S) * b;
    N ? f.scrollTo({ top: M, behavior: "smooth" }) : f.scrollTop = M, p(f, (k % S + S) % S);
  }, E = (f, k) => {
    const S = Math.round(f.scrollTop / b);
    return (Math.max(0, Math.min(S, c * k - 1)) % k + k) % k;
  }, y = (f, k, S, N) => {
    let q = !1, M = null, P = !1;
    const O = () => {
      const F = k * b;
      F <= 0 || (f.scrollTop < F * 1.1 ? (P = !0, f.scrollTop += F, P = !1) : f.scrollTop > F * (c - 2.1) && (P = !0, f.scrollTop -= F, P = !1));
    }, R = () => {
      if (P) return;
      O();
      const F = E(f, k);
      N(F);
      const z = Math.floor((f.scrollTop + b / 2) / (k * b)), it = (Math.min(c - 1, Math.max(0, z)) * k + F) * b;
      Math.abs(f.scrollTop - it) > 0.5 && (P = !0, f.scrollTop = it, P = !1), p(f, F);
    }, G = () => {
      P || (q || (q = !0, requestAnimationFrame(() => {
        if (q = !1, P) return;
        O();
        const F = E(f, k);
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
      const it = Math.floor((f.scrollTop + b / 2) / (k * b)), tr = (Math.min(c - 1, Math.max(0, it)) * k + at) * b;
      f.scrollTo({ top: tr, behavior: "smooth" }), p(f, at);
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
    f.addEventListener("scroll", G, { passive: !0 }), f.addEventListener("click", U), f.addEventListener("pointerdown", j), f.addEventListener("pointermove", J), f.addEventListener("pointerup", nt), f.addEventListener("pointercancel", nt), h(f, S(), k, !1), d.push(() => {
      f.removeEventListener("scroll", G), f.removeEventListener("click", U), f.removeEventListener("pointerdown", j), f.removeEventListener("pointermove", J), f.removeEventListener("pointerup", nt), f.removeEventListener("pointercancel", nt), M && clearTimeout(M);
    });
  }, v = (f, k, S) => {
    f.replaceChildren();
    for (let N = 0; N < c; N++)
      for (let q = 0; q < k; q++) {
        const M = document.createElement("div");
        M.className = "blora-timepicker__item", M.dataset.val = String(q), M.dataset.kind = S, M.textContent = s(q), f.appendChild(M);
      }
  }, w = () => {
    var G;
    for (; d.length; ) (G = d.pop()) == null || G();
    i.replaceChildren();
    const f = document.createElement("div");
    f.className = "blora-timepicker__wheel";
    const k = document.createElement("div");
    k.className = "blora-timepicker__highlight", k.setAttribute("aria-hidden", "true");
    const S = document.createElement("div");
    S.className = "blora-timepicker__cols";
    const N = document.createElement("div");
    N.className = "blora-timepicker__scroll", N.setAttribute("data-scroll", "h"), N.setAttribute("role", "listbox"), N.setAttribute("aria-label", g("timepicker.hour")), v(N, 24, "h");
    const q = document.createElement("span");
    q.className = "blora-timepicker__sep", q.textContent = ":", q.setAttribute("aria-hidden", "true");
    const M = document.createElement("div");
    M.className = "blora-timepicker__scroll", M.setAttribute("data-scroll", "m"), M.setAttribute("role", "listbox"), M.setAttribute("aria-label", g("timepicker.minute")), v(M, 60, "m"), S.append(N, q, M), f.append(k, S), i.appendChild(f);
    const P = document.createElement("div");
    P.className = "blora-datepicker__foot";
    const O = document.createElement("button");
    O.type = "button", O.className = "blora-button", O.setAttribute("data-variant", "ghost"), O.setAttribute("data-size", "sm"), O.setAttribute("data-now", ""), O.textContent = g("common.now");
    const R = document.createElement("button");
    R.type = "button", R.className = "blora-button", R.setAttribute("data-variant", "ghost"), R.setAttribute("data-size", "sm"), R.setAttribute("data-confirm", ""), R.textContent = g("common.confirm"), P.append(O, R), i.appendChild(P), requestAnimationFrame(() => {
      y(
        N,
        24,
        () => e,
        (U) => {
          e = U;
        }
      ), y(
        M,
        60,
        () => r,
        (U) => {
          r = U;
        }
      );
    });
  }, D = () => {
    m(), i.setAttribute("data-open", ""), a.style.zIndex = "var(--blora-z-dropdown)", w();
  }, x = () => {
    var f;
    for (i.removeAttribute("data-open"), a.style.zIndex = ""; d.length; ) (f = d.pop()) == null || f();
  }, _ = () => {
    l.value = o(), l.dispatchEvent(new Event("change", { bubbles: !0 }));
  }, C = (f) => {
    f.preventDefault(), f.stopPropagation(), i.hasAttribute("data-open") ? x() : (n = !0, D(), queueMicrotask(() => {
      n = !1;
    }));
  }, L = (f) => {
    if (!i.hasAttribute("data-open") || n) return;
    const k = f.target;
    k && !k.isConnected || k && a.contains(k) || x();
  }, T = (f) => {
    f.stopPropagation();
    const k = f.target;
    if (k.closest("[data-now]")) {
      const S = /* @__PURE__ */ new Date();
      e = S.getHours(), r = S.getMinutes(), _(), x();
      return;
    }
    k.closest("[data-confirm]") && (_(), x());
  };
  return t == null || t.addEventListener("click", C), i.addEventListener("click", T), document.addEventListener("click", L), {
    destroy() {
      var f;
      for (t == null || t.removeEventListener("click", C), i.removeEventListener("click", T), document.removeEventListener("click", L); d.length; ) (f = d.pop()) == null || f();
    }
  };
}
class Sr extends B {
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
    r.className = "blora-timepicker__btn", r.type = "button", r.tabIndex = -1, r.disabled = e.disabled, r.setAttribute("aria-label", g("timepicker.pick")), r.appendChild(I("clock")), t.append(e, r), this.replaceChildren(t);
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
    (e = this.controller) == null || e.destroy(), this.controller = t ? kr(t) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function La(a = customElements) {
  !a || a.get(St) || a.define(St, Sr);
}
const Nt = "blora-transfer";
function Nr(a) {
  const l = a.querySelectorAll(".blora-transfer__panel"), t = a.querySelectorAll(".blora-transfer__action, [data-transfer]");
  if (l.length < 2 || t.length === 0) return { destroy: () => {
  } };
  const e = l[0], r = l[1], n = e.querySelector(".blora-transfer__list"), i = r.querySelector(".blora-transfer__list"), s = () => {
    const u = e.querySelector(".blora-transfer__head"), b = r.querySelector(".blora-transfer__head");
    if (u) {
      const d = (n == null ? void 0 : n.querySelectorAll(".blora-transfer__row").length) ?? 0;
      u.textContent = g("transfer.sourceCount", { n: d });
    }
    if (b) {
      const d = (i == null ? void 0 : i.querySelectorAll(".blora-transfer__row").length) ?? 0;
      b.textContent = g("transfer.targetCount", { n: d });
    }
  }, o = (u) => {
    u === "right" || u === "to-right" ? Array.from(
      (n == null ? void 0 : n.querySelectorAll(".blora-transfer__row input:checked")) ?? []
    ).forEach((d) => {
      const m = d.closest(".blora-transfer__row");
      m && i && (d.checked = !1, i.appendChild(m));
    }) : Array.from(
      (i == null ? void 0 : i.querySelectorAll(".blora-transfer__row input:checked")) ?? []
    ).forEach((d) => {
      const m = d.closest(".blora-transfer__row");
      m && n && (d.checked = !1, n.appendChild(m));
    }), s();
  }, c = (u) => {
    const b = u.target.closest("[data-transfer]");
    b && (u.preventDefault(), o(b.dataset.transfer ?? "right"));
  };
  return a.addEventListener("click", c), {
    destroy() {
      a.removeEventListener("click", c);
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
    const n = (c, u) => {
      const b = document.createElement("div");
      b.className = "blora-transfer__panel";
      const d = document.createElement("div");
      d.className = "blora-transfer__head", d.textContent = `${c} · ${u.length}`;
      const m = document.createElement("div");
      m.className = "blora-transfer__list";
      for (const p of u) {
        const h = document.createElement("label");
        h.className = "blora-transfer__row";
        const E = document.createElement("input");
        E.type = "checkbox", E.value = p.value, E.dataset.value = p.value, E.checked = p.checked, E.disabled = p.disabled || this.hasAttribute("disabled");
        const y = document.createElement("span");
        y.className = "blora-transfer__check";
        const v = document.createElement("span");
        v.textContent = p.label, h.append(E, y, v), m.appendChild(h);
      }
      return b.append(d, m), b;
    }, i = document.createElement("div");
    i.className = "blora-transfer__actions";
    const s = document.createElement("button");
    s.className = "blora-button", s.dataset.variant = "outline", s.dataset.size = "icon", s.dataset.transfer = "right", s.type = "button", s.disabled = this.hasAttribute("disabled"), s.setAttribute("aria-label", g("transfer.moveRight")), s.appendChild(I("chevron-right", 18, this.ownerDocument));
    const o = document.createElement("button");
    o.className = "blora-button", o.dataset.variant = "outline", o.dataset.size = "icon", o.dataset.transfer = "left", o.type = "button", o.disabled = this.hasAttribute("disabled"), o.setAttribute("aria-label", g("transfer.moveLeft")), o.appendChild(I("chevron-left", 18, this.ownerDocument)), i.append(s, o), r.append(
      n(this.getAttribute("source-label") ?? g("transfer.source"), t),
      i,
      n(this.getAttribute("target-label") ?? g("transfer.target"), e)
    ), this.replaceChildren(r);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-transfer");
    t && (this.controller = Nr(t));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function qa(a = customElements) {
  !a || a.get(Nt) || a.define(Nt, Dr);
}
const Dt = "blora-statistic";
class Lr extends B {
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
    const n = t.createElement("div");
    n.className = "blora-stat__value", n.textContent = this.getAttribute("value") ?? this.initialValue;
    const i = this.getAttribute("suffix");
    if (i) {
      const c = t.createElement("span");
      c.className = "blora-stat__suffix", c.textContent = i, n.appendChild(c);
    }
    e.appendChild(n);
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
    const n = t.querySelector(".blora-stat__value");
    if (n) {
      const o = this.getAttribute("suffix");
      if (n.textContent = this.getAttribute("value") ?? this.initialValue ?? "", o) {
        const c = this.ownerDocument.createElement("span");
        c.className = "blora-stat__suffix", c.textContent = o, n.appendChild(c);
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
function Ta(a = customElements) {
  !a || a.get(Dt) || a.define(Dt, Lr);
}
const Lt = "blora-steps";
function qr(a) {
  if (typeof document > "u")
    return { setCurrent: () => {
    }, getCurrent: () => 0, destroy: () => {
    } };
  a.classList.add("blora-steps");
  const l = () => Array.from(a.querySelectorAll(".blora-step, [data-blora-step]")), t = () => {
    const i = l().findIndex(
      (s) => s.hasAttribute("data-current") || s.getAttribute("data-state") === "active" || s.getAttribute("data-status") === "process"
    );
    return i >= 0 ? i : 0;
  }, e = (n) => {
    l().forEach((s, o) => {
      s.removeAttribute("data-current"), s.removeAttribute("data-status"), o < n ? s.setAttribute("data-state", "done") : o === n ? (s.setAttribute("data-state", "active"), s.setAttribute("data-current", "")) : s.setAttribute("data-state", "pending"), o === n ? s.setAttribute("aria-current", "step") : s.removeAttribute("aria-current");
    }), a.dispatchEvent(new CustomEvent("blora-steps-change", { bubbles: !0, detail: { index: n } }));
  }, r = (n) => {
    if (a.getAttribute("data-clickable") === "false") return;
    const i = n.target.closest(".blora-step, [data-blora-step]");
    if (!i || !a.contains(i)) return;
    const o = l().indexOf(i);
    o >= 0 && e(o);
  };
  return a.addEventListener("click", r), e(t()), {
    setCurrent: e,
    getCurrent: t,
    destroy() {
      a.removeEventListener("click", r);
    }
  };
}
class Tr extends B {
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
    const t = this.getAttribute("current"), e = this.definitions.findIndex((i) => i.state === "active"), r = t === null ? Math.max(0, e) : Number(t), n = this.ownerDocument.createElement("div");
    n.className = "blora-steps", n.dataset.bloraGenerated = "", n.dataset.clickable = String(this.getAttribute("clickable") !== "false"), this.definitions.forEach((i, s) => {
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
      s < r ? o.dataset.state = "done" : s === r ? o.dataset.state = "active" : o.dataset.state = "pending", n.appendChild(o);
    }), this.replaceChildren(n);
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
    t && (this.controller = qr(t), this.listen(t, "blora-steps-change", (e) => {
      const r = e.detail.index;
      this.getAttribute("current") !== String(r) && this.setAttribute("current", String(r));
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Ma(a = customElements) {
  !a || a.get(Lt) || a.define(Lt, Tr);
}
const qt = "blora-radio";
class Mr extends B {
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
    const n = t.createElement("span");
    n.className = "blora-radio__dot", n.setAttribute("aria-hidden", "true"), e.append(r, n, t.createTextNode(this.getAttribute("label") ?? this.initialLabel)), this.replaceChildren(e);
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
function Ba(a = customElements) {
  !a || a.get(qt) || a.define(qt, Mr);
}
const Tt = "blora-switch";
class Re extends B {
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
    const n = t.createElement("input");
    n.type = "checkbox", n.name = this.internals ? "" : this.getAttribute("name") ?? "", n.value = this.value, n.checked = this.hasAttribute("checked"), n.disabled = this.hasAttribute("disabled"), n.required = this.hasAttribute("required");
    const i = t.createElement("span");
    i.className = "blora-switch__track", i.setAttribute("aria-hidden", "true"), e.append(n, i, t.createTextNode(this.getAttribute("label") ?? this.initialLabel)), this.replaceChildren(e), this.syncFormValue();
  }
  sync() {
    const t = this.querySelector('input[type="checkbox"]'), e = this.querySelector(".blora-switch");
    if (!t || !e) return;
    const r = this.getAttribute("size");
    r === "sm" || r === "lg" ? e.dataset.size = r : delete e.dataset.size, t.name = this.internals ? "" : this.getAttribute("name") ?? "", t.value = this.value, t.checked = this.hasAttribute("checked"), t.disabled = this.hasAttribute("disabled"), t.required = this.hasAttribute("required");
    const n = e.lastChild;
    (n == null ? void 0 : n.nodeType) === Node.TEXT_NODE && (n.textContent = this.getAttribute("label") ?? this.initialLabel ?? ""), this.syncFormValue();
  }
  bindEvents() {
    const t = this.querySelector('input[type="checkbox"]');
    t && this.listen(t, "change", () => {
      this.reflecting = !0, this.toggleAttribute("checked", t.checked), this.reflecting = !1, this.syncFormValue();
    });
  }
}
A(Re, "formAssociated", !0);
function Ia(a = customElements) {
  !a || a.get(Tt) || a.define(Tt, Re);
}
const Mt = "blora-slider";
function Br(a) {
  const l = a.querySelector(".blora-slider__input, input[type='range']"), t = a.querySelector(".blora-slider__value");
  if (!l) return { destroy: () => {
  } };
  const e = a.hasAttribute("data-tooltip") || a.dataset.tooltip === "true";
  let r = null;
  e && (r = a.querySelector(".blora-slider__tip"), r || (r = document.createElement("span"), r.className = "blora-slider__tip", r.setAttribute("aria-hidden", "true"), a.appendChild(r)));
  const n = () => {
    const o = Number(l.value), c = Number(l.min) || 0, u = Number(l.max) || 100, b = (o - c) / (u - c) * 100;
    a.style.setProperty("--blora-slider-fill", `${b}%`), t && (t.textContent = String(o)), r && (r.textContent = String(o), r.style.left = `${b}%`);
  }, i = () => {
    r && r.setAttribute("data-show", "");
  }, s = () => {
    r && r.removeAttribute("data-show");
  };
  return l.addEventListener("input", n), e && (l.addEventListener("pointerdown", i), l.addEventListener("pointerup", s), l.addEventListener("focus", i), l.addEventListener("blur", s)), n(), {
    destroy() {
      l.removeEventListener("input", n), e && (l.removeEventListener("pointerdown", i), l.removeEventListener("pointerup", s), l.removeEventListener("focus", i), l.removeEventListener("blur", s));
    }
  };
}
class Ge extends B {
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
    const r = this.hasAttribute("hide-value"), n = t.querySelector("output");
    if (r !== !n) {
      this.render(), this.rebind();
      return;
    }
    this.hasAttribute("tooltip") ? t.dataset.tooltip = "true" : delete t.dataset.tooltip, e.min = this.getAttribute("min") ?? "0", e.max = this.getAttribute("max") ?? "100", e.step = this.getAttribute("step") ?? "1", document.activeElement !== e && (e.value = this.getAttribute("value") ?? e.value), e.name = this.internals ? "" : this.getAttribute("name") ?? "", e.disabled = this.hasAttribute("disabled"), n && (n.textContent = e.value), this.syncFormValue();
  }
  bindEvents() {
    var r;
    const t = this.querySelector(".blora-slider"), e = t == null ? void 0 : t.querySelector('input[type="range"]');
    !t || !e || ((r = this.controller) == null || r.destroy(), this.controller = Br(t), this.listen(e, "input", () => {
      this.reflecting = !0, this.setAttribute("value", e.value), this.reflecting = !1, this.syncFormValue();
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
A(Ge, "formAssociated", !0);
function Oa(a = customElements) {
  !a || a.get(Mt) || a.define(Mt, Ge);
}
const Bt = "blora-rate";
function Ir(a) {
  const l = Array.from(a.querySelectorAll(".blora-rate__star"));
  if (l.length === 0) return { destroy: () => {
  } };
  const t = a.hasAttribute("data-readonly");
  let e = Number(a.dataset.value ?? 0);
  const r = (c) => {
    const u = c ?? e;
    l.forEach((b, d) => {
      d < u ? b.setAttribute("data-active", "") : b.removeAttribute("data-active");
    });
  };
  if (t)
    return r(null), { destroy: () => {
    } };
  const n = (c) => {
    const u = c.target;
    if (!(u instanceof Element)) return null;
    const b = u.closest(".blora-rate__star");
    return b && l.includes(b) ? b : null;
  }, i = (c) => {
    const u = n(c);
    u && r(l.indexOf(u) + 1);
  }, s = () => r(null), o = (c) => {
    const u = n(c);
    u && (e = l.indexOf(u) + 1, a.dataset.value = String(e), r(null));
  };
  return a.addEventListener("mouseover", i), a.addEventListener("mouseleave", s), a.addEventListener("click", o), r(null), {
    destroy() {
      a.removeEventListener("mouseover", i), a.removeEventListener("mouseleave", s), a.removeEventListener("click", o);
    }
  };
}
class Or extends B {
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
    r.className = "blora-rate", r.dataset.bloraGenerated = "", r.dataset.value = String(e), r.setAttribute("role", "radiogroup"), r.setAttribute("aria-label", this.getAttribute("label") ?? g("rate.label")), this.hasAttribute("readonly") && (r.dataset.readonly = "");
    for (let n = 1; n <= t; n += 1) {
      const i = this.ownerDocument.createElement("span");
      i.className = "blora-rate__star", i.appendChild(I("star", 20, this.ownerDocument)), i.dataset.value = String(n), i.setAttribute("role", "radio"), i.setAttribute("aria-checked", String(n === e)), i.setAttribute("aria-label", g("rate.of", { n, max: t })), i.tabIndex = this.hasAttribute("readonly") ? -1 : n === Math.max(1, e) ? 0 : -1, n <= e && (i.dataset.active = ""), r.appendChild(i);
    }
    this.replaceChildren(r);
  }
  sync() {
    const t = this.querySelector(".blora-rate");
    if (!t) return;
    const e = Math.max(1, Number(this.getAttribute("max") ?? 5)), r = Math.min(e, Math.max(0, Number(this.getAttribute("value") ?? 0)));
    t.dataset.value = String(r), t.setAttribute("aria-label", this.getAttribute("label") ?? g("rate.label")), t.toggleAttribute("data-readonly", this.hasAttribute("readonly")), t.querySelectorAll(".blora-rate__star").forEach((n, i) => {
      const s = i + 1;
      n.setAttribute("aria-checked", String(s === r)), n.tabIndex = this.hasAttribute("readonly") ? -1 : s === Math.max(1, r) ? 0 : -1, n.toggleAttribute("data-active", s <= r);
    });
  }
  bindEvents() {
    var r;
    const t = this.querySelector(".blora-rate");
    if (!t) return;
    (r = this.controller) == null || r.destroy(), this.controller = Ir(t);
    const e = (n) => {
      if (this.hasAttribute("readonly")) return;
      n.click();
      const i = t.dataset.value ?? "0";
      this.reflecting = !0, this.setAttribute("value", i), this.reflecting = !1, t.querySelectorAll(".blora-rate__star").forEach((s) => {
        const o = s === n;
        s.setAttribute("aria-checked", String(o)), s.tabIndex = o ? 0 : -1;
      }), this.emit("blora-change", { value: Number(i) });
    };
    this.listen(t, "click", (n) => {
      const i = n.target.closest(".blora-rate__star");
      if (!i || !t.contains(i)) return;
      const s = t.dataset.value ?? "0";
      this.reflecting = !0, this.setAttribute("value", s), this.reflecting = !1, t.querySelectorAll(".blora-rate__star").forEach((o) => {
        const c = o === i;
        o.setAttribute("aria-checked", String(c)), o.tabIndex = c ? 0 : -1;
      }), this.emit("blora-change", { value: Number(s) });
    }), this.listen(t, "keydown", (n) => {
      const i = n, s = i.target.closest(".blora-rate__star");
      !s || i.key !== "Enter" && i.key !== " " || (i.preventDefault(), e(s));
    });
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Pa(a = customElements) {
  !a || a.get(Bt) || a.define(Bt, Or);
}
const It = "blora-otp";
function Pr(a) {
  const l = Array.from(a.querySelectorAll(".blora-otp__input"));
  if (l.length === 0) return { destroy: () => {
  } };
  const t = a.dataset.mode ?? "any", e = a.hasAttribute("data-uppercase"), r = (o) => (e && (o = o.toUpperCase()), t === "numeric" ? /[0-9]/.test(o) ? o : "" : t === "alphanumeric" ? /[a-zA-Z0-9]/.test(o) ? o : "" : o), n = (o) => {
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
    o.addEventListener("input", n), o.addEventListener("keydown", i), o.addEventListener("paste", s);
  }), {
    destroy() {
      l.forEach((o) => {
        o.removeEventListener("input", n), o.removeEventListener("keydown", i), o.removeEventListener("paste", s);
      });
    }
  };
}
class $e extends B {
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
    r.className = "blora-otp", r.dataset.bloraGenerated = "", r.dataset.mode = this.getAttribute("mode") ?? "numeric", r.setAttribute("role", "group"), r.setAttribute("aria-label", this.getAttribute("label") ?? g("otp.label")), this.hasAttribute("uppercase") && (r.dataset.uppercase = "");
    for (let n = 0; n < t; n += 1) {
      const i = this.ownerDocument.createElement("input");
      i.className = "blora-otp__input", i.type = "text", i.maxLength = 1, i.inputMode = r.dataset.mode === "numeric" ? "numeric" : "text", i.autocomplete = n === 0 ? "one-time-code" : "off", i.disabled = this.hasAttribute("disabled"), i.value = e[n] ?? "", i.setAttribute("aria-label", g("otp.char", { n: n + 1, total: t })), r.appendChild(i);
    }
    this.replaceChildren(r), this.syncFormValue();
  }
  sync() {
    const t = this.querySelector(".blora-otp"), e = [...this.querySelectorAll(".blora-otp__input")], r = Math.max(1, Number(this.getAttribute("length") ?? 6));
    if (!t || e.length !== r) {
      this.render(), this.rebind();
      return;
    }
    t.dataset.mode = this.getAttribute("mode") ?? "numeric", t.toggleAttribute("data-uppercase", this.hasAttribute("uppercase")), t.setAttribute("aria-label", this.getAttribute("label") ?? g("otp.label"));
    const n = Array.from(this.getAttribute("value") ?? "");
    e.forEach((i, s) => {
      i.disabled = this.hasAttribute("disabled"), this.ownerDocument.activeElement !== i && (i.value = n[s] ?? "");
    }), this.syncFormValue();
  }
  bindEvents() {
    const t = this.querySelector(".blora-otp");
    t && (this.controller = Pr(t), this.listen(t, "input", () => {
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
A($e, "formAssociated", !0);
function Ra(a = customElements) {
  !a || a.get(It) || a.define(It, $e);
}
const Ot = "blora-tags-input";
function Rr(a) {
  const l = a.ownerDocument, t = a.querySelector("input");
  if (!t) return { destroy: () => {
  } };
  const e = (i) => {
    const s = i.trim();
    if (!s) return;
    const o = l.createElement("span");
    o.className = "blora-tag", o.setAttribute("data-variant", "primary"), o.appendChild(l.createTextNode(s));
    const c = l.createElement("button");
    c.type = "button", c.className = "blora-tag__close", c.setAttribute("aria-label", g("tags.removeNamed", { label: s })), o.appendChild(c), a.insertBefore(o, t), t.value = "";
  }, r = (i) => {
    var o;
    const s = i.target.closest(".blora-tag__close");
    s && a.contains(s) && ((o = s.closest(".blora-tag")) == null || o.remove());
  }, n = (i) => {
    if (i.key === "Enter" || i.key === ",")
      i.preventDefault(), e(t.value);
    else if (i.key === "Backspace" && !t.value) {
      const s = t.previousElementSibling;
      s != null && s.classList.contains("blora-tag") && s.remove();
    }
  };
  return t.addEventListener("keydown", n), a.addEventListener("click", r), {
    destroy() {
      t.removeEventListener("keydown", n), a.removeEventListener("click", r);
    }
  };
}
class Fe extends B {
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
    const t = (this.getAttribute("values") ?? "").split(",").map((n) => n.trim()).filter(Boolean), e = this.ownerDocument.createElement("div");
    e.className = "blora-tags-input", e.dataset.bloraGenerated = "", e.setAttribute("role", "group"), e.setAttribute("aria-label", this.getAttribute("label") ?? g("tags.label"));
    for (const n of t) {
      const i = this.ownerDocument.createElement("span");
      i.className = "blora-tag", i.dataset.variant = "primary", i.appendChild(this.ownerDocument.createTextNode(n));
      const s = this.ownerDocument.createElement("button");
      s.type = "button", s.className = "blora-tag__close", s.setAttribute("aria-label", g("tags.removeNamed", { label: n })), s.disabled = this.hasAttribute("disabled"), i.appendChild(s), e.appendChild(i);
    }
    const r = this.ownerDocument.createElement("input");
    r.type = "text", r.placeholder = this.getAttribute("placeholder") ?? "", r.disabled = this.hasAttribute("disabled"), e.appendChild(r), this.replaceChildren(e), this.syncFormValue();
  }
  sync() {
    const t = this.querySelector(".blora-tags-input");
    t && t.setAttribute("aria-label", this.getAttribute("label") ?? g("tags.label"));
    const e = this.querySelector("input, textarea");
    e && (e.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (e.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== e && (e.value = this.getAttribute("value") ?? e.value)), this.rebind(), this.syncFormValue();
  }
  bindEvents() {
    const t = this.querySelector(".blora-tags-input");
    if (!t) return;
    this.controller = Rr(t);
    const e = () => {
      const r = this.values;
      this.reflecting = !0, this.setAttribute("values", r.join(",")), this.reflecting = !1, this.emit("blora-change", { values: r }), this.syncFormValue();
    };
    this.listen(t, "keydown", (r) => {
      const n = r;
      (n.key === "Enter" || n.key === "," || n.key === "Backspace") && queueMicrotask(e);
    }), this.listen(t, "click", (r) => {
      r.target.closest(".blora-tag__close") && queueMicrotask(e);
    });
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
A(Fe, "formAssociated", !0);
function Ga(a = customElements) {
  !a || a.get(Ot) || a.define(Ot, Fe);
}
const Pt = "blora-checkbox";
function Gr(a) {
  const l = a.querySelector(
    "[data-blora-checkall], .blora-checkbox__input[data-blora-checkall]"
  );
  if (!l) return { destroy: () => {
  } };
  const t = () => Array.from(
    a.querySelectorAll('input[type="checkbox"]:not([data-blora-checkall])')
  ), e = () => {
    const i = t(), s = i.filter((o) => o.checked).length;
    l.checked = i.length > 0 && s === i.length, l.indeterminate = s > 0 && s < i.length;
  }, r = () => {
    t().forEach((i) => {
      i.disabled || (i.checked = l.checked);
    }), l.indeterminate = !1;
  }, n = (i) => {
    i.target !== l && e();
  };
  return l.addEventListener("change", r), a.addEventListener("change", n), e(), {
    destroy() {
      l.removeEventListener("change", r), a.removeEventListener("change", n);
    }
  };
}
class He extends B {
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
        var n, i;
        return {
          checked: r.hasAttribute("checked"),
          checkAll: r.hasAttribute("check-all"),
          disabled: r.hasAttribute("disabled"),
          label: r.getAttribute("label") ?? ((n = r.textContent) == null ? void 0 : n.trim()) ?? "",
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
    const n = t[0];
    n.name = this.internals ? "" : e, n.value = this.getAttribute("value") ?? "on", n.checked = this.hasAttribute("checked"), n.disabled = this.hasAttribute("disabled"), n.required = r;
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
    (r = this.controller) == null || r.destroy(), this.controller = Gr(t);
    const e = (n) => {
      this.definitions || (this.reflecting = !0, this.toggleAttribute("checked", n.checked), this.reflecting = !1), this.syncIndeterminate(t), this.syncFormValue();
    };
    this.listen(t, "change", (n) => e(n.target)), this.syncIndeterminate(t);
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
  createCheckbox(t, e) {
    const r = this.ownerDocument.createElement("label");
    r.className = "blora-checkbox", r.dataset.bloraGenerated = "";
    const n = this.ownerDocument.createElement("input");
    n.type = "checkbox", n.name = e, n.value = t.value, n.checked = t.checked, n.disabled = t.disabled, n.required = this.hasAttribute("required"), t.checkAll && (n.dataset.bloraCheckall = "");
    const i = this.ownerDocument.createElement("span");
    return i.className = "blora-checkbox__box", i.setAttribute("aria-hidden", "true"), r.append(n, i, this.ownerDocument.createTextNode(t.label)), r;
  }
  captureLiveState() {
    if (!this.definitions) return;
    const t = Array.from(this.querySelectorAll('input[type="checkbox"]'));
    this.definitions = this.definitions.map((e, r) => {
      var n;
      return {
        ...e,
        checked: ((n = t[r]) == null ? void 0 : n.checked) ?? e.checked
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
A(He, "formAssociated", !0);
function $a(a = customElements) {
  !a || a.get(Pt) || a.define(Pt, He);
}
const Rt = "blora-field", Ve = [
  "autocomplete",
  "inputmode",
  "aria-label",
  "autocapitalize",
  "spellcheck",
  "enterkeyhint"
];
function Gt(a, l) {
  Ve.forEach((t) => {
    const e = a.getAttribute(t);
    e === null ? l.removeAttribute(t) : l.setAttribute(t, e);
  });
}
let $r = 0;
function Fr(a) {
  const l = a.querySelectorAll(
    "[data-limit], [data-blora-limit]"
  ), t = [], e = (r, n) => {
    const i = Array.from(r || "");
    return {
      count: i.length,
      normal: i.slice(0, n).join(""),
      overflow: i.slice(n).join("")
    };
  };
  return l.forEach((r) => {
    var m;
    const n = Number(r.dataset.limit ?? r.dataset.bloraLimit ?? 0);
    if (!Number.isFinite(n) || n < 1) return;
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
      const p = e(r.value, n), h = p.count > n;
      o.textContent = p.normal || "", c.textContent = p.overflow || "", u.textContent = `${p.count}/${n}`, h ? i.setAttribute("data-over-limit", "") : i.removeAttribute("data-over-limit"), h ? r.setAttribute("aria-invalid", "true") : r.removeAttribute("aria-invalid"), b();
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
class Hr extends B {
  constructor() {
    super(...arguments);
    A(this, "controller", null);
    A(this, "reflecting", !1);
    A(this, "controlId", `blora-field-${++$r}`);
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
      ...Ve
    ];
  }
  attributeChangedCallback() {
    var n;
    if (!this.isConnectedInternal || this.reflecting) return;
    const t = this.querySelector("input, textarea"), e = this.hasAttribute("textarea"), r = t instanceof HTMLTextAreaElement;
    if (t && e !== r) {
      const i = t.value;
      (n = this.controller) == null || n.destroy(), this.render();
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
    const e = this.getAttribute("state") ?? (this.hasAttribute("error") ? "invalid" : null);
    (e === "invalid" || e === "valid") && (t.dataset.state = e);
    const r = this.getAttribute("hint") ?? "", n = this.getAttribute("error") ?? "", i = this.id ? `${this.id}-control` : this.controlId, s = `${i}-hint`, o = `${i}-error`, c = this.getAttribute("layout");
    c === "horizontal" && (t.dataset.layout = c);
    const u = this.getAttribute("validate");
    u && (t.dataset.bloraValidate = u);
    const b = this.getAttribute("label");
    if (b) {
      const w = this.ownerDocument.createElement("label");
      w.className = "blora-field__label", w.htmlFor = i, w.textContent = b, this.hasAttribute("required") && (w.dataset.required = ""), t.appendChild(w);
    }
    const d = this.hasAttribute("textarea") ? this.ownerDocument.createElement("textarea") : this.ownerDocument.createElement("input");
    d.id = i, d.className = this.hasAttribute("textarea") ? "blora-textarea" : "blora-input", d instanceof HTMLInputElement && (d.type = this.getAttribute("type") ?? "text"), d.name = this.getAttribute("name") ?? "", d.value = this.getAttribute("value") ?? "", d.placeholder = this.getAttribute("placeholder") ?? "", d.required = this.hasAttribute("required"), d.disabled = this.hasAttribute("disabled"), d.readOnly = this.hasAttribute("readonly"), Gt(this, d), (e === "invalid" || n) && d.setAttribute("aria-invalid", "true");
    const m = [];
    r && m.push(s), n && m.push(o), m.length && d.setAttribute("aria-describedby", m.join(" "));
    const p = this.getAttribute("limit");
    p && (d.dataset.limit = p);
    const h = this.getAttribute("minlength");
    h && (d.minLength = Number(h));
    const E = this.getAttribute("maxlength");
    E && (d.maxLength = Number(E));
    const y = this.getAttribute("pattern");
    if (y && d instanceof HTMLInputElement && (d.pattern = y), t.appendChild(d), r) {
      const w = this.ownerDocument.createElement("span");
      w.id = s, w.className = "blora-field__help", w.textContent = r, t.appendChild(w);
    }
    const v = this.ownerDocument.createElement("span");
    v.id = o, v.className = "blora-field__error", n ? v.textContent = n : v.hidden = !0, t.appendChild(v), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-field"), e = t == null ? void 0 : t.querySelector("input, textarea");
    if (!t || !e) return;
    const r = this.getAttribute("state") ?? (this.hasAttribute("error") ? "invalid" : null), n = this.getAttribute("hint") ?? "", i = this.getAttribute("error") ?? "", s = this.id ? `${this.id}-control` : this.controlId, o = `${s}-hint`, c = `${s}-error`;
    r === "invalid" || r === "valid" ? t.dataset.state = r : delete t.dataset.state;
    const u = this.getAttribute("layout");
    u === "horizontal" ? t.dataset.layout = u : delete t.dataset.layout;
    const b = this.getAttribute("validate");
    b ? t.dataset.bloraValidate = b : delete t.dataset.bloraValidate;
    const d = t.querySelector(".blora-field__label");
    d && (d.textContent = this.getAttribute("label") ?? "", d.toggleAttribute("data-required", this.hasAttribute("required"))), e instanceof HTMLInputElement && (e.type = this.getAttribute("type") ?? "text"), e.name = this.getAttribute("name") ?? "", document.activeElement !== e && (e.value = this.getAttribute("value") ?? e.value), e.placeholder = this.getAttribute("placeholder") ?? "", e.required = this.hasAttribute("required"), e.disabled = this.hasAttribute("disabled"), e.readOnly = this.hasAttribute("readonly"), Gt(this, e), r === "invalid" || i ? e.setAttribute("aria-invalid", "true") : e.removeAttribute("aria-invalid");
    const m = [];
    n && m.push(o), i && m.push(c), m.length ? e.setAttribute("aria-describedby", m.join(" ")) : e.removeAttribute("aria-describedby");
    const p = this.getAttribute("limit");
    p ? e.dataset.limit = p : delete e.dataset.limit;
    const h = this.getAttribute("minlength");
    h ? e.minLength = Number(h) : e.removeAttribute("minlength");
    const E = this.getAttribute("maxlength");
    E ? e.maxLength = Number(E) : e.removeAttribute("maxlength");
    const y = this.getAttribute("pattern");
    y && e instanceof HTMLInputElement ? e.pattern = y : e instanceof HTMLInputElement && e.removeAttribute("pattern");
    let v = t.querySelector(".blora-field__help");
    if (n) {
      if (!v) {
        v = this.ownerDocument.createElement("span"), v.id = o, v.className = "blora-field__help";
        const D = t.querySelector(".blora-field__error");
        D ? t.insertBefore(v, D) : t.appendChild(v);
      }
      v.textContent = n, v.id = o;
    } else
      v == null || v.remove();
    const w = t.querySelector(".blora-field__error");
    w && (w.id = c, w.textContent = i, w.hidden = !i);
  }
  bindEvents() {
    var r;
    const t = this.querySelector(".blora-field"), e = t == null ? void 0 : t.querySelector("input, textarea");
    !t || !e || ((r = this.controller) == null || r.destroy(), this.controller = Fr(t), this.listen(e, "input", () => {
      this.reflecting = !0, this.setAttribute("value", e.value), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Fa(a = customElements) {
  !a || a.get(Rt) || a.define(Rt, Hr);
}
const $t = "blora-upload";
function Vr(a) {
  const l = a.querySelector(
    ".blora-dropzone, .blora-file-picker, .blora-upload__zone"
  );
  if (!l) return { destroy: () => {
  } };
  const t = l.classList.contains("blora-file-picker");
  let e = a.querySelector('input[type="file"]');
  e || (e = document.createElement("input"), e.type = "file", e.className = t ? "blora-file-picker__input" : "blora-dropzone__input", e.setAttribute("aria-hidden", "true"), a.appendChild(e));
  const r = a.querySelector(".blora-upload__list"), n = a.querySelector(".blora-file-picker__empty"), i = a.querySelector(".blora-file-picker__status"), s = a.querySelector(".blora-file-status__name"), o = a.querySelector(".blora-file-clear"), c = a.querySelector(".blora-file-picker__trigger"), u = (_) => {
    const C = _ == null ? void 0 : _[0];
    if (!(!n || !i || !s)) {
      if (!C) {
        n.hidden = !1, i.hidden = !0, s.textContent = "", o && (o.hidden = !0);
        return;
      }
      n.hidden = !0, i.hidden = !1, s.textContent = C.name, o && (o.hidden = !1);
    }
  }, b = (_) => {
    !_ || !_.length || !r || Array.from(_).forEach((C) => {
      const L = document.createElement("div");
      L.className = "blora-upload__row";
      const T = document.createElement("span");
      T.className = "blora-upload__name", T.textContent = C.name;
      const f = document.createElement("span");
      f.className = "blora-upload__size", f.textContent = C.size > 1024 * 1024 ? (C.size / (1024 * 1024)).toFixed(1) + " MB" : Math.round(C.size / 1024) + " KB", L.append(T, f), r.appendChild(L);
    });
  }, d = (_) => {
    t ? u(_) : b(_), a.dispatchEvent(new Event("change", { bubbles: !0 }));
  }, m = () => {
    e.disabled || e.click();
  }, p = () => d(e.files), h = (_) => {
    _.preventDefault(), m();
  }, E = (_) => {
    (_.key === "Enter" || _.key === " ") && (_.preventDefault(), m());
  }, y = (_) => {
    _.preventDefault(), _.stopPropagation(), e.value = "", d(null);
  }, v = t ? [c, n].filter(Boolean) : [l];
  v.forEach((_) => {
    _.addEventListener("click", h), _.addEventListener("keydown", E);
  }), !t && !l.hasAttribute("tabindex") && (l.tabIndex = 0), e.addEventListener("change", p), o == null || o.addEventListener("click", y);
  const w = (_) => {
    _.preventDefault(), l.setAttribute("data-dragover", "");
  }, D = () => l.removeAttribute("data-dragover"), x = (_) => {
    var C;
    _.preventDefault(), l.removeAttribute("data-dragover"), d(((C = _.dataTransfer) == null ? void 0 : C.files) ?? null);
  };
  return l.addEventListener("dragover", w), l.addEventListener("dragleave", D), l.addEventListener("drop", x), {
    destroy() {
      v.forEach((_) => {
        _.removeEventListener("click", h), _.removeEventListener("keydown", E);
      }), e.removeEventListener("change", p), o == null || o.removeEventListener("click", y), l.removeEventListener("dragover", w), l.removeEventListener("dragleave", D), l.removeEventListener("drop", x);
    }
  };
}
class ze extends B {
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
    const r = this.getAttribute("name") ?? "", n = new FormData();
    for (const i of Array.from(e)) n.append(r, i, i.name);
    Y(this.internals, n);
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
    const e = this.getAttribute("variant") === "compact", r = this.hasAttribute("disabled"), n = this.getAttribute("prompt") ?? (e ? g("upload.choose") : g("upload.drop")), i = this.getAttribute("hint") ?? (e ? g("upload.hint") : g("upload.drop")), s = this.ownerDocument.createElement("input");
    if (s.className = e ? "blora-file-picker__input" : "blora-dropzone__input", s.type = "file", s.name = this.internals ? "" : this.getAttribute("name") ?? "", s.accept = this.getAttribute("accept") ?? "", s.multiple = this.hasAttribute("multiple"), s.disabled = r, s.setAttribute("aria-hidden", "true"), e) {
      const o = this.ownerDocument.createElement("div");
      o.className = "blora-file-picker";
      const c = this.ownerDocument.createElement("button");
      c.type = "button", c.className = "blora-file-picker__trigger", c.disabled = r;
      const u = I("upload", 18, this.ownerDocument);
      u.setAttribute("stroke-width", "1.8");
      const b = this.ownerDocument.createElement("span");
      b.className = "blora-file-picker__label", b.textContent = n, c.append(u, b);
      const d = this.ownerDocument.createElement("span");
      d.className = "blora-file-picker__empty", d.textContent = i;
      const m = this.ownerDocument.createElement("span");
      m.className = "blora-file-status blora-file-picker__status", m.hidden = !0;
      const p = this.ownerDocument.createElement("span");
      p.className = "blora-file-status__name";
      const h = this.ownerDocument.createElement("button");
      h.type = "button", h.className = "blora-file-clear", h.hidden = !0, h.setAttribute("aria-label", g("file.clear")), h.title = g("file.clear"), h.appendChild(I("close", 14, this.ownerDocument)), m.append(p, h), o.append(s, c, d, m), t.append(o);
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
      d.textContent = n;
      const m = this.ownerDocument.createElement("span");
      m.textContent = ` ${g("upload.or")} ${g("upload.browse")}`, b.append(d, m);
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
    const e = this.getAttribute("variant") === "compact", r = this.hasAttribute("disabled"), n = t.querySelector('input[type="file"]');
    n && (n.name = this.internals ? "" : this.getAttribute("name") ?? "", n.accept = this.getAttribute("accept") ?? "", n.multiple = this.hasAttribute("multiple"), n.disabled = r);
    const i = this.getAttribute("prompt") ?? (e ? g("upload.choose") : g("upload.drop")), s = this.getAttribute("hint") ?? (e ? g("upload.hint") : g("upload.drop")), o = t.querySelector(".blora-upload__content strong");
    o && (o.textContent = this.getAttribute("prompt") ?? g("upload.drop"));
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
    (e = this.controller) == null || e.destroy(), this.controller = null, t && !this.hasAttribute("disabled") && (this.controller = Vr(t)), t && this.listen(t, "change", () => this.syncFormValue());
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
A(ze, "formAssociated", !0);
function Ha(a = customElements) {
  !a || a.get($t) || a.define($t, ze);
}
const Ft = "blora-tooltip";
function zr(a) {
  if (typeof document > "u") return { destroy: () => {
  } };
  const l = a.querySelector(".blora-tooltip__bubble");
  if (!l) return { destroy: () => {
  } };
  const t = a.ownerDocument.defaultView, e = () => {
    l.style.setProperty("--blora-float-shift-x", "0px"), l.style.setProperty("--blora-float-shift-y", "0px");
    const r = l.getBoundingClientRect(), n = 12;
    let i = 0, s = 0;
    r.left < n && (i += n - r.left), r.right + i > t.innerWidth - n && (i -= r.right + i - (t.innerWidth - n)), r.top < n && (s += n - r.top), r.bottom + s > t.innerHeight - n && (s -= r.bottom + s - (t.innerHeight - n)), l.style.setProperty("--blora-float-shift-x", `${i}px`), l.style.setProperty("--blora-float-shift-y", `${s}px`);
  };
  return a.addEventListener("pointerenter", e), a.addEventListener("focusin", e), t.addEventListener("resize", e), {
    destroy() {
      a.removeEventListener("pointerenter", e), a.removeEventListener("focusin", e), t.removeEventListener("resize", e);
    }
  };
}
class Yr extends B {
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
      const n = this.querySelector(".blora-tooltip");
      this.triggerNodes = n ? Array.from(n.childNodes).filter(
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
    const n = this.getAttribute("trigger");
    if (n) {
      const i = t.firstChild;
      (i == null ? void 0 : i.nodeType) === Node.TEXT_NODE && (i.textContent = n);
    }
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-tooltip");
    (e = this.controller) == null || e.destroy(), this.controller = t && !this.hasAttribute("disabled") ? zr(t) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Va(a = customElements) {
  !a || a.get(Ft) || a.define(Ft, Yr);
}
const Ht = "blora-popover";
function Wr(a, l) {
  if (typeof document > "u")
    return { open: () => {
    }, close: () => {
    }, destroy: () => {
    } };
  const t = a.querySelector("[data-blora-popover], .blora-popover__trigger") || a.querySelector("button"), e = a.querySelector(".blora-popover__panel");
  if (!t || !e)
    return { open: () => {
    }, close: () => {
    }, destroy: () => {
    } };
  const r = a.ownerDocument, n = (u) => {
    u ? a.setAttribute("data-open", "") : a.removeAttribute("data-open"), t.setAttribute("aria-expanded", String(u)), l == null || l(u);
  }, i = (u) => {
    u.stopPropagation(), n(!a.hasAttribute("data-open"));
  }, s = (u) => {
    !a.contains(u.target) && !e.contains(u.target) && n(!1);
  }, o = (u) => {
    u.key === "Escape" && n(!1);
  }, c = () => n(!1);
  return t.setAttribute("aria-haspopup", "dialog"), t.setAttribute("aria-expanded", "false"), t.addEventListener("click", i), r.addEventListener("click", s), r.addEventListener("keydown", o), e.querySelectorAll("[data-blora-close]").forEach((u) => u.addEventListener("click", c)), n(a.hasAttribute("data-open")), {
    open: () => n(!0),
    close: () => n(!1),
    destroy() {
      t.removeEventListener("click", i), r.removeEventListener("click", s), r.removeEventListener("keydown", o), e.querySelectorAll("[data-blora-close]").forEach((u) => u.removeEventListener("click", c));
    }
  };
}
class Ur extends B {
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
    e.type = "button", e.className = "blora-button blora-popover__trigger", e.dataset.variant = "outline", e.dataset.bloraPopover = "", e.disabled = this.hasAttribute("disabled"), e.textContent = this.getAttribute("trigger") ?? g("popover.trigger");
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-popover__panel", r.setAttribute("role", "dialog");
    const n = this.ownerDocument.createElement("div");
    n.className = "blora-popover__content", this.contentNodes ? n.append(...this.contentNodes) : n.textContent = this.getAttribute("content") ?? "";
    const i = this.ownerDocument.createElement("button");
    i.type = "button", i.className = "blora-button", i.dataset.size = "sm", i.dataset.bloraClose = "", i.textContent = this.getAttribute("close-label") ?? g("common.close"), r.append(n, i), t.append(e, r), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-popover");
    if (!t) return;
    const e = t.querySelector(".blora-popover__trigger");
    e && (e.textContent = this.getAttribute("trigger") ?? g("popover.trigger"), e.disabled = this.hasAttribute("disabled"));
    const r = t.querySelector(".blora-popover__content");
    r && !this.contentNodes && (r.textContent = this.getAttribute("content") ?? "");
    const n = t.querySelector("[data-blora-close]");
    n && (n.textContent = this.getAttribute("close-label") ?? g("common.close"));
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-popover");
    (e = this.controller) == null || e.destroy(), this.controller = t ? Wr(t, (r) => {
      this.reflecting = !0, this.toggleAttribute("open", r), this.reflecting = !1;
    }) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function za(a = customElements) {
  !a || a.get(Ht) || a.define(Ht, Ur);
}
const Vt = "blora-popconfirm";
function Kr(a) {
  if (typeof document > "u") return { destroy: () => {
  } };
  const l = a.querySelector(
    "[data-blora-popconfirm-trigger], .blora-popconfirm__trigger"
  ) || a.querySelector("button"), t = a.querySelector(".blora-popconfirm__panel");
  if (!l || !t) return { destroy: () => {
  } };
  const e = (s) => {
    s ? a.setAttribute("data-open", "") : a.removeAttribute("data-open");
  }, r = (s) => {
    s.stopPropagation(), e(!a.hasAttribute("data-open"));
  }, n = (s) => {
    const o = s.target;
    o.closest("[data-confirm], [data-blora-confirm]") && (a.dispatchEvent(new CustomEvent("blora-confirm", { bubbles: !0 })), e(!1)), o.closest("[data-cancel], [data-blora-cancel], [data-blora-close]") && e(!1);
  }, i = (s) => {
    a.contains(s.target) || e(!1);
  };
  return l.addEventListener("click", r), t.addEventListener("click", n), a.ownerDocument.addEventListener("click", i), {
    destroy() {
      l.removeEventListener("click", r), t.removeEventListener("click", n), a.ownerDocument.removeEventListener("click", i);
    }
  };
}
class Xr extends B {
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
    e.type = "button", e.className = "blora-button blora-popconfirm__trigger", e.dataset.variant = "danger", e.dataset.bloraPopconfirmTrigger = "", e.disabled = this.hasAttribute("disabled"), e.textContent = this.getAttribute("trigger") ?? g("popconfirm.trigger");
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-popconfirm__panel", r.setAttribute("role", "alertdialog");
    const n = this.ownerDocument.createElement("p");
    n.className = "blora-popconfirm__title", n.textContent = this.getAttribute("message") ?? g("popconfirm.message");
    const i = this.ownerDocument.createElement("div");
    i.className = "blora-popconfirm__actions";
    const s = this.ownerDocument.createElement("button");
    s.type = "button", s.className = "blora-button", s.dataset.size = "sm", s.dataset.variant = "ghost", s.dataset.cancel = "", s.textContent = this.getAttribute("cancel-label") ?? g("common.cancel");
    const o = this.ownerDocument.createElement("button");
    o.type = "button", o.className = "blora-button", o.dataset.size = "sm", o.dataset.variant = "danger", o.dataset.confirm = "", o.textContent = this.getAttribute("confirm-label") ?? g("common.confirm"), i.append(s, o), r.append(n, i), t.append(e, r), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-popconfirm__trigger");
    t && (t.textContent = this.getAttribute("trigger") ?? g("popconfirm.trigger"), t.disabled = this.hasAttribute("disabled"));
    const e = this.querySelector(".blora-popconfirm__title");
    e && (e.textContent = this.getAttribute("message") ?? g("popconfirm.message"));
    const r = this.querySelector("[data-cancel]");
    r && (r.textContent = this.getAttribute("cancel-label") ?? g("common.cancel"));
    const n = this.querySelector("[data-confirm]");
    n && (n.textContent = this.getAttribute("confirm-label") ?? g("common.confirm"));
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-popconfirm");
    (e = this.controller) == null || e.destroy(), this.controller = t ? Kr(t) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Ya(a = customElements) {
  !a || a.get(Vt) || a.define(Vt, Xr);
}
const zt = "blora-dropdown";
function jr(a) {
  const l = new AbortController(), { signal: t } = l, e = a.querySelector("[data-dropdown-trigger]"), r = a.querySelector(".blora-dropdown__menu");
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
  const n = e, i = r, s = !!i.querySelector(".blora-dropdown__item");
  n.setAttribute("aria-haspopup", s ? "menu" : "dialog"), n.id || (n.id = `blora-dropdown-trigger-${Math.random().toString(36).slice(2, 9)}`), i.setAttribute("role", s ? "menu" : "dialog"), i.setAttribute("aria-labelledby", n.id);
  function o() {
    return a.hasAttribute("data-open");
  }
  function c() {
    n.setAttribute("aria-expanded", String(o())), i.setAttribute("aria-hidden", String(!o()));
  }
  function u() {
    document.querySelectorAll(".blora-dropdown[data-open]").forEach((m) => {
      var p, h;
      m !== a && (m.removeAttribute("data-open"), (p = m.querySelector("[data-dropdown-trigger]")) == null || p.setAttribute("aria-expanded", "false"), (h = m.querySelector(".blora-dropdown__menu")) == null || h.setAttribute("aria-hidden", "true"));
    }), a.setAttribute("data-open", ""), c();
  }
  function b() {
    a.removeAttribute("data-open"), c();
  }
  function d() {
    o() ? b() : u();
  }
  return n.addEventListener(
    "click",
    (m) => {
      n.getAttribute("aria-disabled") !== "true" && (m.stopPropagation(), d());
    },
    { signal: t }
  ), n.addEventListener(
    "keydown",
    (m) => {
      n.getAttribute("aria-disabled") !== "true" && (m.key !== "Enter" && m.key !== " " || (m.preventDefault(), m.stopPropagation(), d()));
    },
    { signal: t }
  ), i.addEventListener(
    "click",
    (m) => {
      m.target.closest(".blora-dropdown__item") && b();
    },
    { signal: t }
  ), a.addEventListener(
    "keydown",
    (m) => {
      m.key === "Escape" && o() && (m.stopPropagation(), b(), n.focus());
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
class Qr extends B {
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
    const n = t ? t.cloneNode(!0) : this.ownerDocument.createElement("button");
    if (n.dataset.dropdownTrigger = "", n.dataset.trigger = t ? "custom" : "default", t)
      n.hasAttribute("role") || n.setAttribute("role", "button"), n.hasAttribute("tabindex") || n.setAttribute("tabindex", "0"), this.hasAttribute("disabled") && (n.setAttribute("aria-disabled", "true"), n.setAttribute("tabindex", "-1"));
    else {
      const s = n;
      s.type = "button", s.className = "blora-button", s.disabled = this.hasAttribute("disabled");
      const o = this.getAttribute("label") ?? g("dropdown.label");
      if (this.isHelper())
        n.dataset.variant = "ghost", n.dataset.size = "icon", n.setAttribute("aria-label", o), n.append(I("info", 16, this.ownerDocument));
      else {
        n.dataset.variant = "outline";
        const c = this.ownerDocument.createElement("span");
        c.className = "blora-dropdown__label", c.textContent = o, n.append(c, I("chevron-down", 16, this.ownerDocument));
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
    r.append(n, i), this.replaceChildren(r);
  }
  sync() {
    const t = this.querySelector(".blora-dropdown"), e = this.querySelector("[data-dropdown-trigger]");
    if (!t || !e) return;
    t.dataset.align = this.alignValue(), t.dataset.placement = this.placementValue(), this.hasAttribute("disabled") ? (e.setAttribute("aria-disabled", "true"), e instanceof HTMLButtonElement && (e.disabled = !0)) : (e.removeAttribute("aria-disabled"), e instanceof HTMLButtonElement && (e.disabled = !1));
    const r = this.getAttribute("label") ?? g("dropdown.label"), n = e.querySelector(".blora-dropdown__label");
    n && (n.textContent = r), t.dataset.trigger !== "custom" && this.isHelper() && e.setAttribute("aria-label", r);
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-dropdown");
    t && ((e = this.controller) == null || e.destroy(), this.controller = jr(t), this.listen(t, "click", (r) => {
      const n = r.target.closest(".blora-dropdown__item");
      n && n.getAttribute("aria-disabled") !== "true" && this.emit("blora-select", { value: n.dataset.value ?? "" });
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Wa(a = customElements) {
  !a || a.get(zt) || a.define(zt, Qr);
}
const Yt = "blora-drawer";
function Jr(a) {
  if (typeof a.showPopover == "function" && (a.setAttribute("popover", "manual"), !a.matches(":popover-open")))
    try {
      a.showPopover();
    } catch {
    }
}
function Wt(a) {
  if (typeof a.hidePopover == "function")
    try {
      a.hidePopover();
    } catch {
    }
  a.getAttribute("popover") === "manual" && a.removeAttribute("popover");
}
function Zr(a, l) {
  if (typeof document > "u")
    return { open: () => {
    }, close: () => {
    }, destroy: () => {
    } };
  const t = l ?? a.closest("blora-drawer") ?? a, e = a.querySelector(".blora-drawer__panel");
  let r = !1, n = null, i = null;
  const s = () => o(!1), o = (u) => {
    if (!r) {
      r = !0;
      try {
        if (u) {
          i == null || i(), i = null, a.setAttribute("data-open", ""), a.setAttribute("open", ""), t !== a && (t.setAttribute("data-open", ""), t.setAttribute("open", "")), e == null || e.setAttribute("tabindex", "-1"), n == null || n.close(), n = new dt(a, {
            modal: !0,
            closeOnEscape: !0,
            closeOnOutsidePointer: !1,
            restoreFocus: !0,
            trapFocus: !0,
            lockScroll: !0
          }), n.open(), a.addEventListener("blora-close-request", s), Jr(a);
          return;
        }
        a.removeAttribute("data-open"), a.removeAttribute("open"), t !== a && (t.removeAttribute("data-open"), t.removeAttribute("open")), a.removeEventListener("blora-close-request", s);
        const b = n;
        n = null, i == null || i(), i = rt(a, () => {
          i = null, b == null || b.close(), Wt(a);
        });
      } finally {
        r = !1;
      }
    }
  }, c = (u) => {
    const b = u.target;
    (b.closest("[data-blora-close]") || b.classList.contains("blora-drawer__mask")) && o(!1);
  };
  return a.addEventListener("click", c), {
    open: () => o(!0),
    close: () => o(!1),
    destroy() {
      a.removeEventListener("click", c), a.removeEventListener("blora-close-request", s), n == null || n.destroy(), n = null, i == null || i(), Wt(a);
    }
  };
}
class tn extends B {
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
          const n = this.querySelector(".blora-drawer") ?? this;
          rt(n, () => this.restoreHome());
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
    const n = this.ownerDocument.createElement("div");
    n.className = "blora-drawer__header";
    const i = this.ownerDocument.createElement("h3");
    i.className = "blora-drawer__title", i.textContent = this.getAttribute("title") ?? g("drawer.title");
    const s = this.ownerDocument.createElement("button");
    s.type = "button", s.className = "blora-drawer__close", s.dataset.bloraClose = "", s.setAttribute("aria-label", this.getAttribute("close-label") ?? g("common.close")), s.appendChild(I("close", 18, this.ownerDocument)), n.append(i, s);
    const o = this.ownerDocument.createElement("div");
    o.className = "blora-drawer__body";
    const c = this.ownerDocument.createElement("div");
    c.className = "blora-drawer__content", c.append(...this.contentNodes), o.appendChild(c), r.append(n, o), t.append(e, r), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-drawer");
    if (!t) return;
    t.dataset.position = this.getAttribute("position") ?? "right";
    const e = t.querySelector(".blora-drawer__title");
    e && (e.textContent = this.getAttribute("title") ?? g("drawer.title"));
    const r = t.querySelector(".blora-drawer__close");
    r && r.setAttribute("aria-label", this.getAttribute("close-label") ?? g("common.close"));
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-drawer");
    (e = this.controller) == null || e.destroy(), this.controller = t ? Zr(t, this) : null;
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
function Ua(a = customElements) {
  !a || a.get(Yt) || a.define(Yt, tn);
}
const Ut = "blora-backtop";
function en(a) {
  if (a.querySelector("svg")) return;
  const l = I("arrow-up", 22, a.ownerDocument);
  l.setAttribute("stroke-width", "2.5"), (a.childNodes.length > 0 && Array.from(a.childNodes).every(
    (e) => e.nodeType === Node.TEXT_NODE || e.nodeType === Node.COMMENT_NODE
  ) || a.childNodes.length === 0) && Array.from(a.childNodes).forEach((e) => {
    e.nodeType === Node.TEXT_NODE && e.remove();
  }), a.appendChild(l);
}
function Ye(a, l) {
  if (typeof document > "u" || typeof window > "u")
    return { show: () => {
    }, hide: () => {
    }, destroy: () => {
    } };
  a.classList.add("blora-backtop"), en(a), a.getAttribute("aria-label") || a.setAttribute("aria-label", g("common.backTop"));
  const t = Number(
    a.getAttribute("data-show-after") || a.getAttribute("data-blora-backtop") || ""
  ), e = Number.isFinite(t) && t > 0 ? t : 400, r = a.getAttribute("data-target");
  let n = window;
  if (r) {
    const d = document.querySelector(r);
    d && (n = d);
  }
  const i = () => n === window ? window.scrollY || document.documentElement.scrollTop || 0 : n.scrollTop, s = () => {
    a.removeAttribute("data-hidden"), a.classList.add("is-visible");
  }, o = () => {
    a.setAttribute("data-hidden", ""), a.classList.remove("is-visible");
  }, c = () => {
    i() >= e ? s() : o();
  }, u = (d) => {
    d.preventDefault(), n === window ? window.scrollTo({ top: 0, behavior: "smooth" }) : n.scrollTo({ top: 0, behavior: "smooth" });
  };
  o(), c();
  const b = n === window ? window : n;
  return b.addEventListener("scroll", c, { passive: !0 }), a.addEventListener("click", u), {
    show: s,
    hide: o,
    destroy() {
      b.removeEventListener("scroll", c), a.removeEventListener("click", u);
    }
  };
}
function Ka(a = document) {
  if (typeof document > "u") return () => {
  };
  const l = [];
  return a.querySelectorAll("[data-blora-backtop], .blora-backtop").forEach((t) => {
    t.classList.contains("blora-fab--static") || l.push(Ye(t));
  }), () => l.forEach((t) => t.destroy());
}
class rn extends B {
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
    t.type = "button", t.className = "blora-backtop", t.dataset.bloraGenerated = "", t.setAttribute("aria-label", this.getAttribute("label") ?? g("common.backTop"));
    const e = this.getAttribute("show-after");
    e && (t.dataset.showAfter = e);
    const r = this.getAttribute("target");
    r && (t.dataset.target = r), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector(".blora-backtop");
    if (!t) return;
    t.setAttribute("aria-label", this.getAttribute("label") ?? g("common.backTop"));
    const e = this.getAttribute("show-after");
    e ? t.dataset.showAfter = e : delete t.dataset.showAfter;
    const r = this.getAttribute("target");
    r ? t.dataset.target = r : delete t.dataset.target, this.rebind();
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-backtop");
    (e = this.controller) == null || e.destroy(), this.controller = t ? Ye(t) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Xa(a = customElements) {
  !a || a.get(Ut) || a.define(Ut, rn);
}
const Kt = "blora-copy";
function nn(a) {
  const l = a.ownerDocument, t = l.defaultView, e = a.querySelector(
    ".blora-copy__btn, .blora-typo-copy__btn, [data-copy]"
  );
  if (!e) return { destroy: () => {
  } };
  let r = [], n = null;
  const i = () => I("check", 14, l), s = async (o) => {
    var b;
    o.preventDefault(), o.stopPropagation();
    const c = a.getAttribute("data-blora-copy") || a.dataset.copyText || e.dataset.copyText || ((b = a.textContent) == null ? void 0 : b.trim()) || "";
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
    u && (r = Array.from(e.childNodes), e.replaceChildren(i()), a.setAttribute("data-copied", ""), n && clearTimeout(n), n = setTimeout(() => {
      e.replaceChildren(...r), a.removeAttribute("data-copied");
    }, 1500));
  };
  return e.addEventListener("click", s), {
    destroy() {
      e.removeEventListener("click", s), n && clearTimeout(n);
    }
  };
}
class an extends B {
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
    const n = this.ownerDocument.createElement("button");
    if (n.type = "button", n.className = "blora-copy__btn blora-typo-copy__btn", n.setAttribute("aria-label", this.getAttribute("label") ?? g("common.copy")), n.appendChild(I("copy", 14, this.ownerDocument)), e.append(r, n), this.hasAttribute("masked")) {
      e.dataset.masked = "";
      const s = this.ownerDocument.createElement("button");
      s.type = "button", s.className = "blora-copy__reveal-btn", s.setAttribute("aria-label", g("copy.show")), s.appendChild(I("eye", 16, this.ownerDocument)), e.appendChild(s), this.updateMaskedDisplay(e, t);
    } else
      r.textContent = t;
    this.replaceChildren(e);
  }
  updateMaskedDisplay(t, e) {
    const r = t.querySelector("code");
    if (!r) return;
    r.textContent = this.revealed ? e : "•".repeat(Math.max(1, [...e].length)), t.dataset.revealed = String(this.revealed);
    const n = t.querySelector(".blora-copy__reveal-btn");
    n && (n.setAttribute("aria-label", this.revealed ? g("copy.hide") : g("copy.show")), n.setAttribute("aria-pressed", String(this.revealed)), n.replaceChildren(
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
    const n = t.querySelector(".blora-copy__btn");
    n && n.setAttribute("aria-label", this.getAttribute("label") ?? g("common.copy"));
  }
  bindEvents() {
    var r;
    const t = this.querySelector(".blora-copy");
    (r = this.controller) == null || r.destroy(), this.controller = t ? nn(t) : null;
    const e = t == null ? void 0 : t.querySelector(".blora-copy__reveal-btn");
    t && e && this.listen(e, "click", (n) => {
      n.preventDefault(), n.stopPropagation(), this.revealed = !this.revealed, this.updateMaskedDisplay(t, this.getAttribute("text") ?? this.initialText ?? "");
    });
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function ja(a = customElements) {
  !a || a.get(Kt) || a.define(Kt, an);
}
const Xt = "blora-progress";
function sn(a) {
  const l = a.querySelector(".blora-progress__fill") ?? a.querySelector(".blora-progress__ring-fill") ?? a.querySelector(".blora-progress__bar") ?? a, t = a.querySelector("[data-progress-label]") ?? a.querySelector(".blora-progress__label"), e = (n) => {
    const i = Math.max(0, Math.min(100, n));
    a.setAttribute("aria-valuenow", String(i)), a.dataset.value = String(i), l.classList.contains("blora-progress__ring-fill") ? l.style.strokeDashoffset = String(100 - i) : l.style.width = `${i}%`, t && (t.textContent = `${Math.round(i)}%`);
  }, r = Number(a.dataset.value || a.getAttribute("aria-valuenow") || 0);
  return Number.isNaN(r) || e(r), {
    setValue: e,
    destroy() {
    }
  };
}
class on extends B {
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
    if (e.dataset.shape = r, e.setAttribute("aria-label", this.getAttribute("label") ?? g("progress.label")), r === "circular") {
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
    const n = this.ownerDocument.createElement("div");
    n.className = "blora-progress__label";
    const i = this.ownerDocument.createElement("span");
    i.textContent = this.getAttribute("label") ?? g("progress.label");
    const s = this.ownerDocument.createElement("span");
    s.dataset.progressLabel = "", s.textContent = `${Math.round(t)}%`, n.append(i, s);
    const o = this.ownerDocument.createElement("div");
    o.className = "blora-progress__bar";
    const c = this.ownerDocument.createElement("div");
    c.className = "blora-progress__fill";
    const u = this.getAttribute("variant");
    u && (c.dataset.variant = u), o.appendChild(c), e.append(n, o), this.replaceChildren(e);
  }
  sync() {
    var s;
    const t = this.querySelector(".blora-progress");
    if (!t) return;
    const e = Math.max(0, Math.min(100, Number(this.getAttribute("value") ?? 0)));
    t.setAttribute("aria-label", this.getAttribute("label") ?? g("progress.label"));
    const r = this.getAttribute("variant"), n = t.querySelector(".blora-progress__fill") ?? t.querySelector(".blora-progress__ring-fill");
    n && (r ? n.dataset.variant = r : delete n.dataset.variant);
    const i = t.querySelector(".blora-progress__label span:not([data-progress-label])");
    i && (i.textContent = this.getAttribute("label") ?? g("progress.label")), (s = this.controller) == null || s.setValue(e);
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-progress");
    (e = this.controller) == null || e.destroy(), this.controller = t ? sn(t) : null;
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function Qa(a = customElements) {
  !a || a.get(Xt) || a.define(Xt, on);
}
const jt = "blora-number-input";
class We extends B {
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
    const r = `blora-number-input-${Math.random().toString(36).slice(2, 9)}`, n = this.getAttribute("label");
    if (n) {
      const b = t.createElement("label");
      b.className = "blora-number-input__label", b.htmlFor = r, b.textContent = n, e.appendChild(b);
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
    const c = this.makeButton(g("number.decrease"), "minus", -1), u = this.makeButton(g("number.increase"), "plus", 1);
    o.append(c, u), i.append(s, o), e.appendChild(i), this.replaceChildren(e), Y(this.internals, String(this.value));
  }
  makeButton(t, e, r) {
    const n = this.ownerDocument.createElement("button");
    return n.type = "button", n.className = "blora-number-input__button", n.dataset.direction = String(r), n.disabled = this.hasAttribute("disabled"), n.setAttribute("aria-label", t), n.appendChild(I(e, 14, this.ownerDocument)), n;
  }
  sync() {
    const t = this.querySelector("input");
    if (!t) return;
    t.name = this.internals ? "" : this.getAttribute("name") ?? "", document.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value);
    for (const r of ["min", "max", "step"]) {
      const n = this.getAttribute(r);
      n !== null ? t.setAttribute(r, n) : t.removeAttribute(r);
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
A(We, "formAssociated", !0);
function Ja(a = customElements) {
  !a || a.get(jt) || a.define(jt, We);
}
const Qt = "blora-swap";
class ln extends B {
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
    const n = t.createElement("span");
    n.className = "blora-swap__visual", n.setAttribute("aria-hidden", "true");
    const i = this.hasAttribute("checked"), s = this.getAttribute(i ? "on-icon" : "off-icon") ?? (i ? "sun" : "moon");
    n.appendChild(I(s, 18, t));
    const o = t.createElement("span");
    o.className = "blora-swap__label", o.textContent = this.getAttribute(i ? "on-label" : "off-label") ?? (i ? g("swap.on") : g("swap.off")), e.append(r, n, o), this.replaceChildren(e);
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
    const n = this.querySelector(".blora-swap__label");
    n && (n.textContent = this.getAttribute(e ? "on-label" : "off-label") ?? (e ? g("swap.on") : g("swap.off")));
  }
  bindEvents() {
    const t = this.querySelector("input");
    t && this.listen(t, "change", () => {
      this.reflecting = !0, this.toggleAttribute("checked", t.checked), this.reflecting = !1, this.sync(), this.dispatchEvent(new Event("change", { bubbles: !0 }));
    });
  }
}
function Za(a = customElements) {
  !a || a.get(Qt) || a.define(Qt, ln);
}
const Jt = "blora-pagination";
function Zt(a, l, t = 7) {
  const e = Math.max(1, Math.floor(l)), r = Math.max(1, Math.min(e, Math.floor(a))), n = Math.max(5, Math.floor(t)), i = Array.from({ length: e }, (w, D) => D + 1);
  if (e <= n)
    return {
      windowed: !1,
      items: i,
      inner: i,
      offset: 0,
      windowSize: i.length,
      showStartEllipsis: !1,
      showEndEllipsis: !1
    };
  const s = Math.max(1, n - 2), o = e - 2, c = Math.floor((s - 1) / 2), u = Math.max(2, e - 1 - s + 1);
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
  let h = s, E = b - 2;
  m || (h += 1, E = 0, b = 2), p || (h += 1, E = Math.max(0, o - h), b = 2 + E);
  const y = Array.from({ length: h }, (w, D) => b + D).filter(
    (w) => w > 1 && w < e
  ), v = [1];
  return m && v.push("ellipsis"), v.push(...y), p && v.push("ellipsis"), v.push(e), {
    windowed: !0,
    items: v,
    inner: y,
    offset: E,
    windowSize: h,
    showStartEllipsis: m,
    showEndEllipsis: p
  };
}
function cn(a) {
  if (typeof document > "u") return { destroy: () => {
  } };
  const l = () => Array.from(
    a.querySelectorAll(
      ".blora-pagination__item:not(.blora-pagination__nav):not(.blora-pagination__ellipsis)"
    )
  ).filter((n) => n.tagName === "BUTTON"), t = (n) => {
    l().forEach((i) => {
      i.removeAttribute("aria-current");
    }), n.setAttribute("aria-current", "page"), a.dispatchEvent(
      new CustomEvent("blora-change", {
        bubbles: !0,
        detail: { page: Number(n.dataset.page ?? n.textContent) }
      })
    ), e();
  }, e = () => {
    var u, b;
    const n = Number(
      ((u = a.querySelector('[aria-current="page"]')) == null ? void 0 : u.dataset.page) ?? 1
    ), i = Number(a.dataset.total ?? ((b = l().at(-1)) == null ? void 0 : b.dataset.page) ?? 1), s = a.querySelector(
      '.blora-pagination__nav[data-direction="prev"], .blora-pagination__nav:first-of-type'
    ), o = a.querySelectorAll(".blora-pagination__nav"), c = o[o.length - 1];
    s && (s.disabled = n <= 1), c && c !== s && (c.disabled = n >= i);
  }, r = (n) => {
    var m;
    const i = n.target, s = i.closest(
      ".blora-pagination__item:not(.blora-pagination__nav)"
    );
    if (s && a.contains(s) && s.tagName === "BUTTON") {
      t(s);
      return;
    }
    const o = i.closest(".blora-pagination__nav");
    if (!o || !a.contains(o)) return;
    const c = Number(
      ((m = a.querySelector('[aria-current="page"]')) == null ? void 0 : m.dataset.page) ?? 1
    ), u = Number(a.dataset.total ?? 1), d = o.dataset.direction === "prev" || o === a.querySelector(".blora-pagination__nav") ? c - 1 : c + 1;
    d < 1 || d > u || a.dispatchEvent(
      new CustomEvent("blora-change", { bubbles: !0, detail: { page: d } })
    );
  };
  return a.addEventListener("click", r), e(), {
    destroy() {
      a.removeEventListener("click", r);
    }
  };
}
class un extends B {
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
    const t = Math.max(1, Number(this.getAttribute("total") ?? 1)), e = Math.max(1, Math.min(t, Number(this.getAttribute("page") ?? 1))), r = Zt(e, t, Number(this.getAttribute("max-visible") ?? 7)), n = this.ownerDocument.createElement("nav");
    if (n.className = "blora-pagination", n.dataset.bloraGenerated = "", n.dataset.total = String(t), n.dataset.variant = this.layout(), n.setAttribute("aria-label", this.getAttribute("label") ?? g("pagination.nav")), this.layout() === "simple") {
      n.append(
        this.createNav("prev", "chevron-left"),
        this.createStatus(e),
        this.createNav("next", "chevron-right")
      ), this.replaceChildren(n), this.applyWindow(n, r, e, t);
      return;
    }
    if (n.appendChild(this.createNav("prev", "chevron-left")), r.windowed) {
      n.appendChild(this.createPageButton(1, e)), n.appendChild(this.createEllipsis("start"));
      const i = this.ownerDocument.createElement("div");
      i.className = "blora-pagination__window";
      const s = this.ownerDocument.createElement("div");
      s.className = "blora-pagination__track";
      for (let o = 2; o <= t - 1; o += 1)
        s.appendChild(this.createPageButton(o, e));
      i.appendChild(s), n.appendChild(i), n.appendChild(this.createEllipsis("end")), n.appendChild(this.createPageButton(t, e));
    } else
      for (const i of r.items)
        i !== "ellipsis" && n.appendChild(this.createPageButton(i, e));
    n.appendChild(this.createNav("next", "chevron-right")), this.replaceChildren(n), this.applyWindow(n, r, e, t), requestAnimationFrame(() => n.classList.add("is-animated"));
  }
  sync() {
    const t = this.querySelector(".blora-pagination");
    if (!t) return;
    const e = Math.max(1, Number(this.getAttribute("total") ?? 1)), r = Math.max(1, Math.min(e, Number(this.getAttribute("page") ?? 1))), n = Zt(r, e, Number(this.getAttribute("max-visible") ?? 7));
    if (this.layout() === "simple" != !!t.querySelector(".blora-pagination__status")) {
      this.render(), this.rebind();
      return;
    }
    if (this.layout() === "simple") {
      this.applyWindow(t, n, r, e);
      return;
    }
    if (n.windowed !== !!t.querySelector(".blora-pagination__track")) {
      this.render(), this.rebind();
      return;
    }
    this.applyWindow(t, n, r, e);
  }
  bindEvents() {
    const t = this.querySelector(".blora-pagination");
    t && (this.controller = cn(t), this.listen(t, "blora-change", (e) => {
      const r = e.detail.page;
      this.setAttribute("page", String(r));
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
  applyWindow(t, e, r, n) {
    var c, u;
    t.dataset.total = String(n), t.dataset.variant = this.layout(), t.setAttribute("aria-label", this.getAttribute("label") ?? g("pagination.nav"));
    const i = t.querySelector(".blora-pagination__status");
    i && (i.dataset.page = String(r), i.textContent = g("pagination.page", { n: r })), t.style.setProperty("--blora-pagination-window", String(e.windowSize)), t.style.setProperty("--blora-pagination-offset", String(e.offset)), (c = t.querySelector('[data-edge="start"]')) == null || c.toggleAttribute("data-inactive", !e.showStartEllipsis), (u = t.querySelector('[data-edge="end"]')) == null || u.toggleAttribute("data-inactive", !e.showEndEllipsis), t.querySelectorAll("button[data-page]").forEach((b) => {
      const d = Number(b.dataset.page), m = !e.windowed || d === 1 || d === n || e.inner.includes(d);
      d === r ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"), b.tabIndex = m ? 0 : -1, m ? b.removeAttribute("aria-hidden") : b.setAttribute("aria-hidden", "true");
    });
    const s = t.querySelector(
      '.blora-pagination__nav[data-direction="prev"]'
    ), o = t.querySelector(
      '.blora-pagination__nav[data-direction="next"]'
    );
    s && (s.disabled = this.hasAttribute("disabled") || r <= 1), o && (o.disabled = this.hasAttribute("disabled") || r >= n);
  }
  createStatus(t) {
    const e = this.ownerDocument.createElement("span");
    return e.className = "blora-pagination__status", e.dataset.page = String(t), e.setAttribute("aria-current", "page"), e.textContent = g("pagination.page", { n: t }), e;
  }
  createPageButton(t, e) {
    const r = this.ownerDocument.createElement("button");
    return r.type = "button", r.className = "blora-pagination__item", r.textContent = String(t), r.dataset.page = String(t), r.setAttribute("aria-label", g("pagination.page", { n: t })), r.disabled = this.hasAttribute("disabled"), t === e && r.setAttribute("aria-current", "page"), r;
  }
  createEllipsis(t) {
    const e = this.ownerDocument.createElement("span");
    return e.className = "blora-pagination__ellipsis", e.dataset.edge = t, e.setAttribute("aria-hidden", "true"), e.textContent = "…", e;
  }
  createNav(t, e) {
    const r = this.ownerDocument.createElement("button");
    return r.type = "button", r.className = "blora-pagination__item blora-pagination__nav", r.dataset.direction = t, r.setAttribute(
      "aria-label",
      t === "prev" ? g("pagination.prev") : g("pagination.next")
    ), r.disabled = this.hasAttribute("disabled"), r.appendChild(I(e, 18, this.ownerDocument)), r;
  }
}
function ti(a = customElements) {
  !a || a.get(Jt) || a.define(Jt, un);
}
const te = "blora-color-picker", ee = (a, l, t) => Math.max(l, Math.min(t, a)), et = (a) => {
  let l = String(a || "").trim();
  return l && !l.startsWith("#") && (l = "#" + l), /^#[0-9a-f]{3}$/i.test(l) && (l = "#" + l.slice(1).split("").map((t) => t + t).join("")), /^#[0-9a-f]{6}$/i.test(l) ? l.toUpperCase() : null;
}, re = (a) => {
  const l = et(a) || "#000000", t = parseInt(l.slice(1, 3), 16) / 255, e = parseInt(l.slice(3, 5), 16) / 255, r = parseInt(l.slice(5, 7), 16) / 255, n = Math.max(t, e, r), i = Math.min(t, e, r), s = n - i;
  let o = 0;
  return s && (n === t ? o = 60 * ((e - r) / s % 6) : n === e ? o = 60 * ((r - t) / s + 2) : o = 60 * ((t - e) / s + 4)), o < 0 && (o += 360), { h: o, s: n ? s / n : 0, v: n };
}, dn = ({ h: a, s: l, v: t }) => {
  const e = t * l, r = e * (1 - Math.abs(a / 60 % 2 - 1)), n = t - e;
  return "#" + (a < 60 ? [e, r, 0] : a < 120 ? [r, e, 0] : a < 180 ? [0, e, r] : a < 240 ? [0, r, e] : a < 300 ? [r, 0, e] : [e, 0, r]).map(
    (s) => Math.round((s + n) * 255).toString(16).padStart(2, "0")
  ).join("").toUpperCase();
};
function bn(a) {
  const l = a.querySelector(".blora-color-swatch");
  let t = a.querySelector(".blora-color-panel");
  if (!l) return { destroy: () => {
  } };
  t || (t = document.createElement("div"), t.className = "blora-color-panel", a.appendChild(t));
  let e = t.querySelector(".blora-color-spectrum");
  if (!e) {
    e = document.createElement("div"), e.className = "blora-color-spectrum", e.tabIndex = 0, e.setAttribute("role", "slider"), e.setAttribute("aria-label", g("color.spectrum"));
    const C = document.createElement("span");
    C.className = "blora-color-spectrum__cursor", C.setAttribute("aria-hidden", "true"), e.appendChild(C), t.insertBefore(e, t.firstChild);
  }
  const r = e.querySelector(".blora-color-spectrum__cursor");
  let n = t.querySelector(".blora-color-hue");
  n || (n = document.createElement("input"), n.className = "blora-color-hue", n.type = "range", n.min = "0", n.max = "359", n.step = "1", n.setAttribute("aria-label", g("color.hue")), e.insertAdjacentElement("afterend", n));
  let i = t.querySelector(".blora-color-hex");
  if (!i) {
    const C = document.createElement("div");
    C.className = "blora-color-custom";
    const L = document.createElement("span");
    L.className = "blora-color-preview", i = document.createElement("input"), i.className = "blora-input blora-color-hex", i.type = "text", i.placeholder = "#RRGGBB", C.append(L, i), t.appendChild(C);
  }
  const s = t.querySelector(".blora-color-preview");
  let o = et(l.dataset.color || "") || et(
    getComputedStyle(document.documentElement).getPropertyValue(
      "--blora-color-action-primary-default"
    )
  ) || "#3B82F6", c = re(o);
  const u = "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)", b = () => {
    const C = Math.round(c.h);
    e.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${C} 100% 50%)`, n.style.background = u;
  }, d = (C = !1) => {
    o = dn(c), l.style.background = o, l.dataset.color = o, l.setAttribute("aria-label", g("color.swatch", { color: o })), b(), n.value = String(Math.round(c.h)), r.style.left = c.s * 100 + "%", r.style.top = (1 - c.v) * 100 + "%", s && (s.style.background = o), i && document.activeElement !== i && (i.value = o), C && a.dispatchEvent(
      new CustomEvent("blora:change", {
        bubbles: !0,
        detail: { value: o, hsv: { ...c } }
      })
    );
  }, m = (C, L, T = !0) => {
    const f = e.getBoundingClientRect();
    c.s = ee((C - f.left) / f.width, 0, 1), c.v = 1 - ee((L - f.top) / f.height, 0, 1), d(T);
  }, p = (C) => {
    C.preventDefault(), e.focus(), e.setPointerCapture(C.pointerId), m(C.clientX, C.clientY);
  }, h = (C) => {
    e.hasPointerCapture(C.pointerId) && m(C.clientX, C.clientY);
  }, E = () => {
    c.h = Number(n.value), d(!0);
  }, y = () => {
    const C = et(i.value);
    i.setAttribute("aria-invalid", String(!C)), C && (c = re(C), d(!0));
  }, v = () => {
    t.removeAttribute("data-align-end"), t.setAttribute("data-open", ""), l.setAttribute("aria-expanded", "true"), t.getBoundingClientRect().right > window.innerWidth - 8 && t.setAttribute("data-align-end", ""), d();
  }, w = () => {
    t.removeAttribute("data-open"), l.setAttribute("aria-expanded", "false");
  }, D = (C) => {
    C.stopPropagation(), t.hasAttribute("data-open") ? w() : v();
  }, x = (C) => {
    a.contains(C.target) || w();
  }, _ = (C) => {
    C.key === "Escape" && w();
  };
  return l.setAttribute("role", "button"), l.tabIndex = 0, l.setAttribute("aria-haspopup", "dialog"), l.setAttribute("aria-expanded", "false"), e.addEventListener("pointerdown", p), e.addEventListener("pointermove", h), n.addEventListener("input", E), i.addEventListener("input", y), l.addEventListener("click", D), document.addEventListener("click", x), document.addEventListener("keydown", _), d(), {
    destroy() {
      e.removeEventListener("pointerdown", p), e.removeEventListener("pointermove", h), n.removeEventListener("input", E), i.removeEventListener("input", y), l.removeEventListener("click", D), document.removeEventListener("click", x), document.removeEventListener("keydown", _);
    }
  };
}
class hn extends B {
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
      this.getAttribute("label") ?? g("color.swatch", { color: t })
    ), this.hasAttribute("disabled") && r.setAttribute("aria-disabled", "true");
    const n = this.ownerDocument.createElement("div");
    n.className = "blora-color-panel", n.setAttribute("role", "dialog");
    const i = this.ownerDocument.createElement("div");
    i.className = "blora-color-spectrum", i.tabIndex = 0, i.setAttribute("role", "slider"), i.setAttribute("aria-label", g("color.spectrum"));
    const s = this.ownerDocument.createElement("span");
    s.className = "blora-color-spectrum__cursor", s.setAttribute("aria-hidden", "true"), i.appendChild(s);
    const o = this.ownerDocument.createElement("input");
    o.className = "blora-color-hue", o.type = "range", o.min = "0", o.max = "359", o.step = "1", o.setAttribute("aria-label", g("color.hue"));
    const c = this.ownerDocument.createElement("div");
    c.className = "blora-color-custom";
    const u = this.ownerDocument.createElement("span");
    u.className = "blora-color-preview", u.style.background = t;
    const b = this.ownerDocument.createElement("input");
    b.className = "blora-input blora-color-hex", b.type = "text", b.value = t, b.placeholder = "#RRGGBB", c.append(u, b), n.append(i, o, c), e.append(r, n), this.replaceChildren(e);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-color-picker");
    !t || this.hasAttribute("disabled") || (this.controller = bn(t), this.listen(t, "blora:change", (e) => {
      const r = e.detail.value;
      this.reflecting = !0, this.setAttribute("value", r), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function ei(a = customElements) {
  !a || a.get(te) || a.define(te, hn);
}
const ne = "blora-autocomplete";
function pn(a) {
  const l = a.ownerDocument, t = a.querySelector("input");
  if (!t) return { destroy: () => {
  } };
  const e = a.dataset.options ?? "[]";
  let r = [];
  try {
    r = JSON.parse(e);
  } catch {
    r = [];
  }
  let n = a.querySelector(".blora-autocomplete__menu");
  n || (n = l.createElement("div"), n.className = "blora-autocomplete__menu", a.appendChild(n));
  const i = n;
  let s = -1;
  const o = (p) => {
    const h = p ? r.filter((E) => E.toLowerCase().includes(p.toLowerCase())) : r;
    if (h.length === 0 || !p) {
      i.removeAttribute("data-open"), i.replaceChildren();
      return;
    }
    i.setAttribute("data-open", ""), i.replaceChildren(
      ...h.map((E, y) => {
        const v = l.createElement("div");
        return v.className = "blora-autocomplete__option", v.dataset.idx = String(y), v.setAttribute("role", "option"), v.textContent = E, v;
      })
    ), s = -1;
  }, c = (p) => {
    t.value = p, i.removeAttribute("data-open"), i.replaceChildren(), a.dispatchEvent(
      new CustomEvent("blora-autocomplete-change", {
        bubbles: !0,
        detail: { value: p }
      })
    );
  }, u = () => o(t.value), b = (p) => {
    if (!i.hasAttribute("data-open")) return;
    const h = Array.from(i.querySelectorAll(".blora-autocomplete__option"));
    if (p.key === "ArrowDown")
      p.preventDefault(), s = Math.min(s + 1, h.length - 1), h.forEach((E, y) => E.toggleAttribute("data-active", y === s));
    else if (p.key === "ArrowUp")
      p.preventDefault(), s = Math.max(s - 1, 0), h.forEach((E, y) => E.toggleAttribute("data-active", y === s));
    else if (p.key === "Enter") {
      p.preventDefault();
      const E = h[s];
      E && c(E.textContent ?? "");
    } else p.key === "Escape" && i.removeAttribute("data-open");
  }, d = (p) => {
    const h = p.target.closest(".blora-autocomplete__option");
    h && c(h.textContent ?? "");
  }, m = (p) => {
    a.contains(p.target) || i.removeAttribute("data-open");
  };
  return t.addEventListener("input", u), t.addEventListener("keydown", b), n.addEventListener("click", d), l.addEventListener("click", m), {
    destroy() {
      t.removeEventListener("input", u), t.removeEventListener("keydown", b), i.removeEventListener("click", d), l.removeEventListener("click", m);
    }
  };
}
class mn extends B {
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
    const n = this.getAttribute("label");
    if (n) {
      const c = this.ownerDocument.createElement("label");
      c.className = "blora-label", c.textContent = n, r.appendChild(c);
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
    !t || this.hasAttribute("disabled") || (this.controller = pn(t), this.listen(t, "blora-autocomplete-change", (e) => {
      const r = e.detail.value;
      this.reflecting = !0, this.setAttribute("value", r), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function ri(a = customElements) {
  !a || a.get(ne) || a.define(ne, mn);
}
const ae = "blora-mentions", fn = [
  { value: "alice", label: "alice" },
  { value: "bob", label: "bob" },
  { value: "carol", label: "carol" },
  { value: "dave", label: "dave" }
], Q = "data-blora-mentions-owner";
let gn = 0;
function Ue(a) {
  try {
    const l = JSON.parse(a);
    return Array.isArray(l) ? l.map((t) => {
      if (typeof t == "string")
        return { value: t, label: t };
      if (t && typeof t == "object") {
        const e = t, r = String(e.value ?? e.name ?? e.id ?? e.label ?? "").trim();
        if (!r) return null;
        const n = {
          value: r,
          label: String(e.label ?? e.name ?? r)
        };
        return e.initials != null && (n.initials = String(e.initials)), e.avatar != null && (n.avatar = String(e.avatar)), (e.avatarVariant === "primary" || e.avatarVariant === "neutral" || e.avatarVariant === "info" || e.avatarVariant === "success" || e.avatarVariant === "contrast") && (n.avatarVariant = e.avatarVariant), e.tag != null ? n.tag = String(e.tag) : e.description != null && (n.tag = String(e.description)), e.keywords != null && (n.keywords = String(e.keywords)), n;
      }
      return null;
    }).filter((t) => !!t) : [];
  } catch {
    return [];
  }
}
function vn(a) {
  return [a.value, a.label, a.tag, a.keywords, a.initials].filter(Boolean).join(" ");
}
function An(a) {
  if (a.initials) return a.initials.slice(0, 2);
  const l = (a.label || a.value).trim();
  return l ? /^[\w.-]+$/.test(l) ? l.slice(0, 2).toUpperCase() : l.slice(0, 2) : "?";
}
function yn(a, l) {
  a.querySelectorAll(`.blora-mentions__menu[${Q}]`).forEach((t) => {
    const e = t.getAttribute(Q);
    if (l && e === l) return;
    e && a.querySelector(`[data-blora-mentions-id="${CSS.escape(e)}"]`) || t.remove();
  });
}
function _n(a) {
  const l = a.querySelector("textarea, input");
  if (!l) return { destroy: () => {
  } };
  const t = a.ownerDocument, e = a.getAttribute("data-options") || a.dataset.options || l.getAttribute("data-options") || "[]";
  let r = Ue(e);
  r.length === 0 && (r = fn.map((f) => ({ ...f })));
  let n = a.getAttribute("data-blora-mentions-id");
  n || (n = `mn-${++gn}-${Date.now().toString(36)}`, a.setAttribute("data-blora-mentions-id", n)), a.setAttribute(Q, n);
  const i = a.__bloraMentionsDestroy;
  if (typeof i == "function")
    try {
      i();
    } catch {
    }
  t.querySelectorAll(`.blora-mentions__menu[${Q}="${n}"]`).forEach((f) => f.remove()), yn(t, n);
  let s = a.querySelector(".blora-mentions__menu") || t.querySelector(`.blora-mentions__menu[${Q}="${n}"]`);
  s || (s = t.createElement("ul"), s.className = "blora-mentions__menu", s.setAttribute("role", "listbox"));
  const o = s;
  o.setAttribute(Q, n), o.setAttribute("aria-hidden", "true"), o.style.position = "fixed", o.style.left = "-9999px", o.style.top = "-9999px", o.removeAttribute("data-open"), o.parentElement !== t.body && t.body.appendChild(o);
  let c = 0, u = -1, b = !1;
  const d = (f) => {
    b || (f ? (a.setAttribute("data-open", ""), o.setAttribute("aria-hidden", "false")) : (a.removeAttribute("data-open"), o.removeAttribute("data-open"), o.setAttribute("aria-hidden", "true"), o.removeAttribute("data-placement"), o.style.left = "-9999px", o.style.top = "-9999px", o.style.maxHeight = "", o.style.minWidth = "", o.style.visibility = ""));
  }, m = () => {
    const f = l.getBoundingClientRect(), k = getComputedStyle(l), S = Number.parseFloat(k.fontSize) || 14, N = (() => {
      const j = k.lineHeight;
      if (!j || j === "normal") return S * 1.4;
      const J = Number.parseFloat(j);
      return Number.isFinite(J) ? J : S * 1.4;
    })(), q = Number.parseFloat(k.paddingLeft) || 0, M = Number.parseFloat(k.paddingTop) || 0, P = Number.parseFloat(k.borderLeftWidth) || 0, O = Number.parseFloat(k.borderTopWidth) || 0;
    if (u < 0)
      return {
        x: f.left + q + P,
        y: f.top + M + O,
        lineH: N
      };
    const R = t.createElement("div");
    R.setAttribute("aria-hidden", "true");
    const G = R.style;
    G.position = "fixed", G.left = `${f.left}px`, G.top = `${f.top}px`, G.visibility = "hidden", G.pointerEvents = "none", G.zIndex = "-1", G.whiteSpace = "pre-wrap", G.wordWrap = "break-word", G.overflowWrap = "break-word", G.overflow = "hidden", G.boxSizing = "border-box", G.width = `${l.clientWidth}px`, G.height = `${l.clientHeight}px`, G.font = k.font, G.fontSize = k.fontSize, G.fontFamily = k.fontFamily, G.fontWeight = k.fontWeight, G.letterSpacing = k.letterSpacing, G.lineHeight = k.lineHeight, G.padding = k.padding, G.borderStyle = k.borderStyle, G.borderWidth = k.borderWidth, G.borderColor = "transparent", G.textAlign = k.textAlign, G.direction = k.direction;
    const U = l.value.slice(0, Math.max(0, u)), W = t.createTextNode(U), $ = t.createElement("span");
    $.textContent = "​", R.appendChild(W), R.appendChild($), t.body.appendChild(R), R.scrollTop = l.scrollTop, R.scrollLeft = l.scrollLeft;
    const H = $.getBoundingClientRect();
    t.body.removeChild(R);
    let V = H.left, K = H.top;
    return (!Number.isFinite(V) || V < f.left - 2 || V > f.right + 2) && (V = f.left + q + P), (!Number.isFinite(K) || K < f.top - 2 || K > f.bottom + 2) && (K = f.top + M + O), { x: V, y: K, lineH: N };
  }, p = () => {
    if (b || !t.contains(a)) {
      d(!1);
      return;
    }
    const f = 6, k = 8, { x: S, y: N, lineH: q } = m();
    o.style.position = "fixed", o.style.right = "auto", o.style.bottom = "auto", o.style.margin = "0", o.style.zIndex = "var(--blora-z-dropdown)", o.style.visibility = "hidden", o.setAttribute("data-open", "");
    const M = Math.min(Math.max(o.offsetWidth || 160, 160), window.innerWidth - k * 2), P = o.offsetHeight || 120, O = Math.min(P, window.innerHeight * 0.4, 240), R = window.innerHeight - (N + q) - k, G = N - k, U = Math.min(O, 100), W = R >= U || R >= G;
    let $ = W ? N + q + f : N - f - O;
    $ < k && ($ = k), $ + O > window.innerHeight - k && ($ = Math.max(k, window.innerHeight - k - O));
    let H = S;
    H + M > window.innerWidth - k && (H = window.innerWidth - k - M), H < k && (H = k), o.dataset.placement = W ? "below" : "above", o.style.left = `${Math.round(H)}px`, o.style.top = `${Math.round($)}px`;
    const V = o.classList.contains("blora-mentions__menu--rich");
    o.style.minWidth = V ? "16rem" : "10rem", o.style.width = "max-content", o.style.maxWidth = V ? `${Math.min(384, window.innerWidth - k * 2)}px` : `${Math.min(320, window.innerWidth - k * 2)}px`, o.style.maxHeight = `${Math.round(
      Math.max(80, W ? Math.min(O, R) : Math.min(O, G))
    )}px`, o.style.visibility = "visible";
  }, h = (f, k) => {
    const S = t.createElement("li");
    S.className = "blora-mentions__option", k && S.setAttribute("data-active", ""), S.setAttribute("role", "option"), S.dataset.name = f.value;
    const N = t.createElement("span");
    if (N.className = "blora-avatar", N.setAttribute("data-size", "sm"), N.setAttribute("data-variant", f.avatarVariant || "info"), N.setAttribute("aria-hidden", "true"), f.avatar) {
      const P = t.createElement("img");
      P.src = f.avatar, P.alt = "", N.appendChild(P);
    } else
      N.textContent = An(f);
    const q = t.createElement("span");
    q.className = "blora-mentions__meta";
    const M = t.createElement("span");
    if (M.className = "blora-mentions__name", M.textContent = f.label || f.value, q.appendChild(M), S.append(N, q), f.tag) {
      const P = t.createElement("span");
      P.className = "blora-tag blora-mentions__tag", P.setAttribute("data-variant", "neutral"), P.textContent = f.tag, S.append(P);
    }
    return S;
  }, E = (f) => {
    if (b) return;
    const k = f.toLowerCase(), S = r.filter((q) => !k || vn(q).toLowerCase().includes(k)).slice(0, 8);
    if (S.length === 0) {
      d(!1), o.replaceChildren();
      return;
    }
    c = Math.min(c, S.length - 1);
    const N = S.some((q) => q.avatar || q.initials || q.tag || q.label !== q.value);
    o.classList.toggle("blora-mentions__menu--rich", N), o.replaceChildren(...S.map((q, M) => h(q, M === c))), d(!0), requestAnimationFrame(() => {
      p(), requestAnimationFrame(() => p());
    });
  }, y = (f) => {
    const k = l.selectionStart ?? l.value.length, S = l.value.substring(0, u), N = l.value.substring(k);
    l.value = `${S}@${f} ${N}`;
    const q = S.length + f.length + 2;
    l.setSelectionRange(q, q), l.focus(), d(!1), l.dispatchEvent(new Event("input", { bubbles: !0 }));
  }, v = () => {
    if (b || !t.contains(a)) {
      d(!1);
      return;
    }
    const f = l.selectionStart ?? 0, S = l.value.substring(0, f).match(/@([\w\u4e00-\u9fa5.-]*)$/);
    if (!S) {
      u = -1, d(!1);
      return;
    }
    u = f - S[0].length;
    const N = S[1] || "";
    c = 0, E(N);
  }, w = () => v(), D = (f) => {
    var N;
    const k = f;
    if (!a.hasAttribute("data-open")) return;
    const S = o.querySelectorAll(".blora-mentions__option");
    if (S.length)
      if (k.key === "ArrowDown")
        k.preventDefault(), c = (c + 1) % S.length, S.forEach((q, M) => q.toggleAttribute("data-active", M === c));
      else if (k.key === "ArrowUp")
        k.preventDefault(), c = (c - 1 + S.length) % S.length, S.forEach((q, M) => q.toggleAttribute("data-active", M === c));
      else if (k.key === "Enter" || k.key === "Tab") {
        k.preventDefault();
        const q = (N = S[c]) == null ? void 0 : N.dataset.name;
        q && y(q);
      } else k.key === "Escape" && (k.preventDefault(), d(!1));
  }, x = (f) => {
    const k = f.target.closest(".blora-mentions__option");
    k != null && k.dataset.name && y(k.dataset.name);
  }, _ = () => {
    a.hasAttribute("data-open") && p();
  }, C = (f) => {
    const k = f;
    (k.key === "ArrowLeft" || k.key === "ArrowRight" || k.key === "Home" || k.key === "End") && v();
  }, L = () => {
    b || (b = !0, l.removeEventListener("input", w), l.removeEventListener("keydown", D), l.removeEventListener("click", v), l.removeEventListener("keyup", C), o.removeEventListener("click", x), window.removeEventListener("scroll", _, !0), window.removeEventListener("resize", _), a.removeAttribute("data-open"), o.remove(), a.__bloraMentionsDestroy === L && delete a.__bloraMentionsDestroy, T.disconnect());
  }, T = new MutationObserver(() => {
    t.contains(a) || L();
  });
  return T.observe(t.body, { childList: !0, subtree: !0 }), l.addEventListener("input", w), l.addEventListener("keydown", D), l.addEventListener("click", v), l.addEventListener("keyup", C), o.addEventListener("click", x), window.addEventListener("scroll", _, !0), window.addEventListener("resize", _), a.__bloraMentionsDestroy = L, { destroy: L };
}
class En extends B {
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
      var h, E;
      const o = s.getAttribute("value") ?? ((h = s.textContent) == null ? void 0 : h.trim()) ?? "", c = {
        value: o,
        label: s.getAttribute("label") ?? ((E = s.textContent) == null ? void 0 : E.trim()) ?? o
      }, u = s.getAttribute("initials"), b = s.getAttribute("avatar"), d = s.getAttribute(
        "avatar-variant"
      ), m = s.getAttribute("tag"), p = s.getAttribute("keywords");
      return u !== null && (c.initials = u), b !== null && (c.avatar = b), d && (c.avatarVariant = d), m !== null && (c.tag = m), p !== null && (c.keywords = p), c;
    }).filter((s) => s.value));
    const t = this.getAttribute("options") ?? this.getAttribute("data-options");
    let e = this.options;
    if (t) {
      const s = Ue(t);
      e = s.length ? s : [];
    }
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-mentions", r.dataset.bloraGenerated = "", r.dataset.options = JSON.stringify(e);
    const n = this.getAttribute("label");
    if (n) {
      const s = this.ownerDocument.createElement("label");
      s.className = "blora-label", s.textContent = n, r.appendChild(s);
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
    !t || !e || this.hasAttribute("disabled") || (this.controller = _n(t), this.listen(e, "input", () => {
      this.reflecting = !0, this.setAttribute("value", e.value), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function ni(a = customElements) {
  !a || a.get(ae) || a.define(ae, En);
}
const ie = "blora-cascader";
function Cn(a) {
  const l = a.ownerDocument, t = a.dataset.options ?? a.dataset.bloraCascader ?? "[]";
  let e = [];
  try {
    e = JSON.parse(t);
  } catch {
    e = [];
  }
  let r = a.querySelector(".blora-cascader__trigger"), n = a.querySelector(".blora-cascader__panel");
  const i = a.querySelector(".blora-cascader__result");
  r || (r = l.createElement("button"), r.className = "blora-cascader__trigger blora-input", r.type = "button", r.textContent = g("cascader.placeholder"), a.prepend(r)), n || (n = l.createElement("div"), n.className = "blora-cascader__panel", a.appendChild(n));
  const s = [], o = (E) => {
    n.replaceChildren(
      ...E.map((y, v) => {
        const w = l.createElement("div");
        return w.className = "blora-cascader__column", y.forEach((D) => {
          const x = s[v] === D.label, _ = D.children && D.children.length > 0, C = l.createElement("div");
          if (C.className = "blora-cascader__option", x && C.classList.add("blora-cascader__option--active"), C.dataset.col = String(v), C.dataset.label = D.label, C.textContent = D.label, _) {
            const L = l.createElement("span");
            L.className = "blora-cascader__arrow", L.appendChild(I("chevron-right", 14, l)), C.appendChild(L);
          }
          w.appendChild(C);
        }), w;
      })
    );
  }, c = () => {
    r.textContent = s.length ? s.join(" / ") : g("cascader.placeholder"), i && (i.textContent = `${g("cascader.selectedPrefix")}${s.join(" / ")}`);
  }, u = () => {
    n.setAttribute("data-open", ""), s.length = 0, o([e]), c();
  }, b = () => {
    n.removeAttribute("data-open");
  }, d = () => n.hasAttribute("data-open"), m = (E) => {
    E.stopPropagation(), d() ? b() : u();
  }, p = (E) => {
    E.stopPropagation();
    const y = E.target.closest(".blora-cascader__option");
    if (!y) return;
    const v = Number(y.dataset.col), w = y.dataset.label;
    s[v] = w, s.length = v + 1;
    let D = e;
    for (let x = 0; x <= v; x++) {
      const _ = D.find((C) => C.label === s[x]);
      if (!_) return;
      if (x === v) {
        if (_.children && _.children.length > 0) {
          const C = [];
          let L = e;
          for (let T = 0; T <= v; T++) {
            const f = L.find((k) => k.label === s[T]);
            if (!f) break;
            C.push(L), L = f.children ?? [];
          }
          C.push(_.children), o(C);
        } else
          c(), b(), a.dispatchEvent(
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
  return r.addEventListener("click", m), n.addEventListener("click", p), l.addEventListener("click", h), {
    destroy() {
      r.removeEventListener("click", m), n.removeEventListener("click", p), l.removeEventListener("click", h);
    }
  };
}
function Ke(a) {
  return a.filter((l) => l.localName === "blora-cascader-option").map((l) => {
    var t;
    return {
      label: l.getAttribute("label") ?? ((t = l.textContent) == null ? void 0 : t.trim()) ?? "",
      children: Ke(Array.from(l.children))
    };
  }).filter((l) => l.label).map((l) => {
    var t;
    return (t = l.children) != null && t.length ? l : { label: l.label };
  });
}
class wn extends B {
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
    this.options || (this.options = Ke(Array.from(this.children)));
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
    const n = this.ownerDocument.createElement("button");
    n.className = "blora-cascader__trigger blora-input", n.type = "button", n.disabled = this.hasAttribute("disabled"), n.textContent = this.getAttribute("value") || this.getAttribute("placeholder") || g("cascader.placeholder");
    const i = this.ownerDocument.createElement("div");
    if (i.className = "blora-cascader__panel", i.setAttribute("role", "listbox"), r.append(n, i), this.hasAttribute("show-result")) {
      const s = this.ownerDocument.createElement("output");
      s.className = "blora-cascader__result", this.value && (s.textContent = `${g("cascader.selectedPrefix")}${this.value}`), r.appendChild(s);
    }
    this.replaceChildren(r);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-cascader");
    !t || this.hasAttribute("disabled") || (this.controller = Cn(t), this.listen(t, "blora-cascader-change", (e) => {
      const r = e.detail.value;
      this.reflecting = !0, this.setAttribute("value", r), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function ai(a = customElements) {
  !a || a.get(ie) || a.define(ie, wn);
}
const se = "blora-tree";
function xn(a) {
  if (typeof document > "u") return { destroy: () => {
  } };
  a.setAttribute("role", "tree");
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
    for (; o && o !== a; ) {
      if (o.classList.contains("blora-tree__children")) {
        const c = o.previousElementSibling;
        if (c instanceof HTMLElement && c.hasAttribute("data-open")) {
          const u = l(o);
          o.style.setProperty("--blora-tree-h", `${u}px`), o.style.maxHeight !== "none" && o.style.maxHeight !== "" && (o.style.maxHeight = `${u}px`);
        }
      }
      o = o.parentElement;
    }
  }, n = (s) => {
    var b, d;
    const o = s.target.closest(".blora-tree__node");
    if (!o || !a.contains(o)) return;
    const c = o.nextElementSibling, u = c instanceof HTMLElement && c.classList.contains("blora-tree__children") ? c : null;
    u && (!o.hasAttribute("data-open") ? t(o, u) : e(o, u), requestAnimationFrame(() => r(u))), a.querySelectorAll(".blora-tree__node[data-selected]").forEach((m) => {
      m !== o && (m.removeAttribute("data-selected"), m.setAttribute("aria-selected", "false"));
    }), o.hasAttribute("data-selected") ? (o.removeAttribute("data-selected"), o.setAttribute("aria-selected", "false")) : (o.setAttribute("data-selected", ""), o.setAttribute("aria-selected", "true")), a.dispatchEvent(
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
    !o || !a.contains(o) || (s.preventDefault(), o.click());
  };
  return a.querySelectorAll(".blora-tree__node").forEach((s) => {
    s.setAttribute("role", "treeitem"), s.hasAttribute("tabindex") || (s.tabIndex = 0);
    const o = s.nextElementSibling;
    if (o != null && o.classList.contains("blora-tree__children")) {
      const c = s.hasAttribute("data-open");
      if (s.setAttribute("aria-expanded", String(c)), c) {
        const u = o;
        u.style.maxHeight = "none", u.style.setProperty("--blora-tree-h", `${l(u)}px`);
      }
    }
  }), a.addEventListener("click", n), a.addEventListener("keydown", i), {
    destroy() {
      a.removeEventListener("click", n), a.removeEventListener("keydown", i);
    }
  };
}
function kn(a) {
  return Array.from(a.childNodes).filter((l) => l.nodeType === Node.TEXT_NODE).map((l) => l.textContent ?? "").join("").trim();
}
function Xe(a) {
  return a.filter((l) => l.localName === "blora-tree-node").map((l) => {
    const t = l.getAttribute("label") ?? kn(l);
    return {
      children: Xe(Array.from(l.children)),
      label: t,
      open: l.hasAttribute("open"),
      selected: l.hasAttribute("selected"),
      value: l.getAttribute("value") ?? t
    };
  }).filter((l) => l.label);
}
function Sn(a, l) {
  l.appendChild(I("chevron-right", 12, a));
}
class Nn extends B {
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
    this.definitions || (this.definitions = Xe(Array.from(this.children)));
    const t = this.getAttribute("value"), e = this.ownerDocument.createElement("div");
    e.className = "blora-tree", e.dataset.bloraGenerated = "";
    const r = (n, i) => {
      i.forEach((s) => {
        const o = this.ownerDocument.createElement("div");
        o.className = "blora-tree__node", o.dataset.value = s.value, o.dataset.label = s.label, s.open && (o.dataset.open = ""), (s.selected || t === s.value) && (o.dataset.selected = "");
        const c = this.ownerDocument.createElement("span");
        c.className = "blora-tree__toggle", s.children.length ? Sn(this.ownerDocument, c) : c.setAttribute("aria-hidden", "true");
        const u = this.ownerDocument.createElement("span");
        if (u.textContent = s.label, o.append(c, u), n.appendChild(o), s.children.length) {
          const b = this.ownerDocument.createElement("div");
          b.className = "blora-tree__children", r(b, s.children), n.appendChild(b);
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
    t && (this.controller = xn(t), this.listen(t, "blora-tree-change", (e) => {
      const r = e.detail;
      this.reflecting = !0, r.selected ? this.setAttribute("value", r.value) : this.removeAttribute("value"), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function ii(a = customElements) {
  !a || a.get(se) || a.define(se, Nn);
}
const oe = "blora-tree-select";
function je(a) {
  try {
    const l = JSON.parse(a || "[]");
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}
function Dn(a) {
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
  a.classList.add("blora-treeselect");
  const l = a.ownerDocument, t = a.querySelector(
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
  let e = a.querySelector(".blora-treeselect__panel");
  e || (e = l.createElement("div"), e.className = "blora-treeselect__panel", e.setAttribute("role", "listbox"), a.appendChild(e));
  const r = e, n = je(a.getAttribute("data-options") || a.dataset.options || "[]");
  t.readOnly = !0, t.setAttribute("role", "combobox"), t.setAttribute("aria-expanded", "false"), t.setAttribute("aria-haspopup", "listbox");
  let i = a.getAttribute("data-value") || "", s = t.value || "";
  const o = (h) => {
    a.toggleAttribute("data-open", h), t.setAttribute("aria-expanded", String(h));
  }, c = (h) => {
    h.disabled || (i = String(h.value ?? h.label ?? ""), s = String(h.label ?? h.value ?? ""), t.value = s, a.setAttribute("data-value", i), o(!1), a.dispatchEvent(
      new CustomEvent("blora-treeselect-change", {
        bubbles: !0,
        detail: { value: i, label: s, item: h }
      })
    ));
  }, u = (h, E) => {
    const y = l.createElement("div");
    y.className = "blora-treeselect__node", y.dataset.depth = String(E), y.toggleAttribute("data-disabled", !!h.disabled);
    const v = !!(h.children && h.children.length), w = l.createElement("span");
    w.className = "blora-treeselect__toggle", w.setAttribute("aria-hidden", "true"), v ? w.appendChild(I("chevron-right", 12, l)) : w.style.visibility = "hidden", y.appendChild(w);
    const D = l.createElement("span");
    D.textContent = h.label || h.value || "", y.appendChild(D);
    const x = l.createElement("div");
    x.className = "blora-treeselect__children", v && h.children.forEach((C) => x.appendChild(u(C, E + 1)));
    const _ = l.createElement("div");
    return _.appendChild(y), v && _.appendChild(x), y.addEventListener("click", (C) => {
      if (C.stopPropagation(), h.disabled) return;
      const L = C.target.closest(".blora-treeselect__toggle");
      if (v && (L || h.selectable === !1)) {
        const T = !x.hasAttribute("data-open");
        x.toggleAttribute("data-open", T), w.toggleAttribute("data-open", T);
        return;
      }
      if (v && h.selectable !== !0) {
        const T = !x.hasAttribute("data-open");
        x.toggleAttribute("data-open", T), w.toggleAttribute("data-open", T);
        return;
      }
      c(h);
    }), _;
  };
  (() => {
    r.replaceChildren(...n.map((h) => u(h, 0)));
  })();
  const d = (h) => {
    h.stopPropagation(), o(!a.hasAttribute("data-open"));
  }, m = (h) => {
    a.contains(h.target) || o(!1);
  }, p = (h) => {
    h.key === "Escape" && o(!1), h.key === "ArrowDown" && !a.hasAttribute("data-open") && (h.preventDefault(), o(!0));
  };
  return t.addEventListener("click", d), t.addEventListener("keydown", p), l.addEventListener("click", m), {
    open: () => o(!0),
    close: () => o(!1),
    getValue: () => i,
    setValue(h, E) {
      i = h, s = E ?? h, t.value = s, a.setAttribute("data-value", i);
    },
    destroy() {
      t.removeEventListener("click", d), t.removeEventListener("keydown", p), l.removeEventListener("click", m), o(!1);
    }
  };
}
function Ln(a) {
  return Array.from(a.childNodes).filter((l) => l.nodeType === Node.TEXT_NODE).map((l) => l.textContent ?? "").join("").trim();
}
function Qe(a) {
  return a.filter((l) => l.localName === "blora-tree-select-option").map((l) => {
    const t = l.getAttribute("label") ?? Ln(l), e = l.getAttribute("selectable"), r = {
      label: t,
      value: l.getAttribute("value") ?? t,
      disabled: l.hasAttribute("disabled")
    };
    e !== null && (r.selectable = e !== "false");
    const n = Qe(Array.from(l.children));
    return n.length && (r.children = n), r;
  }).filter((l) => l.label);
}
class qn extends B {
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
    this.options || (this.options = Qe(Array.from(this.children)));
    const t = this.getAttribute("options") ?? this.getAttribute("data-options");
    let e = this.options;
    t && (e = je(t));
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-treeselect", r.dataset.bloraGenerated = "", r.dataset.options = JSON.stringify(e);
    const n = this.getAttribute("value") ?? "";
    n && (r.dataset.value = n);
    const i = this.getAttribute("label");
    if (i) {
      const c = this.ownerDocument.createElement("label");
      c.className = "blora-label", c.textContent = i, r.appendChild(c);
    }
    const s = this.ownerDocument.createElement("input");
    s.className = "blora-input blora-treeselect__input", s.type = "text", s.placeholder = this.getAttribute("placeholder") ?? "", s.value = n, s.disabled = this.hasAttribute("disabled");
    const o = this.ownerDocument.createElement("div");
    o.className = "blora-treeselect__panel", o.setAttribute("role", "listbox"), r.append(s, o), this.replaceChildren(r);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-treeselect");
    !t || this.hasAttribute("disabled") || (this.controller = Dn(t), this.listen(t, "blora-treeselect-change", (e) => {
      const r = e.detail.value;
      this.reflecting = !0, this.setAttribute("value", r), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function si(a = customElements) {
  !a || a.get(oe) || a.define(oe, qn);
}
const le = "blora-calendar", ce = () => Te(), Tn = () => Me(), ue = (a, l) => {
  a.replaceChildren(
    I(l === "prev" ? "chevron-left" : "chevron-right", 14, a.ownerDocument)
  );
};
function Mn(a) {
  const l = a.ownerDocument, t = /* @__PURE__ */ new Date(), e = a.getAttribute("data-value"), r = e ? /* @__PURE__ */ new Date(`${e}T00:00:00`) : null, n = r && !Number.isNaN(r.getTime()) ? r : null;
  let i = (n == null ? void 0 : n.getFullYear()) ?? t.getFullYear(), s = (n == null ? void 0 : n.getMonth()) ?? t.getMonth(), o = "days", c = n ?? new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const u = (p, h, E) => {
    const y = l.createElement(p);
    return h && (y.className = h), E != null && (y.textContent = E), y;
  }, b = () => {
    a.replaceChildren();
    const p = u("div", "blora-calendar__head"), h = u("div", "blora-calendar__navs"), E = u("button", "blora-calendar__nav");
    E.setAttribute("type", "button"), E.setAttribute("data-nav", "prev"), E.setAttribute("aria-label", g("calendar.prev")), ue(E, "prev");
    const y = u("button", "blora-calendar__nav");
    y.setAttribute("type", "button"), y.setAttribute("data-nav", "next"), y.setAttribute("aria-label", g("calendar.next")), ue(y, "next"), h.append(E, y);
    let v = "", w = null;
    if (o === "days")
      v = g("calendar.monthYear", {
        year: i,
        month: ce()[s] ?? ""
      }), w = "months";
    else if (o === "months")
      v = g("calendar.year", { year: i }), w = "years";
    else {
      const _ = Math.floor(i / 10) * 10;
      v = g("calendar.decade", { start: _, end: _ + 9 });
    }
    const D = u("div", "blora-calendar__title", v);
    w && D.setAttribute("data-zoom", w);
    const x = u("button", "blora-button blora-calendar__today");
    if (x.setAttribute("type", "button"), x.setAttribute("data-variant", "outline"), x.setAttribute("data-size", "sm"), x.setAttribute("data-today", ""), x.textContent = g("common.today"), p.append(h, D, x), a.appendChild(p), o === "days") {
      const _ = u("div", "blora-calendar__grid");
      Tn().forEach((N) => _.appendChild(u("div", "blora-calendar__dow", N)));
      const L = new Date(i, s, 1).getDay(), T = new Date(i, s + 1, 0).getDate(), f = new Date(i, s, 0).getDate();
      for (let N = L - 1; N >= 0; N--) {
        const q = u("div", "blora-calendar__cell", String(f - N));
        q.setAttribute("data-other", ""), _.appendChild(q);
      }
      for (let N = 1; N <= T; N++) {
        const q = new Date(i, s, N), M = u("div", "blora-calendar__cell", String(N));
        M.setAttribute("data-day", String(N)), q.toDateString() === t.toDateString() && M.setAttribute("data-today", ""), c && q.toDateString() === c.toDateString() && M.setAttribute("data-selected", ""), _.appendChild(M);
      }
      const S = (7 - (L + T) % 7) % 7;
      for (let N = 1; N <= S; N++) {
        const q = u("div", "blora-calendar__cell", String(N));
        q.setAttribute("data-other", ""), _.appendChild(q);
      }
      a.appendChild(_);
    } else if (o === "months") {
      const _ = u("div", "blora-calendar__grid blora-calendar__grid--months");
      ce().forEach((C, L) => {
        const T = u("div", "blora-calendar__cell blora-calendar__cell--month", C);
        T.setAttribute("data-month", String(L)), c && i === c.getFullYear() && L === c.getMonth() && T.setAttribute("data-selected", ""), i === t.getFullYear() && L === t.getMonth() && T.setAttribute("data-today", ""), _.appendChild(T);
      }), a.appendChild(_);
    } else {
      const _ = Math.floor(i / 10) * 10, C = u("div", "blora-calendar__grid blora-calendar__grid--years");
      for (let L = _ - 1; L <= _ + 10; L++) {
        const T = u("div", "blora-calendar__cell blora-calendar__cell--year", String(L));
        T.setAttribute("data-year", String(L)), (L < _ || L > _ + 9) && T.setAttribute("data-other", ""), c && L === c.getFullYear() && T.setAttribute("data-selected", ""), L === t.getFullYear() && T.setAttribute("data-today", ""), C.appendChild(T);
      }
      a.appendChild(C);
    }
  }, d = (p) => {
    const h = p.target, E = h.closest("[data-nav]");
    if (E) {
      const x = E.dataset.nav === "prev" ? -1 : 1;
      o === "days" ? (s += x, s < 0 ? (s = 11, i--) : s > 11 && (s = 0, i++)) : o === "months" ? i += x : i += x * 10, b();
      return;
    }
    const y = h.closest("[data-zoom]");
    if (y) {
      y.dataset.zoom === "months" ? o = "months" : y.dataset.zoom === "years" && (o = "years"), b();
      return;
    }
    if (h.closest("button[data-today], .blora-calendar__head [data-today]")) {
      c = /* @__PURE__ */ new Date(), i = c.getFullYear(), s = c.getMonth(), o = "days", b(), m();
      return;
    }
    const v = h.closest(".blora-calendar__cell[data-day]");
    if (v) {
      c = new Date(i, s, Number(v.dataset.day)), b(), m();
      return;
    }
    const w = h.closest(".blora-calendar__cell--month[data-month]");
    if (w) {
      s = Number(w.dataset.month), o = "days", b();
      return;
    }
    const D = h.closest(".blora-calendar__cell--year[data-year]");
    D && (i = Number(D.dataset.year), o = "months", b());
  }, m = () => {
    if (!c) return;
    const p = `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}-${String(c.getDate()).padStart(2, "0")}`;
    a.dispatchEvent(
      new CustomEvent("blora-calendar-change", {
        bubbles: !0,
        detail: { value: p, date: new Date(c) }
      })
    );
  };
  return a.addEventListener("click", d), b(), {
    destroy() {
      a.removeEventListener("click", d);
    }
  };
}
class Bn extends B {
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
    t && (this.controller = Mn(t), this.listen(t, "blora-calendar-change", (e) => {
      const r = e.detail.value;
      this.reflecting = !0, this.setAttribute("value", r), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function oi(a = customElements) {
  !a || a.get(le) || a.define(le, Bn);
}
const de = "blora-carousel";
function In(a) {
  const l = a.querySelector(".blora-carousel__track"), t = Array.from(a.querySelectorAll(".blora-carousel__slide")), e = Array.from(a.querySelectorAll(".blora-carousel__dot")), r = a.querySelector(".blora-carousel__arrow--prev"), n = a.querySelector(".blora-carousel__arrow--next");
  if (!l || t.length === 0)
    return { destroy: () => {
    }, next: () => {
    }, prev: () => {
    }, goTo: () => {
    } };
  let i = 0, s = null;
  const o = a.hasAttribute("data-autoplay"), c = t.length - 1, u = 0.2, b = 0.35;
  let d = null;
  const m = (S) => {
    l.classList.toggle("is-dragging", !1), l.toggleAttribute("data-dragging", !1), l.style.transform = `translate3d(${-i * 100}%, 0, 0)`, e.forEach((N, q) => {
      q === i ? N.setAttribute("data-active", "") : N.removeAttribute("data-active");
    });
  }, p = (S) => {
    i = (S % t.length + t.length) % t.length, m(), a.dispatchEvent(
      new CustomEvent("blora-carousel-change", { bubbles: !0, detail: { index: i } })
    );
  }, h = () => p(i + 1), E = () => p(i - 1), y = () => {
    o && (v(), s = setInterval(h, 3500));
  }, v = () => {
    s && (clearInterval(s), s = null);
  }, w = () => a.getBoundingClientRect().width || 1, D = (S) => i === 0 && S > 0 || i === c && S < 0 ? S * 0.35 : S, x = (S) => {
    const N = D(S);
    l.classList.add("is-dragging"), l.setAttribute("data-dragging", ""), l.style.transform = `translate3d(calc(${-i * 100}% + ${N}px), 0, 0)`;
  }, _ = (S) => {
    var q;
    if (S.pointerType === "mouse" && S.button !== 0) return;
    const N = S.target;
    if (!((q = N.closest) != null && q.call(
      N,
      ".blora-carousel__arrow, .blora-carousel__dot, a, button, input, textarea, select, label"
    ))) {
      d = {
        x: S.clientX,
        y: S.clientY,
        dx: 0,
        locked: null,
        lx: S.clientX,
        lt: Date.now(),
        vx: 0,
        pointerId: S.pointerId
      };
      try {
        a.setPointerCapture(S.pointerId);
      } catch {
      }
      v();
    }
  }, C = (S) => {
    if (!d || S.pointerId !== d.pointerId) return;
    const N = S.clientX - d.x, q = S.clientY - d.y;
    if (d.locked == null && (Math.abs(N) > 6 || Math.abs(q) > 6) && (d.locked = Math.abs(N) > Math.abs(q) ? "x" : "y", d.locked === "y")) {
      d = null, o && y();
      return;
    }
    if (d.locked !== "x") return;
    S.cancelable && S.preventDefault();
    const M = Date.now(), P = Math.max(1, M - d.lt);
    d.vx = (S.clientX - d.lx) / P, d.lx = S.clientX, d.lt = M, d.dx = N, x(N);
  }, L = (S) => {
    if (!d) return;
    const N = d.dx, q = d.vx, M = d.locked === "x";
    if (d = null, l.classList.remove("is-dragging"), l.removeAttribute("data-dragging"), !M || S)
      m();
    else {
      const P = w();
      let O = i;
      N <= -P * u || q <= -b ? O = i + 1 : (N >= P * u || q >= b) && (O = i - 1), i = Math.max(0, Math.min(c, O)), m();
    }
    o && y();
  }, T = (S) => {
    if (!(!d || S.pointerId !== d.pointerId)) {
      if (d.locked === "x") {
        d.dx = S.clientX - d.x;
        const N = Date.now(), q = Math.max(1, N - d.lt);
        d.vx = (S.clientX - d.lx) / q;
      }
      L(!1);
    }
  }, f = () => L(!0);
  r == null || r.addEventListener("click", E), n == null || n.addEventListener("click", h);
  const k = e.map((S, N) => {
    const q = () => p(N);
    return S.addEventListener("click", q), { dot: S, fn: q };
  });
  return a.addEventListener("pointerdown", _), a.addEventListener("pointermove", C), a.addEventListener("pointerup", T), a.addEventListener("pointercancel", f), a.style.touchAction = "pan-y", o && (a.addEventListener("mouseenter", v), a.addEventListener("mouseleave", y), y()), p(0), {
    destroy() {
      v(), r == null || r.removeEventListener("click", E), n == null || n.removeEventListener("click", h), k.forEach(({ dot: S, fn: N }) => S.removeEventListener("click", N)), a.removeEventListener("pointerdown", _), a.removeEventListener("pointermove", C), a.removeEventListener("pointerup", T), a.removeEventListener("pointercancel", f), a.removeEventListener("mouseenter", v), a.removeEventListener("mouseleave", y);
    },
    next: h,
    prev: E,
    goTo: p
  };
}
function be(a, l) {
  const t = a.createElement("button");
  return t.className = `blora-carousel__arrow blora-carousel__arrow--${l}`, t.type = "button", t.setAttribute("aria-label", l === "prev" ? g("carousel.prev") : g("carousel.next")), t.appendChild(
    I(l === "prev" ? "chevron-left" : "chevron-right", 18, a)
  ), t;
}
class On extends B {
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
    this.definitions || (this.definitions = Array.from(this.children).filter((n) => n.localName === "blora-carousel-slide").map((n) => ({
      label: n.getAttribute("label") ?? "",
      nodes: Array.from(n.childNodes).map((i) => i.cloneNode(!0))
    })));
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-carousel", t.dataset.bloraGenerated = "", t.setAttribute("role", "region"), t.setAttribute("aria-label", this.getAttribute("label") ?? g("carousel.label")), this.hasAttribute("autoplay") && (t.dataset.autoplay = "");
    const e = this.ownerDocument.createElement("div");
    e.className = "blora-carousel__track", this.definitions.forEach((n, i) => {
      const s = this.ownerDocument.createElement("div");
      s.className = "blora-carousel__slide", s.setAttribute("role", "group"), s.setAttribute(
        "aria-label",
        n.label || `${i + 1} / ${this.definitions.length}`
      ), s.append(...n.nodes.map((o) => o.cloneNode(!0))), e.appendChild(s);
    });
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-carousel__dots", this.definitions.forEach((n, i) => {
      const s = this.ownerDocument.createElement("button");
      s.className = "blora-carousel__dot", s.type = "button", s.setAttribute("aria-label", g("carousel.goto", { n: i + 1 })), r.appendChild(s);
    }), t.append(
      e,
      be(this.ownerDocument, "prev"),
      be(this.ownerDocument, "next"),
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
    this.controller = In(t);
    const e = Number(this.getAttribute("current") ?? 0);
    e && this.controller.goTo(e), this.listen(t, "blora-carousel-change", (r) => {
      const n = r.detail.index;
      this.reflecting = !0, this.setAttribute("current", String(n)), this.reflecting = !1;
    });
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function li(a = customElements) {
  !a || a.get(de) || a.define(de, On);
}
const he = "blora-deck";
function Pn(a) {
  const l = () => Array.from(a.children).filter((x) => x.nodeType === 1);
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
  a.hasAttribute("tabindex") || (a.tabIndex = 0);
  const t = 0.72, e = 96, r = 2.35, n = (x, _, C) => Math.min(C, Math.max(_, x)), i = (x, _, C) => {
    let L = x - _;
    return L -= C * Math.round(L / C), L;
  }, s = (x) => {
    const _ = Math.abs(x);
    if (_ > r)
      return { y: x > 0 ? -t * r : t * r, scale: 0.88, opacity: 0, z: 0 };
    const C = -x * t, L = 1 - n(_, 0, 3) * 0.04, T = _ <= 0.15 ? 1 : Math.max(0.28, n(1 - (_ - 0.15) / (r - 0.15), 0, 1)), f = Math.round(40 - _ * 10);
    return { y: C, scale: L, opacity: T, z: f };
  };
  let o = (() => {
    let _ = l().findIndex((C) => C.hasAttribute("data-front"));
    return _ < 0 && (_ = 0), _;
  })(), c = null, u = 0, b = 0;
  const d = (x) => {
    const _ = l(), C = _.length;
    if (!C) return;
    a.toggleAttribute("data-dragging", x);
    let L = 0, T = 1 / 0;
    _.forEach((f, k) => {
      const S = i(k, o, C), N = s(S);
      f.style.setProperty("--blora-deck-y", N.y + "rem"), f.style.setProperty("--blora-deck-scale", String(N.scale)), f.style.setProperty("--blora-deck-opacity", String(N.opacity)), f.style.zIndex = String(N.z), Math.abs(S) < T && (T = Math.abs(S), L = k);
    }), _.forEach((f, k) => {
      const S = k === L;
      f.toggleAttribute("data-front", S), f.setAttribute("aria-hidden", String(!S));
    });
  }, m = () => {
    const x = l().length;
    x && (o = Math.round(o), o = (o % x + x) % x, d(!1), a.dispatchEvent(
      new CustomEvent("blora-deck-change", { bubbles: !0, detail: { index: o } })
    ));
  }, p = (x) => {
    l().length && (o = Math.round(o) + x, m());
  }, h = (x) => {
    o = x, m();
  }, E = (x) => {
    if (!(x.pointerType === "mouse" && x.button !== 0)) {
      c = {
        y: x.clientY,
        startOffset: o,
        locked: null,
        ly: x.clientY,
        lt: Date.now(),
        vy: 0,
        pointerId: x.pointerId
      };
      try {
        a.setPointerCapture(x.pointerId);
      } catch {
      }
    }
  }, y = (x) => {
    if (!c || x.pointerId !== c.pointerId) return;
    const _ = x.clientY - c.y;
    if (c.locked == null && (Math.abs(_) > 6 || Math.abs(x.movementX) > 6) && (c.locked = Math.abs(_) >= Math.abs(x.movementX) ? "y" : "x", c.locked === "x")) {
      c = null;
      return;
    }
    if (c.locked !== "y") return;
    x.preventDefault();
    const C = Date.now(), L = Math.max(1, C - c.lt);
    c.vy = (x.clientY - c.ly) / L, c.ly = x.clientY, c.lt = C, o = c.startOffset + _ / e, d(!0);
  }, v = (x) => {
    if (!c || x.pointerId !== c.pointerId) return;
    const _ = c.locked === "y", C = c.vy, L = c.startOffset;
    if (c = null, !_) {
      o = L, d(!1);
      return;
    }
    C <= -0.4 ? o -= 0.55 : C >= 0.4 && (o += 0.55), m();
  }, w = (x) => {
    x.preventDefault();
    const _ = Date.now();
    _ < b || (u += x.deltaY, Math.abs(u) > 40 && (p(u > 0 ? 1 : -1), u = 0, b = _ + 280));
  }, D = (x) => {
    x.key === "ArrowDown" || x.key === "PageDown" ? (x.preventDefault(), p(1)) : (x.key === "ArrowUp" || x.key === "PageUp") && (x.preventDefault(), p(-1));
  };
  return a.addEventListener("pointerdown", E), a.addEventListener("pointermove", y), a.addEventListener("pointerup", v), a.addEventListener("pointercancel", v), a.addEventListener("wheel", w, { passive: !1 }), a.addEventListener("keydown", D), d(!1), {
    destroy() {
      a.removeEventListener("pointerdown", E), a.removeEventListener("pointermove", y), a.removeEventListener("pointerup", v), a.removeEventListener("pointercancel", v), a.removeEventListener("wheel", w), a.removeEventListener("keydown", D);
    },
    next: () => p(1),
    prev: () => p(-1),
    goTo: h,
    getCurrent: () => Math.round(o)
  };
}
class Rn extends B {
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
      nodes: Array.from(r.childNodes).map((n) => n.cloneNode(!0)),
      variant: r.getAttribute("variant") ?? "flat"
    })));
    const t = Number(this.getAttribute("current") ?? 0), e = this.ownerDocument.createElement("div");
    e.className = "blora-deck", e.dataset.bloraGenerated = "", e.tabIndex = 0, e.setAttribute("aria-label", this.getAttribute("label") ?? g("deck.label")), this.definitions.forEach((r, n) => {
      const i = this.ownerDocument.createElement("article");
      i.className = "blora-card", i.dataset.variant = r.variant, (r.front || n === t) && (i.dataset.front = ""), i.append(...r.nodes.map((s) => s.cloneNode(!0))), e.appendChild(i);
    }), this.replaceChildren(e);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-deck");
    if (!t) return;
    this.controller = Pn(t);
    const e = Number(this.getAttribute("current") ?? 0);
    e && this.controller.goTo(e), this.listen(t, "blora-deck-change", (r) => {
      const n = r.detail.index;
      this.reflecting = !0, this.setAttribute("current", String(n)), this.reflecting = !1;
    });
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function ci(a = customElements) {
  !a || a.get(he) || a.define(he, Rn);
}
const pe = "blora-image";
function Je(a) {
  const l = a.getAttribute("data-preview-group") || a.getAttribute("data-blora-preview-group"), t = l ? a.ownerDocument.querySelectorAll(
    `[data-preview-group="${l}"], [data-blora-preview-group="${l}"]`
  ) : [a], e = [];
  let r = 0;
  return Array.from(t).forEach((n, i) => {
    const s = n.matches("img") ? n : n.querySelector("img"), o = n.getAttribute("data-preview-src") || n.getAttribute("href") || (s == null ? void 0 : s.currentSrc) || (s == null ? void 0 : s.src) || "";
    o && ((n === a || n.contains(a) || a.contains(n)) && (r = e.length), e.push({
      src: o,
      alt: (s == null ? void 0 : s.alt) || "",
      caption: n.getAttribute("data-caption") || (s == null ? void 0 : s.alt) || ""
    }));
  }), !e.length && a instanceof HTMLImageElement && e.push({ src: a.src, alt: a.alt, caption: a.alt }), { items: e, start: r };
}
function Ze(a, l = 0) {
  if (typeof document > "u" || !a.length) return null;
  const t = document, e = a.map((w) => typeof w == "string" ? { src: w } : w);
  let r = Math.max(0, Math.min(l, e.length - 1));
  const n = t.createElement("div");
  n.className = "blora-image-preview", n.dataset.open = "", n.setAttribute("role", "dialog"), n.setAttribute("aria-modal", "true"), n.setAttribute("aria-label", g("preview.label"));
  const i = t.createElement("div");
  i.className = "blora-image-preview__stage";
  const s = t.createElement("img");
  s.className = "blora-image-preview__img", s.alt = "";
  const o = t.createElement("div");
  o.className = "blora-image-preview__cap";
  const c = t.createElement("div");
  c.className = "blora-image-preview__count";
  const u = t.createElement("button");
  u.type = "button", u.className = "blora-image-preview__close", u.setAttribute("aria-label", g("preview.close")), u.appendChild(I("close", 18));
  const b = t.createElement("button");
  b.type = "button", b.className = "blora-image-preview__btn blora-image-preview__btn--prev", b.setAttribute("aria-label", g("preview.prev")), b.appendChild(I("chevron-left", 20));
  const d = t.createElement("button");
  d.type = "button", d.className = "blora-image-preview__btn blora-image-preview__btn--next", d.setAttribute("aria-label", g("preview.next")), d.appendChild(I("chevron-right", 20)), i.append(s, o), n.append(c, u, b, d, i), t.body.appendChild(n);
  const m = new dt(n, {
    modal: !0,
    closeOnEscape: !1,
    closeOnOutsidePointer: !1,
    restoreFocus: !0,
    trapFocus: !0,
    lockScroll: !0
  });
  m.open();
  const p = () => {
    const w = e[r];
    s.src = w.src, s.alt = w.alt || "", o.textContent = w.caption || "", c.textContent = e.length > 1 ? `${r + 1} / ${e.length}` : "", b.hidden = e.length < 2, d.hidden = e.length < 2;
  }, h = () => {
    n.isConnected && (n.removeAttribute("data-open"), t.removeEventListener("keydown", v), rt(n, () => {
      m.close(), n.remove();
    }));
  }, E = () => {
    r = (r + 1) % e.length, p();
  }, y = () => {
    r = (r - 1 + e.length) % e.length, p();
  }, v = (w) => {
    w.key === "Escape" && h(), w.key === "ArrowRight" && E(), w.key === "ArrowLeft" && y();
  };
  return u.addEventListener("click", h), b.addEventListener("click", (w) => {
    w.stopPropagation(), y();
  }), d.addEventListener("click", (w) => {
    w.stopPropagation(), E();
  }), n.addEventListener("click", (w) => {
    w.target === n && h();
  }), t.addEventListener("keydown", v), p(), { close: h, next: E, prev: y, el: n };
}
function Gn(a) {
  if (typeof document > "u") return { destroy: () => {
  } };
  const l = [], t = (n) => {
    const i = n.querySelector("img");
    if (!i) return;
    const s = () => n.removeAttribute("data-loading");
    if (i.complete && i.naturalWidth > 0) {
      s();
      return;
    }
    n.setAttribute("data-loading", ""), i.addEventListener("load", s), i.addEventListener("error", s), l.push(() => {
      i.removeEventListener("load", s), i.removeEventListener("error", s);
    });
  }, e = (n) => {
    if (!n.hasAttribute("data-blora-preview") && !n.classList.contains("blora-image--preview") && n.getAttribute("data-variant") !== "preview")
      return;
    n.setAttribute("tabindex", n.getAttribute("tabindex") || "0"), n.setAttribute("role", n.getAttribute("role") || "button");
    const i = () => {
      const { items: c, start: u } = Je(n);
      Ze(c, u);
    }, s = () => i(), o = (c) => {
      (c.key === "Enter" || c.key === " ") && (c.preventDefault(), i());
    };
    n.addEventListener("click", s), n.addEventListener("keydown", o), l.push(() => {
      n.removeEventListener("click", s), n.removeEventListener("keydown", o);
    });
  }, r = a.matches(".blora-image") ? [a] : Array.from(a.querySelectorAll(".blora-image, [data-blora-preview]"));
  return r.forEach((n) => {
    (n.classList.contains("blora-image") || n.matches(".blora-image")) && t(n), e(n);
  }), r.length || a.querySelectorAll("img").forEach((n) => {
    const i = n.closest(".blora-image");
    i && (t(i), e(i));
  }), {
    destroy() {
      l.forEach((n) => n());
    }
  };
}
class $n extends B {
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
    const { items: e, start: r } = Je(t);
    this.previewHandle = Ze(e, r);
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
    const n = this.getAttribute("caption");
    if (n) {
      const i = this.ownerDocument.createElement("figcaption");
      i.className = "blora-image__cap", i.textContent = n, t.dataset.caption = n, t.appendChild(i);
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
    const n = this.getAttribute("caption");
    let i = t.querySelector("figcaption");
    n ? (i || (i = this.ownerDocument.createElement("figcaption"), i.className = "blora-image__cap", t.appendChild(i)), i.textContent = n, t.dataset.caption = n) : (i == null || i.remove(), delete t.dataset.caption);
  }
  bindEvents() {
    const t = this.querySelector(".blora-image");
    t && (this.controller = Gn(t));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null, this.close();
  }
}
function ui(a = customElements) {
  !a || a.get(pe) || a.define(pe, $n);
}
const me = "blora-dock";
function Fn(a) {
  var u, b, d;
  const l = a.ownerDocument, t = l.defaultView, e = Array.from(a.querySelectorAll(".blora-dock__item"));
  if (!e.length || !t) return { destroy: () => {
  }, getCurrent: () => 0, select: () => {
  } };
  let r = a.querySelector(".blora-dock__indicator");
  r || (r = l.createElement("span"), r.className = "blora-dock__indicator", r.setAttribute("aria-hidden", "true"), a.insertBefore(r, a.firstChild));
  const n = (m) => {
    if (!m || !r) {
      r.style.opacity = "0";
      return;
    }
    const p = a.getBoundingClientRect(), h = m.getBoundingClientRect(), E = h.left - p.left + a.scrollLeft;
    r.style.opacity = "1", r.style.width = `${h.width}px`, r.style.height = `${h.height}px`, r.style.transform = `translate(${E}px, ${h.top - p.top}px)`;
  }, i = (m) => {
    e.forEach((p) => p.removeAttribute("data-active")), m.setAttribute("data-active", ""), n(m), a.dispatchEvent(
      new CustomEvent("blora-dock-change", {
        bubbles: !0,
        detail: { index: e.indexOf(m), value: m.dataset.value ?? "" }
      })
    );
  }, s = (m) => {
    const p = m.target.closest(".blora-dock__item");
    !p || !a.contains(p) || (m.preventDefault(), i(p));
  }, o = e.find((m) => m.hasAttribute("data-active")) ?? e[0];
  o && (i(o), requestAnimationFrame(() => {
    n(o), requestAnimationFrame(() => n(o));
  })), a.addEventListener("click", s);
  const c = () => {
    const m = e.find((p) => p.hasAttribute("data-active"));
    m && n(m);
  };
  return t.addEventListener("resize", c), (d = (b = (u = l.fonts) == null ? void 0 : u.ready) == null ? void 0 : b.then) == null || d.call(b, c), {
    destroy() {
      a.removeEventListener("click", s), t.removeEventListener("resize", c);
    },
    getCurrent: () => e.findIndex((m) => m.hasAttribute("data-active")),
    select(m) {
      const p = e[m];
      p && i(p);
    }
  };
}
class Hn extends B {
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
      nodes: Array.from(r.childNodes).map((n) => n.cloneNode(!0)),
      value: r.getAttribute("value") ?? ""
    })));
    const t = Number(this.getAttribute("current") ?? 0), e = this.ownerDocument.createElement("nav");
    e.className = "blora-dock", this.hasAttribute("static") && e.classList.add("blora-dock--static"), e.dataset.bloraGenerated = "", e.setAttribute("aria-label", this.getAttribute("label") ?? g("dock.label")), this.definitions.forEach((r, n) => {
      const i = this.ownerDocument.createElement("a");
      if (i.className = "blora-dock__item", i.href = r.href, i.dataset.value = r.value, (r.active || n === t) && (i.dataset.active = ""), r.icon) {
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
    t && (this.controller = Fn(t), this.listen(t, "blora-dock-change", (e) => {
      const r = e.detail.index;
      this.reflecting = !0, this.setAttribute("current", String(r)), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function di(a = customElements) {
  !a || a.get(me) || a.define(me, Hn);
}
const fe = "blora-megamenu";
function Vn(a) {
  if (typeof document > "u")
    return { open: () => {
    }, close: () => {
    }, destroy: () => {
    } };
  const l = a.ownerDocument, t = l.defaultView, e = a.querySelector("[data-blora-megamenu-trigger], .blora-megamenu__trigger") || a.querySelector("button"), r = a.querySelector(".blora-megamenu__panel");
  if (!e || !r || !t)
    return { open: () => {
    }, close: () => {
    }, destroy: () => {
    } };
  r.id || (r.id = `blora-megamenu-${Math.random().toString(36).slice(2, 9)}`), e.setAttribute("aria-controls", r.id), e.setAttribute("aria-haspopup", "true"), e.setAttribute("aria-expanded", "false");
  const n = () => {
    if (!a.hasAttribute("data-open") || typeof t.matchMedia == "function" && t.matchMedia("(max-width: 900px)").matches)
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
      if (h === a) return;
      h.removeAttribute("data-open");
      const E = h.querySelector(
        "[data-blora-megamenu-trigger], .blora-megamenu__trigger"
      );
      E == null || E.setAttribute("aria-expanded", "false");
    }), a.setAttribute("data-open", "")) : a.removeAttribute("data-open"), e.setAttribute("aria-expanded", String(d)), a.dispatchEvent(
      new CustomEvent("blora-megamenu-toggle", { bubbles: !0, detail: { open: d } })
    ), d && t.requestAnimationFrame(n), d && m && ((p = r.querySelector("a, button")) == null || p.focus());
  }, s = (d) => {
    d.stopPropagation(), i(!a.hasAttribute("data-open"));
  }, o = (d) => {
    d.key === "ArrowDown" && (d.preventDefault(), i(!0, !0));
  }, c = (d) => {
    d.key === "Escape" && (d.preventDefault(), i(!1), e.focus());
  }, u = (d) => {
    d.target.closest("a") && i(!1);
  }, b = (d) => {
    a.contains(d.target) || i(!1);
  };
  return e.addEventListener("click", s), e.addEventListener("keydown", o), a.addEventListener("keydown", c), r.addEventListener("click", u), l.addEventListener("click", b), t.addEventListener("resize", n), {
    open: () => i(!0),
    close: () => i(!1),
    destroy() {
      e.removeEventListener("click", s), e.removeEventListener("keydown", o), a.removeEventListener("keydown", c), r.removeEventListener("click", u), l.removeEventListener("click", b), t.removeEventListener("resize", n);
    }
  };
}
class zn extends B {
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
    e.className = "blora-button blora-megamenu__trigger", e.type = "button", e.dataset.variant = "outline", e.dataset.bloraMegamenuTrigger = "", e.textContent = this.getAttribute("label") ?? g("megamenu.label");
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-megamenu__panel";
    const n = this.ownerDocument.createElement("div");
    n.className = "blora-megamenu__grid", this.definitions.forEach((i) => {
      const s = this.ownerDocument.createElement("div"), o = this.ownerDocument.createElement("div");
      o.className = "blora-megamenu__title", o.textContent = i.title, s.appendChild(o), i.nodes.forEach((c) => {
        const u = c.cloneNode(!0);
        u instanceof this.ownerDocument.defaultView.HTMLAnchorElement && u.classList.add("blora-megamenu__link"), s.appendChild(u);
      }), n.appendChild(s);
    }), r.appendChild(n), t.append(e, r), this.replaceChildren(t);
  }
  sync() {
    const t = this.querySelector("input, textarea");
    t && (t.disabled = this.hasAttribute("disabled"), this.hasAttribute("placeholder") && (t.placeholder = this.getAttribute("placeholder") ?? ""), this.hasAttribute("value") && this.ownerDocument.activeElement !== t && (t.value = this.getAttribute("value") ?? t.value)), this.rebind();
  }
  bindEvents() {
    const t = this.querySelector(".blora-megamenu");
    t && (this.controller = Vn(t), this.listen(t, "blora-megamenu-toggle", (e) => {
      const r = e.detail.open;
      this.reflecting = !0, this.toggleAttribute("open", r), this.reflecting = !1;
    }), this.hasAttribute("open") && this.controller.open());
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function bi(a = customElements) {
  !a || a.get(fe) || a.define(fe, zn);
}
const ge = "blora-speed-dial";
function Z(a, l, t) {
  const e = I(l ?? t, 18, a);
  return e.childElementCount ? e : I(t, 18, a);
}
function Yn(a, l = {}) {
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
  const t = a.ownerDocument, e = a.querySelector(
    "[data-blora-speed-dial-trigger], .blora-speed-dial__trigger"
  ), r = a.querySelector(".blora-speed-dial__actions"), n = a.querySelector(
    "[data-blora-speed-dial-close], .blora-speed-dial__close"
  ), i = a.querySelector(
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
  }), n == null || n.setAttribute("tabindex", "-1"), n == null || n.setAttribute("aria-hidden", "true"), i == null || i.setAttribute("tabindex", "-1"), i == null || i.setAttribute("aria-hidden", "true");
  const o = (h, E = !1) => {
    var y;
    h ? a.setAttribute("data-open", "") : a.removeAttribute("data-open"), e.setAttribute("aria-expanded", String(h)), r.setAttribute("aria-hidden", String(!h)), n == null || n.setAttribute("aria-hidden", String(!h)), i && (i.setAttribute("aria-hidden", String(!h)), i.setAttribute("tabindex", h ? "0" : "-1")), s.forEach((v) => v.setAttribute("tabindex", h ? "0" : "-1")), h && E && ((y = i ?? s[0]) == null || y.focus()), h || s.forEach((v) => v.setAttribute("tabindex", "-1")), a.dispatchEvent(
      new CustomEvent("blora-speed-dial-toggle", { bubbles: !0, detail: { open: h } })
    );
  }, c = (h) => {
    h.stopPropagation(), o(!a.hasAttribute("data-open"));
  }, u = (h) => {
    (h.key === "ArrowDown" || h.key === "ArrowUp" || h.key === "ArrowLeft" || h.key === "ArrowRight") && (h.preventDefault(), o(!0, !0));
  }, b = (h) => {
    var v, w, D, x;
    if (h.key === "Escape" && a.hasAttribute("data-open")) {
      h.preventDefault(), o(!1), e.focus();
      return;
    }
    if (!a.hasAttribute("data-open")) return;
    const E = i ? [i, ...s] : s, y = E.indexOf(h.target);
    y < 0 || ((h.key === "ArrowDown" || h.key === "ArrowRight") && (h.preventDefault(), (v = E[(y + 1) % E.length]) == null || v.focus()), (h.key === "ArrowUp" || h.key === "ArrowLeft") && (h.preventDefault(), (w = E[(y - 1 + E.length) % E.length]) == null || w.focus()), h.key === "Home" && (h.preventDefault(), (D = E[0]) == null || D.focus()), h.key === "End" && (h.preventDefault(), (x = E[E.length - 1]) == null || x.focus()));
  }, d = (h) => {
    const E = h.target.closest(".blora-speed-dial__action");
    E && (a.dispatchEvent(
      new CustomEvent("blora-speed-dial-select", {
        bubbles: !0,
        detail: { value: E.dataset.value ?? "" }
      })
    ), o(!1));
  }, m = (h) => {
    a.contains(h.target) || o(!1);
  }, p = (h) => {
    h.stopPropagation(), o(!1), e.focus();
  };
  return l.triggerDelegated || e.addEventListener("click", c), e.addEventListener("keydown", u), a.addEventListener("keydown", b), r.addEventListener("click", d), n == null || n.addEventListener("click", p), i == null || i.addEventListener("click", p), t.addEventListener("click", m), {
    open: () => o(!0),
    close: () => o(!1),
    toggle: () => o(!a.hasAttribute("data-open")),
    destroy() {
      l.triggerDelegated || e.removeEventListener("click", c), e.removeEventListener("keydown", u), a.removeEventListener("keydown", b), r.removeEventListener("click", d), n == null || n.removeEventListener("click", p), i == null || i.removeEventListener("click", p), t.removeEventListener("click", m);
    }
  };
}
class Wn extends B {
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
    if (r.className = "blora-button blora-speed-dial__trigger", r.dataset.size = "icon", r.dataset.variant = "primary", r.dataset.bloraSpeedDialTrigger = "", r.type = "button", r.setAttribute("aria-label", this.getAttribute("label") ?? g("speedDial.label")), r.appendChild(Z(this.ownerDocument, "plus", "plus")), t.appendChild(r), this.hasAttribute("close-button")) {
      const o = this.ownerDocument.createElement("button");
      o.className = "blora-button blora-speed-dial__close", o.dataset.size = "icon", o.dataset.variant = "danger", o.dataset.bloraSpeedDialClose = "", o.type = "button", o.setAttribute("aria-label", g("common.close")), o.appendChild(Z(this.ownerDocument, "close", "close")), t.appendChild(o);
    }
    const n = this.getAttribute("main-label");
    if (n) {
      const o = this.ownerDocument.createElement("button");
      o.className = "blora-button blora-speed-dial__main", o.dataset.size = "icon", o.dataset.variant = "secondary", o.dataset.bloraSpeedDialMain = "", o.type = "button", o.setAttribute("aria-label", n), o.appendChild(Z(this.ownerDocument, this.getAttribute("main-icon"), "plus")), t.appendChild(o);
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
    t && (this.controller = Yn(t, { triggerDelegated: !0 }), (r = this.dialTreeObserver) == null || r.disconnect(), this.dialTreeObserver = new MutationObserver(() => {
      this.isConnectedInternal && this.rebind();
    }), this.dialTreeObserver.observe(this, { childList: !0 }), this.listen(this, "click", (n) => {
      var s;
      if (this.lastToggleEvent === n) return;
      const i = n.target;
      !i || !i.closest("[data-blora-speed-dial-trigger], .blora-speed-dial__trigger") || this.contains(i) && (this.lastToggleEvent = n, n.stopPropagation(), (s = this.controller) == null || s.toggle());
    }), this.listen(this, "keydown", (n) => {
      var o;
      const i = n;
      if (this.lastToggleEvent === n) return;
      const s = n.target;
      !s || !s.closest("[data-blora-speed-dial-trigger], .blora-speed-dial__trigger") || !this.contains(s) || i.key !== "Enter" && i.key !== " " || (this.lastToggleEvent = n, n.preventDefault(), n.stopPropagation(), (o = this.controller) == null || o.toggle());
    }), this.listen(t, "blora-speed-dial-toggle", (n) => {
      const i = n.detail.open;
      this.reflecting = !0, this.toggleAttribute("open", i), this.reflecting = !1;
    }), this.hasAttribute("open") && this.controller.open());
  }
  onDisconnect() {
    var t, e;
    (t = this.dialTreeObserver) == null || t.disconnect(), this.dialTreeObserver = null, (e = this.controller) == null || e.destroy(), this.controller = null;
  }
}
function hi(a = customElements) {
  !a || a.get(ge) || a.define(ge, Wn);
}
const ve = "blora-splitter";
function Un(a) {
  const l = a.ownerDocument, t = Array.from(a.querySelectorAll(".blora-splitter__pane"));
  if (t.length < 2) return { destroy: () => {
  }, getPosition: () => 50, setPosition: () => {
  } };
  let e = a.querySelector(".blora-splitter__handle");
  if (!e) {
    e = l.createElement("div"), e.className = "blora-splitter__handle";
    const d = l.createElement("span");
    d.className = "blora-splitter__grip", e.appendChild(d), a.insertBefore(e, t[1]);
  }
  const r = Number(a.dataset.min ?? 50);
  let n = !1, i = Number(a.dataset.position ?? 50);
  e.tabIndex = 0, e.setAttribute("role", "separator"), e.setAttribute("aria-orientation", "vertical");
  const s = (d, m = !1) => {
    const p = a.getBoundingClientRect(), h = p.width > 0 ? r / p.width * 100 : 0;
    i = Math.max(h, Math.min(100 - h, d)), t[0].style.flex = `0 0 ${i}%`, t[1].style.flex = "1 1 0%", e.setAttribute("aria-valuenow", String(Math.round(i))), m && a.dispatchEvent(
      new CustomEvent("blora-splitter-change", {
        bubbles: !0,
        detail: { position: i }
      })
    );
  }, o = (d) => {
    n = !0, e.setPointerCapture(d.pointerId), d.preventDefault();
  }, c = (d) => {
    if (!n) return;
    const m = a.getBoundingClientRect(), p = (d.clientX - m.left) / m.width * 100;
    s(p, !0);
  }, u = (d) => {
    d.key !== "ArrowLeft" && d.key !== "ArrowRight" || (d.preventDefault(), s(i + (d.key === "ArrowRight" ? 2 : -2), !0));
  }, b = (d) => {
    n = !1;
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
class Kn extends B {
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
      r.className = "blora-splitter__pane", r.style.cssText = e.style, r.append(...e.nodes.map((n) => n.cloneNode(!0))), t.appendChild(r);
    }), this.replaceChildren(t);
  }
  sync() {
    var n;
    const t = this.querySelector(".blora-splitter");
    if (!t) return;
    const e = this.getAttribute("min");
    e && (t.dataset.min = e);
    const r = this.getAttribute("position");
    r && (t.dataset.position = r, (n = this.controller) == null || n.setPosition(Number(r)));
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-splitter");
    t && ((e = this.controller) == null || e.destroy(), this.controller = Un(t), this.listen(t, "blora-splitter-change", (r) => {
      const n = r.detail.position;
      this.reflecting = !0, this.setAttribute("position", String(n)), this.reflecting = !1;
    }));
  }
  onDisconnect() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
}
function pi(a = customElements) {
  !a || a.get(ve) || a.define(ve, Kn);
}
const Ae = "blora-tour";
function Xn(a, l) {
  const t = a.trim();
  return t ? t.endsWith("%") ? Number.parseFloat(t) / 100 * l : Number.parseFloat(t) || 0 : 0;
}
function jn(a) {
  const l = Array.from(a.children).filter(
    (t) => t instanceof HTMLElement
  );
  return l.length === 1 ? l[0] : a;
}
function Qn(a) {
  const l = getComputedStyle(a).getPropertyValue("--blora-tour-pad").trim(), t = Number.parseFloat(l);
  return Number.isFinite(t) && t >= 0 ? t : 4;
}
function ot(a, l, t) {
  return Xn(a.trim().split(/\s+/)[0] ?? "0px", l) + t;
}
function Jn(a, l, t) {
  const e = Math.min(
    1,
    a / Math.max(t.tl + t.tr, 1e-3),
    a / Math.max(t.bl + t.br, 1e-3),
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
function Zn(a, l) {
  const t = l.getBoundingClientRect(), e = getComputedStyle(l), r = Qn(a), n = t.left - r, i = t.top - r, s = Math.max(0, t.width + r * 2), o = Math.max(0, t.height + r * 2), c = Jn(s, o, {
    tl: ot(e.borderTopLeftRadius, t.width, r),
    tr: ot(e.borderTopRightRadius, t.width, r),
    br: ot(e.borderBottomRightRadius, t.width, r),
    bl: ot(e.borderBottomLeftRadius, t.width, r)
  }), u = a.querySelector(".blora-tour__ring");
  return u.style.left = `${n}px`, u.style.top = `${i}px`, u.style.width = `${s}px`, u.style.height = `${o}px`, u.style.borderRadius = `${c.tl}px ${c.tr}px ${c.br}px ${c.bl}px`, { pad: r, rect: t };
}
function ta(a) {
  const l = a.ownerDocument, t = a.querySelector("[data-tour-start]"), e = Array.from(a.querySelectorAll("[data-tour-step]"));
  if (e.length === 0)
    return { destroy: () => {
    }, end: () => {
    }, next: () => {
    }, prev: () => {
    }, start: () => {
    } };
  let r = -1, n = null, i = null, s = null;
  const o = () => {
    var x;
    n = l.createElement("div"), n.className = "blora-tour__overlay", n.setAttribute("popover", "manual");
    const p = l.createElement("div");
    p.className = "blora-tour__ring", n.appendChild(p), i = l.createElement("div"), i.className = "blora-tour__tooltip", i.setAttribute("role", "dialog"), i.setAttribute("aria-modal", "true");
    const h = l.createElement("div");
    h.className = "blora-tour__title", h.id = "blora-tour-title";
    const E = l.createElement("div");
    E.className = "blora-tour__desc";
    const y = l.createElement("div");
    y.className = "blora-tour__footer";
    const v = l.createElement("span");
    v.className = "blora-tour__counter";
    const w = l.createElement("div");
    w.className = "blora-tour__buttons";
    const D = (_, C, L) => {
      const T = l.createElement("button");
      return T.className = `blora-button ${_}`, T.dataset.variant = L, T.dataset.size = "sm", T.type = "button", T.textContent = C, T;
    };
    w.append(
      D("blora-tour__skip", g("common.skip"), "outline"),
      D("blora-tour__prev", g("common.prev"), "outline"),
      D("blora-tour__next", g("common.next"), "primary")
    ), y.append(v, w), i.append(h, E, y), i.setAttribute("aria-labelledby", h.id), n.appendChild(i), l.body.appendChild(n);
    try {
      (x = n.showPopover) == null || x.call(n);
    } catch {
    }
    i.querySelector(".blora-tour__skip").addEventListener("click", m), i.querySelector(".blora-tour__prev").addEventListener("click", () => b(r - 1)), i.querySelector(".blora-tour__next").addEventListener("click", () => {
      r < e.length - 1 ? b(r + 1) : m();
    }), n.addEventListener("blora-close-request", m);
  }, c = () => {
    var f;
    if (!n || !i || r < 0) return;
    const p = e[r], h = jn(p), E = l.defaultView, y = (f = E == null ? void 0 : E.matchMedia) == null ? void 0 : f.call(E, "(prefers-reduced-motion: reduce)").matches;
    typeof h.scrollIntoView == "function" && h.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: y ? "auto" : "smooth"
    });
    const { pad: v, rect: w } = Zn(n, h), D = i.offsetHeight || 140, x = i.offsetWidth || 280, _ = (E == null ? void 0 : E.innerHeight) ?? 800, C = (E == null ? void 0 : E.innerWidth) ?? 1200;
    let L = w.bottom + v + 12;
    L + D > _ - 12 && (L = w.top - v - 12 - D), L < 12 && (L = 12);
    let T = Math.max(8, w.left - v);
    T + x > C - 8 && (T = Math.max(8, C - x - 8)), i.style.top = `${L}px`, i.style.left = `${T}px`;
  }, u = () => c(), b = (p) => {
    r = Math.max(0, Math.min(p, e.length - 1));
    const h = e[r];
    i.querySelector(".blora-tour__title").textContent = h.dataset.tourTitle ?? "", i.querySelector(".blora-tour__desc").textContent = h.dataset.tourDesc ?? "", i.querySelector(".blora-tour__counter").textContent = g("tour.step", {
      current: r + 1,
      total: e.length
    });
    const E = i.querySelector(".blora-tour__next");
    E.textContent = r < e.length - 1 ? g("common.next") : g("common.done"), i.querySelector(".blora-tour__prev").style.visibility = r > 0 ? "visible" : "hidden", c(), n != null && n.hasAttribute("data-open") && i.setAttribute("data-open", ""), a.dispatchEvent(
      new CustomEvent("blora-tour-change", {
        bubbles: !0,
        detail: { index: r, total: e.length }
      })
    );
  }, d = () => {
    m(), o(), l.documentElement.setAttribute("data-blora-tour-open", ""), n && (s = new dt(n, {
      modal: !0,
      closeOnEscape: !0,
      closeOnOutsidePointer: !1,
      restoreFocus: !0,
      trapFocus: !0,
      lockScroll: !0
    }), s.open()), window.addEventListener("resize", u), window.addEventListener("scroll", u, !0), b(0), n == null || n.offsetWidth, i == null || i.offsetWidth;
    const p = l.defaultView, h = () => {
      n == null || n.setAttribute("data-open", ""), i == null || i.setAttribute("data-open", "");
    };
    p ? p.requestAnimationFrame(h) : h();
  }, m = () => {
    const p = r >= 0;
    window.removeEventListener("resize", u), window.removeEventListener("scroll", u, !0), l.documentElement.removeAttribute("data-blora-tour-open");
    const h = n, E = i, y = s;
    n = null, i = null, s = null, r = -1, h == null || h.removeAttribute("data-open"), E == null || E.removeAttribute("data-open");
    const v = () => {
      var w;
      y == null || y.close();
      try {
        (w = h == null ? void 0 : h.hidePopover) == null || w.call(h);
      } catch {
      }
      h == null || h.remove();
    };
    E ? rt(E, v) : v(), p && a.dispatchEvent(new CustomEvent("blora-tour-end", { bubbles: !0 }));
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
class ea extends B {
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
    this.definitions || (this.definitions = Array.from(this.children).filter((n) => n.localName === "blora-tour-step").map((n) => ({
      description: n.getAttribute("description") ?? "",
      nodes: Array.from(n.childNodes).map((i) => i.cloneNode(!0)),
      title: n.getAttribute("title") ?? ""
    })));
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-tour", t.dataset.bloraGenerated = "";
    const e = this.ownerDocument.createElement("button");
    e.className = "blora-button", e.dataset.variant = "primary", e.dataset.tourStart = "", e.type = "button", e.textContent = this.getAttribute("label") ?? g("tour.start"), t.appendChild(e);
    const r = this.ownerDocument.createElement("div");
    r.className = "blora-tour__steps", this.definitions.forEach((n) => {
      const i = this.ownerDocument.createElement("div");
      i.dataset.tourStep = "", i.dataset.tourTitle = n.title, i.dataset.tourDesc = n.description, i.append(...n.nodes.map((s) => s.cloneNode(!0))), r.appendChild(i);
    }), t.appendChild(r), this.replaceChildren(t);
  }
  sync() {
    var e, r;
    const t = this.querySelector("[data-tour-start]");
    t && (t.textContent = this.getAttribute("label") ?? g("tour.start")), this.hasAttribute("open") ? (e = this.controller) == null || e.start() : (r = this.controller) == null || r.end();
  }
  bindEvents() {
    var e;
    const t = this.querySelector(".blora-tour");
    t && ((e = this.controller) == null || e.destroy(), this.controller = ta(t), this.listen(t, "blora-tour-change", () => {
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
function mi(a = customElements) {
  !a || a.get(Ae) || a.define(Ae, ea);
}
const ra = {
  success: "check",
  danger: "close",
  error: "close",
  warning: "circle-alert",
  info: "info"
};
function ut(a, l, t) {
  return I(ra[l] ?? "info", t, a);
}
const ye = "blora-alert";
class na extends B {
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
    const n = this.ownerDocument.createElement("div");
    n.className = "blora-alert__title", n.textContent = this.getAttribute("title") ?? "";
    const i = this.ownerDocument.createElement("div");
    if (i.className = "blora-alert__desc", i.textContent = this.getAttribute("description") ?? "", r.append(n, i), t.append(e, r), this.hasAttribute("dismissible")) {
      const s = this.ownerDocument.createElement("button");
      s.className = "blora-alert__close", s.type = "button", s.setAttribute("aria-label", g("common.close")), s.appendChild(I("close", 16, this.ownerDocument)), t.appendChild(s);
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
    const n = l.querySelector(".blora-alert__desc");
    n && (n.textContent = this.getAttribute("description") ?? "");
    const i = l.querySelector(".blora-alert__close");
    this.hasAttribute("dismissible") && !i ? (this.render(), this.rebind()) : !this.hasAttribute("dismissible") && i && i.remove();
  }
  bindEvents() {
    const l = this.querySelector(".blora-alert__close");
    l && this.listen(l, "click", () => this.close());
  }
}
function fi(a = customElements) {
  !a || a.get(ye) || a.define(ye, na);
}
const _e = "blora-banner";
class aa extends B {
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
    const n = this.ownerDocument.createElement("div");
    n.className = "blora-banner__desc", n.textContent = this.getAttribute("description") ?? "", e.append(r, n);
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
function gi(a = customElements) {
  !a || a.get(_e) || a.define(_e, aa);
}
const Ee = "blora-breadcrumb";
class ia extends B {
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
    t.className = "blora-breadcrumb", t.dataset.bloraGenerated = "", t.setAttribute("aria-label", g("breadcrumb.label")), this.definitions.forEach((e, r) => {
      if (r) {
        const n = this.ownerDocument.createElement("span");
        n.className = "blora-breadcrumb__sep", n.setAttribute("aria-hidden", "true"), n.textContent = "/", t.appendChild(n);
      }
      if (e.current || r === this.definitions.length - 1) {
        const n = this.ownerDocument.createElement("span");
        n.className = "blora-breadcrumb__current", n.setAttribute("aria-current", "page"), n.textContent = e.label, t.appendChild(n);
      } else {
        const n = this.ownerDocument.createElement("a");
        n.href = e.href, n.textContent = e.label, t.appendChild(n);
      }
    }), this.replaceChildren(t);
  }
  bindEvents() {
  }
}
function vi(a = customElements) {
  !a || a.get(Ee) || a.define(Ee, ia);
}
const Ce = "blora-chart-container";
class sa extends B {
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
    const r = this.ownerDocument.createElement("div"), n = this.ownerDocument.createElement("div");
    n.className = "blora-chart__title", n.textContent = this.getAttribute("title") ?? "";
    const i = this.ownerDocument.createElement("div");
    i.className = "blora-text-xs blora-text-subtle", i.textContent = this.getAttribute("subtitle") ?? "", r.append(n, i), e.appendChild(r);
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
    const r = this.getAttribute("trend"), n = this.querySelector(".blora-tag");
    if (r) {
      if (!n) {
        this.render();
        return;
      }
      n.textContent = r, n.dataset.variant = this.getAttribute("trend-variant") ?? "success";
    } else
      n == null || n.remove();
  }
  bindEvents() {
  }
}
function Ai(a = customElements) {
  !a || a.get(Ce) || a.define(Ce, sa);
}
const we = "blora-chat";
class oa extends B {
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
    const n = this.ownerDocument.createElement("span");
    n.textContent = this.getAttribute("author") ?? "";
    const i = this.ownerDocument.createElement("time");
    i.textContent = this.getAttribute("time") ?? "", r.append(n, i);
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
    const n = l.querySelector(".blora-chat__bubble");
    n && (n.textContent = this.getAttribute("message") ?? "");
  }
  bindEvents() {
  }
}
function yi(a = customElements) {
  !a || a.get(we) || a.define(we, oa);
}
const xe = "blora-comment";
function la(a) {
  const l = a.getAttribute("slot");
  return a.localName === "blora-comment" || l === "nested" ? "nested" : l === "time" || l === "meta" ? "meta" : l === "avatar" || l === "author" || l === "actions" ? l : "body";
}
class ca extends B {
  constructor() {
    super(...arguments);
    A(this, "assigned", null);
  }
  render() {
    const t = this.takeAssigned(), e = this.ownerDocument, r = e.createElement("article");
    r.className = "blora-comment", r.dataset.bloraGenerated = "";
    const n = e.createElement("div");
    if (n.className = "blora-comment__main", t.author.length || t.meta.length) {
      const i = e.createElement("div");
      if (i.className = "blora-comment__head", t.author.length) {
        const s = e.createElement("span");
        s.className = "blora-comment__author", s.append(...this.take(t.author)), i.append(s);
      }
      if (t.meta.length) {
        const s = e.createElement("span");
        s.className = "blora-comment__time", s.append(...this.take(t.meta)), i.append(s);
      }
      n.append(i);
    }
    if (t.body.length) {
      const i = e.createElement("div");
      i.className = "blora-comment__body", i.append(...this.take(t.body)), n.append(i);
    }
    if (t.actions.length) {
      const i = e.createElement("div");
      i.className = "blora-comment__actions", i.append(...this.take(t.actions)), n.append(i);
    }
    if (t.nested.length) {
      const i = e.createElement("div");
      i.className = "blora-comment__nested", i.append(...this.take(t.nested)), n.append(i);
    }
    if (t.avatar.length) {
      const i = e.createElement("div");
      i.className = "blora-comment__avatar", i.append(...this.take(t.avatar)), r.append(i, n);
    } else
      r.append(n);
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
          const n = r;
          if (n.hasAttribute("data-blora-generated")) continue;
          e[la(n)].push(n);
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
function _i(a = customElements) {
  a.get(xe) || a.define(xe, ca);
}
const ke = "blora-empty";
class ua extends B {
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
    r.className = "blora-empty__title", r.textContent = this.getAttribute("title") ?? g("empty.title");
    const n = this.ownerDocument.createElement("div");
    n.className = "blora-empty__desc", n.textContent = this.getAttribute("description") ?? "", l.append(t, r, n);
    const i = this.getAttribute("action-label");
    if (i) {
      const s = this.ownerDocument.createElement("button");
      s.className = "blora-button", s.dataset.variant = "primary", s.dataset.size = "sm", s.type = "button", s.textContent = i, s.dataset.emptyAction = "", l.appendChild(s);
    }
    this.replaceChildren(l);
  }
  sync() {
    const l = this.querySelector(".blora-empty__title");
    l && (l.textContent = this.getAttribute("title") ?? g("empty.title"));
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
function Ei(a = customElements) {
  !a || a.get(ke) || a.define(ke, ua);
}
const Se = "blora-mockup";
class da extends B {
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
    if (e.className = `blora-mockup blora-mockup--${t}`, e.dataset.bloraGenerated = "", e.setAttribute("aria-label", this.getAttribute("label") ?? g("mockup.label", { variant: t })), t === "code")
      this.content.forEach((r) => {
        var n;
        if (r instanceof Element && r.localName === "blora-mockup-line") {
          const i = this.ownerDocument.createElement("pre");
          i.className = "blora-mockup__line";
          const s = r.getAttribute("tone");
          ["danger", "highlight", "info", "muted", "success", "warning"].includes(s ?? "") && i.classList.add(`blora-mockup__line--${s}`);
          const o = r.getAttribute("prefix");
          o != null && (i.dataset.prefix = o), i.append(...Array.from(r.childNodes).map((c) => c.cloneNode(!0))), e.appendChild(i);
          return;
        }
        (r.nodeType !== Node.TEXT_NODE || (n = r.textContent) != null && n.trim()) && e.appendChild(r.cloneNode(!0));
      });
    else if (t === "phone") {
      const r = this.ownerDocument.createElement("div");
      r.className = "blora-mockup__camera", r.setAttribute("aria-hidden", "true");
      const n = this.ownerDocument.createElement("div");
      n.className = "blora-mockup__display";
      const i = this.ownerDocument.createElement("div");
      i.className = "blora-mockup__display-body", i.append(...this.content.map((s) => s.cloneNode(!0))), n.appendChild(i), e.append(r, n);
    } else {
      const r = this.ownerDocument.createElement("div");
      r.className = "blora-mockup__toolbar";
      const n = this.ownerDocument.createElement("span");
      n.className = "blora-mockup__dots", n.setAttribute("aria-hidden", "true"), n.appendChild(this.ownerDocument.createElement("span")), r.appendChild(n);
      const i = this.ownerDocument.createElement(t === "browser" ? "div" : "span");
      i.className = t === "browser" ? "blora-mockup__address" : "blora-mockup__title", t === "browser" ? i.append(
        I("search", 16, this.ownerDocument),
        this.ownerDocument.createTextNode(this.getAttribute("address") ?? "about:blank")
      ) : i.textContent = this.getAttribute("title") ?? g("mockup.window"), r.appendChild(i);
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
      this.getAttribute("label") ?? g("mockup.label", { variant: this.getAttribute("variant") ?? "browser" })
    );
    const e = t.querySelector(".blora-mockup__address");
    e && e.replaceChildren(
      I("search", 16, this.ownerDocument),
      this.ownerDocument.createTextNode(this.getAttribute("address") ?? "about:blank")
    );
    const r = t.querySelector(".blora-mockup__title");
    r && (r.textContent = this.getAttribute("title") ?? g("mockup.window"));
  }
  bindEvents() {
  }
}
function Ci(a = customElements) {
  !a || a.get(Se) || a.define(Se, da);
}
const Ne = "blora-navbar";
class ba extends B {
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
    const n = this.ownerDocument.createElement("span");
    n.className = "blora-brand-mark";
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
    n.appendChild(i);
    const s = this.ownerDocument.createElement("span");
    s.className = "blora-navbar__title", s.textContent = this.getAttribute("title") ?? g("navbar.title"), r.append(n, s);
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
    const n = t.querySelector(".blora-navbar__title");
    n && (n.textContent = this.getAttribute("title") ?? g("navbar.title")), t.dataset.variant = this.getAttribute("variant") ?? "floating";
  }
  bindEvents() {
  }
}
function wi(a = customElements) {
  !a || a.get(Ne) || a.define(Ne, ba);
}
const De = "blora-sidebar-nav";
class ha extends B {
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
          this.getAttribute("label") ?? g("sidebar.label")
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
    const t = this.getAttribute("value") ?? ((r = this.definitions.flatMap((n) => n.links).find((n) => n.current)) == null ? void 0 : r.value) ?? "";
    t && !this.hasAttribute("value") && (this.reflecting = !0, this.setAttribute("value", t), this.reflecting = !1);
    const e = this.ownerDocument.createElement("nav");
    e.className = "blora-sidebar-nav", e.dataset.bloraGenerated = "", e.setAttribute("aria-label", this.getAttribute("label") ?? g("sidebar.label"));
    for (const n of this.definitions) {
      const i = this.ownerDocument.createElement("div");
      if (i.className = "blora-sidebar-nav__group", i.setAttribute("role", "group"), n.label) {
        i.setAttribute("aria-label", n.label);
        const s = this.ownerDocument.createElement("div");
        s.className = "blora-sidebar-nav__group-label", s.textContent = n.label, s.setAttribute("aria-hidden", "true"), i.appendChild(s);
      }
      for (const s of n.links) {
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
      const r = e.target, n = r == null ? void 0 : r.closest(".blora-sidebar-nav__link");
      if (!n || !t.contains(n)) return;
      const i = n.dataset.value ?? "";
      this.select(i), this.emit("blora-change", {
        href: n.getAttribute("href") ?? "",
        value: i
      });
    });
  }
  readDefinitions() {
    const t = [], e = [];
    for (const r of Array.from(this.children))
      r.localName === "blora-sidebar-nav-group" ? t.push({
        label: r.getAttribute("label") ?? "",
        links: Array.from(r.children).filter((n) => n.localName === "blora-sidebar-nav-link").map((n, i) => this.readLink(n, i))
      }) : r.localName === "blora-sidebar-nav-link" && e.push(this.readLink(r, e.length));
    return e.length && t.unshift({ label: "", links: e }), t.filter((r) => r.links.length > 0);
  }
  readLink(t, e) {
    var s;
    const r = t.getAttribute("href") ?? "#", n = t.getAttribute("label") ?? ((s = t.textContent) == null ? void 0 : s.trim()) ?? "", i = t.getAttribute("value") ?? (r.replace(/^#/, "") || `item-${e + 1}`);
    return { current: t.hasAttribute("current"), href: r, label: n, value: i };
  }
  syncCurrent() {
    const t = this.getAttribute("value") ?? "";
    for (const e of this.querySelectorAll(".blora-sidebar-nav__link"))
      t && e.dataset.value === t ? e.setAttribute("aria-current", "page") : e.removeAttribute("aria-current");
  }
}
function xi(a = customElements) {
  !a || a.get(De) || a.define(De, ha);
}
const Le = "blora-result";
class pa extends B {
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
    const n = this.ownerDocument.createElement("div");
    n.className = "blora-result__desc", n.textContent = this.getAttribute("description") ?? "", t.append(e, r, n), this.replaceChildren(t);
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
    const n = l.querySelector(".blora-result__desc");
    n && (n.textContent = this.getAttribute("description") ?? "");
  }
  bindEvents() {
  }
}
function ki(a = customElements) {
  !a || a.get(Le) || a.define(Le, pa);
}
const qe = "blora-timeline";
class ma extends B {
  constructor() {
    super(...arguments);
    A(this, "definitions", null);
  }
  render() {
    this.definitions || (this.definitions = Array.from(this.children).filter((e) => e.localName === "blora-timeline-item").map((e) => {
      var n;
      const r = Array.from(e.childNodes).filter(
        (i) => !(i.nodeType === Node.ELEMENT_NODE && i.hasAttribute("data-blora-generated"))
      );
      return {
        description: e.getAttribute("description") ?? "",
        time: e.getAttribute("time") ?? "",
        // Only fall back to textContent for plain text items; items carrying
        // custom child content render that in .blora-timeline__content instead.
        title: e.getAttribute("title") ?? (r.length ? "" : ((n = e.textContent) == null ? void 0 : n.trim()) ?? ""),
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
      const n = this.ownerDocument.createElement("div");
      if (n.className = "blora-timeline__dot", e.icon ? (n.classList.add("blora-timeline__dot--icon"), n.append(I(e.icon, 14, this.ownerDocument))) : e.variant && (n.dataset.variant = e.variant), r.appendChild(n), e.nodes.length) {
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
function Si(a = customElements) {
  !a || a.get(qe) || a.define(qe, ma);
}
export {
  Ei as $,
  Xa as A,
  ja as B,
  Qa as C,
  Ja as D,
  Za as E,
  ti as F,
  ei as G,
  ri as H,
  ni as I,
  ai as J,
  ii as K,
  si as L,
  oi as M,
  li as N,
  ci as O,
  ui as P,
  di as Q,
  bi as R,
  hi as S,
  pi as T,
  mi as U,
  fi as V,
  gi as W,
  vi as X,
  Ai as Y,
  yi as Z,
  _i as _,
  Ea as a,
  se as a$,
  Ci as a0,
  wi as a1,
  xi as a2,
  ki as a3,
  Si as a4,
  ut as a5,
  gt as a6,
  ye as a7,
  ne as a8,
  Ut as a9,
  It as aA,
  Jt as aB,
  Vt as aC,
  Ht as aD,
  Xt as aE,
  qt as aF,
  Ct as aG,
  Bt as aH,
  Le as aI,
  vt as aJ,
  wt as aK,
  De as aL,
  Mt as aM,
  ge as aN,
  ve as aO,
  Dt as aP,
  Lt as aQ,
  Qt as aR,
  Tt as aS,
  xt as aT,
  Ot as aU,
  qe as aV,
  St as aW,
  Ft as aX,
  Ae as aY,
  Nt as aZ,
  oe as a_,
  _e as aa,
  Ee as ab,
  le as ac,
  de as ad,
  ie as ae,
  Ce as af,
  we as ag,
  Pt as ah,
  mt as ai,
  te as aj,
  At as ak,
  xe as al,
  Kt as am,
  yt as an,
  he as ao,
  me as ap,
  Yt as aq,
  zt as ar,
  ke as as,
  Rt as at,
  pe as au,
  fe as av,
  ae as aw,
  Se as ax,
  Ne as ay,
  jt as az,
  xa as b,
  $t as b0,
  cr as b1,
  na as b2,
  mn as b3,
  rn as b4,
  aa as b5,
  ia as b6,
  Bn as b7,
  On as b8,
  wn as b9,
  Mr as bA,
  Pe as bB,
  Or as bC,
  pa as bD,
  Oe as bE,
  _r as bF,
  ha as bG,
  Ge as bH,
  Wn as bI,
  Kn as bJ,
  Lr as bK,
  Tr as bL,
  ln as bM,
  Re as bN,
  xr as bO,
  Fe as bP,
  ma as bQ,
  Sr as bR,
  Yr as bS,
  ea as bT,
  Dr as bU,
  Nn as bV,
  qn as bW,
  ze as bX,
  Ka as bY,
  Ze as bZ,
  sa as ba,
  oa as bb,
  He as bc,
  or as bd,
  hn as be,
  pr as bf,
  ca as bg,
  an as bh,
  vr as bi,
  Rn as bj,
  Hn as bk,
  tn as bl,
  Qr as bm,
  ua as bn,
  Hr as bo,
  $n as bp,
  zn as bq,
  En as br,
  da as bs,
  ba as bt,
  We as bu,
  $e as bv,
  un as bw,
  Xr as bx,
  Ur as by,
  on as bz,
  ka as c,
  Ca as d,
  Sa as e,
  wa as f,
  Na as g,
  Da as h,
  La as i,
  qa as j,
  Ta as k,
  Ma as l,
  Ba as m,
  Ia as n,
  Oa as o,
  Pa as p,
  Ra as q,
  Ga as r,
  $a as s,
  Fa as t,
  Ha as u,
  Va as v,
  za as w,
  Ya as x,
  Wa as y,
  Ua as z
};
