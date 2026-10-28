// 演示模式：授权管理列表（只读示例数据，吊销只返回成功不改数据）
const express = require('express');
const router = express.Router();

const now = Date.now();
const DEMO_AUTHORIZATIONS = [
  { id: 1, client_id: 'crewrouter-cli', client_name: 'CrewRouter CLI', scope: 'openid profile api', api_key_id: 1, api_key_name: '生产环境 Key', last_used_at: new Date(now - 2 * 3600000).toISOString(), expires_at: new Date(now + 30 * 86400000).toISOString(), expired: false },
  { id: 2, client_id: 'vscode-ext', client_name: 'VS Code 插件', scope: 'api', api_key_id: 2, api_key_name: '测试环境 Key', last_used_at: null, expires_at: new Date(now - 86400000).toISOString(), expired: true }
];

router.get('/authorizations', (req, res) => res.json({ authorizations: DEMO_AUTHORIZATIONS }));
router.post('/authorizations/revoke', (req, res) => res.json({ ok: true }));

module.exports = router;
