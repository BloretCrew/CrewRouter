import { B as X, O as Z } from "./blora-element-Cn5j6OzD.js";
import { t as u } from "./i18n-Duo0HNK5.js";
import { a as Q, g as aa, l as ea, b as ta, e as ra, c as na, z as oa, r as sa, s as ia } from "./i18n-Duo0HNK5.js";
import { c as G } from "./icons-CnJWc0S0.js";
import { i as ca } from "./icons-CnJWc0S0.js";
import { a6 as C } from "./timeline-DSgX2R5p.js";
import { a7 as ua, a8 as Ba, a9 as Aa, aa as fa, ab as ba, ac as _a, ad as pa, ae as ma, af as Ta, ag as Ra, ah as Oa, ai as La, aj as Ea, ak as Ca, al as ga, am as va, an as Ga, ao as Sa, ap as ha, aq as ya, ar as Na, as as Ia, at as Da, au as Pa, av as Ma, aw as wa, ax as ka, ay as xa, az as Ua, aA as qa, aB as Fa, aC as Va, aD as Ka, aE as $a, aF as Ha, aG as Wa, aH as za, aI as Ya, aJ as ja, aK as Xa, aL as Za, aM as Ja, aN as Qa, aO as ae, aP as ee, aQ as te, aR as re, aS as ne, aT as oe, aU as se, aV as ie, aW as le, aX as ce, aY as de, aZ as ue, a_ as Be, a$ as Ae, b0 as fe, b1 as be, b2 as _e, b3 as pe, b4 as me, b5 as Te, b6 as Re, b7 as Oe, b8 as Le, b9 as Ee, ba as Ce, bb as ge, bc as ve, bd as Ge, be as Se, bf as he, bg as ye, bh as Ne, bi as Ie, bj as De, bk as Pe, bl as Me, bm as we, bn as ke, bo as xe, bp as Ue, bq as qe, br as Fe, bs as Ve, bt as Ke, bu as $e, bv as He, bw as We, bx as ze, by as Ye, bz as je, bA as Xe, bB as Ze, bC as Je, bD as Qe, bE as at, bF as et, bG as tt, bH as rt, bI as nt, bJ as ot, bK as st, bL as it, bM as lt, bN as ct, bO as dt, bP as ut, bQ as Bt, bR as At, bS as ft, bT as bt, bU as _t, bV as pt, bW as mt, bX as Tt, bY as Rt, d as Ot, W as Lt, I as Et, B as Ct, X as gt, Y as vt, N as Gt, O as St, K as ht, Z as yt, _ as Nt, t as It, a as Dt, H as Pt, b as Mt, $ as wt, C as kt, c as xt, P as Ut, R as qt, A as Ft, z as Vt, a0 as Kt, u as $t, Q as Ht, S as Wt, J as zt, a1 as Yt, a2 as jt, E as Xt, r as Zt, G as Jt, y as Qt, x as ar, D as er, m as tr, e as rr, q as nr, a4 as or, f as sr, g as ir, a3 as lr, p as cr, T as dr, U as ur, k as Br, l as Ar, F as fr, n as br, h as _r, s as pr, a5 as mr, i as Tr, w as Rr, V as Or, j as Lr, L as Er, M as Cr, v as gr, bZ as vr, b_ as Gr, b$ as Sr, o as hr, c0 as yr } from "./timeline-DSgX2R5p.js";
import { w as p } from "./dialog-N9Ob5DI5.js";
import { B as Ir, a as Dr, d as Pr } from "./dialog-N9Ob5DI5.js";
import { BLORA_SELECT_TAG as wr, BloraSelect as kr, defineBloraSelect as xr } from "./components/select/index.js";
import { createTableController as qr } from "./components/table/index.js";
import { enhanceButtons as Vr, setButtonLoading as Kr } from "./components/button/index.js";
import { r as Hr } from "./icons-registry-BEZgQ6x-.js";
const m = "blora-message-container";
function S(a) {
  return a === "error" || a === "danger" ? "danger" : a === "success" || a === "warning" || a === "info" ? a : "info";
}
function h(a) {
  let e = a.querySelector(`.${m}`);
  return e || (e = a.createElement("div"), e.className = `${m} blora-portal`, e.setAttribute("data-blora-message-root", ""), (a.body || a.documentElement).appendChild(e)), e;
}
function y(a, e, t) {
  const r = a.createElement("span");
  r.className = "blora-message__icon", r.setAttribute("aria-hidden", "true"), r.appendChild(C(a, t, 16)), e.appendChild(r);
}
function N(a, e = document) {
  const t = typeof a == "string" ? { content: a } : a || {}, r = S(t.type), n = e.createElement("span");
  n.className = "blora-message", n.setAttribute("data-variant", r), n.setAttribute("role", "status"), y(e, n, r);
  const o = e.createElement("span");
  return o.className = "blora-message__content", o.textContent = (t.content ?? t.message ?? "").trim(), n.appendChild(o), n;
}
function b(a) {
  if (typeof document > "u") return null;
  const e = document, t = h(e), r = N(a, e);
  t.appendChild(r);
  let n = !1;
  const o = () => {
    n || (n = !0, r.classList.add("is-leaving"), p(r, () => {
      r.remove(), t.childElementCount === 0 && t.remove();
    }));
  }, i = a.duration == null ? 3e3 : a.duration;
  return i > 0 && window.setTimeout(o, i), { close: o, el: r };
}
function I(a) {
  return b(typeof a == "string" ? { content: a } : a || {});
}
function f(a) {
  return (e, t) => {
    const r = { content: e, type: a };
    return t !== void 0 && (r.duration = t), b(r);
  };
}
const V = Object.assign(I, {
  open: (a) => b(a || {}),
  success: f("success"),
  info: f("info"),
  warning: f("warning"),
  danger: f("danger"),
  error: f("danger")
});
function T(a) {
  return Array.from(a.querySelectorAll(".blora-field, [data-blora-field]"));
}
function R(a) {
  return a.querySelector(
    "input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select"
  );
}
function O(a) {
  return a.querySelector(".blora-field__error, [data-blora-error]");
}
function B(a, e) {
  if (e) {
    a.setAttribute("data-state", "invalid");
    const t = O(a);
    t && (t.hidden = !1, t.textContent = e);
  } else {
    a.removeAttribute("data-state");
    const t = O(a);
    t && (t.hidden = !0, t.textContent = "");
  }
}
function L(a) {
  return a.validity.valueMissing ? a.getAttribute("data-blora-required-message") || u("validate.required") : a.validity.typeMismatch || a.validity.patternMismatch ? a.getAttribute("data-blora-pattern-message") || u("validate.pattern") : a.validity.tooShort ? u("validate.minlength", { n: a.getAttribute("minlength") ?? "" }) : a.validity.tooLong ? u("validate.maxlength", { n: a.getAttribute("maxlength") ?? "" }) : a.validationMessage || u("validate.invalid");
}
function E(a) {
  const e = {}, t = new FormData(a);
  return t.forEach((r, n) => {
    const o = e[n], i = String(r);
    o === void 0 ? e[n] = i : Array.isArray(o) ? o.push(i) : e[n] = [o, i];
  }), a.querySelectorAll('input[type="checkbox"][name]').forEach((r) => {
    t.has(r.name) || (e[r.name] = r.checked);
  }), e;
}
function K(a) {
  if (typeof document > "u")
    return {
      validate: () => ({ valid: !0, errors: [], values: {} }),
      getValues: () => ({}),
      clearErrors: () => {
      },
      destroy: () => {
      }
    };
  a.classList.add("blora-form"), a.hasAttribute("data-blora-native-validate") || a.setAttribute("novalidate", "");
  const e = () => {
    T(a).forEach((s) => B(s, null));
  }, t = () => {
    const s = [];
    T(a).forEach((c) => {
      const d = R(c);
      if (!d || d.disabled) {
        B(c, null);
        return;
      }
      const v = c.getAttribute("data-blora-validate");
      let _ = d.checkValidity(), A = "";
      v === "email" && d.value && (_ = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.value), _ || (A = d.getAttribute("data-blora-pattern-message") || u("validate.email"))), _ ? (B(c, null), c.setAttribute("data-state", "valid")) : (A = A || L(d), B(c, A), s.push({ name: d.name || "", message: A, field: c }));
    });
    const l = E(a);
    return { valid: s.length === 0, errors: s, values: l };
  }, r = (s) => {
    a.hasAttribute("data-blora-native-validate") || s.preventDefault();
  }, n = (s) => {
    const l = t();
    if (!l.valid) {
      s.preventDefault(), s.stopPropagation();
      return;
    }
    a.dispatchEvent(
      new CustomEvent("blora-form-submit", {
        bubbles: !0,
        detail: { values: l.values, form: a }
      })
    ), a.hasAttribute("data-blora-native-submit") || s.preventDefault();
  }, o = String(a.getAttribute("data-blora-validate-on") || "submit").split(/[\s,]+/).filter(Boolean), i = (s) => {
    if (!o.includes("blur")) return;
    const l = s.target.closest(
      ".blora-field, [data-blora-field]"
    );
    if (!l || !a.contains(l)) return;
    const c = R(l);
    c && (c.checkValidity() ? B(l, null) : B(l, L(c)));
  };
  return a.addEventListener("invalid", r, !0), a.addEventListener("submit", n), o.includes("blur") && a.addEventListener("focusout", i), {
    validate: t,
    getValues: () => E(a),
    clearErrors: e,
    destroy() {
      a.removeEventListener("invalid", r, !0), a.removeEventListener("submit", n), a.removeEventListener("focusout", i);
    }
  };
}
const g = {
  "top-right": "blora-notify-container--top-right",
  "top-left": "blora-notify-container--top-left",
  "bottom-right": "blora-notify-container--bottom-right",
  "bottom-left": "blora-notify-container--bottom-left"
};
function D(a) {
  return a === "error" || a === "danger" ? "danger" : a === "success" || a === "warning" || a === "info" ? a : "info";
}
function P(a, e) {
  const t = g[e];
  let r = a.querySelector(`.blora-notify-container.${t}`);
  return r || (r = a.createElement("div"), r.className = `blora-notify-container ${t} blora-portal`, r.setAttribute("data-placement", e), (a.body || a.documentElement).appendChild(r)), r;
}
function M(a, e, t) {
  const r = a.createElement("span");
  r.className = "blora-notification__icon", r.setAttribute("aria-hidden", "true"), r.appendChild(C(a, t, 22)), e.appendChild(r);
}
function w(a, e) {
  const t = a.createElement("button");
  return t.type = "button", t.className = "blora-notification__close", t.setAttribute("aria-label", u("common.close")), t.appendChild(G("close", 16, a)), e.appendChild(t), t;
}
function k(a, e = document) {
  const t = typeof a == "string" ? { title: a } : a || {}, r = D(t.type), n = e.createElement("div");
  n.className = "blora-notification", n.setAttribute("data-variant", r), n.setAttribute("role", "status"), M(e, n, r);
  const o = e.createElement("div");
  o.className = "blora-notification__body";
  const i = e.createElement("div");
  if (i.className = "blora-notification__title", i.textContent = t.title || t.description || "", o.appendChild(i), t.description && t.title) {
    const s = e.createElement("div");
    s.className = "blora-notification__desc", s.textContent = t.description, o.appendChild(s);
  }
  return n.appendChild(o), w(e, n), n;
}
function $(a) {
  var l;
  if (typeof document > "u") return null;
  const e = typeof a == "string" ? { title: a } : a || {}, t = e.placement && g[e.placement] ? e.placement : "top-right", r = document, n = P(r, t), o = k(e, r), i = () => {
    o.classList.add("is-leaving"), p(o, () => o.remove());
  };
  (l = o.querySelector(".blora-notification__close")) == null || l.addEventListener("click", i), n.appendChild(o);
  const s = e.duration == null ? 4500 : e.duration;
  return s > 0 && setTimeout(i, s), { close: i, el: o };
}
function H(a) {
  const e = a.querySelector(".blora-notification__close, [data-blora-close]");
  if (!e) return { destroy: () => {
  } };
  const t = () => {
    a.classList.add("is-leaving"), a.dispatchEvent(new CustomEvent("blora-notification-close", { bubbles: !0 })), p(a, () => a.remove());
  };
  return e.addEventListener("click", t), {
    destroy() {
      e.removeEventListener("click", t);
    }
  };
}
const W = "2.1.0";
function z() {
  return typeof window < "u" && typeof document < "u";
}
export {
  ua as BLORA_ACCORDION_TAG,
  Ba as BLORA_ALERT_TAG,
  Aa as BLORA_AUTOCOMPLETE_TAG,
  fa as BLORA_BACKTOP_TAG,
  ba as BLORA_BANNER_TAG,
  _a as BLORA_BREADCRUMB_TAG,
  pa as BLORA_CALENDAR_TAG,
  ma as BLORA_CAROUSEL_TAG,
  Ta as BLORA_CASCADER_TAG,
  Ra as BLORA_CHART_CONTAINER_TAG,
  Oa as BLORA_CHAT_TAG,
  La as BLORA_CHECKBOX_TAG,
  Ea as BLORA_COLLAPSE_TAG,
  Ca as BLORA_COLOR_PICKER_TAG,
  ga as BLORA_COMMAND_TAG,
  va as BLORA_COMMENT_TAG,
  Ga as BLORA_COPY_TAG,
  Sa as BLORA_DATEPICKER_TAG,
  ha as BLORA_DECK_TAG,
  Ir as BLORA_DIALOG_TAG,
  ya as BLORA_DOCK_TAG,
  Na as BLORA_DRAWER_TAG,
  Ia as BLORA_DROPDOWN_TAG,
  Da as BLORA_EMPTY_TAG,
  Pa as BLORA_FIELD_TAG,
  Ma as BLORA_IMAGE_TAG,
  wa as BLORA_MEGAMENU_TAG,
  ka as BLORA_MENTIONS_TAG,
  xa as BLORA_MOCKUP_TAG,
  Ua as BLORA_NAVBAR_TAG,
  qa as BLORA_NUMBER_INPUT_TAG,
  Fa as BLORA_OTP_TAG,
  Va as BLORA_PAGINATION_TAG,
  Ka as BLORA_POPCONFIRM_TAG,
  $a as BLORA_POPOVER_TAG,
  Ha as BLORA_PROGRESS_TAG,
  Wa as BLORA_RADIO_TAG,
  za as BLORA_RANGE_TAG,
  Ya as BLORA_RATE_TAG,
  ja as BLORA_RESULT_TAG,
  Xa as BLORA_SEARCH_TAG,
  Za as BLORA_SEGMENTED_TAG,
  wr as BLORA_SELECT_TAG,
  Ja as BLORA_SIDEBAR_NAV_TAG,
  Qa as BLORA_SLIDER_TAG,
  ae as BLORA_SPEED_DIAL_TAG,
  ee as BLORA_SPLITTER_TAG,
  te as BLORA_STATISTIC_TAG,
  re as BLORA_STEPS_TAG,
  ne as BLORA_SWAP_TAG,
  oe as BLORA_SWITCH_TAG,
  se as BLORA_TABS_TAG,
  ie as BLORA_TAGS_INPUT_TAG,
  le as BLORA_TIMELINE_TAG,
  ce as BLORA_TIMEPICKER_TAG,
  de as BLORA_TOOLTIP_TAG,
  ue as BLORA_TOUR_TAG,
  Be as BLORA_TRANSFER_TAG,
  Ae as BLORA_TREE_SELECT_TAG,
  fe as BLORA_TREE_TAG,
  be as BLORA_UPLOAD_TAG,
  _e as BloraAccordion,
  pe as BloraAlert,
  me as BloraAutocomplete,
  Te as BloraBacktop,
  Re as BloraBanner,
  Oe as BloraBreadcrumb,
  Le as BloraCalendar,
  Ee as BloraCarousel,
  Ce as BloraCascader,
  ge as BloraChartContainer,
  ve as BloraChat,
  Ge as BloraCheckbox,
  Se as BloraCollapse,
  he as BloraColorPicker,
  ye as BloraCommand,
  Ne as BloraComment,
  Ie as BloraCopy,
  De as BloraDatepicker,
  Pe as BloraDeck,
  Dr as BloraDialog,
  Me as BloraDock,
  we as BloraDrawer,
  ke as BloraDropdown,
  X as BloraElement,
  xe as BloraEmpty,
  Ue as BloraField,
  qe as BloraImage,
  Fe as BloraMegamenu,
  Ve as BloraMentions,
  Ke as BloraMockup,
  $e as BloraNavbar,
  He as BloraNumberInput,
  We as BloraOtp,
  ze as BloraPagination,
  Ye as BloraPopconfirm,
  je as BloraPopover,
  Xe as BloraProgress,
  Ze as BloraRadio,
  Je as BloraRange,
  Qe as BloraRate,
  at as BloraResult,
  et as BloraSearch,
  tt as BloraSegmented,
  kr as BloraSelect,
  rt as BloraSidebarNav,
  nt as BloraSlider,
  ot as BloraSpeedDial,
  st as BloraSplitter,
  it as BloraStatistic,
  lt as BloraSteps,
  ct as BloraSwap,
  dt as BloraSwitch,
  ut as BloraTabs,
  Bt as BloraTagsInput,
  At as BloraTimeline,
  ft as BloraTimepicker,
  bt as BloraTooltip,
  _t as BloraTour,
  pt as BloraTransfer,
  mt as BloraTree,
  Tt as BloraTreeSelect,
  Rt as BloraUpload,
  Z as OverlayController,
  W as VERSION,
  Q as applyDocumentLocale,
  G as createBloraIcon,
  K as createFormController,
  N as createMessageElement,
  H as createNotificationController,
  k as createNotificationElement,
  qr as createTableController,
  Ot as defineBloraAccordion,
  Lt as defineBloraAlert,
  Et as defineBloraAutocomplete,
  Ct as defineBloraBacktop,
  gt as defineBloraBanner,
  vt as defineBloraBreadcrumb,
  Gt as defineBloraCalendar,
  St as defineBloraCarousel,
  ht as defineBloraCascader,
  yt as defineBloraChartContainer,
  Nt as defineBloraChat,
  It as defineBloraCheckbox,
  Dt as defineBloraCollapse,
  Pt as defineBloraColorPicker,
  Mt as defineBloraCommand,
  wt as defineBloraComment,
  kt as defineBloraCopy,
  xt as defineBloraDatepicker,
  Ut as defineBloraDeck,
  Pr as defineBloraDialog,
  qt as defineBloraDock,
  Ft as defineBloraDrawer,
  Vt as defineBloraDropdown,
  Kt as defineBloraEmpty,
  $t as defineBloraField,
  Ht as defineBloraImage,
  Wt as defineBloraMegamenu,
  zt as defineBloraMentions,
  Yt as defineBloraMockup,
  jt as defineBloraNavbar,
  Xt as defineBloraNumberInput,
  Zt as defineBloraOtp,
  Jt as defineBloraPagination,
  Qt as defineBloraPopconfirm,
  ar as defineBloraPopover,
  er as defineBloraProgress,
  tr as defineBloraRadio,
  rr as defineBloraRange,
  nr as defineBloraRate,
  or as defineBloraResult,
  sr as defineBloraSearch,
  ir as defineBloraSegmented,
  xr as defineBloraSelect,
  lr as defineBloraSidebarNav,
  cr as defineBloraSlider,
  dr as defineBloraSpeedDial,
  ur as defineBloraSplitter,
  Br as defineBloraStatistic,
  Ar as defineBloraSteps,
  fr as defineBloraSwap,
  br as defineBloraSwitch,
  _r as defineBloraTabs,
  pr as defineBloraTagsInput,
  mr as defineBloraTimeline,
  Tr as defineBloraTimepicker,
  Rr as defineBloraTooltip,
  Or as defineBloraTour,
  Lr as defineBloraTransfer,
  Er as defineBloraTree,
  Cr as defineBloraTreeSelect,
  gr as defineBloraUpload,
  vr as enhanceBadges,
  Vr as enhanceButtons,
  E as getFormValues,
  aa as getLocale,
  Gr as hydrateIcons,
  Sr as initBackTop,
  ca as isBloraIconName,
  z as isBrowser,
  ea as localeCollator,
  ta as localeDow,
  ra as localeEn,
  na as localeMonths,
  oa as localeZhCN,
  V as message,
  $ as notify,
  hr as observeIcons,
  yr as openImagePreview,
  Hr as registerBloraIcons,
  sa as registerLocale,
  Kr as setButtonLoading,
  ia as setLocale,
  u as t
};
