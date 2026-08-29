'use strict';

const express = require('express');
const router = express.Router();

const now = Date.now();
const conversations = [
  { id: 'demo-conv-1', title: '分析 CrewRouter 架构', model: 'gpt-4.1', created_at: new Date(now - 86400000).toISOString(), updated_at: new Date(now - 3600000).toISOString(), messages: [
    { role: 'user', content: '请概括一下这个项目的架构。' },
    { role: 'assistant', content: 'CrewRouter 是一个统一的 AI API 网关，包含模型管理、用量统计、Playground 和插件系统。' },
  ] },
  { id: 'demo-conv-2', title: '优化插件商店体验', model: 'claude-sonnet-4-20250514', created_at: new Date(now - 3 * 86400000).toISOString(), updated_at: new Date(now - 2 * 3600000).toISOString(), messages: [
    { role: 'user', content: '如何让插件详情页更容易理解？' },
    { role: 'assistant', content: '可以补充权限说明、评分摘要、安装方式和相关插件推荐。' },
  ] },
];

router.get('/', (req, res) => res.json(conversations.map(({ messages, ...conversation }) => conversation)));
router.post('/', (req, res) => {
  const item = { id: `demo-conv-${Date.now()}`, title: req.body?.title || '新对话（演示）', model: req.body?.model || 'gpt-4.1', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), messages: Array.isArray(req.body?.messages) ? req.body.messages : [] };
  conversations.unshift(item);
  res.json({ id: item.id });
});
router.get('/:id', (req, res) => {
  const item = conversations.find(c => c.id === req.params.id);
  if (!item) return res.status(404).json({ error: '对话不存在' });
  res.json(item);
});
router.put('/:id', (req, res) => { const item = conversations.find(c => c.id === req.params.id); if (item) Object.assign(item, req.body || {}, { updated_at: new Date().toISOString() }); res.json({ ok: true }); });
router.post('/:id/messages', (req, res) => { const item = conversations.find(c => c.id === req.params.id); if (item && Array.isArray(req.body?.messages)) item.messages.push(...req.body.messages); res.json({ ok: true }); });
router.put('/:id/messages', (req, res) => { const item = conversations.find(c => c.id === req.params.id); if (item) item.messages = Array.isArray(req.body?.messages) ? req.body.messages : []; res.json({ ok: true }); });
router.post('/:id/fork', (req, res) => { const item = conversations.find(c => c.id === req.params.id); if (!item) return res.status(404).json({ error: '对话不存在' }); const copy = { ...item, id: `demo-conv-${Date.now()}`, title: `${item.title} (副本)`, messages: item.messages.slice(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; conversations.unshift(copy); res.json({ id: copy.id }); });
router.delete('/:id', (req, res) => { const index = conversations.findIndex(c => c.id === req.params.id); if (index >= 0) conversations.splice(index, 1); res.json({ ok: true }); });

module.exports = router;
