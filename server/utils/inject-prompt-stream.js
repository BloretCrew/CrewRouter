'use strict';

const MAX_TAIL = 256;
const START_TAG = '<system-reminder>';
const END_TAG_RE = /<\/system-reminder>/i;
const OLD_HEADER_RE = /(?:^|\n\n|\r\n\r\n)[ \t]*#\s*User Custom Instructions \(CrewRouter\)[ \t]*\r?\n/i;
const OLD_FULL_RE = /(?:^|\n|\r\n)[ \t]*\[System-injected reference notes[^\n]*\r?\n[ \t]*\r?\n[ \t]*# User Custom Instructions \(CrewRouter\)[ \t]*\r?\n/i;

function createStreamScrubber(injectPrompt) {
  if (!injectPrompt) return { feed: text => text, flush: () => '' };
  let pending = '';
  let swallowing = false;
  let newFormat = false;
  let finished = false;

  function findStart(text) {
    // 新格式必须从文本开头或换行后的独立标签开始，避免吞掉同一行内联文本。
    const newMatch = /(?:^|(?:\r\n|\n))[ \t]*<system-reminder>/i.exec(text);
    const oldMatch = OLD_FULL_RE.exec(text) || OLD_HEADER_RE.exec(text);
    if (newMatch && (!oldMatch || newMatch.index <= oldMatch.index)) {
      return { index: newMatch.index, length: newMatch[0].length, newFormat: true };
    }
    if (oldMatch) return { index: oldMatch.index, length: oldMatch[0].length, newFormat: false };
    return null;
  }

  function process(final) {
    let out = '';
    while (pending) {
      if (swallowing) {
        const end = newFormat ? END_TAG_RE.exec(pending) : /\n\n---\n\n/.exec(pending);
        if (!end) { if (final) pending = ''; break; }
        pending = pending.slice(end.index + end[0].length);
        swallowing = false;
        newFormat = false;
        continue;
      }

      const start = findStart(pending);
      if (start) {
        out += pending.slice(0, start.index);
        if (start.index > 0 && (pending[start.index] === '\n' || pending[start.index] === '\r')) {
          out += pending[start.index] === '\r' && pending[start.index + 1] === '\n' ? '\r\n' : '\n';
        }
        pending = pending.slice(start.index + start.length);
        swallowing = true;
        newFormat = start.newFormat;
        continue;
      }

      if (final) {
        out += pending;
        pending = '';
      } else {
        // 保留可能尚未完整到达的起始标签，尤其是 <system-reminder> 被拆 chunk 时。
        const keep = Math.max(MAX_TAIL, START_TAG.length - 1);
        const safe = Math.max(0, pending.length - keep);
        if (safe) { out += pending.slice(0, safe); pending = pending.slice(safe); }
        break;
      }
    }
    return out;
  }

  return {
    feed(text) { if (finished || typeof text !== 'string' || !text) return text || ''; pending += text; return process(false); },
    flush() { if (finished) return ''; finished = true; return process(true); },
  };
}

module.exports = { createStreamScrubber, MAX_TAIL };
