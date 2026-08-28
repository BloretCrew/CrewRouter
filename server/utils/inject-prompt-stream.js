'use strict';

const MAX_TAIL = 256;
function createStreamScrubber(injectPrompt) {
  if (!injectPrompt) return { feed: text => text, flush: () => '' };
  let pending = '';
  let swallowing = false;
  let newFormat = false;
  let finished = false;
  function findStart(text) {
    const m = /<system-reminder>[\s\S]*?#\s*claudeMd\b|(?:^|\n\n|\r\n\r\n)[ \t]*#\s*User Custom Instructions \(CrewRouter\)[ \t]*\r?\n|(?:^|\n|\r\n)[ \t]*#\s*claudeMd\b|(?:^|\n|\r\n)[ \t]*\[System-injected reference notes[^\n]*\r?\n[ \t]*\r?\n[ \t]*# User Custom Instructions \(CrewRouter\)[ \t]*\r?\n/i.exec(text);
    if (m && m[0].includes('<system-reminder>')) newFormat = true;
    return m;
  }
  function process(final) {
    let out = '';
    while (pending) {
      if (swallowing) {
        const end = newFormat ? pending.search(/<\/system-reminder>/i) : pending.search(/\n\n---\n\n/);
        if (end < 0) { if (final) pending = ''; break; }
        const marker = newFormat ? /<\/system-reminder>/i : /\n\n---\n\n/;
        const match = pending.slice(end).match(marker);
        pending = pending.slice(end + match[0].length);
        swallowing = false;
        newFormat = false;
        continue;
      }
      const start = findStart(pending);
      if (start) {
        out += pending.slice(0, start.index);
        if (start.index > 0 && (pending[start.index] === '\n' || pending[start.index] === '\r')) out += '\n';
        pending = pending.slice(start.index + start[0].length);
        swallowing = true;
        continue;
      }
      if (final) { out += pending; pending = ''; } else { const safe = Math.max(0, pending.length - MAX_TAIL); if (safe) { out += pending.slice(0, safe); pending = pending.slice(safe); } break; }
    }
    return out;
  }
  return {
    feed(text) { if (finished || typeof text !== 'string' || !text) return text || ''; pending += text; return process(false); },
    flush() { if (finished) return ''; finished = true; return process(true); },
  };
}
module.exports = { createStreamScrubber, MAX_TAIL };
