/**
 * Fusion Processor - 多模型审议系统
 *
 * 核心流程：
 * 1. 并行调用多个 Panel 模型
 * 2. Judge 模型分析各 Panel 输出的共识、矛盾、盲点、独特洞见
 * 3. 外层模型基于 Judge 分析生成最终高质量回答
 */

const { runPanels } = require('./panel-runner');
const { runJudge } = require('./judge-analyzer');
const { synthesize } = require('./synthesizer');
const Logger = require('../logger');
const { decryptSecret } = require('../utils/secret-crypto');
const { pool } = require('../models/database');
const { upstreamUrl } = require('../utils/url-validator');
const proxyPool = require('../proxy-pool');
const { selectHealthyWeighted } = require('../utils/provider-selector');
const {
  buildChatCompletionChunk,
  getOrCreateStreamMeta
} = require('../utils/openai-response-normalize');

// 获取 Fusion 配置
async function getFusionConfig(configName = 'general') {
  try {
    const result = await pool.query(
      'SELECT * FROM fusion_configs WHERE name = $1 AND enabled = TRUE',
      [configName]
    );
    if (result.rows[0]) return result.rows[0];

    // 回退到默认配置
    const defaultResult = await pool.query(
      'SELECT * FROM fusion_configs WHERE is_default = TRUE AND enabled = TRUE LIMIT 1'
    );
    return defaultResult.rows[0] || null;
  } catch (err) {
    Logger.error(`[Fusion] 获取配置失败: ${err.message}`);
    return null;
  }
}

// 获取模型配置
async function getModelConfig(modelId) {
  try {
    // 1. 先尝试 id 匹配
    const byId = await pool.query('SELECT * FROM models WHERE id = $1 AND enabled = TRUE', [modelId]);
    if (byId.rows[0]) return byId.rows[0];

    // 2. 尝试 alias 匹配
    const byAlias = await pool.query("SELECT * FROM models WHERE alias = $1 AND alias != '' AND enabled = TRUE", [modelId]);
    if (byAlias.rows[0]) return byAlias.rows[0];

    // 3. 尝试 upstream_model_id 匹配
    const byUpstream = await pool.query('SELECT * FROM models WHERE upstream_model_id = $1 AND enabled = TRUE', [modelId]);
    return byUpstream.rows[0] || null;
  } catch (err) {
    Logger.error(`[Fusion] 获取模型配置失败: ${err.message}`);
    return null;
  }
}

// 获取供应商配置
async function getProviderForRequest(providerId) {
  try {
    const provider = await pool.query('SELECT * FROM providers WHERE id = $1 AND enabled = TRUE', [providerId]);
    if (!provider.rows[0]) return null;
    provider.rows[0].api_key = decryptSecret(provider.rows[0].api_key);

    const group = provider.rows[0].grp;
    if (!group) return provider.rows[0];

    const groupResult = await pool.query(
      'SELECT * FROM providers WHERE grp = $1 AND enabled = TRUE',
      [group]
    );

    if (groupResult.rows.length <= 1) return provider.rows[0];
    for (const candidate of groupResult.rows) candidate.api_key = decryptSecret(candidate.api_key);

    const candidates = groupResult.rows;
    const selected = selectHealthyWeighted(candidates, `provider:${group}`);
    Logger.info(`[Fusion] 负载均衡: 供应商组 "${group}" 从 ${candidates.length} 个中选择 ${selected.id}`);
    return selected;
  } catch (err) {
    Logger.error(`[Fusion] 获取供应商失败: ${err.message}`);
    return null;
  }
}

// 调用单个模型（非流式）
async function callModel(modelId, messages, options = {}) {
  const modelConfig = await getModelConfig(modelId);
  if (!modelConfig) {
    throw new Error(`模型 ${modelId} 未找到或未启用`);
  }

  const provider = await getProviderForRequest(modelConfig.provider);
  if (!provider) {
    throw new Error(`模型 ${modelId} 的供应商未配置`);
  }
  if (!['openai', 'anthropic'].includes(provider.format || 'openai')) {
    const error = new Error(`Fusion 暂不支持供应商协议: ${provider.format || 'unknown'}`);
    error.code = 'unsupported_provider_format';
    throw error;
  }

  const upstreamModelId = modelConfig.upstream_model_id || modelConfig.id;
  const { temperature = 0.7, max_tokens = 4096, tools, tool_choice, response_format } = options;

  // 构建请求体
  const requestBody = {
    model: upstreamModelId,
    messages,
    temperature,
    max_tokens,
    stream: false
  };
  if (tools) requestBody.tools = tools;
  if (tool_choice) requestBody.tool_choice = tool_choice;
  if (response_format) requestBody.response_format = response_format;

  const baseUrl = cleanBaseUrl(provider.base_url);
  const { buildKeyAttemptOrder, getPrimaryApiKey } = require('../utils/provider-keys');
  const keyAttempts = buildKeyAttemptOrder(provider);
  const keys = keyAttempts.length ? keyAttempts : (getPrimaryApiKey(provider) ? [getPrimaryApiKey(provider)] : ['']);

  let lastErr = null;
  for (let ki = 0; ki < keys.length; ki++) {
    const providerWithKey = { ...provider, api_key: keys[ki] };
    try {
      if (provider.format === 'anthropic') {
        return await callAnthropicModel(baseUrl, providerWithKey, requestBody, options.requestContext);
      }
      return await callOpenAIModel(baseUrl, providerWithKey, requestBody, options.requestContext);
    } catch (err) {
      if (err.code === 'fusion_upstream_limit') throw err;
      lastErr = err;
      if (ki < keys.length - 1) {
        Logger.warn(`[Fusion] Key ${ki + 1}/${keys.length} 失败，切换下一 Key: ${err.message}`);
        continue;
      }
    }
  }
  throw lastErr || new Error(`模型 ${modelId} 调用失败`);
}

// 调用 OpenAI 格式模型
async function callOpenAIModel(baseUrl, provider, body, requestContext = null) {
  const url = `${upstreamUrl(baseUrl, '/chat/completions')}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.api_key || ''}`
  };

  Logger.info(`[Fusion] OpenAI 调用开始: url=${url}, model=${body.model}, stream=false`);
  const startTime = Date.now();

  const proxyInfo = await proxyPool.getProxyAgent(provider);
  const response = await proxyPool.proxyFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000), // 2 分钟超时
    agent: proxyInfo?.agent,
    requestContext
  });

  const data = await response.json();
  const latency = Date.now() - startTime;

  if (!response.ok) {
    Logger.error(`[Fusion] OpenAI 调用失败: status=${response.status}, body=${JSON.stringify(data).substring(0, 500)}`);
    throw new Error(`上游调用失败: ${data.error?.message || 'Unknown error'}`);
  }

  Logger.info(`[Fusion] OpenAI 调用成功: latency=${latency}ms, tokens=${data.usage?.total_tokens || 0}`);

  return {
    content: data.choices?.[0]?.message?.content || '',
    usage: {
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
      cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens || 0
    },
    latency
  };
}

// 调用 Anthropic 格式模型
async function callAnthropicModel(baseUrl, provider, body, requestContext = null) {
  const url = `${upstreamUrl(baseUrl, '/messages')}`;
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': provider.api_key || ''
  };

  // 转换 OpenAI 格式到 Anthropic 格式
  const systemMessage = body.messages.find(m => m.role === 'system');
  const nonSystemMessages = body.messages.filter(m => m.role !== 'system');

  const anthropicBody = {
    model: body.model,
    max_tokens: body.max_tokens || 4096,
    messages: nonSystemMessages.map(m => ({
      role: m.role,
      content: m.content
    })),
    stream: false
  };

  if (systemMessage) {
    anthropicBody.system = systemMessage.content;
  }

  if (body.temperature !== undefined) {
    anthropicBody.temperature = body.temperature;
  }

  // 透传工具调用定义（OpenAI 格式 -> Anthropic 格式）
  if (body.tools) {
    anthropicBody.tools = body.tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      input_schema: t.function?.parameters || t.input_schema
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc === 'auto') anthropicBody.tool_choice = { type: 'auto' };
    else if (tc === 'required') anthropicBody.tool_choice = { type: 'any' };
    else if (tc === 'none') anthropicBody.tool_choice = { type: 'none' };
    else if (tc.type === 'function') anthropicBody.tool_choice = { type: 'tool', name: tc.function?.name };
    else anthropicBody.tool_choice = tc;
  }

  const startTime = Date.now();

  const proxyInfo = await proxyPool.getProxyAgent(provider);
  const response = await proxyPool.proxyFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(anthropicBody),
    signal: AbortSignal.timeout(120000),
    agent: proxyInfo?.agent,
    requestContext
  });

  const data = await response.json();
  const latency = Date.now() - startTime;

  if (!response.ok) {
    Logger.error(`[Fusion] Anthropic 调用失败: status=${response.status}, body=${JSON.stringify(data).substring(0, 500)}`);
    throw new Error(`上游调用失败: ${data.error?.message || 'Unknown error'}`);
  }

  Logger.info(`[Fusion] Anthropic 调用成功: latency=${latency}ms, tokens=${(data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)}`);

  return {
    content: data.content?.[0]?.text || '',
    usage: {
      promptTokens: data.usage?.input_tokens || 0,
      completionTokens: data.usage?.output_tokens || 0,
      cachedTokens: data.usage?.cache_read_input_tokens || 0
    },
    latency
  };
}

// 清理 base_url：保留 /v1、/api/v1 版本前缀，由 upstreamUrl() 智能补全
function cleanBaseUrl(base) {
  return base
    .replace(/\/$/, '')
    .replace(/\/v1\/chat\/completions$/i, '')
    .replace(/\/v1\/messages$/i, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/messages$/i, '');
}

// 发送 Anthropic 流式响应头：发送 message_start 并开启 index 0 的 text block
// 状态消息和最终回答共用这一个 block，与 OpenAI 格式行为保持一致
function sendAnthropicStreamHeader(res, model = 'fusion') {
  if (!res) return;
  try {
    const responseId = `msg_fusion_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // message_start
    const messageStart = JSON.stringify({
      type: 'message_start',
      message: {
        id: responseId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
    Logger.info(`[Fusion] 发�� message_start: ${messageStart.substring(0, 100)}...`);
    res.write(`event: message_start\ndata: ${messageStart}\n\n`);

    // 开启 index 0 的 text block，后续所有状态消息和最终回答都写入此 block
    const contentBlockStart = JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    });
    Logger.info(`[Fusion] 发送 content_block_start: ${contentBlockStart.substring(0, 100)}...`);
    res.write(`event: content_block_start\ndata: ${contentBlockStart}\n\n`);

    return responseId;
  } catch (e) {
    Logger.error(`[Fusion] sendAnthropicStreamHeader 错误: ${e.message}`);
    return null;
  }
}

// 发送 SSE 状态消息（Anthropic 格式作为 index 0 的 text_delta）
// OpenAI 格式必须带完整 chat.completion.chunk envelope（id/object/created/model），否则严格 SDK 会反序列化失败
function sendFusionStatus(res, message, format = 'openai') {
  if (!res || res.writableEnded || res.destroyed) return;
  try {
    if (format === 'anthropic') {
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: message }
      })}\n\n`);
    } else {
      const meta = getOrCreateStreamMeta(res, { model: 'fusion', prefix: 'chatcmpl-fusion' });
      const chunk = buildChatCompletionChunk({
        id: meta.id,
        created: meta.created,
        model: meta.model,
        delta: { content: message }
      });
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
  } catch (e) {
    Logger.warn(`[Fusion] sendFusionStatus 写入失败: ${e.message}`);
  }
}

// 处理 Fusion 请求
async function processFusion(body, req, options = {}) {
  const startTime = Date.now();
  const { messages, temperature, max_tokens, fusion_preset, tools, tool_choice, response_format } = body;
  const { res, format = 'openai' } = options;
  const requestContext = options.requestContext || { upstreamAttempts: 0 };
  const budgetedCallModel = (modelId, messages, callOptions = {}) => callModel(modelId, messages, { ...callOptions, requestContext });

  Logger.info(`[Fusion] 开始处理: preset=${fusion_preset || 'default'}, messages=${messages?.length}, format=${format}, stream=${options.stream}, hasRes=${!!res}`);

  // Anthropic 格式流的状态消息与最终回答共用 index 0 的 text block（在 sendAnthropicStreamHeader 中开启）
  let anthropicBlockIndex = 0;

  // 1. 获取 Fusion 配置（优先使用 API Key 级别配置，其次使用 preset）
  let fusionConfig;
  const apiKeyCfg = options.apiKeyFusionConfig;
  const synthesisPromptEnabled = apiKeyCfg?.synthesis_prompt_enabled !== false;
  requestContext.fusionSynthesisPromptEnabled = synthesisPromptEnabled;

  if (apiKeyCfg && apiKeyCfg.panel_models && apiKeyCfg.panel_models.length > 0 && apiKeyCfg.judge_model_id && apiKeyCfg.outer_model_id) {
    // 使用 API Key 级别的配置
    fusionConfig = {
      name: 'api-key-custom',
      panel_models: apiKeyCfg.panel_models,
      judge_model_id: apiKeyCfg.judge_model_id,
      outer_model_id: apiKeyCfg.outer_model_id,
      max_panel_count: 8,
      temperature: 0.7,
      max_tokens: 4096
    };
    Logger.info(`[Fusion] 使用 API Key 自定义配置: panel=${fusionConfig.panel_models.length} 个模型`);
  } else {
    // 回退到 preset
    fusionConfig = await getFusionConfig(fusion_preset || 'general');
    if (!fusionConfig) {
      throw new Error('Fusion 配置未找到或未启用。请在 API Key 设置中配置 Fusion 模型。');
    }
    Logger.info(`[Fusion] 使用预设配置: ${fusionConfig.name}`);
  }

  Logger.info(`[Fusion] 配置详情: panel=${fusionConfig.panel_models.join(', ')}, judge=${fusionConfig.judge_model_id}, outer=${fusionConfig.outer_model_id}`);

  // 流式模式下，先校验外层合成模型配置，避免发送 SSE 头后才发现错误
  if (options.stream && res) {
    const outerModelConfig = await getModelConfig(fusionConfig.outer_model_id);
    if (!outerModelConfig) {
      throw new Error(`Fusion 外层合成模型 ${fusionConfig.outer_model_id} 未找到或未启用`);
    }
    const outerProvider = await getProviderForRequest(outerModelConfig.provider);
    if (!outerProvider) {
      throw new Error(`Fusion 外层合成模型 ${fusionConfig.outer_model_id} 的供应商未配置`);
    }
    Logger.info(`[Fusion] 外层模型校验通过: ${fusionConfig.outer_model_id}, provider=${outerProvider.id}`);
  }

  // 2. 如果是流式模式，发送 SSE 头和初始状态
  if (options.stream && res) {
    Logger.info(`[Fusion] 设置 SSE 头...`);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲
    res.flushHeaders();
    Logger.info(`[Fusion] SSE 头已设置, headersSent=${res.headersSent}`);

    // 如果是 Anthropic 格式，发送 message_start 并开启 index 0 的 text block
    if (format === 'anthropic') {
      Logger.info(`[Fusion] 发送 Anthropic 流式响应头...`);
      sendAnthropicStreamHeader(res, 'fusion');
    } else {
      // OpenAI 流式：预生成 stream meta，并发送 role 首包（兼容严格 SDK）
      const meta = getOrCreateStreamMeta(res, { model: 'fusion', prefix: 'chatcmpl-fusion' });
      Logger.info(`[Fusion] OpenAI 流式 envelope: id=${meta.id}, model=${meta.model}`);
      const roleChunk = buildChatCompletionChunk({
        id: meta.id,
        created: meta.created,
        model: meta.model,
        delta: { role: 'assistant', content: '' }
      });
      res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
    }

    // 发送初始状态消息
    Logger.info(`[Fusion] 发送初始状态消息...`);
    sendFusionStatus(res, '\n**🔍 Fusion 正在进行问题评估...**\n\n', format);
    Logger.info(`[Fusion] 初始状态消息已发送`);

    // 发送配置信息
    sendFusionStatus(res, `📋 **配置**: ${fusionConfig.name} | **Panel**: ${fusionConfig.panel_models.join(', ')}\n\n`, format);
  } else {
    Logger.info(`[Fusion] 非流式模式或无 res 对象`);
  }

  // 3. 并行执行 Panel 模型
  if (options.stream && res) {
    sendFusionStatus(res, `🔄 **正在并行调用 ${fusionConfig.panel_models.length} 个 Panel 模型...**\n`, format);
    await new Promise(r => setTimeout(r, 50));
  }

  // 限制 max_tokens 避免超出模型限制（大多数模型上限 4096-8192）
  const safeMaxTokens = Math.min(max_tokens || 4096, 4096);

  const panelResults = await runPanels(fusionConfig, messages, {
    temperature: temperature || fusionConfig.temperature,
    max_tokens: safeMaxTokens,
    tools,
    tool_choice,
    response_format,
    callModel: budgetedCallModel
  });

  const panelSuccess = panelResults.filter(r => r.success).length;
  Logger.info(`[Fusion] Panel 完成: ${panelSuccess}/${panelResults.length} 成功`);

  // 4. 发送 Panel 完成状态
  if (options.stream && res) {
    const panelSummary = panelResults.map(r =>
      `  - ${r.model_id}: ${r.success ? '✅' : '❌'} (${r.latency}ms, ${r.content?.length || 0} chars)`
    ).join('\n');
    sendFusionStatus(res, `\n✅ **Panel 完成**: ${panelSuccess}/${panelResults.length} 成功\n${panelSummary}\n\n`, format);
  }

  // 5. Judge 分析
  if (options.stream && res) {
    sendFusionStatus(res, `🔍 **正在使用 ${fusionConfig.judge_model_id} 进行 Judge 分析...**\n`, format);
  }

  const judgeResult = await runJudge(fusionConfig, messages, panelResults, {
    callModel: budgetedCallModel
  });

  Logger.info(`[Fusion] Judge 完成: 共识=${judgeResult.consensus?.length || 0}, 矛盾=${judgeResult.contradictions?.length || 0}, 盲点=${judgeResult.blind_spots?.length || 0}`);

  // 6. 发送 Judge 完成状态
  if (options.stream && res) {
    sendFusionStatus(res, `\n✅ **Judge 分析完成**: 共识=${judgeResult.consensus?.length || 0}, 矛盾=${judgeResult.contradictions?.length || 0}, 盲点=${judgeResult.blind_spots?.length || 0}\n\n`, format);
  }

  // 7. 最终合成
  if (options.stream && res) {
    sendFusionStatus(res, `✨ **正在使用 ${fusionConfig.outer_model_id} 生成最终回答...**\n\n---\n\n`, format);
  }

  const finalResult = await synthesize(fusionConfig, messages, judgeResult, panelResults, {
    temperature: temperature || fusionConfig.temperature,
    max_tokens: safeMaxTokens,
    stream: options.stream,
    res: options.res,
    format,
    anthropicBlockIndex,
    callModel: budgetedCallModel,
    getModelConfig,
    getProviderForRequest,
    tools,
    tool_choice,
    response_format,
    synthesisPromptEnabled
  });

  const totalLatency = Date.now() - startTime;

  // 计算总 token 和成本
  const totalTokens = panelResults.reduce((sum, r) => {
    if (r.success && r.usage) {
      return sum + r.usage.promptTokens + r.usage.completionTokens;
    }
    return sum;
  }, 0) + (judgeResult.usage?.promptTokens || 0) + (judgeResult.usage?.completionTokens || 0) +
    (finalResult.usage?.promptTokens || 0) + (finalResult.usage?.completionTokens || 0);

  Logger.info(`[Fusion] 完成: latency=${totalLatency}ms, totalTokens=${totalTokens}`);

  return {
    ...finalResult,
    fusion: {
      config: fusionConfig.name,
      panel_count: panelResults.length,
      panel_success: panelResults.filter(r => r.success).length,
      judge_consensus: judgeResult.consensus?.length || 0,
      judge_contradictions: judgeResult.contradictions?.length || 0,
      total_latency: totalLatency
    },
    totalTokens,
    panelResults,
    judgeResult
  };
}

module.exports = {
  processFusion,
  getFusionConfig,
  getModelConfig,
  getProviderForRequest,
  callModel,
  cleanBaseUrl
};
