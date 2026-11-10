'use strict';

/**
 * Server-Sent Events framing.
 *
 * Dialects differ in what they put on the wire:
 * - Gemini generateContent: `data: {json}` only, no `[DONE]` and no event name.
 * - OpenAI Chat: `data: {json}` + `data: [DONE]`.
 * - Anthropic / Responses / Interactions: `event: name` + `data: {json}`.
 *
 * This module only handles framing; protocol semantics stay in the codecs.
 */

const CRLF = /\r\n?/g;

function createSSEParser() {
  let buffer = '';
  let eventName = '';
  let dataLines = [];
  let lastEventId;
  let retry;

  function resetFrame() {
    eventName = '';
    dataLines = [];
    retry = undefined;
    // lastEventId follows the SSE spec and persists between frames.
  }

  function flushFrame() {
    if (dataLines.length === 0 && !eventName) return null;
    const data = dataLines.join('\n');
    const frame = {
      event: eventName || 'message',
      data,
      id: lastEventId,
      retry,
      done: data.trim() === '[DONE]'
    };
    resetFrame();
    return frame;
  }

  function processLine(line) {
    if (line === '') return flushFrame();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        eventName = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) lastEventId = value;
        break;
      case 'retry': {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) retry = parsed;
        break;
      }
      default:
        // Unknown fields are ignored per the SSE specification.
        break;
    }
    return null;
  }

  return {
    push(chunk) {
      buffer += String(chunk == null ? '' : chunk).replace(CRLF, '\n');
      const frames = [];
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const frame = processLine(line);
        if (frame) frames.push(frame);
      }
      return frames;
    },
    end() {
      const frames = [];
      if (buffer) {
        const frame = processLine(buffer.replace(/\r/g, ''));
        if (frame) frames.push(frame);
        buffer = '';
      }
      const frame = flushFrame();
      if (frame) frames.push(frame);
      return frames;
    }
  };
}

function formatSSE({ event, data, id, retry } = {}) {
  let out = '';
  if (event) out += `event: ${event}\n`;
  if (id !== undefined && id !== null && id !== '') out += `id: ${id}\n`;
  if (retry !== undefined && retry !== null) out += `retry: ${retry}\n`;
  const payload = typeof data === 'string' ? data : JSON.stringify(data == null ? {} : data);
  for (const line of payload.split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}

function formatDone() {
  return 'data: [DONE]\n\n';
}

module.exports = { createSSEParser, formatSSE, formatDone };
