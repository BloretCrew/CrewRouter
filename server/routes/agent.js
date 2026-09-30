'use strict';

const express = require('express');
const { pool } = require('../models/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { upstreamUrl, validateUrl } = require('../utils/url-validator');
const { getPrimaryApiKey, buildKeyAttemptOrder } = require('../utils/provider-keys');
const { selectHealthyWeighted } = require('../utils/provider-selector');
const { loadPersistedEdition } = require('../utils/instance-edition');
const { logAction, ACTIONS } = require('../utils/audit-log');
const { ensureAgentSchema } = require('../utils/agent-schema');
const {
  executeTool,
  resolveToolDecision,
  redactSecrets,
  openAiTools,
  anthropicTools,
  systemPrompt
} = require('../utils/agent-tools');
const {
  assertImageModel,
  assertImageSize,
  decodeImagePayload,
  isTestImageModel,
  TEST_IMAGE_PNG,
  sniffMime,
  imageUsageTokens,
  insertImage,
  getImageContent
} = require('../utils/agent-images');
const {
  parseModelResponse,
  extractUsage,
  replyAsTestModel,
  runManageLoop,
  toOpenAiMessages,
  toAnthropicMessages
} = require('../utils/agent-loop');
const { recordAgentUsage, assertHasBalance, logAgentError } = require('../utils/agent-billing');

const router = express.Router();

function keyAttempts(provider) {
  const order = buildKeyAttemptOrder(provider);
  if (order.length) return order;
  const key = getPrimaryApiKey(provider);
  return key ? [key] : [];
}

function redactError(text) {
  return String(text || '').replace(/\b(?:sk|key|tok)-[A-Za-z0-9_\-]{8,}\b/g, '[redacted]').slice(0, 500);
}

async function loadUsableModel(userId, modelId) {
  const result = await pool.query(
    `SELECT m.id, m.name, m.provider, m.enabled,
            COALESCE(m.output_kind, 'chat') AS output_kind,
            COALESCE(NULLIF(m.upstream_model_id, ''), m.id) AS upstream_model_id,
            m.model_multiplier
     FROM models m
     JOIN providers p ON p.id = m.provider AND p.enabled = TRUE
     JOIN team_models tm ON tm.model_id = m.id AND tm.enabled = TRUE
     JOIN user_teams ut ON ut.team_id = tm.team_id AND ut.user_id = $1
     WHERE m.id = $2 AND m.enabled = TRUE
     LIMIT 1`,
    [userId, modelId]
  );
  return result.rows[0] || null;
}

async function loadProvider(model) {
  const result = await pool.query('SELECT * FROM providers WHERE id = $1 AND enabled = TRUE', [model.provider]);
  let provider = result.rows[0];
  if (!provider) return null;
  if (provider.grp) {
    const group = await pool.query('SELECT * FROM providers WHERE grp = $1 AND enabled = TRUE', [provider.grp]);
    if (group.rows.length > 1) {
      provider = selectHealthyWeighted(group.rows, `provider:${provider.grp}`) || provider;
    }
  }
  return provider;
}

function beginSse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

function normalizeMessage(row) {
  let toolCalls = row.tool_calls;
  if (typeof toolCalls === 'string') {
    try { toolCalls = JSON.parse(toolCalls); } catch (_) { toolCalls = null; }
  }
  return {
    role: row.role,
    content: row.content || '',
    tool_calls: Array.isArray(toolCalls) ? toolCalls : null,
    tool_call_id: row.tool_call_id || null,
    tool_name: row.tool_name || null
  };
}

async function saveThreadMessages(threadId, messages) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM agent_messages WHERE thread_id = $1', [threadId]);
    for (const message of messages) {
      await client.query(
        `INSERT INTO agent_messages (thread_id, role, content, tool_calls, tool_call_id, tool_name)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          threadId,
          message.role,
          message.content || '',
          message.tool_calls ? JSON.stringify(message.tool_calls) : null,
          message.tool_call_id || null,
          message.tool_name || null
        ]
      );
    }
    await client.query('UPDATE agent_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [threadId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function callManageModel(model, messages) {
  if (model.id === 'test-model' || model.upstream_model_id === 'test-model') {
    return { ...replyAsTestModel(messages), usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }
  const provider = await loadProvider(model);
  if (!provider) throw new Error('供应商未配置');
  const attempts = keyAttempts(provider);
  if (!attempts.length) throw new Error('供应商 API Key 未配置');
  const format = provider.format === 'anthropic' ? 'anthropic' : 'openai';
  const url = upstreamUrl(provider.base_url, format === 'anthropic' ? '/messages' : '/chat/completions');
  const urlCheck = await validateUrl(url, { allowPrivate: false });
  if (!urlCheck.ok) throw new Error(`供应商 URL 校验失败: ${urlCheck.error}`);
  const body = format === 'anthropic'
    ? {
      model: model.upstream_model_id,
      max_tokens: 4096,
      system: systemPrompt(),
      tools: anthropicTools(),
      messages: toAnthropicMessages(messages)
    }
    : {
      model: model.upstream_model_id,
      temperature: 0.2,
      messages: toOpenAiMessages(messages, systemPrompt()),
      tools: openAiTools()
    };
  let lastStatus = 502;
  let lastText = '上游请求失败';
  for (let i = 0; i < attempts.length; i += 1) {
    const headers = format === 'anthropic'
      ? { 'Content-Type': 'application/json', 'x-api-key': attempts[i], 'anthropic-version': '2023-06-01' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${attempts[i]}` };
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
      redirect: 'manual'
    });
    if (response.ok) {
      const json = await response.json();
      return { ...parseModelResponse(format, json), usage: extractUsage(json) };
    }
    lastStatus = response.status;
    lastText = await response.text().catch(() => '');
    if (i < attempts.length - 1 && (lastStatus === 429 || lastStatus >= 500 || lastStatus === 401 || lastStatus === 403)) continue;
    break;
  }
  throw new Error(redactError(lastText) || `上游返回 ${lastStatus}`);
}

async function continueManage(req, res, { thread, messages, model }) {
  const send = beginSse(res);
  send({ type: 'run.started', payload: { thread_id: thread.id } });
  const usages = [];
  try {
    const edition = await loadPersistedEdition(pool);
    const result = await runManageLoop({
      messages,
      modelCaller: async (current) => {
        const reply = await callManageModel(model, current);
        usages.push(reply.usage || {});
        return reply;
      },
      onEvent: async (event) => { send(event); },
      executeRead: (name, args) => executeTool(pool, { name, arguments: args }, { edition: edition || 'personal' })
    });
    await saveThreadMessages(thread.id, result.messages);
    if (result.status === 'waiting_approval') {
      const approval = result.approval;
      const saved = await pool.query(
        `INSERT INTO agent_approvals (thread_id, user_id, tool_call_id, tool_name, arguments, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'pending') RETURNING id`,
        [thread.id, req.session.user.id, approval.tool_call_id, approval.tool_name, JSON.stringify(approval.arguments || {})]
      );
      send({
        type: 'approval.required',
        payload: {
          id: approval.tool_call_id,
          name: approval.tool_name,
          arguments: approval.arguments,
          approval_id: saved.rows[0].id
        }
      });
    } else if (result.status === 'failed') {
      send({ type: 'run.failed', payload: { error: result.error || '管理对话失败' } });
    } else {
      send({ type: 'run.completed', payload: { content: result.content || '' } });
    }
    const promptTokens = usages.reduce((sum, item) => sum + Number(item.prompt_tokens || 0), 0);
    const completionTokens = usages.reduce((sum, item) => sum + Number(item.completion_tokens || 0), 0);
    if (usages.length) {
      try {
        await recordAgentUsage({
          userId: req.session.user.id,
          modelConfig: model,
          requestType: 'agent_manage',
          promptTokens,
          completionTokens,
          req
        });
      } catch (billingErr) {
        logAgentError('billing', billingErr);
      }
    }
  } catch (err) {
    logAgentError('manage', err);
    if (!res.writableEnded) send({ type: 'run.failed', payload: { error: redactError(err.message) } });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

router.post('/images', requireAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt || prompt.length > 4000) return res.status(400).json({ error: '请填写 4000 字以内的提示词' });
    const sizeCheck = assertImageSize(req.body?.size);
    if (!sizeCheck.ok) return res.status(sizeCheck.status).json({ error: sizeCheck.error });
    const balance = await assertHasBalance(req.session.user.id);
    if (!balance.ok) return res.status(balance.status).json({ error: balance.error });
    const model = await loadUsableModel(req.session.user.id, req.body?.model);
    const modelCheck = assertImageModel(model);
    if (!modelCheck.ok) return res.status(modelCheck.status).json({ error: modelCheck.error });

    let bytes = TEST_IMAGE_PNG;
    let mime = 'image/png';
    let usage = null;
    if (!isTestImageModel(model)) {
      const provider = await loadProvider(model);
      if (!provider) return res.status(500).json({ error: '供应商未配置' });
      const attempts = keyAttempts(provider);
      if (!attempts.length) return res.status(500).json({ error: '供应商 API Key 未配置' });
      const url = upstreamUrl(provider.base_url, '/images/generations');
      const urlCheck = await validateUrl(url, { allowPrivate: false });
      if (!urlCheck.ok) return res.status(400).json({ error: `供应商 URL 校验失败: ${urlCheck.error}` });
      let lastStatus = 502;
      let lastText = '上游请求失败';
      let payload = null;
      for (let i = 0; i < attempts.length; i += 1) {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${attempts[i]}` },
          body: JSON.stringify({
            model: model.upstream_model_id,
            prompt,
            size: sizeCheck.size,
            n: 1,
            response_format: 'b64_json'
          }),
          signal: AbortSignal.timeout(60000),
          redirect: 'manual'
        });
        if (response.ok) {
          payload = await response.json();
          break;
        }
        lastStatus = response.status;
        lastText = await response.text().catch(() => '');
        if (i < attempts.length - 1 && (lastStatus === 429 || lastStatus >= 500 || lastStatus === 401 || lastStatus === 403)) continue;
        return res.status(lastStatus).json({ error: redactError(lastText) || `上游返回 ${lastStatus}` });
      }
      const decoded = decodeImagePayload(payload);
      if (!decoded.ok) return res.status(decoded.status).json({ error: decoded.error });
      bytes = decoded.bytes;
      mime = decoded.mime || sniffMime(bytes);
      usage = payload?.usage || null;
    }
    const saved = await insertImage(pool, {
      userId: req.session.user.id,
      modelId: model.id,
      prompt,
      size: sizeCheck.size,
      mime,
      bytes
    });
    if (!saved.ok) return res.status(saved.status).json({ error: saved.error });
    const tokens = imageUsageTokens(usage);
    await recordAgentUsage({
      userId: req.session.user.id,
      modelConfig: model,
      requestType: 'imagine',
      promptTokens: tokens.promptTokens,
      completionTokens: tokens.completionTokens,
      req
    });
    res.json({
      id: saved.id,
      model_id: model.id,
      prompt,
      size: sizeCheck.size,
      mime,
      created_at: saved.created_at,
      url: `/api/agent/images/${saved.id}/content`
    });
  } catch (err) {
    logAgentError('images', err);
    res.status(500).json({ error: '生成图片失败' });
  }
});

router.get('/images', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, model_id, prompt, size, mime, created_at
       FROM agent_images WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [req.session.user.id]
    );
    res.json(result.rows.map(row => ({ ...row, url: `/api/agent/images/${row.id}/content` })));
  } catch (err) {
    logAgentError('images.list', err);
    res.status(500).json({ error: '读取图片历史失败' });
  }
});

router.get('/images/:id/content', requireAuth, async (req, res) => {
  try {
    const row = await getImageContent(pool, req.params.id, req.session.user.id);
    if (!row) return res.status(404).json({ error: '图片不存在' });
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.bytes);
  } catch (err) {
    logAgentError('images.content', err);
    res.status(500).json({ error: '读取图片失败' });
  }
});

router.get('/manage/threads', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, model_id, created_at, updated_at
       FROM agent_threads WHERE user_id = $1 AND mode = 'manage'
       ORDER BY updated_at DESC LIMIT 50`,
      [req.session.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    logAgentError('threads', err);
    res.status(500).json({ error: '读取管理对话失败' });
  }
});

router.get('/manage/threads/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const thread = await pool.query(
      `SELECT id, title, model_id, created_at, updated_at
       FROM agent_threads WHERE id = $1 AND user_id = $2 AND mode = 'manage'`,
      [req.params.id, req.session.user.id]
    );
    if (!thread.rows[0]) return res.status(404).json({ error: '对话不存在' });
    const messages = await pool.query(
      `SELECT role, content, tool_calls, tool_call_id, tool_name
       FROM agent_messages WHERE thread_id = $1 ORDER BY id`,
      [req.params.id]
    );
    const approval = await pool.query(
      `SELECT id, tool_call_id, tool_name, arguments, status
       FROM agent_approvals
       WHERE thread_id = $1 AND user_id = $2 AND status = 'pending'
       ORDER BY id DESC LIMIT 1`,
      [req.params.id, req.session.user.id]
    );
    res.json({
      ...thread.rows[0],
      messages: messages.rows.map(normalizeMessage),
      approval: approval.rows[0] || null
    });
  } catch (err) {
    logAgentError('thread', err);
    res.status(500).json({ error: '读取管理对话失败' });
  }
});

router.post('/manage/runs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: '请输入内容' });
    const balance = await assertHasBalance(req.session.user.id);
    if (!balance.ok) return res.status(balance.status).json({ error: balance.error });
    const model = await loadUsableModel(req.session.user.id, req.body?.model);
    if (!model) return res.status(404).json({ error: '模型不存在或已禁用' });
    if (model.output_kind === 'image') return res.status(400).json({ error: '请选择对话模型' });

    let threadId = Number(req.body?.thread_id) || null;
    let messages = [];
    if (threadId) {
      const existing = await pool.query(
        `SELECT id, title FROM agent_threads WHERE id = $1 AND user_id = $2 AND mode = 'manage'`,
        [threadId, req.session.user.id]
      );
      if (!existing.rows[0]) return res.status(404).json({ error: '对话不存在' });
      const pending = await pool.query(
        `SELECT id FROM agent_approvals WHERE thread_id = $1 AND status = 'pending'`,
        [threadId]
      );
      if (pending.rows.length) return res.status(409).json({ error: '请先处理待审批的工具调用' });
      const stored = await pool.query(
        `SELECT role, content, tool_calls, tool_call_id, tool_name
         FROM agent_messages WHERE thread_id = $1 ORDER BY id`,
        [threadId]
      );
      messages = stored.rows.map(normalizeMessage);
    } else {
      const title = text.slice(0, 40);
      const created = await pool.query(
        `INSERT INTO agent_threads (user_id, mode, title, model_id)
         VALUES ($1, 'manage', $2, $3) RETURNING id`,
        [req.session.user.id, title, model.id]
      );
      threadId = created.rows[0].id;
    }
    messages.push({ role: 'user', content: text, tool_calls: null, tool_call_id: null, tool_name: null });
    await continueManage(req, res, { thread: { id: threadId }, messages, model });
  } catch (err) {
    logAgentError('runs', err);
    if (!res.headersSent) res.status(500).json({ error: '管理对话失败' });
    else if (!res.writableEnded) res.end();
  }
});

router.post('/manage/approvals/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const decision = req.body?.decision === 'allow' ? 'allow' : (req.body?.decision === 'deny' ? 'deny' : '');
    if (!decision) return res.status(400).json({ error: '无效决定' });
    const approvalResult = await pool.query(
      `SELECT a.id, a.thread_id, a.tool_call_id, a.tool_name, a.arguments, t.model_id
       FROM agent_approvals a
       JOIN agent_threads t ON t.id = a.thread_id AND t.user_id = a.user_id
       WHERE a.id = $1 AND a.user_id = $2 AND a.status = 'pending'`,
      [req.params.id, req.session.user.id]
    );
    const approval = approvalResult.rows[0];
    if (!approval) return res.status(404).json({ error: '审批不存在或已处理' });
    const model = await loadUsableModel(req.session.user.id, approval.model_id);
    if (!model) return res.status(404).json({ error: '模型不存在或已禁用' });
    const stored = await pool.query(
      `SELECT role, content, tool_calls, tool_call_id, tool_name
       FROM agent_messages WHERE thread_id = $1 ORDER BY id`,
      [approval.thread_id]
    );
    const messages = stored.rows.map(normalizeMessage);
    const edition = await loadPersistedEdition(pool);
    const output = await resolveToolDecision(
      pool,
      { name: approval.tool_name, arguments: approval.arguments },
      decision,
      { edition: edition || 'personal', approved: true }
    );
    if (decision === 'allow' && output && !output.error) {
      const action = approval.tool_name === 'set_provider_enabled' ? ACTIONS.ADMIN_PROVIDER_TOGGLE : ACTIONS.ADMIN_MODEL_UPDATE;
      await logAction({
        userId: req.session.user.id,
        username: req.session.user.username,
        isAdmin: true,
        action,
        resourceType: approval.tool_name === 'set_provider_enabled' ? 'provider' : 'model',
        resourceId: output.id || null,
        description: `Blora Agent ${approval.tool_name}`,
        details: redactSecrets(approval.arguments),
        ip: req.ip,
        userAgent: req.get('user-agent')
      });
    }
    await pool.query(
      `UPDATE agent_approvals SET status = $1, resolved_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [decision === 'allow' ? 'approved' : 'denied', approval.id]
    );
    messages.push({
      role: 'tool',
      content: JSON.stringify(redactSecrets(output)),
      tool_calls: null,
      tool_call_id: approval.tool_call_id,
      tool_name: approval.tool_name
    });
    await continueManage(req, res, { thread: { id: approval.thread_id }, messages, model });
  } catch (err) {
    logAgentError('approval', err);
    if (!res.headersSent) res.status(500).json({ error: '处理审批失败' });
    else if (!res.writableEnded) res.end();
  }
});

module.exports = router;
module.exports.ensureAgentSchema = ensureAgentSchema;
