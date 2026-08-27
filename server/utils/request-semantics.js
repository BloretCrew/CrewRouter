'use strict';

const crypto = require('crypto');
const { classifyCompaction } = require('./attribution');

const CLASSIFIER_VERSION = '2026-08-28';
const MAX_TEXT_LENGTH = 50000;
const FINGERPRINT_BUDGET = 12000;
const RETRY_WINDOW_MS = 5000;
const RETRY_CACHE_LIMIT = 500;
const recentRequests = new Map();

function textOf(value, limit = MAX_TEXT_LENGTH) {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, limit);
  if (Array.isArray(value)) return value.map((item) => textOf(item, limit)).join('\n').slice(0, limit);
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.slice(0, limit);
    if (typeof value.content === 'string') return value.content.slice(0, limit);
    return boundedSerialize(value, limit);
  }
  return String(value).slice(0, limit);
}

function boundedSerialize(value, budget = FINGERPRINT_BUDGET, depth = 0) {
  if (budget <= 0) return '';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (value.length <= budget) return JSON.stringify(value);
    const head = Math.max(1, Math.floor(budget * 0.6));
    const tail = Math.max(1, budget - head - 32);
    return `${JSON.stringify(value.slice(0, head))}…len=${value.length}…${JSON.stringify(value.slice(-tail))}`;
  }
  if (depth > 5) return `[depth:${typeof value}]`;
  if (Array.isArray(value)) {
    const items = value.length <= 20 ? value : [...value.slice(0, 10), ...value.slice(-10)];
    const parts = items.map((item) => boundedSerialize(item, Math.floor(budget / Math.max(items.length, 1)), depth + 1));
    return `[len=${value.length};${parts.join(',')}]`.slice(0, budget);
  }
  const keys = Object.keys(value).sort();
  const entries = keys.length <= 40 ? keys : [...keys.slice(0, 20), ...keys.slice(-20)];
  const perEntry = Math.max(32, Math.floor((budget - 24) / Math.max(entries.length, 1)));
  const parts = entries.map((key) => `${JSON.stringify(key)}:${boundedSerialize(value[key], perEntry, depth + 1)}`);
  return `{keys=${keys.length};${parts.join(',')}}`.slice(0, budget);
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
  if (typeof body?.input === 'string' && body.input.trim()) return [{ role: 'user', content: body.input }];
  return [];
}

function bodyText(body, messages) {
  return [body?.system, body?.instructions, body?.prompt, body?.input, messages]
    .map((value) => textOf(value, MAX_TEXT_LENGTH))
    .join('\n')
    .slice(0, MAX_TEXT_LENGTH);
}

function hasTools(body) {
  return (Array.isArray(body?.tools) && body.tools.length > 0)
    || (body?.tool_definitions && Object.keys(body.tool_definitions).length > 0);
}

function result(type, confidence, reasonCodes) {
  return {
    type,
    confidence,
    reason_codes: [...new Set(reasonCodes)],
    classifier_version: CLASSIFIER_VERSION,
  };
}

function sessionKey(body, headers) {
  const metadata = body?.client_metadata || {};
  return headerValue(headers, 'x-grok-session-id')
    || headerValue(headers, 'x-hermes-session-id')
    || headerValue(headers, 'x-codex-parent-thread-id')
    || metadata.thread_id
    || metadata.parent_thread_id
    || (/:subagent:/i.test(String(body?.session_key || body?.sessionKey || '')) ? String(body.session_key || body.sessionKey) : null)
    || null;
}

function requestFingerprint(body) {
  const fingerprintBody = body && typeof body === 'object' ? { ...body } : body;
  if (fingerprintBody && typeof fingerprintBody === 'object') {
    delete fingerprintBody.__request_url;
    delete fingerprintBody.url;
    delete fingerprintBody.path;
  }
  return crypto.createHash('sha256').update(boundedSerialize(fingerprintBody)).digest('hex');
}

function isRetry(body, headers) {
  const key = sessionKey(body, headers);
  if (!key) return null;
  const cacheKey = String(key);
  const now = Date.now();
  const hash = requestFingerprint(body);
  const previous = recentRequests.get(cacheKey);
  recentRequests.delete(cacheKey);
  recentRequests.set(cacheKey, { hash, ts: now });
  while (recentRequests.size > RETRY_CACHE_LIMIT) recentRequests.delete(recentRequests.keys().next().value);
  if (previous && previous.hash === hash && now - previous.ts <= RETRY_WINDOW_MS) {
    return 'retry.same_request_within_5s';
  }
  return null;
}

function isMeaningfulMessage(message) {
  if (!message || typeof message !== 'object') return false;
  const role = message.role || (message.type === 'message' ? 'user' : '');
  return role === 'user' && textOf(message.content ?? message.input ?? message).trim().length > 0;
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
  if (safeBody.compaction === true || safeBody.compact === true || safeBody.operation === 'summarize') {
    reasons.push('body.explicit_compaction_operation');
  }
  if (reasons.length) return result('compaction', 'high', reasons);

  // Review is more specific than generic subagent lineage.
  if (subagentHeader === 'review') return result('review', 'high', ['header.x-openai-subagent=review']);
  if (/You are a security reviewer for an AI coding agent/i.test(systemText)) {
    return result('review', 'high', ['system.security_reviewer']);
  }

  if (subagentHeader) reasons.push(`header.x-openai-subagent=${subagentHeader}`);
  const metadata = safeBody.client_metadata || {};
  if (metadata.parent_thread_id) reasons.push('body.client_metadata.parent_thread_id');
  else if (metadata.thread_id) reasons.push('body.client_metadata.thread_id');
  if (headerValue(headers, 'x-codex-parent-thread-id')) reasons.push('header.x-codex-parent-thread-id');
  const promptId = String(safeBody.prompt_id || safeBody.promptId || '');
  if (promptId.includes('#')) reasons.push('body.prompt_id=compound_subagent_key');
  if (/(^|[:/_-])sa-[\w-]+/i.test(allText) || safeBody.parent_subagent_id || safeBody.tui_depth != null) reasons.push('body.hermes.subagent_identity');
  if (/:subagent:/i.test(String(safeBody.session_key || safeBody.sessionKey || headerValue(headers, 'x-openclaw-session-key')))) reasons.push('session_key.openclaw.subagent');
  if (reasons.length) {
    const structured = !!(subagentHeader || metadata.parent_thread_id || metadata.thread_id || headerValue(headers, 'x-codex-parent-thread-id') || safeBody.parent_subagent_id || safeBody.tui_depth != null || /:subagent:/i.test(String(safeBody.session_key || safeBody.sessionKey || headerValue(headers, 'x-openclaw-session-key'))));
    return result('subagent', structured ? 'high' : 'medium', reasons);
  }

  if (/Goal Plan Writer/i.test(systemText)) return result('plan', 'medium', ['system.grok.goal_plan_writer']);
  if (/Goal Summarizer/i.test(systemText)) return result('title', 'medium', ['system.grok.goal_summarizer']);
  if (/Goal Strategist/i.test(systemText)) return result('other_automation', 'low', ['system.grok.goal_strategist']);
  if (/(?:enter_plan_mode|exit_plan_mode|plan_mode|verify_plan_reminder|plan-mode synthetic)/i.test(systemText)) {
    return result('plan', 'medium', ['system.plan_mode_marker']);
  }
  if (/(?:summary\/title|title agent|<title>)/i.test(systemText) && !hasTools(safeBody)) {
    return result('title', 'medium', ['system.title_prompt_marker']);
  }

  const retryReason = isRetry(safeBody, headers);
  if (retryReason) return result('retry', 'medium', [retryReason]);

  const hasMeaningfulUser = (typeof safeBody.input === 'string' && safeBody.input.trim().length > 0)
    || messages.some(isMeaningfulMessage);
  const hasOutputRequest = Number(safeBody.max_tokens || safeBody.max_output_tokens || 0) > 0;
  if (!messages.length && !textOf(safeBody.input).trim()) return result('heartbeat', 'medium', ['empty.messages_and_input']);
  if (!hasMeaningfulUser && !hasOutputRequest && !hasTools(safeBody)) return result('heartbeat', 'low', ['no_user_message_no_output_request']);
  if (!hasTools(safeBody) && messages.length <= 1 && allText.length < 120 && !hasMeaningfulUser) {
    return result('other_automation', 'low', ['short_request_without_semantic_evidence']);
  }

  if (requestSource) reasons.push(`request_source=${String(requestSource)}`);
  return result('primary', 'high', reasons.length ? reasons : ['default_primary']);
}

function resetRequestSemanticsCache() {
  recentRequests.clear();
}

module.exports = { classifyRequestSemantics, resetRequestSemanticsCache };
