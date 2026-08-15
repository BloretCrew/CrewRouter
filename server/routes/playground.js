const express = require('express');
const router = express.Router();
const { pool } = require('../models/database');
const { requireAuth } = require('../middleware/auth');
const Logger = require('../logger');
const config = require('../config-loader');
const { normalizeUsageTokens } = require('../utils/token-normalize');
const { calculateCost } = require('../utils/billing');
const { recordQuotaData } = require('../utils/quota-data');
const { recordModelCall } = require('../utils/model-uptime');
const { recordLiveCallTest } = require('../utils/model-test');
const { calculatePointsToDeduct } = require('../utils/points-deduct');
const { clientMetaFromReq } = require('../utils/request-source');
const { notifyUser, NOTIFICATION_TYPES } = require('../utils/notifications');

const UPSTREAM_TIMEOUT = 60000;
const UPSTREAM_STREAM_TIMEOUT = 300000; // 流式请求超时 5 分钟

// 判断模型是否支持思考模式
function supportsThinking(model, providerId) {
  // DeepSeek 模型支持思考切换
  if (providerId === 'deepseek' && model.startsWith('deepseek-')) return true;
  // Anthropic Claude 模型支持思考
  if (providerId === 'anthropic') return true;
  // OpenAI o1/o3 系列支持 reasoning_effort
  if (providerId === 'openai' && /^(o1|o3|o4)/.test(model)) return true;
  return false;
}

// 判断模型是否支持思考强度调节
function supportsThinkingBudget(model, providerId) {
  // Anthropic 支持 budget_tokens
  if (providerId === 'anthropic') return true;
  // OpenAI o1/o3 支持 reasoning_effort
  if (providerId === 'openai' && /^(o1|o3|o4)/.test(model)) return true;
  return false;
}

const { getPrimaryApiKey, buildKeyAttemptOrder } = require('../utils/provider-keys');

async function getEffectiveApiKey(provider) {
  return getPrimaryApiKey(provider) || null;
}

/** 固定密钥多 Key 尝试序（Playground 简化：无脚本刷新） */
function resolvePlaygroundKeyAttempts(provider) {
  const order = buildKeyAttemptOrder(provider);
  if (order.length) return order;
  const k = getPrimaryApiKey(provider);
  return k ? [k] : [];
}

router.post('/chat', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  let { model, messages, temperature, max_tokens, top_p, stream, thinking, thinking_budget, reasoning_effort } = req.body;

  if (!model || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  try {
    const userResult = await pool.query('SELECT balance + refund_balance as total FROM users WHERE id = $1', [userId]);
    const totalBalance = parseFloat(userResult.rows[0]?.total || 0);
    if (totalBalance <= 0) {
      notifyUser(userId, NOTIFICATION_TYPES.QUOTA_INSUFFICIENT, '余额不足，请先充值后再发起请求。', { source: 'playground' }).catch(() => {});
      return res.status(402).json({ error: '余额不足，请先充值' });
    }

    let modelResult = await pool.query('SELECT * FROM models WHERE id = $1 AND enabled = TRUE', [model]);
    if (modelResult.rows.length === 0) {
      modelResult = await pool.query('SELECT * FROM models WHERE alias = $1 AND enabled = TRUE', [model]);
    }
    if (modelResult.rows.length === 0) {
      return res.status(404).json({ error: `模型 '${model}' 不存在或已禁用` });
    }
    const modelConfig = modelResult.rows[0];
    // 使用 upstream_model_id 作为发给上游的模型名
    model = modelConfig.upstream_model_id || modelConfig.id;

    // TestModel 特殊处理：直接返回固定文本，不调用外部 API
    if (modelConfig.id === 'test-model' || model === 'test-model') {
      Logger.info(`[Playground] TestModel: 直接返回固定文本, stream=${!!stream}`);
      const testModelText = '这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！';
      const testModelThinking = '用户想要测试一个模型。这是一个测试模型，它只会返回固定的文本内容。我应该先思考一下如何回复，然后返回预设的文本。这个测试模型主要用于验证系统的流式传输功能是否正常工作，包括思考过程的流式输出和正文的流式输出。思考过程应该先输出，然后再输出正文内容。';
      
      if (stream !== false) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const chunkSize = 5;
        const delayMs = 30;
        let phase = 'thinking'; // 'thinking' -> 'content'
        let index = 0;

        const sendChunk = () => {
          if (phase === 'thinking') {
            if (index >= testModelThinking.length) {
              phase = 'content';
              index = 0;
              setTimeout(sendChunk, delayMs);
              return;
            }

            const chunk = testModelThinking.slice(index, index + chunkSize);
            index += chunkSize;

            res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: chunk }, index: 0 }] })}\n\n`);
            setTimeout(sendChunk, delayMs);
          } else {
            if (index >= testModelText.length) {
              res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }

            const chunk = testModelText.slice(index, index + chunkSize);
            index += chunkSize;

            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, index: 0 }] })}\n\n`);
            setTimeout(sendChunk, delayMs);
          }
        };

        sendChunk();
      } else {
        res.json({
          id: 'chatcmpl-test-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{ index: 0, message: { role: 'assistant', content: testModelText, reasoning_content: testModelThinking }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
      }
      return;
    }

    // 获取供应商（支持同组负载均衡）
    let providerResult = await pool.query('SELECT * FROM providers WHERE id = $1 AND enabled = TRUE', [modelConfig.provider]);
    if (providerResult.rows.length === 0) {
      return res.status(500).json({ error: '供应商未配置' });
    }
    let provider = providerResult.rows[0];

    // 同组负载均衡：查找同组其他可用供应商
    if (provider.grp) {
      const groupResult = await pool.query(
        'SELECT * FROM providers WHERE grp = $1 AND enabled = TRUE',
        [provider.grp]
      );
      if (groupResult.rows.length > 1) {
        const candidates = groupResult.rows;
        provider = candidates[Math.floor(Math.random() * candidates.length)];
        Logger.info(`[Playground] 供应商组 "${provider.grp}": 从 ${candidates.length} 个中选择 ${provider.id}`);
      }
    }

    const keyAttempts = resolvePlaygroundKeyAttempts(provider);
    if (!keyAttempts.length) {
      return res.status(500).json({ error: '供应商 API Key 未配置' });
    }

    const isStream = stream !== false;
    const upstreamBody = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: isStream
    };
    if (isStream) {
      upstreamBody.stream_options = { include_usage: true };
    }
    if (temperature !== undefined) upstreamBody.temperature = temperature;
    if (max_tokens !== undefined) upstreamBody.max_tokens = max_tokens;
    if (top_p !== undefined) upstreamBody.top_p = top_p;

    // 处理思考模式参数
    const effectiveThinking = thinking !== false; // 默认启用思考
    if (provider.format === 'anthropic') {
      // Anthropic: 使用 thinking 参数
      if (effectiveThinking) {
        const budgetTokens = thinking_budget || max_tokens || 4096;
        upstreamBody.thinking = { type: 'enabled', budget_tokens: budgetTokens };
        upstreamBody.max_tokens = budgetTokens + 4096; // 需要额外空间给非思考内容
      }
    } else if (/^(o1|o3|o4)/.test(model)) {
      // OpenAI o1/o3/o4: 使用 reasoning_effort 参数
      if (!effectiveThinking) {
        upstreamBody.reasoning_effort = 'low';
      } else if (reasoning_effort) {
        upstreamBody.reasoning_effort = reasoning_effort;
      }
    }

    let url;
    if (provider.format === 'anthropic') {
      url = `${provider.base_url}/messages`;
      const systemMsg = messages.find(m => m.role === 'system');
      const nonSystem = messages.filter(m => m.role !== 'system');
      upstreamBody.messages = nonSystem;
      // 对于 Anthropic，如果启用了思考，max_tokens 已经在上面设置过了
      if (!effectiveThinking || !upstreamBody.thinking) {
        upstreamBody.max_tokens = max_tokens || 4096;
      }
      if (systemMsg) upstreamBody.system = systemMsg.content;
    } else {
      const baseUrl = provider.base_url.replace(/\/$/, '');
      const chatPath = (baseUrl.endsWith('/v1') || baseUrl.endsWith('/api')) ? '/chat/completions' : '/v1/chat/completions';
      url = `${baseUrl}${chatPath}`;
    }

    // 多 Key：顺序 / 权重尝试，失败后 fallback
    let response = null;
    let lastErrText = '';
    let lastStatus = 502;
    for (let ki = 0; ki < keyAttempts.length; ki++) {
      const apiKey = keyAttempts[ki];
      provider = { ...provider, api_key: apiKey };
      const headers = provider.format === 'anthropic'
        ? {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          }
        : {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          };
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(isStream ? UPSTREAM_STREAM_TIMEOUT : UPSTREAM_TIMEOUT)
        });
      } catch (fetchErr) {
        lastErrText = fetchErr.message || 'fetch failed';
        lastStatus = 502;
        response = null;
        if (ki < keyAttempts.length - 1) {
          Logger.warn(`[Playground] Key ${ki + 1}/${keyAttempts.length} 请求失败，切换下一 Key: ${lastErrText}`);
          continue;
        }
        throw fetchErr;
      }
      if (response.ok) break;
      lastStatus = response.status;
      lastErrText = await response.text().catch(() => '');
      if (ki < keyAttempts.length - 1 && (lastStatus === 429 || lastStatus >= 500 || lastStatus === 401 || lastStatus === 403)) {
        Logger.warn(`[Playground] Key ${ki + 1}/${keyAttempts.length} HTTP ${lastStatus}，切换下一 Key`);
        response = null;
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      Logger.error(`[Playground] 上游错误: provider=${provider.id}, url=${url}, status=${lastStatus}, body=${String(lastErrText).substring(0, 500)}`);
      recordModelCall(model, false);
      recordLiveCallTest(model, { ok: false, error: `HTTP ${lastStatus}` });
      return res.status(lastStatus || 502).json({ error: `上游服务错误 (${lastStatus})`, detail: String(lastErrText).substring(0, 500) });
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      Logger.stream(`[Playground] SSE 头已发送, 开始流式传输: provider=${provider.id}, model=${model}, url=${url}, format=${provider.format}`);
      const streamStartTime = Date.now();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let totalContent = '';
      let totalReasoning = '';
      let lastUsage = null;
      let anthropicUsage = { input_tokens: 0 };
      let completionTokens = 0;
      let finishReason = null;
      let chunkCount = 0;
      let sseLineCount = 0;
      let jsonParseErrors = 0;
      let firstChunkTime = null;
      let clientDisconnected = false;
      let backpressureCount = 0;

      // 检测客户端断开连接
      req.on('close', () => {
        clientDisconnected = true;
        Logger.stream(`[Playground] 客户端断开连接: provider=${provider.id}, model=${model}, 已接收 ${chunkCount} 个chunk, ${sseLineCount} 行SSE`);
      });

      // 背压处理
      const writeWithDrain = (data) => {
        if (clientDisconnected) return false;
        const ok = res.write(data);
        if (!ok) {
          backpressureCount++;
          if (backpressureCount <= 3 || backpressureCount % 10 === 0) {
            Logger.warn(`[Playground] 背压等待drain: provider=${provider.id}, model=${model}, 累计=${backpressureCount}次`);
          }
        }
        return ok;
      };

      const waitForDrain = () => {
        return new Promise((resolve) => {
          if (clientDisconnected) { resolve(); return; }
          const onDrain = () => { cleanup(); resolve(); };
          const onClose = () => { cleanup(); resolve(); };
          const cleanup = () => { res.removeListener('drain', onDrain); req.removeListener('close', onClose); };
          res.once('drain', onDrain);
          req.once('close', onClose);
        });
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (clientDisconnected) {
            Logger.stream(`[Playground] 客户端已断开, 停止读取上游: provider=${provider.id}, model=${model}`);
            break;
          }

          if (!firstChunkTime) {
            firstChunkTime = Date.now();
            Logger.stream(`[Playground] 收到首个上游chunk: 等待耗时=${firstChunkTime - streamStartTime}ms, chunk大小=${value.length}bytes`);
          }
          chunkCount++;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            sseLineCount++;
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              Logger.stream(`[Playground] 收到上游 [DONE] 事件`);
              const ok = writeWithDrain('data: [DONE]\n\n');
              if (!ok) await waitForDrain();
              continue;
            }
            try {
              const parsed = JSON.parse(data);

              if (provider.format === 'anthropic') {
                if (parsed.type === 'content_block_delta') {
                  if (parsed.delta?.type === 'thinking') {
                    const thinkingChunk = parsed.delta?.thinking || '';
                    totalReasoning += thinkingChunk;
                    const ok = writeWithDrain(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: thinkingChunk }, index: 0 }] })}\n\n`);
                    if (!ok) await waitForDrain();
                  } else {
                    const chunk = parsed.delta?.text || '';
                    totalContent += chunk;
                    const ok = writeWithDrain(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, index: 0 }] })}\n\n`);
                    if (!ok) await waitForDrain();
                  }
                } else if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'thinking') {
                  const ok = writeWithDrain(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '' }, index: 0 }] })}\n\n`);
                  if (!ok) await waitForDrain();
                } else if (parsed.type === 'message_start' && parsed.message?.usage) {
                  anthropicUsage = parsed.message.usage;
                } else if (parsed.type === 'message_delta' && parsed.usage) {
                  completionTokens = parsed.usage.output_tokens || 0;
                  finishReason = parsed.delta?.stop_reason || finishReason;
                } else if (parsed.type === 'message_stop') {
                  Logger.stream(`[Playground] 收到上游 message_stop 事件`);
                  const ok = writeWithDrain('data: [DONE]\n\n');
                  if (!ok) await waitForDrain();
                }
              } else {
                const content = parsed.choices?.[0]?.delta?.content || '';
                const reasoningContent = parsed.choices?.[0]?.delta?.reasoning_content || '';
                totalContent += content;
                totalReasoning += reasoningContent;
                if (parsed.usage) {
                  lastUsage = parsed.usage;
                }
                const finish = parsed.choices?.[0]?.finish_reason;
                if (finish) finishReason = finish;
                const forward = {};
                if (content) forward.content = content;
                if (reasoningContent) forward.reasoning_content = reasoningContent;
                if (Object.keys(forward).length > 0) {
                  const ok = writeWithDrain(`data: ${JSON.stringify({ choices: [{ delta: forward, index: 0 }] })}\n\n`);
                  if (!ok) await waitForDrain();
                }
              }
            } catch (e) {
              jsonParseErrors++;
              Logger.warn(`[Playground] JSON解析失败: data=${data.substring(0, 200)}, error=${e.message}`);
            }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') {
          Logger.error(`[Playground] 流式超时 (${UPSTREAM_STREAM_TIMEOUT}ms): url=${url}, model=${model}, 已接收 ${chunkCount} chunks`);
        } else if (clientDisconnected) {
          Logger.warn(`[Playground] 上游读取中断(客户端已断开): url=${url}, model=${model}, error=${err.message}`);
        } else {
          Logger.error(`[Playground] 流式读取错误: ${err.message}, chunkCount=${chunkCount}`);
        }
      }

      res.end();

      // Normalize tokens based on provider format
      let normalized;
      if (provider.format === 'anthropic') {
        const syntheticUsage = {
          input_tokens: anthropicUsage.input_tokens || 0,
          output_tokens: completionTokens
        };
        normalized = normalizeUsageTokens(syntheticUsage, 'anthropic');
      } else {
        normalized = normalizeUsageTokens(lastUsage, 'openai');
        normalized.completionTokens = completionTokens;
      }

      const totalTokens = (normalized.promptTokens || 0) + (normalized.completionTokens || 0);
      // 倍率计费
      let weightedTokens = 0;
      let pointsCost = 0;
      if (totalTokens > 0) {
        const calculated = calculateCost(modelConfig, normalized);
        weightedTokens = calculated.weightedTokens;
        pointsCost = calculated.pointsCost;
      }

      Logger.stream(`[Playground] 流式传输统计: chunkCount=${chunkCount}, sseLineCount=${sseLineCount}, jsonParseErrors=${jsonParseErrors}, contentLength=${totalContent.length}, reasoningLength=${totalReasoning.length}, 首chunk耗时=${firstChunkTime ? firstChunkTime - streamStartTime : '-'}ms, 客户端断开=${clientDisconnected}, 背压次数=${backpressureCount}`);
      Logger.info(`[Playground] 流式完成: model=${model}, promptTokens=${normalized.promptTokens}, completionTokens=${normalized.completionTokens}, totalTokens=${totalTokens}, points=${pointsCost}`);
      const requestParams = { temperature, max_tokens, top_p, thinking: effectiveThinking, thinking_budget, reasoning_effort };
      try {
        await recordUsage(userId, modelConfig.id, totalTokens, weightedTokens, pointsCost, messages, totalContent, normalized, totalReasoning, requestParams, finishReason, req);
      } catch (e) {
        Logger.error(`[Playground] 记录使用量异常: ${e.message}`);
      }
      recordModelCall(model, true);
      recordLiveCallTest(model, {
        ok: true,
        latency_ms: typeof streamStartTime === 'number' ? Date.now() - streamStartTime : undefined,
        promptTokens: normalized?.promptTokens,
        completionTokens: normalized?.completionTokens
      });
    } else {
      const data = await response.json();

      let normalized;
      if (provider.format === 'anthropic') {
        normalized = normalizeUsageTokens(data.usage, 'anthropic');
        const openaiResp = {
          id: data.id || 'chatcmpl-' + Date.now(),
          choices: [{
            message: { role: 'assistant', content: data.content?.[0]?.text || '' },
            finish_reason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason || 'stop'
          }],
          usage: { prompt_tokens: normalized.promptTokens, completion_tokens: normalized.completionTokens, total_tokens: normalized.totalTokens }
        };
        res.json(openaiResp);
      } else {
        normalized = normalizeUsageTokens(data.usage, 'openai');
        res.json(data);
      }

      const totalTokens = (normalized.promptTokens || 0) + (normalized.completionTokens || 0);
      // 倍率计费
      let weightedTokens = 0;
      let pointsCost = 0;
      if (totalTokens > 0) {
        const calculated = calculateCost(modelConfig, normalized);
        weightedTokens = calculated.weightedTokens;
        pointsCost = calculated.pointsCost;
      }

      const responseContent = data.choices?.[0]?.message?.content || data.content?.[0]?.text || null;
      const reasoningContent = data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning || null;
      const finishReason = data.choices?.[0]?.finish_reason || data.stop_reason || null;
      Logger.info(`[Playground] 非流式完成: model=${model}, promptTokens=${normalized.promptTokens}, completionTokens=${normalized.completionTokens}, totalTokens=${totalTokens}, points=${pointsCost}`);
      const requestParams = { temperature, max_tokens, top_p, thinking: effectiveThinking, thinking_budget, reasoning_effort };
      try {
        await recordUsage(userId, modelConfig.id, totalTokens, weightedTokens, pointsCost, messages, responseContent, normalized, reasoningContent, requestParams, finishReason, req);
      } catch (e) {
        Logger.error(`[Playground] 记录使用量异常: ${e.message}`);
      }
      recordModelCall(model, true);
      recordLiveCallTest(model, {
        ok: true,
        promptTokens: normalized?.promptTokens,
        completionTokens: normalized?.completionTokens
      });
    }
  } catch (error) {
    Logger.error(`[Playground] 错误: model=${model}, userId=${userId}, error=${error.message}, stack=${error.stack}`);
    if (model) {
      recordModelCall(model, false);
      recordLiveCallTest(model, { ok: false, error: error.message });
    }
    if (!res.headersSent) {
      res.status(500).json({ error: '服务器错误: ' + error.message });
    }
  }
});

async function recordUsage(userId, modelId, totalTokens, weightedTokens, pointsCost, messages, response, normalized, reasoningContent, requestParams, finishReason, req) {
  try {
    // 与 API 一致：组配额未耗尽时实扣可为 0
    let groupId = null;
    try {
      const ug = await pool.query('SELECT group_id FROM users WHERE id = $1', [userId]);
      groupId = ug.rows[0]?.group_id || null;
    } catch (_) { /* ignore */ }
    const pointsToDeduct = await calculatePointsToDeduct({
      userId,
      groupId,
      weightedTokens,
      pointsCost
    });
    const clientMeta = clientMetaFromReq(req || {});

    Logger.info(`[Playground计费] 准备记录: userId=${userId}, modelId=${modelId}, tokens=${totalTokens}, theory=${pointsCost}, deduct=${pointsToDeduct}`);
    const messagesJson = messages ? JSON.stringify(messages) : null;
    const responseText = response || null;
    const promptTokens = normalized?.promptTokens || 0;
    const completionTokens = normalized?.completionTokens || 0;
    const reasoningText = reasoningContent || null;
    const paramsJson = requestParams ? JSON.stringify(requestParams) : null;
    const finish = finishReason || null;
    // 解析供应商：modelId 应为本地 models.id
    let providerId = null;
    try {
      const pr = await pool.query('SELECT provider FROM models WHERE id = $1', [modelId]);
      providerId = pr.rows[0]?.provider || null;
    } catch (_) { /* ignore */ }

    await pool.query(
      `INSERT INTO usage_records (user_id, model_id, tokens_used, weighted_tokens, prompt_tokens, completion_tokens,
       provider_id, request_type, messages, response, cost, reasoning_content, request_params, finish_reason, request_source, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [userId, modelId, totalTokens, weightedTokens, promptTokens, completionTokens,
       providerId, 'playground', messagesJson, responseText, pointsToDeduct, reasoningText, paramsJson, finish,
       clientMeta.requestSource, clientMeta.userAgent]
    );
    Logger.info(`[Playground计费] 记录成功`);
    if (pointsToDeduct > 0) {
      const { deductPoints } = require('../utils/balance');
      await deductPoints(userId, pointsToDeduct);
    }
    recordQuotaData(userId, modelId, totalTokens, weightedTokens, pointsToDeduct);
  } catch (err) {
    Logger.error(`[Playground计费] 完整INSERT失败: ${err.message}, 尝试简化INSERT`);
    try {
      const promptTokens = normalized?.promptTokens || 0;
      const completionTokens = normalized?.completionTokens || 0;
      // 简化路径同样走配额实扣
      let groupId = null;
      try {
        const ug = await pool.query('SELECT group_id FROM users WHERE id = $1', [userId]);
        groupId = ug.rows[0]?.group_id || null;
      } catch (_) { /* ignore */ }
      const pointsToDeduct = await calculatePointsToDeduct({
        userId, groupId, weightedTokens, pointsCost
      });
      const clientMeta = clientMetaFromReq(req || {});
      await pool.query(
        `INSERT INTO usage_records (user_id, model_id, tokens_used, weighted_tokens, prompt_tokens, completion_tokens, cost, request_type, provider_id, request_source, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'playground',
           (SELECT provider FROM models WHERE id = $2 LIMIT 1), $8, $9)`,
        [userId, modelId, totalTokens, weightedTokens, promptTokens, completionTokens, pointsToDeduct,
         clientMeta.requestSource, clientMeta.userAgent]
      );
      Logger.info(`[Playground计费] 简化INSERT成功`);
      if (pointsToDeduct > 0) {
        const { deductPoints } = require('../utils/balance');
        await deductPoints(userId, pointsToDeduct);
      }
      recordQuotaData(userId, modelId, totalTokens, weightedTokens, pointsToDeduct);
    } catch (err2) {
      Logger.error(`[Playground计费] 简化INSERT也失败: ${err2.message}`);
      Logger.error(`[Playground计费] 堆栈: ${err2.stack}`);
    }
  }
}

// 诊断接口：检查 usage_records 表是否存在及字段
router.get('/diagnose', requireAuth, async (req, res) => {
  try {
    const tableCheck = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_records' ORDER BY ordinal_position`);
    const columns = tableCheck.rows.map(r => r.column_name);
    const countResult = await pool.query('SELECT COUNT(*) as total FROM usage_records');
    const recentResult = await pool.query('SELECT id, user_id, model_id, tokens_used, cost, created_at FROM usage_records ORDER BY created_at DESC LIMIT 5');
    res.json({ columns, totalRecords: parseInt(countResult.rows[0].total), recentRecords: recentResult.rows });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// 获取模型思考能力信息
router.get('/thinking-capabilities', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, provider, alias FROM models WHERE enabled = TRUE');
    const capabilities = {};
    for (const m of result.rows) {
      const modelId = m.alias || m.id;
      capabilities[modelId] = {
        supportsThinking: supportsThinking(m.id, m.provider),
        supportsThinkingBudget: supportsThinkingBudget(m.id, m.provider)
      };
    }
    res.json(capabilities);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// 获取 PlayGround 历史记录
router.get('/history', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const model = req.query.model || null;

    // 仅展示未从 Playground 历史隐藏的记录；用量明细仍保留全部成功行
    let where = 'WHERE user_id = $1 AND request_type = \'playground\' AND COALESCE(history_hidden, FALSE) = FALSE';
    const params = [userId];

    if (model) {
      params.push(model);
      where += ` AND model_id = $${params.length}`;
    }

    const countResult = await pool.query(`SELECT COUNT(*) as total FROM usage_records ${where}`, params);
    const total = parseInt(countResult.rows[0].total);

    const result = await pool.query(`
      SELECT id, model_id, prompt_tokens, completion_tokens, tokens_used, cost,
             reasoning_content, request_params, finish_reason, response, messages,
             created_at
      FROM usage_records
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    res.json({
      total,
      limit,
      offset,
      records: result.rows.map(r => ({
        id: r.id,
        model: r.model_id,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        totalTokens: r.tokens_used,
        cost: parseFloat(r.cost),
        reasoningContent: r.reasoning_content,
        requestParams: r.request_params ? (typeof r.request_params === 'string' ? JSON.parse(r.request_params) : r.request_params) : null,
        finishReason: r.finish_reason,
        response: r.response,
        messages: r.messages ? (typeof r.messages === 'string' ? JSON.parse(r.messages) : r.messages) : null,
        createdAt: r.created_at
      }))
    });
  } catch (err) {
    Logger.error('[获取PlayGround历史] 错误:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取单条 PlayGround 历史详情
router.get('/history/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await pool.query(
      `SELECT id, model_id, prompt_tokens, completion_tokens, tokens_used, cost,
              reasoning_content, request_params, finish_reason, response, messages,
              created_at
       FROM usage_records
       WHERE id = $1 AND user_id = $2 AND request_type = 'playground'
         AND COALESCE(history_hidden, FALSE) = FALSE`,
      [req.params.id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '记录不存在' });
    }

    const r = result.rows[0];
    res.json({
      id: r.id,
      model: r.model_id,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      totalTokens: r.tokens_used,
      cost: parseFloat(r.cost),
      reasoningContent: r.reasoning_content,
      requestParams: r.request_params ? (typeof r.request_params === 'string' ? JSON.parse(r.request_params) : r.request_params) : null,
      finishReason: r.finish_reason,
      response: r.response,
      messages: r.messages ? (typeof r.messages === 'string' ? JSON.parse(r.messages) : r.messages) : null,
      createdAt: r.created_at
    });
  } catch (err) {
    Logger.error('[获取PlayGround历史详情] 错误:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 从 PlayGround 历史列表隐藏（软删）：不删除 usage_records，调用记录/统计仍可见
router.delete('/history/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const result = await pool.query(
      `UPDATE usage_records
       SET history_hidden = TRUE
       WHERE id = $1 AND user_id = $2 AND request_type = 'playground'
       RETURNING id`,
      [req.params.id, userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: '记录不存在' });
    }
    res.json({ success: true });
  } catch (err) {
    Logger.error('[删除PlayGround历史] 错误:', err);
    res.status(500).json({ error: '服务器错误' });
  }
});

module.exports = router;
