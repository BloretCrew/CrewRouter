'use strict';

const legacyConfig = require('./config-loader');

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = clone(item);
    return Object.freeze(result);
  }
  return value;
}

const snapshot = clone(legacyConfig);

function get(path, fallback) {
  if (!path) return snapshot;
  const value = String(path).split('.').reduce((current, key) => current && current[key], snapshot);
  return value === undefined ? fallback : value;
}

function has(path) {
  return get(path, undefined) !== undefined;
}

module.exports = Object.freeze({
  get,
  has,
  snapshot,
  // Explicit name keeps call sites readable while preserving the legacy export.
  getConfig: get
});
