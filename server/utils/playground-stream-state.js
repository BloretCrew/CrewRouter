'use strict';

function consumePlaygroundSseLines(state, lines, providerFormat) {
  const output = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const result = consumePlaygroundSseLine(state, line, providerFormat);
    output.push(result);
    if (result.kind === 'done' || result.kind === 'error' || result.kind === 'ignore') break;
  }
  return { state, output, terminal: finalizePlaygroundStream({ ...state }) };
}

function consumePlaygroundSseLine(state, line, providerFormat) {
  const value = String(line || '').replace(/\\r$/, '');
  if (value.startsWith('event:')) {
    state.pendingEvent = value.slice(6).trim();
    return { kind: 'event', state };
  }
  if (!value.startsWith('data:')) return { kind: 'ignore', state };
  const data = value.slice(5).trim();
  if (state.pendingEvent === 'message_stop') {
    state.pendingEvent = '';
    state.streamCompleted = true;
    return { kind: 'done', state, providerMessageStop: true };
  }
  state.pendingEvent = '';
  return consumePlaygroundSseFrame(state, data, providerFormat);
}

function consumePlaygroundSseFrame(state, data, providerFormat) {
  if (state.clientDisconnected || state.streamCompleted || state.streamFailed || state.timeoutAborted) {
    return { kind: 'ignore', state };
  }
  if (data === '[DONE]' || (providerFormat === 'anthropic' && data === 'message_stop')) {
    state.streamCompleted = true;
    return { kind: 'done', state };
  }
  try {
    const parsed = JSON.parse(data);
    if (providerFormat === 'anthropic' && parsed?.type === 'message_stop') {
      state.streamCompleted = true;
      return { kind: 'done', state, providerMessageStop: true };
    }
    if (parsed && parsed.error) {
      state.streamFailed = true;
      return { kind: 'error', terminal: true, message: String(parsed.error.message || '上游流式响应失败'), parsed, state };
    }
    return { kind: 'data', parsed, state };
  } catch (error) {
    state.streamFailed = true;
    return { kind: 'error', terminal: true, message: '上游流式响应失败', error, state };
  }
}

function shouldRecordPlaygroundUsage(state) {
  return state.streamCompleted === true && state.clientDisconnected !== true && state.timeoutAborted !== true && state.streamFailed !== true;
}

async function recordPlaygroundUsageIfCompleted(state, recordUsageFn, args = []) {
  if (!shouldRecordPlaygroundUsage(state)) return false;
  await recordUsageFn(...args);
  return true;
}

function finalizePlaygroundStream(state) {
  if (state.clientDisconnected) return 'client-disconnected';
  if (state.timeoutAborted) return 'timeout';
  if (state.streamFailed) return 'failed';
  if (!state.streamCompleted) {
    state.streamFailed = true;
    return 'failed';
  }
  return 'completed';
}

module.exports = { consumePlaygroundSseLines, consumePlaygroundSseLine, consumePlaygroundSseFrame, finalizePlaygroundStream, shouldRecordPlaygroundUsage, recordPlaygroundUsageIfCompleted };
