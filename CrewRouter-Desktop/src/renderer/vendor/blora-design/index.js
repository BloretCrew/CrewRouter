import { B as ee, O as ae } from "./blora-element-Cn5j6OzD.js";
import { t as u } from "./i18n-Duo0HNK5.js";
import { a as ne, g as re, l as oe, b as se, e as ie, c as le, z as ce, r as de, s as ue } from "./i18n-Duo0HNK5.js";
import { i as S, c as C } from "./icons-PjqNgrW5.js";
import { a5 as v } from "./timeline-CM8btlTR.js";
import { a6 as Ae, a7 as fe, a8 as be, a9 as pe, aa as _e, ab as me, ac as Te, ad as Re, ae as Oe, af as Le, ag as Ee, ah as Ce, ai as ve, aj as ge, ak as he, al as Se, am as Ge, an as ye, ao as Ne, ap as Ie, aq as De, ar as Pe, as as Me, at as we, au as ke, av as xe, aw as qe, ax as Ue, ay as Fe, az as Ve, aA as Ke, aB as $e, aC as He, aD as We, aE as ze, aF as je, aG as Xe, aH as Ye, aI as Ze, aJ as Je, aK as Qe, aL as ea, aM as aa, aN as ta, aO as na, aP as ra, aQ as oa, aR as sa, aS as ia, aT as la, aU as ca, aV as da, aW as ua, aX as Ba, aY as Aa, aZ as fa, a_ as ba, a$ as pa, b0 as _a, b1 as ma, b2 as Ta, b3 as Ra, b4 as Oa, b5 as La, b6 as Ea, b7 as Ca, b8 as va, b9 as ga, ba as ha, bb as Sa, bc as Ga, bd as ya, be as Na, bf as Ia, bg as Da, bh as Pa, bi as Ma, bj as wa, bk as ka, bl as xa, bm as qa, bn as Ua, bo as Fa, bp as Va, bq as Ka, br as $a, bs as Ha, bt as Wa, bu as za, bv as ja, bw as Xa, bx as Ya, by as Za, bz as Ja, bA as Qa, bB as et, bC as at, bD as tt, bE as nt, bF as rt, bG as ot, bH as st, bI as it, bJ as lt, bK as ct, bL as dt, bM as ut, bN as Bt, bO as At, bP as ft, bQ as bt, bR as pt, bS as _t, bT as mt, bU as Tt, bV as Rt, bW as Ot, bX as Lt, d as Et, V as Ct, H as vt, A as gt, W as ht, X as St, M as Gt, N as yt, J as Nt, Y as It, Z as Dt, s as Pt, a as Mt, G as wt, b as kt, _ as xt, B as qt, c as Ut, O as Ft, Q as Vt, z as Kt, y as $t, $ as Ht, t as Wt, P as zt, R as jt, I as Xt, a0 as Yt, a1 as Zt, D as Jt, q as Qt, F as en, x as an, w as tn, C as nn, m as rn, e as on, p as sn, a3 as ln, f as cn, g as dn, a2 as un, o as Bn, S as An, T as fn, k as bn, l as pn, E as _n, n as mn, h as Tn, r as Rn, a4 as On, i as Ln, v as En, U as Cn, j as vn, K as gn, L as hn, u as Sn, bY as Gn, bZ as yn } from "./timeline-CM8btlTR.js";
import { w as _ } from "./dialog-D8W4uPbO.js";
import { B as In, a as Dn, d as Pn } from "./dialog-D8W4uPbO.js";
import { BLORA_SELECT_TAG as wn, BloraSelect as kn, defineBloraSelect as xn } from "./components/select/index.js";
import { createTableController as Un } from "./components/table/index.js";
import { enhanceButtons as Vn, setButtonLoading as Kn } from "./components/button/index.js";
import { r as Hn } from "./icons-registry-BEZgQ6x-.js";
function G(e) {
  const a = e.replace(/\s+/g, "");
  return a ? typeof Intl < "u" && "Segmenter" in Intl ? [...new Intl.Segmenter(void 0, { granularity: "grapheme" }).segment(a)].length : [...a].length : 0;
}
function y(e) {
  const a = e.getAttribute("data-variant");
  if (a === "dot" || a === "pill") {
    e.getAttribute("data-shape") === "circle" && e.removeAttribute("data-shape");
    return;
  }
  const t = [...e.childNodes].filter((r) => r.nodeType === Node.TEXT_NODE).map((r) => r.textContent ?? "").join(""), n = G(t), o = !!e.querySelector(":scope > svg");
  n === 1 && !o ? e.setAttribute("data-shape", "circle") : n > 1 ? e.setAttribute("data-shape", "pill") : e.getAttribute("data-shape") === "circle" && e.removeAttribute("data-shape");
}
function H(e = document) {
  typeof document > "u" || e.querySelectorAll(".blora-badge").forEach((a) => {
    const t = a.getAttribute("data-icon");
    if (t && S(t) && !a.querySelector(":scope > svg[data-blora-icon]")) {
      const n = C(t, 12, a.ownerDocument);
      n.dataset.bloraIcon = t, a.getAttribute("data-icon-position") === "end" ? a.append(n) : a.prepend(n);
    }
    y(a);
  });
}
const m = "blora-message-container";
function N(e) {
  return e === "error" || e === "danger" ? "danger" : e === "success" || e === "warning" || e === "info" ? e : "info";
}
function I(e) {
  let a = e.querySelector(`.${m}`);
  return a || (a = e.createElement("div"), a.className = `${m} blora-portal`, a.setAttribute("data-blora-message-root", ""), (e.body || e.documentElement).appendChild(a)), a;
}
function D(e, a, t) {
  const n = e.createElement("span");
  n.className = "blora-message__icon", n.setAttribute("aria-hidden", "true"), n.appendChild(v(e, t, 16)), a.appendChild(n);
}
function P(e, a = document) {
  const t = typeof e == "string" ? { content: e } : e || {}, n = N(t.type), o = a.createElement("span");
  o.className = "blora-message", o.setAttribute("data-variant", n), o.setAttribute("role", "status"), D(a, o, n);
  const r = a.createElement("span");
  return r.className = "blora-message__content", r.textContent = (t.content ?? t.message ?? "").trim(), o.appendChild(r), o;
}
function b(e) {
  if (typeof document > "u") return null;
  const a = document, t = I(a), n = P(e, a);
  t.appendChild(n);
  let o = !1;
  const r = () => {
    o || (o = !0, n.classList.add("is-leaving"), _(n, () => {
      n.remove(), t.childElementCount === 0 && t.remove();
    }));
  }, i = e.duration == null ? 3e3 : e.duration;
  return i > 0 && window.setTimeout(r, i), { close: r, el: n };
}
function M(e) {
  return b(typeof e == "string" ? { content: e } : e || {});
}
function f(e) {
  return (a, t) => {
    const n = { content: a, type: e };
    return t !== void 0 && (n.duration = t), b(n);
  };
}
const W = Object.assign(M, {
  open: (e) => b(e || {}),
  success: f("success"),
  info: f("info"),
  warning: f("warning"),
  danger: f("danger"),
  error: f("danger")
});
function T(e) {
  return Array.from(e.querySelectorAll(".blora-field, [data-blora-field]"));
}
function R(e) {
  return e.querySelector(
    "input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select"
  );
}
function O(e) {
  return e.querySelector(".blora-field__error, [data-blora-error]");
}
function B(e, a) {
  if (a) {
    e.setAttribute("data-state", "invalid");
    const t = O(e);
    t && (t.hidden = !1, t.textContent = a);
  } else {
    e.removeAttribute("data-state");
    const t = O(e);
    t && (t.hidden = !0, t.textContent = "");
  }
}
function L(e) {
  return e.validity.valueMissing ? e.getAttribute("data-blora-required-message") || u("validate.required") : e.validity.typeMismatch || e.validity.patternMismatch ? e.getAttribute("data-blora-pattern-message") || u("validate.pattern") : e.validity.tooShort ? u("validate.minlength", { n: e.getAttribute("minlength") ?? "" }) : e.validity.tooLong ? u("validate.maxlength", { n: e.getAttribute("maxlength") ?? "" }) : e.validationMessage || u("validate.invalid");
}
function E(e) {
  const a = {}, t = new FormData(e);
  return t.forEach((n, o) => {
    const r = a[o], i = String(n);
    r === void 0 ? a[o] = i : Array.isArray(r) ? r.push(i) : a[o] = [r, i];
  }), e.querySelectorAll('input[type="checkbox"][name]').forEach((n) => {
    t.has(n.name) || (a[n.name] = n.checked);
  }), a;
}
function z(e) {
  if (typeof document > "u")
    return {
      validate: () => ({ valid: !0, errors: [], values: {} }),
      getValues: () => ({}),
      clearErrors: () => {
      },
      destroy: () => {
      }
    };
  e.classList.add("blora-form"), e.hasAttribute("data-blora-native-validate") || e.setAttribute("novalidate", "");
  const a = () => {
    T(e).forEach((s) => B(s, null));
  }, t = () => {
    const s = [];
    T(e).forEach((c) => {
      const d = R(c);
      if (!d || d.disabled) {
        B(c, null);
        return;
      }
      const h = c.getAttribute("data-blora-validate");
      let p = d.checkValidity(), A = "";
      h === "email" && d.value && (p = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.value), p || (A = d.getAttribute("data-blora-pattern-message") || u("validate.email"))), p ? (B(c, null), c.setAttribute("data-state", "valid")) : (A = A || L(d), B(c, A), s.push({ name: d.name || "", message: A, field: c }));
    });
    const l = E(e);
    return { valid: s.length === 0, errors: s, values: l };
  }, n = (s) => {
    e.hasAttribute("data-blora-native-validate") || s.preventDefault();
  }, o = (s) => {
    const l = t();
    if (!l.valid) {
      s.preventDefault(), s.stopPropagation();
      return;
    }
    e.dispatchEvent(
      new CustomEvent("blora-form-submit", {
        bubbles: !0,
        detail: { values: l.values, form: e }
      })
    ), e.hasAttribute("data-blora-native-submit") || s.preventDefault();
  }, r = String(e.getAttribute("data-blora-validate-on") || "submit").split(/[\s,]+/).filter(Boolean), i = (s) => {
    if (!r.includes("blur")) return;
    const l = s.target.closest(
      ".blora-field, [data-blora-field]"
    );
    if (!l || !e.contains(l)) return;
    const c = R(l);
    c && (c.checkValidity() ? B(l, null) : B(l, L(c)));
  };
  return e.addEventListener("invalid", n, !0), e.addEventListener("submit", o), r.includes("blur") && e.addEventListener("focusout", i), {
    validate: t,
    getValues: () => E(e),
    clearErrors: a,
    destroy() {
      e.removeEventListener("invalid", n, !0), e.removeEventListener("submit", o), e.removeEventListener("focusout", i);
    }
  };
}
const g = {
  "top-right": "blora-notify-container--top-right",
  "top-left": "blora-notify-container--top-left",
  "bottom-right": "blora-notify-container--bottom-right",
  "bottom-left": "blora-notify-container--bottom-left"
};
function w(e) {
  return e === "error" || e === "danger" ? "danger" : e === "success" || e === "warning" || e === "info" ? e : "info";
}
function k(e, a) {
  const t = g[a];
  let n = e.querySelector(`.blora-notify-container.${t}`);
  return n || (n = e.createElement("div"), n.className = `blora-notify-container ${t} blora-portal`, n.setAttribute("data-placement", a), (e.body || e.documentElement).appendChild(n)), n;
}
function x(e, a, t) {
  const n = e.createElement("span");
  n.className = "blora-notification__icon", n.setAttribute("aria-hidden", "true"), n.appendChild(v(e, t, 22)), a.appendChild(n);
}
function q(e, a) {
  const t = e.createElement("button");
  return t.type = "button", t.className = "blora-notification__close", t.setAttribute("aria-label", u("common.close")), t.appendChild(C("close", 16, e)), a.appendChild(t), t;
}
function U(e, a = document) {
  const t = typeof e == "string" ? { title: e } : e || {}, n = w(t.type), o = a.createElement("div");
  o.className = "blora-notification", o.setAttribute("data-variant", n), o.setAttribute("role", "status"), x(a, o, n);
  const r = a.createElement("div");
  r.className = "blora-notification__body";
  const i = a.createElement("div");
  if (i.className = "blora-notification__title", i.textContent = t.title || t.description || "", r.appendChild(i), t.description && t.title) {
    const s = a.createElement("div");
    s.className = "blora-notification__desc", s.textContent = t.description, r.appendChild(s);
  }
  return o.appendChild(r), q(a, o), o;
}
function j(e) {
  var l;
  if (typeof document > "u") return null;
  const a = typeof e == "string" ? { title: e } : e || {}, t = a.placement && g[a.placement] ? a.placement : "top-right", n = document, o = k(n, t), r = U(a, n), i = () => {
    r.classList.add("is-leaving"), _(r, () => r.remove());
  };
  (l = r.querySelector(".blora-notification__close")) == null || l.addEventListener("click", i), o.appendChild(r);
  const s = a.duration == null ? 4500 : a.duration;
  return s > 0 && setTimeout(i, s), { close: i, el: r };
}
function X(e) {
  const a = e.querySelector(".blora-notification__close, [data-blora-close]");
  if (!a) return { destroy: () => {
  } };
  const t = () => {
    e.classList.add("is-leaving"), e.dispatchEvent(new CustomEvent("blora-notification-close", { bubbles: !0 })), _(e, () => e.remove());
  };
  return a.addEventListener("click", t), {
    destroy() {
      a.removeEventListener("click", t);
    }
  };
}
const Y = "2.0.8";
function Z() {
  return typeof window < "u" && typeof document < "u";
}
export {
  Ae as BLORA_ACCORDION_TAG,
  fe as BLORA_ALERT_TAG,
  be as BLORA_AUTOCOMPLETE_TAG,
  pe as BLORA_BACKTOP_TAG,
  _e as BLORA_BANNER_TAG,
  me as BLORA_BREADCRUMB_TAG,
  Te as BLORA_CALENDAR_TAG,
  Re as BLORA_CAROUSEL_TAG,
  Oe as BLORA_CASCADER_TAG,
  Le as BLORA_CHART_CONTAINER_TAG,
  Ee as BLORA_CHAT_TAG,
  Ce as BLORA_CHECKBOX_TAG,
  ve as BLORA_COLLAPSE_TAG,
  ge as BLORA_COLOR_PICKER_TAG,
  he as BLORA_COMMAND_TAG,
  Se as BLORA_COMMENT_TAG,
  Ge as BLORA_COPY_TAG,
  ye as BLORA_DATEPICKER_TAG,
  Ne as BLORA_DECK_TAG,
  In as BLORA_DIALOG_TAG,
  Ie as BLORA_DOCK_TAG,
  De as BLORA_DRAWER_TAG,
  Pe as BLORA_DROPDOWN_TAG,
  Me as BLORA_EMPTY_TAG,
  we as BLORA_FIELD_TAG,
  ke as BLORA_IMAGE_TAG,
  xe as BLORA_MEGAMENU_TAG,
  qe as BLORA_MENTIONS_TAG,
  Ue as BLORA_MOCKUP_TAG,
  Fe as BLORA_NAVBAR_TAG,
  Ve as BLORA_NUMBER_INPUT_TAG,
  Ke as BLORA_OTP_TAG,
  $e as BLORA_PAGINATION_TAG,
  He as BLORA_POPCONFIRM_TAG,
  We as BLORA_POPOVER_TAG,
  ze as BLORA_PROGRESS_TAG,
  je as BLORA_RADIO_TAG,
  Xe as BLORA_RANGE_TAG,
  Ye as BLORA_RATE_TAG,
  Ze as BLORA_RESULT_TAG,
  Je as BLORA_SEARCH_TAG,
  Qe as BLORA_SEGMENTED_TAG,
  wn as BLORA_SELECT_TAG,
  ea as BLORA_SIDEBAR_NAV_TAG,
  aa as BLORA_SLIDER_TAG,
  ta as BLORA_SPEED_DIAL_TAG,
  na as BLORA_SPLITTER_TAG,
  ra as BLORA_STATISTIC_TAG,
  oa as BLORA_STEPS_TAG,
  sa as BLORA_SWAP_TAG,
  ia as BLORA_SWITCH_TAG,
  la as BLORA_TABS_TAG,
  ca as BLORA_TAGS_INPUT_TAG,
  da as BLORA_TIMELINE_TAG,
  ua as BLORA_TIMEPICKER_TAG,
  Ba as BLORA_TOOLTIP_TAG,
  Aa as BLORA_TOUR_TAG,
  fa as BLORA_TRANSFER_TAG,
  ba as BLORA_TREE_SELECT_TAG,
  pa as BLORA_TREE_TAG,
  _a as BLORA_UPLOAD_TAG,
  ma as BloraAccordion,
  Ta as BloraAlert,
  Ra as BloraAutocomplete,
  Oa as BloraBacktop,
  La as BloraBanner,
  Ea as BloraBreadcrumb,
  Ca as BloraCalendar,
  va as BloraCarousel,
  ga as BloraCascader,
  ha as BloraChartContainer,
  Sa as BloraChat,
  Ga as BloraCheckbox,
  ya as BloraCollapse,
  Na as BloraColorPicker,
  Ia as BloraCommand,
  Da as BloraComment,
  Pa as BloraCopy,
  Ma as BloraDatepicker,
  wa as BloraDeck,
  Dn as BloraDialog,
  ka as BloraDock,
  xa as BloraDrawer,
  qa as BloraDropdown,
  ee as BloraElement,
  Ua as BloraEmpty,
  Fa as BloraField,
  Va as BloraImage,
  Ka as BloraMegamenu,
  $a as BloraMentions,
  Ha as BloraMockup,
  Wa as BloraNavbar,
  za as BloraNumberInput,
  ja as BloraOtp,
  Xa as BloraPagination,
  Ya as BloraPopconfirm,
  Za as BloraPopover,
  Ja as BloraProgress,
  Qa as BloraRadio,
  et as BloraRange,
  at as BloraRate,
  tt as BloraResult,
  nt as BloraSearch,
  rt as BloraSegmented,
  kn as BloraSelect,
  ot as BloraSidebarNav,
  st as BloraSlider,
  it as BloraSpeedDial,
  lt as BloraSplitter,
  ct as BloraStatistic,
  dt as BloraSteps,
  ut as BloraSwap,
  Bt as BloraSwitch,
  At as BloraTabs,
  ft as BloraTagsInput,
  bt as BloraTimeline,
  pt as BloraTimepicker,
  _t as BloraTooltip,
  mt as BloraTour,
  Tt as BloraTransfer,
  Rt as BloraTree,
  Ot as BloraTreeSelect,
  Lt as BloraUpload,
  ae as OverlayController,
  Y as VERSION,
  ne as applyDocumentLocale,
  C as createBloraIcon,
  z as createFormController,
  P as createMessageElement,
  X as createNotificationController,
  U as createNotificationElement,
  Un as createTableController,
  Et as defineBloraAccordion,
  Ct as defineBloraAlert,
  vt as defineBloraAutocomplete,
  gt as defineBloraBacktop,
  ht as defineBloraBanner,
  St as defineBloraBreadcrumb,
  Gt as defineBloraCalendar,
  yt as defineBloraCarousel,
  Nt as defineBloraCascader,
  It as defineBloraChartContainer,
  Dt as defineBloraChat,
  Pt as defineBloraCheckbox,
  Mt as defineBloraCollapse,
  wt as defineBloraColorPicker,
  kt as defineBloraCommand,
  xt as defineBloraComment,
  qt as defineBloraCopy,
  Ut as defineBloraDatepicker,
  Ft as defineBloraDeck,
  Pn as defineBloraDialog,
  Vt as defineBloraDock,
  Kt as defineBloraDrawer,
  $t as defineBloraDropdown,
  Ht as defineBloraEmpty,
  Wt as defineBloraField,
  zt as defineBloraImage,
  jt as defineBloraMegamenu,
  Xt as defineBloraMentions,
  Yt as defineBloraMockup,
  Zt as defineBloraNavbar,
  Jt as defineBloraNumberInput,
  Qt as defineBloraOtp,
  en as defineBloraPagination,
  an as defineBloraPopconfirm,
  tn as defineBloraPopover,
  nn as defineBloraProgress,
  rn as defineBloraRadio,
  on as defineBloraRange,
  sn as defineBloraRate,
  ln as defineBloraResult,
  cn as defineBloraSearch,
  dn as defineBloraSegmented,
  xn as defineBloraSelect,
  un as defineBloraSidebarNav,
  Bn as defineBloraSlider,
  An as defineBloraSpeedDial,
  fn as defineBloraSplitter,
  bn as defineBloraStatistic,
  pn as defineBloraSteps,
  _n as defineBloraSwap,
  mn as defineBloraSwitch,
  Tn as defineBloraTabs,
  Rn as defineBloraTagsInput,
  On as defineBloraTimeline,
  Ln as defineBloraTimepicker,
  En as defineBloraTooltip,
  Cn as defineBloraTour,
  vn as defineBloraTransfer,
  gn as defineBloraTree,
  hn as defineBloraTreeSelect,
  Sn as defineBloraUpload,
  H as enhanceBadges,
  Vn as enhanceButtons,
  E as getFormValues,
  re as getLocale,
  Gn as initBackTop,
  S as isBloraIconName,
  Z as isBrowser,
  oe as localeCollator,
  se as localeDow,
  ie as localeEn,
  le as localeMonths,
  ce as localeZhCN,
  W as message,
  j as notify,
  yn as openImagePreview,
  Hn as registerBloraIcons,
  de as registerLocale,
  Kn as setButtonLoading,
  ue as setLocale,
  u as t
};
