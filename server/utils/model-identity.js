'use strict';

const MAX_MODEL_LENGTH = 1024;
const MAX_FRAME_LENGTH = 1024 * 1024;

function normalizeModel(value) {
  if (typeof value !== 'string' || value.length > MAX_MODEL_LENGTH) return null;
  const model = value.trim();
  return model && !/[\x00-\x1f\x7f]/.test(model) ? model : null;
}

function createModelIdentity(requestedModel, resolvedModel) {
  let responseModel = null;
  let frozen = false;
  return {
    observe(value, eventName = '') {
      if (frozen || !value || typeof value !== 'object' || Array.isArray(value)) return;
      const type = value.type || eventName;
      if (value.error || value.response?.error || type === 'error' || type === 'response.failed') {
        if (type === 'error' || type === 'response.failed' || type === 'response.completed' || type === 'response.incomplete' || type === 'message_stop') frozen = true;
        return;
      }
      let candidate = null;
      if (type === 'message_start') candidate = normalizeModel(value.message?.model);
      else if (typeof type === 'string' && type.startsWith('response.')) candidate = normalizeModel(value.response?.model);
      else if (!type || type === 'message' || type === 'response') candidate = normalizeModel(value.model);
      if (candidate) responseModel = candidate;
      if (type === 'response.completed' || type === 'response.incomplete' || type === 'message_stop') frozen = true;
    },
    finish() { frozen = true; },
    snapshot() {
      return {
        requested_model: normalizeModel(requestedModel),
        resolved_model: normalizeModel(resolvedModel),
        response_model: responseModel,
      };
    },
  };
}

function createModelIdentityStream(identity) {
  const decoder = new TextDecoder();
  let buffer = '';
  let dropping = false;
  const observeFrame = frame => {
    let eventName = '';
    const data = [];
    for (const line of frame.split(/\r\n|\n|\r/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    const payload = data.join('\n').trim();
    if (payload === '[DONE]') return identity.finish();
    try { identity.observe(JSON.parse(payload), eventName); } catch { /* ignore malformed events */ }
  };
  const drain = final => {
    let match;
    while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (!dropping && frame.length <= MAX_FRAME_LENGTH) observeFrame(frame);
      dropping = false;
    }
    if (buffer.length > MAX_FRAME_LENGTH) {
      buffer = buffer.slice(-3);
      dropping = true;
    }
    if (final) {
      if (!dropping && buffer) observeFrame(buffer);
      buffer = '';
      identity.finish();
    }
  };
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      drain(false);
    },
    finish() { buffer += decoder.decode(); drain(true); },
  };
}

// 观察代理实际读取的字节，不分流或提前读取上游。
function observeModelResponse(response, identity) {
  if (!response) return response;
  if (!response.ok) identity.finish();
  const stream = createModelIdentityStream(identity);
  const body = response.body && new Proxy(response.body, {
    get(target, property) {
      if (property === 'getReader') return (...args) => {
        const reader = target.getReader(...args);
        return new Proxy(reader, {
          get(readerTarget, key) {
            if (key === 'read') return async (...readArgs) => {
              try {
                const result = await readerTarget.read(...readArgs);
                if (result.done) stream.finish();
                else stream.push(result.value);
                return result;
              } catch (error) {
                stream.finish();
                throw error;
              }
            };
            if (key === 'cancel') return async (...cancelArgs) => {
              stream.finish();
              return readerTarget.cancel(...cancelArgs);
            };
            const value = Reflect.get(readerTarget, key, readerTarget);
            return typeof value === 'function' ? value.bind(readerTarget) : value;
          },
        });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(response, {
    get(target, property) {
      if (property === 'body') return body;
      if (property === 'json' || property === 'text') return async () => {
        try {
          const value = await target[property]();
          if (target.ok) {
            if (property === 'json') identity.observe(value);
            else {
              try { identity.observe(JSON.parse(value)); } catch { /* ignore malformed JSON */ }
            }
          }
          return value;
        } finally { identity.finish(); }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

module.exports = { MAX_MODEL_LENGTH, MAX_FRAME_LENGTH, normalizeModel, createModelIdentity, createModelIdentityStream, observeModelResponse };
