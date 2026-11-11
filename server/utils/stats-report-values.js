'use strict';

const MAX_VALUE = Number.MAX_SAFE_INTEGER;
const GROUPS = {
  requests: ['total', 'success', 'error'],
  tokens: ['prompt', 'completion', 'cached', 'total'],
};
const COUNTS = ['activeUsers', 'activeKeys', 'activeModels', 'activeProviders'];
const MEASURES = ['cost', 'avgLatencyMs'];
const BREAKDOWNS = ['requestTypes', 'models', 'providers'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validNumber = (value, integer) => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && value <= MAX_VALUE && (!integer || Number.isSafeInteger(value));

// Missing fields remain optional for older/counts-only reporters. Unknown metadata is not interpreted.
function normalizeStats(value) {
  if (!isObject(value)) return { valid: false, stats: {} };
  const stats = {};
  let valid = true;
  function number(source, target, key, integer) {
    if (!Object.hasOwn(source, key)) return;
    if (validNumber(source[key], integer)) target[key] = source[key];
    else { valid = false; target[key] = 0; }
  }
  for (const [group, keys] of Object.entries(GROUPS)) {
    if (!Object.hasOwn(value, group)) continue;
    stats[group] = {};
    if (!isObject(value[group])) { valid = false; continue; }
    for (const key of keys) number(value[group], stats[group], key, true);
  }
  for (const key of COUNTS) number(value, stats, key, true);
  for (const key of MEASURES) number(value, stats, key, false);
  for (const key of BREAKDOWNS) {
    if (!Object.hasOwn(value, key)) continue;
    stats[key] = [];
    if (!Array.isArray(value[key])) { valid = false; continue; }
    for (const entry of value[key]) {
      if (!isObject(entry)) { valid = false; continue; }
      if (Object.hasOwn(entry, 'name') && typeof entry.name !== 'string') { valid = false; continue; }
      const row = {};
      if (Object.hasOwn(entry, 'name')) row.name = entry.name;
      number(entry, row, 'requests', true);
      number(entry, row, 'tokens', true);
      stats[key].push(row);
    }
  }
  return { valid, stats };
}

// JSONB numbers already fit PostgreSQL numeric; strings and containers never reach the cast.
function safeMetricSql(path, integer = true) {
  const json = `payload #> '{stats,${path}}'`;
  const numeric = `(payload #>> '{stats,${path}}')::numeric`;
  return `(CASE WHEN jsonb_typeof(${json}) = 'number' THEN
    CASE WHEN ${numeric} BETWEEN 0 AND ${MAX_VALUE}${integer ? ` AND trunc(${numeric}) = ${numeric}` : ''}
      THEN ${numeric} ELSE 0 END ELSE 0 END)`;
}

// The public page expects numbers. Saturate aggregates rather than rounding unsafe integers or emitting Infinity/null.
function publicNumber(value) {
  const number = Number(value || 0);
  if (Number.isNaN(number) || number < 0) return 0;
  return Math.min(number, MAX_VALUE);
}

module.exports = { isObject, normalizeStats, safeMetricSql, publicNumber };
