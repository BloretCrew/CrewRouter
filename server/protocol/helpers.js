'use strict';

function omitKnown(value, known) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!known.has(key)) result[key] = item;
  }
  return result;
}

function withPassthrough(base, passthrough) {
  return { ...(passthrough || {}), ...base };
}

function safeParseJson(value, fallback = {}) {
  if (typeof value !== 'string') return value == null ? fallback : value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map(block => {
    if (typeof block === 'string') return block;
    return block?.text || '';
  }).join('\n');
}

module.exports = { omitKnown, withPassthrough, safeParseJson, contentToText };
