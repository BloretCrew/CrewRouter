var h = Object.defineProperty;
var v = (l, c, t) => c in l ? h(l, c, { enumerable: !0, configurable: !0, writable: !0, value: t }) : l[c] = t;
var i = (l, c, t) => v(l, typeof c != "symbol" ? c + "" : c, t);
import { B as _, O as g } from "../../blora-element-Cn5j6OzD.js";
import { t as u } from "../../i18n-Duo0HNK5.js";
const m = '.blora-tag{display:inline-flex;align-items:center;gap:.3em;padding:.2em .7em;font-size:var(--blora-text-xs);font-weight:500;background:var(--blora-color-surface-sunken);color:var(--blora-color-text-emphasis);border:1px solid var(--blora-color-border-subtle);border-radius:var(--blora-radius-full);line-height:1.25;box-sizing:border-box;vertical-align:middle}.blora-tag[data-variant=primary]{background:var(--blora-color-action-primary-tint);color:var(--blora-color-text-emphasis);border-color:color-mix(in srgb,var(--blora-color-action-primary-default) 25%,transparent)}.blora-tag[data-variant=neutral]{background:color-mix(in srgb,var(--blora-color-status-neutral) 8%,transparent);color:var(--blora-color-text-emphasis);border-color:color-mix(in srgb,var(--blora-color-status-neutral) 25%,transparent)}.blora-tag[data-variant=info]{background:color-mix(in srgb,var(--blora-color-status-info) 8%,transparent);color:var(--blora-color-text-emphasis);border-color:color-mix(in srgb,var(--blora-color-status-info) 25%,transparent)}.blora-tag[data-variant=success]{background:color-mix(in srgb,var(--blora-color-status-success) 8%,transparent);color:var(--blora-color-text-emphasis);border-color:color-mix(in srgb,var(--blora-color-status-success) 25%,transparent)}.blora-tag[data-variant=warning]{background:color-mix(in srgb,var(--blora-color-status-warning) 10%,transparent);color:var(--blora-color-text-emphasis);border-color:color-mix(in srgb,var(--blora-color-status-warning) 30%,transparent)}.blora-tag--removable{padding-inline-end:.35em}.blora-tag__close{position:relative;width:1em;height:1em;flex:none;border-radius:50%;cursor:pointer;border:none;background:none;transition:background var(--blora-duration-fast) var(--blora-easing-standard)}.blora-tag__close:before,.blora-tag__close:after{content:"";position:absolute;top:50%;inset-inline-start:50%;width:.65em;height:1.5px;background:currentcolor;border-radius:1px;transform:translate(-50%,-50%) rotate(45deg)}.blora-tag__close:after{transform:translate(-50%,-50%) rotate(-45deg)}.blora-tag__close:hover{background:color-mix(in srgb,var(--blora-color-text-primary) 15%,transparent)}', f = ':host{display:inline-block;position:relative}:host([disabled]){opacity:.5;pointer-events:none}.blora-select__trigger{width:100%;min-height:calc(.6em * 2 + var(--blora-text-sm, .875rem) * 1.4);padding:.6em 2.4em .6em .85em;font-size:var(--blora-text-sm);line-height:1.4;color:var(--blora-color-text-secondary);background:var(--blora-color-surface-default);border:1px solid var(--blora-color-border-subtle);border-radius:var(--blora-radius-lg);cursor:pointer;position:relative;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:border-color var(--blora-duration-fast) var(--blora-easing-standard),box-shadow var(--blora-duration-fast) var(--blora-easing-standard),background-color var(--blora-duration-fast) var(--blora-easing-standard),color var(--blora-duration-fast) var(--blora-easing-standard),opacity var(--blora-duration-fast) var(--blora-easing-standard),transform var(--blora-duration-fast) var(--blora-easing-standard)}@supports (corner-shape: superellipse(1.2)){.blora-select__trigger{corner-shape:superellipse(1.2)}}.blora-select__value{display:inline-block;vertical-align:middle;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}:host([multiple]) .blora-select__trigger{display:flex;flex-wrap:wrap;align-items:center;height:auto;overflow:visible;white-space:normal;text-overflow:unset;padding-block:.35em}.blora-select__tags{display:flex;flex-wrap:wrap;align-items:center;gap:var(--blora-space-2);max-width:calc(100% - 1.5em);overflow:visible;text-overflow:unset;white-space:normal}.blora-select__tags .blora-tag{max-width:100%}.blora-select__trigger:hover{border-color:var(--blora-color-text-subtle)}.blora-select__trigger[aria-expanded=true]{border-color:var(--blora-color-action-primary-default);box-shadow:var(--blora-focus-ring-default)}.blora-select__trigger:after{content:"";position:absolute;inset-inline-end:.85em;top:50%;width:0;height:0;border-inline-start:4px solid transparent;border-inline-end:4px solid transparent;border-block-start:5px solid var(--blora-color-text-subtle);transform:translateY(-50%);transition:transform var(--blora-duration-fast) var(--blora-easing-standard)}.blora-select__trigger[aria-expanded=true]:after{transform:translateY(-50%) rotate(180deg)}.blora-select__trigger[data-placeholder]{color:var(--blora-color-text-disabled)}.blora-select__popup{position:absolute;inset-block-start:calc(100% + 4px);inset-inline:0;max-height:var(--blora-select-popup-max-height, 240px);overflow-y:auto;background:var(--blora-color-surface-default);border:var(--blora-border-subtle);border-radius:var(--blora-radius-lg);box-shadow:var(--blora-shadow-3);padding:var(--blora-space-1);z-index:var(--blora-z-dropdown);opacity:0;pointer-events:none;transform:translateY(-4px);transition:border-color var(--blora-duration-fast) var(--blora-easing-standard),box-shadow var(--blora-duration-fast) var(--blora-easing-standard),background-color var(--blora-duration-fast) var(--blora-easing-standard),color var(--blora-duration-fast) var(--blora-easing-standard),opacity var(--blora-duration-fast) var(--blora-easing-standard),transform var(--blora-duration-fast) var(--blora-easing-standard)}.blora-select__popup[data-open]{opacity:1;pointer-events:auto;transform:translateY(0)}.blora-select__listbox{max-height:min(14rem,40vh);overflow-y:auto}.blora-select__option{padding:.5em .8em;font-size:var(--blora-text-sm);color:var(--blora-color-text-emphasis);border-radius:var(--blora-radius-sm);cursor:pointer;white-space:nowrap;transition:border-color var(--blora-duration-fast) var(--blora-easing-standard),box-shadow var(--blora-duration-fast) var(--blora-easing-standard),background-color var(--blora-duration-fast) var(--blora-easing-standard),color var(--blora-duration-fast) var(--blora-easing-standard),opacity var(--blora-duration-fast) var(--blora-easing-standard),transform var(--blora-duration-fast) var(--blora-easing-standard)}.blora-select__option:hover,.blora-select__option[data-active]{background:var(--blora-color-surface-raised);color:var(--blora-color-text-primary)}.blora-select__option[data-selected]{background:var(--blora-color-action-primary-tint);color:var(--blora-color-action-primary-default);font-weight:500}.blora-select__option[data-disabled]{color:var(--blora-color-text-disabled);cursor:not-allowed}.blora-select__option[data-disabled]:hover{background:none}.blora-select__empty{padding:.65em .8em;font-size:var(--blora-text-xs);color:var(--blora-color-text-subtle)}', b = "blora-select";
class p extends _ {
  constructor() {
    super(...arguments);
    i(this, "_internals", null);
    i(this, "_overlay", null);
    i(this, "_isOpen", !1);
    i(this, "_activeIndex", -1);
    i(this, "_options", []);
    i(this, "_value", "");
    i(this, "_values", []);
    // Shadow DOM refs
    i(this, "_trigger", null);
    i(this, "_popup", null);
    i(this, "_listbox", null);
    i(this, "_optionObserver", null);
  }
  static get observedAttributes() {
    return ["value", "disabled", "required", "placeholder", "multiple", "max-tag-count"];
  }
  attributeChangedCallback(t, e, a) {
    var r;
    this.isConnectedInternal && (t === "value" ? (this._value = a, this._values = this.multiple ? a.split(",").map((o) => o.trim()).filter(Boolean) : a ? [a] : [], this._updateDisplay(), typeof ((r = this._internals) == null ? void 0 : r.setFormValue) == "function" && this._internals.setFormValue(a), this._renderOptions()) : (t === "multiple" || t === "max-tag-count") && (t === "multiple" && (this._values = this.multiple ? this._value.split(",").map((o) => o.trim()).filter(Boolean) : this._value ? [this._value] : []), this._renderOptions(), this._updateDisplay()));
  }
  render() {
    if (this._value = this.getAttribute("value") ?? "", this._values = this.multiple ? this._value.split(",").map((d) => d.trim()).filter(Boolean) : this._value ? [this._value] : [], this.shadowRoot) return;
    const t = this.attachShadow({ mode: "open" }), e = document.createElement("style");
    e.textContent = `${m}
${f}`, t.appendChild(e);
    const a = document.createElement("button");
    a.type = "button", a.className = "blora-select__trigger", a.setAttribute("part", "trigger"), a.setAttribute("role", "combobox"), a.setAttribute("aria-expanded", "false"), a.setAttribute("aria-haspopup", "listbox");
    const r = document.createElement("span");
    r.className = "blora-select__value", r.setAttribute("part", "value"), a.appendChild(r);
    const o = document.createElement("div");
    o.className = "blora-select__popup", o.setAttribute("part", "popup"), o.setAttribute("role", "listbox"), this.multiple && o.setAttribute("aria-multiselectable", "true");
    const s = document.createElement("div");
    s.className = "blora-select__listbox", s.setAttribute("part", "listbox"), o.appendChild(s);
    const n = document.createElement("slot");
    n.style.display = "none", t.appendChild(n), t.appendChild(a), t.appendChild(o), this._trigger = a, this._popup = o, this._listbox = s, typeof this.attachInternals == "function" && (this._internals = this.attachInternals()), this._initOptions();
  }
  bindEvents() {
    !this._trigger || !this._popup || (this.listen(this._trigger, "click", () => {
      this._isOpen ? this.close("trigger-click") : this.open();
    }), this.listen(this._trigger, "keydown", (t) => {
      this._onKeyDown(t);
    }), this.listen(this._popup, "pointerdown", (t) => {
      var r;
      const e = t.target, a = (r = e.closest) == null ? void 0 : r.call(e, ".blora-select__option");
      if (a && !a.hasAttribute("data-disabled")) {
        const o = Number(a.dataset.index);
        this._selectIndex(o), this.multiple || this.close("option-click");
      }
    }));
  }
  // Public API
  get value() {
    return this._value;
  }
  set value(t) {
    this.setAttribute("value", t);
  }
  get multiple() {
    return this.hasAttribute("multiple");
  }
  get values() {
    return [...this._values];
  }
  get selectedOptions() {
    return this._options.filter((t) => this._values.includes(t.value));
  }
  get options() {
    return this._options;
  }
  open() {
    var e, a;
    this._isOpen || this.hasAttribute("disabled") || !this.emit(
      "blora-before-open",
      { source: "api", reason: "open" },
      { cancelable: !0 }
    ) || (this._isOpen = !0, (e = this._trigger) == null || e.setAttribute("aria-expanded", "true"), (a = this._popup) == null || a.setAttribute("data-open", ""), this._activeIndex = this._options.findIndex((r) => this._values.includes(r.value)), this._updateActiveOption(), this._popup && (this._overlay = new g(this._popup, {
      modal: !1,
      closeOnEscape: !0,
      closeOnOutsidePointer: !1,
      restoreFocus: !0,
      trapFocus: !1,
      lockScroll: !1
    }), this._overlay.open()), this.emit("blora-open", { source: "api", reason: "open" }));
  }
  close(t = "api") {
    var a, r, o;
    !this._isOpen || !this.emit(
      "blora-before-close",
      { source: "api", reason: t },
      { cancelable: !0 }
    ) || (this._isOpen = !1, (a = this._trigger) == null || a.setAttribute("aria-expanded", "false"), (r = this._popup) == null || r.removeAttribute("data-open"), (o = this._overlay) == null || o.close(), this._overlay = null, this.emit("blora-close", { source: "api", reason: t }));
  }
  focus() {
    var t;
    (t = this._trigger) == null || t.focus();
  }
  checkValidity() {
    return this._internals ? this._internals.checkValidity() : !0;
  }
  reportValidity() {
    return this._internals ? this._internals.reportValidity() : !0;
  }
  setCustomValidity(t) {
    var e;
    (e = this._internals) == null || e.setValidity({ customError: !!t }, t);
  }
  // Internal methods
  _collectOptions() {
    const t = this.querySelectorAll("blora-option");
    this._options = Array.from(t).map((e) => {
      const a = e;
      return {
        value: a.getAttribute("value") ?? a.textContent ?? "",
        label: a.textContent ?? "",
        disabled: a.hasAttribute("disabled")
      };
    }), this._renderOptions(), this._updateDisplay();
  }
  _renderOptions() {
    if (!this._listbox) return;
    if (this._listbox.querySelectorAll(".blora-select__option, .blora-select__empty").forEach((e) => e.remove()), this._options.length === 0) {
      const e = document.createElement("div");
      e.className = "blora-select__empty", e.textContent = u("select.empty"), this._listbox.appendChild(e);
      return;
    }
    this._options.forEach((e, a) => {
      const r = document.createElement("div");
      r.className = "blora-select__option", r.setAttribute("part", "option"), r.setAttribute("role", "option"), r.dataset.index = String(a), r.dataset.value = e.value, r.textContent = e.label, e.disabled && (r.setAttribute("data-disabled", ""), r.setAttribute("aria-disabled", "true")), this._values.includes(e.value) && (r.setAttribute("data-selected", ""), r.setAttribute("aria-selected", "true")), this._listbox.appendChild(r);
    });
  }
  _updateDisplay() {
    if (!this._trigger) return;
    const t = this._trigger.querySelector(".blora-select__value");
    if (!t) return;
    const e = this.selectedOptions;
    if (t.replaceChildren(), e.length > 0 && this.multiple) {
      t.classList.add("blora-select__tags");
      const a = Number(this.getAttribute("max-tag-count") ?? "2"), r = Number.isFinite(a) ? Math.max(0, a) : 2;
      if (e.slice(0, r).forEach((o) => {
        const s = document.createElement("span");
        s.className = "blora-tag blora-tag--removable", s.dataset.variant = "primary", s.setAttribute("part", "tag"), s.appendChild(document.createTextNode(o.label));
        const n = document.createElement("button");
        n.type = "button", n.className = "blora-tag__close", n.setAttribute("part", "tag-remove"), n.setAttribute("aria-label", u("select.remove", { label: o.label })), n.addEventListener("pointerdown", (d) => {
          d.preventDefault(), d.stopPropagation(), this._toggleValue(o.value);
        }), s.appendChild(n), t.appendChild(s);
      }), e.length > r) {
        const o = document.createElement("span");
        o.className = "blora-tag", o.dataset.variant = "primary", o.textContent = u("select.more", { n: e.length - r }), t.appendChild(o);
      }
      this._trigger.removeAttribute("data-placeholder");
    } else if (e[0])
      t.classList.remove("blora-select__tags"), t.textContent = e[0].label, this._trigger.removeAttribute("data-placeholder");
    else {
      t.classList.remove("blora-select__tags");
      const a = this.getAttribute("placeholder") ?? "";
      t.textContent = a || " ", a ? this._trigger.setAttribute("data-placeholder", "") : this._trigger.removeAttribute("data-placeholder");
    }
  }
  _selectIndex(t) {
    var r;
    const e = this._options[t];
    if (!e || e.disabled) return;
    if (this.multiple) {
      this._toggleValue(e.value);
      return;
    }
    const a = this._value;
    this._value = e.value, this.setAttribute("value", e.value), typeof ((r = this._internals) == null ? void 0 : r.setFormValue) == "function" && this._internals.setFormValue(e.value), this._renderOptions(), this._updateDisplay(), a !== e.value && (this.dispatchEvent(new Event("input", { bubbles: !0, composed: !0 })), this.dispatchEvent(new Event("change", { bubbles: !0, composed: !0 })));
  }
  _toggleValue(t) {
    var r;
    const e = this._values.includes(t) ? this._values.filter((o) => o !== t) : [...this._values, t], a = e.join(",");
    a !== this._value && (this._values = e, this._value = a, this.setAttribute("value", a), (r = this._internals) == null || r.setFormValue(a), this._renderOptions(), this._updateDisplay(), this.dispatchEvent(new Event("input", { bubbles: !0, composed: !0 })), this.dispatchEvent(new Event("change", { bubbles: !0, composed: !0 })));
  }
  _updateActiveOption() {
    if (!this._listbox) return;
    this._listbox.querySelectorAll(".blora-select__option").forEach((e, a) => {
      a === this._activeIndex ? (e.setAttribute("data-active", ""), e.scrollIntoView({ block: "nearest" })) : e.removeAttribute("data-active");
    }), this._trigger && this._activeIndex >= 0 && this._trigger.setAttribute("aria-activedescendant", `select-option-${this._activeIndex}`);
  }
  _onKeyDown(t) {
    if (!this.hasAttribute("disabled"))
      switch (t.key) {
        case "ArrowDown":
          t.preventDefault(), this._isOpen ? (this._activeIndex = Math.min(this._activeIndex + 1, this._options.length - 1), this._skipDisabled(1), this._updateActiveOption()) : this.open();
          break;
        case "ArrowUp":
          t.preventDefault(), this._isOpen && (this._activeIndex = Math.max(this._activeIndex - 1, 0), this._skipDisabled(-1), this._updateActiveOption());
          break;
        case "Home":
          this._isOpen && (t.preventDefault(), this._activeIndex = 0, this._skipDisabled(1), this._updateActiveOption());
          break;
        case "End":
          this._isOpen && (t.preventDefault(), this._activeIndex = this._options.length - 1, this._skipDisabled(-1), this._updateActiveOption());
          break;
        case "Enter":
          this._isOpen && this._activeIndex >= 0 && (t.preventDefault(), this._selectIndex(this._activeIndex), this.multiple || this.close("enter"));
          break;
        case "Escape":
          this._isOpen && (t.preventDefault(), this.close("escape"));
          break;
        case "Tab":
          this._isOpen && this.close("tab");
          break;
      }
  }
  _skipDisabled(t) {
    var e;
    for (; this._activeIndex >= 0 && this._activeIndex < this._options.length && ((e = this._options[this._activeIndex]) != null && e.disabled); )
      this._activeIndex += t;
    this._activeIndex < 0 && (this._activeIndex = 0), this._activeIndex >= this._options.length && (this._activeIndex = this._options.length - 1);
  }
  onDisconnect() {
    var t;
    (t = this._overlay) == null || t.destroy(), this._overlay = null, this._isOpen = !1;
  }
  // Called by connectedCallback to collect initial options
  _initOptions() {
    var e;
    this._collectOptions();
    const t = (e = this.shadowRoot) == null ? void 0 : e.querySelector("slot");
    t == null || t.addEventListener("slotchange", () => this._collectOptions()), !this._optionObserver && (this._optionObserver = new MutationObserver(() => this._collectOptions()), this._optionObserver.observe(this, {
      childList: !0,
      subtree: !0,
      attributes: !0,
      attributeFilter: ["value", "disabled"]
    }));
  }
}
i(p, "formAssociated", !0);
function A(l = customElements) {
  !l || l.get(b) || l.define(b, p);
}
export {
  b as BLORA_SELECT_TAG,
  p as BloraSelect,
  A as defineBloraSelect
};
