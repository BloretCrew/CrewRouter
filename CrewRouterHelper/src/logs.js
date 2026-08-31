'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { maskUrl } = require('./profiles');
function logPath() { return process.env.CR_REPORT_LOG || path.join(process.env.XDG_CACHE_HOME || process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'cr-report', 'events.log'); }
function clean(value) { return String(value == null ? '' : value).replace(/(bearer\s+|(?:key|token|secret|password)\s*[:=])[^\s,;]+/gi, '$1[REDACTED]').replace(/https?:\/\/[^\s]+/gi, (url) => maskUrl(url)).slice(0, 256); }
function writeLog(entry) { const target = logPath(); fs.mkdirSync(path.dirname(target), { recursive: true }); const line = JSON.stringify({ ts: new Date().toISOString(), profile: clean(entry.profile || 'default'), event: clean(entry.event), ok: Boolean(entry.ok), status: Number.isFinite(entry.status) ? entry.status : null, latency_ms: Number.isFinite(entry.latency_ms) ? entry.latency_ms : null, error: clean(entry.error || '') }) + '\n'; if (line.length > 2048) return; try { if (fs.existsSync(target) && fs.statSync(target).size > 1024 * 1024) fs.renameSync(target, `${target}.${Date.now()}`); fs.appendFileSync(target, line, { mode: 0o600 }); fs.chmodSync(target, 0o600); } catch {} }
function readLogs() { try { return fs.readFileSync(logPath(), 'utf8').split('\n').filter(Boolean).slice(-500).map((line) => { try { return JSON.parse(line); } catch { return { error: 'invalid log entry' }; } }); } catch { return []; } }
function clearLogs() { try { fs.unlinkSync(logPath()); return true; } catch (err) { if (err.code === 'ENOENT') return false; throw err; } }
module.exports = { logPath, clean, writeLog, readLogs, clearLogs };
