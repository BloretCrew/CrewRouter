'use strict';
const { scanHooks } = require('./hooks');
const { readLogs } = require('./logs');
const { summary } = require('./queue');
const { scanDoctor } = require('./doctor');
const { get } = require('./machine');
async function collect(command) {
  const logs = readLogs(); const q = summary(); const d = await scanDoctor(command); const by = {};
  for (const x of logs) by[x.event] = (by[x.event] || 0) + 1;
  const metric = (event) => by[event] || 0;
  return {
    hook_installed: scanHooks(command).valid, report_success: logs.filter(x => x.ok).length,
    report_failure: logs.filter(x => !x.ok).length, queue_length: q.count === null ? 0 : q.count,
    dead_letter_count: q.dead_letter_count || 0, recent_latency_ms: logs.at(-1)?.latency_ms || 0,
    heartbeat_total: metric('heartbeat'), remote_test_total: metric('remote_test'), duplicate_total: metric('duplicate'), repair_total: metric('repair'),
    events: by, doctor_status: d.overall, machine: get().name,
  };
}
function prometheus(m) {
  const lines = ['# TYPE cr_helper_hook_installed gauge', `cr_helper_hook_installed ${m.hook_installed ? 1 : 0}`,
    `cr_helper_report_success_total ${m.report_success}`, `cr_helper_report_failure_total ${m.report_failure}`, `cr_helper_queue_length ${m.queue_length}`, `cr_helper_dead_letter_count ${m.dead_letter_count}`, `cr_helper_recent_latency_ms ${m.recent_latency_ms}`];
  for (const key of ['heartbeat_total', 'remote_test_total', 'duplicate_total', 'repair_total']) lines.push(`cr_helper_${key} ${Number(m[key]) || 0}`);
  for (const [e, n] of Object.entries(m.events || {})) lines.push(`cr_helper_events_total{event="${String(e).replace(/[^a-z0-9_]/gi, '_')}"} ${n}`);
  lines.push(`cr_helper_doctor_status{status="${m.doctor_status}"} 1`); return lines.join('\n') + '\n';
}
module.exports = { collect, prometheus };
