import { t as I } from "../../i18n-Duo0HNK5.js";
import { c as Lt } from "../../icons-PjqNgrW5.js";
function rt(u, f) {
  const m = u.createElement("label");
  m.className = ["blora-checkbox", f.className || ""].filter(Boolean).join(" ");
  const r = u.createElement("input");
  if (r.type = "checkbox", f.checked && (r.checked = !0), f.attrs)
    for (const s of f.attrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
      const c = s[1], k = s[2];
      !c || c === "type" || (k === void 0 ? r.setAttribute(c, "") : r.setAttribute(c, k));
    }
  const y = u.createElement("span");
  if (y.className = "blora-checkbox__box", m.append(r, y), f.label) {
    const s = u.createElement("span");
    s.textContent = f.label, m.appendChild(s);
  }
  return m;
}
function tt(u) {
  const f = u.querySelector(".blora-table__sort");
  if (!f) return;
  const m = u.dataset.sortDir === "asc" ? "arrow-up" : u.dataset.sortDir === "desc" ? "arrow-down" : "arrow-down-up";
  f.replaceChildren(Lt(m, 12, u.ownerDocument));
}
function _t(u) {
  var y;
  if (u.querySelector(".blora-table__sort")) {
    tt(u);
    return;
  }
  u.style.cursor = "pointer", u.style.userSelect = "none";
  const f = ((y = u.textContent) == null ? void 0 : y.trim()) || "";
  u.textContent = "";
  const m = document.createElement("span");
  m.textContent = f;
  const r = document.createElement("span");
  r.className = "blora-table__sort", r.setAttribute("aria-hidden", "true"), u.append(m, r), tt(u);
}
function $t(u, f) {
  return u.getAttribute("data-blora-cols-key") || `blora-table-cols:${f.id || u.id || "default"}`;
}
function dt(u) {
  return Array.from(u.querySelectorAll("thead th")).filter(
    (m) => !m.hasAttribute("data-blora-select-col")
  ).map((m, r) => ({
    key: m.getAttribute("data-blora-sort") || m.getAttribute("data-col-key") || String(r),
    label: (m.textContent || "").replace(/\s*[⇅▲▼]\s*$/, "").trim() || String(r + 1),
    visible: m.getAttribute("data-col-hidden") !== "true",
    index: r
  }));
}
function Ot(u, f) {
  try {
    const m = localStorage.getItem($t(u, f));
    if (!m) return null;
    const r = JSON.parse(m);
    return Array.isArray(r) ? r : null;
  } catch {
    return null;
  }
}
function Z(u, f, m) {
  try {
    localStorage.setItem($t(u, f), JSON.stringify(m));
  } catch {
  }
}
function zt(u, f) {
  const m = {
    setPage: () => {
    },
    getPage: () => 1,
    getPageCount: () => 1,
    setRows: () => {
    },
    getColumnConfig: () => [],
    setColumnVisible: () => {
    },
    resetColumns: () => {
    },
    getSelectedRows: () => [],
    clearSelection: () => {
    },
    destroy: () => {
    }
  };
  if (typeof document > "u") return m;
  const r = u.matches("table") ? u : u.querySelector("table");
  if (!r) return m;
  let y = r.tBodies[0] || r.createTBody();
  const s = r.ownerDocument, c = u.closest(".blora-table-wrap") || r.closest(".blora-table-wrap") || u;
  r.id || (r.id = `blora-table-${Math.random().toString(36).slice(2, 9)}`);
  const k = (f == null ? void 0 : f.pageSize) || Number(c.getAttribute("data-page-size") || r.getAttribute("data-page-size") || 0) || 0, lt = (f == null ? void 0 : f.columns) !== !1 && (c.hasAttribute("data-blora-cols") || r.hasAttribute("data-blora-cols")), x = c.hasAttribute("data-blora-virtual") || r.hasAttribute("data-blora-virtual"), S = (f == null ? void 0 : f.selectable) === !0 || (f == null ? void 0 : f.selectable) !== !1 && (c.hasAttribute("data-blora-selectable") || r.hasAttribute("data-blora-selectable"));
  r._bloraSelectedKeys || (r._bloraSelectedKeys = /* @__PURE__ */ new Set());
  const O = r._bloraSelectedKeys;
  let A = 1, v = Ot(c, r) || dt(r), L = null;
  Array.from(
    r.querySelectorAll("th[data-sort], th[data-blora-sort]")
  ).forEach(_t);
  const B = () => Array.from(y.querySelectorAll("tr:not(.blora-table-virtual-pad)"));
  let nt = B();
  const et = () => Array.from(r.querySelectorAll("thead th")).filter(
    (e) => !e.hasAttribute("data-blora-select-col")
  ), $ = () => {
    var a;
    if (!lt) return;
    const e = et(), t = (a = r.tHead) == null ? void 0 : a.rows[0];
    if (!t) return;
    v.forEach((o, i) => {
      const h = e.find(
        (p) => (p.getAttribute("data-blora-sort") || p.getAttribute("data-col-key") || "") === o.key
      ) || e[o.index];
      h && (h.dataset.colOrder = String(i), h.hidden = !o.visible, h.toggleAttribute("data-col-hidden", !o.visible));
    }), Array.from(t.children).filter((o) => !o.hasAttribute("data-blora-select-col")).sort((o, i) => Number(o.dataset.colOrder || 0) - Number(i.dataset.colOrder || 0)).forEach((o) => t.appendChild(o));
    const l = Array.from(t.children);
    Array.from(y.rows).forEach((o) => {
      if (o.classList.contains("blora-table-virtual-pad")) return;
      const i = Array.from(o.children);
      i.forEach((g, q) => {
        g.dataset.colIndex || (g.dataset.colIndex = String(q));
      });
      const h = new Map(i.map((g) => [Number(g.dataset.colIndex), g])), p = i.find((g) => g.hasAttribute("data-blora-select-col")), w = [];
      p && w.push(p), l.forEach((g) => {
        if (g.hasAttribute("data-blora-select-col")) return;
        const q = g.getAttribute("data-blora-sort") || g.getAttribute("data-col-key"), D = v.find((T) => T.key === q), X = D ? D.index : Number(g.dataset.colIndex || 0), R = h.get(X);
        R && (R.hidden = g.hidden, R.dataset.colOrder = g.dataset.colOrder || "", w.push(R));
      }), o.replaceChildren(...w);
    });
  };
  et().forEach((e, t) => {
    e.dataset.colIndex = String(t);
  }), B().forEach((e) => {
    Array.from(e.cells).forEach((t, n) => {
      t.dataset.colIndex = String(n);
    });
  });
  const ot = () => {
    var e;
    if (x) {
      const t = ((e = r._bloraRowData) == null ? void 0 : e.length) || 0;
      return k ? Math.max(1, Math.ceil(t / k)) : 1;
    }
    return k ? Math.max(1, Math.ceil(B().length / k)) : 1;
  }, H = () => {
    if (x) return;
    if (!k) {
      B().forEach((a) => {
        a.hidden = !1;
      }), $();
      return;
    }
    const e = B(), t = ot();
    A > t && (A = t), A < 1 && (A = 1);
    const n = (A - 1) * k, l = n + k;
    e.forEach((a, o) => {
      a.hidden = o < n || o >= l;
    }), c.setAttribute("data-page", String(A)), c.setAttribute("data-page-count", String(t)), u.dispatchEvent(
      new CustomEvent("blora-table-page", {
        bubbles: !0,
        detail: { page: A, pageSize: k, pageCount: t }
      })
    ), $(), S && ct();
  }, qt = (e, t) => (n, l) => {
    var p, w, g, q;
    const a = ((w = (p = n.children[e]) == null ? void 0 : p.textContent) == null ? void 0 : w.trim()) || "", o = ((q = (g = l.children[e]) == null ? void 0 : g.textContent) == null ? void 0 : q.trim()) || "", i = Number(a), h = Number(o);
    return !Number.isNaN(i) && !Number.isNaN(h) && a !== "" && o !== "" ? t ? i - h : h - i : t ? a.localeCompare(o, "zh") : o.localeCompare(a, "zh");
  }, Dt = (e) => {
    r.querySelectorAll("th[data-sort], th[data-blora-sort]").forEach((t) => {
      e && t === e || (delete t.dataset.sortDir, t.removeAttribute("aria-sort"), tt(t));
    });
  }, st = (e) => e.getAttribute("data-row-key") || e.dataset.virtualIndex || e.getAttribute("data-id") || Array.from(e.cells).filter((t) => !t.hasAttribute("data-blora-select-col")).map((t) => {
    var n;
    return ((n = t.textContent) == null ? void 0 : n.trim()) || "";
  }).join("|"), ct = () => {
    var n;
    if (!S) return;
    const e = (n = r.tHead) == null ? void 0 : n.rows[0];
    if (!e) return;
    if (!e.querySelector("th[data-blora-select-col]")) {
      const l = s.createElement("th");
      l.setAttribute("data-blora-select-col", ""), l.className = "blora-table-select-col", l.appendChild(
        rt(s, {
          className: "blora-table-check",
          attrs: `data-blora-select-all aria-label="${I("table.selectAll")}"`
        })
      ), e.insertBefore(l, e.firstChild);
    }
    Array.from(y.rows).forEach((l) => {
      if (l.classList.contains("blora-table-virtual-pad") || l.querySelector("td[data-blora-select-col]")) return;
      const a = s.createElement("td");
      a.setAttribute("data-blora-select-col", ""), a.className = "blora-table-select-col";
      const o = st(l), i = rt(s, {
        className: "blora-table-check",
        checked: O.has(o),
        attrs: `data-blora-row-select aria-label="${I("table.selectRow")}" data-row-key="${o.replace(/"/g, "")}"`
      });
      a.appendChild(i), l.insertBefore(a, l.firstChild);
    });
    let t = c.parentElement && c.parentElement.querySelector(
      `.blora-table-bulk[data-blora-table-bulk="${r.id}"]`
    ) || null;
    if (!t && c.parentElement) {
      t = s.createElement("div"), t.className = "blora-table-bulk", t.setAttribute("data-blora-table-bulk", r.id), t.hidden = !0;
      const l = s.createElement("span");
      l.className = "blora-table-bulk__count";
      const a = s.createElement("button");
      a.type = "button", a.className = "blora-button", a.setAttribute("data-variant", "ghost"), a.setAttribute("data-size", "sm"), a.setAttribute("data-blora-clear-selection", ""), a.textContent = I("table.clearSelection");
      const o = s.createElement("span");
      o.className = "blora-table-bulk__slot", o.setAttribute("data-blora-bulk-actions", ""), t.append(l, a, o), c.parentElement.insertBefore(t, c);
    }
    r._bloraBulk = t;
  }, Rt = () => Array.from(y.rows).filter((e) => {
    if (e.hidden || e.classList.contains("blora-table-virtual-pad")) return !1;
    const t = e.querySelector("input[data-blora-row-select]");
    return !!(t && t.checked);
  }), V = () => {
    if (!S) return;
    const e = Array.from(y.rows).filter(
      (a) => !a.hidden && !a.classList.contains("blora-table-virtual-pad")
    ), t = e.filter((a) => {
      const o = a.querySelector("input[data-blora-row-select]");
      return !!(o && o.checked);
    }), n = r.querySelector("input[data-blora-select-all]");
    if (n) {
      n.checked = e.length > 0 && t.length === e.length, n.indeterminate = t.length > 0 && t.length < e.length;
      const a = n.closest(".blora-checkbox");
      a == null || a.toggleAttribute("data-indeterminate", n.indeterminate);
    }
    const l = r._bloraBulk;
    if (l) {
      l.hidden = t.length === 0;
      const a = l.querySelector(".blora-table-bulk__count");
      a && (a.textContent = I("table.selected", { n: t.length }));
    }
    c.classList.toggle("has-selection", t.length > 0), r.dispatchEvent(
      new CustomEvent("blora-table-select", {
        bubbles: !0,
        detail: { selected: t.length, rows: t, table: r }
      })
    );
  }, bt = () => {
    O.clear(), r.querySelectorAll(
      "input[data-blora-row-select], input[data-blora-select-all]"
    ).forEach((e) => {
      e.checked = !1, e.indeterminate = !1;
    }), r.querySelectorAll(".blora-checkbox[data-indeterminate]").forEach((e) => {
      e.removeAttribute("data-indeterminate");
    }), V();
  }, ut = (e) => {
    if (!S) return;
    const t = e.target;
    if (!(!(t instanceof HTMLInputElement) || t.type !== "checkbox") && r.contains(t)) {
      if (t.hasAttribute("data-blora-select-all")) {
        const n = t.checked;
        y.querySelectorAll("input[data-blora-row-select]").forEach((l) => {
          const a = l.closest("tr");
          if (a && !a.hidden && !a.classList.contains("blora-table-virtual-pad")) {
            l.checked = n;
            const o = l.getAttribute("data-row-key") || st(a);
            n ? O.add(o) : O.delete(o);
          }
        }), V();
        return;
      }
      if (t.hasAttribute("data-blora-row-select")) {
        const n = t.closest("tr");
        if (n) {
          const l = t.getAttribute("data-row-key") || st(n);
          t.checked ? O.add(l) : O.delete(l);
        }
        V();
      }
    }
  }, ft = (e) => {
    e.target.closest("[data-blora-clear-selection]") && bt();
  }, ht = () => {
    if (L && L.isConnected) return L;
    c.classList.add("blora-table-wrap--virtual");
    let e = c.querySelector(".blora-table-virtual");
    if (!e) {
      e = s.createElement("div"), e.className = "blora-table-virtual";
      const n = r.parentElement;
      n ? (n.insertBefore(e, r), e.appendChild(r)) : (c.appendChild(e), e.appendChild(r));
    }
    const t = Number(c.getAttribute("data-viewport-height")) || e.clientHeight || 360;
    return e.style.height = `${t}px`, e.style.overflow = "auto", L = e, e;
  }, It = () => {
    const e = r._bloraRowData || [], t = r._bloraRowKeys;
    if (t != null && t.length)
      return t.map((a, o) => {
        var p;
        const i = et()[o], h = ((p = i == null ? void 0 : i.textContent) == null ? void 0 : p.replace(/\s*[⇅▲▼]\s*$/, "").trim()) || a;
        return { key: a, label: h };
      });
    const n = et();
    if (n.length)
      return n.map((a, o) => {
        var i;
        return {
          key: a.getAttribute("data-col-key") || a.getAttribute("data-blora-sort") || String(o),
          label: ((i = a.textContent) == null ? void 0 : i.replace(/\s*[⇅▲▼]\s*$/, "").trim()) || String(o + 1)
        };
      });
    const l = e[0];
    return Array.isArray(l) ? l.map((a, o) => ({ key: String(o), label: `Col ${o + 1}` })) : l && typeof l == "object" ? Object.keys(l).map((a) => ({ key: a, label: a })) : [{ key: "0", label: "Col" }];
  }, Bt = (e, t, n) => {
    if (e == null) return "";
    if (Array.isArray(e)) {
      const a = e[t];
      return a == null ? "" : String(a);
    }
    const l = e[n];
    return l == null ? "" : String(l);
  }, mt = (e, t) => {
    const n = s.createElement("td");
    return n.className = "blora-table-virtual-pad-cell", n.style.cssText = [
      `width:${e}px`,
      `min-width:${e}px`,
      `max-width:${e}px`,
      "padding:0",
      "border:0",
      ""
    ].filter(Boolean).join(";"), n;
  }, M = () => {
    if (!x) return;
    const e = r._bloraRowData || [], t = Number(c.getAttribute("data-row-height")) || 44, n = Number(c.getAttribute("data-col-width")) || 120, l = Number(c.getAttribute("data-overscan")) || 6, a = (c.getAttribute("data-virtual-axis") || "both").toLowerCase(), o = a === "y" || a === "both", i = a === "x" || a === "both", h = ht();
    y = r.tBodies[0] || r.createTBody();
    const p = r.tHead || r.createTHead();
    let w = p.rows[0];
    w || (w = p.insertRow());
    const g = h.clientHeight || Number(c.getAttribute("data-viewport-height")) || 360, q = h.clientWidth || Number(c.getAttribute("data-viewport-width")) || c.clientWidth || 600, D = e.length, X = It(), R = X.length;
    let T = 0, P = D;
    if (o && D > 0) {
      const b = h.scrollTop || 0;
      T = Math.max(0, Math.floor(b / t) - l);
      const E = Math.ceil(g / t) + l * 2;
      P = Math.min(D, T + E);
    }
    let K = 0, z = R;
    const wt = R * n, N = i && wt > q + 1;
    if (N) {
      const b = h.scrollLeft || 0;
      K = Math.max(0, Math.floor(b / n) - l);
      const E = Math.ceil(q / n) + l * 2;
      z = Math.min(R, K + E);
    }
    const U = N ? K * n : 0, Y = N ? Math.max(0, R - z) * n : 0, Tt = Math.max(1, z - K), Nt = (S ? 1 : 0) + (N ? 2 : 0) + Tt, G = s.createDocumentFragment();
    if (S) {
      const b = s.createElement("th");
      b.setAttribute("data-blora-select-col", ""), b.className = "blora-table-select-col", b.appendChild(
        rt(s, {
          className: "blora-table-check",
          attrs: `data-blora-select-all aria-label="${I("table.selectAll")}"`
        })
      ), G.appendChild(b);
    }
    if (N && U > 0) {
      const b = s.createElement("th");
      b.className = "blora-table-virtual-pad-cell", b.style.cssText = `width:${U}px;min-width:${U}px;padding:0;border:0`, G.appendChild(b);
    }
    for (let b = K; b < z; b++) {
      const E = X[b], C = s.createElement("th");
      C.dataset.colKey = E.key, C.setAttribute("data-col-key", E.key), C.dataset.colIndex = String(b), C.style.width = `${n}px`, C.style.minWidth = `${n}px`, C.textContent = E.label, G.appendChild(C);
    }
    if (N && Y > 0) {
      const b = s.createElement("th");
      b.className = "blora-table-virtual-pad-cell", b.style.cssText = `width:${Y}px;min-width:${Y}px;padding:0;border:0`, G.appendChild(b);
    }
    w.replaceChildren(G);
    const at = s.createDocumentFragment();
    if (o && T > 0) {
      const b = s.createElement("tr");
      b.className = "blora-table-virtual-pad";
      const E = s.createElement("td");
      E.colSpan = Nt, E.style.cssText = `height:${T * t}px;padding:0;border:0`, b.appendChild(E), at.appendChild(b);
    }
    for (let b = T; b < P; b++) {
      const E = e[b], C = s.createElement("tr");
      if (C.dataset.virtualIndex = String(b), C.style.height = `${t}px`, S) {
        const _ = s.createElement("td");
        _.setAttribute("data-blora-select-col", ""), _.className = "blora-table-select-col";
        const Q = String(b);
        _.appendChild(
          rt(s, {
            className: "blora-table-check",
            checked: O.has(Q),
            attrs: `data-blora-row-select aria-label="${I("table.selectRow")}" data-row-key="${Q}"`
          })
        ), C.appendChild(_);
      }
      N && U > 0 && C.appendChild(mt(U));
      for (let _ = K; _ < z; _++) {
        const Q = X[_], j = s.createElement("td");
        j.dataset.colIndex = String(_), j.setAttribute("data-col-key", Q.key), j.style.width = `${n}px`, j.style.minWidth = `${n}px`, j.textContent = Bt(E, _, Q.key), C.appendChild(j);
      }
      N && Y > 0 && C.appendChild(mt(Y)), at.appendChild(C);
    }
    if (o && P < D) {
      const b = s.createElement("tr");
      b.className = "blora-table-virtual-pad";
      const E = s.createElement("td");
      E.colSpan = Nt, E.style.cssText = `height:${Math.max(0, D - P) * t}px;padding:0;border:0`, b.appendChild(E), at.appendChild(b);
    }
    y.replaceChildren(at), N ? r.style.minWidth = `${wt}px` : r.style.minWidth = "", lt && $(), S && (ct(), V()), c.setAttribute("data-virtual-total", String(D)), c.setAttribute("data-virtual-start", String(T)), c.setAttribute("data-virtual-end", String(P)), c.setAttribute("data-virtual-col-start", String(K)), c.setAttribute("data-virtual-col-end", String(z)), c.toggleAttribute("data-virtual-x", N);
  };
  let it = !1;
  const pt = () => {
    it || (it = !0, requestAnimationFrame(() => {
      it = !1, M();
    }));
  };
  let W = null, d = null, F = "", gt = !1;
  const J = () => {
    if (!d) return;
    const e = d.querySelector(".blora-table-cols__list");
    e && (e.replaceChildren(), v.forEach((t) => {
      const n = s.createElement("div");
      n.className = "blora-table-cols__item", n.setAttribute("data-col-key", t.key), n.draggable = !0;
      const l = s.createElement("span");
      l.className = "blora-table-cols__grip", l.setAttribute("aria-hidden", "true"), l.title = I("table.colDrag");
      const a = Lt("grip", 14, s);
      l.appendChild(a);
      const o = s.createElement("label");
      o.className = "blora-checkbox blora-table-cols__check";
      const i = s.createElement("input");
      i.type = "checkbox", i.checked = t.visible, i.setAttribute("data-col-key", t.key);
      const h = s.createElement("span");
      h.className = "blora-checkbox__box";
      const p = s.createElement("span");
      p.textContent = t.label, o.append(i, h, p), n.append(l, o), e.appendChild(n);
    }));
  }, Mt = () => {
    const e = c.parentElement || c;
    if (W = e.querySelector(".blora-table-cols-bar"), d = e.querySelector(".blora-table-cols"), !W) {
      W = s.createElement("div"), W.className = "blora-table-cols-bar";
      const t = s.createElement("button");
      t.type = "button", t.className = "blora-button", t.setAttribute("data-variant", "outline"), t.setAttribute("data-size", "sm"), t.setAttribute("data-blora-cols-toggle", ""), t.textContent = I("table.cols"), W.appendChild(t), e.insertBefore(W, c);
    }
    if (!d) {
      d = s.createElement("div"), d.className = "blora-table-cols", d.hidden = !0;
      const t = s.createElement("div");
      t.className = "blora-table-cols__list";
      const n = s.createElement("div");
      n.className = "blora-table-cols__foot";
      const l = s.createElement("button");
      l.type = "button", l.className = "blora-button", l.setAttribute("data-variant", "ghost"), l.setAttribute("data-size", "sm"), l.setAttribute("data-blora-cols-reset", ""), l.textContent = I("table.colsReset"), n.appendChild(l), d.append(t, n), e.insertBefore(d, c);
    }
    return d;
  }, yt = (e) => {
    const t = e.target;
    if (t.closest("[data-blora-cols-toggle]")) {
      if (!d) return;
      d.hidden = !d.hidden, d.hidden || J();
      return;
    }
    t.closest("[data-blora-cols-reset]") && (v = dt(r), Z(c, r, v), J(), $(), x && M());
  }, At = (e) => {
    const t = e.target.closest("input[data-col-key]");
    if (!t || !(d != null && d.contains(t))) return;
    const n = t.getAttribute("data-col-key") || "", l = v.find((a) => a.key === n);
    l && (l.visible = t.checked, Z(c, r, v), $(), x && M());
  }, vt = (e) => {
    const t = e.target.closest(".blora-table-cols__item");
    if (!(!t || !(d != null && d.contains(t)))) {
      if (e.target.closest("input, .blora-checkbox__box, label.blora-checkbox")) {
        e.preventDefault();
        return;
      }
      F = t.getAttribute("data-col-key") || "";
      try {
        e.dataTransfer.effectAllowed = "move", e.dataTransfer.setData("text/plain", F);
      } catch {
      }
      t.classList.add("is-dragging");
    }
  }, Et = (e) => {
    const t = e.target.closest(".blora-table-cols__item");
    !t || !(d != null && d.contains(t)) || (e.preventDefault(), d.querySelectorAll(".is-drag-over").forEach((n) => n.classList.remove("is-drag-over")), t.classList.add("is-drag-over"));
  }, Ct = (e) => {
    e.preventDefault();
    const t = e.target.closest(".blora-table-cols__item");
    if (!t || !(d != null && d.contains(t)) || !F) return;
    const n = t.getAttribute("data-col-key") || "", l = v.findIndex((i) => i.key === F), a = v.findIndex((i) => i.key === n);
    if (l < 0 || a < 0 || l === a) return;
    const [o] = v.splice(l, 1);
    o && (v.splice(a, 0, o), v.forEach((i, h) => {
      i.index = h;
    }), Z(c, r, v), J(), $(), x && M());
  }, kt = () => {
    F = "", d == null || d.querySelectorAll(".blora-table-cols__item").forEach((e) => e.classList.remove("is-dragging", "is-drag-over"));
  }, xt = (e) => {
    if (x) return;
    const t = e.target.closest("th[data-sort], th[data-blora-sort]");
    if (!t || !r.contains(t)) return;
    _t(t);
    const n = Array.from(t.parentElement.children).indexOf(t), l = t.dataset.sortDir;
    let a;
    if (l === "asc" ? a = "desc" : l === "desc" ? a = null : a = "asc", Dt(a ? t : void 0), a === null) {
      delete t.dataset.sortDir, t.removeAttribute("aria-sort"), tt(t), nt.forEach((i) => {
        document.contains(i) && y.appendChild(i);
      }), A = 1, H();
      return;
    }
    t.dataset.sortDir = a, t.setAttribute("aria-sort", a === "asc" ? "ascending" : "descending"), tt(t);
    const o = B();
    o.sort(qt(n, a === "asc")), o.forEach((i) => y.appendChild(i)), A = 1, H();
  }, St = (e) => {
    const t = e.target.closest("[data-table-page], [data-page]");
    if (!t) return;
    const n = c.getAttribute("data-pagination");
    if (n) {
      const a = document.querySelector(n);
      if (a && !a.contains(t)) return;
    } else if (!c.contains(t) && !r.contains(t))
      return;
    const l = t.getAttribute("data-table-page") || t.getAttribute("data-page");
    l === "prev" ? A = Math.max(1, A - 1) : l === "next" ? A = Math.min(ot(), A + 1) : l && (A = Number(l) || A), H();
  };
  if (r.addEventListener("click", xt), document.addEventListener("click", St), S && (r.addEventListener("change", ut), document.addEventListener("click", ft), ct(), V()), lt) {
    const e = Mt();
    document.addEventListener("click", yt), e.addEventListener("change", At), e.addEventListener("dragstart", vt), e.addEventListener("dragover", Et), e.addEventListener("drop", Ct), e.addEventListener("dragend", kt), gt = !0, $();
  }
  if (x) {
    if (ht().addEventListener("scroll", pt, { passive: !0 }), !r._bloraRowData) {
      const t = B();
      r._bloraRowData = t.map(
        (n) => Array.from(n.cells).map((l) => {
          var a;
          return ((a = l.textContent) == null ? void 0 : a.trim()) || "";
        })
      ), nt = [];
    }
    M();
  } else
    H();
  return {
    setPage(e) {
      A = e, H();
    },
    getPage: () => A,
    getPageCount: ot,
    setRows(e, t) {
      r._bloraRowData = e.slice(), t ? r._bloraRowKeys = t.slice() : e[0] && !Array.isArray(e[0]) && typeof e[0] == "object" && (r._bloraRowKeys = Object.keys(e[0])), x ? (L && (L.scrollTop = 0), M()) : (y.replaceChildren(), e.forEach((n) => {
        const l = s.createElement("tr");
        Array.isArray(n) ? n.forEach((a, o) => {
          const i = s.createElement("td");
          i.textContent = a == null ? "" : String(a), i.dataset.colIndex = String(o), l.appendChild(i);
        }) : (r._bloraRowKeys || Object.keys(n)).forEach((o, i) => {
          const h = s.createElement("td"), p = n[o];
          h.textContent = p == null ? "" : String(p), h.dataset.colIndex = String(i), l.appendChild(h);
        }), y.appendChild(l);
      }), nt = B(), A = 1, H());
    },
    getColumnConfig: () => v.map((e) => ({ ...e })),
    setColumnVisible(e, t) {
      const n = v.find((l) => l.key === e);
      n && (n.visible = t, Z(c, r, v), J(), $(), x && M());
    },
    resetColumns() {
      v = dt(r), Z(c, r, v), J(), $(), x && M();
    },
    getSelectedRows: Rt,
    clearSelection: bt,
    destroy() {
      r.removeEventListener("click", xt), document.removeEventListener("click", St), document.removeEventListener("click", yt), S && (r.removeEventListener("change", ut), document.removeEventListener("click", ft)), gt && d && (d.removeEventListener("change", At), d.removeEventListener("dragstart", vt), d.removeEventListener("dragover", Et), d.removeEventListener("drop", Ct), d.removeEventListener("dragend", kt)), L == null || L.removeEventListener("scroll", pt);
    }
  };
}
export {
  zt as createTableController
};
