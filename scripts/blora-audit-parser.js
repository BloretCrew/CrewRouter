'use strict';

function scanHtml(html) {
  const counts = { controls: 0, nativeDialogs: 0, forms: 0, tables: 0, states: 0, legacyModalContainers: 0 };
  let i = 0;
  while (i < html.length) {
    const start = html.indexOf('<', i);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const tagMatch = html.slice(start).match(/^<([A-Za-z][\w:-]*)\b/);
    if (!tagMatch) { i = start + 1; continue; }
    const tag = tagMatch[1].toLowerCase();
    let cursor = start + tagMatch[0].length;
    let quote = null;
    while (cursor < html.length) {
      const char = html[cursor];
      if (quote) { if (char === quote) quote = null; cursor++; continue; }
      if (char === '"' || char === "'") { quote = char; cursor++; continue; }
      if (char === '>') { cursor++; break; }
      cursor++;
    }
    const attrs = html.slice(start + tagMatch[0].length, cursor).toLowerCase();
    if (/^(button|input|select|textarea)$/.test(tag)) counts.controls++;
    if (tag === 'dialog') counts.nativeDialogs++;
    if (tag === 'form') counts.forms++;
    if (tag === 'table') counts.tables++;
    const classValue = attrs.match(/\bclass\s*=\s*["']([^"']*)["']/)?.[1] || '';
    const semanticAttrs = attrs.match(/\b(?:class|id|role|aria-busy|aria-label)\s*=\s*["']([^"']*)["']/g)?.join(' ') || '';
    if (/(?:^|[\s_-])modal(?:[\s_-]|$)/i.test(classValue)) counts.legacyModalContainers++;
    if (/(?:loading|error|empty|success|status|disabled)/i.test(semanticAttrs)) counts.states++;
    i = cursor;
  }
  return counts;
}

module.exports = { scanHtml };
