'use strict';

const express = require('express');
const { pool } = require('../models/database');
const { claimThread, decideApproval } = require('../utils/agent-state');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { upstreamUrl, validateUrl } = require('../utils/url-validator');
const { getPrimaryApiKey, buildKeyAttemptOrder } = require('../utils/provider-keys');
const { selectHealthyWeighted } = require('../utils/provider-selector');
const { loadPersistedEdition } = require('../utils/instance-edition');
const { logAction, ACTIONS } = require('../utils/audit-log');
const { ensureAgentSchema } = require('../utils/agent-schema');
const {
  executeTool,
  validateToolCall,
  resolveToolDecision,
  redactSecrets,
  openAiTools,
  anthropicTools,
  systemPrompt
} = require('../utils/agent-tools');
const { buildApprovalPreview } = require('../utils/agent-approval-preview');
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
const { createModelIdentity, normalizeModel } = require('../utils/model-identity');
const { recordAgentUsage, assertHasBalance, logAgentError } = require('../utils/agent-billing');
const {
  readAgentUploads,
  processUploads,
  bindAttachments,
  listThreadAttachments,
  deleteAttachment,
  getAttachmentContent,
  cleanupDraftAttachments,
  loadVisionImages,
  attachmentManifest,
  toMessageAttachments,
  mapAttachment
} = require('../utils/agent-attachments');
const { fetchUrlAsAttachment } = require('../utils/agent-fetch');

const router = express.Router();
const { requestMiddleware: quotaRequestMiddleware, quotaFetch } = require('../utils/quota-request-context');
router.use(quotaRequestMiddleware);

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
  let attachments = row.attachments;
  if (typeof attachments === 'string') {
    try { attachments = JSON.parse(attachments); } catch (_) { attachments = null; }
  }
  return {
    role: row.role,
    content: row.content || '',
    tool_calls: Array.isArray(toolCalls) ? toolCalls : null,
    tool_call_id: row.tool_call_id || null,
    tool_name: row.tool_name || null,
    attachments: Array.isArray(attachments) ? attachments : null
  };
}

function parseAttachmentIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(Number.isInteger))].slice(0, 10);
}

async function attachImagesToLatestUser(messages, db, { userId, threadId }) {
  let target = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') { target = messages[index]; break; }
  }
  if (!target || !Array.isArray(target.attachments) || !target.attachments.length) return;
  const imageIds = target.attachments
    .filter(item => item.kind === 'image' && Number.isInteger(Number(item.id)))
    .map(item => Number(item.id));
  if (!imageIds.length) return;
  const images = await loadVisionImages(db, { userId, threadId, ids: imageIds });
  if (images.length) target.images = images;
}

async function saveThreadMessages(threadId, messages, transaction) {
  const client = transaction || await pool.connect();
  try {
    if (!transaction) await client.query('BEGIN');
    await client.query('SELECT id FROM agent_threads WHERE id=$1 FOR UPDATE', [threadId]);
    await client.query('DELETE FROM agent_messages WHERE thread_id = $1', [threadId]);
    for (const message of messages) {
      await client.query(
        `INSERT INTO agent_messages (thread_id, role, content, tool_calls, tool_call_id, tool_name, attachments)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb)`,
        [
          threadId,
          message.role,
          message.content || '',
          message.tool_calls ? JSON.stringify(message.tool_calls) : null,
          message.tool_call_id || null,
          message.tool_name || null,
          Array.isArray(message.attachments) && message.attachments.length
            ? JSON.stringify(message.attachments) : null
        ]
      );
    }
    await client.query('UPDATE agent_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = $1', [threadId]);
    if (!transaction) await client.query('COMMIT');
  } catch (err) {
    if (!transaction) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (!transaction) client.release();
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
  if (['gemini', 'google'].includes(String(provider.format || '').toLowerCase())) {
    const error = new Error('Agent 暂不支持 Gemini 供应商');
    error.code = 'unsupported_provider_format';
    throw error;
  }
  const format = provider.format === 'anthropic' ? 'anthropic' : 'openai';
  const url = upstreamUrl(provider.base_url, format === 'anthropic' ? '/messages' : '/chat/completions');
  const urlCheck = await validateUrl(url, { allowPrivate: false });
  if (!urlCheck.ok) throw new Error(`供应商 URL 校验失败: ${urlCheck.error}`);
  const body = format === 'anthropic'
    ? {
      model: model.upstream_model_id,
      max_tokens: 8192,
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
    const response = await quotaFetch(urlCheck.url.toString(), {
      quotaProvider: provider,
      quotaKey: attempts[i],
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
      redirect: 'manual'
    });
    if (response.ok) {
      const json = await response.json();
      const identity = createModelIdentity(null, body.model);
      identity.observe(json);
      identity.finish();
      return { ...parseModelResponse(format, json), usage: extractUsage(json), quotaAttempt: response.quotaAttempt, identity: identity.snapshot() };
    }
    lastStatus = response.status;
    lastText = await response.text().catch(() => '');
    if (i < attempts.length - 1 && (lastStatus === 429 || lastStatus >= 500 || lastStatus === 401 || lastStatus === 403)) continue;
    break;
  }
  throw new Error(redactError(lastText) || `上游返回 ${lastStatus}`);
}

async function continueManage(req, res, { thread, messages, model, claim }) {
  const send = beginSse(res);
  send({ type: 'run.started', payload: { thread_id: thread.id } });
  const usages = [];
  const identities = [];
  try {
    const edition = await loadPersistedEdition(pool);
    const toolContext = {
      edition: edition || 'personal',
      userId: req.authUser.id,
      threadId: thread.id
    };
    await attachImagesToLatestUser(messages, pool, toolContext);
    const imageBlocks = messages.flatMap(message => (message.images || []).map(image => ({
      type: 'image_url',
      image_url: { url: `data:${image.mime};base64,` }
    })));
    const requestBody = imageBlocks.length ? { messages: [{ role: 'user', content: imageBlocks }] } : null;
    const result = await runManageLoop({
      messages,
      modelCaller: async (current) => {
        const reply = await callManageModel(model, current);
        usages.push({ ...(reply.usage || {}), quotaAttempt: reply.quotaAttempt });
        identities.push(reply.identity || null);
        return reply;
      },
      onEvent: async (event) => { send(event); },
      validateWrite: (name, args) => validateToolCall(pool, { name, arguments: args }, toolContext),
      executeRead: (name, args, extra) => executeTool(pool, { name, arguments: args }, { ...toolContext, round: extra?.round })
    });
    if (result.status === 'waiting_approval') {
      try {
        result.approval.preview = await buildApprovalPreview(pool, {
          toolName: result.approval.tool_name,
          args: result.approval.arguments,
          userId: req.authUser.id,
          threadId: thread.id
        });
      } catch (previewError) {
        logAgentError('approval preview', previewError);
        result.approval.preview = null;
      }
    }
    let approvalId;
    const persist = async client => {
      await saveThreadMessages(thread.id, result.messages, client);
      if (result.status === 'waiting_approval') {
        const approval = result.approval;
        const saved = await client.query(
          `INSERT INTO agent_approvals (thread_id, user_id, tool_call_id, tool_name, arguments, status, preview)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6::jsonb) RETURNING id`,
          [
            thread.id,
            req.authUser.id,
            approval.tool_call_id,
            approval.tool_name,
            JSON.stringify(approval.arguments || {}),
            approval.preview ? JSON.stringify(approval.preview) : null
          ]
        );
        approvalId = saved.rows[0].id;
      }
    };
    if (usages.length) {
      await recordAgentUsage({
        userId: req.authUser.id, modelConfig: model, requestType: 'agent_manage',
        attempts: usages.map(usage => usage.quotaAttempt).filter(Boolean),
        promptTokens: usages.reduce((sum, item) => sum + Number(item.prompt_tokens || 0), 0),
        completionTokens: usages.reduce((sum, item) => sum + Number(item.completion_tokens || 0), 0),
        requestBody,
        req, persist, transactionClient: claim?.client,
        identity: {
          requested_model: normalizeModel(req.body?.model),
          resolved_model: identities.every(item => item?.resolved_model === identities[0]?.resolved_model) ? identities[0]?.resolved_model : null,
          response_model: identities.every(item => item?.response_model && item.response_model === identities[0]?.response_model) ? identities[0]?.response_model : null
        }
      });
    } else {
      const client = claim?.client || await pool.connect();
      try {
        await client.query('BEGIN');
        await persist(client);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { if (!claim?.client) client.release(); }
    }
    // Completion and approval events follow the atomic history/billing commit.
    if (result.status === 'waiting_approval') {
      send({ type: 'approval.required', payload: {
        id: result.approval.tool_call_id,
        name: result.approval.tool_name,
        arguments: result.approval.arguments,
        approval_id: approvalId,
        preview: result.approval.preview || null
      } });
    } else if (result.status === 'failed') {
      send({ type: 'run.failed', payload: { error: result.error || '管理对话失败' } });
    } else {
      send({ type: 'run.completed', payload: { content: result.content || '' } });
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
    const balance = await assertHasBalance(req.authUser.id);
    if (!balance.ok) return res.status(balance.status).json({ error: balance.error });
    const model = await loadUsableModel(req.authUser.id, req.body?.model);
    const modelCheck = assertImageModel(model);
    if (!modelCheck.ok) return res.status(modelCheck.status).json({ error: modelCheck.error });

    let bytes = TEST_IMAGE_PNG;
    let mime = 'image/png';
    let usage = null;
    const identity = createModelIdentity(req.body?.model, isTestImageModel(model) ? null : model.upstream_model_id);
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
        const response = await quotaFetch(urlCheck.url.toString(), {
          quotaProvider: provider,
          quotaKey: attempts[i],
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
          identity.observe(payload);
          identity.finish();
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
    let saved;
    const tokens = imageUsageTokens(usage);
    await recordAgentUsage({
      userId: req.authUser.id, modelConfig: model, requestType: 'imagine',
      promptTokens: tokens.promptTokens, completionTokens: tokens.completionTokens,
      identity: identity.snapshot(), req,
      persist: async client => {
        saved = await insertImage(client, { userId: req.authUser.id, modelId: model.id,
          prompt, size: sizeCheck.size, mime, bytes });
        if (!saved.ok) throw new Error(saved.error);
      }
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
    if (err.billingFailure) return res.status(err.status || 500).json({ error: err.message });
    res.status(500).json({ error: '生成图片失败' });
  }
});

router.get('/images', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, model_id, prompt, size, mime, created_at
       FROM agent_images WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [req.authUser.id]
    );
    res.json(result.rows.map(row => ({ ...row, url: `/api/agent/images/${row.id}/content` })));
  } catch (err) {
    logAgentError('images.list', err);
    res.status(500).json({ error: '读取图片历史失败' });
  }
});

router.get('/images/:id/content', requireAuth, async (req, res) => {
  try {
    const row = await getImageContent(pool, req.params.id, req.authUser.id);
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

router.post('/manage/attachments', requireAuth, requireAdmin, async (req, res) => {
  try {
    const upload = await readAgentUploads(req);
    let threadId = null;
    if (upload.threadId !== undefined && upload.threadId !== null && String(upload.threadId).trim() !== '') {
      threadId = Number(upload.threadId);
      if (!Number.isInteger(threadId) || threadId <= 0) {
        return res.status(400).json({ error: '无效的 thread_id', code: 'invalid_thread_id' });
      }
      const thread = await pool.query(
        "SELECT id FROM agent_threads WHERE id = $1 AND user_id = $2 AND mode = 'manage'",
        [threadId, req.authUser.id]
      );
      if (!thread.rows[0]) return res.status(404).json({ error: '对话不存在', code: 'thread_not_found' });
    }
    const result = await processUploads(pool, {
      files: upload.files,
      userId: req.authUser.id,
      threadId
    });
    res.json(result);
  } catch (err) {
    logAgentError('attachments.upload', err);
    res.status(err.status || 500).json({ error: err.message || '上传附件失败', code: err.code || undefined });
  }
});

router.post('/manage/attachments/url', requireAuth, requireAdmin, async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: '请输入链接', code: 'url_required' });
    let threadId = null;
    if (req.body?.thread_id !== undefined && req.body?.thread_id !== null && String(req.body.thread_id).trim() !== '') {
      threadId = Number(req.body.thread_id);
      if (!Number.isInteger(threadId) || threadId <= 0) {
        return res.status(400).json({ error: '无效的 thread_id', code: 'invalid_thread_id' });
      }
      const thread = await pool.query(
        "SELECT id FROM agent_threads WHERE id = $1 AND user_id = $2 AND mode = 'manage'",
        [threadId, req.authUser.id]
      );
      if (!thread.rows[0]) return res.status(404).json({ error: '对话不存在', code: 'thread_not_found' });
    }
    const fetched = await fetchUrlAsAttachment(pool, {
      url,
      userId: req.authUser.id,
      threadId,
      maxChars: 6000
    });
    const row = await pool.query(
      'SELECT * FROM agent_attachments WHERE id = $1 AND user_id = $2',
      [fetched.attachment_id, req.authUser.id]
    );
    res.json({ attachment: row.rows[0] ? mapAttachment(row.rows[0]) : null, preview: fetched });
  } catch (err) {
    logAgentError('attachments.url', err);
    res.status(err.status || 500).json({ error: err.message || '抓取链接失败', code: err.code || undefined });
  }
});

router.delete('/manage/attachments/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const threadId = Number(req.query?.thread_id) || null;
    const deleted = await deleteAttachment(pool, {
      id: Number(req.params.id),
      userId: req.authUser.id,
      threadId
    });
    if (!deleted) return res.status(404).json({ error: '附件不存在或已绑定其他对话', code: 'attachment_not_found' });
    res.json({ success: true });
  } catch (err) {
    logAgentError('attachments.delete', err);
    res.status(500).json({ error: '删除附件失败' });
  }
});

router.get('/manage/attachments/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = await pool.query(
      'SELECT * FROM agent_attachments WHERE id = $1 AND user_id = $2',
      [id, req.authUser.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: '附件不存在', code: 'attachment_not_found' });
    res.json(mapAttachment(result.rows[0]));
  } catch (err) {
    logAgentError('attachments.get', err);
    res.status(500).json({ error: '读取附件失败' });
  }
});

router.get('/manage/attachments/:id/content', requireAuth, requireAdmin, async (req, res) => {
  try {
    const row = await getAttachmentContent(pool, {
      id: Number(req.params.id),
      userId: req.authUser.id
    });
    if (!row) return res.status(404).json({ error: '图片附件不存在', code: 'attachment_not_found' });
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(row.bytes);
  } catch (err) {
    logAgentError('attachments.content', err);
    res.status(500).json({ error: '读取附件失败' });
  }
});

router.get('/manage/threads', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, model_id, created_at, updated_at
       FROM agent_threads WHERE user_id = $1 AND mode = 'manage'
       ORDER BY updated_at DESC LIMIT 50`,
      [req.authUser.id]
    );
    res.json(result.rows);
  } catch (err) {
    logAgentError('threads', err);
    res.status(500).json({ error: '读取管理对话失败' });
  }
});

router.get('/manage/threads/:id', requireAuth, requireAdmin, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const thread = await client.query(
      `SELECT id, title, model_id, created_at, updated_at
       FROM agent_threads WHERE id = $1 AND user_id = $2 AND mode = 'manage'`,
      [req.params.id, req.authUser.id]
    );
    if (!thread.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: '对话不存在' }); }
    const messages = await client.query(
      `SELECT role, content, tool_calls, tool_call_id, tool_name, attachments
       FROM agent_messages WHERE thread_id = $1 ORDER BY id`,
      [req.params.id]
    );
    const approval = await client.query(
      `SELECT id, tool_call_id, tool_name, arguments, status, preview
       FROM agent_approvals
       WHERE thread_id = $1 AND user_id = $2 AND status = 'pending'
       ORDER BY id DESC LIMIT 1`,
      [req.params.id, req.authUser.id]
    );
    const attachments = await listThreadAttachments(client, {
      userId: req.authUser.id,
      threadId: Number(req.params.id)
    });
    await client.query('COMMIT');
    res.json({
      ...thread.rows[0],
      messages: messages.rows.map(normalizeMessage),
      approval: approval.rows[0] || null,
      attachments
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    logAgentError('thread', err);
    res.status(500).json({ error: '读取管理对话失败' });
  } finally { if (client) client.release(); }
});

router.post('/manage/runs', requireAuth, requireAdmin, async (req, res) => {
  let claim;
  try {
    const text = String(req.body?.text || '').trim();
    const attachmentIds = parseAttachmentIds(req.body?.attachment_ids);
    if (!text && !attachmentIds.length) return res.status(400).json({ error: '请输入内容或添加附件' });
    const balance = await assertHasBalance(req.authUser.id);
    if (!balance.ok) return res.status(balance.status).json({ error: balance.error });
    const model = await loadUsableModel(req.authUser.id, req.body?.model);
    if (!model) return res.status(404).json({ error: '模型不存在或已禁用' });
    if (model.output_kind === 'image') return res.status(400).json({ error: '请选择对话模型' });

    await cleanupDraftAttachments(pool, req.authUser.id);
    let threadId = Number(req.body?.thread_id) || null;
    let messages = [];
    if (threadId) {
      const existing = await pool.query(
        `SELECT id, title FROM agent_threads WHERE id = $1 AND user_id = $2 AND mode = 'manage'`,
        [threadId, req.authUser.id]
      );
      if (!existing.rows[0]) return res.status(404).json({ error: '对话不存在' });
      claim = await claimThread(pool, threadId, req.authUser.id);
      if (!claim) return res.status(409).json({ error: '对话正在处理中，请稍后重试' });
      const pending = await pool.query(
        `SELECT id FROM agent_approvals WHERE thread_id = $1 AND status = 'pending'`,
        [threadId]
      );
      if (pending.rows.length) return res.status(409).json({ error: '请先处理待审批的工具调用' });
      const stored = await pool.query(
        `SELECT role, content, tool_calls, tool_call_id, tool_name, attachments
         FROM agent_messages WHERE thread_id = $1 ORDER BY id`,
        [threadId]
      );
      messages = stored.rows.map(normalizeMessage);
    } else {
      const title = (text || '新对话').slice(0, 40);
      const created = await pool.query(
        `INSERT INTO agent_threads (user_id, mode, title, model_id)
         VALUES ($1, 'manage', $2, $3) RETURNING id`,
        [req.authUser.id, title, model.id]
      );
      threadId = created.rows[0].id;
      claim = await claimThread(pool, threadId, req.authUser.id);
      if (!claim) return res.status(409).json({ error: '对话正在处理中，请稍后重试' });
    }
    const attachments = attachmentIds.length
      ? await bindAttachments(pool, { userId: req.authUser.id, threadId, ids: attachmentIds })
      : [];
    const manifest = attachmentManifest(attachments);
    const content = [text, manifest].filter(Boolean).join('\n\n');
    messages.push({
      role: 'user',
      content,
      tool_calls: null,
      tool_call_id: null,
      tool_name: null,
      attachments: toMessageAttachments(attachments)
    });
    await continueManage(req, res, { thread: { id: threadId }, messages, model, claim });
  } catch (err) {
    logAgentError('runs', err);
    if (!res.headersSent) {
      const status = err.status || (err.code === 'attachment_unavailable' ? 409 : 500);
      res.status(status).json({ error: err.message || '管理对话失败', code: err.code || undefined });
    } else if (!res.writableEnded) res.end();
  } finally {
    if (claim) try { await claim.release(); } catch (error) { logAgentError('thread claim cleanup', error); }
  }
});

router.post('/manage/approvals/:id', requireAuth, requireAdmin, async (req, res) => {
  let claim;
  let committedApproval;
  try {
    const decision = req.body?.decision === 'allow' ? 'allow' : (req.body?.decision === 'deny' ? 'deny' : '');
    if (!decision) return res.status(400).json({ error: '无效决定' });
    const approvalResult = await pool.query(
      `SELECT a.id, a.thread_id, a.tool_call_id, a.tool_name, a.arguments, t.model_id
       FROM agent_approvals a
       JOIN agent_threads t ON t.id = a.thread_id AND t.user_id = a.user_id
       WHERE a.id = $1 AND a.user_id = $2 AND a.status = 'pending'`,
      [req.params.id, req.authUser.id]
    );
    const approval = approvalResult.rows[0];
    if (!approval) return res.status(404).json({ error: '审批不存在或已处理' });
    const model = await loadUsableModel(req.authUser.id, approval.model_id);
    if (!model) return res.status(404).json({ error: '模型不存在或已禁用' });
    claim = await claimThread(pool, approval.thread_id, req.authUser.id);
    if (!claim) return res.status(409).json({ error: '对话正在处理中，请稍后重试' });
    const edition = await loadPersistedEdition(pool);
    const applied = await decideApproval(pool, { threadId: approval.thread_id,
      approvalId: approval.id, userId: req.authUser.id, decision, edition: edition || 'personal', transactionClient: claim.client },
    (db, call, contextDecision, ctx) => resolveToolDecision(db, call, contextDecision, ctx).then(redactSecrets));
    if (!applied) return res.status(404).json({ error: '审批不存在或已处理' });
    committedApproval = { id: approval.id, status: decision === 'allow' ? 'approved' : 'denied' };
    const output = applied.output;
    if (decision === 'allow' && output && !output.error) {
      const isMultiplierBatch = approval.tool_name === 'batch_set_model_multipliers';
      const action = isMultiplierBatch ? ACTIONS.ADMIN_MODEL_BATCH
        : (approval.tool_name === 'set_provider_enabled' ? ACTIONS.ADMIN_PROVIDER_TOGGLE : ACTIONS.ADMIN_MODEL_UPDATE);
      const details = isMultiplierBatch
        ? {
          updated: output.updated,
          unchanged: output.unchanged,
          changes: Array.isArray(output.changes) ? output.changes.slice(0, 200) : [],
          basis: redactSecrets(approval.arguments?.basis),
          currency: redactSecrets(approval.arguments?.currency),
          fx_rate: approval.arguments?.fx_rate,
          markup: approval.arguments?.markup
        }
        : redactSecrets(approval.arguments);
      try { await logAction({
        userId: req.authUser.id,
        username: req.authUser.username,
        isAdmin: true,
        action,
        resourceType: approval.tool_name === 'set_provider_enabled' ? 'provider' : 'model',
        resourceId: isMultiplierBatch ? null : (output.id || null),
        description: isMultiplierBatch
          ? `Blora Agent 批量调整 ${output.updated} 个模型倍率`
          : `Blora Agent ${approval.tool_name}`,
        details,
        ip: req.ip,
        userAgent: req.get('user-agent')
      }); } catch (error) { logAgentError('audit after committed approval', error); }
    }
    const stored = await pool.query(
      `SELECT role, content, tool_calls, tool_call_id, tool_name, attachments
       FROM agent_messages WHERE thread_id=$1 ORDER BY id`, [approval.thread_id]);
    const messages = stored.rows.map(normalizeMessage);
    await continueManage(req, res, { thread: { id: approval.thread_id }, messages, model, claim });
  } catch (err) {
    logAgentError('approval', err);
    if (committedApproval && !res.headersSent) {
      return res.status(503).json({ error: '审批已处理，后续对话暂不可用，请刷新查看审批结果',
        approval_applied: true, approval_id: committedApproval.id, status: committedApproval.status });
    }
    const conflictCodes = new Set(['stale_multiplier', 'model_not_found', 'unmatched_models']);
    if (!res.headersSent && conflictCodes.has(err.code)) {
      return res.status(409).json({ error: err.message, code: err.code, details: err.details || null });
    }
    if (!res.headersSent && err.code) {
      return res.status(400).json({ error: err.message, code: err.code, details: err.details || null });
    }
    if (!res.headersSent) res.status(500).json({ error: '处理审批失败' });
    else if (!res.writableEnded) res.end();
  } finally {
    if (claim) try { await claim.release(); } catch (error) { logAgentError('thread claim cleanup', error); }
  }
});

module.exports = router;
module.exports.ensureAgentSchema = ensureAgentSchema;
