'use strict';

const crypto = require('crypto');
const { classifyCompaction } = require('./attribution');

const MAX_TEXT_LENGTH = 50000;
const RETRY_WINDOW_MS = 5000;
const RETRY_CACHE_LIMIT = 500;
const recentRequests = new Map();

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, MAX_TEXT_LENGTH);
  if (Array.isArray(value)) return value.map(textOf).join('\n').slice(0, MAX_TEXT_LENGTH);
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.slice(0, MAX_TEXT_LENGTH);
    if (typeof value.content === 'string') return value.content.slice(0, MAX_TEXT_LENGTH);
    return JSON.stringify(value).slice(0, MAX_TEXT_LENGTH);
  }
  return String(value).slice(0, MAX_TEXT_LENGTH);
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  const value = key ? headers[key] : '';
  return Array.isArray(value) ? value.join(',') : String(value || '').trim();
}

function messagesOf(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.input)) return body.input;
  return [];
}

function bodyText(body, messages) {
  return [body?.system, body?.instructions, body?.prompt, body?.input, messages]
    .map(textOf)
    .join('\n')
    .slice(0, MAX_TEXT_LENGTH);
}

function hasTools(body) {
  return (Array.isArray(body?.tools) && body.tools.length > 0)
    || (body?.tool_definitions && Object.keys(body.tool_definitions).length > 0);
}

function result(type, confidence, reasonCodes) {
  return { type, confidence, reason_codes: [...new Set(reasonCodes)] };
}

function sessionKey(body, headers) {
  const metadata = body?.client_metadata || {};
  return headerValue(headers, 'x-grok-session-id')
    || headerValue(headers, 'x-hermes-session-id')
    || metadata.thread_id
    || metadata.parent_thread_id
    || body?.prompt_cache_key
    || body?.metadata?.user_id
    || null;
}

function requestFingerprint(body) {
  const copy = body && typeof body === 'object' ? { ...body } : body;
  if (copy && typeof copy === 'object') {
    delete copy.__request_url;
    delete copy.url;
    delete copy.path;
  }
  return crypto.createHash('sha256').update(JSON.stringify(copy || null).slice(0, MAX_TEXT_LENGTH)).digest('hex');
}

function isRetry(body, headers) {
  const key = sessionKey(body, headers);
  if (!key) return null;
  const now = Date.now();
  const hash = requestFingerprint(body);
  const previous = recentRequests.get(String(key));
  recentRequests.delete(String(key));
  recentRequests.set(String(key), { hash, ts: now });
  while (recentRequests.size > RETRY_CACHE_LIMIT) recentRequests.delete(recentRequests.keys().next().value);
  if (previous && previous.hash === hash && now - previous.ts <= RETRY_WINDOW_MS) {
    return `retry.same_request_within_5s:${String(key).slice(0, 80)}`;
  }
  return null;
}

function classifyRequestSemantics({ body = {}, headers = {}, requestSource = null, url = '' } = {}) {
  const safeBody = body && typeof body === 'object' ? body : {};
  const messages = messagesOf(safeBody);
  const allText = bodyText(safeBody, messages);
  const systemText = textOf(safeBody.system ?? safeBody.instructions);
  const subagentHeader = headerValue(headers, 'x-openai-subagent').toLowerCase();
  const requestUrl = String(url || safeBody.__request_url || safeBody.url || safeBody.path || '').toLowerCase();
  const reasons = [];

  if (classifyCompaction(safeBody)) reasons.push('classifyCompaction=true');
  if (subagentHeader === 'compact') reasons.push('header.x-openai-subagent=compact');
  if (/\/session\/[^/]+\/summarize(?:$|[/?])/.test(requestUrl)) reasons.push('url.opencode.session.summarize');
  const explicitCompactionText = [safeBody.prompt, safeBody.input, messages].map(textOf).join('\n');
  if (/(?:^|[^a-z])(summarize|summary|compaction|compact)(?:[^a-z]|$)/i.test(explicitCompactionText)
    && !/Goal (?:Summarizer|Strategist|Plan Writer)/i.test(systemText)
    && (messages.length === 1 || !hasTools(safeBody))) reasons.push('body.compaction_marker');
  if (reasons.length) return result('compaction', 'high', reasons);

  if (subagentHeader && subagentHeader !== 'review') reasons.push(`header.x-openai-subagent=${subagentHeader}`);
  const metadata = safeBody.client_metadata || {};
  if (metadata.parent_thread_id) reasons.push('body.client_metadata.parent_thread_id');
  else if (metadata.thread_id) reasons.push('body.client_metadata.thread_id');
  if (headerValue(headers, 'x-codex-parent-thread-id')) reasons.push('header.x-codex-parent-thread-id');
  const promptId = String(safeBody.prompt_id || safeBody.promptId || '');
  if (promptId.includes('#')) reasons.push('body.prompt_id=compound_subagent_key');
  if (/(^|[:/_-])sa-[\w-]+/i.test(allText) || safeBody.parent_subagent_id || safeBody.tui_depth != null) reasons.push('body.hermes.subagent_identity');
  if (/:subagent:/i.test(String(safeBody.session_key || safeBody.sessionKey || headerValue(headers, 'x-openclaw-session-key')))) reasons.push('session_key.openclaw.subagent');
  if (reasons.length) {
    const highConfidence = !!(subagentHeader || metadata.parent_thread_id || metadata.thread_id || headerValue(headers, 'x-codex-parent-thread-id') || safeBody.parent_subagent_id || safeBody.tui_depth != null || /:subagent:/i.test(String(safeBody.session_key || safeBody.sessionKey || headerValue(headers, 'x-openclaw-session-key'))));
    const qwenCompoundKey = promptId.includes('#') && !highConfidence;
    return result('subagent', qwenCompoundKey ? 'medium' : (highConfidence ? 'high' : 'medium'), reasons);
  }

  if (subagentHeader === 'review') return result('review', 'high', ['header.x-openai-subagent=review']);
  if (/You are a security reviewer for an AI coding agent/i.test(systemText)) {
    return result('review', 'high', ['system.security_reviewer']);
  }

  if (/Goal Summarizer|Goal Strategist/i.test(systemText)) {
    return result('title', 'medium', ['system.grok.goal_summarizer']);
  }
  if (/Goal Plan Writer/i.test(systemText)) {
    return result('plan', 'medium', ['system.grok.goal_plan_writer']);
  }
  if (/(?:enter_plan_mode|exit_plan_mode|plan_mode|verify_plan_reminder)/i.test(allText)) {
    return result('plan', 'medium', ['body.plan_mode_marker']);
  }
  if (/(?:summary\/title|title agent|<title>)/i.test(allText) && !hasTools(safeBody)) {
    return result('title', 'medium', ['body.title_prompt_marker']);
  }

  const retryReason = isRetry(safeBody, headers);
  if (retryReason) return result('retry', 'medium', [retryReason]);

  const hasMeaningfulUser = messages.some((message) => message?.role === 'user' && textOf(message.content || message.input || message).trim());
  const hasOutputRequest = Number(safeBody.max_tokens || safeBody.max_output_tokens || 0) > 0;
  if (!messages.length && !textOf(safeBody.input).trim()) return result('heartbeat', 'medium', ['empty.messages_and_input']);
  if (!hasMeaningfulUser && !hasOutputRequest && !hasTools(safeBody)) return result('heartbeat', 'low', ['no_user_message_no_output_request']);
  if (!hasTools(safeBody) && messages.length <= 1 && allText.length < 120) {
    return result('other_automation', 'low', ['short_request_without_semantic_evidence']);
  }

  if (requestSource) reasons.push(`request_source=${String(requestSource)}`);
  return result('primary', 'high', reasons.length ? reasons : ['default_primary']);
}

function resetRequestSemanticsCache() {
  recentRequests.clear();
}

module.exports = { classifyRequestSemantics, resetRequestSemanticsCache };
