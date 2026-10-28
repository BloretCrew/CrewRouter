// 演示模式：客户端事件接口（demo 接口缺路由，结构与 server/routes/client-events.js 的 /live 一致，示例数据）
const express = require('express');
const router = express.Router();

router.get('/live', (req, res) => {
  const windowSec = Math.min(Math.max(parseInt(req.query.window, 10) || 300, 30), 86400);
  const now = Date.now();
  const ago = (s) => new Date(now - s * 1000).toISOString();
  const sources = [
    { harness: 'codex', active_sessions: 2, tool_calls: 38, failure_count: 1, total_events: 64, last_event_at: ago(25), avg_latency_ms: 240 },
    { harness: 'claude_code', active_sessions: 1, tool_calls: 21, failure_count: 0, total_events: 33, last_event_at: ago(70), avg_latency_ms: 310 },
  ].map(r => ({ ...r, suspected_offline: now - new Date(r.last_event_at).getTime() > Math.max(windowSec * 1000, 120000) }));
  const sessions = [
    { harness: 'codex', session_id: 'demo-sess-codex-1', cwd: '/workspace/crewrouter', tool_name: 'shell', ts: ago(25), machine_id: 'demo-mac', machine_name: 'Demo MacBook' },
    { harness: 'codex', session_id: 'demo-sess-codex-2', cwd: '/workspace/plugin-lab', tool_name: 'apply_patch', ts: ago(140), machine_id: 'demo-mac', machine_name: 'Demo MacBook' },
    { harness: 'claude_code', session_id: 'demo-sess-cc-1', cwd: '/workspace/analytics-dashboard', tool_name: 'Read', ts: ago(70), machine_id: 'demo-linux', machine_name: 'Demo Linux' },
  ];
  const machines = sessions.reduce((out, row) => {
    if (!out[row.machine_id]) out[row.machine_id] = { id: row.machine_id, name: row.machine_name, harness: row.harness, last_event_at: row.ts, last_session: row.session_id, failure_count: 0, latency_ms: 0, suspected_offline: false };
    return out;
  }, {});
  res.json({ window: windowSec, sources, machines, sessions: sessions.map(s => ({ ...s, logical_session_id: s.session_id })) });
});

router.all('*', (req, res) => res.json(req.method === 'GET' ? {} : { success: true }));

module.exports = router;
