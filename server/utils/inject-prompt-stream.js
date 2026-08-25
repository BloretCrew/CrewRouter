'use strict';

const HEADER_MARKER = '# User Custom Instructions (CrewRouter)';
const SEPARATOR = '\n\n---\n\n';
const MAX_TAIL = 64;

function createStreamScrubber(injectPrompt) {
  if (!injectPrompt) return { feed: (text) => text, flush: () => '' };

  let pending = '';
  let swallowing = false;
  let finished = false;

  function findStart(text) {
    return /(?:^|\n|\r\n)[ \t]*(?:\[System-injected reference notes[^\n]*\r?\n[ \t]*\r?\n[ \t]*)?# User Custom Instructions \(CrewRouter\)[ \t]*\r?\n/.exec(text);
  }

  function process(final) {
    let out = '';
    while (pending) {
      if (swallowing) {
        const end = pending.indexOf(SEPARATOR);
        if (end < 0) {
          if (final) pending = '';
          break;
        }
        pending = pending.slice(end + SEPARATOR.length);
        swallowing = false;
        continue;
      }

      const start = findStart(pending);
      if (start) {
        out += pending.slice(0, start.index);
        pending = pending.slice(start.index + start[0].length);
        swallowing = true;
        continue;
      }

      if (final) {
        out += pending;
        pending = '';
      } else {
        const safeLength = Math.max(0, pending.length - MAX_TAIL);
        if (safeLength > 0) {
          out += pending.slice(0, safeLength);
          pending = pending.slice(safeLength);
        }
        break;
      }
    }
    return out;
  }

  return {
    feed(text) {
      if (finished || typeof text !== 'string' || !text) return text || '';
      pending += text;
      return process(false);
    },
    flush() {
      if (finished) return '';
      finished = true;
      return process(true);
    },
  };
}

module.exports = { createStreamScrubber, HEADER_MARKER, MAX_TAIL };
