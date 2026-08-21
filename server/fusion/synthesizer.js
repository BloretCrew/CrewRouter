/**
 * Synthesizer - 基于 Judge 分析生成最终回答
 *
 * 职责：
 * - 接收 Judge 分析结果和 Panel 输出
 * - 使用外层模型生成最终高质量回答
 * - 支持流式和非流式输出
 */

const Logger = require('../logger');
const { upstreamUrl } = require('../utils/url-validator');
const {
  ensureChatCompletionChunk,
  buildChatCompletionChunk,
  getOrCreateStreamMeta
} = require('../utils/openai-response-normalize');

// 合成 Prompt 模板
const SYNTHESIS_PROMPT_TEMPLATE = `你是最终回答生成器。根据多个 AI 模型的回答和分析，直接生成一个高质量的最终回答。

要求：
- 直接回答用户问题，不要提及"分析"、"模型"、"共识"等过程
- 综合所有模型的最佳内容，补充遗漏点
- 回答要完整、详细、有深度`;

// 构建合成请求
function buildSynthesisMessages(originalMessages, judgeResult, panelResults) {
  // 获取原始用户问题
  const userQuestion = originalMessages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join('\n');

  // 构建 Panel 模型回答摘要
  const panelSummary = panelResults
    .filter(r => r.success && r.content)
    .map((r, i) => `--- 回答 ${i + 1} (${r.model_id}) ---\n${r.content}`)
    .join('\n\n');

  // 构建 Judge 分析摘要（精简）
  const judgeSummary = buildAnalysisSummary(judgeResult);

  const synthesisContent = `用户问题：${userQuestion}

以下是多个 AI 模型的回答：
${panelSummary}

分析要点：
${judgeSummary}

请综合以上所有回答，直接给出最终回答。`;

  return [
    {
      role: 'system',
      content: SYNTHESIS_PROMPT_TEMPLATE
    },
    {
      role: 'user',
      content: synthesisContent
    }
  ];
}

// 构建分析摘要
function buildAnalysisSummary(judgeResult) {
  const parts = [];

  if (judgeResult.consensus?.length > 0) {
    parts.push(`**共识点：**\n${judgeResult.consensus.map(c => `- ${c}`).join('\n')}`);
  }

  if (judgeResult.contradictions?.length > 0) {
    parts.push(`**矛盾点：**\n${judgeResult.contradictions.map(c => {
      const models = Array.isArray(c.models) ? c.models.join(' vs ') : (c.models || '观点分歧');
      return `- ${c.topic || c}: ${models}`;
    }).join('\n')}`);
  }

  if (judgeResult.blind_spots?.length > 0) {
    parts.push(`**盲点：**\n${judgeResult.blind_spots.map(b => `- ${b}`).join('\n')}`);
  }

  if (judgeResult.unique_insights?.length > 0) {
    parts.push(`**独特洞见：**\n${judgeResult.unique_insights.map(i =>
      `- ${typeof i === 'string' ? i : `[${i.model || '?'}] ${i.insight || i}`
      }`).join('\n')}`);
  }

  return parts.join('\n\n');
}

// 构建独特的 Panel 输出
function buildUniquePanelInsights(panelResults, judgeResult) {
  // 如果 Judge 分析中有独特洞见，提取对应的 Panel 输出
  if (!judgeResult.unique_insights?.length) return '';

  const insights = judgeResult.unique_insights
    .filter(i => i.model && i.insight)
    .slice(0, 3) // 限制数量
    .map(i => {
      const panel = panelResults.find(r => r.model_id === i.model && r.success);
      if (panel) {
        return `来自 ${i.model} 的洞见：\n${panel.content.substring(0, 1000)}${panel.content.length > 1000 ? '...' : ''}`;
      }
      return null;
    })
    .filter(Boolean);

  return insights.join('\n\n');
}

// 运行合成（非流式）
async function synthesizeNonStream(fusionConfig, originalMessages, judgeResult, panelResults, options = {}) {
  const { callModel, temperature, max_tokens, tools, tool_choice, response_format } = options;
  const outerModelId = fusionConfig.outer_model_id;

  if (!outerModelId) {
    throw new Error('未配置外层合成模型');
  }

  Logger.info(`[Synthesizer] 开始合成: 使用模型 ${outerModelId}`);

  try {
    // 构建合成请求
    const synthesisMessages = buildSynthesisMessages(originalMessages, judgeResult, panelResults);

    // 调用外层模型
    const result = await callModel(outerModelId, synthesisMessages, {
      temperature: temperature || fusionConfig.temperature,
      max_tokens: max_tokens || fusionConfig.max_tokens,
      tools,
      tool_choice,
      response_format
    });

    Logger.info(`[Synthesizer] 合成完成: content_length=${result.content?.length || 0}`);

    return {
      content: result.content,
      usage: result.usage,
      model_id: outerModelId
    };
  } catch (err) {
    Logger.error(`[Synthesizer] 合成失败: ${err.message}`);
    throw err;
  }
}

// 运行合成（流式）
async function synthesizeStream(fusionConfig, originalMessages, judgeResult, panelResults, res, options = {}) {
  const outerModelId = fusionConfig.outer_model_id;

  if (!outerModelId) {
    throw new Error('未配置外层合成模型');
  }

  const clientFormat = options.format || 'openai';

  Logger.info(`[Synthesizer] 开始流式合成: 使用模型 ${outerModelId}, clientFormat=${clientFormat}`);

  try {
    // 获取模型和供应商配置
    const { getModelConfig, getProviderForRequest, callModel } = options;
    const modelConfig = await getModelConfig(outerModelId);
    if (!modelConfig) {
      throw new Error(`模型 ${outerModelId} 未找到`);
    }

    const provider = await getProviderForRequest(modelConfig.provider);
    if (!provider) {
      throw new Error(`模型 ${outerModelId} 的供应商未配置`);
    }

    const upstreamModelId = modelConfig.upstream_model_id || modelConfig.id;

    // 构建合成请求
    const synthesisMessages = buildSynthesisMessages(originalMessages, judgeResult, panelResults);

    // 调用上游流式 API
    const { cleanBaseUrl } = require('./index');
    const baseUrl = cleanBaseUrl(provider.base_url);

    // Anthropic 流式需要从 status 块之后继续的 content block 索引
    const anthropicBlockIndex = options.anthropicBlockIndex || 0;

    // 根据客户端格式和供应商格式选择处理方式
    if (clientFormat === 'anthropic') {
      // 客户端期望 Anthropic 格式
      if (provider.format === 'anthropic') {
        // 供应商也是 Anthropic 格式 - 直接转发
        return await streamAnthropicSynthesis(baseUrl, provider, upstreamModelId, synthesisMessages, res, { ...options, anthropicBlockIndex });
      } else {
        // 供应商是 OpenAI 格式 - 需要转换为 Anthropic 格式
        return await streamOpenAIToAnthropicSynthesis(baseUrl, provider, upstreamModelId, synthesisMessages, res, { ...options, anthropicBlockIndex });
      }
    } else {
      // 客户端期望 OpenAI 格式
      if (provider.format === 'anthropic') {
        // 供应商是 Anthropic 格式 - 需要转换为 OpenAI 格式
        return await streamAnthropicToOpenAISynthesis(baseUrl, provider, upstreamModelId, synthesisMessages, res, options);
      } else {
        // 供应商也是 OpenAI 格式 - 直接转发
        return await streamOpenAISynthesis(baseUrl, provider, upstreamModelId, synthesisMessages, res, options);
      }
    }
  } catch (err) {
    Logger.error(`[Synthesizer] 流式合成失败: ${err.message}`);

    // 若已发送 SSE 头且客户端仍连接，尝试优雅终止 Anthropic 流，避免客户端收到截断响应
    if (res && res.headersSent && !res.writableEnded && clientFormat === 'anthropic') {
      try {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0 }
        })}\n\n`);
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        res.end();
        Logger.warn(`[Synthesizer] 已发送 Anthropic 流终止事件`);
      } catch (termErr) {
        Logger.error(`[Synthesizer] 终止 Anthropic 流失败: ${termErr.message}`);
      }
    }

    throw err;
  }
}

// OpenAI 格式流式合成
async function streamOpenAISynthesis(baseUrl, provider, model, messages, res, options = {}) {
  const url = `${upstreamUrl(baseUrl, '/chat/completions')}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.api_key || ''}`
  };

  const body = {
    model,
    messages,
    temperature: options.temperature || 0.7,
    max_tokens: options.max_tokens || 4096,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (options.tools) body.tools = options.tools;
  if (options.tool_choice) body.tool_choice = options.tool_choice;
  if (options.response_format) body.response_format = options.response_format;

  const startTime = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`上游调用失败: ${response.status} - ${err}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalContent = '';
  let lastUsage = null;
  let clientDisconnected = false;
  const streamMeta = getOrCreateStreamMeta(res, { model: model || 'fusion', prefix: 'chatcmpl-fusion' });
  const streamNormLog = { logged: false };

  res.req.on('close', () => {
    clientDisconnected = true;
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientDisconnected) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            totalContent += content;
            if (parsed.usage) {
              lastUsage = parsed.usage;
            }
            // 补全 id/object/created/model，与 Fusion 状态 chunk 使用同一 envelope
            const normalized = ensureChatCompletionChunk(parsed, {
              id: streamMeta.id,
              created: streamMeta.created,
              model: streamMeta.model,
              logPrefix: 'Synthesizer/OpenAI',
              logOnceRef: streamNormLog
            });
            res.write(`data: ${JSON.stringify(normalized)}\n\n`);
          } catch (e) {
            Logger.warn(`[Synthesizer] OpenAI chunk 解析失败: ${e.message}, data=${data.substring(0, 120)}`);
            res.write(line + '\n\n');
          }
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError' && err.name !== 'TimeoutError') {
      Logger.error(`[Synthesizer] 流式读取错误: ${err.message}`);
    }
  }

  res.end();

  const latency = Date.now() - startTime;
  Logger.info(`[Synthesizer] OpenAI 流式完成: latency=${latency}ms, content_length=${totalContent.length}, stream_id=${streamMeta.id}`);

  return {
    content: totalContent,
    usage: {
      promptTokens: lastUsage?.prompt_tokens || 0,
      completionTokens: lastUsage?.completion_tokens || 0,
      cachedTokens: lastUsage?.prompt_tokens_details?.cached_tokens || 0
    },
    model_id: model,
    latency
  };
}

// OpenAI -> Anthropic 格式流式合成（客户端期望 Anthropic，供应商是 OpenAI）
// 状态消息已在 processFusion 中写入 index 0 的 text block（由 sendAnthropicStreamHeader 开启），
// 这里继续向 index 0 追加最终回答，不再新开 content block，与 OpenAI 格式行为一致。
async function streamOpenAIToAnthropicSynthesis(baseUrl, provider, model, messages, res, options = {}) {
  const url = `${upstreamUrl(baseUrl, '/chat/completions')}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.api_key || ''}`
  };

  const body = {
    model,
    messages,
    temperature: options.temperature || 0.7,
    max_tokens: options.max_tokens || 4096,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (options.tools) body.tools = options.tools;
  if (options.tool_choice) body.tool_choice = options.tool_choice;
  if (options.response_format) body.response_format = options.response_format;

  // 始终使用 index 0，与状态消息共用同一个 text block
  const blockIndex = 0;

  Logger.info(`[Synthesizer] OpenAI->Anthropic 流式合成: url=${url}, model=${model}, blockIndex=${blockIndex}`);

  const startTime = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`上游调用失败: ${response.status} - ${err}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalContent = '';
  let lastUsage = null;
  let clientDisconnected = false;
  let chunkCount = 0;
  let stopReason = 'end_turn';

  try {
    res.req.on('close', () => { clientDisconnected = true; });
  } catch (e) { /* ignore */ }

  const writeEvent = (obj) => {
    if (clientDisconnected || !res || res.writableEnded || res.destroyed) return false;
    return res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientDisconnected) break;

      chunkCount++;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta || {};
          const finishReason = parsed.choices?.[0]?.finish_reason;

          if (finishReason) {
            if (finishReason === 'stop') stopReason = 'end_turn';
            else if (finishReason === 'length') stopReason = 'max_tokens';
            else if (finishReason === 'tool_calls') stopReason = 'tool_use';
          }

          // 正文内容 → 追加到 index 0 的 text block
          if (delta.content) {
            totalContent += delta.content;
            writeEvent({
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: delta.content }
            });
          }

          // 推理内容（reasoning_content）丢弃：Fusion 合成阶段只输出最终正文，
          // 且 Anthropic thinking block 需要 signature 字段并在启用 thinking 的 query 中使用，
          // Fusion 合成调用未启用 thinking，输出 thinking block 会触发协议错误。
          if (delta.reasoning_content) {
            Logger.stream(`[Synthesizer] 丢弃上游 reasoning_content: ${delta.reasoning_content.length} chars`);
          }

          if (parsed.usage) lastUsage = parsed.usage;
        } catch (e) { /* ignore */ }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError' && err.name !== 'TimeoutError') {
      Logger.error(`[Synthesizer] OpenAI->Anthropic 流式读取错误: ${err.message}`);
    }
  }

  // 发送 Anthropic 流式结束事件：关闭 index 0 的 text block + message 终止事件
  if (!clientDisconnected) {
    writeEvent({ type: 'content_block_stop', index: blockIndex });
    writeEvent({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: lastUsage?.completion_tokens || 0 }
    });
    writeEvent({ type: 'message_stop' });
    res.end();
  }

  const latency = Date.now() - startTime;
  Logger.info(`[Synthesizer] OpenAI->Anthropic 流式完成: latency=${latency}ms, chunks=${chunkCount}, content_length=${totalContent.length}`);

  return {
    content: totalContent,
    usage: {
      promptTokens: lastUsage?.prompt_tokens || 0,
      completionTokens: lastUsage?.completion_tokens || 0,
      cachedTokens: lastUsage?.prompt_tokens_details?.cached_tokens || 0
    },
    model_id: model,
    latency
  };
}

// Anthropic 格式流式合成（客户端和供应商都是 Anthropic 格式）
async function streamAnthropicSynthesis(baseUrl, provider, model, messages, res, options = {}) {
  const url = `${upstreamUrl(baseUrl, '/messages')}`;
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': provider.api_key || ''
  };

  const systemMessage = messages.find(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  const body = {
    model,
    max_tokens: options.max_tokens || 4096,
    messages: nonSystemMessages.map(m => ({
      role: m.role,
      content: m.content
    })),
    stream: true
  };

  // 透传工具调用定义（OpenAI 格式 -> Anthropic 格式）
  if (options.tools) {
    body.tools = options.tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      input_schema: t.function?.parameters || t.input_schema
    }));
  }
  if (options.tool_choice) {
    const tc = options.tool_choice;
    if (tc === 'auto') body.tool_choice = { type: 'auto' };
    else if (tc === 'required') body.tool_choice = { type: 'any' };
    else if (tc === 'none') body.tool_choice = { type: 'none' };
    else if (tc.type === 'function') body.tool_choice = { type: 'tool', name: tc.function?.name };
    else body.tool_choice = tc;
  }

  if (systemMessage) {
    body.system = systemMessage.content;
  }

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  const startTime = Date.now();
  Logger.info(`[Synthesizer] 调用上游 Anthropic: url=${url}, model=${model}`);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`上游调用失败: ${response.status} - ${err}`);
  }

  Logger.info(`[Synthesizer] 上游响应 OK, 开始读取流`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalContent = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let clientDisconnected = false;
  let chunkCount = 0;

  // 监听客户端断开
  try {
    res.req.on('close', () => {
      clientDisconnected = true;
      Logger.info(`[Synthesizer] 客户端断开连接`);
    });
  } catch (e) {
    Logger.warn(`[Synthesizer] 无法监听客户端断开: ${e.message}`);
  }

  const writeEvent = (obj) => {
    if (clientDisconnected || !res || res.writableEnded || res.destroyed) return false;
    return res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  };

  // index 0 的 text block 已由 sendAnthropicStreamHeader 开启并被状态消息使用。
  // 这里只把上游 text_delta 重定向到 index 0，跳过其它 block（thinking/tool_use）和 content_block_start/stop，
  // 最终由本函数统一发送 content_block_stop + message 终止事件。
  let currentBlockType = null;
  let skipCurrentBlock = false;
  let textDeltaForwarded = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        Logger.info(`[Synthesizer] 上游流结束 (done=true), chunks=${chunkCount}`);
        break;
      }
      if (clientDisconnected) {
        Logger.info(`[Synthesizer] 客户端已断开, 停止读取`);
        break;
      }

      chunkCount++;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) continue; // 不转发上游 event: 行，由我们自己按需构造
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);

          // message_start 已在 processFusion 中发送，跳过
          if (parsed.type === 'message_start') {
            inputTokens = parsed.message?.usage?.input_tokens || 0;
            cachedTokens = parsed.message?.usage?.cache_read_input_tokens || 0;
            Logger.stream(`[Synthesizer] 上游 message_start (已跳过)`);
            continue;
          }

          if (parsed.type === 'content_block_start') {
            currentBlockType = parsed.content_block?.type || null;
            skipCurrentBlock = currentBlockType !== 'text';
            if (skipCurrentBlock) {
              Logger.stream(`[Synthesizer] 跳过上游 ${currentBlockType} block`);
            }
            // 不转发 content_block_start（index 0 已开）
            continue;
          }

          if (parsed.type === 'content_block_delta') {
            if (skipCurrentBlock) continue;
            const deltaType = parsed.delta?.type;
            if (deltaType === 'text_delta') {
              const text = parsed.delta?.text || '';
              totalContent += text;
              textDeltaForwarded = true;
              writeEvent({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text }
              });
            }
            continue;
          }

          if (parsed.type === 'content_block_stop') {
            // 不转发（index 0 由本函数统一关闭）
            skipCurrentBlock = false;
            currentBlockType = null;
            continue;
          }

          if (parsed.type === 'message_delta') {
            outputTokens = parsed.usage?.output_tokens || 0;
            // 不转发，由本函数统一发送
            continue;
          }

          if (parsed.type === 'message_stop') {
            // 不转发，由本函数统一发送
            continue;
          }

          // ping 等其他事件忽略
        } catch (e) {
          // 忽略解析错误
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      Logger.error(`[Synthesizer] 上游流超时`);
    } else {
      Logger.error(`[Synthesizer] 流式读取错误: ${err.message}`);
    }
  }

  Logger.info(`[Synthesizer] 上游流处理完毕, chunks=${chunkCount}, contentLength=${totalContent.length}, clientDisconnected=${clientDisconnected}, textDeltaForwarded=${textDeltaForwarded}`);

  // 统一发送结束事件：关闭 index 0 的 text block + message 终止事件
  if (!clientDisconnected && !res.writableEnded) {
    writeEvent({ type: 'content_block_stop', index: 0 });
    writeEvent({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens }
    });
    writeEvent({ type: 'message_stop' });
    res.end();
  }

  const latency = Date.now() - startTime;
  Logger.info(`[Synthesizer] Anthropic 流式完成: latency=${latency}ms, content_length=${totalContent.length}`);

  return {
    content: totalContent,
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      cachedTokens
    },
    model_id: model,
    latency
  };
}

// Anthropic -> OpenAI 格式流式合成（客户端期望 OpenAI，供应商是 Anthropic）
async function streamAnthropicToOpenAISynthesis(baseUrl, provider, model, messages, res, options = {}) {
  const url = `${upstreamUrl(baseUrl, '/messages')}`;
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': provider.api_key || ''
  };

  const systemMessage = messages.find(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  const body = {
    model,
    max_tokens: options.max_tokens || 4096,
    messages: nonSystemMessages.map(m => ({
      role: m.role,
      content: m.content
    })),
    stream: true
  };

  // 透传工具调用定义（OpenAI 格式 -> Anthropic 格式）
  if (options.tools) {
    body.tools = options.tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      input_schema: t.function?.parameters || t.input_schema
    }));
  }
  if (options.tool_choice) {
    const tc = options.tool_choice;
    if (tc === 'auto') body.tool_choice = { type: 'auto' };
    else if (tc === 'required') body.tool_choice = { type: 'any' };
    else if (tc === 'none') body.tool_choice = { type: 'none' };
    else if (tc.type === 'function') body.tool_choice = { type: 'tool', name: tc.function?.name };
    else body.tool_choice = tc;
  }

  if (systemMessage) {
    body.system = systemMessage.content;
  }

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  Logger.info(`[Synthesizer] Anthropic->OpenAI 流式合成: url=${url}, model=${model}`);

  const startTime = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`上游调用失败: ${response.status} - ${err}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalContent = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let clientDisconnected = false;
  let chunkCount = 0;
  let currentBlockType = null;

  try {
    res.req.on('close', () => { clientDisconnected = true; });
  } catch (e) { /* ignore */ }

  const streamMeta = getOrCreateStreamMeta(res, { model: model || 'fusion', prefix: 'chatcmpl-fusion' });

  const writeOpenAIEvent = (partial) => {
    if (clientDisconnected || !res || res.writableEnded || res.destroyed) return false;
    // 始终输出完整 chat.completion.chunk envelope
    let chunk;
    if (partial.usage && (!partial.choices || partial.choices.length === 0)) {
      chunk = buildChatCompletionChunk({
        id: streamMeta.id,
        created: streamMeta.created,
        model: streamMeta.model,
        choices: [],
        usage: partial.usage
      });
    } else {
      const choice = partial.choices?.[0] || {};
      chunk = buildChatCompletionChunk({
        id: streamMeta.id,
        created: streamMeta.created,
        model: streamMeta.model,
        delta: choice.delta || {},
        index: choice.index ?? 0,
        finish_reason: choice.finish_reason != null ? choice.finish_reason : null,
        usage: partial.usage
      });
    }
    return res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientDisconnected) break;

      chunkCount++;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);

          if (parsed.type === 'message_start') {
            inputTokens = parsed.message?.usage?.input_tokens || 0;
            cachedTokens = parsed.message?.usage?.cache_read_input_tokens || 0;
            continue;
          }

          if (parsed.type === 'content_block_start') {
            currentBlockType = parsed.content_block?.type || null;
            continue;
          }

          if (parsed.type === 'content_block_delta') {
            const deltaType = parsed.delta?.type;
            if (currentBlockType === 'text' && deltaType === 'text_delta') {
              const text = parsed.delta?.text || '';
              totalContent += text;
              writeOpenAIEvent({ choices: [{ delta: { content: text }, index: 0 }] });
            } else if (currentBlockType === 'thinking' && deltaType === 'thinking_delta') {
              writeOpenAIEvent({ choices: [{ delta: { reasoning_content: parsed.delta.thinking }, index: 0 }] });
            }
            continue;
          }

          if (parsed.type === 'content_block_stop') {
            currentBlockType = null;
            continue;
          }

          if (parsed.type === 'message_delta') {
            outputTokens = parsed.usage?.output_tokens || 0;
            continue;
          }

          if (parsed.type === 'message_stop') {
            continue;
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError' && err.name !== 'TimeoutError') {
      Logger.error(`[Synthesizer] Anthropic->OpenAI 流式读取错误: ${err.message}`);
    }
  }

  if (!clientDisconnected) {
    writeOpenAIEvent({
      choices: [],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      }
    });
    res.write('data: [DONE]\n\n');
    res.end();
  }

  const latency = Date.now() - startTime;
  Logger.info(`[Synthesizer] Anthropic->OpenAI 流式完成: latency=${latency}ms, content_length=${totalContent.length}`);

  return {
    content: totalContent,
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      cachedTokens
    },
    model_id: model,
    latency
  };
}

// 主合成函数（根据 stream 参数选择模式）
async function synthesize(fusionConfig, originalMessages, judgeResult, panelResults, options = {}) {
  if (options.stream && options.res) {
    return await synthesizeStream(fusionConfig, originalMessages, judgeResult, panelResults, options.res, options);
  } else {
    return await synthesizeNonStream(fusionConfig, originalMessages, judgeResult, panelResults, options);
  }
}

module.exports = {
  synthesize,
  synthesizeNonStream,
  synthesizeStream,
  buildSynthesisMessages,
  SYNTHESIS_PROMPT_TEMPLATE
};
