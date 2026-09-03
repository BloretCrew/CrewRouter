/* Pure Playground request-state helpers shared by production UI and tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlaygroundState = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function buildRetryPayload(request) {
    const messages = Array.isArray(request.apiMessages)
      ? request.apiMessages.map(message => Object.freeze({ ...message }))
      : [];
    return Object.freeze({
      text: String(request.text || ''), model: String(request.model || ''), systemPrompt: String(request.systemPrompt || ''),
      temperature: request.temperature, maxTokens: request.maxTokens, thinking: request.thinking,
      thinkingBudget: request.thinkingBudget, reasoningEffort: request.reasoningEffort, apiMessages: Object.freeze(messages)
    });
  }
  function prepareRetryRequest(payload, currentMessages) {
    return { ...payload, apiMessages: payload.apiMessages.map(message => ({ ...message })), messages: payload.apiMessages.filter(message => message.role !== 'system').map(message => ({ ...message })) };
  }
  function shouldRollback(status) { return status !== 'completed'; }
  return { buildRetryPayload, prepareRetryRequest, shouldRollback };
}));
