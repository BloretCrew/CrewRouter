import { i as d, c as r } from "../../icons-CnJWc0S0.js";
function s(e, n, a = {}) {
  const { label: i, disable: t = !0 } = a;
  if (n)
    e.setAttribute("aria-busy", "true"), e.setAttribute("data-loading", ""), t && (e.disabled = !0), i !== void 0 && (e.dataset.loadingLabel === void 0 && (e.dataset.loadingLabel = e.textContent ?? ""), e.textContent = i);
  else if (e.removeAttribute("aria-busy"), e.removeAttribute("data-loading"), t && (e.disabled = !1), i !== void 0 || e.dataset.loadingLabel !== void 0) {
    const o = e.dataset.loadingLabel;
    o !== void 0 && (e.textContent = o, delete e.dataset.loadingLabel);
  }
}
function c(e = document) {
  if (typeof document > "u") return;
  const n = [...e.querySelectorAll(".blora-button[data-icon]")];
  e instanceof HTMLElement && e.matches(".blora-button[data-icon]") && n.unshift(e), n.forEach((a) => {
    const i = a.getAttribute("data-icon");
    if (!i || !d(i) || a.querySelector(":scope > svg[data-blora-icon]")) return;
    const t = r(i, 16, a.ownerDocument);
    t.dataset.bloraIcon = i, a.getAttribute("data-icon-position") === "end" ? a.append(t) : a.prepend(t);
  });
}
export {
  c as enhanceButtons,
  s as setButtonLoading
};
