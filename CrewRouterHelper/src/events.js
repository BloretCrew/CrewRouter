'use strict';

const EVENT_MAP = new Map([
  ['sessionstart', 'session_start'], ['session_start', 'session_start'],
  ['sessionend', 'session_end'], ['session_end', 'session_end'],
  ['userpromptsubmit', 'prompt_submit'], ['user_prompt_submit', 'prompt_submit'],
  ['pretooluse', 'tool_use'], ['pre_tool_use', 'tool_use'],
  ['posttooluse', 'tool_use'], ['post_tool_use', 'tool_use'],
  ['posttoolusefailure', 'tool_use_failure'], ['post_tool_use_failure', 'tool_use_failure'],
  ['permissiondenied', 'permission_denied'], ['permission_denied', 'permission_denied'],
  ['stop', 'response_stop'], ['stopfailure', 'response_stop_failure'], ['stop_failure', 'response_stop_failure'],
  ['notification', 'notification'], ['subagentstart', 'subagent_start'], ['subagent_start', 'subagent_start'],
  ['subagentstop', 'subagent_stop'], ['subagent_stop', 'subagent_stop'], ['subagentend', 'subagent_stop'], ['subagent_end', 'subagent_stop'],
  ['precompact', 'pre_compact'], ['pre_compact', 'pre_compact'], ['postcompact', 'post_compact'], ['post_compact', 'post_compact'],
]);
const EVENT_TYPES = new Set(EVENT_MAP.values());
function first(obj, ...names) { return names.map((name) => obj && obj[name]).find((value) => value !== undefined && value !== null); }
function mapHookEvent(detail, explicit) {
  if (explicit) return EVENT_TYPES.has(explicit) ? explicit : null;
  const raw = first(detail, 'hook_event_name', 'hookEventName');
  return typeof raw === 'string' ? EVENT_MAP.get(raw.trim()) || EVENT_MAP.get(raw.trim().toLowerCase()) || null : null;
}
function safeDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return {};
  const out = {};
  for (const key of ['hook_event_name', 'hookEventName', 'source', 'reason', 'message', 'error', 'notificationType', 'subagentType']) {
    const value = first(detail, key);
    if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = typeof value === 'string' ? value.slice(0, 512) : value;
  }
  const input = first(detail, 'tool_input', 'toolInput');
  if (input && typeof input === 'object' && !Array.isArray(input)) out.tool_input_keys = Object.keys(input).map(String).slice(0, 64).map((key) => key.slice(0, 64)).sort();
  else if (input !== undefined && input !== null) out.tool_input_type = typeof input;
  return out;
}
function normalizeHook(detail, harness = 'grok', explicit) {
  const input = detail && typeof detail === 'object' ? detail : {};
  return { harness, event: mapHookEvent(input, explicit), session_id: String(first(input, 'session_id', 'sessionId') || '').slice(0, 128) || null, tool_name: String(first(input, 'tool_name', 'toolName') || '').slice(0, 128) || null, cwd: String(first(input, 'cwd', 'workspaceRoot') || process.cwd()).slice(0, 512), ts: Math.floor(Date.now() / 1000), detail: safeDetail(input) };
}
module.exports = { EVENT_TYPES, first, mapHookEvent, safeDetail, normalizeHook };
