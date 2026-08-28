'use strict';

let INJECT_MITIGATION_PREFIX = '[System-injected reference notes';
try { ({ INJECT_MITIGATION_PREFIX } = require('./inject-prompt')); } catch { /* 独立使用时回退 */ }
const INJECT_HEADER_TITLE = '# User Custom Instructions (CrewRouter)';
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 新格式必须以标签/独立标题开始，允许正文后单换行；不匹配普通内联文字。
const SYSTEM_REMINDER_RE = /(^|\n|\r\n)[ \t]*<system-reminder>[\s\S]*?#\s*claudeMd\b[\s\S]*?<\/system-reminder>[ \t]*/gi;
const CLAUDE_SECTION_RE = /(^|\n|\r\n)[ \t]*#\s*claudeMd\b[ \t]*\r?\n[\s\S]*?(?=\n[ \t]*#\s+currentDate\b|\n[ \t]*<\/system-reminder>|$)/gi;
const LEGACY_HEADER_RE = new RegExp('(^|\\n\\n|\\r\\n\\r\\n)[ \\t]*' + escapeRegExp(INJECT_HEADER_TITLE) + '[ \\t]*\\r?\\n[\\s\\S]*?(?=\\n\\n---\\n\\n|$)', 'g');
const LEGACY_FULL_RE = new RegExp('(^|\\n|\\r\\n)' + escapeRegExp(INJECT_MITIGATION_PREFIX) + '[^\\n]*\\r?\\n(?:[ \\t]*\\r?\\n)+[ \\t]*' + escapeRegExp(INJECT_HEADER_TITLE) + '[ \\t]*\\r?\\n[\\s\\S]*?(?=\\n\\n---\\n\\n|$)', 'g');

function exactCandidates(text) {
  const out = new Set();
  const add = s => { if (typeof s === 'string' && s.trim()) out.add(s); };
  add(text);
  if (typeof text === 'string') {
    add(text.replace(/\n+$/, ''));
    const marker = text.indexOf('<system-reminder>');
    if (marker >= 0) {
      add(text.slice(marker));
      const claude = text.indexOf('# claudeMd', marker);
      if (claude >= 0) add(text.slice(claude));
    }
    const header = text.indexOf(INJECT_HEADER_TITLE);
    if (header >= 0) add(text.slice(header));
  }
  return [...out];
}

function scrubInjectedEcho(text, options = {}) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  let changed = false;
  for (const candidate of exactCandidates(options.exactText || '')) {
    if (out.includes(candidate)) { out = out.split(candidate).join(''); changed = true; }
  }
  for (const re of [SYSTEM_REMINDER_RE, LEGACY_FULL_RE, LEGACY_HEADER_RE]) {
    re.lastIndex = 0;
    if (re.test(out)) { re.lastIndex = 0; out = out.replace(re, (_, boundary) => boundary); changed = true; }
    re.lastIndex = 0;
  }
  if (!changed) return text;
  out = out.replace(/^(?:\r?\n)+/, '').replace(/^(?:\r?\n)*---(?:\r?\n)+/, '').replace(/\s+$/, '');
  return out.trim() === '' ? '' : out;
}

function scrubOpenAiChatCompletion(data, injectPromptText) {
  if (!injectPromptText || !data || !Array.isArray(data.choices)) return false;
  let changed = false;
  for (const choice of data.choices) {
    const msg = choice?.message;
    if (!msg) continue;
    const parts = typeof msg.content === 'string' ? [{ get: () => msg.content, set: v => { msg.content = v; } }] : Array.isArray(msg.content) ? msg.content.filter(p => p?.type === 'text').map(p => ({ get: () => p.text, set: v => { p.text = v; } })) : [];
    for (const part of parts) { const before = part.get(); const after = scrubInjectedEcho(before, { exactText: injectPromptText }); if (after !== before) { part.set(after); changed = true; } }
  }
  return changed;
}
function scrubAnthropicResponse(data, injectPromptText) {
  if (!injectPromptText || !data || !Array.isArray(data.content)) return false;
  let changed = false;
  for (const block of data.content) if (block?.type === 'text' && typeof block.text === 'string') { const s = scrubInjectedEcho(block.text, { exactText: injectPromptText }); if (s !== block.text) { block.text = s; changed = true; } }
  return changed;
}
function scrubResponsesApiResult(data, injectPromptText) {
  if (!injectPromptText || !data || !Array.isArray(data.output)) return false;
  let changed = false;
  for (const item of data.output) if (item?.type === 'message' && Array.isArray(item.content)) for (const c of item.content) if (c?.type === 'output_text' && typeof c.text === 'string') { const s = scrubInjectedEcho(c.text, { exactText: injectPromptText }); if (s !== c.text) { c.text = s; changed = true; } }
  if (changed && typeof data.output_text === 'string') data.output_text = data.output.filter(o => o.type === 'message').map(o => Array.isArray(o.content) ? o.content.map(c => c.text || '').join('') : '').join('');
  return changed;
}
module.exports = { INJECT_HEADER_TITLE, scrubInjectedEcho, scrubOpenAiChatCompletion, scrubAnthropicResponse, scrubResponsesApiResult };
