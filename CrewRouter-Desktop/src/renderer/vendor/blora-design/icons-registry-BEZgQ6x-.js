let r = null;
function o(n) {
  r = { ...r ?? {}, ...n };
}
function t(n) {
  return r == null ? void 0 : r[n];
}
function e(n) {
  return Object.prototype.hasOwnProperty.call(r ?? {}, n);
}
export {
  e as h,
  t as l,
  o as r
};
