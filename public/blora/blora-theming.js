var ne = Object.defineProperty;
var le = (r, a, t) => a in r ? ne(r, a, { enumerable: !0, configurable: !0, writable: !0, value: t }) : r[a] = t;
var P = (r, a, t) => le(r, typeof a != "symbol" ? a + "" : a, t);
const ce = {
  "arrow-down": [
    { tag: "path", attrs: { d: "M12 5v14" } },
    { tag: "path", attrs: { d: "m19 12-7 7-7-7" } }
  ],
  "arrow-down-up": [
    { tag: "path", attrs: { d: "m3 16 4 4 4-4" } },
    { tag: "path", attrs: { d: "M7 20V4" } },
    { tag: "path", attrs: { d: "m21 8-4-4-4 4" } },
    { tag: "path", attrs: { d: "M17 4v16" } }
  ],
  "arrow-up": [
    { tag: "path", attrs: { d: "m5 12 7-7 7 7" } },
    { tag: "path", attrs: { d: "M12 19V5" } }
  ],
  ban: [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
    { tag: "path", attrs: { d: "M4.929 4.929 19.07 19.071" } }
  ],
  calendar: [
    { tag: "path", attrs: { d: "M8 2v3" } },
    { tag: "path", attrs: { d: "M16 2v3" } },
    { tag: "rect", attrs: { rx: "2", x: "3", y: "3", width: "18", height: "18" } },
    { tag: "path", attrs: { d: "M3 9h18" } }
  ],
  camera: [
    {
      tag: "path",
      attrs: {
        d: "M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"
      }
    },
    { tag: "circle", attrs: { cx: "12", cy: "13", r: "3" } }
  ],
  chart: [
    { tag: "path", attrs: { d: "M3 3v16a2 2 0 0 0 2 2h16" } },
    { tag: "path", attrs: { d: "M7 16h8" } },
    { tag: "path", attrs: { d: "M7 11h12" } },
    { tag: "path", attrs: { d: "M7 6h3" } }
  ],
  check: [{ tag: "path", attrs: { d: "M20 6 9 17l-5-5" } }],
  "chevron-down": [{ tag: "path", attrs: { d: "m6 9 6 6 6-6" } }],
  "chevron-left": [{ tag: "path", attrs: { d: "m15 18-6-6 6-6" } }],
  "chevron-right": [{ tag: "path", attrs: { d: "m9 18 6-6-6-6" } }],
  "circle-alert": [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
    { tag: "line", attrs: { x1: "12", y1: "8", x2: "12", y2: "12" } },
    { tag: "line", attrs: { x1: "12", y1: "16", x2: "12.01", y2: "16" } }
  ],
  "circle-check": [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
    { tag: "path", attrs: { d: "m9 12 2 2 4-4" } }
  ],
  clock: [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
    { tag: "path", attrs: { d: "M12 6v6l4 2" } }
  ],
  close: [
    { tag: "path", attrs: { d: "M18 6 6 18" } },
    { tag: "path", attrs: { d: "m6 6 12 12" } }
  ],
  copy: [
    { tag: "rect", attrs: { rx: "2", ry: "2", x: "8", y: "8", width: "14", height: "14" } },
    { tag: "path", attrs: { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" } }
  ],
  document: [
    {
      tag: "path",
      attrs: {
        d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"
      }
    },
    { tag: "path", attrs: { d: "M14 2v5a1 1 0 0 0 1 1h5" } }
  ],
  "document-add": [
    {
      tag: "path",
      attrs: {
        d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"
      }
    },
    { tag: "path", attrs: { d: "M14 2v5a1 1 0 0 0 1 1h5" } },
    { tag: "path", attrs: { d: "M9 15h6" } },
    { tag: "path", attrs: { d: "M12 18v-6" } }
  ],
  ellipsis: [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "1" } },
    { tag: "circle", attrs: { cx: "19", cy: "12", r: "1" } },
    { tag: "circle", attrs: { cx: "5", cy: "12", r: "1" } }
  ],
  eye: [
    {
      tag: "path",
      attrs: {
        d: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
      }
    },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "3" } }
  ],
  "eye-off": [
    {
      tag: "path",
      attrs: {
        d: "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"
      }
    },
    { tag: "path", attrs: { d: "M14.084 14.158a3 3 0 0 1-4.242-4.242" } },
    {
      tag: "path",
      attrs: {
        d: "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"
      }
    },
    { tag: "path", attrs: { d: "m2 2 20 20" } }
  ],
  flame: [
    {
      tag: "path",
      attrs: {
        d: "M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"
      }
    }
  ],
  folder: [
    {
      tag: "path",
      attrs: {
        d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
      }
    }
  ],
  grip: [
    { tag: "circle", attrs: { cx: "12", cy: "5", r: "1" } },
    { tag: "circle", attrs: { cx: "19", cy: "5", r: "1" } },
    { tag: "circle", attrs: { cx: "5", cy: "5", r: "1" } },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "1" } },
    { tag: "circle", attrs: { cx: "19", cy: "12", r: "1" } },
    { tag: "circle", attrs: { cx: "5", cy: "12", r: "1" } },
    { tag: "circle", attrs: { cx: "12", cy: "19", r: "1" } },
    { tag: "circle", attrs: { cx: "19", cy: "19", r: "1" } },
    { tag: "circle", attrs: { cx: "5", cy: "19", r: "1" } }
  ],
  heart: [
    {
      tag: "path",
      attrs: {
        d: "M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"
      }
    }
  ],
  home: [
    { tag: "path", attrs: { d: "M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" } },
    {
      tag: "path",
      attrs: {
        d: "M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
      }
    }
  ],
  image: [
    { tag: "rect", attrs: { rx: "2", ry: "2", x: "3", y: "3", width: "18", height: "18" } },
    { tag: "circle", attrs: { cx: "9", cy: "9", r: "2" } },
    { tag: "path", attrs: { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" } }
  ],
  inbox: [
    { tag: "polyline", attrs: { points: "22 12 16 12 14 15 10 15 8 12 2 12" } },
    {
      tag: "path",
      attrs: {
        d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
      }
    }
  ],
  info: [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
    { tag: "path", attrs: { d: "M12 16v-4" } },
    { tag: "path", attrs: { d: "M12 8h.01" } }
  ],
  key: [
    { tag: "path", attrs: { d: "m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" } },
    { tag: "path", attrs: { d: "m21 2-9.6 9.6" } },
    { tag: "circle", attrs: { cx: "7.5", cy: "15.5", r: "5.5" } }
  ],
  mail: [
    { tag: "path", attrs: { d: "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" } },
    { tag: "rect", attrs: { rx: "2", x: "2", y: "4", width: "20", height: "16" } }
  ],
  menu: [
    { tag: "path", attrs: { d: "M4 5h16" } },
    { tag: "path", attrs: { d: "M4 12h16" } },
    { tag: "path", attrs: { d: "M4 19h16" } }
  ],
  message: [
    {
      tag: "path",
      attrs: {
        d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"
      }
    }
  ],
  mic: [
    { tag: "path", attrs: { d: "M12 19v3" } },
    { tag: "path", attrs: { d: "M19 10v2a7 7 0 0 1-14 0v-2" } },
    { tag: "rect", attrs: { rx: "3", x: "9", y: "2", width: "6", height: "13" } }
  ],
  minus: [{ tag: "path", attrs: { d: "M5 12h14" } }],
  moon: [
    {
      tag: "path",
      attrs: {
        d: "M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"
      }
    }
  ],
  palette: [
    {
      tag: "path",
      attrs: {
        d: "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"
      }
    },
    { tag: "circle", attrs: { cx: "13.5", cy: "6.5", r: ".5", fill: "currentColor" } },
    { tag: "circle", attrs: { cx: "17.5", cy: "10.5", r: ".5", fill: "currentColor" } },
    { tag: "circle", attrs: { cx: "6.5", cy: "12.5", r: ".5", fill: "currentColor" } },
    { tag: "circle", attrs: { cx: "8.5", cy: "7.5", r: ".5", fill: "currentColor" } }
  ],
  pencil: [
    {
      tag: "path",
      attrs: {
        d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
      }
    },
    { tag: "path", attrs: { d: "m15 5 4 4" } }
  ],
  phone: [
    {
      tag: "path",
      attrs: {
        d: "M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"
      }
    }
  ],
  plus: [
    { tag: "path", attrs: { d: "M5 12h14" } },
    { tag: "path", attrs: { d: "M12 5v14" } }
  ],
  search: [
    { tag: "path", attrs: { d: "m21 21-4.34-4.34" } },
    { tag: "circle", attrs: { cx: "11", cy: "11", r: "8" } }
  ],
  settings: [
    {
      tag: "path",
      attrs: {
        d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"
      }
    },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "3" } }
  ],
  share: [
    { tag: "path", attrs: { d: "M12 2v13" } },
    { tag: "path", attrs: { d: "m16 6-4-4-4 4" } },
    { tag: "path", attrs: { d: "M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" } }
  ],
  smile: [
    { tag: "path", attrs: { d: "M15 10V9" } },
    { tag: "path", attrs: { d: "M16.472 15a6 6 0 01-8.943 0" } },
    { tag: "path", attrs: { d: "M9 10V9" } },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } }
  ],
  sparkles: [
    {
      tag: "path",
      attrs: {
        d: "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"
      }
    },
    { tag: "path", attrs: { d: "M20 2v4" } },
    { tag: "path", attrs: { d: "M22 4h-4" } },
    { tag: "circle", attrs: { cx: "4", cy: "20", r: "2" } }
  ],
  star: [
    {
      tag: "path",
      attrs: {
        d: "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"
      }
    }
  ],
  sun: [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "4" } },
    { tag: "path", attrs: { d: "M12 2v2" } },
    { tag: "path", attrs: { d: "M12 20v2" } },
    { tag: "path", attrs: { d: "m4.93 4.93 1.41 1.41" } },
    { tag: "path", attrs: { d: "m17.66 17.66 1.41 1.41" } },
    { tag: "path", attrs: { d: "M2 12h2" } },
    { tag: "path", attrs: { d: "M20 12h2" } },
    { tag: "path", attrs: { d: "m6.34 17.66-1.41 1.41" } },
    { tag: "path", attrs: { d: "m19.07 4.93-1.41 1.41" } }
  ],
  "thumbs-up": [
    {
      tag: "path",
      attrs: {
        d: "M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"
      }
    },
    { tag: "path", attrs: { d: "M7 10v12" } }
  ],
  trash: [
    { tag: "path", attrs: { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" } },
    { tag: "path", attrs: { d: "M3 6h18" } },
    { tag: "path", attrs: { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" } }
  ],
  "triangle-alert": [
    {
      tag: "path",
      attrs: { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }
    },
    { tag: "path", attrs: { d: "M12 9v4" } },
    { tag: "path", attrs: { d: "M12 17h.01" } }
  ],
  upload: [
    { tag: "path", attrs: { d: "M12 3v12" } },
    { tag: "path", attrs: { d: "m17 8-5-5-5 5" } },
    { tag: "path", attrs: { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" } }
  ],
  user: [
    { tag: "path", attrs: { d: "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" } },
    { tag: "circle", attrs: { cx: "12", cy: "7", r: "4" } }
  ]
};
let T = null;
function se(r) {
  return T == null ? void 0 : T[r];
}
const Y = "http://www.w3.org/2000/svg";
function ie(r, a, t) {
  const e = r.createElementNS(Y, a);
  for (const [d, m] of Object.entries(t)) e.setAttribute(d, m);
  return e;
}
function j(r, a = 16, t = document) {
  const e = t.createElementNS(Y, "svg");
  e.setAttribute("width", String(a)), e.setAttribute("height", String(a)), e.setAttribute("viewBox", "0 0 24 24"), e.setAttribute("fill", "none"), e.setAttribute("stroke", "currentColor"), e.setAttribute("stroke-width", "2"), e.setAttribute("stroke-linecap", "round"), e.setAttribute("stroke-linejoin", "round"), e.setAttribute("aria-hidden", "true"), e.setAttribute("data-blora-icon", r);
  const d = ce[r] ?? se(r);
  if (d)
    for (const m of d) {
      const p = ie(t, m.tag, m.attrs);
      e.appendChild(p);
    }
  return e;
}
const de = {
  collator: "en",
  months: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ],
  dow: ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
  messages: {
    "common.close": "Close",
    "common.cancel": "Cancel",
    "common.ok": "OK",
    "common.next": "Next",
    "common.prev": "Back",
    "common.skip": "Skip",
    "common.done": "Done",
    "common.copy": "Copy",
    "common.copied": "Copied",
    "common.copyFailed": "Copy failed",
    "common.backTop": "Back to top",
    "common.min": "Minimum",
    "common.max": "Maximum",
    "common.search": "Search",
    "common.clear": "Clear",
    "common.remove": "Remove",
    "common.today": "Today",
    "common.now": "Now",
    "common.confirm": "OK",
    "common.loading": "Loading",
    "common.closeDialog": "Close dialog",
    "validate.required": "This field is required",
    "validate.email": "Please enter a valid email",
    "validate.url": "Please enter a valid URL",
    "validate.number": "Please enter a valid number",
    "validate.min": "Must be ≥ {n}",
    "validate.max": "Must be ≤ {n}",
    "validate.minlength": "At least {n} characters",
    "validate.maxlength": "At most {n} characters",
    "validate.pattern": "Invalid format",
    "validate.mismatch": "Values do not match",
    "validate.async": "Validation failed",
    "validate.invalid": "Invalid input",
    "pagination.prev": "Previous page",
    "pagination.next": "Next page",
    "pagination.page": "Page {n}",
    "pagination.nav": "Pagination",
    "cascader.placeholder": "Select",
    "cascader.selectedPrefix": "Selected: ",
    "table.empty": "No data",
    "table.loading": "Loading…",
    "table.selectAll": "Select all",
    "table.selectRow": "Select row",
    "table.selected": "{n} selected",
    "table.clearSelection": "Clear selection",
    "table.bulk": "Bulk actions",
    "table.cols": "Columns",
    "table.colsReset": "Reset columns",
    "table.colDrag": "Drag to reorder",
    "select.search": "Search…",
    "select.empty": "No matches",
    "select.placeholder": "Select",
    "select.more": "+{n}",
    "select.remove": "Remove {label}",
    "palette.title": "Palette",
    "palette.hint": "Semantic colors only — component shapes stay the same",
    "palette.label": "Palette",
    "colorMode.system": "System",
    "colorMode.light": "Light",
    "colorMode.dark": "Dark",
    "colorMode.switchToLight": "Switch to light theme",
    "colorMode.switchToDark": "Switch to dark theme",
    "upload.remove": "Remove",
    "upload.drop": "Drop files here",
    "upload.or": "or",
    "upload.browse": "browse",
    "upload.choose": "Choose a file",
    "upload.hint": "Choose a file or drop it here",
    "file.clear": "Remove selected file",
    "preview.prev": "Previous image",
    "preview.next": "Next image",
    "preview.close": "Close preview",
    "preview.label": "Image preview",
    "tour.start": "Start tour",
    "tour.step": "{current} / {total}",
    "autocomplete.empty": "No matches",
    "color.swatch": "Pick color, current {color}",
    "color.panel": "Color picker",
    "color.hue": "Hue",
    "color.spectrum": "Saturation and brightness",
    "color.hex": "Hex color",
    "breadcrumb.label": "Breadcrumb",
    "carousel.prev": "Previous slide",
    "carousel.next": "Next slide",
    "carousel.label": "Carousel",
    "carousel.goto": "Go to slide {n}",
    "calendar.prev": "Previous period",
    "calendar.next": "Next period",
    "calendar.monthYear": "{month} {year}",
    "calendar.year": "{year}",
    "calendar.decade": "{start}–{end}",
    "command.placeholder": "Type a command or search…",
    "command.clear": "Clear",
    "copy.label": "Copy",
    "copy.show": "Show value",
    "copy.hide": "Hide value",
    "datepicker.pick": "Choose date",
    "timepicker.pick": "Choose time",
    "timepicker.hour": "Hour",
    "timepicker.minute": "Minute",
    "drawer.title": "Drawer",
    "empty.title": "No data",
    "megamenu.label": "Browse",
    "number.decrease": "Decrease",
    "number.increase": "Increase",
    "rate.of": "{n} of {max}",
    "rate.label": "Rating",
    "search.label": "Search",
    "search.placeholder": "Search…",
    "speedDial.label": "Actions",
    "swap.on": "On",
    "swap.off": "Off",
    "tags.remove": "Remove",
    "tags.removeNamed": "Remove {label}",
    "tags.label": "Tags",
    "transfer.moveRight": "Move right",
    "transfer.moveLeft": "Move left",
    "transfer.source": "Available",
    "transfer.target": "Selected",
    "transfer.sourceCount": "Available · {n}",
    "transfer.targetCount": "Selected · {n}",
    "dropdown.label": "Menu",
    "popconfirm.trigger": "Delete",
    "popconfirm.message": "Are you sure?",
    "popover.trigger": "Open popover",
    "progress.label": "Progress",
    "otp.label": "One-time password",
    "otp.char": "Character {n} of {total}",
    "sidebar.label": "Sidebar navigation",
    "mockup.window": "Window",
    "mockup.label": "{variant} mockup",
    "navbar.title": "Blora Design",
    "deck.label": "Card stack",
    "dock.label": "Dock",
    "diff.position": "Compare position",
    "countdown.days": "Days",
    "countdown.hours": "Hours",
    "countdown.minutes": "Minutes",
    "countdown.seconds": "Seconds",
    "countdown.aria": "{days}d {hours}h {minutes}m {seconds}s",
    "gallery.label": "Gallery",
    "gallery.slide": "{label}, image {current} / {total}",
    "thread.expand": "Expand comments",
    "thread.collapse": "Collapse comments",
    "thread.edit": "Edit",
    "thread.preview": "Preview",
    "qrcode.tooLong": "QR value is too long to encode",
    "layout.menu": "Menu",
    "theme.name.coral": "Coral",
    "theme.name.indigo": "Indigo",
    "theme.name.graphite": "Graphite",
    "theme.name.mono": "Mono",
    "theme.name.circuit": "Circuit",
    "theme.name.dusk": "Dusk",
    "theme.coral": "Warm coral on cool indigo grey",
    "theme.indigo": "Cool grey with quiet blue",
    "theme.graphite": "Cool grey with steel blue",
    "theme.mono": "Neutral grey and near-black",
    "theme.circuit": "Carbon grey with restrained teal",
    "theme.dusk": "Dusk grey-violet"
  }
}, me = {
  collator: "zh-CN",
  months: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
  dow: ["日", "一", "二", "三", "四", "五", "六"],
  messages: {
    "common.close": "关闭",
    "common.cancel": "取消",
    "common.ok": "确定",
    "common.next": "下一步",
    "common.prev": "上一步",
    "common.skip": "跳过",
    "common.done": "完成",
    "common.copy": "复制",
    "common.copied": "已复制",
    "common.copyFailed": "复制失败",
    "common.backTop": "回到顶部",
    "common.min": "最小值",
    "common.max": "最大值",
    "common.search": "搜索",
    "common.clear": "清除",
    "common.remove": "移除",
    "common.today": "今天",
    "common.now": "此刻",
    "common.confirm": "确定",
    "common.loading": "加载中",
    "common.closeDialog": "关闭对话框",
    "validate.required": "此字段为必填项",
    "validate.email": "请输入有效邮箱",
    "validate.url": "请输入有效的网址",
    "validate.number": "请输入有效数字",
    "validate.min": "不能小于 {n}",
    "validate.max": "不能大于 {n}",
    "validate.minlength": "至少输入 {n} 个字符",
    "validate.maxlength": "最多输入 {n} 个字符",
    "validate.pattern": "格式不正确",
    "validate.mismatch": "输入不匹配",
    "validate.async": "校验未通过",
    "validate.invalid": "无效输入",
    "pagination.prev": "上一页",
    "pagination.next": "下一页",
    "pagination.page": "第 {n} 页",
    "pagination.nav": "分页",
    "cascader.placeholder": "请选择",
    "cascader.selectedPrefix": "已选：",
    "table.empty": "暂无数据",
    "table.loading": "加载中…",
    "table.selectAll": "全选",
    "table.selectRow": "选择行",
    "table.selected": "已选 {n} 项",
    "table.clearSelection": "清除选择",
    "table.bulk": "批量操作",
    "table.cols": "列设置",
    "table.colsReset": "重置列",
    "table.colDrag": "拖动排序",
    "select.search": "搜索…",
    "select.empty": "无匹配选项",
    "select.placeholder": "请选择",
    "select.more": "+{n}",
    "select.remove": "移除 {label}",
    "palette.title": "主题配色",
    "palette.hint": "选择一套调色板",
    "palette.label": "主题配色",
    "colorMode.system": "跟随系统",
    "colorMode.light": "浅色",
    "colorMode.dark": "深色",
    "colorMode.switchToLight": "切换为亮色主题",
    "colorMode.switchToDark": "切换为暗色主题",
    "upload.remove": "移除",
    "upload.drop": "拖拽文件至此",
    "upload.or": "或",
    "upload.browse": "点击选择",
    "upload.choose": "选择文件",
    "upload.hint": "点击选择或拖拽文件至此",
    "file.clear": "移除已选文件",
    "preview.prev": "上一张",
    "preview.next": "下一张",
    "preview.close": "关闭预览",
    "preview.label": "图片预览",
    "tour.start": "开始漫游",
    "tour.step": "{current} / {total}",
    "autocomplete.empty": "无匹配项",
    "color.swatch": "选择颜色，当前 {color}",
    "color.panel": "选择颜色",
    "color.hue": "色相",
    "color.spectrum": "颜色饱和度与明度",
    "color.hex": "十六进制颜色",
    "breadcrumb.label": "面包屑",
    "carousel.prev": "上一张",
    "carousel.next": "下一张",
    "carousel.label": "轮播图",
    "carousel.goto": "转到第 {n} 张",
    "calendar.prev": "上一个",
    "calendar.next": "下一个",
    "calendar.monthYear": "{year}年{month}",
    "calendar.year": "{year}年",
    "calendar.decade": "{start}–{end}年",
    "command.placeholder": "输入命令或搜索...",
    "command.clear": "清除",
    "copy.label": "复制",
    "copy.show": "显示内容",
    "copy.hide": "隐藏内容",
    "datepicker.pick": "选择日期",
    "timepicker.pick": "选择时间",
    "timepicker.hour": "时",
    "timepicker.minute": "分",
    "drawer.title": "抽屉",
    "empty.title": "暂无数据",
    "megamenu.label": "浏览产品",
    "number.decrease": "减少",
    "number.increase": "增加",
    "rate.of": "{n} / {max}",
    "rate.label": "评分",
    "search.label": "搜索",
    "search.placeholder": "搜索…",
    "speedDial.label": "操作",
    "swap.on": "已开启",
    "swap.off": "已关闭",
    "tags.remove": "移除",
    "tags.removeNamed": "移除 {label}",
    "tags.label": "标签",
    "transfer.moveRight": "右移",
    "transfer.moveLeft": "左移",
    "transfer.source": "候选",
    "transfer.target": "已选",
    "transfer.sourceCount": "候选 · {n}",
    "transfer.targetCount": "已选 · {n}",
    "dropdown.label": "菜单",
    "popconfirm.trigger": "删除",
    "popconfirm.message": "确定要执行此操作？",
    "popover.trigger": "打开弹出层",
    "progress.label": "进度",
    "otp.label": "一次性密码",
    "otp.char": "第 {n} 位，共 {total} 位",
    "sidebar.label": "侧栏导航",
    "mockup.window": "窗口",
    "mockup.label": "{variant} 样机",
    "navbar.title": "Blora Design",
    "deck.label": "卡片叠层",
    "dock.label": "底部导航",
    "diff.position": "对比位置",
    "countdown.days": "天",
    "countdown.hours": "时",
    "countdown.minutes": "分",
    "countdown.seconds": "秒",
    "countdown.aria": "{days} 天 {hours} 小时 {minutes} 分 {seconds} 秒",
    "gallery.label": "图片库",
    "gallery.slide": "{label}，图片 {current} / {total}",
    "thread.expand": "展开评论",
    "thread.collapse": "收起评论",
    "thread.edit": "编辑",
    "thread.preview": "预览",
    "qrcode.tooLong": "二维码内容过长，无法编码",
    "layout.menu": "菜单",
    "theme.name.coral": "珊瑚",
    "theme.name.indigo": "靛蓝",
    "theme.name.graphite": "石墨",
    "theme.name.mono": "单色",
    "theme.name.circuit": "电路",
    "theme.name.dusk": "暮色",
    "theme.coral": "深靛灰与柔和珊瑚红",
    "theme.indigo": "冷灰基底与沉静蓝",
    "theme.graphite": "冷灰界面与低饱和钢蓝",
    "theme.mono": "纯中性灰与近黑主色",
    "theme.circuit": "碳灰界面与克制青色",
    "theme.dusk": "暮色灰紫"
  }
}, M = /* @__PURE__ */ new Map([
  ["en", de],
  ["zh-CN", me]
]);
let U = "en", W = !1, Z = !1;
function he(r) {
  const a = r.trim();
  if (!a) return "en";
  if (/^zh\b/i.test(a)) return "zh-CN";
  if (M.has(a)) return a;
  const t = a.split("-")[0] ?? "en";
  return M.has(t) ? t : "en";
}
function pe(r) {
  r.dispatchEvent(new CustomEvent("blora-locale-change", { bubbles: !0 }));
}
function ue(r = typeof document < "u" ? document : null) {
  r && (Z = !1, U = he(r.documentElement.lang || ""), pe(r));
}
function ge() {
  W || typeof document > "u" || (W = !0, Z || ue(document));
}
function i(r, a) {
  var d;
  ge();
  const t = M.get(U) ?? M.get("en");
  return (t == null ? void 0 : t.messages[r]) ?? ((d = M.get("en")) == null ? void 0 : d.messages[r]) ?? r;
}
const A = {
  coral: {
    name: "Coral",
    description: "",
    colors: ["#FAF7F8", "#303143", "#9F5964", "#5D6680", "#5B756B"]
  },
  indigo: {
    name: "Indigo",
    description: "",
    colors: ["#F4F5F8", "#405D87", "#55756F", "#A74B52", "#AF8A55"]
  },
  graphite: {
    name: "Graphite",
    description: "",
    colors: ["#F6F7F8", "#171A1F", "#4F6578", "#596A86", "#5B756B"]
  },
  mono: {
    name: "Mono",
    description: "",
    colors: ["#FAFAF9", "#111110", "#34363A", "#5E6672", "#616D67"]
  },
  circuit: {
    name: "Circuit",
    description: "",
    colors: ["#F4F5F5", "#161A1A", "#3E6C70", "#536D7D", "#4F7368"]
  },
  dusk: {
    name: "Dusk",
    description: "",
    colors: ["#F6F4F8", "#3A3548", "#7A6B8A", "#5A6B7A", "#8A7A6A"]
  }
}, N = "blora-theme";
function ke() {
  const r = JSON.stringify(Object.keys(A)), a = JSON.stringify(N), t = JSON.stringify(F);
  return `(function(){var r=document.documentElement,t=${r},s="coral",c="light";try{var saved=localStorage.getItem(${a});if(saved&&t.indexOf(saved)!==-1)s=saved;var storedScheme=localStorage.getItem(${t});if(storedScheme==="dark"||storedScheme==="light")c=storedScheme;}catch(e){}r.setAttribute("data-blora-theme",s);r.setAttribute("data-blora-color-scheme",c);r.style.colorScheme=c;}());`;
}
function Q(r = document.documentElement) {
  return r.getAttribute("data-blora-theme") || "coral";
}
const F = "blora-color-scheme";
function X(r = document.documentElement) {
  return r.getAttribute("data-blora-color-scheme") === "dark" ? "dark" : "light";
}
function ee(r, a) {
  const t = r.body;
  t && (t.style.backgroundColor = "", t.style.color = "", t.removeAttribute("data-blora-color-scheme"), a && (t.style.colorScheme = a));
  for (const e of r.querySelectorAll(".blora-scope"))
    e.removeAttribute("data-blora-color-scheme"), a && (e.style.colorScheme = a);
}
function B(r, a = document.documentElement, t) {
  if (typeof document > "u") return;
  const e = a.ownerDocument ?? document;
  if (a.setAttribute("data-blora-color-scheme", r), a.style.colorScheme = r, ee(e, r), (t == null ? void 0 : t.persist) !== !1)
    try {
      localStorage.setItem(F, r);
    } catch {
    }
  (t == null ? void 0 : t.emit) !== !1 && a.dispatchEvent(
    new CustomEvent("blora-color-scheme-change", {
      bubbles: !0,
      detail: { scheme: r }
    })
  );
}
function te(r, a = document.documentElement, t) {
  if (typeof document > "u") return;
  const e = A[r] ? r : "coral";
  if (a.setAttribute("data-blora-theme", e), ee(a.ownerDocument ?? document), a.hasAttribute("data-blora-color-scheme") || B("light", a, { persist: !1, emit: !1 }), (t == null ? void 0 : t.persist) !== !1)
    try {
      localStorage.setItem(N, e);
    } catch {
    }
  (t == null ? void 0 : t.emit) !== !1 && a.dispatchEvent(
    new CustomEvent("blora-theme-change", { bubbles: !0, detail: { theme: e } })
  );
}
function be(r = document.documentElement) {
  let a = "coral";
  try {
    a = localStorage.getItem(N) || a;
  } catch {
  }
  A[a] || (a = "coral");
  let t = X(r);
  try {
    const e = localStorage.getItem(F);
    !r.hasAttribute("data-blora-color-scheme") && (e === "dark" || e === "light") && (t = e);
  } catch {
  }
  return r.hasAttribute("data-blora-color-scheme") || B(t, r, { persist: !1, emit: !1 }), te(a, r, { persist: !1, emit: !1 }), a;
}
function ve(r) {
  if (typeof document > "u")
    return { close: () => {
    }, destroy: () => {
    }, open: () => {
    } };
  const a = r.ownerDocument, t = r.querySelector(
    "[data-blora-palette-trigger], .blora-palette-picker__trigger"
  );
  let e = r.querySelector(".blora-palette-picker__menu");
  if (!t) return { close: () => {
  }, destroy: () => {
  }, open: () => {
  } };
  e || (e = a.createElement("div"), e.className = "blora-palette-picker__menu", r.appendChild(e));
  const d = typeof e.showPopover == "function" && typeof e.hidePopover == "function";
  let m = !1;
  if (be(a.documentElement), t.setAttribute("aria-haspopup", "listbox"), t.setAttribute("aria-expanded", "false"), e.setAttribute("role", "listbox"), e.setAttribute("aria-label", i("palette.label")), e.setAttribute("popover", "manual"), e.hidden = !0, !e.querySelector("[data-blora-palette-option]")) {
    const o = a.createElement("div");
    o.className = "blora-palette-picker__head";
    const l = a.createElement("span");
    l.className = "blora-palette-picker__title", l.textContent = i("palette.title");
    const c = a.createElement("span");
    c.className = "blora-palette-picker__hint", c.textContent = i("palette.hint"), o.append(l, c);
    const n = a.createElement("div");
    n.className = "blora-palette-picker__list";
    for (const [s, g] of Object.entries(A)) {
      const h = a.createElement("button");
      h.className = "blora-palette-card", h.type = "button", h.setAttribute("role", "option"), h.setAttribute("data-blora-palette-option", s);
      const f = a.createElement("span");
      f.className = "blora-palette-card__copy";
      const b = a.createElement("span");
      b.className = "blora-palette-card__name", b.textContent = i(`theme.name.${s}`);
      const k = a.createElement("span");
      k.className = "blora-palette-card__desc", k.textContent = i(`theme.${s}`), f.append(b, k);
      const y = a.createElement("span");
      y.className = "blora-palette-card__colors", y.setAttribute("aria-hidden", "true");
      for (const C of g.colors) {
        const w = a.createElement("span");
        w.className = "blora-palette-card__color", w.style.background = C, y.append(w);
      }
      h.append(f, y), n.append(h);
    }
    e.replaceChildren(o, n);
  }
  const p = () => Array.from(e.querySelectorAll("[data-blora-palette-option]")), u = () => {
    const o = Q(a.documentElement);
    p().forEach(
      (c) => c.setAttribute(
        "aria-selected",
        String(c.getAttribute("data-blora-palette-option") === o)
      )
    );
    const l = t.querySelector(".blora-palette-picker__label");
    l && A[o] && (l.textContent = i(`theme.name.${o}`));
  }, re = () => {
    e.style.removeProperty("position"), e.style.removeProperty("top"), e.style.removeProperty("left"), e.style.removeProperty("right"), e.style.removeProperty("width"), e.style.removeProperty("max-width"), e.style.removeProperty("max-height"), e.style.removeProperty("overflow-y");
  }, R = () => {
    const o = t.getBoundingClientRect(), l = e.offsetWidth, c = e.offsetHeight, n = 16, s = 8, g = Math.max(0, window.innerHeight - o.bottom - s - n), h = Math.max(0, o.top - s - n), f = c > g && h > g, b = f ? h : g, k = f ? Math.max(n, o.top - s - Math.min(c, b)) : Math.max(n, o.bottom + s), y = (o.left + o.right) / 2 > window.innerWidth / 2, C = o.left + l <= window.innerWidth - n, w = o.right - l >= n, oe = y ? w || !C : !C && w;
    e.style.position = "fixed", e.style.top = `${k}px`, c > b ? (e.style.maxHeight = `${b}px`, e.style.overflowY = "auto") : (e.style.removeProperty("max-height"), e.style.removeProperty("overflow-y"));
    const G = Math.max(n, window.innerWidth - n - l);
    if (oe) {
      const D = Math.min(Math.max(n, window.innerWidth - o.right), G);
      e.style.left = "auto", e.style.right = `${D}px`;
    } else {
      const D = Math.min(Math.max(n, o.left), G);
      e.style.left = `${D}px`, e.style.right = "auto";
    }
  }, S = (o = !1) => {
    var l;
    if (window.clearTimeout(v), d ? (m && e.hidePopover(), e.hidden = !1, e.showPopover(), m = !0) : e.hidden = !1, e.offsetWidth, a.querySelectorAll("[data-blora-palette-picker][data-open]").forEach((c) => {
      var s;
      if (c === r) return;
      c.removeAttribute("data-open"), (s = c.querySelector("[data-blora-palette-trigger], .blora-palette-picker__trigger")) == null || s.setAttribute("aria-expanded", "false");
      const n = c.querySelector(".blora-palette-picker__menu");
      n && (d ? n.matches(":popover-open") && n.hidePopover() : n.hidden = !0, n.style.removeProperty("position"), n.style.removeProperty("top"), n.style.removeProperty("left"), n.style.removeProperty("right"), n.style.removeProperty("width"), n.style.removeProperty("max-width"));
    }), r.setAttribute("data-open", ""), t.setAttribute("aria-expanded", "true"), R(), o) {
      const c = p();
      (l = c.find((n) => n.getAttribute("aria-selected") === "true") || c[0]) == null || l.focus();
    }
  };
  let v = 0;
  const _ = () => {
    e.removeEventListener("transitionend", L), window.clearTimeout(v), v = 0, r.hasAttribute("data-open") || (d && m && (e.hidePopover(), m = !1), e.hidden = !0, re());
  }, L = (o) => {
    o.target !== e || o.propertyName !== "transform" || _();
  }, x = (o = !1) => {
    r.removeAttribute("data-open"), t.setAttribute("aria-expanded", "false"), e.removeEventListener("transitionend", L), e.addEventListener("transitionend", L), window.clearTimeout(v), v = window.setTimeout(_, 320), o && t.focus();
  }, H = (o) => {
    o.stopPropagation(), r.hasAttribute("data-open") ? x() : S();
  }, O = (o) => {
    o.key === "ArrowDown" && (o.preventDefault(), S(!0));
  }, z = (o) => {
    const l = o.target.closest("[data-blora-palette-option]");
    l && (te(l.getAttribute("data-blora-palette-option") || "coral", a.documentElement), u(), x(!0));
  }, q = (o) => {
    var s;
    const l = p(), c = l.indexOf(a.activeElement);
    let n = c;
    if (o.key === "ArrowDown" || o.key === "ArrowRight")
      n = (c + 1 + l.length) % l.length;
    else if (o.key === "ArrowUp" || o.key === "ArrowLeft")
      n = (c - 1 + l.length) % l.length;
    else if (o.key === "Home") n = 0;
    else if (o.key === "End") n = l.length - 1;
    else if (o.key === "Escape") {
      o.preventDefault(), x(!0);
      return;
    } else return;
    o.preventDefault(), (s = l[n]) == null || s.focus();
  }, I = (o) => {
    r.contains(o.target) || x();
  }, V = () => u(), E = () => {
    r.hasAttribute("data-open") && R();
  };
  t.addEventListener("click", H), t.addEventListener("keydown", O), e.addEventListener("click", z), e.addEventListener("keydown", q), a.addEventListener("click", I);
  const $ = () => {
    e == null || e.querySelectorAll("[data-blora-palette-option]").forEach((c) => {
      const n = c.getAttribute("data-blora-palette-option");
      if (!n) return;
      const s = c.querySelector(".blora-palette-card__name"), g = c.querySelector(".blora-palette-card__desc");
      s && (s.textContent = i(`theme.name.${n}`)), g && (g.textContent = i(`theme.${n}`));
    });
    const o = e == null ? void 0 : e.querySelector(".blora-palette-picker__title"), l = e == null ? void 0 : e.querySelector(".blora-palette-picker__hint");
    o && (o.textContent = i("palette.title")), l && (l.textContent = i("palette.hint")), u();
  };
  return a.addEventListener("blora-locale-change", $), a.documentElement.addEventListener("blora-theme-change", V), window.addEventListener("resize", E), window.addEventListener("scroll", E, !0), u(), {
    close: () => x(!0),
    destroy() {
      window.clearTimeout(v), t.removeEventListener("click", H), t.removeEventListener("keydown", O), e.removeEventListener("click", z), e.removeEventListener("keydown", q), e.removeEventListener("transitionend", _), a.removeEventListener("click", I), a.removeEventListener("blora-locale-change", $), a.documentElement.removeEventListener("blora-theme-change", V), window.removeEventListener("resize", E), window.removeEventListener("scroll", E, !0);
    },
    open: () => S(!0)
  };
}
const K = "blora-palette-picker", J = "blora-color-scheme-toggle", ae = typeof HTMLElement < "u" ? HTMLElement : class {
};
class fe extends ae {
  constructor() {
    super(...arguments);
    P(this, "controller", null);
  }
  static get observedAttributes() {
    return ["button-variant", "size", "icon-only"];
  }
  connectedCallback() {
    this.render();
  }
  disconnectedCallback() {
    var t;
    (t = this.controller) == null || t.destroy(), this.controller = null;
  }
  attributeChangedCallback() {
    this.isConnected && this.render();
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
    var p;
    (p = this.controller) == null || p.destroy();
    const t = this.ownerDocument.createElement("div");
    t.className = "blora-palette-picker", t.dataset.bloraGenerated = "";
    const e = this.ownerDocument.createElement("button");
    if (e.type = "button", e.className = "blora-button blora-palette-picker__trigger", e.dataset.variant = this.getAttribute("button-variant") ?? "outline", e.dataset.size = this.getAttribute("size") ?? "sm", e.dataset.bloraPaletteTrigger = "", e.appendChild(j("palette", 18, this.ownerDocument)), this.hasAttribute("icon-only"))
      e.dataset.iconOnly = "", e.setAttribute("aria-label", i("palette.title"));
    else {
      const u = this.ownerDocument.createElement("span");
      u.className = "blora-palette-picker__label", u.textContent = i(`theme.name.${Q(this.ownerDocument.documentElement)}`), e.appendChild(u);
    }
    const m = this.ownerDocument.createElement("div");
    m.className = "blora-palette-picker__menu", t.append(e, m), this.replaceChildren(t), this.controller = ve(t);
  }
}
class ye extends ae {
  constructor() {
    super(...arguments);
    P(this, "sync", () => this.render());
  }
  static get observedAttributes() {
    return ["button-variant", "size"];
  }
  connectedCallback() {
    this.ownerDocument.documentElement.addEventListener("blora-color-scheme-change", this.sync), this.render();
  }
  disconnectedCallback() {
    this.ownerDocument.documentElement.removeEventListener("blora-color-scheme-change", this.sync);
  }
  attributeChangedCallback() {
    this.isConnected && this.render();
  }
  render() {
    const t = X(this.ownerDocument.documentElement), e = this.ownerDocument.createElement("button");
    e.type = "button", e.className = "blora-button blora-color-scheme-toggle__button", e.dataset.variant = this.getAttribute("button-variant") ?? "ghost", e.dataset.size = this.getAttribute("size") ?? "sm", e.setAttribute(
      "aria-label",
      i(t === "dark" ? "colorMode.switchToLight" : "colorMode.switchToDark")
    ), e.appendChild(j(t === "dark" ? "sun" : "moon", 18, this.ownerDocument)), e.addEventListener("click", () => {
      B(t === "dark" ? "light" : "dark", this.ownerDocument.documentElement);
    }), this.replaceChildren(e);
  }
}
function we(r = customElements) {
  r.get(K) || r.define(K, fe), r.get(J) || r.define(J, ye);
}
typeof customElements < "u" && we(customElements);
export {
  J as BLORA_COLOR_SCHEME_TOGGLE_TAG,
  K as BLORA_PALETTE_PICKER_TAG,
  ye as BloraColorSchemeToggle,
  fe as BloraPalettePicker,
  A as THEME_PRESETS,
  B as applyColorScheme,
  te as applyTheme,
  be as bootThemeFromStorage,
  we as defineBloraThemingElements,
  X as getColorScheme,
  Q as getTheme,
  ke as getThemeBootScript
};
