'use strict';

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseJson(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find(k => k.toLowerCase() === wanted);
  return key ? stringValue(headers[key]) : null;
}

function addSignal(signals, kind, value) {
  const normalized = stringValue(value);
  if (normalized) signals.push({ kind, value: normalized });
  return normalized;
}

const COMPACTION_FEATURES = Object.freeze({
  minUserChars: 8000,
  maxSystemChars: 200,
  historyPatterns: [
    /previous conversation/i,
    /conversation summary/i,
    /serialized history/i,
    /(?:^|\\n)\\s*role\\s*[:=]/i,
    /(?:^|\\n)\\s*\\"role\\"\\s*:/i,
  ],
});

function classifyCompaction(body = {}) {
  if (!body || typeof body !== 'object') return false;
  if ((Array.isArray(body.tools) && body.tools.length > 0) || (body.tool_definitions && Object.keys(body.tool_definitions).length > 0)) return false;
  const system = body.system ?? body.instructions ?? '';
  const systemText = typeof system === 'string' ? system : JSON.stringify(system || '');
  if (systemText.trim().length >= COMPACTION_FEATURES.maxSystemChars) return false;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length !== 1 || messages[0]?.role !== 'user') return false;
  const content = messages[0].content;
  const userText = typeof content === 'string' ? content : JSON.stringify(content || '');
  return userText.length > COMPACTION_FEATURES.minUserChars
    && COMPACTION_FEATURES.historyPatterns.some(pattern => pattern.test(userText));
}

function extractAttribution(req = {}) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const signals = [];
  let parentThreadId = null;
  let subagent = null;
  let sessionId = null;

  const metadataUserId = body.metadata?.user_id;
  const anthropicMeta = parseJson(metadataUserId);
  if (anthropicMeta) {
    sessionId = addSignal(signals, 'anthropic.metadata.user_id.session_id', anthropicMeta.session_id);
    addSignal(signals, 'anthropic.metadata.user_id.account_uuid', anthropicMeta.account_uuid);
  }

  const clientMetadata = body.client_metadata && typeof body.client_metadata === 'object'
    ? body.client_metadata
    : null;
  if (clientMetadata) {
    parentThreadId = addSignal(signals, 'openai.client_metadata.parent_thread_id', clientMetadata.parent_thread_id)
      || addSignal(signals, 'openai.client_metadata.thread_id', clientMetadata.thread_id)
      || addSignal(signals, 'openai.client_metadata.root_turn_id', clientMetadata.root_turn_id);
    subagent = addSignal(signals, 'openai.client_metadata.agent_name', clientMetadata.agent_name);
  }

  const headers = req.headers || {};
  const headerSignals = [
    ['x-codex-parent-thread-id', 'header.x-codex-parent-thread-id', 'parent'],
    ['x-openai-subagent', 'header.x-openai-subagent', 'subagent'],
    ['x-grok-session-id', 'header.x-grok-session-id', 'session'],
    ['x-hermes-session-id', 'header.x-hermes-session-id', 'session'],
  ];
  for (const [header, kind, target] of headerSignals) {
    const value = headerValue(headers, header);
    if (!value) continue;
    const selected = addSignal(signals, kind, value);
    if (target === 'parent' && !parentThreadId) parentThreadId = selected;
    if (target === 'subagent' && !subagent) subagent = selected;
    if (target === 'session' && !sessionId) sessionId = selected;
  }

  const promptId = body.prompt_id || body.promptId;
  const promptPrefix = stringValue(promptId)?.split('#')[0];
  if (promptPrefix) {
    sessionId = sessionId || addSignal(signals, 'prompt_id.prefix', promptPrefix);
    addSignal(signals, 'prompt_id', promptId);
  }

  return { parentThreadId, subagent, sessionId, source: signals };
}

module.exports = { extractAttribution, classifyCompaction, COMPACTION_FEATURES };
