import { i as r, c as n } from "../../icons-PjqNgrW5.js";
function s(e, a, t = {}) {
  const { label: i, disable: d = !0 } = t;
  if (a)
    e.setAttribute("aria-busy", "true"), e.setAttribute("data-loading", ""), d && (e.disabled = !0), i !== void 0 && (e.dataset.loadingLabel === void 0 && (e.dataset.loadingLabel = e.textContent ?? ""), e.textContent = i);
  else if (e.removeAttribute("aria-busy"), e.removeAttribute("data-loading"), d && (e.disabled = !1), i !== void 0 || e.dataset.loadingLabel !== void 0) {
    const o = e.dataset.loadingLabel;
    o !== void 0 && (e.textContent = o, delete e.dataset.loadingLabel);
  }
}
function c(e = document) {
  typeof document > "u" || e.querySelectorAll(".blora-button[data-icon]").forEach((a) => {
    const t = a.getAttribute("data-icon");
    if (!t || !r(t) || a.querySelector(":scope > svg[data-blora-icon]")) return;
    const i = n(t, 16, a.ownerDocument);
    i.dataset.bloraIcon = t, a.getAttribute("data-icon-position") === "end" ? a.append(i) : a.prepend(i);
  });
}
export {
  c as enhanceButtons,
  s as setButtonLoading
};
