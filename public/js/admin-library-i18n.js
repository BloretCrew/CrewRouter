/* Translate library UI keys at render time; names and input values stay caller-owned. */
(() => {
  'use strict';

  function AdminLibraryText(key, vars) {
    if (typeof window.t === 'function') return window.t(key, vars);
    if (key == null || key === '') return key;
    return String(key).replace(/\{(\w+)\}/g, (match, name) =>
      vars && Object.prototype.hasOwnProperty.call(vars, name) && vars[name] != null ? String(vars[name]) : match);
  }

  // Escape after interpolation, including names and server error messages.
  AdminLibraryText.html = (key, vars) => String(AdminLibraryText(key, vars) ?? '').replace(/[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  AdminLibraryText.attr = AdminLibraryText.html;

  window.AdminLibraryText = AdminLibraryText;
})();
