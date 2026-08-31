'use strict';

const crypto = require('crypto');
const { REQUEST_SOURCES, normalizeRequestSource } = require('./request-source');
const { extractAttribution } = require('./attribution');

const SESSION_ID_MAX = 128;
const CWD_MAX = 512;
const SESSION_KEY_VERSION = 'v2';

function safeString(value, max = SESSION_ID_MAX) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function firstString(...values) {
  for (const value of values) {
    const normalized = safeString(value);
    if (normalized) return normalized;
  }
  return null;
}

function digest(value) {
  // Keep the key reproducible in SQL (PostgreSQL md5) without storing raw IDs.
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

function sessionKeyFor(sessionId, harness) {
  if (!sessionId) return null;
  return `session-${SESSION_KEY_VERSION}:${normalizeRequestSource(harness)}:${digest(sessionId)}`;
}

function unknownKey(recordId) {
  return recordId == null ? null : `unknown-${SESSION_KEY_VERSION}:${digest(recordId)}`;
}

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find(k => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

function extractEventIdentity(event = {}) {
  const harness = normalizeRequestSource(event.harness);
  const sessionId = firstString(
    event.session_id,
    event.sessionId,
    event.client_session_id,
    event.clientSessionId,
    event.conversation_id,
    event.conversationId,
    event.thread_id,
    event.threadId,
  );
  const parentSessionId = firstString(
    event.parent_session_id,
    event.parentSessionId,
    event.parent_thread_id,
    event.parentThreadId,
  );
  return buildIdentity({
    harness,
    sessionId,
    parentSessionId,
    subagentId: firstString(event.subagent_id, event.subagentId),
    cwd: safeString(event.cwd || event.workspaceRoot, CWD_MAX),
    project: firstString(event.project, event.project_id, event.projectId, event.worktree),
    eventType: firstString(event.event_type, event.eventType, event.event),
    source: sessionId ? 'event.session_id' : 'unknown',
    confidence: sessionId ? 'high' : 'unknown',
  });
}

function extractRequestIdentity(req = {}, options = {}) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const headers = req.headers || {};
  const attribution = options.attribution || extractAttribution(req);
  const harness = normalizeRequestSource(options.requestSource || options.harness || 'unknown');
  const headerSession = firstString(
    headerValue(headers, 'x-crewrouter-session-id'),
    headerValue(headers, 'x-session-id'),
    headerValue(headers, 'x-client-session-id'),
    headerValue(headers, 'x-grok-session-id'),
    headerValue(headers, 'x-hermes-session-id'),
    headerValue(headers, 'session-id'),
    headerValue(headers, 'x-codex-session-id'),
    headerValue(headers, 'thread-id'),
    headerValue(headers, 'x-codex-thread-id'),
    headerValue(headers, 'x-openclaw-session-key'),
  );
  const bodySession = firstString(
    body.session_id,
    body.sessionId,
    body.client_session_id,
    body.clientSessionId,
    body.conversation_id,
    body.conversationId,
    body.thread_id,
    body.threadId,
    body.session_key,
    body.sessionKey,
  );
  const sessionId = headerSession || bodySession || safeString(attribution.sessionId);
  const source = headerSession
    ? 'header'
    : bodySession
      ? 'body'
      : (sessionId ? 'attribution' : 'unknown');
  return buildIdentity({
    harness,
    sessionId,
    parentSessionId: firstString(
      headerValue(headers, 'parent-thread-id'),
      headerValue(headers, 'x-codex-parent-thread-id'),
      headerValue(headers, 'x-parent-session-id'),
      body.parent_session_id,
      body.parentSessionId,
      body.parent_thread_id,
      body.parentThreadId,
      attribution.parentThreadId,
    ),
    subagentId: firstString(
      headerValue(headers, 'x-openai-subagent'),
      body.subagent_id,
      body.subagentId,
      body.parent_subagent_id,
      attribution.subagent,
    ),
    cwd: safeString(body.cwd || body.workspaceRoot || body.worktree, CWD_MAX),
    project: firstString(body.project, body.project_id, body.projectId, body.worktree, body.workspaceRoot),
    eventType: firstString(body.event_type, body.eventType),
    source,
    confidence: sessionId ? (headerSession || bodySession ? 'high' : 'medium') : 'unknown',
  });
}

function buildIdentity({
  harness = REQUEST_SOURCES.UNKNOWN,
  sessionId = null,
  parentSessionId = null,
  subagentId = null,
  cwd = null,
  project = null,
  eventType = null,
  source = 'unknown',
  confidence = 'unknown',
}) {
  const normalizedHarness = normalizeRequestSource(harness);
  const normalizedSession = safeString(sessionId);
  const normalizedParent = safeString(parentSessionId);
  return Object.freeze({
    version: SESSION_KEY_VERSION,
    harness: normalizedHarness,
    sessionId: normalizedSession,
    sessionIdSource: source,
    confidence,
    parentSessionId: normalizedParent,
    parentSessionKey: sessionKeyFor(normalizedParent, normalizedHarness),
    subagentId: safeString(subagentId),
    cwd: safeString(cwd, CWD_MAX),
    project: safeString(project, CWD_MAX),
    eventType: safeString(eventType, 64),
    logicalSessionKey: sessionKeyFor(normalizedSession, normalizedHarness),
  });
}

function identityWithRecordKey(identity, recordId) {
  if (identity?.logicalSessionKey) return identity;
  return Object.freeze({ ...identity, logicalSessionKey: unknownKey(recordId) });
}

module.exports = {
  SESSION_KEY_VERSION,
  SESSION_ID_MAX,
  sessionKeyFor,
  extractEventIdentity,
  extractRequestIdentity,
  identityWithRecordKey,
};
