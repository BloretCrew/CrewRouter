'use strict';
const http = require('http');
const https = require('https');
const { getAccessToken, loadConfig, requestJson } = require('./config');
const { writeLog } = require('./logs');
const { enqueue } = require('./queue');
function postEvent(url, token, payload, timeout = 3000) { return new Promise((resolve) => { const started = Date.now(); try { const target = new URL(`${url}/api/client-events`); const transport = target.protocol === 'https:' ? https : http; const req = transport.request(target, { method: 'POST', timeout, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, (res) => { res.resume(); res.on('end', () => { const ok = res.statusCode >= 200 && res.statusCode < 300; writeLog({ profile: loadConfig()?.current_profile, event: payload.event, ok, status: res.statusCode, latency_ms: Date.now() - started }); if (!ok) enqueue(payload, `HTTP ${res.statusCode}`); resolve(ok); }); }); req.on('timeout', () => req.destroy()); req.on('error', (err) => { writeLog({ profile: loadConfig()?.current_profile, event: payload.event, ok: false, error: err.message, latency_ms: Date.now() - started }); enqueue(payload, err.message); resolve(false); }); req.end(JSON.stringify(payload)); } catch (err) { writeLog({ profile: loadConfig()?.current_profile, event: payload.event, ok: false, error: err.message, latency_ms: Date.now() - started }); enqueue(payload, err.message); resolve(false); } }); }
async function report(payload) { const { allows } = require('./filter'); if (!allows(payload.event, payload.tool_name)) { writeLog({ profile: loadConfig()?.current_profile, event: payload.event, ok: true, status: null, error: 'filtered' }); return true; } let token = null; try { token = await getAccessToken(); } catch (err) { enqueue(payload, err.message); } const cfg = loadConfig(); const url = cfg && String(cfg.url || '').replace(/\/$/, ''); if (!url || !token) { enqueue(payload, 'missing configuration or credential'); return false; } return postEvent(url, token, payload); }
async function remoteTest(events, timeout = 1200) {
  const cfg = loadConfig();
  const url = cfg && String(cfg.url || '').replace(/\/$/, '');
  if (!url) return events.map(type => ({ type, status: null, latency_ms: 0, level: 'WARN', error: 'not_configured' }));
  let token = null; try { token = await getAccessToken(); } catch {}
  const eventMap = { SessionStart: 'session_start', PostToolUse: 'tool_use', Stop: 'response_stop', PostToolUseFailure: 'tool_use_failure', SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop' };
  return Promise.all(events.map(async (requested) => {
    const type = eventMap[requested] || requested;
    const started = Date.now();
    if (!eventMap[requested] && !['session_start','tool_use','response_stop','tool_use_failure','subagent_start','subagent_stop'].includes(type)) return { type: requested, status: null, latency_ms: 0, level: 'FAILED', error: 'invalid_event' };
    const payload = { harness: 'grok', event: type, session_id: 'cr-report-test', tool_name: 'cr-report' };
    try {
      const r = await requestJson(`${url}/api/client-events`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload) }, timeout, 1024);
      return { type, status: Number(r.statusCode) || null, latency_ms: Date.now() - started, level: r.statusCode >= 200 && r.statusCode < 300 ? 'READY' : r.statusCode === 401 || r.statusCode === 403 ? 'WARN' : 'FAILED' };
    } catch { return { type, status: null, latency_ms: Date.now() - started, level: 'WARN', error: 'request_failed' }; }
  }));
}
module.exports = { postEvent, report, remoteTest };
