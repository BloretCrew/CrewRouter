'use strict';

function consumePlaygroundSseFrame(state, data, providerFormat) {
  if (state.clientDisconnected || state.streamCompleted || state.streamFailed || state.timeoutAborted) {
    return { kind: 'ignore', state };
  }
  if (data === '[DONE]') {
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

module.exports = { consumePlaygroundSseFrame, finalizePlaygroundStream, shouldRecordPlaygroundUsage };
