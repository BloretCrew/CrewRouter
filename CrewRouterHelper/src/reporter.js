'use strict';
const http = require('http');
const https = require('https');
const { getAccessToken, loadConfig } = require('./config');
const { writeLog } = require('./logs');
function postEvent(url, token, payload, timeout = 3000) { return new Promise((resolve) => { const started = Date.now(); try { const target = new URL(`${url}/api/client-events`); const transport = target.protocol === 'https:' ? https : http; const req = transport.request(target, { method: 'POST', timeout, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, (res) => { res.resume(); res.on('end', () => { const ok = res.statusCode >= 200 && res.statusCode < 300; writeLog({ profile: loadConfig()?.current_profile, event: payload.event, ok, status: res.statusCode, latency_ms: Date.now() - started }); resolve(ok); }); }); req.on('timeout', () => req.destroy()); req.on('error', (err) => { writeLog({ profile: loadConfig()?.current_profile, event: payload.event, ok: false, error: err.message, latency_ms: Date.now() - started }); resolve(false); }); req.end(JSON.stringify(payload)); } catch (err) { writeLog({ profile: loadConfig()?.current_profile, event: payload.event, ok: false, error: err.message, latency_ms: Date.now() - started }); resolve(false); } }); }
async function report(payload) { const token = await getAccessToken(); const cfg = loadConfig(); const url = cfg && String(cfg.url || '').replace(/\/$/, ''); return url && token ? postEvent(url, token, payload) : false; }
module.exports = { postEvent, report };
