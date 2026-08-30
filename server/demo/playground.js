'use strict';

const express = require('express');
const router = express.Router();

router.get('/thinking-capabilities', (req, res) => res.json({
  'gpt-4.1': { supportsThinking: false, supportsThinkingBudget: false },
  'claude-sonnet-4-20250514': { supportsThinking: true, supportsThinkingBudget: true },
  'deepseek-reasoner': { supportsThinking: true, supportsThinkingBudget: false },
  'o4-mini': { supportsThinking: true, supportsThinkingBudget: true },
}));

router.get('/history', (req, res) => {
  const records = Array.from({ length: 5 }, (_, i) => ({ id: 900 + i, model: ['gpt-4.1', 'claude-sonnet-4-20250514', 'deepseek-reasoner'][i % 3], promptTokens: 240 + i * 31, completionTokens: 180 + i * 22, totalTokens: 420 + i * 53, cost: Number((0.12 + i * 0.04).toFixed(2)), reasoningContent: '演示思考过程：整理上下文并生成答案。', requestParams: { temperature: 0.7, thinking: true }, finishReason: 'stop', response: `这是 Playground 第 ${i + 1} 条演示回复。`, messages: [{ role: 'user', content: `演示问题 ${i + 1}` }], createdAt: new Date(Date.now() - i * 3600000).toISOString() }));
  res.json({ total: records.length, limit: records.length, offset: 0, records });
});
router.get('/history/:id', (req, res) => res.json({ id: Number(req.params.id), model: 'gpt-4.1', promptTokens: 240, completionTokens: 180, totalTokens: 420, cost: 0.12, reasoningContent: '演示思考过程：整理上下文并生成答案。', requestParams: { temperature: 0.7, thinking: true }, finishReason: 'stop', response: '这是 Playground 的演示详情回复。', messages: [{ role: 'user', content: '演示问题' }], createdAt: new Date().toISOString() }));

router.post('/chat', (req, res) => {
  const content = '这是演示模式的固定回复。你可以继续体验消息发送、流式显示、思考过程和用量统计。';
  if (req.body?.stream !== false) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '演示思考：分析问题并组织回答。' }, index: 0 }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }], usage: { prompt_tokens: 32, completion_tokens: 18, total_tokens: 50 } })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  res.json({ id: `demo-chat-${Date.now()}`, choices: [{ message: { role: 'assistant', content, reasoning_content: '演示思考：分析问题并组织回答。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 32, completion_tokens: 18, total_tokens: 50 } });
});

module.exports = router;
