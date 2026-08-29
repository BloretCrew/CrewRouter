const express = require('express');
const router = express.Router();
const { recordEvent } = require('../utils/trace-session');

// 在响应结束时统一捕获当前 API Key 的完整请求，覆盖成功、失败和零 token 请求。
router.use((req, res, next) => {
  res.once('finish', () => {
    if (!req.apiUser?.keyId) return;
    recordEvent(req, {
      ok: res.statusCode < 400,
      httpStatus: res.statusCode,
      requestType: req.path.includes('responses') ? 'responses' : (req.path.includes('messages') ? 'anthropic' : 'chat'),
      messages: req.body?.messages || req.body?.input || req.body,
      response: null,
      latencyMs: req._traceStartedAt ? Date.now() - req._traceStartedAt : null,
      error: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null,
    }).catch(() => {});
  });
  req._traceStartedAt = Date.now();
  next();
});
const { pool } = require('../models/database');
const Logger = require('../logger');
const config = require('../config-loader');
const { getCacheStatus, resetCacheStats } = require('../provider-lookup');
const { normalizeUsageTokens } = require('../utils/token-normalize');
const { calculateCost } = require('../utils/billing');
const { recordQuotaData } = require('../utils/quota-data');
const { recordModelCall } = require('../utils/model-uptime');
const { recordLiveCallTest } = require('../utils/model-test');
const { captureCallError, clientIp } = require('../utils/error-records');
const { notifyUser, NOTIFICATION_TYPES } = require('../utils/notifications');
const {
  clientMetaFromReq,
  isHarnessSource,
  normalizeRequestSource,
} = require('../utils/request-source');
const { extractCustomInstructions } = require('../utils/custom-instructions-extractor');
const { buildInjectedPrompt, openaiAppend, anthropicAppend, anthropicMessageAppend, responsesAppend } = require('../utils/inject-prompt');
const {
  scrubInjectedEcho,
  scrubOpenAiChatCompletion,
  scrubAnthropicResponse,
  scrubResponsesApiResult,
} = require('../utils/inject-prompt-scrub');
const { checkQuotaRules } = require('../utils/points-deduct');
const { recordUsageAndDeduct } = require('../utils/balance');
const { sha256Hex } = require('../utils/key-hash');
const {
  getQuotaInfo,
  getGroupName,
  getTeamName,
  getTodayStats,
  resolveSignatureMode,
  planStreamSignatureInjection,
  injectSignatureIntoOpenAIResponse,
  injectSignatureIntoAnthropicResponse,
  injectSignatureIntoResponsesBody,
  buildSignatureForRequest
} = require('../utils/api-signature');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { oauthBearer } = require('../middleware/oauth-bearer');
const keyRefresher = require('../key-refresher');
const proxyPool = require('../proxy-pool');
const pluginHooks = require('../plugins/hooks');
const { processFusion } = require('../fusion');
const {
  genChatCompletionId,
  ensureChatCompletionResponse,
  ensureChatCompletionChunk,
  buildChatCompletionChunk
} = require('../utils/openai-response-normalize');
const {
  getPrimaryApiKey,
  buildKeyAttemptOrder,
  normalizeProviderKeyEntries
} = require('../utils/provider-keys');
const ResponsesUpstream = require('../utils/responses-upstream');
const { extractAttribution, classifyCompaction } = require('../utils/attribution');
const { classifyRequestSemantics } = require('../utils/request-semantics');
const { createStreamScrubber } = require('../utils/inject-prompt-stream');
const crypto = require('crypto');
const { decryptSecret } = require('../utils/secret-crypto');

// 非流式：上游整段响应（headers+body）超时。30s 对免费/慢模型过短，易误杀。
const UPSTREAM_TIMEOUT = 180000; // 3 分钟
const UPSTREAM_STREAM_TIMEOUT = 300000; // 流式请求超时 5 分钟
const MAX_UPSTREAM_ATTEMPTS = 12;

function isUpstreamTimeoutError(err) {
  if (!err) return false;
  if (err.code === 'upstream_timeout' || err.code === 'ETIMEDOUT') return true;
  if (err.name === 'TimeoutError') return true;
  const msg = String(err.message || '');
  if (/timed?\s*out|timeout/i.test(msg)) return true;
  // AbortSignal.timeout 在部分路径会变成 “aborted”
  if (err.name === 'AbortError' && /abort/i.test(msg)) return true;
  return false;
}

/**
 * 将代理层抛出的异常映射为对客户端友好的 HTTP 错误体
 * @param {Error} error
 * @param {'openai'|'anthropic'} [format='openai']
 */
function buildUpstreamExceptionError(error, format = 'openai') {
  const isTimeout = isUpstreamTimeoutError(error);
  const status = isTimeout ? 504 : 502;
  const code = isTimeout ? 'upstream_timeout' : (error?.code || 'upstream_error');
  let message = error?.message || 'unknown error';
  if (isTimeout && /aborted/i.test(message) && !/timeout/i.test(message)) {
    message = `Upstream request timed out (${UPSTREAM_TIMEOUT}ms)`;
  } else if (isTimeout && !/^Upstream/i.test(message)) {
    message = `Upstream request timed out: ${message}`;
  } else if (!isTimeout && !/^Upstream/i.test(message)) {
    message = `Upstream request failed: ${message}`;
  }

  if (format === 'anthropic') {
    return {
      status,
      body: {
        type: 'error',
        error: {
          type: isTimeout ? 'timeout_error' : 'api_error',
          message
        }
      },
      retryable: true
    };
  }
  return {
    status,
    body: {
      error: {
        message,
        type: isTimeout ? 'timeout_error' : 'server_error',
        code
      }
    },
    retryable: true
  };
}

/**
 * 使用代理池发送上游请求，支持 429 和代理连接失败重试
 *
 * @param {Function} makeFetchOpts - (proxyInfo) => fetch options，返回的对象需包含 url 字段
 * @param {object} provider - 供应商对象
 * @param {object|null} currentProxyInfo - 当前代理信息
 * @param {number} maxRetries - 最大重试次数
 * @param {string} logPrefix - 日志前缀
 * @param {object|null} [hookCtx] - 插件 beforeUpstream 钩子上下文（{ model, requestType }）
 * @returns {Promise<{response: object, currentProxyInfo: object|null}>}
 */
async function fetchWithProxyRetry(makeFetchOpts, provider, currentProxyInfo, maxRetries, logPrefix, hookCtx = null) {
  let response;
  const affinityKey = hookCtx?.affinityKey || null;
  let proxyInfo = currentProxyInfo;
  let lastError = null;
  const attempts = Math.min(MAX_UPSTREAM_ATTEMPTS, Math.max(1, parseInt(maxRetries, 10) || 1));
  const requestContext = hookCtx?.requestContext || provider?._requestContext;
  const consumeAttempt = () => {
    if (!requestContext) return;
    requestContext.upstreamAttempts = (requestContext.upstreamAttempts || 0) + 1;
    if (requestContext.upstreamAttempts > MAX_UPSTREAM_ATTEMPTS) {
      const err = new Error(`Upstream request attempt limit exceeded (${MAX_UPSTREAM_ATTEMPTS})`);
      err.code = 'upstream_attempt_limit';
      throw err;
    }
  };

  // 插件 gateway:beforeUpstream 钩子：首次构造请求选项时执行一次，
  // 得到的覆盖值（url / headers / bodyText）在后续代理重试中持续生效
  let upstreamOverride = null;
  if (hookCtx && pluginHooks.hasSubscribers('gateway:beforeUpstream')) {
    try {
      const probe = makeFetchOpts(proxyInfo);
      const payload = {
        url: probe.url,
        headers: probe.headers && typeof probe.headers === 'object' ? { ...probe.headers } : {},
        bodyText: typeof probe.body === 'string' ? probe.body : '',
      };
      const out = await pluginHooks.apply('gateway:beforeUpstream', payload, {
        provider: provider ? { id: provider.id, name: provider.name, format: provider.format || 'openai' } : null,
        model: hookCtx.model,
        requestType: hookCtx.requestType || logPrefix,
      });
      if (out && typeof out === 'object') upstreamOverride = out;
    } catch (err) {
      Logger.warn(`[plugins] beforeUpstream 钩子失败（已忽略）: ${err.message}`);
    }
  }

  // 把钩子产生的覆盖值合并进每次重试的 fetch 选项
  const applyUpstreamOverride = (fetchOpts) => {
    if (!upstreamOverride) return fetchOpts;
    if (typeof upstreamOverride.url === 'string' && upstreamOverride.url) fetchOpts.url = upstreamOverride.url;
    if (upstreamOverride.headers && typeof upstreamOverride.headers === 'object') {
      const base = fetchOpts.headers && typeof fetchOpts.headers === 'object' ? fetchOpts.headers : {};
      for (const [k, v] of Object.entries(upstreamOverride.headers)) {
        if (v === null || v === undefined) delete base[k];
        else base[k] = v;
      }
      fetchOpts.headers = base;
    }
    if (typeof upstreamOverride.bodyText === 'string' && upstreamOverride.bodyText) fetchOpts.body = upstreamOverride.bodyText;
    return fetchOpts;
  };

  for (let retry = 0; retry < attempts; retry++) {
    const fetchOpts = applyUpstreamOverride(makeFetchOpts(proxyInfo));

    try {
      consumeAttempt();
      response = await proxyPool.proxyFetch(fetchOpts.url, fetchOpts);
      lastError = null;
    } catch (err) {
      lastError = err;
      response = null;
      Logger.warn(`[${logPrefix}] 代理请求失败，切换代理重试 ${retry + 1}/${attempts}: proxy=${proxyInfo?.proxyUrl || 'none'}, error=${err.message}`);
      if (proxyInfo?.proxyId) {
        proxyPool.markProxy429(provider.id, proxyInfo.proxyId);
      }
      // 有代理（供应商级或全局强制）时尝试切换；无代理则继续按 attempts 直连重试
      const nextProxy = await proxyPool.getProxyAgent(provider, affinityKey);
      if (nextProxy || proxyInfo) {
        proxyInfo = nextProxy;
        if (!proxyInfo && retry >= attempts - 1) break;
        if (!proxyInfo) {
          // 代理耗尽，最后一次可回退到直连再试
          continue;
        }
      }
      continue;
    }

    if (response.status === 429 && retry < attempts - 1) {
      const nextProxy = await proxyPool.getProxyAgent(provider, affinityKey);
      if (!nextProxy && !proxyInfo) break;
      const errText = await response.text().catch(() => '');
      lastError = new Error(`HTTP 429${errText ? ': ' + String(errText).slice(0, 200) : ''}`);
      Logger.warn(`[${logPrefix}] 收到 429 限速，切换代理重试 ${retry + 1}/${attempts}: proxy=${proxyInfo?.proxyUrl || 'none'}`);
      if (proxyInfo?.proxyId) {
        proxyPool.markProxy429(provider.id, proxyInfo.proxyId);
      }
      proxyInfo = nextProxy || await proxyPool.getProxyAgent(provider, affinityKey);
      if (!proxyInfo) break;
      response = null;
      continue;
    }

    break;
  }

  if (!response) {
    const timedOut = isUpstreamTimeoutError(lastError);
    let reason = lastError?.message || 'upstream request failed';
    if (timedOut && /aborted/i.test(reason) && !/timeout/i.test(reason)) {
      reason = 'request timed out';
    }
    const err = new Error(`Upstream request failed after ${attempts} attempt(s): ${reason}`);
    err.code = timedOut ? 'upstream_timeout' : 'upstream_unreachable';
    err.name = timedOut ? 'TimeoutError' : (lastError?.name || 'Error');
    err.cause = lastError;
    throw err;
  }

  return { response, currentProxyInfo: proxyInfo };
}

/**
 * 是否可对 Key 模型队列做失败回退（换下一个模型重试）
 * - 网络/5xx/429 → 可回退；4xx 通常表示客户端请求或鉴权错误，不切换模型/Key
 */
function isRetryableUpstreamStatus(status) {
  if (status == null) return true;
  const code = Number(status);
  if (!Number.isFinite(code)) return true;
  if (code >= 500) return true;
  return false;
}

function isProxyErrorResult(result) {
  return !!(result && result.__proxyError === true);
}

/**
 * 代理失败时：要么写响应，要么返回可回退的错误对象
 * @returns {null|{ __proxyError: true, status: number, body: any, retryable: boolean }}
 */
function respondProxyError(res, status, body, options = {}) {
  const retryable = options.retryable != null
    ? !!options.retryable
    : isRetryableUpstreamStatus(status);
  if (options.suppressErrorResponse) {
    return { __proxyError: true, status: status || 502, body, retryable };
  }
  if (!res.headersSent) {
    res.status(status || 502).json(body);
  }
  return null;
}

/** 解析 Key 的有序模型队列；无记录时回退 currentModelId */
function resolveModelQueue(apiUser) {
  const queue = Array.isArray(apiUser?.modelQueue)
    ? apiUser.modelQueue.map(id => String(id || '').trim()).filter(Boolean)
    : [];
  if (queue.length > 0) return queue;
  if (apiUser?.currentModelId) return [String(apiUser.currentModelId)];
  return [];
}

/**
 * 按请求来源（harness）解析模型队列：
 * - 已知 harness 且 Key 配置了单独绑定时 → 仅使用该模型
 * - 否则回退默认 modelQueue / currentModelId
 * @returns {{ queue: string[], requestSource: string, harnessOverride: boolean }}
 */
function resolveModelQueueForRequest(apiUser, req, metadata = {}) {
  const meta = clientMetaFromReq(req, metadata);
  const requestSource = normalizeRequestSource(meta.requestSource);
  const harnessMap = apiUser?.harnessModels && typeof apiUser.harnessModels === 'object'
    ? apiUser.harnessModels
    : {};
  if (isHarnessSource(requestSource) && harnessMap[requestSource]) {
    const mid = String(harnessMap[requestSource] || '').trim();
    if (mid) {
      return { queue: [mid], requestSource, harnessOverride: true };
    }
  }
  return {
    queue: resolveModelQueue(apiUser),
    requestSource,
    harnessOverride: false,
  };
}

async function loadModelQueueForKey(keyId, currentModelId) {
  try {
    const r = await pool.query(
      `SELECT model_id FROM api_key_models
       WHERE api_key_id = $1 AND enabled IS DISTINCT FROM FALSE
       ORDER BY sort_order ASC, id ASC`,
      [keyId]
    );
    if (r.rows.length > 0) {
      return r.rows.map(row => row.model_id);
    }
  } catch (err) {
    Logger.warn(`[API密钥验证] 加载模型队列失败 keyId=${keyId}: ${err.message}`);
  }
  return currentModelId ? [currentModelId] : [];
}

async function loadHarnessModelsForKey(keyId) {
  try {
    const r = await pool.query(
      `SELECT harness, model_id FROM api_key_harness_models WHERE api_key_id = $1`,
      [keyId]
    );
    const map = {};
    for (const row of r.rows) {
      if (row.harness && row.model_id) map[row.harness] = row.model_id;
    }
    return map;
  } catch (err) {
    // 表尚未迁移时静默回退
    if (err.code !== '42P01') {
      Logger.warn(`[API密钥验证] 加载 Harness 绑定失败 keyId=${keyId}: ${err.message}`);
    }
    return {};
  }
}

const TEST_MODEL_TEXT = '这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！这是一个测试模型。这里只会返回这段文字。当然了，如果你看到了这段文字，那么应该是 All Done 了。祝你生活愉快！';

const TEST_MODEL_THINKING = '用户想要测试一个模型。这是一个测试模型，它只会返回固定的文本内容。我应该先思考一下如何回复，然后返回预设的文本。这个测试模型主要用于验证系统的流式传输功能是否正常工作，包括思考过程的流式输出和正文的流式输出。思考过程应该先输出，然后再输出正文内容。';

// 获取供应商有效的 API Key（支持动态密钥脚本模式；固定模式返回主 Key）
async function getEffectiveApiKey(provider) {
  // key_mode 可能不存在（旧数据库迁移未完成），默认为 fixed
  const keyMode = provider.key_mode || 'fixed';
  if (keyMode === 'script') {
    try {
      return await keyRefresher.ensureFreshKey(provider);
    } catch (err) {
      Logger.error(`[API] 动态密钥获取失败: provider=${provider.id}, error=${err.message}`);
      return getPrimaryApiKey(provider) || provider.api_key || '';
    }
  }
  return getPrimaryApiKey(provider);
}

/**
 * 解析调用时的 Key 尝试列表：
 * - 脚本模式：单 Key（动态刷新）
 * - 固定模式：多 Key 按顺序 / 权重模式生成尝试序
 * @returns {Promise<string[]>}
 */
async function resolveApiKeyAttempts(provider) {
  const keyMode = provider?.key_mode || 'fixed';
  if (keyMode === 'script') {
    const k = await getEffectiveApiKey(provider);
    return k ? [k] : [];
  }
  const order = buildKeyAttemptOrder(provider);
  if (order.length > 0) return order;
  const primary = getPrimaryApiKey(provider);
  return primary ? [primary] : [];
}

/**
 * 使用多 Key 顺序/权重尝试上游代理；headers 未发出前可 fallback
 * @param {object} provider
 * @param {import('express').Response} res
 * @param {boolean} outerSuppress - 外层（如模型队列）是否还要 suppress
 * @param {(providerWithKey: object, opts: { suppressErrorResponse: boolean, keyIndex: number, keyTotal: number, apiKey: string }) => Promise<any>} runOnce
 */
async function runWithProviderKeyFallback(provider, res, outerSuppress, runOnce) {
  const keys = await resolveApiKeyAttempts(provider);
  if (keys.length === 0) {
    // 无 Key 也尝试一次（部分上游可能不需鉴权）
    return runOnce({ ...provider, api_key: '', _requestContext: res.req?._upstreamAttemptContext }, {
      suppressErrorResponse: !!outerSuppress,
      keyIndex: 0,
      keyTotal: 1,
      apiKey: ''
    });
  }

  let lastResult = null;
  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    const hasMoreKeys = i < keys.length - 1;
    const suppressErrorResponse = !!outerSuppress || hasMoreKeys;
    const apiKey = keys[i];
    const providerWithKey = { ...provider, api_key: apiKey, _requestContext: provider._requestContext || res.req?._upstreamAttemptContext };
    try {
      lastResult = await runOnce(providerWithKey, {
        suppressErrorResponse,
        keyIndex: i,
        keyTotal: keys.length,
        apiKey
      });
      lastError = null;
    } catch (err) {
      lastError = err;
      lastResult = null;
      if (hasMoreKeys && !res.headersSent) {
        Logger.warn(
          `[KeyFallback] provider=${provider.id} key ${i + 1}/${keys.length} 异常，切换下一 Key: ${err.message}`
        );
        continue;
      }
      throw err;
    }

    if (res.headersSent) return lastResult;

    if (isProxyErrorResult(lastResult) && lastResult.retryable && hasMoreKeys) {
      Logger.warn(
        `[KeyFallback] provider=${provider.id} key ${i + 1}/${keys.length} 失败 status=${lastResult.status}，切换下一 Key`
      );
      continue;
    }
    return lastResult;
  }

  if (lastError) throw lastError;
  return lastResult;
}

// 内存中的速率限制存储
const rateLimitStore = new Map();

// 清理过期的速率限制记录（每分钟清理一次）
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore) {
    if (now - record.windowStart > 120000) {
      rateLimitStore.delete(key);
    }
  }
}, 60000);

// API Key 验证缓存（性能优化：减少数据库查询）
const apiKeyCache = new Map();
const API_KEY_CACHE_TTL = 60000; // 60 秒缓存

// 清理过期的 API Key 缓存（每分钟清理一次）
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of apiKeyCache) {
    if (now - entry.timestamp > API_KEY_CACHE_TTL * 2) {
      apiKeyCache.delete(key);
    }
  }
}, 60000);

// 获取缓存的 API Key 验证结果
function getCachedApiKey(apiKey) {
  const entry = apiKeyCache.get(apiKey);
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.timestamp > API_KEY_CACHE_TTL) {
    apiKeyCache.delete(apiKey);
    return null;
  }

  return entry.data;
}

// 设置 API Key 缓存
function setCachedApiKey(apiKey, data) {
  apiKeyCache.set(apiKey, {
    data: data,
    timestamp: Date.now()
  });
}

// 失效指定用户的 API Key 缓存（余额变化时调用）
function invalidateUserApiKeyCache(userId) {
  for (const [key, entry] of apiKeyCache) {
    if (entry.data.userId === userId) {
      apiKeyCache.delete(key);
    }
  }
}

// 失效指定 API Key 的缓存（签名配置变化时调用）
function invalidateApiKeyCacheByKeyId(keyId) {
  for (const [key, entry] of apiKeyCache) {
    if (entry.data.keyId === keyId) {
      apiKeyCache.delete(key);
    }
  }
}

async function getProvider(providerId) {
  const result = await pool.query('SELECT * FROM providers WHERE id = $1 AND enabled = TRUE', [providerId]);
  const provider = result.rows[0] || null;
  if (provider) provider.api_key = decryptSecret(provider.api_key);
  return provider;
}

// 获取供应商（支持同组负载均衡）
async function getProviderForRequest(providerId) {
  const provider = await getProvider(providerId);
  if (!provider) return null;

  const group = provider.grp;
  if (!group) return applyProviderSelect(provider);

  // 查找同组所有启用的供应商
  const groupResult = await pool.query(
    'SELECT * FROM providers WHERE grp = $1 AND enabled = TRUE',
    [group]
  );

  if (groupResult.rows.length <= 1) return applyProviderSelect(provider);
  for (const candidate of groupResult.rows) candidate.api_key = decryptSecret(candidate.api_key);

  // 默认随机选择；插件 provider:select 钩子可过滤/排序候选供应商
  let candidates = groupResult.rows;
  if (pluginHooks.hasSubscribers('provider:select')) {
    try {
      const out = await pluginHooks.apply('provider:select', { candidates: candidates.map(r => ({ ...r })) }, { providerId: provider.id, group });
      if (Array.isArray(out?.candidates) && out.candidates.length > 0) {
        candidates = out.candidates;
      }
    } catch (err) {
      Logger.warn(`[provider:select] 钩子异常: ${err.message}`);
    }
  }
  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  Logger.info(`[负载均衡] 供应商组 "${group}": 从 ${candidates.length} 个中选择 ${selected?.id || selected?.provider_id || '?'}`);
  return selected || null;
}

// 单个供应商（无组）场景的 provider:select 收口：返回所选或 null
async function applyProviderSelect(provider) {
  if (!pluginHooks.hasSubscribers('provider:select')) return provider;
  try {
    const out = await pluginHooks.apply('provider:select', { candidates: [{ ...provider }] }, { providerId: provider.id, group: provider.grp || '' });
    if (Array.isArray(out?.candidates) && out.candidates.length > 0) return out.candidates[0] || null;
  } catch (err) {
    Logger.warn(`[provider:select] 钩子异常: ${err.message}`);
  }
  return provider;
}

async function getModelConfig(modelId) {
  // 先尝试直接 id 匹配
  const byId = await pool.query('SELECT * FROM models WHERE id = $1 AND enabled = TRUE', [modelId]);
  if (byId.rows[0]) return byId.rows[0];
  // 再尝试别名匹配
  const byAlias = await pool.query("SELECT * FROM models WHERE alias = $1 AND alias != '' AND enabled = TRUE", [modelId]);
  return byAlias.rows[0] || null;
}

// 用量落库前的统计元数据：stats:record 钩子可附加维度（写入 usage_records.plugin_meta）
async function pluginMetaFrom(ctxMeta) {
  try {
    const meta = await pluginHooks.applyStatsRecord({}, ctxMeta);
    return (meta && Object.keys(meta).length) ? meta : null;
  } catch (err) {
    Logger.warn(`[stats:record] 钩子异常: ${err.message}`);
    return null;
  }
}

// 在 plugin_meta 上合并「自定义提示词文件」提取结果（键 customInstructions）。
// 只在 messages 存在时执行；提取无命中时保持 pluginMeta 原样（无键、零额外开销）；
// 超大 messages 时标记 customInstructions = { skipped: 'size' }。
async function buildUsagePluginMeta(ctxMeta, messages, system, req) {
  const pluginMeta = await pluginMetaFrom(ctxMeta);
  const attribution = req ? extractAttribution(req) : null;
  const isCompaction = req ? classifyCompaction(req.body) : false;
  const requestSource = req ? clientMetaFromReq(req).requestSource : null;
  const requestSemantics = req
    ? classifyRequestSemantics({ body: req.body, headers: req.headers, requestSource, url: req.originalUrl || req.url })
    : null;
  const hasAttribution = !!(attribution && (attribution.parentThreadId || attribution.subagent || attribution.sessionId || attribution.source.length));
  const withAttribution = (hasAttribution || isCompaction)
    ? { ...(pluginMeta || {}), attribution: { ...(attribution || {}), isCompaction } }
    : pluginMeta;
  const withSemantics = requestSemantics
    ? { ...(withAttribution || {}), request_semantics: requestSemantics }
    : withAttribution;
  if (messages == null) return withSemantics;
  const res = extractCustomInstructions(messages, system, { requestSource });
  if (res.skipped === 'size') {
    return { ...(withSemantics || {}), customInstructions: { skipped: 'size' } };
  }
  if (res.items && res.items.length) {
    return { ...(withSemantics || {}), customInstructions: res.items };
  }
  return withSemantics;
}

function affinityKeyForRequest(req, body) {
  const source = body || req?.body || {};
  const promptCacheKey = source.prompt_cache_key;
  if (typeof promptCacheKey === 'string' && promptCacheKey.trim()) return promptCacheKey.trim();
  const userId = source.metadata?.user_id;
  if (typeof userId === 'string' && userId.trim()) return userId.trim();
  const system = source.system ?? source.instructions ?? (Array.isArray(source.messages) ? source.messages.find(m => m.role === 'system')?.content : '');
  const text = typeof system === 'string' ? system : JSON.stringify(system || '');
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function addFourthCacheBreakpoint(upstreamBody, sourceSystem = upstreamBody.system, enabled = config.gateway?.fourth_cache_breakpoint) {
  if (!enabled || !Array.isArray(upstreamBody.messages) || upstreamBody.messages.length < 6) return false;
  const cacheCount = (Array.isArray(sourceSystem) ? sourceSystem : [sourceSystem]).reduce((count, part) => {
    if (part && typeof part === 'object' && part.cache_control) return count + 1;
    return count;
  }, 0) + upstreamBody.messages.reduce((count, message) => {
    const content = Array.isArray(message.content) ? message.content : [];
    return count + content.filter(block => block && typeof block === 'object' && block.cache_control).length;
  }, 0);
  if (cacheCount > 3 || cacheCount === 0) return false;
  const lastUser = upstreamBody.messages[upstreamBody.messages.length - 1];
  if (!lastUser || lastUser.role !== 'user') return false;
  const content = Array.isArray(lastUser.content) ? lastUser.content : [{ type: 'text', text: String(lastUser.content || '') }];
  if (content.some(block => block?.type === 'thinking')) return false;
  const lastBlock = content[content.length - 1];
  if (!lastBlock || typeof lastBlock !== 'object') return false;
  lastBlock.cache_control = { type: 'ephemeral' };
  lastUser.content = content;
  Logger.debug('[proxyAnthropic] 已补充第四个缓存断点');
  return true;
}

// 计费调整钩子：插件可按 倍率/固定额/重写 修改单次扣费（billing:calculate）
async function adjustBillingCost(weightedTokens, pointsCost, meta) {
  if (!pluginHooks.hasSubscribers('billing:calculate')) return pointsCost;
  try {
    const out = await pluginHooks.apply('billing:calculate', { cost: pointsCost, ratio: 1, weightedTokens }, meta);
    let ratio = Number(out?.ratio);
    if (!Number.isFinite(ratio) || ratio < 0) ratio = 1;
    let cost = Number(out?.cost);
    if (Number.isFinite(cost) && cost >= 0) return cost;
    return Number(pointsCost) * ratio;
  } catch (err) {
    Logger.warn(`[billing:calculate] 钩子异常: ${err.message}`);
    return pointsCost;
  }
}

// 速率限制检查
function checkRateLimit(key, rpmLimit, tpmLimit, tokenCount) {
  const now = Date.now();
  let record = rateLimitStore.get(key);

  if (!record || now - record.windowStart > 60000) {
    record = { windowStart: now, requests: 0, tokens: 0 };
    rateLimitStore.set(key, record);
  }

  record.requests++;
  record.tokens += (tokenCount || 0);

  if (rpmLimit > 0 && record.requests > rpmLimit) {
    return { limited: true, reason: `Rate limit exceeded: ${rpmLimit} requests per minute` };
  }
  if (tpmLimit > 0 && record.tokens > tpmLimit) {
    return { limited: true, reason: `Token limit exceeded: ${tpmLimit} tokens per minute` };
  }
  return { limited: false };
}

/**
 * 判断当前请求是否走 Anthropic Messages API 路径
 * （挂载在 /v1 或 /api 下时 path 为 /messages）
 */
function isAnthropicApiPath(req) {
  const p = (req.path || req.url || '').split('?')[0];
  return p === '/messages' || p.endsWith('/messages');
}

/**
 * 按目标 API 格式构造标准错误响应体
 * OpenAI: { error: { type, message, code? } }
 * Anthropic: { type: "error", error: { type, message } }
 */
function buildApiErrorBody(req, type, message, extra = {}) {
  if (isAnthropicApiPath(req)) {
    // Anthropic 标准错误类型；非标准类型映射到最接近的官方类型
    const anthropicTypeMap = {
      upstream_error: 'api_error',
      server_error: 'api_error',
      quota_exceeded: 'rate_limit_error',
      insufficient_quota: 'rate_limit_error',
      key_disabled: 'authentication_error',
    };
    const mappedType = anthropicTypeMap[type] || type;
    return {
      type: 'error',
      error: { type: mappedType, message, ...(extra.code ? { } : {}), ...omitOpenAIOnly(extra) }
    };
  }
  // OpenAI 标准：无 upstream_error / quota_exceeded
  const openaiTypeMap = {
    upstream_error: 'server_error',
    quota_exceeded: 'insufficient_quota',
  };
  const mappedType = openaiTypeMap[type] || type;
  return {
    error: { type: mappedType, message, ...extra }
  };
}

function omitOpenAIOnly(extra) {
  // Anthropic error 对象不强制携带 code，但保留无害字段
  if (!extra || typeof extra !== 'object') return {};
  const { code, ...rest } = extra;
  return rest;
}

/** 安全解析 JSON 字符串，失败时返回 fallback */
function safeParseJson(str, fallback = {}) {
  if (str == null || str === '') return fallback;
  if (typeof str !== 'string') return str;
  try {
    return JSON.parse(str);
  } catch (e) {
    Logger.warn(`[safeParseJson] JSON 解析失败: ${e.message}, snippet=${String(str).slice(0, 120)}`);
    return fallback;
  }
}

/** 吞图：启用后不把客户端图片转发给上游，并在 message 中注入提示 */
const SWALLOW_IMAGE_NOTICE = '**⚠️ 您已启用吞图，您本次提交的图片不会转发给上游供应商。**';
const SWALLOW_IMAGE_PART_TYPES = new Set(['image', 'image_url', 'input_image']);

function isSwallowImagePart(part) {
  if (!part || typeof part !== 'object') return false;
  if (SWALLOW_IMAGE_PART_TYPES.has(part.type)) return true;
  return false;
}

function makeSwallowTextPart(style = 'openai') {
  if (style === 'responses') return { type: 'input_text', text: SWALLOW_IMAGE_NOTICE };
  // openai / anthropic 均使用 type:text
  return { type: 'text', text: SWALLOW_IMAGE_NOTICE };
}

/**
 * 从 content 中移除图片块。
 * @param {string|Array|*} content
 * @param {'openai'|'anthropic'|'responses'} style
 * @returns {{ content: any, stripped: boolean }}
 */
function stripImagesFromContent(content, style = 'openai') {
  if (content == null) return { content, stripped: false };
  if (typeof content === 'string') return { content, stripped: false };
  if (!Array.isArray(content)) return { content, stripped: false };

  let stripped = false;
  const kept = [];
  for (const part of content) {
    if (isSwallowImagePart(part)) {
      stripped = true;
      continue;
    }
    // tool_result 内嵌 content 也可能含图
    if (part && typeof part === 'object' && part.type === 'tool_result' && Array.isArray(part.content)) {
      const nested = stripImagesFromContent(part.content, style);
      if (nested.stripped) {
        stripped = true;
        kept.push({ ...part, content: nested.content });
        continue;
      }
    }
    kept.push(part);
  }

  if (!stripped) return { content, stripped: false };

  // 若清空后无任何块，保留空数组由上层注入提示
  if (kept.length === 0) return { content: [], stripped: true };
  if (kept.length === 1 && kept[0].type === 'text' && style !== 'responses') {
    return { content: kept[0].text || '', stripped: true };
  }
  if (kept.length === 1 && (kept[0].type === 'input_text' || kept[0].type === 'text') && style === 'responses') {
    // Responses 用户消息通常保持数组结构
    return { content: kept, stripped: true };
  }
  return { content: kept, stripped: true };
}

function injectSwallowNoticeIntoMessage(msg, style = 'openai') {
  if (!msg || typeof msg !== 'object') return msg;
  const content = msg.content;
  if (content == null || content === '' || (Array.isArray(content) && content.length === 0)) {
    return { ...msg, content: style === 'responses' ? [makeSwallowTextPart('responses')] : SWALLOW_IMAGE_NOTICE };
  }
  if (typeof content === 'string') {
    if (content.includes(SWALLOW_IMAGE_NOTICE)) return msg;
    return { ...msg, content: `${content}\n\n${SWALLOW_IMAGE_NOTICE}` };
  }
  if (Array.isArray(content)) {
    const noticePart = makeSwallowTextPart(style);
    // 避免重复注入
    const already = content.some(p => p && p.text === SWALLOW_IMAGE_NOTICE);
    if (already) return msg;
    return { ...msg, content: [...content, noticePart] };
  }
  return { ...msg, content: SWALLOW_IMAGE_NOTICE };
}

/**
 * 从 Chat / Anthropic messages 中剥离图片并注入提示。
 * @returns {{ messages: Array, strippedCount: number }}
 */
function applySwallowImagesToMessages(messages, style = 'openai') {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, strippedCount: 0 };
  }

  let strippedCount = 0;
  let injectIdx = -1;
  const result = messages.map((msg, idx) => {
    if (!msg || typeof msg !== 'object') return msg;
    const { content, stripped } = stripImagesFromContent(msg.content, style);
    if (!stripped) return msg;
    strippedCount += 1;
    // 优先注入到最近一条 user 消息；否则注入到最后一条被剥离的消息
    if (msg.role === 'user' || injectIdx < 0) injectIdx = idx;
    return { ...msg, content };
  });

  if (strippedCount > 0 && injectIdx >= 0) {
    result[injectIdx] = injectSwallowNoticeIntoMessage(result[injectIdx], style);
  }

  return { messages: result, strippedCount };
}

/**
 * 从 Responses API input 中剥离图片并注入提示。
 * @returns {{ input: any, strippedCount: number }}
 */
function applySwallowImagesToResponsesInput(input) {
  if (input == null) return { input, strippedCount: 0 };
  if (typeof input === 'string') return { input, strippedCount: 0 };
  if (!Array.isArray(input)) return { input, strippedCount: 0 };

  let strippedCount = 0;
  let injectIdx = -1;
  const result = [];

  for (let idx = 0; idx < input.length; idx++) {
    const item = input[idx];
    if (!item || typeof item !== 'object') {
      result.push(item);
      continue;
    }

    // 顶层 input_image 项直接丢弃
    if (item.type === 'input_image' || item.type === 'image_url' || item.type === 'image') {
      strippedCount += 1;
      injectIdx = result.length; // 标记在后续注入点附近
      continue;
    }

    if (Array.isArray(item.content)) {
      const { content, stripped } = stripImagesFromContent(item.content, 'responses');
      if (stripped) {
        strippedCount += 1;
        const role = item.role || (item.type === 'message' ? 'user' : undefined);
        const next = { ...item, content };
        result.push(next);
        if (role === 'user' || injectIdx < 0) injectIdx = result.length - 1;
        continue;
      }
    }

    result.push(item);
  }

  if (strippedCount > 0) {
    if (injectIdx >= 0 && injectIdx < result.length) {
      result[injectIdx] = injectSwallowNoticeIntoMessage(result[injectIdx], 'responses');
    } else {
      // 全部是顶层图片被丢弃时，补一条 user 文本提示
      result.push({
        type: 'message',
        role: 'user',
        content: [makeSwallowTextPart('responses')]
      });
    }
  }

  return { input: result, strippedCount };
}

/**
 * 若 API Key 启用吞图，则改写请求体中的图片相关字段。
 * 返回是否实际剥离了图片。
 */
function applySwallowImagesIfEnabled(req) {
  if (!req?.apiUser?.swallowImages) return false;

  let totalStripped = 0;

  if (Array.isArray(req.body?.messages)) {
    const style = isAnthropicApiPath(req) ? 'anthropic' : 'openai';
    const { messages, strippedCount } = applySwallowImagesToMessages(req.body.messages, style);
    if (strippedCount > 0) {
      req.body.messages = messages;
      totalStripped += strippedCount;
    }
  }

  if (req.body?.input != null) {
    const { input, strippedCount } = applySwallowImagesToResponsesInput(req.body.input);
    if (strippedCount > 0) {
      req.body.input = input;
      totalStripped += strippedCount;
    }
  }

  // Anthropic system 也可能是含图的 content 数组（极少见）
  if (Array.isArray(req.body?.system)) {
    const { content, stripped } = stripImagesFromContent(req.body.system, 'anthropic');
    if (stripped) {
      // system 中剥离图片后若为空则置空字符串
      req.body.system = Array.isArray(content) && content.length === 0 ? '' : content;
      totalStripped += 1;
    }
  }

  if (totalStripped > 0) {
    Logger.info(`[吞图] 已剥离图片: key=${req.apiUser.keyName || req.apiUser.keyId}, messages/parts=${totalStripped}, path=${req.path}`);
  }
  return totalStripped > 0;
}

/**
 * 将 OpenAI 多模态 content（string | array）转为 Anthropic content
 * - image_url / data URL → image.source base64 或 url
 * - 已是 Anthropic 块则原样保留
 */
function convertOpenAIContentToAnthropic(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);

  const converted = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      converted.push({ type: 'text', text: part.text || '' });
    } else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string'
        ? part.image_url
        : (part.image_url?.url || '');
      if (typeof url === 'string' && url.startsWith('data:')) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/s);
        if (match) {
          converted.push({
            type: 'image',
            source: { type: 'base64', media_type: match[1] || 'image/jpeg', data: match[2] }
          });
        } else {
          Logger.warn('[convertOpenAIContentToAnthropic] 无法解析 data URL 图片');
        }
      } else if (url) {
        converted.push({
          type: 'image',
          source: { type: 'url', url }
        });
      }
    } else if (part.type === 'image' || part.type === 'tool_use' || part.type === 'tool_result'
      || part.type === 'thinking' || part.type === 'redacted_thinking' || part.type === 'document') {
      converted.push(part);
    } else if (part.text != null && !part.type) {
      converted.push({ type: 'text', text: part.text });
    }
  }

  if (converted.length === 0) return '';
  if (converted.length === 1 && converted[0].type === 'text') return converted[0].text;
  return converted;
}

/** 规范化消息 role：developer → system（OpenAI 新角色） */
function normalizeMessageRole(role) {
  if (role === 'developer') return 'system';
  return role;
}

// 验证API密钥中间件（带缓存优化；按路径返回 OpenAI/Anthropic 标准错误形）
async function validateApiKey(req, res, next) {
  let apiKey = req.headers['x-api-key'];
  // 支持 Authorization: Bearer xxx 格式
  if (!apiKey && req.headers.authorization) {
    const auth = req.headers.authorization;
    if (auth.startsWith('Bearer ')) {
      apiKey = auth.slice(7);
    }
  }

  const sendAuthError = (status, type, message, extra = {}) => {
    Logger.warn(`[API密钥验证] 拒绝请求: status=${status}, type=${type}, path=${req.path}, anthropic=${isAnthropicApiPath(req)}`);
    return res.status(status).json(buildApiErrorBody(req, type, message, extra));
  };

  if (!apiKey) {
    return sendAuthError(401, 'authentication_error', 'Missing API key');
  }

  // 插件 apikey:validate 钩子：可基于 IP/时段/自定义规则拒绝（不影响鉴权主流程）
  if (pluginHooks.hasSubscribers('apikey:validate')) {
    try {
      const v = await pluginHooks.apply('apikey:validate', { allow: true, reason: '', status: 403 }, {
        apiKey: String(apiKey),
        ip: req.ip || '',
        path: req.path,
        requestType: isAnthropicApiPath(req) ? 'anthropic' : (req.path.includes('responses') ? 'responses' : 'openai'),
      });
      if (v && v.allow === false) {
        return sendAuthError(v.status || 403, v.reasonType || 'invalid_request_error', v.reason || 'request blocked by plugin', { code: 'plugin_blocked' });
      }
    } catch (err) {
      Logger.warn(`[API密钥验证] apikey:validate 钩子异常: ${err.message}`);
    }
  }

  try {
    // 尝试从缓存获取验证结果
    const cached = getCachedApiKey(apiKey);
    if (cached) {
      // 缓存命中：直接使用缓存的数据，但仍需检查额度
      Logger.debug(`[API密钥验证] 缓存命中: user=${cached.username}`);

      // 检查密钥是否被禁用
      if (cached.enabled === false) {
        return sendAuthError(403, 'authentication_error', 'API key is disabled. Enable it in your console to resume access.', { code: 'key_disabled' });
      }

      // 检查用户组额度规则 - 超额但仍有积分时可继续
      // 标准状态码使用 429 + insufficient_quota / rate_limit_error（避免非标准 402）
      if (cached.groupId) {
        const quotaRules = await checkQuotaRules(cached.userId, cached.groupId);
        const exceeded = quotaRules && quotaRules.some(r => r.exceeded);
        if (exceeded && (!cached.balance || cached.balance <= 0)) {
          notifyUser(cached.userId, NOTIFICATION_TYPES.QUOTA_INSUFFICIENT, '配额已用尽且积分不足，请及时充值或调整额度。', { source: 'api_key_validation' }).catch(() => {});
          return sendAuthError(429, 'insufficient_quota', '配额已用尽且积分不足', { code: 'insufficient_quota' });
        }
      }

      // 异步更新 last_used_at（不阻塞请求）
      pool.query(
        'UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1',
        [cached.keyId]
      ).catch(err => Logger.warn('[API密钥验证] 更新 last_used_at 失败:', err.message));

      req.apiUser = cached;
      return next();
    }

    // 缓存未命中：查询数据库
    Logger.debug(`[API密钥验证] 缓存未命中，查询数据库: key=${apiKey.slice(0, 8)}...`);

    const result = await pool.query(
      `SELECT ak.*, u.id as user_id, u.username, u.balance, u.group_id,
              u.rate_limit_rpm as user_rate_limit_rpm, u.rate_limit_tpm as user_rate_limit_tpm,
              u.api_signature_enabled, u.api_signature_template
       FROM api_keys ak
       JOIN users u ON ak.user_id = u.id
       WHERE ak.key_value = $1 OR ak.key_hash = $2`,
      [apiKey, sha256Hex(apiKey)]
    );

    // 重新查询以获取 key 级别签名设置
    const keySignatureResult = await pool.query(
      `SELECT signature_enabled, signature_template FROM api_keys WHERE key_value = $1 OR key_hash = $2`,
      [apiKey, sha256Hex(apiKey)]
    );

    if (result.rows.length === 0) {
      return sendAuthError(401, 'authentication_error', 'Invalid API key');
    }

    const keyData = result.rows[0];

    if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
      return sendAuthError(401, 'authentication_error', 'API key has expired');
    }

    if (keyData.enabled === false) {
      return sendAuthError(403, 'authentication_error', 'API key is disabled. Enable it in your console to resume access.', { code: 'key_disabled' });
    }

    // 检查用户组额度规则 - 超额但仍有积分时可继续
    if (keyData.group_id) {
      const quotaRules = await checkQuotaRules(keyData.user_id, keyData.group_id);
      const exceeded = quotaRules && quotaRules.some(r => r.exceeded);
      if (exceeded && (!keyData.balance || keyData.balance <= 0)) {
        notifyUser(keyData.user_id, NOTIFICATION_TYPES.QUOTA_INSUFFICIENT, '配额已用尽且积分不足，请及时充值或调整额度。', { source: 'api_key_validation' }).catch(() => {});
        return sendAuthError(429, 'insufficient_quota', '配额已用尽且积分不足', { code: 'insufficient_quota' });
      }
    }

    // 异步更新 last_used_at（不阻塞请求）
    pool.query(
      'UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1',
      [keyData.id]
    ).catch(err => Logger.warn('[API密钥验证] 更新 last_used_at 失败:', err.message));

    const currentModelId = keyData.current_model_id || null;
    const modelQueue = await loadModelQueueForKey(keyData.id, currentModelId);
    const harnessModels = await loadHarnessModelsForKey(keyData.id);

    // 构建用户信息对象
    const apiUser = {
      userId: keyData.user_id,
      username: keyData.username,
      keyId: keyData.id,
      groupId: keyData.group_id,
      balance: keyData.balance,
      userRateLimitRpm: keyData.user_rate_limit_rpm || 0,
      userRateLimitTpm: keyData.user_rate_limit_tpm || 0,
      customModelName: keyData.custom_model_name || 'claude-fable-5',
      currentModelId,
      modelQueue,
      harnessModels,
      fusionPanelModels: keyData.fusion_panel_models || [],
      fusionJudgeModelId: keyData.fusion_judge_model_id || '',
      fusionOuterModelId: keyData.fusion_outer_model_id || '',
      fusionEnabled: keyData.fusion_enabled !== false,
      // 优先使用 key 级别签名设置，回退到用户级别设置
      signatureEnabled: keySignatureResult.rows[0]?.signature_enabled !== null
        ? keySignatureResult.rows[0].signature_enabled
        : keyData.api_signature_enabled === true,
      signatureTemplate: keySignatureResult.rows[0]?.signature_template || keyData.api_signature_template || null,
      keySignatureEnabled: keySignatureResult.rows[0]?.signature_enabled,  // 保留原始值用于前端显示
      keySignatureTemplate: keySignatureResult.rows[0]?.signature_template,
      quotaWarningEnabled: keyData.quota_warning_enabled === true,
      keyName: keyData.name || '',
      enabled: keyData.enabled !== false,
      // 吞图：默认禁用；启用后客户端图片不转发给上游
      swallowImages: keyData.swallow_images === true,
      crewrouterCommands: keyData.crewrouter_commands !== false
    };

    // 注入提示词：查好拼接结果随 apiUser 一起缓存（无启用条目为 null）
    try {
      apiUser.injectPrompt = await buildInjectedPrompt(keyData.user_id, keyData.id);
    } catch (err) {
      Logger.warn('[API密钥验证] 注入提示词查询失败:', err.message);
      apiUser.injectPrompt = null;
    }

    // 缓存验证结果
    setCachedApiKey(apiKey, apiUser);

    req.apiUser = apiUser;
    next();
  } catch (error) {
    Logger.error('[API密钥验证] 错误:', error);
    res.status(500).json(buildApiErrorBody(req, 'server_error', 'Internal server error'));
  }
}

/**
 * 根据供应商配置构建上游请求头
 * @param {object} provider - 供应商配置（含 content_type_mode / forward_headers）
 * @param {object} req - Express 请求对象
 * @param {object} baseHeaders - 必须的基础头（auth、anthropic-version 等）
 * @returns {object} 最终的请求头
 */
function buildUpstreamHeaders(provider, req, baseHeaders) {
  const headers = { ...baseHeaders };

  // Content-Type 策略
  if (provider.content_type_mode === 'passthrough') {
    const ct = req.headers['content-type'];
    if (ct) headers['Content-Type'] = ct;
  }
  // 否则保持 baseHeaders 中的 'application/json'

  // 请求头转发策略
  if (provider.forward_headers !== false) {
    // 永不转发的敏感/传输层头
    const denied = new Set([
      'authorization', 'x-api-key', 'api-key', 'proxy-authorization',
      'host', 'cookie', 'set-cookie', 'origin', 'referer',
      'content-type', 'content-length', 'transfer-encoding',
      'connection', 'upgrade', 'keep-alive', 'expect',
      'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'x-forwarded-host',
      'cf-connecting-ip', 'cf-ray', 'cf-worker', 'cdn-loop',
    ]);
    for (const [key, val] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (!denied.has(lower) && val && headers[lower] === undefined) {
        headers[lower] = Array.isArray(val) ? val.join(', ') : val;
      }
    }
  }

  // 供应商级静态 User-Agent 覆盖（插件仍可在 beforeUpstream 钩子中动态改写）
  if (provider.request_user_agent && String(provider.request_user_agent).trim()) {
    headers['user-agent'] = String(provider.request_user_agent).trim();
  }

  return headers;
}

// 清理 base_url 与拼接上游端点：统一走 url-validator（保留 /v1、/api/v1 版本前缀）
const { cleanBaseUrl, upstreamUrl } = require('../utils/url-validator');

// 预加载签名注入所需的数据（性能优化：减少重复数据库查询）
async function preloadSignatureData(userId, groupId, template) {
  if (!template) return {};

  const preloaded = {};

  // 检查模板中使用了哪些变量，并行预加载
  const promises = [];

  if (/\{quota_info\}/.test(template)) {
    promises.push(
      getQuotaInfo(userId)
        .then(info => { preloaded.quotaInfo = info; })
        .catch(err => Logger.warn('[预加载] 获取 quotaInfo 失败:', err.message))
    );
  }

  if (/\{group_name\}/.test(template)) {
    promises.push(
      getGroupName(groupId)
        .then(name => { preloaded.groupName = name; })
        .catch(err => Logger.warn('[预加载] 获取 groupName 失败:', err.message))
    );
  }

  if (/\{team_name\}/.test(template)) {
    promises.push(
      getTeamName(userId)
        .then(name => { preloaded.teamName = name; })
        .catch(err => Logger.warn('[预加载] 获取 teamName 失败:', err.message))
    );
  }

  if (/\{today_requests\}/.test(template) || /\{today_tokens\}/.test(template)) {
    promises.push(
      getTodayStats(userId)
        .then(stats => { preloaded.todayStats = stats; })
        .catch(err => Logger.warn('[预加载] 获取 todayStats 失败:', err.message))
    );
  }

  // 并行执行所有预加载
  if (promises.length > 0) {
    await Promise.all(promises);
  }

  return preloaded;
}

// 转发到上游 OpenAI 格式
async function proxyOpenAI(provider, model, body, stream, res, req, options = {}) {
  const suppressErrorResponse = !!options.suppressErrorResponse;
  const baseUrl = cleanBaseUrl(provider.base_url);
  const url = upstreamUrl(baseUrl, '/chat/completions');
  const startTime = Date.now();
  const headers = buildUpstreamHeaders(provider, req, {
    'Content-Type': 'application/json'
  });
  if (provider.api_key) {
    headers['Authorization'] = `Bearer ${provider.api_key}`;
  }

  // 代理池支持：获取代理 agent 和重试次数
  const proxyInfo = await proxyPool.getProxyAgent(provider, affinityKeyForRequest(req, req.body));
  const proxyList = await proxyPool.getProxies(provider);
  const maxRetries = Math.min(MAX_UPSTREAM_ATTEMPTS, Math.max(proxyList.length || 1, 1));
  let currentProxyInfo = proxyInfo;

  // 预加载签名注入所需的数据（性能优化：减少重复数据库查询）
  let preloadedSignatureData = {};
  if (req.apiUser.signatureEnabled && req.apiUser.signatureTemplate) {
    preloadedSignatureData = await preloadSignatureData(
      req.apiUser.userId,
      req.apiUser.groupId,
      req.apiUser.signatureTemplate
    );
  }

  const upstreamBody = {
    model: model,
    messages: body.messages,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    top_p: body.top_p,
    frequency_penalty: body.frequency_penalty,
    presence_penalty: body.presence_penalty,
    stop: body.stop,
    stream: !!stream
  };

  if (body.tools) upstreamBody.tools = body.tools;
  if (body.tool_choice) upstreamBody.tool_choice = body.tool_choice;
  if (body.response_format) upstreamBody.response_format = body.response_format;
  if (body.n) upstreamBody.n = body.n;
  if (body.stream_options) upstreamBody.stream_options = body.stream_options;
  // 透传 max_completion_tokens（o 系列 / 新 OpenAI 模型）
  if (body.max_completion_tokens !== undefined) {
    upstreamBody.max_completion_tokens = body.max_completion_tokens;
    // 部分上游仍只认 max_tokens，两者都给更稳妥；若上游同时拒绝则由上游报错
    if (body.max_tokens === undefined) {
      upstreamBody.max_tokens = body.max_completion_tokens;
    }
  }
  if (body.seed !== undefined) upstreamBody.seed = body.seed;
  if (body.logit_bias !== undefined) upstreamBody.logit_bias = body.logit_bias;
  if (body.user !== undefined) upstreamBody.user = body.user;
  // reasoning_effort：仅当模型开启 forward_reasoning_effort 时由上层写入 body
  if (body.reasoning_effort !== undefined) upstreamBody.reasoning_effort = body.reasoning_effort;

  // 注入提示词：插入首条 user 消息前的 meta user（复制数组，重试/换供应商不会重复拼接）
  if (req.apiUser?.injectPrompt) {
    upstreamBody.messages = openaiAppend([...(upstreamBody.messages || [])], req.apiUser.injectPrompt);
  }

  if (stream && !upstreamBody.stream_options) {
    upstreamBody.stream_options = { include_usage: true };
  }

  const msgCount = body.messages?.length || 0;
  Logger.info(`[proxyOpenAI] 请求: provider=${provider.id}(${provider.name}), url=${url}, model=${model}, stream=${!!stream}, messages=${msgCount}, max_tokens=${body.max_tokens ?? '-'}, temperature=${body.temperature ?? '-'}, proxy=${currentProxyInfo?.proxyUrl || 'none'}`);

  if (stream) {
    // 带代理重试的 fetch
    const { response, currentProxyInfo: finalProxyInfo } = await fetchWithProxyRetry(
      (proxyInfo) => ({
        url,
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(UPSTREAM_STREAM_TIMEOUT),
        agent: proxyInfo?.agent
      }),
      provider,
      currentProxyInfo,
      maxRetries,
      'proxyOpenAI',
      { model, requestType: 'proxyOpenAI', affinityKey: affinityKeyForRequest(req, req.body) }
    );
    currentProxyInfo = finalProxyInfo;

    if (!response) {
      Logger.error(`[proxyOpenAI] 上游无响应(流式): provider=${provider.id}(${provider.name}), url=${url}`);
      return respondProxyError(res, 502, {
        error: { message: 'Upstream request failed: no response', type: 'server_error', code: 'upstream_error' }
      }, { suppressErrorResponse, retryable: true });
    }

    if (!response.ok) {
      const err = await response.text();
      Logger.error(`[proxyOpenAI] 上游响应错误: provider=${provider.id}(${provider.name}), url=${url}, status=${response.status}, body=${err.substring(0, 500)}`);
      let errBody;
      try { errBody = JSON.parse(err); } catch { errBody = null; }
      const bodyOut = errBody?.error
        ? errBody
        : {
            error: {
              message: typeof err === 'string' ? err.slice(0, 2000) : 'Upstream request failed',
              type: 'server_error',
              code: 'upstream_error'
            }
          };
      return respondProxyError(res, response.status, bodyOut, { suppressErrorResponse });
    }

    // 标记代理成功
    if (currentProxyInfo?.proxyId) {
      proxyPool.markProxySuccess(provider.id, currentProxyInfo.proxyId, Date.now() - startTime);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    Logger.stream(`[proxyOpenAI] SSE 头已发送, 开始流式传输: provider=${provider.id}(${provider.name}), model=${model}, url=${url}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalContent = '';
    let lastUsage = null;
    const streamChunkId = genChatCompletionId();
    const streamCreated = Math.floor(Date.now() / 1000);
    const streamNormLog = { logged: false };
    let chunkCount = 0;
    let sseLineCount = 0;
    let jsonParseErrors = 0;
    let firstChunkTime = null;
    let clientDisconnected = false;
    let backpressureCount = 0;
    let gotDone = false;
    const streamScrubber = createStreamScrubber(req.apiUser?.injectPrompt);

    // 检测客户端断开连接
    req.on('close', () => {
      clientDisconnected = true;
      Logger.stream(`[proxyOpenAI] 客户端断开连接: provider=${provider.id}, model=${model}, 已接收 ${chunkCount} 个chunk, ${sseLineCount} 行SSE`);
    });

    // 背压处理：等待 drain 事件后再继续，支持客户端断开中断
    const writeWithDrain = (data) => {
      if (clientDisconnected) return false;
      const ok = res.write(data);
      if (!ok) {
        backpressureCount++;
        if (backpressureCount <= 3 || backpressureCount % 10 === 0) {
          Logger.warn(`[proxyOpenAI] 背压等待drain: provider=${provider.id}, model=${model}, 累计=${backpressureCount}次`);
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

    // 归一化并写出流式 chunk（补全 id/object/created/model，兼容严格 SDK）
    const writeNormalizedChunk = async (dataStr) => {
      try {
        // 插件 gateway:responseChunk 钩子：改写/丢弃 SSE 数据帧
        let frame = dataStr;
        if (pluginHooks.hasSubscribers('gateway:responseChunk')) {
          const out = await pluginHooks.maybeRewriteChunk(dataStr, { model, requestType: 'proxyOpenAI', affinityKey: affinityKeyForRequest(req, req.body) });
          if (!out) return; // 空字符串视为丢弃该帧
          frame = out;
        }
        const parsed = JSON.parse(frame);
        const originalContent = parsed.choices?.[0]?.delta?.content || '';
        const content = streamScrubber.feed(originalContent);
        if (parsed.choices?.[0]?.delta && originalContent !== content) {
          parsed.choices[0].delta.content = content;
        }
        totalContent += content;
        if (parsed.usage) lastUsage = parsed.usage;
        const normalizedChunk = ensureChatCompletionChunk(parsed, {
          id: streamChunkId,
          created: streamCreated,
          model,
          logPrefix: `proxyOpenAI/${provider.id}`,
          logOnceRef: streamNormLog
        });
        const ok = writeWithDrain(`data: ${JSON.stringify(normalizedChunk)}\n\n`);
        if (!ok) await waitForDrain();
      } catch (e) {
        jsonParseErrors++;
        Logger.warn(`[proxyOpenAI] JSON解析失败: data=${dataStr.substring(0, 200)}, error=${e.message}`);
        const ok = writeWithDrain(`data: ${dataStr}\n\n`);
        if (!ok) await waitForDrain();
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (clientDisconnected) {
          Logger.stream(`[proxyOpenAI] 客户端已断开, 停止读取上游: provider=${provider.id}, model=${model}`);
          break;
        }

        if (!firstChunkTime) {
          firstChunkTime = Date.now();
          Logger.stream(`[proxyOpenAI] 收到首个上游chunk: 等待耗时=${firstChunkTime - startTime}ms, chunk大小=${value.length}bytes`);
        }
        chunkCount++;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            sseLineCount++;
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              Logger.stream(`[proxyOpenAI] 收到上游 [DONE] 事件`);
              gotDone = true;
              continue;
            }
            await writeNormalizedChunk(data);
          }
        }
      }

      // Process any residual data left in the buffer
      if (buffer.trim() && !clientDisconnected) {
        Logger.stream(`[proxyOpenAI] 处理残余缓冲区: ${buffer.length} bytes`);
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            sseLineCount++;
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              gotDone = true;
              continue;
            }
            await writeNormalizedChunk(data);
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        Logger.error(`[proxyOpenAI] 流式超时 (${UPSTREAM_STREAM_TIMEOUT}ms): url=${url}, model=${model}, 已接收 ${chunkCount} chunks`);
      } else if (clientDisconnected) {
        Logger.warn(`[proxyOpenAI] 上游读取中断(客户端已断开): url=${url}, model=${model}, error=${err.message}`);
      } else {
        Logger.error(`[proxyOpenAI] 流式读取错误: url=${url}, model=${model}, error=${err.message}, chunkCount=${chunkCount}`);
      }
    }

    const residualScrubbed = streamScrubber.flush();
    if (residualScrubbed && !clientDisconnected) {
      const ok = writeWithDrain(`data: ${JSON.stringify(buildChatCompletionChunk({ id: streamChunkId, created: streamCreated, model, delta: { content: residualScrubbed } }))}\n\n`);
      if (!ok) await waitForDrain();
      totalContent += residualScrubbed;
    }
    const latency = Date.now() - startTime;
    const normalized = normalizeUsageTokens(lastUsage, 'openai');

    // 流式签名：headers 已 flush，仅按智能跳过决定是否追加 content
    if (gotDone && !clientDisconnected) {
      try {
        const signature = await buildSignatureForRequest(req, {
          model, normalized, providerName: provider.name, provider, preloaded: preloadedSignatureData
        });
        if (signature) {
          const mode = resolveSignatureMode(req);
          const plan = planStreamSignatureInjection({
            mode,
            requestBody: body,
            hasTextContent: totalContent.length > 0,
            hasToolCalls: false,
            format: 'openai'
          });
          Logger.info(`[proxyOpenAI] 流式签名: append=${plan.appendContent}, reason=${plan.reason}, mode=${mode}`);
          if (plan.appendContent) {
            const sigChunk = JSON.stringify(buildChatCompletionChunk({
              id: streamChunkId,
              created: streamCreated,
              model,
              delta: { content: `\n\n${signature}` }
            }));
            const ok = writeWithDrain(`data: ${sigChunk}\n\n`);
            if (!ok) await waitForDrain();
          }
        }
      } catch (e) {
        Logger.warn(`[proxyOpenAI] 签名生成失败: ${e.message}`);
      }
      writeWithDrain('data: [DONE]\n\n');
    }

    res.end();
    Logger.stream(`[proxyOpenAI] 流式传输统计: chunkCount=${chunkCount}, sseLineCount=${sseLineCount}, jsonParseErrors=${jsonParseErrors}, contentLength=${totalContent.length}, 首chunk耗时=${firstChunkTime ? firstChunkTime - startTime : '-'}ms, 客户端断开=${clientDisconnected}, 背压次数=${backpressureCount}`);
    const cacheHitRate = normalized.promptTokens > 0 ? (normalized.cachedTokens / normalized.promptTokens * 100).toFixed(1) : 0;
    Logger.info(`[proxyOpenAI] 流式完成: provider=${provider.id}(${provider.name}), model=${model}, latency=${latency}ms, prompt_tokens=${normalized.promptTokens || 0}, completion_tokens=${normalized.completionTokens || 0}, cached_tokens=${normalized.cachedTokens || 0}, cache_hit_rate=${cacheHitRate}%`);
    return { ...normalized, content: totalContent };
  } else {
    // 非流式请求：带代理重试的 fetch
    const { response, currentProxyInfo: finalProxyInfo } = await fetchWithProxyRetry(
      (proxyInfo) => ({
        url,
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
        agent: proxyInfo?.agent
      }),
      provider,
      currentProxyInfo,
      maxRetries,
      'proxyOpenAI',
      { model, requestType: 'proxyOpenAI', affinityKey: affinityKeyForRequest(req, req.body) }
    );
    currentProxyInfo = finalProxyInfo;

    const latency = Date.now() - startTime;
    if (!response) {
      Logger.error(`[proxyOpenAI] 上游无响应: provider=${provider.id}(${provider.name}), url=${url}, latency=${latency}ms`);
      return respondProxyError(res, 502, {
        error: { message: 'Upstream request failed: no response', type: 'server_error', code: 'upstream_error' }
      }, { suppressErrorResponse, retryable: true });
    }

    let data;
    try {
      data = JSON.parse(await response.text());
    } catch (parseErr) {
      Logger.error(`[proxyOpenAI] 上游响应解析失败: provider=${provider.id}(${provider.name}), url=${url}, status=${response.status}, latency=${latency}ms, error=${parseErr.message}`);
      return respondProxyError(res, 502, {
        error: { message: 'Upstream returned invalid JSON', type: 'server_error', code: 'upstream_error' }
      }, { suppressErrorResponse, retryable: true });
    }

    if (!response.ok) {
      Logger.error(`[proxyOpenAI] 上游响应错误: provider=${provider.id}(${provider.name}), url=${url}, status=${response.status}, latency=${latency}ms, body=${JSON.stringify(data).substring(0, 500)}`);
      return respondProxyError(res, response.status, data, { suppressErrorResponse });
    }

    // 插件 gateway:upstreamResponse 钩子：改写上游返回的响应体
    if (pluginHooks.hasSubscribers('gateway:upstreamResponse')) {
      const out = await pluginHooks.apply('gateway:upstreamResponse', { status: response.status, body: data }, {
        provider: { id: provider.id, name: provider.name },
        model,
        requestType: 'proxyOpenAI',
      });
      if (out?.body !== undefined && out.body !== null) data = out.body;
    }

    // 标记代理成功
    if (currentProxyInfo?.proxyId) {
      proxyPool.markProxySuccess(provider.id, currentProxyInfo.proxyId, latency);
    }

    // 补全 id/object/created/model，避免严格 SDK（如 Grok Build）反序列化失败
    data = ensureChatCompletionResponse(data, {
      model,
      fallbackId: genChatCompletionId(),
      logPrefix: `proxyOpenAI/${provider.id}`
    });

    const normalized = normalizeUsageTokens(data.usage, 'openai');
    try {
      const signature = await buildSignatureForRequest(req, {
        model, normalized, providerName: provider.name, provider, preloaded: preloadedSignatureData
      });
      if (signature) {
        injectSignatureIntoOpenAIResponse(res, data, signature, {
          mode: resolveSignatureMode(req),
          requestBody: body
        });
      }
    } catch (e) {
      Logger.warn(`[proxyOpenAI] 非流式签名生成失败: ${e.message}`);
    }

    // 插件 gateway:finalResponse 钩子：追加自定义响应头
    await pluginHooks.applyFinalResponseHeaders(res, { provider: { id: provider.id }, model, requestType: 'proxyOpenAI' });
    // 注入提示词回显净化：模型复述 system 注入块时，返回前剥离（仅启用注入的请求）
    if (req.apiUser?.injectPrompt) {
      scrubOpenAiChatCompletion(data, req.apiUser.injectPrompt);
    }
    res.json(data);
    const cacheHitRate = normalized.promptTokens > 0 ? (normalized.cachedTokens / normalized.promptTokens * 100).toFixed(1) : 0;
    Logger.info(`[proxyOpenAI] 非流式完成: provider=${provider.id}(${provider.name}), model=${model}, latency=${latency}ms, id=${data.id}, prompt_tokens=${normalized.promptTokens || 0}, completion_tokens=${normalized.completionTokens || 0}, cached_tokens=${normalized.cachedTokens || 0}, cache_hit_rate=${cacheHitRate}%`);
    return { ...normalized, content: data.choices?.[0]?.message?.content || '' };
  }
}

/**
 * 转发到上游 Responses 格式（Chat 客户端 → /v1/responses → Chat 响应）
 * 当供应商 format=responses（原生只支持 OpenAI Responses API）时，
 * 将 OpenAI Chat 请求转换为 Responses 请求打给上游 /v1/responses，
 * 再把上游的 Responses 响应转换回 chat.completion。
 */
async function proxyChatToResponses(provider, model, body, stream, res, req, options = {}) {
  const suppressErrorResponse = !!options.suppressErrorResponse;
  const baseUrl = cleanBaseUrl(provider.base_url);
  const url = upstreamUrl(baseUrl, '/responses');
  const startTime = Date.now();
  const headers = buildUpstreamHeaders(provider, req, {
    'Content-Type': 'application/json'
  });
  if (provider.api_key) {
    headers['Authorization'] = `Bearer ${provider.api_key}`;
  }

  const proxyInfo = await proxyPool.getProxyAgent(provider, affinityKeyForRequest(req, req.body));
  const proxyList = await proxyPool.getProxies(provider);
  const maxRetries = Math.min(MAX_UPSTREAM_ATTEMPTS, Math.max(proxyList.length || 1, 1));
  let currentProxyInfo = proxyInfo;

  const upstreamBody = ResponsesUpstream.chatToResponsesBody({ ...body, stream: !!stream }, model);
  // 注入提示词：放入 Responses input 首条 user 前的 meta user
  if (req.apiUser?.injectPrompt) {
    upstreamBody.input = responsesAppend(upstreamBody.input, req.apiUser.injectPrompt);
  }
  const msgCount = body.messages?.length || 0;
  Logger.info(`[proxyChatToResponses] 请求: provider=${provider.id}(${provider.name}), url=${url}, model=${model}, stream=${!!stream}, messages=${msgCount}, proxy=${currentProxyInfo?.proxyUrl || 'none'}`);

  const { response, currentProxyInfo: finalProxyInfo } = await fetchWithProxyRetry(
    (proxyInfo) => ({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(stream ? UPSTREAM_STREAM_TIMEOUT : UPSTREAM_TIMEOUT),
      agent: proxyInfo?.agent
    }),
    provider,
    currentProxyInfo,
    maxRetries,
    'proxyChatToResponses',
    { model, requestType: 'proxyChatToResponses', affinityKey: affinityKeyForRequest(req, req.body) }
  );
  currentProxyInfo = finalProxyInfo;

  if (!response) {
    Logger.error(`[proxyChatToResponses] 上游无响应: provider=${provider.id}(${provider.name}), url=${url}`);
    return respondProxyError(res, 502, {
      error: { message: 'Upstream request failed: no response', type: 'server_error', code: 'upstream_error' }
    }, { suppressErrorResponse, retryable: true });
  }

  if (!response.ok) {
    const errText = await response.text();
    Logger.error(`[proxyChatToResponses] 上游响应错误: provider=${provider.id}(${provider.name}), url=${url}, status=${response.status}, body=${errText.substring(0, 500)}`);
    let errBody = null;
    try { errBody = JSON.parse(errText); } catch { errBody = null; }
    const bodyOut = errBody?.error ? errBody : {
      error: {
        message: typeof errText === 'string' && errText ? errText.slice(0, 2000) : 'Upstream request failed',
        type: 'server_error',
        code: 'upstream_error'
      }
    };
    return respondProxyError(res, response.status, bodyOut, { suppressErrorResponse });
  }

  if (currentProxyInfo?.proxyId) {
    proxyPool.markProxySuccess(provider.id, currentProxyInfo.proxyId, Date.now() - startTime);
  }

  // 流式：Responses SSE → chat.completion.chunk SSE
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    Logger.stream(`[proxyChatToResponses] SSE 头已发送, 开始流式传输: provider=${provider.id}(${provider.name}), model=${model}, url=${url}`);

    const { content, usage } = await ResponsesUpstream.streamResponsesAsChatCompletion(response.body, res, {
      model, logPrefix: 'proxyChatToResponses', scrubber: createStreamScrubber(req.apiUser?.injectPrompt)
    });

    const streamUsage = usage || {};
    const promptTokens = streamUsage.input_tokens || 0;
    const completionTokens = streamUsage.output_tokens || 0;
    const cachedTokens = streamUsage.cached_tokens
      || streamUsage.input_tokens_details?.cached_tokens
      || streamUsage.prompt_tokens_details?.cached_tokens
      || 0;
    return { promptTokens, completionTokens, cachedTokens, content };
  }

  // 非流式：Responses → chat.completion
  const data = await response.json();
  const latency = Date.now() - startTime;
  const completion = ResponsesUpstream.responsesToChatCompletion(data, { model });
  const usage = data?.usage || {};
  const normalized = {
    promptTokens: usage.input_tokens || 0,
    completionTokens: usage.output_tokens || 0,
    cachedTokens: usage.cached_tokens || 0
  };
  // 注入提示词回显净化：返回体与入库内容同步剥离（仅启用注入的请求）
  if (req.apiUser?.injectPrompt) {
    scrubOpenAiChatCompletion(completion, req.apiUser.injectPrompt);
  }
  const storedContent = req.apiUser?.injectPrompt
    ? scrubInjectedEcho(ResponsesUpstream.extractResponsesText(data), { exactText: req.apiUser.injectPrompt })
    : ResponsesUpstream.extractResponsesText(data);
  res.json(completion);
  Logger.info(`[proxyChatToResponses] 非流式完成: provider=${provider.id}(${provider.name}), model=${model}, latency=${latency}ms, prompt_tokens=${normalized.promptTokens}, completion_tokens=${normalized.completionTokens}`);
  return { ...normalized, content: storedContent };
}

// 转发到上游 Anthropic 格式
async function proxyAnthropic(provider, model, body, stream, res, req, options = {}) {
  const suppressErrorResponse = !!options.suppressErrorResponse;
  const baseUrl = cleanBaseUrl(provider.base_url);
  const url = upstreamUrl(baseUrl, '/messages');
  const headers = buildUpstreamHeaders(provider, req, {
    'Content-Type': 'application/json',
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01'
  });
  if (provider.api_key) {
    headers['x-api-key'] = provider.api_key;
  }
  // 透传 anthropic-beta 扩展能力头（始终透传，属于协议级头）
  if (req.headers['anthropic-beta']) {
    headers['anthropic-beta'] = req.headers['anthropic-beta'];
  }

  // 代理池支持：获取代理 agent 和重试次数
  const proxyInfo = await proxyPool.getProxyAgent(provider, affinityKeyForRequest(req, req.body));
  const proxyList = await proxyPool.getProxies(provider);
  const maxRetries = Math.min(MAX_UPSTREAM_ATTEMPTS, Math.max(proxyList.length || 1, 1));
  let currentProxyInfo = proxyInfo;

  // 预加载签名注入所需的数据（性能优化：减少重复数据库查询）
  let preloadedSignatureData = {};
  if (req.apiUser.signatureEnabled && req.apiUser.signatureTemplate) {
    preloadedSignatureData = await preloadSignatureData(
      req.apiUser.userId,
      req.apiUser.groupId,
      req.apiUser.signatureTemplate
    );
  }

  // 将 OpenAI 格式的 messages 转换为 Anthropic 格式
  // 支持: system/developer、tool_calls、tool 结果、image_url 多模态
  const systemParts = [];
  const nonSystemMessages = [];
  for (const m of (body.messages || [])) {
    const role = normalizeMessageRole(m.role);
    if (role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content);
      else if (Array.isArray(m.content)) {
        systemParts.push(m.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n'));
      }
    } else {
      nonSystemMessages.push({ ...m, role });
    }
  }

  const upstreamBody = {
    model: model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096,
    messages: [],
    stream: !!stream
  };

  for (const m of nonSystemMessages) {
    if (m.role === 'tool') {
      // OpenAI tool 消息 → Anthropic tool_result content 块
      const toolContent = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => (typeof c === 'string' ? c : (c.text || ''))).join('\n')
          : (m.content || '');
      upstreamBody.messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: toolContent
        }]
      });
    } else if (m.role === 'assistant' && m.tool_calls) {
      // OpenAI assistant 携带 tool_calls → Anthropic tool_use content 块
      const content = [];
      if (m.content) {
        const textContent = convertOpenAIContentToAnthropic(m.content);
        if (typeof textContent === 'string' && textContent) {
          content.push({ type: 'text', text: textContent });
        } else if (Array.isArray(textContent)) {
          content.push(...textContent.filter(b => b.type === 'text'));
        }
      }
      for (const tc of (m.tool_calls || [])) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || '',
          input: typeof tc.function?.arguments === 'string'
            ? safeParseJson(tc.function.arguments, {})
            : (tc.function?.arguments || {})
        });
      }
      upstreamBody.messages.push({ role: m.role, content });
    } else {
      // 普通消息（含多模态 image_url → Anthropic image）
      upstreamBody.messages.push({
        role: m.role,
        content: convertOpenAIContentToAnthropic(m.content)
      });
    }
  }

  // 注入提示词：放入 Anthropic 首条 user 消息前的 contextual meta user
  if (req.apiUser?.injectPrompt) {
    anthropicAppend(upstreamBody.messages, req.apiUser.injectPrompt);
  }

  if (systemParts.length > 0) {
    upstreamBody.system = systemParts.join('\n');
  }
  addFourthCacheBreakpoint(upstreamBody, systemParts);

  if (body.temperature !== undefined) upstreamBody.temperature = body.temperature;
  if (body.top_p !== undefined) upstreamBody.top_p = body.top_p;
  if (body.stop) upstreamBody.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  if (body.tools) {
    upstreamBody.tools = body.tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} }
    }));
  }
  if (body.tool_choice) {
    if (body.tool_choice === 'auto') upstreamBody.tool_choice = { type: 'auto' };
    else if (body.tool_choice === 'required') upstreamBody.tool_choice = { type: 'any' };
    else if (body.tool_choice === 'none') upstreamBody.tool_choice = { type: 'none' };
    else if (body.tool_choice?.type === 'function') upstreamBody.tool_choice = { type: 'tool', name: body.tool_choice.function?.name };
    else upstreamBody.tool_choice = body.tool_choice;
  }

  const msgCount = body.messages?.length || 0;
  Logger.info(`[proxyAnthropic] 请求: provider=${provider.id}(${provider.name}), url=${url}, model=${model}, stream=${!!stream}, messages=${msgCount}, max_tokens=${body.max_tokens ?? '-'}, temperature=${body.temperature ?? '-'}, proxy=${currentProxyInfo?.proxyUrl || 'none'}`);
  const startTime = Date.now();

  if (stream) {
    // 带代理重试的 fetch
    const { response, currentProxyInfo: finalProxyInfo } = await fetchWithProxyRetry(
      (proxyInfo) => ({
        url,
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(UPSTREAM_STREAM_TIMEOUT),
        agent: proxyInfo?.agent
      }),
      provider,
      currentProxyInfo,
      maxRetries,
      'proxyAnthropic',
      { model, requestType: 'proxyAnthropic', affinityKey: affinityKeyForRequest(req, req.body) }
    );
    currentProxyInfo = finalProxyInfo;

    if (!response.ok) {
      const errText = await response.text();
      const latency = Date.now() - startTime;
      Logger.error(`[proxyAnthropic] 上游响应错误: provider=${provider.id}(${provider.name}), url=${url}, status=${response.status}, latency=${latency}ms, body=${errText.substring(0, 500)}`);
      let errBody;
      try { errBody = JSON.parse(errText); } catch { errBody = errText; }
      const { toOpenAIError } = require('../utils/error-mapper');
      return respondProxyError(res, response.status, toOpenAIError(errBody, response.status), { suppressErrorResponse });
    }

    // 标记代理成功
    if (currentProxyInfo?.proxyId) {
      proxyPool.markProxySuccess(provider.id, currentProxyInfo.proxyId, Date.now() - startTime);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    Logger.stream(`[proxyAnthropic] SSE 头已发送, 开始流式传输: provider=${provider.id}(${provider.name}), model=${model}, url=${url}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalContent = '';
    let anthropicUsage = { input_tokens: 0 };
    let completionTokens = 0;
    let currentBlockType = null;
    // Tool use state: track blocks and accumulate partial_json
    const toolUseBlocks = [];
    let currentToolIndex = -1;
    const streamChunkId = 'chatcmpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const streamCreated = Math.floor(Date.now() / 1000);
    let chunkCount = 0;
    let sseLineCount = 0;
    let jsonParseErrors = 0;
    let firstChunkTime = null;
    let clientDisconnected = false;
    let backpressureCount = 0;
    let gotDone = false;
    let roleEmitted = false;
    let streamFinishReason = 'stop'; // OpenAI finish_reason
    let hasToolCalls = false;
    const streamScrubber = createStreamScrubber(req.apiUser?.injectPrompt);

    // 检测客户端断开连接
    req.on('close', () => {
      clientDisconnected = true;
      Logger.stream(`[proxyAnthropic] 客户端断开连接: provider=${provider.id}, model=${model}, 已接收 ${chunkCount} 个chunk, ${sseLineCount} 行SSE`);
    });

    // 背压处理
    const writeWithDrain = (data) => {
      if (clientDisconnected) return false;
      const ok = res.write(data);
      if (!ok) {
        backpressureCount++;
        if (backpressureCount <= 3 || backpressureCount % 10 === 0) {
          Logger.warn(`[proxyAnthropic] 背压等待drain: provider=${provider.id}, model=${model}, 累计=${backpressureCount}次`);
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

    // 标准 OpenAI 流式：首包携带 role: assistant
    const ensureRoleEmitted = async () => {
      if (roleEmitted || clientDisconnected) return;
      roleEmitted = true;
      const roleChunk = JSON.stringify({
        id: streamChunkId,
        object: 'chat.completion.chunk',
        created: streamCreated,
        model: model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
      });
      const ok = writeWithDrain(`data: ${roleChunk}\n\n`);
      if (!ok) await waitForDrain();
    };

    const emitOpenAIChunk = async (delta, finishReason = null) => {
      await ensureRoleEmitted();
      let payload = {
        id: streamChunkId,
        object: 'chat.completion.chunk',
        created: streamCreated,
        model: model,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      };
      // 插件 gateway:responseChunk 钩子：改写/丢弃输出增量
      let payloadText = JSON.stringify(payload);
      if (pluginHooks.hasSubscribers('gateway:responseChunk') && delta?.content) {
        const out = await pluginHooks.maybeRewriteChunk(delta.content, { model, requestType: 'proxyAnthropic', affinityKey: affinityKeyForRequest(req, req.body) });
        if (out === null) return;
        if (typeof out === 'string' && out !== delta.content) {
          payload = { ...payload, choices: [{ index: 0, delta: { ...delta, content: out }, finish_reason: finishReason }] };
          payloadText = JSON.stringify(payload);
        }
      }
      const ok = writeWithDrain(`data: ${payloadText}\n\n`);
      if (!ok) await waitForDrain();
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (clientDisconnected) {
          Logger.stream(`[proxyAnthropic] 客户端已断开, 停止读取上游: provider=${provider.id}, model=${model}`);
          break;
        }

        if (!firstChunkTime) {
          firstChunkTime = Date.now();
          Logger.stream(`[proxyAnthropic] 收到首个上游chunk: 等待耗时=${firstChunkTime - startTime}ms, chunk大小=${value.length}bytes`);
        }
        chunkCount++;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            sseLineCount++;
            const data = line.slice(6).trim();
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'content_block_start') {
                currentBlockType = parsed.content_block?.type || null;
                Logger.stream(`[proxyAnthropic] content_block_start: type=${currentBlockType}, index=${parsed.index}`);
                if (currentBlockType === 'tool_use') {
                  currentToolIndex = toolUseBlocks.length;
                  hasToolCalls = true;
                  toolUseBlocks.push({
                    id: parsed.content_block.id,
                    name: parsed.content_block.name,
                    arguments: ''
                  });
                  // OpenAI 风格：先发 id/name/type，arguments 为空，后续增量
                  await emitOpenAIChunk({
                    tool_calls: [{
                      index: currentToolIndex,
                      id: parsed.content_block.id,
                      type: 'function',
                      function: { name: parsed.content_block.name, arguments: '' }
                    }]
                  });
                }
              } else if (parsed.type === 'content_block_delta') {
                if (currentBlockType === 'thinking' && parsed.delta?.thinking) {
                  await emitOpenAIChunk({ reasoning_content: parsed.delta.thinking });
                } else if (currentBlockType === 'text' && parsed.delta?.text) {
                  const chunk = streamScrubber.feed(parsed.delta.text);
                  totalContent += chunk;
                  if (chunk) await emitOpenAIChunk({ content: chunk });
                } else if (currentBlockType === 'tool_use' && (parsed.delta?.type === 'input_json_delta' || parsed.delta?.partial_json != null)) {
                  // 增量工具参数（OpenAI tool_calls 流式标准）
                  const partial = parsed.delta.partial_json || '';
                  if (currentToolIndex >= 0 && toolUseBlocks[currentToolIndex]) {
                    toolUseBlocks[currentToolIndex].arguments += partial;
                  }
                  if (partial) {
                    await emitOpenAIChunk({
                      tool_calls: [{
                        index: currentToolIndex,
                        function: { arguments: partial }
                      }]
                    });
                  }
                }
              } else if (parsed.type === 'content_block_stop') {
                if (currentBlockType === 'tool_use' && currentToolIndex >= 0) {
                  const tool = toolUseBlocks[currentToolIndex];
                  Logger.stream(`[proxyAnthropic] tool_use block完成: name=${tool.name}, id=${tool.id}, arguments长度=${tool.arguments.length}`);
                }
                currentBlockType = null;
              } else if (parsed.type === 'message_start' && parsed.message?.usage) {
                anthropicUsage = parsed.message.usage;
              } else if (parsed.type === 'message_delta') {
                if (parsed.usage) {
                  completionTokens = parsed.usage.output_tokens || 0;
                }
                // 映射 Anthropic stop_reason → OpenAI finish_reason
                const sr = parsed.delta?.stop_reason;
                if (sr === 'end_turn') streamFinishReason = 'stop';
                else if (sr === 'max_tokens') streamFinishReason = 'length';
                else if (sr === 'tool_use') streamFinishReason = 'tool_calls';
                else if (sr === 'stop_sequence') streamFinishReason = 'stop';
              } else if (parsed.type === 'message_stop') {
                Logger.stream(`[proxyAnthropic] 收到上游 message_stop 事件`);
                gotDone = true;
              }
              // Ignore ping, signature_delta, and other event types
            } catch (e) {
              jsonParseErrors++;
              Logger.warn(`[proxyAnthropic] JSON解析失败: data=${data.substring(0, 200)}, error=${e.message}`);
            }
          }
        }
      }

      // Process any residual data left in the buffer
      if (buffer.trim() && !clientDisconnected) {
        Logger.stream(`[proxyAnthropic] 处理残余缓冲区: ${buffer.length} bytes`);
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            sseLineCount++;
            const data = line.slice(6).trim();
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'message_delta') {
                if (parsed.usage) completionTokens = parsed.usage.output_tokens || 0;
                const sr = parsed.delta?.stop_reason;
                if (sr === 'end_turn') streamFinishReason = 'stop';
                else if (sr === 'max_tokens') streamFinishReason = 'length';
                else if (sr === 'tool_use') streamFinishReason = 'tool_calls';
              } else if (parsed.type === 'message_stop') {
                gotDone = true;
              }
            } catch (e) {
              jsonParseErrors++;
              Logger.warn(`[proxyAnthropic] 残余缓冲区JSON解析失败: data=${data.substring(0, 200)}, error=${e.message}`);
            }
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        Logger.error(`[proxyAnthropic] 流式超时 (${UPSTREAM_STREAM_TIMEOUT}ms): url=${url}, model=${model}, 已接收 ${chunkCount} chunks`);
      } else if (clientDisconnected) {
        Logger.warn(`[proxyAnthropic] 上游读取中断(客户端已断开): url=${url}, model=${model}, error=${err.message}`);
      } else {
        Logger.error(`[proxyAnthropic] 流式读取错误: url=${url}, model=${model}, error=${err.message}, chunkCount=${chunkCount}`);
      }
    }

    const residualScrubbed = streamScrubber.flush();
    if (residualScrubbed && !clientDisconnected) {
      const ok = writeWithDrain(`data: ${JSON.stringify(buildChatCompletionChunk({ id: streamChunkId, created: streamCreated, model, delta: { content: residualScrubbed } }))}\n\n`);
      if (!ok) await waitForDrain();
      totalContent += residualScrubbed;
    }
    const latency = Date.now() - startTime;
    // Build a synthetic usage object for normalizeUsageTokens (Anthropic format)
    const syntheticUsage = {
      input_tokens: anthropicUsage.input_tokens || 0,
      output_tokens: completionTokens,
      cache_read_input_tokens: anthropicUsage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: anthropicUsage.cache_creation_input_tokens || 0
    };
    const normalized = normalizeUsageTokens(syntheticUsage, 'anthropic');

    // 流式签名：仅在有正文且非纯 tool 时追加 content
    if (gotDone && !clientDisconnected) {
      try {
        const signature = await buildSignatureForRequest(req, {
          model, normalized, providerName: provider.name, provider, preloaded: preloadedSignatureData
        });
        if (signature) {
          const mode = resolveSignatureMode(req);
          const plan = planStreamSignatureInjection({
            mode,
            requestBody: body,
            hasTextContent: totalContent.length > 0,
            hasToolCalls,
            finishReason: streamFinishReason,
            format: 'openai'
          });
          Logger.info(`[proxyAnthropic] 流式签名: append=${plan.appendContent}, reason=${plan.reason}, mode=${mode}`);
          if (plan.appendContent) {
            await emitOpenAIChunk({ content: `\n\n${signature}` });
          }
        }
      } catch (e) {
        Logger.warn(`[proxyAnthropic] 签名生成失败: ${e.message}`);
      }

      // 若有工具调用且上游未给出 tool_use stop_reason，兜底为 tool_calls
      if (hasToolCalls && streamFinishReason === 'stop') {
        streamFinishReason = 'tool_calls';
      }

      // 标准 OpenAI 流式：结束 chunk 带 finish_reason，并附带 usage（若有）
      const finishPayload = {
        id: streamChunkId,
        object: 'chat.completion.chunk',
        created: streamCreated,
        model: model,
        choices: [{ index: 0, delta: {}, finish_reason: streamFinishReason }],
        usage: {
          prompt_tokens: normalized.promptTokens || 0,
          completion_tokens: normalized.completionTokens || 0,
          total_tokens: (normalized.promptTokens || 0) + (normalized.completionTokens || 0),
          ...(normalized.cachedTokens ? {
            prompt_tokens_details: { cached_tokens: normalized.cachedTokens }
          } : {})
        }
      };
      const ok = writeWithDrain(`data: ${JSON.stringify(finishPayload)}\n\n`);
      if (!ok) await waitForDrain();
      writeWithDrain('data: [DONE]\n\n');
    }

    res.end();
    Logger.stream(`[proxyAnthropic] 流式传输统计: chunkCount=${chunkCount}, sseLineCount=${sseLineCount}, jsonParseErrors=${jsonParseErrors}, contentLength=${totalContent.length}, finish_reason=${streamFinishReason}, 首chunk耗时=${firstChunkTime ? firstChunkTime - startTime : '-'}ms, 客户端断开=${clientDisconnected}, toolUseBlocks=${toolUseBlocks.length}, 背压次数=${backpressureCount}`);
    const cacheHitRate = normalized.promptTokens > 0 ? (normalized.cachedTokens / normalized.promptTokens * 100).toFixed(1) : 0;
    Logger.info(`[proxyAnthropic] 流式完成: provider=${provider.id}(${provider.name}), model=${model}, latency=${latency}ms, prompt_tokens=${normalized.promptTokens || 0}, completion_tokens=${normalized.completionTokens || 0}, cached_tokens=${normalized.cachedTokens || 0}, cache_hit_rate=${cacheHitRate}%`);
    return { ...normalized, content: totalContent };
  } else {
    // 非流式请求：带代理重试的 fetch
    const { response, currentProxyInfo: finalProxyInfo } = await fetchWithProxyRetry(
      (proxyInfo) => ({
        url,
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
        agent: proxyInfo?.agent
      }),
      provider,
      currentProxyInfo,
      maxRetries,
      'proxyAnthropic',
      { model, requestType: 'proxyAnthropic', affinityKey: affinityKeyForRequest(req, req.body) }
    );
    currentProxyInfo = finalProxyInfo;

    const data = await response.json();
    const latency = Date.now() - startTime;

    if (!response.ok) {
      Logger.error(`[proxyAnthropic] 上游响应错误: provider=${provider.id}(${provider.name}), url=${url}, status=${response.status}, latency=${latency}ms, body=${JSON.stringify(data).substring(0, 500)}`);
      const { toOpenAIError } = require('../utils/error-mapper');
      return respondProxyError(res, response.status, toOpenAIError(data, response.status), { suppressErrorResponse });
    }

    // 插件 gateway:upstreamResponse 钩子：改写上游返回的响应体（Anthropic 原始格式）
    let hookData = data;
    if (pluginHooks.hasSubscribers('gateway:upstreamResponse')) {
      const out = await pluginHooks.apply('gateway:upstreamResponse', { status: response.status, body: data }, {
        provider: { id: provider.id, name: provider.name },
        model,
        requestType: 'proxyAnthropic',
      });
      if (out?.body !== undefined && out.body !== null) hookData = out.body;
    }

    // 标记代理成功
    if (currentProxyInfo?.proxyId) {
      proxyPool.markProxySuccess(provider.id, currentProxyInfo.proxyId, latency);
    }

    // 将 Anthropic 响应转换为 OpenAI 格式返回
    // 遍历所有 content blocks，支持 text / tool_use / thinking → reasoning_content
    const contentBlocks = hookData.content || [];
    let textContent = '';
    let reasoningContent = '';
    const toolCalls = [];

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        textContent += block.text || '';
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {})
          }
        });
      } else if (block.type === 'thinking') {
        reasoningContent += block.thinking || '';
      }
      // redacted_thinking 无可用明文，跳过
    }

    // stop_reason 映射
    let finishReason = 'stop';
    if (hookData.stop_reason === 'max_tokens') finishReason = 'length';
    else if (hookData.stop_reason === 'tool_use') finishReason = 'tool_calls';
    else if (hookData.stop_reason === 'end_turn') finishReason = 'stop';
    else if (hookData.stop_reason === 'stop_sequence') finishReason = 'stop';

    const message = { role: 'assistant' };
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
      // OpenAI 惯例：有 tool_calls 时 content 可为 null，但若有正文仍保留
      message.content = textContent || null;
    } else {
      message.content = textContent || '';
    }
    if (reasoningContent) {
      message.reasoning_content = reasoningContent;
    }

    const normalizedUsage = normalizeUsageTokens(hookData.usage, 'anthropic');
    const openaiResponse = {
      id: hookData.id || 'chatcmpl-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: normalizedUsage.promptTokens || 0,
        completion_tokens: normalizedUsage.completionTokens || 0,
        total_tokens: (normalizedUsage.promptTokens || 0) + (normalizedUsage.completionTokens || 0),
        ...(normalizedUsage.cachedTokens ? {
          prompt_tokens_details: { cached_tokens: normalizedUsage.cachedTokens }
        } : {})
      }
    };

    const normalized = normalizedUsage;
    try {
      const signature = await buildSignatureForRequest(req, {
        model, normalized, providerName: provider.name, provider, preloaded: preloadedSignatureData
      });
      if (signature) {
        injectSignatureIntoOpenAIResponse(res, openaiResponse, signature, {
          mode: resolveSignatureMode(req),
          requestBody: body
        });
      }
    } catch (e) {
      Logger.warn(`[proxyAnthropic] 非流式签名生成失败: ${e.message}`);
    }

    // 插件 gateway:finalResponse 钩子：追加自定义响应头
    await pluginHooks.applyFinalResponseHeaders(res, { provider: { id: provider.id }, model, requestType: 'proxyAnthropic' });
    // 注入提示词回显净化：模型复述 system 注入块时，返回前剥离（仅启用注入的请求）
    if (req.apiUser?.injectPrompt) {
      scrubOpenAiChatCompletion(openaiResponse, req.apiUser.injectPrompt);
    }
    res.json(openaiResponse);
    const cacheHitRate = normalized.promptTokens > 0 ? (normalized.cachedTokens / normalized.promptTokens * 100).toFixed(1) : 0;
    Logger.info(`[proxyAnthropic] 非流式完成: provider=${provider.id}(${provider.name}), model=${model}, latency=${latency}ms, prompt_tokens=${normalized.promptTokens || 0}, completion_tokens=${normalized.completionTokens || 0}, cached_tokens=${normalized.cachedTokens || 0}, cache_hit_rate=${cacheHitRate}%`);
    return { ...normalized, content: openaiResponse.choices[0].message.content };
  }
}

// OpenAI 兼容: /v1/chat/completions 和 /api/chat/completions
// 双鉴权：Bearer crh_ 前缀走自有 OAuth access token（scope 需 gateway:invoke），
// 其余凭证原样回落 validateApiKey，老路径零影响
router.post('/chat/completions', oauthBearer, handleChatCompletion);

async function handleChatCompletion(req, res) {
  req._upstreamAttemptContext = { upstreamAttempts: 0 };
  const { tryHandleCrewRouterCommand } = require('../utils/crewrouter-command');
  if (await tryHandleCrewRouterCommand(req, res)) return;

  // 插件 gateway:requestReceived 钩子：可改写请求体或短路直接响应
  if (pluginHooks.hasSubscribers('gateway:requestReceived')) {
    const out = await pluginHooks.apply('gateway:requestReceived', { body: req.body }, { model: req.body?.model || null, requestType: 'openai' });
    if (out?.shortCircuit) return res.status(out.status || 200).json(out.body ?? {});
    if (out?.body !== undefined) req.body = out.body;
  }

  // 吞图：在转发前剥离客户端图片并注入提示（默认禁用）
  applySwallowImagesIfEnabled(req);

  let { model, messages, temperature, max_tokens, max_completion_tokens, top_p, frequency_penalty, presence_penalty, stop, stream, tools, tool_choice, response_format, n, fusion_preset, prompt_cache_key } = req.body;
  // 兼容 max_completion_tokens（新 OpenAI / o 系列）
  if (max_tokens === undefined && max_completion_tokens !== undefined) {
    max_tokens = max_completion_tokens;
  }

  // 注入提示词：Fusion 走独立上游调用，在首条 user 消息前插入 meta user
  if (req.apiUser.injectPrompt && Array.isArray(messages) && (model === 'fusion' || model?.startsWith('fusion'))) {
    openaiAppend(messages, req.apiUser.injectPrompt);
  }

  // 检测 Fusion 模型请求
  if (model === 'fusion' || model?.startsWith('fusion')) {
    if (!req.apiUser.fusionEnabled) {
      Logger.info(`[Chat] Fusion 已禁用，回退到普通模型: key=${req.apiUser.keyName}`);
    } else {
      return await handleFusionRequest(req, res, 'openai');
    }
  }

  // CrewRouter: 使用 API Key 绑定的有序模型队列，忽略请求中的 model；
  // 若识别到 harness 且有单独绑定，则优先使用该模型。
  const resolved = resolveModelQueueForRequest(req.apiUser, req);
  const modelQueue = resolved.queue;
  if (!modelQueue.length) {
    return res.status(400).json({ error: { message: 'No model selected. Please select a model from the model library first.', type: 'invalid_request_error' } });
  }

  Logger.info(
    `[Chat] 收到请求: queue=[${modelQueue.join(',')}], stream=${!!stream}, messages=${messages?.length}` +
    `, source=${resolved.requestSource}` +
    (resolved.harnessOverride ? ', harness_override=1' : ', harness_override=0')
  );

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: { message: 'Missing required parameters: messages', type: 'invalid_request_error' } });
  }

  let lastError = null;

  for (let i = 0; i < modelQueue.length; i++) {
    const queueModelId = modelQueue[i];
    const hasMore = i < modelQueue.length - 1;
    const suppressErrorResponse = hasMore;

    const modelConfig = await getModelConfig(queueModelId);
    if (!modelConfig) {
      Logger.warn(`[Chat] 队列模型未找到 attempt=${i + 1}/${modelQueue.length}: ${queueModelId}`);
      lastError = {
        status: 404,
        body: { error: { message: `Model '${queueModelId}' not found`, type: 'not_found_error' } },
        retryable: false
      };
      if (hasMore && lastError.retryable) continue;
      return res.status(404).json(lastError.body);
    }

    // 将 model 解析为上游模型 id（别名→原始id）
    const userRequestedModel = queueModelId;
    model = modelConfig.upstream_model_id || modelConfig.id;

    // TestModel 特殊处理：直接返回固定文本，不调用外部 API
    if (modelConfig.id === 'test-model' || model === 'test-model') {
      Logger.info(`[Chat] TestModel: 直接返回固定文本, stream=${!!stream}`);

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const streamChunkId = 'chatcmpl-test-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const streamCreated = Math.floor(Date.now() / 1000);
        const chunkSize = 5;
        const delayMs = 30;
        let phase = 'thinking';
        let index = 0;

        const sendChunk = () => {
          if (phase === 'thinking') {
            if (index >= TEST_MODEL_THINKING.length) {
              phase = 'content';
              index = 0;
              setTimeout(sendChunk, delayMs);
              return;
            }

            const chunk = TEST_MODEL_THINKING.slice(index, index + chunkSize);
            index += chunkSize;

            const sseData = JSON.stringify({
              id: streamChunkId,
              object: 'chat.completion.chunk',
              created: streamCreated,
              model: model,
              choices: [{ delta: { reasoning_content: chunk }, index: 0 }]
            });
            res.write(`data: ${sseData}\n\n`);
            setTimeout(sendChunk, delayMs);
          } else {
            if (index >= TEST_MODEL_TEXT.length) {
              const usageData = {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
              };
              res.write(`data: ${JSON.stringify({ id: streamChunkId, object: 'chat.completion.chunk', created: streamCreated, model: model, choices: [], usage: usageData })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }

            const chunk = TEST_MODEL_TEXT.slice(index, index + chunkSize);
            index += chunkSize;

            const sseData = JSON.stringify({
              id: streamChunkId,
              object: 'chat.completion.chunk',
              created: streamCreated,
              model: model,
              choices: [{ delta: { content: chunk }, index: 0 }]
            });
            res.write(`data: ${sseData}\n\n`);
            setTimeout(sendChunk, delayMs);
          }
        };

        sendChunk();
      } else {
        const response = {
          id: 'chatcmpl-test-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: TEST_MODEL_TEXT,
              reasoning_content: TEST_MODEL_THINKING
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
          }
        };
        res.json(response);
      }
      return;
    }

    // 速率限制检查（模型级别 + 用户级别，取较严格的值）
    const modelRpm = modelConfig.rate_limit_rpm || 0;
    const modelTpm = modelConfig.rate_limit_tpm || 0;
    const userRpm = req.apiUser.userRateLimitRpm || 0;
    const userTpm = req.apiUser.userRateLimitTpm || 0;

    const effectiveRpm = (modelRpm > 0 && userRpm > 0) ? Math.min(modelRpm, userRpm) : (modelRpm || userRpm);
    const effectiveTpm = (modelTpm > 0 && userTpm > 0) ? Math.min(modelTpm, userTpm) : (modelTpm || userTpm);

    if (effectiveRpm > 0 || effectiveTpm > 0) {
      const estimatedTokens = (messages.reduce((sum, m) => sum + (m.content?.length || 0), 0) / 4) || 500;
      const rpmKey = `rpm:${req.apiUser.userId}:${model}`;
      const rpmCheck = checkRateLimit(rpmKey, effectiveRpm, 0, 0);
      if (rpmCheck.limited) {
        Logger.warn(`[Chat] 速率限制 attempt=${i + 1}/${modelQueue.length}: ${rpmCheck.reason}, user=${req.apiUser.username}, model=${model}`);
        lastError = { status: 429, body: { error: { message: rpmCheck.reason, type: 'rate_limit_error' } }, retryable: false };
        if (hasMore && lastError.retryable) continue;
        return res.status(429).json(lastError.body);
      }
      const tpmKey = `tpm:${req.apiUser.userId}:${model}`;
      const tpmCheck = checkRateLimit(tpmKey, 0, effectiveTpm, Math.ceil(estimatedTokens));
      if (tpmCheck.limited) {
        Logger.warn(`[Chat] 速率限制 attempt=${i + 1}/${modelQueue.length}: ${tpmCheck.reason}, user=${req.apiUser.username}, model=${model}`);
        lastError = { status: 429, body: { error: { message: tpmCheck.reason, type: 'rate_limit_error' } }, retryable: false };
        if (hasMore && lastError.retryable) continue;
        return res.status(429).json(lastError.body);
      }
    }

    const provider = await getProviderForRequest(modelConfig.provider);
    if (!provider) {
      Logger.warn(`[Chat] 供应商未配置 attempt=${i + 1}/${modelQueue.length}: ${modelConfig.provider}`);
      lastError = { status: 500, body: { error: { message: 'Provider not configured', type: 'server_error' } }, retryable: true };
      if (hasMore && lastError.retryable) continue;
      return res.status(500).json(lastError.body);
    }

    let result;
    let providerWithKey = provider;

    const body = { messages, temperature, max_tokens, top_p, frequency_penalty, presence_penalty, stop };

    if (tools !== undefined) body.tools = tools;
    if (tool_choice !== undefined) body.tool_choice = tool_choice;
    if (response_format !== undefined) body.response_format = response_format;
    if (n !== undefined) body.n = n;
    if (max_completion_tokens !== undefined) body.max_completion_tokens = max_completion_tokens;
    if (req.body.seed !== undefined) body.seed = req.body.seed;
    if (req.body.logit_bias !== undefined) body.logit_bias = req.body.logit_bias;
    if (req.body.user !== undefined) body.user = req.body.user;
    if (req.body.stream_options !== undefined) body.stream_options = req.body.stream_options;
    if (prompt_cache_key !== undefined) body.prompt_cache_key = prompt_cache_key;
    if (modelConfig.forward_reasoning_effort && req.body.reasoning_effort !== undefined) {
      body.reasoning_effort = req.body.reasoning_effort;
    }

    req.apiUser._inputPrice = modelConfig.input_price_per_1k_tokens || 0;
    req.apiUser._outputPrice = modelConfig.output_price_per_1k_tokens || 0;

    const uptimeModelId = modelConfig.id || userRequestedModel;
    const liveCallStart = Date.now();

    try {
      Logger.info(`[Chat] 转发到上游 attempt=${i + 1}/${modelQueue.length}: provider=${provider.id}(${provider.name}), format=${provider.format}, url=${cleanBaseUrl(provider.base_url)}, model=${model}, keys=${normalizeProviderKeyEntries(provider).length || 1}`);
      result = await runWithProviderKeyFallback(provider, res, suppressErrorResponse, async (pwk, keyOpts) => {
        providerWithKey = pwk;
        const proxyOpts = { suppressErrorResponse: keyOpts.suppressErrorResponse };
        if (provider.format === 'responses') {
          return proxyChatToResponses(pwk, model, body, !!stream, res, req, proxyOpts);
        }
        if (provider.format === 'anthropic') {
          return proxyAnthropic(pwk, model, body, !!stream, res, req, proxyOpts);
        }
        return proxyOpenAI(pwk, model, body, !!stream, res, req, proxyOpts);
      });
    } catch (error) {
      Logger.error(`[Chat] 上游代理错误 attempt=${i + 1}/${modelQueue.length}: provider=${provider.id}(${provider.name}), url=${cleanBaseUrl(provider.base_url)}, model=${model}, error=${error.message}, stack=${error.stack}`);
      recordModelCall(uptimeModelId, false);
      recordLiveCallTest(uptimeModelId, { ok: false, latency_ms: Date.now() - liveCallStart, error: error.message });
      lastError = buildUpstreamExceptionError(error, 'openai');
      const willRetry = hasMore && !res.headersSent;
      captureCallError(req, {
        modelId: uptimeModelId, providerId: provider?.id, requestType: 'chat',
        status: lastError.status, error, latencyMs: Date.now() - liveCallStart, isFinal: !willRetry
      });
      if (res.headersSent) return;
      if (hasMore) {
        Logger.warn(`[Chat] 队列回退 attempt=${i + 1}/${modelQueue.length} model=${queueModelId} reason=exception`);
        continue;
      }
      return res.status(lastError.status).json(lastError.body);
    }

    if (isProxyErrorResult(result)) {
      recordModelCall(uptimeModelId, false);
      recordLiveCallTest(uptimeModelId, { ok: false, latency_ms: Date.now() - liveCallStart, error: `HTTP ${result.status}` });
      lastError = { status: result.status, body: result.body, retryable: result.retryable };
      const willRetry = hasMore && result.retryable && !res.headersSent;
      captureCallError(req, {
        modelId: uptimeModelId, providerId: provider?.id, requestType: 'chat',
        status: result.status, body: result.body, latencyMs: Date.now() - liveCallStart, isFinal: !willRetry
      });
      if (res.headersSent) return;
      if (hasMore && result.retryable) {
        Logger.warn(`[Chat] 队列回退 attempt=${i + 1}/${modelQueue.length} model=${queueModelId} status=${result.status}`);
        continue;
      }
      return res.status(result.status || 502).json(result.body);
    }

    if (!result) {
      recordModelCall(uptimeModelId, false);
      recordLiveCallTest(uptimeModelId, { ok: false, latency_ms: Date.now() - liveCallStart, error: 'upstream_error' });
      captureCallError(req, {
        modelId: uptimeModelId, providerId: provider?.id, requestType: 'chat',
        status: 502, body: { error: { message: 'upstream_error', type: 'server_error' } },
        latencyMs: Date.now() - liveCallStart, isFinal: true
      });
      // 已写入响应（非 suppress 路径）
      return;
    }

    recordModelCall(uptimeModelId, true);
    recordLiveCallTest(uptimeModelId, {
      ok: true,
      latency_ms: Date.now() - liveCallStart,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens
    });

    // 倍率计费：按实际成功的模型计费
    const totalTokens = (result.promptTokens || 0) + (result.completionTokens || 0);
    let weightedTokens = 0;
    let pointsCost = 0;
    if (totalTokens > 0) {
      const calculated = calculateCost(modelConfig, result);
      weightedTokens = calculated.weightedTokens;
      pointsCost = calculated.pointsCost;
    }

    if (pointsCost > 0 || totalTokens > 0) {
      try {
        // billing:calculate 钩子可调整单次扣费（倍率/固定额/重写）
        const pointsToDeduct = await adjustBillingCost(weightedTokens, pointsCost, {
          userId: req.apiUser.userId,
          groupId: req.apiUser.groupId,
          model: modelConfig.id || userRequestedModel,
          provider: provider?.id || null,
          requestType: 'chat',
        });
        // stats:record 钩子可附加统计维度（写入 usage_records.plugin_meta）
        const pluginMeta = await buildUsagePluginMeta({
          userId: req.apiUser.userId,
          model: modelConfig.id || userRequestedModel,
          provider: provider?.id || null,
          requestType: 'chat',
          apiKeyId: req.apiUser.keyId,
        }, req.body.messages ?? req.body.input, req.body.system ?? req.body.instructions, req);

        const localModelId = modelConfig.id || userRequestedModel;
        const latencyMs = Date.now() - liveCallStart;
        const usageResult = await recordUsageAndDeduct({ pool, usageQuery: `INSERT INTO usage_records (user_id, model_id, api_key_id, tokens_used, prompt_tokens, completion_tokens,
           cached_tokens, weighted_tokens, provider_id, request_type, messages, response, cost, latency_ms, ip_address, request_source, user_agent, plugin_meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`, usageValues: [req.apiUser.userId, localModelId, req.apiUser.keyId, totalTokens,
           result.promptTokens || 0, result.completionTokens || 0,
           result.cachedTokens || 0, weightedTokens,
           provider?.id || null, 'chat', JSON.stringify(messages), result.content || null, pointsToDeduct,
           latencyMs, clientIp(req), clientMetaFromReq(req).requestSource, clientMetaFromReq(req).userAgent,
           pluginMeta], userId: req.apiUser.userId, pointsToDeduct });
        if (!usageResult.ok) throw new Error(usageResult.error || '用量记录与扣款失败');
        recordQuotaData(req.apiUser.userId, localModelId, totalTokens, weightedTokens, pointsToDeduct);
      } catch (err) {
        Logger.error('[用量记录] 错误:', err);
        if (err.billingFailure) {
          if (!res.headersSent) return res.status(500).json({ error: { message: 'Billing failed; request was not charged.', type: 'server_error' } });
          res.destroy(err);
          return;
        }
      }
    }
    return;
  }

  if (lastError && !res.headersSent) {
    return res.status(lastError.status || 502).json(lastError.body);
  }
}

// Fusion 模型请求处理
async function handleFusionRequest(req, res, format = 'openai') {
  const { messages, temperature, max_tokens, stream, fusion_preset, tools, tool_choice, response_format } = req.body;

  Logger.info(`[Fusion] 收到请求: stream=${!!stream}, messages=${messages?.length}, user=${req.apiUser.username}, format=${format}`);

  const sendFusionError = (status, type, message) => {
    if (format === 'anthropic') {
      return res.status(status).json({ type: 'error', error: { type: type === 'server_error' ? 'api_error' : type, message } });
    }
    return res.status(status).json({ error: { message, type } });
  };

  if (!messages || !Array.isArray(messages)) {
    return sendFusionError(400, 'invalid_request_error', 'Missing required parameters: messages');
  }

  try {
    const startTime = Date.now();
    const result = await processFusion(
      { messages, temperature, max_tokens, fusion_preset, tools, tool_choice, response_format },
      req,
      {
        stream: !!stream,
        res: stream ? res : null,
        format,
        tools,
        tool_choice,
        response_format,
        requestContext: req._upstreamAttemptContext,
        apiKeyFusionConfig: {
          panel_models: req.apiUser.fusionPanelModels || [],
          judge_model_id: req.apiUser.fusionJudgeModelId || '',
          outer_model_id: req.apiUser.fusionOuterModelId || ''
        }
      }
    );

    // 注入提示词回显净化：Fusion 合成输出在组装响应/入库前统一剥离（仅启用注入的请求）
    if (!stream && req.apiUser?.injectPrompt && typeof result.content === 'string') {
      result.content = scrubInjectedEcho(result.content, { exactText: req.apiUser.injectPrompt });
    }

    // 非流式模式：返回完整响应
    if (!stream) {
      if (format === 'anthropic') {
        const response = {
          id: 'msg_fusion_' + Date.now(),
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: result.content || '' }],
          model: 'fusion',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: result.usage?.promptTokens || 0,
            output_tokens: result.usage?.completionTokens || 0
          },
          fusion: result.fusion
        };
        // 对外 usage 用外层合成模型的 token；全链路汇总仅用于内部计费
        res.json(response);
      } else {
        const response = {
          id: 'chatcmpl-fusion-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'fusion',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: result.content
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: result.usage?.promptTokens || 0,
            completion_tokens: result.usage?.completionTokens || 0,
            total_tokens: (result.usage?.promptTokens || 0) + (result.usage?.completionTokens || 0)
          },
          fusion: result.fusion
        };
        res.json(response);
      }
    }

    // 汇总各阶段 prompt / completion token（勿把 total 塞进 prompt_tokens）
    let fusionPromptTokens = 0;
    let fusionCompletionTokens = 0;
    const accumulateUsage = (usage) => {
      if (!usage) return;
      fusionPromptTokens += usage.promptTokens || 0;
      fusionCompletionTokens += usage.completionTokens || 0;
    };
    if (result.panelResults) {
      for (const panel of result.panelResults) {
        if (panel.success) accumulateUsage(panel.usage);
      }
    }
    accumulateUsage(result.judgeResult?.usage);
    accumulateUsage(result.usage);
    const totalTokens = result.totalTokens
      || (fusionPromptTokens + fusionCompletionTokens);

    // 计算 Fusion 总成本（加权 token 口径）
    let totalWeightedTokens = 0;
    if (result.panelResults) {
      for (const panel of result.panelResults) {
        if (panel.success && panel.usage) {
          const modelConfig = await getModelConfig(panel.model_id);
          if (modelConfig) {
            const { calculateCost } = require('../utils/billing');
            const panelCalc = calculateCost(modelConfig, panel.usage);
            totalWeightedTokens += panelCalc.weightedTokens;
          }
        }
      }
    }

    // Judge 模型成本
    if (result.judgeResult?.usage && result.judgeResult?.model_id) {
      const judgeModelConfig = await getModelConfig(result.judgeResult.model_id);
      if (judgeModelConfig) {
        const { calculateCost } = require('../utils/billing');
        const judgeCalc = calculateCost(judgeModelConfig, result.judgeResult.usage);
        totalWeightedTokens += judgeCalc.weightedTokens;
      }
    }

    // 外层模型成本
    if (result.usage && (result.usage.promptTokens || result.usage.completionTokens) && result.model_id) {
      const outerModelConfig = await getModelConfig(result.model_id);
      if (outerModelConfig) {
        const { calculateCost } = require('../utils/billing');
        const outerCalc = calculateCost(outerModelConfig, result.usage);
        totalWeightedTokens += outerCalc.weightedTokens;
      }
    }

    const fusionPointsCost = totalWeightedTokens / 1000000;

    if (fusionPointsCost > 0 || totalTokens > 0) {
      try {
        const pointsToDeduct = await adjustBillingCost(totalWeightedTokens, fusionPointsCost, {
          userId: req.apiUser.userId,
          groupId: req.apiUser.groupId,
          model: 'fusion',
          provider: null,
          requestType: 'fusion',
        });
        const pluginMeta = await buildUsagePluginMeta({
          userId: req.apiUser.userId,
          model: 'fusion',
          provider: null,
          requestType: 'fusion',
          apiKeyId: req.apiUser.keyId,
        }, req.body.messages ?? req.body.input, req.body.system ?? req.body.instructions, req);

        const usageResult = await recordUsageAndDeduct({ pool, usageQuery: `INSERT INTO usage_records (user_id, api_key_id, tokens_used, prompt_tokens, completion_tokens,
           weighted_tokens, provider_id, request_type, messages, response, cost, latency_ms, ip_address, request_source, user_agent, plugin_meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`, usageValues: [req.apiUser.userId, req.apiUser.keyId, totalTokens,
           fusionPromptTokens, fusionCompletionTokens,
           totalWeightedTokens, null, 'fusion',
           JSON.stringify(messages), result.content || null, pointsToDeduct,
           Date.now() - startTime, clientIp(req), clientMetaFromReq(req).requestSource, clientMetaFromReq(req).userAgent,
           pluginMeta], userId: req.apiUser.userId, pointsToDeduct });
        if (!usageResult.ok) throw new Error(usageResult.error || '用量记录与扣款失败');

        // 记录 Fusion 专用用量
        await pool.query(
          `INSERT INTO fusion_usage_records (user_id, api_key_id, config_id, panel_results, judge_result,
           final_content, total_tokens, total_cost, latency_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [req.apiUser.userId, req.apiUser.keyId, null,
           JSON.stringify(result.panelResults || []),
           JSON.stringify(result.judgeResult || {}),
           result.content || null, totalTokens, pointsToDeduct, result.fusion?.total_latency || 0]
        );
        recordQuotaData(req.apiUser.userId, 'fusion', totalTokens, totalWeightedTokens, pointsToDeduct);
      } catch (err) {
        Logger.error('[Fusion] 用量记录错误:', err);
        if (err.billingFailure) {
          if (!res.headersSent) return sendFusionError(500, 'server_error', 'Billing failed; request was not charged.');
          res.destroy(err);
          return;
        }
      }
    }

    Logger.info(`[Fusion] 完成: latency=${Date.now() - startTime}ms, tokens=${totalTokens}, weightedTokens=${totalWeightedTokens}`);
  } catch (error) {
    Logger.error(`[Fusion] 处理失败: ${error.message}, stack=${error.stack}`);
    captureCallError(req, {
      modelId: 'fusion', requestType: 'fusion',
      status: 500, error, isFinal: true
    });
    if (!res.headersSent) {
      if (format === 'anthropic') {
        res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Fusion processing failed: ' + error.message } });
      } else {
        res.status(500).json({ error: { message: 'Fusion processing failed: ' + error.message, type: 'server_error' } });
      }
    }
  }
}

// OpenAI 兼容: /v1/models (CrewRouter: 返回配置的模型列表 + fusion 固定)
router.get('/models', oauthBearer, async (req, res) => {
  try {
    // 读取系统设置中配置的模型列表
    const settingsResult = await pool.query("SELECT value FROM settings WHERE key = 'model_list'");
    let configuredModels = [];
    if (settingsResult.rows.length > 0) {
      try {
        configuredModels = settingsResult.rows[0].value;
      } catch {
        configuredModels = [];
      }
    }

    // 默认模型列表
    const defaultModels = ['claude-fable-5', 'crew-router'];

    // 校验：如果配置了模型但除了 fusion 之外没有其他模型，使用默认值
    const nonFusionModels = (configuredModels || []).filter(m => m !== 'fusion');
    if (configuredModels.length > 0 && nonFusionModels.length === 0) {
      configuredModels = [...defaultModels];
    }

    // fusion 固定作为第一个返回
    const modelSet = new Set(['fusion']);
    const models = [
      {
        id: 'fusion',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'crewrouter',
        description: 'Fusion 多模型审议系统 - 并行调用多个模型，由 Judge 分析后生成高质量回答'
      }
    ];

    const modelsToAdd = configuredModels.length > 0 ? configuredModels : defaultModels;
    for (const m of modelsToAdd) {
      if (m !== 'fusion' && !modelSet.has(m)) {
        modelSet.add(m);
        models.push({
          id: m,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'crewrouter'
        });
      }
    }

    // 插件 models:list 钩子：过滤/追加模型列表
    let finalModels = models;
    if (pluginHooks.hasSubscribers('models:list')) {
      const out = await pluginHooks.apply('models:list', { models }, { requestType: 'models' });
      if (Array.isArray(out?.models)) finalModels = out.models;
    }

    res.json({ object: 'list', data: finalModels });
  } catch (error) {
    Logger.error('[获取模型列表] 错误:', error);
    res.status(500).json({ error: { message: 'Internal server error', type: 'server_error' } });
  }
});

// Anthropic 兼容: /v1/messages 和 /api/messages
router.post('/messages', oauthBearer, handleAnthropicMessage);

async function handleAnthropicMessage(req, res) {
  req._upstreamAttemptContext = { upstreamAttempts: 0 };
  const { tryHandleCrewRouterCommand } = require('../utils/crewrouter-command');
  if (await tryHandleCrewRouterCommand(req, res)) return;

  // 插件 gateway:requestReceived 钩子：可改写请求体或短路直接响应
  if (pluginHooks.hasSubscribers('gateway:requestReceived')) {
    const out = await pluginHooks.apply('gateway:requestReceived', { body: req.body }, { model: req.body?.model || null, requestType: 'anthropic' });
    if (out?.shortCircuit) return res.status(out.status || 200).json(out.body ?? {});
    if (out?.body !== undefined) req.body = out.body;
  }

  // 吞图：在转发前剥离客户端图片并注入提示（默认禁用）
  applySwallowImagesIfEnabled(req);

  let { model, messages, system, max_tokens, stream, temperature, top_p, top_k, stop_sequences, tools, tool_choice, response_format, thinking, metadata, output_config, service_tier, cache_control, container, inference_geo } = req.body;

  // 注入提示词：插入 Anthropic messages 首条 user 前；无配置时请求保持原样
  if (req.apiUser.injectPrompt) {
    messages = anthropicMessageAppend([...(messages || [])], req.apiUser.injectPrompt);
    req.body.messages = messages;
  }

  Logger.info(`[Anthropic] 收到请求: model=${model}, stream=${!!stream}, messages=${messages?.length}`);

  // 检测 Fusion 模型请求
  if ((model === 'fusion' || model?.startsWith('fusion')) && req.apiUser.fusionEnabled) {
    // 将 Anthropic 格式的 messages 转换为 OpenAI 格式（如果需要）
    // 注意：吞图已剥离 image 块；此处文本化时忽略非 text 块
    const fusionMessages = [];
    if (system) {
      fusionMessages.push({ role: 'system', content: typeof system === 'string' ? system : system.map(b => b.text || '').join('') });
    }
    for (const m of (messages || [])) {
      fusionMessages.push({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(b => b.text || '').join('') : '')
      });
    }

    // 重新构造请求体给 Fusion 处理器（保留工具调用相关字段）
    req.body = {
      model: 'fusion',
      messages: fusionMessages,
      temperature,
      max_tokens,
      stream
    };
    if (tools !== undefined) req.body.tools = tools;
    if (tool_choice !== undefined) req.body.tool_choice = tool_choice;
    if (response_format !== undefined) req.body.response_format = response_format;
    if (metadata !== undefined) req.body.metadata = metadata;

    return await handleFusionRequest(req, res, 'anthropic');
  }

  // CrewRouter: 使用 API Key 绑定的有序模型队列；harness 单独绑定优先
  const resolved = resolveModelQueueForRequest(req.apiUser, req);
  const modelQueue = resolved.queue;
  if (!modelQueue.length) {
    return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'No model selected. Please select a model from the model library first.' } });
  }

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'Missing required parameters: messages' } });
  }

  if (!max_tokens && max_tokens !== 0) {
    return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'Missing required parameter: max_tokens' } });
  }

  Logger.info(
    `[Anthropic] 收到请求: queue=[${modelQueue.join(',')}], stream=${!!stream}, messages=${messages?.length}` +
    `, source=${resolved.requestSource}` +
    (resolved.harnessOverride ? ', harness_override=1' : ', harness_override=0')
  );

  let lastError = null;
  const anthropicBody = { messages, system, max_tokens, temperature, top_p, top_k, stop_sequences, tools, tool_choice, thinking, metadata, output_config, service_tier, cache_control, container, inference_geo };

  for (let i = 0; i < modelQueue.length; i++) {
    const queueModelId = modelQueue[i];
    const hasMore = i < modelQueue.length - 1;
    const suppressErrorResponse = hasMore;

    const modelConfig = await getModelConfig(queueModelId);
    if (!modelConfig) {
      Logger.warn(`[Anthropic] 队列模型未找到 attempt=${i + 1}/${modelQueue.length}: ${queueModelId}`);
      lastError = {
        status: 404,
        body: { type: 'error', error: { type: 'not_found_error', message: `Model '${queueModelId}' not found` } },
        retryable: false
      };
      if (hasMore && lastError.retryable) continue;
      return res.status(404).json(lastError.body);
    }

    model = modelConfig.upstream_model_id || modelConfig.id;

    // TestModel 特殊处理
    if (modelConfig.id === 'test-model' || model === 'test-model') {
      Logger.info(`[Anthropic] TestModel: 直接返回固定文本, stream=${!!stream}`);

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const responseId = `msg_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const writeAnthropicEvent = (obj) => {
          res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
        };

        writeAnthropicEvent({
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

        writeAnthropicEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        });

        const chunkSize = 5;
        const delayMs = 30;
        let index = 0;

        const sendChunk = () => {
          if (index >= TEST_MODEL_TEXT.length) {
            writeAnthropicEvent({ type: 'content_block_stop', index: 0 });
            writeAnthropicEvent({
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 0 }
            });
            writeAnthropicEvent({ type: 'message_stop' });
            res.end();
            return;
          }

          const chunk = TEST_MODEL_TEXT.slice(index, index + chunkSize);
          index += chunkSize;

          writeAnthropicEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: chunk }
          });

          setTimeout(sendChunk, delayMs);
        };

        sendChunk();
      } else {
        res.json({
          id: `msg_test_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: TEST_MODEL_TEXT }],
          model: model,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        });
      }
      return;
    }

    const modelRpm = modelConfig.rate_limit_rpm || 0;
    const modelTpm = modelConfig.rate_limit_tpm || 0;
    const userRpm = req.apiUser.userRateLimitRpm || 0;
    const userTpm = req.apiUser.userRateLimitTpm || 0;

    const effectiveRpm = (modelRpm > 0 && userRpm > 0) ? Math.min(modelRpm, userRpm) : (modelRpm || userRpm);
    const effectiveTpm = (modelTpm > 0 && userTpm > 0) ? Math.min(modelTpm, userTpm) : (modelTpm || userTpm);

    if (effectiveRpm > 0 || effectiveTpm > 0) {
      const estimatedTokens = (messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0) / 4) || 500;
      const rpmKey = `rpm:${req.apiUser.userId}:${model}`;
      const rpmCheck = checkRateLimit(rpmKey, effectiveRpm, 0, 0);
      if (rpmCheck.limited) {
        Logger.warn(`[Anthropic] 速率限制 attempt=${i + 1}/${modelQueue.length}: ${rpmCheck.reason}, model=${model}`);
        lastError = { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: rpmCheck.reason } }, retryable: false };
        if (hasMore && lastError.retryable) continue;
        return res.status(429).json(lastError.body);
      }
      const tpmKey = `tpm:${req.apiUser.userId}:${model}`;
      const tpmCheck = checkRateLimit(tpmKey, 0, effectiveTpm, Math.ceil(estimatedTokens));
      if (tpmCheck.limited) {
        Logger.warn(`[Anthropic] 速率限制 attempt=${i + 1}/${modelQueue.length}: ${tpmCheck.reason}, model=${model}`);
        lastError = { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: tpmCheck.reason } }, retryable: false };
        if (hasMore && lastError.retryable) continue;
        return res.status(429).json(lastError.body);
      }
    }

    const provider = await getProviderForRequest(modelConfig.provider);
    if (!provider) {
      Logger.warn(`[Anthropic] 供应商未配置 attempt=${i + 1}/${modelQueue.length}: ${modelConfig.provider}`);
      lastError = { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'Provider not configured' } }, retryable: true };
      if (hasMore && lastError.retryable) continue;
      return res.status(500).json(lastError.body);
    }

    let result;
    let providerWithKey = provider;

    req.apiUser._inputPrice = modelConfig.input_price_per_1k_tokens || 0;
    req.apiUser._outputPrice = modelConfig.output_price_per_1k_tokens || 0;

    const liveCallStart = Date.now();
    try {
      Logger.info(`[Anthropic] 转发到上游 attempt=${i + 1}/${modelQueue.length}: provider=${provider.id}(${provider.name}), format=${provider.format}, url=${cleanBaseUrl(provider.base_url)}, model=${model}, keys=${normalizeProviderKeyEntries(provider).length || 1}`);
      result = await runWithProviderKeyFallback(provider, res, suppressErrorResponse, async (pwk, keyOpts) => {
        providerWithKey = pwk;
        const proxyOpts = { suppressErrorResponse: keyOpts.suppressErrorResponse };
        if (provider.format === 'anthropic') {
          return proxyAnthropicToAnthropic(pwk, model, anthropicBody, !!stream, res, req, proxyOpts);
        }
        return proxyOpenAIToAnthropic(pwk, model, anthropicBody, !!stream, res, req, proxyOpts);
      });
    } catch (error) {
      Logger.error(`[Anthropic] 上游代理错误 attempt=${i + 1}/${modelQueue.length}: provider=${provider.id}(${provider.name}), model=${model}, error=${error.message}`);
      recordModelCall(modelConfig.id || model, false);
      recordLiveCallTest(modelConfig.id || model, { ok: false, latency_ms: Date.now() - liveCallStart, error: error.message });
      lastError = buildUpstreamExceptionError(error, 'anthropic');
      const willRetry = hasMore && !res.headersSent;
      captureCallError(req, {
        modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'anthropic',
        status: lastError.status, error, latencyMs: Date.now() - liveCallStart, isFinal: !willRetry
      });
      if (res.headersSent) return;
      if (hasMore) {
        Logger.warn(`[Anthropic] 队列回退 attempt=${i + 1}/${modelQueue.length} model=${queueModelId} reason=exception`);
        continue;
      }
      return res.status(lastError.status).json(lastError.body);
    }

    if (isProxyErrorResult(result)) {
      recordModelCall(modelConfig.id || model, false);
      recordLiveCallTest(modelConfig.id || model, { ok: false, latency_ms: Date.now() - liveCallStart, error: `HTTP ${result.status}` });
      lastError = { status: result.status, body: result.body, retryable: result.retryable };
      const willRetry = hasMore && result.retryable && !res.headersSent;
      captureCallError(req, {
        modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'anthropic',
        status: result.status, body: result.body, latencyMs: Date.now() - liveCallStart, isFinal: !willRetry
      });
      if (res.headersSent) return;
      if (hasMore && result.retryable) {
        Logger.warn(`[Anthropic] 队列回退 attempt=${i + 1}/${modelQueue.length} model=${queueModelId} status=${result.status}`);
        continue;
      }
      return res.status(result.status || 502).json(result.body);
    }

    if (!result) {
      recordModelCall(modelConfig.id || model, false);
      recordLiveCallTest(modelConfig.id || model, { ok: false, latency_ms: Date.now() - liveCallStart, error: 'upstream_error' });
      captureCallError(req, {
        modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'anthropic',
        status: 502, body: { type: 'error', error: { type: 'api_error', message: 'upstream_error' } },
        latencyMs: Date.now() - liveCallStart, isFinal: true
      });
      return;
    }

    recordModelCall(modelConfig.id || model, true);
    recordLiveCallTest(modelConfig.id || model, {
      ok: true,
      latency_ms: Date.now() - liveCallStart,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens
    });

    const totalTokens = (result.promptTokens || 0) + (result.completionTokens || 0);
    let weightedTokens = 0;
    let pointsCost = 0;
    if (totalTokens > 0) {
      const calculated = calculateCost(modelConfig, result);
      weightedTokens = calculated.weightedTokens;
      pointsCost = calculated.pointsCost;
    }

    if (pointsCost > 0 || totalTokens > 0) {
      try {
        const pointsToDeduct = await adjustBillingCost(weightedTokens, pointsCost, {
          userId: req.apiUser.userId,
          groupId: req.apiUser.groupId,
          model: modelConfig.id || queueModelId,
          provider: provider?.id || null,
          requestType: 'chat',
        });
        const pluginMeta = await buildUsagePluginMeta({
          userId: req.apiUser.userId,
          model: modelConfig.id || queueModelId,
          provider: provider?.id || null,
          requestType: 'chat',
          apiKeyId: req.apiUser.keyId,
        }, req.body.messages ?? req.body.input, req.body.system ?? req.body.instructions, req);

        const localModelId = modelConfig.id || queueModelId;
        const latencyMs = Date.now() - liveCallStart;
        const usageResult = await recordUsageAndDeduct({ pool, usageQuery: `INSERT INTO usage_records (user_id, model_id, api_key_id, tokens_used, prompt_tokens, completion_tokens,
           cached_tokens, weighted_tokens, provider_id, request_type, messages, response, cost, latency_ms, ip_address, request_source, user_agent, plugin_meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`, usageValues: [req.apiUser.userId, localModelId, req.apiUser.keyId, totalTokens,
           result.promptTokens || 0, result.completionTokens || 0,
           result.cachedTokens || 0, weightedTokens,
           provider?.id || null, 'chat', JSON.stringify(messages), result.content || null, pointsToDeduct,
           latencyMs, clientIp(req), clientMetaFromReq(req).requestSource, clientMetaFromReq(req).userAgent,
           pluginMeta], userId: req.apiUser.userId, pointsToDeduct });
        if (!usageResult.ok) throw new Error(usageResult.error || '用量记录与扣款失败');
        recordQuotaData(req.apiUser.userId, localModelId, totalTokens, weightedTokens, pointsToDeduct);
      } catch (err) {
        Logger.error('[Anthropic 用量记录] 错误:', err);
        if (err.billingFailure) {
          if (!res.headersSent) return res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Billing failed; request was not charged.' } });
          res.destroy(err);
          return;
        }
      }
    }
    return;
  }

  if (lastError && !res.headersSent) {
    return res.status(lastError.status || 502).json(lastError.body);
  }
}

// 将 Anthropic 格式请求转换为 OpenAI 格式
function convertAnthropicToOpenAI(body) {
  const systemMessage = body.system;
  const messages = [];

  if (systemMessage) {
    const sysContent = typeof systemMessage === 'string' ? systemMessage :
      Array.isArray(systemMessage) ? systemMessage.map(b => b.text || '').join('\n') : '';
    messages.push({ role: 'system', content: sysContent });
  }

  for (const msg of body.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter(b => b.type === 'text').map(b => b.text);
      const toolUseParts = msg.content.filter(b => b.type === 'tool_use');
      const toolResultParts = msg.content.filter(b => b.type === 'tool_result');
      const imageParts = msg.content.filter(b => b.type === 'image');

      if (toolUseParts.length > 0 && msg.role === 'assistant') {
        // Assistant 消息中的 tool_use 块 → OpenAI tool_calls
        const text = textParts.join('\n');
        const toolCalls = toolUseParts.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input || {})
          }
        }));
        const openaiMsg = { role: 'assistant', content: text || null };
        if (toolCalls.length > 0) {
          openaiMsg.tool_calls = toolCalls;
          // 保留文本（若有），否则 content 为 null
          openaiMsg.content = text || null;
        }
        // thinking 块 → reasoning_content
        const thinkingParts = msg.content.filter(b => b.type === 'thinking');
        if (thinkingParts.length > 0) {
          openaiMsg.reasoning_content = thinkingParts.map(t => t.thinking || '').join('');
        }
        messages.push(openaiMsg);
      } else if (toolResultParts.length > 0) {
        // tool_result 块 → OpenAI role: 'tool' 消息
        for (const tr of toolResultParts) {
          const trContent = typeof tr.content === 'string' ? tr.content
            : Array.isArray(tr.content) ? tr.content.map(c => typeof c === 'string' ? c : (c.text || '')).join('\n')
            : String(tr.content || '');
          messages.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: trContent
          });
        }
      } else if (imageParts.length > 0) {
        // 包含图片 → 构建 OpenAI 多模态 content 数组
        const content = [];
        for (const part of msg.content) {
          if (part.type === 'text') {
            content.push({ type: 'text', text: part.text });
          } else if (part.type === 'image') {
            if (part.source?.type === 'base64') {
              content.push({
                type: 'image_url',
                image_url: { url: `data:${part.source.media_type || 'image/jpeg'};base64,${part.source.data}` }
              });
            } else if (part.source?.type === 'url') {
              content.push({ type: 'image_url', image_url: { url: part.source.url } });
            }
          }
        }
        messages.push({ role: msg.role, content });
      } else {
        // 纯文本消息
        messages.push({ role: msg.role, content: textParts.join('\n') });
      }
    }
  }

  const openaiBody = { messages, model: body.model };
  if (body.max_tokens !== undefined) openaiBody.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) openaiBody.temperature = body.temperature;
  if (body.top_p !== undefined) openaiBody.top_p = body.top_p;
  if (body.stop_sequences) openaiBody.stop = body.stop_sequences;
  if (body.stream !== undefined) openaiBody.stream = body.stream;
  if (body.tools) {
    openaiBody.tools = body.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }
    }));
  }
  if (body.tool_choice) {
    if (body.tool_choice.type === 'auto') openaiBody.tool_choice = 'auto';
    else if (body.tool_choice.type === 'any') openaiBody.tool_choice = 'required';
    else if (body.tool_choice.type === 'tool') openaiBody.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    else if (body.tool_choice.type === 'none') openaiBody.tool_choice = 'none';
  }

  return openaiBody;
}

// 将 OpenAI 格式响应转换为 Anthropic 格式
function convertOpenAIToAnthropicResponse(openaiResp, model) {
  const choice = openaiResp.choices?.[0];
  const message = choice?.message;

  const content = [];
  if (message?.content) {
    content.push({ type: 'text', text: message.content });
  }
  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: safeParseJson(tc.function.arguments, {})
      });
    }
  }
  // 映射 reasoning_content → thinking block（无 signature，仅尽力兼容）
  if (message?.reasoning_content) {
    content.unshift({ type: 'thinking', thinking: message.reasoning_content });
  }

  let stopReason = 'end_turn';
  if (choice?.finish_reason === 'stop') stopReason = 'end_turn';
  else if (choice?.finish_reason === 'length') stopReason = 'max_tokens';
  else if (choice?.finish_reason === 'tool_calls') stopReason = 'tool_use';

  return {
    id: openaiResp.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0
    }
  };
}

// Anthropic -> Anthropic 直接代理
async function proxyAnthropicToAnthropic(provider, model, body, stream, res, req, options = {}) {
  const suppressErrorResponse = !!options.suppressErrorResponse;
  const baseUrl = cleanBaseUrl(provider.base_url);
  const url = upstreamUrl(baseUrl, '/messages');
  const headers = buildUpstreamHeaders(provider, req, {
    'Content-Type': 'application/json',
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01'
  });
  if (provider.api_key) {
    headers['x-api-key'] = provider.api_key;
  }
  if (req.headers['anthropic-beta']) {
    headers['anthropic-beta'] = req.headers['anthropic-beta'];
  }

  // 预加载签名注入所需的数据（性能优化：减少重复数据库查询）
  let preloadedSignatureData = {};
  if (req.apiUser.signatureEnabled && req.apiUser.signatureTemplate) {
    preloadedSignatureData = await preloadSignatureData(
      req.apiUser.userId,
      req.apiUser.groupId,
      req.apiUser.signatureTemplate
    );
  }

  const upstreamBody = { model, max_tokens: body.max_tokens, messages: body.messages, stream: !!stream };
  if (body.system) upstreamBody.system = body.system;
  if (body.temperature !== undefined) upstreamBody.temperature = body.temperature;
  if (body.top_p !== undefined) upstreamBody.top_p = body.top_p;
  if (body.top_k !== undefined) upstreamBody.top_k = body.top_k;
  if (body.stop_sequences) upstreamBody.stop_sequences = body.stop_sequences;
  if (body.tools) upstreamBody.tools = body.tools;
  if (body.tool_choice) upstreamBody.tool_choice = body.tool_choice;
  if (body.thinking) upstreamBody.thinking = body.thinking;
  if (body.metadata) upstreamBody.metadata = body.metadata;
  if (body.output_config) upstreamBody.output_config = body.output_config;
  if (body.service_tier) upstreamBody.service_tier = body.service_tier;
  if (body.cache_control) upstreamBody.cache_control = body.cache_control;
  if (body.container) upstreamBody.container = body.container;
  if (body.inference_geo) upstreamBody.inference_geo = body.inference_geo;
  addFourthCacheBreakpoint(upstreamBody, body.system);

  // 代理池支持
  const proxyInfo = await proxyPool.getProxyAgent(provider, affinityKeyForRequest(req, req.body));
  const proxyList = await proxyPool.getProxies(provider);
  const maxRetries = Math.min(MAX_UPSTREAM_ATTEMPTS, Math.max(proxyList.length || 1, 1));
  let currentProxyInfo = proxyInfo;

  const msgCount = body.messages?.length || 0;
  Logger.info(`[proxyAnthropicToAnthropic] 请求: provider=${provider.id}(${provider.name}), url=${url}, model=${model}, stream=${!!stream}, messages=${msgCount}, max_tokens=${body.max_tokens ?? '-'}, temperature=${body.temperature ?? '-'}, proxy=${currentProxyInfo?.proxyUrl || 'none'}`);
  const startTime = Date.now();

  if (stream) {
    const { response, currentProxyInfo: finalProxyInfo } = await fetchWithProxyRetry(
      (proxyInfo) => ({
        url,
        method: 'POST', headers,
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(UPSTREAM_STREAM_TIMEOUT),
        agent: proxyInfo?.agent
      }),
      provider,
      currentProxyInfo,
      maxRetries,
      'proxyAnthropicToAnthropic',
      { model, requestType: 'proxyAnthropicToAnthropic', affinityKey: affinityKeyForRequest(req, req.body) }
    );
    currentProxyInfo = finalProxyInfo;

    if (!response.ok) {
      const errText = await response.text();
      const latency = Date.now() - startTime;
      Logger.error(`[proxyAnthropicToAnthropic] 上游错误: provider=${provider.id}(${provider.name}), status=${response.status}, latency=${latency}ms, body=${errText.substring(0, 500)}`);
      // 标准化错误映射
      let errBody;
      try { errBody = JSON.parse(errText); } catch { errBody = errText; }
      const { toAnthropicError } = require('../utils/error-mapper');
      return respondProxyError(res, response.status, toAnthropicError(errBody, response.status), { suppressErrorResponse });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    Logger.stream(`[proxyAnthropicToAnthropic] SSE 头已发送, 开始流式传输: provider=${provider.id}(${provider.name}), model=${model}, url=${url}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalContent = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let responseId = '';
    let stopReason = null;
    let currentBlockType = null;
    let chunkCount = 0;
    let sseLineCount = 0;
    let jsonParseErrors = 0;
    let firstChunkTime = null;
    let clientDisconnected = false;
    let backpressureCount = 0;
    let gotDone = false;
    const streamScrubber = createStreamScrubber(req.apiUser?.injectPrompt);

    // 检测客户端断开连接
    req.on('close', () => {
      clientDisconnected = true;
      Logger.stream(`[proxyAnthropicToAnthropic] 客户端断开连接: provider=${provider.id}, model=${model}, 已接收 ${chunkCount} 个chunk, ${sseLineCount} 行SSE`);
    });

    // 背压处理
    const writeWithDrain = (data) => {
      if (clientDisconnected) return false;
      const ok = res.write(data);
      if (!ok) {
        backpressureCount++;
        if (backpressureCount <= 3 || backpressureCount % 10 === 0) {
          Logger.warn(`[proxyAnthropicToAnthropic] 背压等待drain: provider=${provider.id}, model=${model}, 累计=${backpressureCount}次`);
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
          Logger.stream(`[proxyAnthropicToAnthropic] 客户端已断开, 停止读取上游: provider=${provider.id}, model=${model}`);
          break;
        }

        if (!firstChunkTime) {
          firstChunkTime = Date.now();
          Logger.stream(`[proxyAnthropicToAnthropic] 收到首个上游chunk: 等待耗时=${firstChunkTime - startTime}ms, chunk大小=${value.length}bytes`);
        }
        chunkCount++;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          // Forward event: lines (Anthropic SSE protocol includes event: before data:)
          if (line.startsWith('event: ')) {
            const eventName = line.slice(7).trim();
            // Don't forward event: message_stop yet; inject signature first, then send both event: and data: together.
            if (eventName === 'message_stop') {
              continue;
            }
            const ok = writeWithDrain(line + '\n');
            if (!ok) await waitForDrain();
            continue;
          }
          if (line.startsWith('data: ')) {
            sseLineCount++;
            const data = line.slice(6).trim();
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'message_start') {
                responseId = parsed.message?.id || '';
                promptTokens = parsed.message?.usage?.input_tokens || 0;
                cachedTokens = parsed.message?.usage?.cache_read_input_tokens || 0;
              } else if (parsed.type === 'content_block_start') {
                currentBlockType = parsed.content_block?.type || null;
              } else if (parsed.type === 'content_block_delta') {
                if (currentBlockType === 'text') {
                  const scrubbedText = streamScrubber.feed(parsed.delta?.text || '');
                  parsed.delta.text = scrubbedText;
                  totalContent += scrubbedText;
                } else if (currentBlockType === 'thinking') {
                  // Thinking content tracked but not added to totalContent
                }
              } else if (parsed.type === 'content_block_stop') {
                currentBlockType = null;
              } else if (parsed.type === 'message_delta') {
                completionTokens = parsed.usage?.output_tokens || 0;
                stopReason = parsed.delta?.stop_reason;
              } else if (parsed.type === 'message_stop') {
                Logger.stream(`[proxyAnthropicToAnthropic] 收到上游 message_stop 事件`);
                gotDone = true;
                // Don't forward message_stop yet; inject signature first below.
                continue;
              }
              // 插件 gateway:responseChunk 钩子：改写/丢弃直通帧
              let frameOut = JSON.stringify(parsed);
              if (pluginHooks.hasSubscribers('gateway:responseChunk')) {
                const out = await pluginHooks.maybeRewriteChunk(data, { model, requestType: 'proxyAnthropicToAnthropic', affinityKey: affinityKeyForRequest(req, req.body) });
                if (!out) continue;
                frameOut = out;
              }
              const ok = writeWithDrain(`data: ${frameOut}\n\n`);
              if (!ok) await waitForDrain();
            } catch (e) {
              jsonParseErrors++;
              Logger.warn(`[proxyAnthropicToAnthropic] JSON解析失败: data=${data.substring(0, 200)}, error=${e.message}`);
            }
          }
        }
      }

      // Process any residual data left in the buffer
      if (buffer.trim() && !clientDisconnected) {
        Logger.stream(`[proxyAnthropicToAnthropic] 处理残余缓冲区: ${buffer.length} bytes`);
        const lines = buffer.split('\n');
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            const eventName = line.slice(7).trim();
            if (eventName === 'message_stop') {
              gotDone = true;
              continue;
            }
            res.write(line + '\n');
          } else if (line.startsWith('data: ')) {
            sseLineCount++;
            const data = line.slice(6).trim();
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'message_delta') {
                completionTokens = parsed.usage?.output_tokens || 0;
                stopReason = parsed.delta?.stop_reason;
              } else if (parsed.type === 'message_stop') {
                gotDone = true;
                continue;
              }
              // 插件 gateway:responseChunk 钩子（残余缓冲区路径）
              let frameOut2 = JSON.stringify(parsed);
              if (pluginHooks.hasSubscribers('gateway:responseChunk')) {
                const out = await pluginHooks.maybeRewriteChunk(data, { model, requestType: 'proxyAnthropicToAnthropic', affinityKey: affinityKeyForRequest(req, req.body) });
                if (!out) continue;
                frameOut2 = out;
              }
              res.write(`data: ${frameOut2}\n\n`);
            } catch (e) {
              jsonParseErrors++;
              Logger.warn(`[proxyAnthropicToAnthropic] 残余缓冲区JSON解析失败: data=${data.substring(0, 200)}, error=${e.message}`);
            }
          }
        }
      }
      const residualScrubbed = streamScrubber.flush();
      if (residualScrubbed && !clientDisconnected) {
        const residualEvent = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: residualScrubbed } };
        const ok = writeWithDrain(`data: ${JSON.stringify(residualEvent)}\n\n`);
        if (!ok) await waitForDrain();
        totalContent += residualScrubbed;
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        Logger.error(`[proxyAnthropicToAnthropic] 流式超时 (${UPSTREAM_STREAM_TIMEOUT}ms): url=${url}, model=${model}, 已接收 ${chunkCount} chunks`);
      } else if (clientDisconnected) {
        Logger.warn(`[proxyAnthropicToAnthropic] 上游读取中断(客户端已断开): url=${url}, model=${model}, error=${err.message}`);
      } else {
        Logger.error(`[proxyAnthropicToAnthropic] 流式读取错误: ${err.message}, chunkCount=${chunkCount}`);
      }
    }

    const latency = Date.now() - startTime;

    // 流式签名：有正文时追加到现有 text 流语义；纯 tool 则跳过（避免 index 999 空块）
    if (gotDone && !clientDisconnected) {
      try {
        const signature = await buildSignatureForRequest(req, {
          model,
          normalized: { promptTokens, completionTokens, cachedTokens },
          providerName: provider.name,
          provider,
          preloaded: preloadedSignatureData
        });
        if (signature) {
          const mode = resolveSignatureMode(req);
          const plan = planStreamSignatureInjection({
            mode,
            requestBody: body,
            hasTextContent: totalContent.length > 0,
            hasToolCalls: false, // 流式 A2A 未细粒度跟踪 tool，有正文才 append
            stopReason,
            format: 'anthropic'
          });
          // 若 stop_reason 为 tool_use 且无正文，强制跳过
          const append = plan.appendContent && totalContent.length > 0 && stopReason !== 'tool_use';
          Logger.info(`[proxyAnthropicToAnthropic] 流式签名: append=${append}, reason=${plan.reason}, stop=${stopReason}, mode=${mode}`);
          if (append) {
            // 上游 text block 通常已 stop，另开 index=1 文本块注入签名（仅有正文时）
            const blockIndex = 1;
            const safeEvents = [
              { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: `\n\n${signature}` } },
              { type: 'content_block_stop', index: blockIndex }
            ];
            for (const evt of safeEvents) {
              const ok = writeWithDrain(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
              if (!ok) await waitForDrain();
            }
          }
        }
      } catch (e) {
        Logger.warn(`[proxyAnthropicToAnthropic] 签名生成失败: ${e.message}`);
      }
      // Forward the intercepted message_stop event with proper event: line
      writeWithDrain(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    }

    res.end();
    if (currentProxyInfo?.proxyId) {
      proxyPool.markProxySuccess(provider.id, currentProxyInfo.proxyId, Date.now() - startTime);
    }
    Logger.stream(`[proxyAnthropicToAnthropic] 流式传输统计: chunkCount=${chunkCount}, sseLineCount=${sseLineCount}, jsonParseErrors=${jsonParseErrors}, contentLength=${totalContent.length}, 首chunk耗时=${firstChunkTime ? firstChunkTime - startTime : '-'}ms, 客户端断开=${clientDisconnected}, 背压次数=${backpressureCount}`);
    const cacheHitRate = promptTokens > 0 ? (cachedTokens / promptTokens * 100).toFixed(1) : 0;
    Logger.info(`[proxyAnthropicToAnthropic] 流式完成: provider=${provider.id}(${provider.name}), model=${model}, latency=${latency}ms, prompt_tokens=${promptTokens}, completion_tokens=${completionTokens}, cached_tokens=${cachedTokens}, cache_hit_rate=${cacheHitRate}%`);
    return { promptTokens, completionTokens, cachedTokens, content: totalContent };
  } else {
    const { response, currentProxyInfo: finalProxyInfo } = await fetchWithProxyRetry(
      (proxyInfo) => ({
        url,
        method: 'POST', headers,
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
        agent: proxyInfo?.agent
      }),
      provider,
      currentProxyInfo,
      maxRetries,
      'proxyAnthropicToAnthropic',
      { model, requestType: 'proxyAnthropicToAnthropic', affinityKey: affinityKeyForRequest(req, req.body) }
    );
    currentProxyInfo = finalProxyInfo;

    const data = await response.json();
    const latency = Date.now() - startTime;
    if (!response.ok) {
      Logger.error(`[proxyAnthropicToAnthropic] 上游错误: provider=${provider.id}(${provider.name}), status=${response.status}, latency=${latency}ms, body=${JSON.stringify(data).substring(0, 500)}`);
      const { toAnthropicError } = require('../utils/error-mapper');
      return respondProxyError(res, response.status, toAnthropicError(data, response.status), { suppressErrorResponse });
    }

    // 插件 gateway:upstreamResponse 钩子：改写上游返回的响应体
    let hookData = data;
    if (pluginHooks.hasSubscribers('gateway:upstreamResponse')) {
      const out = await pluginHooks.apply('gateway:upstreamResponse', { status: response.status, body: data }, {
        provider: { id: provider.id, name: provider.name },
        model,
        requestType: 'proxyAnthropicToAnthropic',
      });
      if (out?.body !== undefined && out.body !== null) hookData = out.body;
    }

    if (currentProxyInfo?.proxyId) {
      proxyPool.markProxySuccess(provider.id, currentProxyInfo.proxyId, latency);
    }

    const normalized = normalizeUsageTokens(hookData.usage, 'anthropic');
    try {
      const signature = await buildSignatureForRequest(req, {
        model, normalized, providerName: provider.name, provider, preloaded: preloadedSignatureData
      });
      if (signature) {
        injectSignatureIntoAnthropicResponse(res, hookData, signature, {
          mode: resolveSignatureMode(req),
          requestBody: body
        });
      }
    } catch (e) {
      Logger.warn(`[proxyAnthropicToAnthropic] 非流式签名生成失败: ${e.message}`);
    }

    // 插件 gateway:finalResponse 钩子：追加自定义响应头
    await pluginHooks.applyFinalResponseHeaders(res, { provider: { id: provider.id }, model, requestType: 'proxyAnthropicToAnthropic' });
    // 注入提示词回显净化：模型复述 system 注入块时，返回前剥离（仅启用注入的请求）
    if (req.apiUser?.injectPrompt) {
      scrubAnthropicResponse(hookData, req.apiUser.injectPrompt);
    }
    res.json(hookData);
    const cacheHitRate = normalized.promptTokens > 0 ? (normalized.cachedTokens / normalized.promptTokens * 100).toFixed(1) : 0;
    Logger.info(`[proxyAnthropicToAnthropic] 非流式完成: provider=${provider.id}(${provider.name}), model=${model}, latency=${latency}ms, prompt_tokens=${normalized.promptTokens || 0}, completion_tokens=${normalized.completionTokens || 0}, cached_tokens=${normalized.cachedTokens || 0}, cache_hit_rate=${cacheHitRate}%`);
    return { ...normalized, content: hookData.content?.map(b => b.text || '').join('') || '' };
  }
}

// OpenAI -> Anthropic 转换代理
async function proxyOpenAIToAnthropic(provider, model, body, stream, res, req, options = {}) {
  const openaiBody = convertAnthropicToOpenAI({ ...body, model });
  const msgCount = body.messages?.length || 0;
  Logger.info(`[proxyOpenAIToAnthropic] 转换请求: provider=${provider.id}(${provider.name}), model=${model}, stream=${!!stream}, messages=${msgCount}, max_tokens=${body.max_tokens ?? '-'}, temperature=${body.temperature ?? '-'}`);

  let openaiResult;
  if (stream) {
    openaiResult = await proxyOpenAIStreamToAnthropic(provider, model, openaiBody, res, req, options);
  } else {
    openaiResult = await proxyOpenAINonStreamToAnthropic(provider, model, openaiBody, res, req, options);
  }
  return openaiResult;
}

// OpenAI 流式响应 -> Anthropic 格式
async function proxyOpenAIStreamToAnthropic(provider, model, openaiBody, res, req, options = {}) {
  const suppressErrorResponse = !!options.suppressErrorResponse;
  const baseUrl = cleanBaseUrl(provider.base_url);
  const url = upstreamUrl(baseUrl, '/chat/completions');
  const headers = buildUpstreamHeaders(provider, req, {
    'Content-Type': 'application/json'
  });
  if (provider.api_key) {
    headers['Authorization'] = `Bearer ${provider.api_key}`;
  }
  const startTime = Date.now();

  // 代理池支持
  const proxyInfo = await proxyPool.getProxyAgent(provider, affinityKeyForRequest(req, req.body));
  const proxyList = await proxyPool.getProxies(provider);
  const maxRetries = Math.min(MAX_UPSTREAM_ATTEMPTS, Math.max(proxyList.length || 1, 1));
  let currentProxyInfo = proxyInfo;

  // 预加载签名注入所需的数据（性能优化：减少重复数据库查询）
  let preloadedSignatureData = {};
  if (req.apiUser.signatureEnabled && req.apiUser.signatureTemplate) {
    preloadedSignatureData = await preloadSignatureData(
      req.apiUser.userId,
      req.apiUser.groupId,
      req.apiUser.signatureTemplate
    );
  }

  const { response, currentProxyInfo: finalProxyInfo } = await fetchWithProxyRetry(
    (proxyInfo) => ({
      url,
      method: 'POST', headers,
      body: JSON.stringify({ ...openaiBody, stream: true, stream_options: { include_usage: true } }),
      signal: AbortSignal.timeout(UPSTREAM_STREAM_TIMEOUT),
      agent: proxyInfo?.agent
    }),
    provider,
    currentProxyInfo,
    maxRetries,
    'proxyOpenAIToAnthropic',
    { model, requestType: 'proxyOpenAIToAnthropic', affinityKey: affinityKeyForRequest(req, req.body) }
  );
  currentProxyInfo = finalProxyInfo;

  if (!response.ok) {
    const err = await response.text();
    const latency = Date.now() - startTime;
    Logger.error(`[proxyOpenAIToAnthropic] 上游错误: provider=${provider.id}(${provider.name}), status=${response.status}, latency=${latency}ms, body=${err.substring(0, 500)}`);
    let errBody;
    try { errBody = JSON.parse(err); } catch { errBody = err; }
    const { toAnthropicError } = require('../utils/error-mapper');
    return respondProxyError(res, response.status, toAnthropicError(errBody, response.status), { suppressErrorResponse });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  Logger.stream(`[proxyOpenAIToAnthropic] SSE 头已发送, 开始流式传输: provider=${provider.id}(${provider.name}), model=${model}, url=${url}`);

  let clientDisconnected = false;
  let backpressureCount = 0;

  // 检测客户端断开连接
  req.on('close', () => {
    clientDisconnected = true;
    Logger.stream(`[proxyOpenAIToAnthropic] 客户端断开连接: provider=${provider.id}, model=${model}`);
  });

  // 背压处理
  const writeWithDrain = (data) => {
    if (clientDisconnected) return false;
    const ok = res.write(data);
    if (!ok) {
      backpressureCount++;
      if (backpressureCount <= 3 || backpressureCount % 10 === 0) {
        Logger.warn(`[proxyOpenAIToAnthropic] 背压等待drain: provider=${provider.id}, model=${model}, 累计=${backpressureCount}次`);
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

  const responseId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const anthropicModel = openaiBody.model || model;

  const messageStart = {
    type: 'message_start',
    message: {
      id: responseId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: anthropicModel,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  };
  const ok0 = writeWithDrain(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);
  if (!ok0) await waitForDrain();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalContent = '';
  let lastUsage = null;
  let textBlockStarted = false;
  let textBlockIndex = null;
  let stopReason = 'end_turn';
  let chunkCount = 0;
  let sseLineCount = 0;
  let jsonParseErrors = 0;
  let firstChunkTime = null;

  // Track tool calls: index → { id, name, arguments }
  const toolCallMap = new Map();
  // Thinking block tracking
  let thinkingBlockIndex = null;
  let nextBlockIndex = 0;

  const emitSSE = async (obj) => {
    // 插件 gateway:responseChunk 钩子：改写输出事件文本（仅文本类 delta）
    if (pluginHooks.hasSubscribers('gateway:responseChunk') && obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta' && obj.delta.text) {
      const out = await pluginHooks.maybeRewriteChunk(obj.delta.text, { model, requestType: 'proxyOpenAIToAnthropic', affinityKey: affinityKeyForRequest(req, req.body) });
      if (out === null) return;
      if (typeof out === 'string' && out !== obj.delta.text) {
        obj = { ...obj, delta: { ...obj.delta, text: out } };
      }
    }
    const data = JSON.stringify(obj);
    const eventType = obj.type;
    const ok = writeWithDrain(`event: ${eventType}\ndata: ${data}\n\n`);
    if (!ok) await waitForDrain();
  };

  const ensureTextBlockStarted = async () => {
    if (!textBlockStarted) {
      textBlockIndex = nextBlockIndex++;
      await emitSSE({ type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } });
      textBlockStarted = true;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientDisconnected) {
        Logger.stream(`[proxyOpenAIToAnthropic] 客户端已断开, 停止读取上游: provider=${provider.id}, model=${model}`);
        break;
      }

      if (!firstChunkTime) {
        firstChunkTime = Date.now();
        Logger.stream(`[proxyOpenAIToAnthropic] 收到首个上游chunk: 等待耗时=${firstChunkTime - startTime}ms, chunk大小=${value.length}bytes`);
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
          Logger.stream(`[proxyOpenAIToAnthropic] 收到上游 [DONE] 事件`);
          break;
        }

        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) {
            lastUsage = parsed.usage;
          }
          const delta = parsed.choices?.[0]?.delta;
          const finishReason = parsed.choices?.[0]?.finish_reason;

          // Text content
          if (delta?.content) {
            await ensureTextBlockStarted();
            totalContent += delta.content;
            await emitSSE({
              type: 'content_block_delta',
              index: textBlockIndex,
              delta: { type: 'text_delta', text: delta.content }
            });
          }

          // Tool calls (incremental) — 不强制先开空 text block
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const tcIndex = tc.index ?? 0;
              const entry = toolCallMap.get(tcIndex);
              if (!entry) {
                // 分配动态索引（在 thinking/text 之后递增）
                const toolBlockIndex = nextBlockIndex++;
                toolCallMap.set(tcIndex, { id: tc.id || '', name: tc.function?.name || '', arguments: tc.function?.arguments || '', blockIndex: toolBlockIndex });
                const newEntry = toolCallMap.get(tcIndex);
                await emitSSE({
                  type: 'content_block_start',
                  index: toolBlockIndex,
                  content_block: { type: 'tool_use', id: newEntry.id, name: newEntry.name, input: {} }
                });
                // 首块也可能包含参数（非标准 OpenAI 实现），也需要发送 input_json_delta
                if (tc.function?.arguments) {
                  await emitSSE({
                    type: 'content_block_delta',
                    index: toolBlockIndex,
                    delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                  });
                }
              } else {
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name = tc.function.name;
                if (tc.function?.arguments) entry.arguments += tc.function.arguments;
                // Emit input_json_delta
                await emitSSE({
                  type: 'content_block_delta',
                  index: entry.blockIndex,
                  delta: { type: 'input_json_delta', partial_json: tc.function?.arguments || '' }
                });
              }
            }
          }

          // Reasoning content (from models like DeepSeek/Claude that use reasoning_content in OpenAI format)
          // Map to Anthropic thinking_delta for proper content block handling
          if (delta?.reasoning_content) {
            if (thinkingBlockIndex === null) {
              thinkingBlockIndex = nextBlockIndex++;
              await emitSSE({
                type: 'content_block_start',
                index: thinkingBlockIndex,
                content_block: { type: 'thinking', thinking: '' }
              });
            }
            totalContent += delta.reasoning_content;
            await emitSSE({
              type: 'content_block_delta',
              index: thinkingBlockIndex,
              delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
            });
          }

          if (finishReason) {
            if (finishReason === 'stop') stopReason = 'end_turn';
            else if (finishReason === 'length') stopReason = 'max_tokens';
            else if (finishReason === 'tool_calls') stopReason = 'tool_use';
          }
        } catch (e) {
          jsonParseErrors++;
          Logger.warn(`[proxyOpenAIToAnthropic] JSON解析失败: data=${data.substring(0, 200)}, error=${e.message}`);
        }
      }
    }

    // Process any residual data left in the buffer
    if (buffer.trim() && !clientDisconnected) {
      Logger.stream(`[proxyOpenAIToAnthropic] 处理残余缓冲区: ${buffer.length} bytes`);
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        sseLineCount++;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) lastUsage = parsed.usage;
          const finishReason = parsed.choices?.[0]?.finish_reason;
          if (finishReason) {
            if (finishReason === 'stop') stopReason = 'end_turn';
            else if (finishReason === 'length') stopReason = 'max_tokens';
            else if (finishReason === 'tool_calls') stopReason = 'tool_use';
          }
        } catch (e) {
          jsonParseErrors++;
          Logger.warn(`[proxyOpenAIToAnthropic] 残余缓冲区JSON解析失败: data=${data.substring(0, 200)}, error=${e.message}`);
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      Logger.error(`[proxyOpenAIToAnthropic] 流式超时 (${UPSTREAM_STREAM_TIMEOUT}ms): url=${url}, model=${model}, 已接收 ${chunkCount} chunks`);
    } else if (clientDisconnected) {
      Logger.warn(`[proxyOpenAIToAnthropic] 上游读取中断(客户端已断开): url=${url}, model=${model}, error=${err.message}`);
    } else {
      Logger.error(`[proxyOpenAIToAnthropic] 流式读取错误: ${err.message}, chunkCount=${chunkCount}`);
    }
  }

  // Use real usage from upstream if available, otherwise 0
  const promptTokens = lastUsage?.prompt_tokens || 0;
  const completionTokens = lastUsage?.completion_tokens || 0;
  const normalizedForSig = normalizeUsageTokens(lastUsage, 'openai');

  // 流式签名：有正文才追加；纯 tool 跳过，避免凭空 ensureTextBlockStarted
  try {
    const signature = await buildSignatureForRequest(req, {
      model,
      normalized: normalizedForSig,
      providerName: provider.name,
      provider,
      preloaded: preloadedSignatureData
    });
    if (signature) {
      const mode = resolveSignatureMode(req);
      const plan = planStreamSignatureInjection({
        mode,
        requestBody: openaiBody,
        hasTextContent: totalContent.length > 0 || textBlockStarted,
        hasToolCalls: toolCallMap.size > 0,
        stopReason,
        format: 'anthropic'
      });
      Logger.info(`[proxyOpenAIToAnthropic] 流式签名: append=${plan.appendContent}, reason=${plan.reason}, mode=${mode}`);
      if (plan.appendContent && (totalContent.length > 0 || textBlockStarted)) {
        await ensureTextBlockStarted();
        await emitSSE({
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: `\n\n${signature}` }
        });
      }
    }
  } catch (e) {
    Logger.warn(`[proxyOpenAIToAnthropic] 签名生成失败: ${e.message}`);
  }

  // Close thinking content block if started
  if (thinkingBlockIndex !== null) {
    await emitSSE({ type: 'content_block_stop', index: thinkingBlockIndex });
  }

  // Close text content block if started
  if (textBlockStarted) {
    await emitSSE({ type: 'content_block_stop', index: textBlockIndex });
  }

  // Close all tool use content blocks (in reverse index order)
  const sortedTools = [...toolCallMap.entries()].sort((a, b) => (b[1].blockIndex || 0) - (a[1].blockIndex || 0));
  for (const [tcIndex, entry] of sortedTools) {
    await emitSSE({ type: 'content_block_stop', index: entry.blockIndex });
  }

  const messageDelta = {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: completionTokens }
  };
  await emitSSE(messageDelta);

  const messageStop = { type: 'message_stop' };
  await emitSSE(messageStop);

  res.end();
  const latency = Date.now() - startTime;
  const normalized = normalizeUsageTokens(lastUsage, 'openai');
  if (currentProxyInfo?.proxyId) {
    proxyPool.markProxySuccess(provider.id, currentProxyInfo.proxyId, latency);
  }
  Logger.stream(`[proxyOpenAIToAnthropic] 流式传输统计: chunkCount=${chunkCount}, sseLineCount=${sseLineCount}, jsonParseErrors=${jsonParseErrors}, contentLength=${totalContent.length}, 首chunk耗时=${firstChunkTime ? firstChunkTime - startTime : '-'}ms, 客户端断开=${clientDisconnected}, toolCalls=${toolCallMap.size}, 背压次数=${backpressureCount}`);
  const cacheHitRate = promptTokens > 0 ? ((normalized.cachedTokens || 0) / promptTokens * 100).toFixed(1) : 0;
  Logger.info(`[proxyOpenAIToAnthropic] 流式完成: provider=${provider.id}(${provider.name}), model=${model}, latency=${latency}ms, prompt_tokens=${promptTokens || 0}, completion_tokens=${completionTokens}, cached_tokens=${normalized.cachedTokens || 0}, cache_hit_rate=${cacheHitRate}%`);
  return { ...normalized, promptTokens, completionTokens, content: totalContent };
}

// OpenAI 非流式响应 -> Anthropic 格式
async function proxyOpenAINonStreamToAnthropic(provider, model, openaiBody, res, req, options = {}) {
  const suppressErrorResponse = !!options.suppressErrorResponse;
  const baseUrl = cleanBaseUrl(provider.base_url);
  const url = upstreamUrl(baseUrl, '/chat/completions');
  const headers = buildUpstreamHeaders(provider, req, {
    'Content-Type': 'application/json'
  });
  if (provider.api_key) {
    headers['Authorization'] = `Bearer ${provider.api_key}`;
  }
  const startTime = Date.now();

  // 代理池支持
  const proxyInfo = await proxyPool.getProxyAgent(provider, affinityKeyForRequest(req, req.body));
  const proxyList = await proxyPool.getProxies(provider);
  const maxRetries = Math.min(MAX_UPSTREAM_ATTEMPTS, Math.max(proxyList.length || 1, 1));
  let currentProxyInfo = proxyInfo;

  // 预加载签名注入所需的数据（性能优化：减少重复数据库查询）
  let preloadedSignatureData = {};
  if (req.apiUser.signatureEnabled && req.apiUser.signatureTemplate) {
    preloadedSignatureData = await preloadSignatureData(
      req.apiUser.userId,
      req.apiUser.groupId,
      req.apiUser.signatureTemplate
    );
  }

  const { response, currentProxyInfo: finalProxyInfo } = await fetchWithProxyRetry(
    (proxyInfo) => ({
      url,
      method: 'POST', headers,
      body: JSON.stringify({ ...openaiBody, stream: false }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      agent: proxyInfo?.agent
    }),
    provider,
    currentProxyInfo,
    maxRetries,
    'proxyOpenAIToAnthropic',
    { model, requestType: 'proxyOpenAIToAnthropic', affinityKey: affinityKeyForRequest(req, req.body) }
  );
  currentProxyInfo = finalProxyInfo;

  let data;
  const latency = Date.now() - startTime;
  try {
    const text = await response.text();
    data = JSON.parse(text);
  } catch (parseErr) {
    Logger.error(`[proxyOpenAIToAnthropic] 上游响应解析失败: provider=${provider.id}(${provider.name}), status=${response.status}, latency=${latency}ms, error=${parseErr.message}`);
    return respondProxyError(res, 502, {
      type: 'error', error: { type: 'api_error', message: 'Upstream returned invalid JSON' }
    }, { suppressErrorResponse, retryable: true });
  }

  if (!response.ok) {
    Logger.error(`[proxyOpenAIToAnthropic] 上游错误: provider=${provider.id}(${provider.name}), status=${response.status}, latency=${latency}ms, body=${JSON.stringify(data).substring(0, 500)}`);
    const { toAnthropicError } = require('../utils/error-mapper');
    return respondProxyError(res, response.status, toAnthropicError(data, response.status), { suppressErrorResponse });
  }
  if (currentProxyInfo?.proxyId) {
    proxyPool.markProxySuccess(provider.id, currentProxyInfo.proxyId, latency);
  }

  const anthropicResp = convertOpenAIToAnthropicResponse(data, model);
  const normalized = normalizeUsageTokens(data.usage, 'openai');
  try {
    const signature = await buildSignatureForRequest(req, {
      model, normalized, providerName: provider.name, provider, preloaded: preloadedSignatureData
    });
    if (signature) {
      injectSignatureIntoAnthropicResponse(res, anthropicResp, signature, {
        mode: resolveSignatureMode(req),
        requestBody: openaiBody
      });
    }
  } catch (e) {
    Logger.warn(`[proxyOpenAIToAnthropic] 非流式签名生成失败: ${e.message}`);
  }

  // 注入提示词回显净化：模型复述 system 注入块时，返回前剥离（仅启用注入的请求）
  if (req.apiUser?.injectPrompt) {
    scrubAnthropicResponse(anthropicResp, req.apiUser.injectPrompt);
  }
  res.json(anthropicResp);
  const cacheHitRate = normalized.promptTokens > 0 ? (normalized.cachedTokens / normalized.promptTokens * 100).toFixed(1) : 0;
  Logger.info(`[proxyOpenAIToAnthropic] 非流式完成: provider=${provider.id}(${provider.name}), model=${model}, latency=${latency}ms, prompt_tokens=${normalized.promptTokens || 0}, completion_tokens=${normalized.completionTokens || 0}, cached_tokens=${normalized.cachedTokens || 0}, cache_hit_rate=${cacheHitRate}%`);
  return { ...normalized, content: anthropicResp.content.map(b => b.text || '').join('') };
}

// ==================== OpenAI Responses API ====================

// 将 Responses API input 转换为 Chat Completions messages
function convertResponsesInputToMessages(body) {
  const messages = [];

  // instructions → system/developer 消息
  if (body.instructions) {
    if (typeof body.instructions === 'string') {
      messages.push({ role: 'system', content: body.instructions });
    } else if (Array.isArray(body.instructions)) {
      for (const item of body.instructions) {
        if (typeof item === 'string') {
          messages.push({ role: 'system', content: item });
        } else if (item.type === 'message') {
          const role = item.role === 'developer' ? 'system' : item.role;
          const content = typeof item.content === 'string' ? item.content :
            Array.isArray(item.content) ? item.content.map(c => c.text || c.input_text || '').join('') : '';
          messages.push({ role, content });
        }
      }
    }
  }

  // input → messages
  if (!body.input) return messages;

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
    return messages;
  }

  if (!Array.isArray(body.input)) return messages;

  // 将连续的 function_call 合并为一条 assistant 消息（OpenAI Chat 惯例）
  let pendingToolCalls = [];
  const flushPendingToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: pendingToolCalls.map(fc => ({
        id: fc.call_id || fc.id,
        type: 'function',
        function: {
          name: fc.name || '',
          arguments: typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments || {})
        }
      }))
    });
    pendingToolCalls = [];
  };

  for (const item of body.input) {
    if (typeof item === 'string') {
      flushPendingToolCalls();
      messages.push({ role: 'user', content: item });
    } else if (item.type === 'function_call') {
      // Responses API assistant 历史工具调用
      pendingToolCalls.push(item);
    } else if (item.type === 'function_call_output') {
      flushPendingToolCalls();
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
      });
    } else if (item.type === 'message' || item.role) {
      flushPendingToolCalls();
      const role = (item.role === 'developer') ? 'system' : (item.role || 'user');
      let content;
      if (typeof item.content === 'string') {
        content = item.content;
      } else if (Array.isArray(item.content)) {
        const hasImage = item.content.some(c => c.type === 'input_image' || c.type === 'image_url');
        if (hasImage) {
          content = [];
          for (const c of item.content) {
            if (c.type === 'input_text' || c.type === 'text' || c.type === 'output_text') {
              content.push({ type: 'text', text: c.text || '' });
            } else if (c.type === 'input_image') {
              if (c.image_url) {
                content.push({ type: 'image_url', image_url: { url: c.image_url } });
              } else if (c.file_id) {
                content.push({ type: 'image_url', image_url: { url: c.file_id } });
              }
            } else if (c.type === 'image_url') {
              content.push(c);
            }
          }
        } else {
          content = item.content.map(c => c.text || c.refusal || '').join('');
        }
      } else {
        content = '';
      }
      // assistant 消息可能内嵌 tool_calls
      if (role === 'assistant' && item.tool_calls) {
        messages.push({ role, content: content || null, tool_calls: item.tool_calls });
      } else {
        messages.push({ role, content });
      }
    } else {
      Logger.debug(`[Responses] 忽略未知 input item type: ${item.type}`);
    }
  }
  flushPendingToolCalls();

  return messages;
}

// 将 Responses API tools 转换为 Chat Completions tools
function convertToolsToChatCompletions(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  return tools
    .filter(t => t.type === 'function')
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
}

// 将 Responses API text.format 转换为 Chat Completions response_format
function convertTextFormatToResponseFormat(text) {
  if (!text?.format) return undefined;
  const fmt = text.format;
  if (fmt.type === 'json_object') return { type: 'json_object' };
  if (fmt.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: { name: fmt.name, schema: fmt.schema, strict: fmt.strict !== false, description: fmt.description }
    };
  }
  return undefined;
}

// 将 Chat Completions 非流式响应转换为 Responses API 格式
function convertChatCompletionToResponse(data, respId, body) {
  const choice = data.choices?.[0];
  const message = choice?.message;
  const output = [];

  // Responses API 允许同一 response 中同时存在 message 文本与 function_call
  const text = message?.content || '';
  if (text) {
    output.push({
      id: `msg_${respId}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }]
    });
  }
  if (message?.reasoning_content) {
    output.push({
      id: `rs_${respId}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: message.reasoning_content }]
    });
  }
  if (message?.tool_calls?.length > 0) {
    for (const tc of message.tool_calls) {
      const fcId = tc.id || `fc_${Date.now()}`;
      output.push({
        type: 'function_call',
        id: fcId,
        call_id: tc.id || fcId,
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}',
        status: 'completed'
      });
    }
  }
  // 无文本也无工具时仍输出空 message，保持结构完整
  if (output.length === 0) {
    output.push({
      id: `msg_${respId}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }]
    });
  }

  return {
    id: respId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: body.instructions || null,
    max_output_tokens: body.max_output_tokens || null,
    model: data.model || body.model,
    output,
    parallel_tool_calls: body.parallel_tool_calls !== false,
    previous_response_id: body.previous_response_id || null,
    reasoning: body.reasoning || { effort: null, summary: null },
    store: false,
    temperature: body.temperature ?? 1.0,
    text: body.text || { format: { type: 'text' } },
    tool_choice: body.tool_choice || 'auto',
    tools: body.tools || [],
    top_p: body.top_p ?? 1.0,
    truncation: body.truncation || 'disabled',
    usage: data.usage ? {
      input_tokens: data.usage.prompt_tokens || 0,
      output_tokens: data.usage.completion_tokens || 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: data.usage.total_tokens || 0
    } : null,
    user: body.user || null,
    metadata: body.metadata || {},
    output_text: output.filter(o => o.type === 'message').map(o => o.content?.map(c => c.text || '').join('') || '').join('')
  };
}

// 流式代理 OpenAI 上游，输出 Responses API SSE 事件
async function streamOpenAIAsResponses(reader, decoder, res, req, respId, model, body, writeWithDrain, waitForDrain) {
  let buffer = '';
  let totalContent = '';
  let lastUsage = null;
  let chunkCount = 0;
  let sseLineCount = 0;
  let jsonParseErrors = 0;
  let firstChunkTime = null;
  let clientDisconnected = false;
  let gotDone = false;
  const startTime = Date.now();
  let textStarted = false;
  let textDone = false;
  const toolCalls = {}; // index → { id, name, arguments }
  const emittedToolCalls = new Set();

  req.on('close', () => { clientDisconnected = true; });

  // 发送初始事件
  const baseResponse = {
    id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress', error: null, incomplete_details: null,
    instructions: body.instructions || null, max_output_tokens: body.max_output_tokens || null,
    model, output: [], parallel_tool_calls: body.parallel_tool_calls !== false,
    previous_response_id: body.previous_response_id || null,
    reasoning: body.reasoning || { effort: null, summary: null },
    store: false, temperature: body.temperature ?? 1.0,
    text: body.text || { format: { type: 'text' } },
    tool_choice: body.tool_choice || 'auto', tools: body.tools || [],
    top_p: body.top_p ?? 1.0, truncation: body.truncation || 'disabled',
    usage: null, user: body.user || null, metadata: body.metadata || {}
  };
  await writeWithDrain(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: baseResponse })}\n\n`);
  await writeWithDrain(`event: response.in_progress\ndata: ${JSON.stringify({ type: 'response.in_progress', response: baseResponse })}\n\n`);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || clientDisconnected) break;
      if (!firstChunkTime) firstChunkTime = Date.now();
      chunkCount++;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        sseLineCount++;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { gotDone = true; continue; }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) {
            if (parsed.usage) lastUsage = parsed.usage;
            continue;
          }

          // 文本内容
          if (delta.content && !textDone) {
            if (!textStarted) {
              textStarted = true;
              await writeWithDrain(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: `msg_${respId}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })}\n\n`);
              await writeWithDrain(`event: response.content_part.added\ndata: ${JSON.stringify({ type: 'response.content_part.added', item_id: `msg_${respId}`, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })}\n\n`);
            }
            totalContent += delta.content;
            let deltaText = delta.content;
            if (pluginHooks.hasSubscribers('gateway:responseChunk')) {
              const out = await pluginHooks.maybeRewriteChunk(deltaText, { model, requestType: 'Responses/OpenAI', affinityKey: affinityKeyForRequest(req, req.body) });
              if (out === null) continue;
              if (typeof out === 'string') {
                totalContent = totalContent.slice(0, totalContent.length - deltaText.length) + out;
                deltaText = out;
              }
            }
            await writeWithDrain(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: `msg_${respId}`, output_index: 0, content_index: 0, delta: deltaText })}\n\n`);
          }

          // 工具调用
          if (delta.tool_calls) {
            // 关闭文本输出（如果有）
            if (textStarted && !textDone) {
              textDone = true;
              await writeWithDrain(`event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', item_id: `msg_${respId}`, output_index: 0, content_index: 0, text: totalContent })}\n\n`);
              await writeWithDrain(`event: response.content_part.done\ndata: ${JSON.stringify({ type: 'response.content_part.done', item_id: `msg_${respId}`, output_index: 0, content_index: 0, part: { type: 'output_text', text: totalContent, annotations: [] } })}\n\n`);
              await writeWithDrain(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: `msg_${respId}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: totalContent, annotations: [] }] } })}\n\n`);
            }

            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', arguments: '' };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
            }
          }

          if (parsed.usage) lastUsage = parsed.usage;
        } catch (e) {
          jsonParseErrors++;
        }
      }
    }

    // 处理残余缓冲区
    if (buffer.trim() && !clientDisconnected) {
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { gotDone = true; continue; }
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) lastUsage = parsed.usage;
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content && !textDone) { totalContent += delta.content; }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', arguments: '' };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
            }
          }
        } catch (e) { jsonParseErrors++; }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError' && err.name !== 'TimeoutError' && !clientDisconnected) {
      Logger.error(`[Responses/OpenAI] 流式读取错误: model=${model}, error=${err.message}`);
    }
  }

  // 关闭未完成的文本输出
  if (textStarted && !textDone) {
    await writeWithDrain(`event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', item_id: `msg_${respId}`, output_index: 0, content_index: 0, text: totalContent })}\n\n`);
    await writeWithDrain(`event: response.content_part.done\ndata: ${JSON.stringify({ type: 'response.content_part.done', item_id: `msg_${respId}`, output_index: 0, content_index: 0, part: { type: 'output_text', text: totalContent, annotations: [] } })}\n\n`);
    await writeWithDrain(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: `msg_${respId}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: totalContent, annotations: [] }] } })}\n\n`);
  }

  // 发送工具调用事件
  const toolCallIndices = Object.keys(toolCalls).map(Number).sort((a, b) => a - b);
  const toolOutput = [];
  for (const idx of toolCallIndices) {
    const tc = toolCalls[idx];
    const tcId = tc.id || `fc_${respId}_${idx}`;
    const outputIdx = textStarted ? idx + 1 : idx;
    await writeWithDrain(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: outputIdx, item: { type: 'function_call', id: tcId, call_id: tc.id || tcId, name: tc.name, arguments: tc.arguments, status: 'completed' } })}\n\n`);
    await writeWithDrain(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: tcId, output_index: outputIdx, arguments: tc.arguments })}\n\n`);
    await writeWithDrain(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: outputIdx, item: { type: 'function_call', id: tcId, call_id: tc.id || tcId, name: tc.name, arguments: tc.arguments, status: 'completed' } })}\n\n`);
    toolOutput.push({ type: 'function_call', id: tcId, call_id: tc.id || tcId, name: tc.name, arguments: tc.arguments, status: 'completed' });
  }

  // 构建最终输出数组
  const finalOutput = [];
  if (textStarted) {
    finalOutput.push({ id: `msg_${respId}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: totalContent, annotations: [] }] });
  }
  finalOutput.push(...toolOutput);

  // 发送 response.completed
  const normalized = normalizeUsageTokens(lastUsage, 'openai');
  const completedResponse = {
    ...baseResponse, status: 'completed', output: finalOutput,
    usage: lastUsage ? {
      input_tokens: normalized.promptTokens || 0, output_tokens: normalized.completionTokens || 0,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: (normalized.promptTokens || 0) + (normalized.completionTokens || 0)
    } : null,
    output_text: totalContent
  };
  await writeWithDrain(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`);

  const latency = Date.now() - startTime;
  Logger.info(`[Responses/OpenAI] 流式完成: model=${model}, latency=${latency}ms, content=${totalContent.length}, chunks=${chunkCount}, tools=${toolCallIndices.length}`);
  return { ...normalized, content: totalContent };
}

// 流式代理 Anthropic 上游，输出 Responses API SSE 事件
async function streamAnthropicAsResponses(reader, decoder, res, req, respId, model, body, writeWithDrain, waitForDrain) {
  let buffer = '';
  let totalContent = '';
  let anthropicUsage = { input_tokens: 0 };
  let completionTokens = 0;
  let currentBlockType = null;
  const toolUseBlocks = [];
  let currentToolIndex = -1;
  let chunkCount = 0;
  let sseLineCount = 0;
  let jsonParseErrors = 0;
  let firstChunkTime = null;
  let clientDisconnected = false;
  let gotDone = false;
  const startTime = Date.now();
  let textStarted = false;
  let textDone = false;

  req.on('close', () => { clientDisconnected = true; });

  const baseResponse = {
    id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress', error: null, incomplete_details: null,
    instructions: body.instructions || null, max_output_tokens: body.max_output_tokens || null,
    model, output: [], parallel_tool_calls: body.parallel_tool_calls !== false,
    previous_response_id: body.previous_response_id || null,
    reasoning: body.reasoning || { effort: null, summary: null },
    store: false, temperature: body.temperature ?? 1.0,
    text: body.text || { format: { type: 'text' } },
    tool_choice: body.tool_choice || 'auto', tools: body.tools || [],
    top_p: body.top_p ?? 1.0, truncation: body.truncation || 'disabled',
    usage: null, user: body.user || null, metadata: body.metadata || {}
  };
  await writeWithDrain(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: baseResponse })}\n\n`);
  await writeWithDrain(`event: response.in_progress\ndata: ${JSON.stringify({ type: 'response.in_progress', response: baseResponse })}\n\n`);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || clientDisconnected) break;
      if (!firstChunkTime) firstChunkTime = Date.now();
      chunkCount++;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        sseLineCount++;
        const data = line.slice(6).trim();
        try {
          const parsed = JSON.parse(data);

          if (parsed.type === 'content_block_start') {
            currentBlockType = parsed.content_block?.type || null;
            if (currentBlockType === 'tool_use') {
              currentToolIndex = toolUseBlocks.length;
              toolUseBlocks.push({ id: parsed.content_block.id, name: parsed.content_block.name, arguments: '' });
            }
          } else if (parsed.type === 'content_block_delta') {
            if (currentBlockType === 'text' && parsed.delta?.text) {
              if (!textStarted) {
                textStarted = true;
                await writeWithDrain(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: `msg_${respId}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })}\n\n`);
                await writeWithDrain(`event: response.content_part.added\ndata: ${JSON.stringify({ type: 'response.content_part.added', item_id: `msg_${respId}`, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })}\n\n`);
              }
              totalContent += parsed.delta.text;
              let deltaTextA = parsed.delta.text;
              if (pluginHooks.hasSubscribers('gateway:responseChunk')) {
                const out = await pluginHooks.maybeRewriteChunk(deltaTextA, { model, requestType: 'Responses/Anthropic', affinityKey: affinityKeyForRequest(req, req.body) });
                if (out === null) continue;
                if (typeof out === 'string') {
                  totalContent = totalContent.slice(0, totalContent.length - deltaTextA.length) + out;
                  deltaTextA = out;
                }
              }
              await writeWithDrain(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: `msg_${respId}`, output_index: 0, content_index: 0, delta: deltaTextA })}\n\n`);
            } else if (currentBlockType === 'tool_use' && parsed.delta?.type === 'input_json_delta') {
              if (currentToolIndex >= 0 && toolUseBlocks[currentToolIndex]) {
                toolUseBlocks[currentToolIndex].arguments += parsed.delta.partial_json || '';
              }
            }
          } else if (parsed.type === 'content_block_stop') {
            if (currentBlockType === 'tool_use' && currentToolIndex >= 0) {
              // 关闭文本输出（如果有）
              if (textStarted && !textDone) {
                textDone = true;
                await writeWithDrain(`event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', item_id: `msg_${respId}`, output_index: 0, content_index: 0, text: totalContent })}\n\n`);
                await writeWithDrain(`event: response.content_part.done\ndata: ${JSON.stringify({ type: 'response.content_part.done', item_id: `msg_${respId}`, output_index: 0, content_index: 0, part: { type: 'output_text', text: totalContent, annotations: [] } })}\n\n`);
                await writeWithDrain(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: `msg_${respId}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: totalContent, annotations: [] }] } })}\n\n`);
              }

              const tool = toolUseBlocks[currentToolIndex];
              const outputIdx = textStarted ? currentToolIndex + 1 : currentToolIndex;
              await writeWithDrain(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: outputIdx, item: { type: 'function_call', id: tool.id, call_id: tool.id, name: tool.name, arguments: tool.arguments, status: 'completed' } })}\n\n`);
              await writeWithDrain(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: tool.id, output_index: outputIdx, arguments: tool.arguments })}\n\n`);
              await writeWithDrain(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: outputIdx, item: { type: 'function_call', id: tool.id, call_id: tool.id, name: tool.name, arguments: tool.arguments, status: 'completed' } })}\n\n`);
            }
            currentBlockType = null;
          } else if (parsed.type === 'message_start' && parsed.message?.usage) {
            anthropicUsage = parsed.message.usage;
          } else if (parsed.type === 'message_delta' && parsed.usage) {
            completionTokens = parsed.usage.output_tokens || 0;
          } else if (parsed.type === 'message_stop') {
            gotDone = true;
          }
        } catch (e) { jsonParseErrors++; }
      }
    }

    // 处理残余缓冲区
    if (buffer.trim() && !clientDisconnected) {
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'message_delta' && parsed.usage) completionTokens = parsed.usage.output_tokens || 0;
          if (parsed.type === 'message_stop') gotDone = true;
        } catch (e) { jsonParseErrors++; }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError' && err.name !== 'TimeoutError' && !clientDisconnected) {
      Logger.error(`[Responses/Anthropic] 流式读取错误: model=${model}, error=${err.message}`);
    }
  }

  // 关闭未完成的文本输出
  if (textStarted && !textDone) {
    await writeWithDrain(`event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', item_id: `msg_${respId}`, output_index: 0, content_index: 0, text: totalContent })}\n\n`);
    await writeWithDrain(`event: response.content_part.done\ndata: ${JSON.stringify({ type: 'response.content_part.done', item_id: `msg_${respId}`, output_index: 0, content_index: 0, part: { type: 'output_text', text: totalContent, annotations: [] } })}\n\n`);
    await writeWithDrain(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: `msg_${respId}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: totalContent, annotations: [] }] } })}\n\n`);
  }

  // 构建最终输出
  const finalOutput = [];
  if (textStarted) {
    finalOutput.push({ id: `msg_${respId}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: totalContent, annotations: [] }] });
  }
  for (const tool of toolUseBlocks) {
    finalOutput.push({ type: 'function_call', id: tool.id, call_id: tool.id, name: tool.name, arguments: tool.arguments, status: 'completed' });
  }

  const syntheticUsage = {
    input_tokens: anthropicUsage.input_tokens || 0, output_tokens: completionTokens,
    cache_read_input_tokens: anthropicUsage.cache_read_input_tokens || 0,
    cache_creation_input_tokens: anthropicUsage.cache_creation_input_tokens || 0
  };
  const normalized = normalizeUsageTokens(syntheticUsage, 'anthropic');

  const completedResponse = {
    ...baseResponse, status: 'completed', output: finalOutput,
    usage: {
      input_tokens: normalized.promptTokens || 0, output_tokens: normalized.completionTokens || 0,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: (normalized.promptTokens || 0) + (normalized.completionTokens || 0)
    },
    output_text: totalContent
  };
  await writeWithDrain(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: completedResponse })}\n\n`);

  const latency = Date.now() - startTime;
  Logger.info(`[Responses/Anthropic] 流式完成: model=${model}, latency=${latency}ms, content=${totalContent.length}, chunks=${chunkCount}, tools=${toolUseBlocks.length}`);
  return { ...normalized, content: totalContent };
}

// 非流式代理 OpenAI 上游，返回 Responses API 格式
async function proxyOpenAIForResponses(provider, model, chatBody, res, req, respId, body, options = {}) {
  const suppressErrorResponse = !!options.suppressErrorResponse;
  const baseUrl = cleanBaseUrl(provider.base_url);
  const url = upstreamUrl(baseUrl, '/chat/completions');
  const headers = buildUpstreamHeaders(provider, req, {
    'Content-Type': 'application/json'
  });
  if (provider.api_key) headers['Authorization'] = `Bearer ${provider.api_key}`;

  const startTime = Date.now();

  // 代理池支持
  const proxyInfo = await proxyPool.getProxyAgent(provider, affinityKeyForRequest(req, req.body));
  const proxyList = await proxyPool.getProxies(provider);
  const maxRetries = Math.min(MAX_UPSTREAM_ATTEMPTS, Math.max(proxyList.length || 1, 1));
  let currentProxyInfo = proxyInfo;

  Logger.info(`[Responses/OpenAI] 非流式请求: provider=${provider.id}(${provider.name}), model=${model}, proxy=${currentProxyInfo?.proxyUrl || 'none'}`);

  // 预加载签名注入所需的数据（性能优化：减少重复数据库查询）
  let preloadedSignatureData = {};
  if (req.apiUser.signatureEnabled && req.apiUser.signatureTemplate) {
    preloadedSignatureData = await preloadSignatureData(
      req.apiUser.userId,
      req.apiUser.groupId,
      req.apiUser.signatureTemplate
    );
  }

  const { response, currentProxyInfo: finalProxyInfo } = await fetchWithProxyRetry(
    (proxyInfo) => ({
      url,
      method: 'POST', headers, body: JSON.stringify(chatBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      agent: proxyInfo?.agent
    }),
    provider,
    currentProxyInfo,
    maxRetries,
    'Responses/OpenAI',
    { model, requestType: 'Responses/OpenAI', affinityKey: affinityKeyForRequest(req, req.body) }
  );
  currentProxyInfo = finalProxyInfo;

  const data = await response.json();
  const latency = Date.now() - startTime;

  if (!response.ok) {
    Logger.error(`[Responses/OpenAI] 上游错误: provider=${provider.id}, status=${response.status}, latency=${latency}ms`);
    return respondProxyError(res, response.status, data, { suppressErrorResponse });
  }
  if (currentProxyInfo?.proxyId) {
    proxyPool.markProxySuccess(provider.id, currentProxyInfo.proxyId, latency);
  }

  const normalized = normalizeUsageTokens(data.usage, 'openai');
  let result = convertChatCompletionToResponse(data, respId, body);

  // 签名注入
  try {
    const signature = await buildSignatureForRequest(req, {
      model, normalized, providerName: provider.name, provider, preloaded: preloadedSignatureData
    });
    if (signature) {
      injectSignatureIntoResponsesBody(res, result, signature, {
        mode: resolveSignatureMode(req),
        requestBody: body
      });
    }
  } catch (e) { Logger.warn(`[Responses/OpenAI] 签名生成失败: ${e.message}`); }

  // 注入提示词回显净化：模型复述 system 注入块时，返回前剥离（仅启用注入的请求）
  if (req.apiUser?.injectPrompt) {
    scrubResponsesApiResult(result, req.apiUser.injectPrompt);
  }
  res.json(result);
  Logger.info(`[Responses/OpenAI] 非流式完成: provider=${provider.id}, model=${model}, latency=${latency}ms, prompt=${normalized.promptTokens}, completion=${normalized.completionTokens}`);
  return { ...normalized, content: result.output_text || '' };
}

// 非流式代理 Anthropic 上游，返回 Responses API 格式
async function proxyAnthropicForResponses(provider, model, chatBody, res, req, respId, body, options = {}) {
  const suppressErrorResponse = !!options.suppressErrorResponse;
  const baseUrl = cleanBaseUrl(provider.base_url);
  const url = upstreamUrl(baseUrl, '/messages');
  const headers = buildUpstreamHeaders(provider, req, {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01'
  });
  if (provider.api_key) headers['x-api-key'] = provider.api_key;

  // 复用与 proxyAnthropic 一致的 OpenAI→Anthropic 消息转换（含 tool / image）
  const systemParts = [];
  const convertedMessages = [];
  for (const m of (chatBody.messages || [])) {
    const role = normalizeMessageRole(m.role);
    if (role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content);
      else if (Array.isArray(m.content)) {
        systemParts.push(m.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n'));
      }
      continue;
    }
    if (role === 'tool') {
      convertedMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : String(m.content || '')
        }]
      });
    } else if (role === 'assistant' && m.tool_calls) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: typeof m.content === 'string' ? m.content : '' });
      for (const tc of m.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || '',
          input: typeof tc.function?.arguments === 'string'
            ? safeParseJson(tc.function.arguments, {})
            : (tc.function?.arguments || {})
        });
      }
      convertedMessages.push({ role: 'assistant', content });
    } else {
      convertedMessages.push({ role, content: convertOpenAIContentToAnthropic(m.content) });
    }
  }
  const upstreamBody = {
    model,
    max_tokens: chatBody.max_tokens || chatBody.max_completion_tokens || 4096,
    messages: convertedMessages,
    stream: false
  };
  if (systemParts.length > 0) upstreamBody.system = systemParts.join('\n');
  if (chatBody.temperature !== undefined) upstreamBody.temperature = chatBody.temperature;
  if (chatBody.top_p !== undefined) upstreamBody.top_p = chatBody.top_p;
  if (chatBody.stop) upstreamBody.stop_sequences = Array.isArray(chatBody.stop) ? chatBody.stop : [chatBody.stop];
  if (chatBody.tools) {
    upstreamBody.tools = chatBody.tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} }
    }));
  }

  const startTime = Date.now();

  // 代理池支持
  const proxyInfo = await proxyPool.getProxyAgent(provider, affinityKeyForRequest(req, req.body));
  const proxyList = await proxyPool.getProxies(provider);
  const maxRetries = Math.min(MAX_UPSTREAM_ATTEMPTS, Math.max(proxyList.length || 1, 1));
  let currentProxyInfo = proxyInfo;

  Logger.info(`[Responses/Anthropic] 非流式请求: provider=${provider.id}(${provider.name}), model=${model}, proxy=${currentProxyInfo?.proxyUrl || 'none'}`);

  const { response, currentProxyInfo: finalProxyInfo } = await fetchWithProxyRetry(
    (proxyInfo) => ({
      url,
      method: 'POST', headers, body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      agent: proxyInfo?.agent
    }),
    provider,
    currentProxyInfo,
    maxRetries,
    'Responses/Anthropic',
    { model, requestType: 'Responses/Anthropic', affinityKey: affinityKeyForRequest(req, req.body) }
  );
  currentProxyInfo = finalProxyInfo;

  const data = await response.json();
  const latency = Date.now() - startTime;

  if (!response.ok) {
    Logger.error(`[Responses/Anthropic] 上游错误: provider=${provider.id}, status=${response.status}, latency=${latency}ms`);
    // Responses API 使用 OpenAI 风格错误（本端点对外是 /v1/responses）
    return respondProxyError(res, response.status, {
      error: {
        message: data.error?.message || (typeof data === 'string' ? data : JSON.stringify(data).slice(0, 500)),
        type: 'server_error',
        code: 'upstream_error'
      }
    }, { suppressErrorResponse });
  }
  if (currentProxyInfo?.proxyId) {
    proxyPool.markProxySuccess(provider.id, currentProxyInfo.proxyId, latency);
  }

  const output = [];
  if (data.content) {
    const textParts = data.content.filter(b => b.type === 'text');
    const toolParts = data.content.filter(b => b.type === 'tool_use');
    const thinkingParts = data.content.filter(b => b.type === 'thinking');
    // 文本与 function_call 可并存
    if (textParts.length > 0) {
      const text = textParts.map(b => b.text).join('');
      output.push({ id: `msg_${respId}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
    }
    if (thinkingParts.length > 0) {
      output.push({
        id: `rs_${respId}`,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: thinkingParts.map(t => t.thinking || '').join('') }]
      });
    }
    for (const tp of toolParts) {
      output.push({ type: 'function_call', id: tp.id, call_id: tp.id, name: tp.name, arguments: JSON.stringify(tp.input || {}), status: 'completed' });
    }
  }

  const normalized = normalizeUsageTokens(data.usage, 'anthropic');
  const result = {
    id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status: 'completed', error: null, incomplete_details: null,
    instructions: body.instructions || null, max_output_tokens: body.max_output_tokens || null,
    model: data.model || model, output,
    parallel_tool_calls: body.parallel_tool_calls !== false,
    previous_response_id: body.previous_response_id || null,
    reasoning: body.reasoning || { effort: null, summary: null },
    store: false, temperature: body.temperature ?? 1.0,
    text: body.text || { format: { type: 'text' } },
    tool_choice: body.tool_choice || 'auto', tools: body.tools || [],
    top_p: body.top_p ?? 1.0, truncation: body.truncation || 'disabled',
    usage: { input_tokens: normalized.promptTokens || 0, output_tokens: normalized.completionTokens || 0,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: (normalized.promptTokens || 0) + (normalized.completionTokens || 0) },
    user: body.user || null, metadata: body.metadata || {},
    output_text: output.filter(o => o.type === 'message').map(o => o.content?.map(c => c.text || '').join('') || '').join('')
  };

  // 注入提示词回显净化：模型复述 system 注入块时，返回前剥离（仅启用注入的请求）
  if (req.apiUser?.injectPrompt) {
    scrubResponsesApiResult(result, req.apiUser.injectPrompt);
  }
  res.json(result);
  Logger.info(`[Responses/Anthropic] 非流式完成: provider=${provider.id}, model=${model}, latency=${latency}ms`);
  return { ...normalized, content: result.output_text || '' };
}

// OpenAI 兼容: /v1/responses 和 /api/responses
router.post('/responses', oauthBearer, handleResponses);

async function handleResponses(req, res) {
  req._upstreamAttemptContext = { upstreamAttempts: 0 };
  const { tryHandleCrewRouterCommand } = require('../utils/crewrouter-command');
  if (await tryHandleCrewRouterCommand(req, res)) return;

  // 插件 gateway:requestReceived 钩子：可改写请求体或短路直接响应
  if (pluginHooks.hasSubscribers('gateway:requestReceived')) {
    const out = await pluginHooks.apply('gateway:requestReceived', { body: req.body }, { model: req.body?.model || null, requestType: 'responses' });
    if (out?.shortCircuit) return res.status(out.status || 200).json(out.body ?? {});
    if (out?.body !== undefined) req.body = out.body;
  }

  // 吞图：剥离 input 中的图片并注入提示（默认禁用）；须在转换/透传前执行
  applySwallowImagesIfEnabled(req);

  const body = req.body;
  let { model, input, stream, temperature, max_output_tokens, top_p, tools, tool_choice, text, reasoning } = body;

  // 注入提示词：放入 Responses input 首条 user 前的 meta user；无配置时请求保持原样
  if (req.apiUser.injectPrompt) {
    body.input = responsesAppend(body.input, req.apiUser.injectPrompt);
  }

  // Fusion 模型检测
  if (model === 'fusion' || model?.startsWith('fusion')) {
    // 将 Responses API input 转为 messages 格式供 Fusion 使用
    const messages = convertResponsesInputToMessages(body);
    req.body = { ...req.body, messages, max_tokens: max_output_tokens };
    return await handleFusionRequest(req, res, 'openai');
  }

  // CrewRouter: 使用 API Key 绑定的有序模型队列；harness 单独绑定优先
  const resolved = resolveModelQueueForRequest(req.apiUser, req);
  const modelQueue = resolved.queue;
  if (!modelQueue.length) {
    return res.status(400).json({ error: { message: 'No model selected. Please select a model from the model library first.', type: 'invalid_request_error' } });
  }

  Logger.info(
    `[Responses] 收到请求: queue=[${modelQueue.join(',')}], stream=${!!stream}` +
    `, input=${typeof input === 'string' ? input.length + 'chars' : Array.isArray(input) ? input.length + 'items' : 'none'}` +
    `, source=${resolved.requestSource}` +
    (resolved.harnessOverride ? ', harness_override=1' : ', harness_override=0')
  );

  // 参数转换（与具体模型无关）
  const messages = convertResponsesInputToMessages(body);
  const chatTools = convertToolsToChatCompletions(tools);
  const responseFormat = convertTextFormatToResponseFormat(text);
  const respId = 'resp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  let lastError = null;
  let modelConfig = null;
  let upstreamModel = null;
  let provider = null;
  let providerWithKey = null;
  let currentProxyInfo = null;
  let chatBody = null;
  let selectedQueueIndex = -1;

  for (let i = 0; i < modelQueue.length; i++) {
    const queueModelId = modelQueue[i];
    const hasMore = i < modelQueue.length - 1;
    const cfg = await getModelConfig(queueModelId);
    if (!cfg) {
      Logger.warn(`[Responses] 队列模型未找到 attempt=${i + 1}/${modelQueue.length}: ${queueModelId}`);
      lastError = { status: 404, body: { error: { message: `Model '${queueModelId}' not found`, type: 'not_found_error' } }, retryable: false };
      if (hasMore && lastError.retryable) continue;
      return res.status(404).json(lastError.body);
    }

    const upModel = cfg.upstream_model_id || cfg.id;
    const modelRpm = cfg.rate_limit_rpm || 0;
    const modelTpm = cfg.rate_limit_tpm || 0;
    const userRpm = req.apiUser.userRateLimitRpm || 0;
    const userTpm = req.apiUser.userRateLimitTpm || 0;
    const effectiveRpm = (modelRpm > 0 && userRpm > 0) ? Math.min(modelRpm, userRpm) : (modelRpm || userRpm);
    const effectiveTpm = (modelTpm > 0 && userTpm > 0) ? Math.min(modelTpm, userTpm) : (modelTpm || userTpm);

    if (effectiveRpm > 0 || effectiveTpm > 0) {
      const estimatedTokens = (typeof input === 'string' ? input.length / 4 : 500);
      const rpmKey = `rpm:${req.apiUser.userId}:${upModel}`;
      const rpmCheck = checkRateLimit(rpmKey, effectiveRpm, 0, 0);
      if (rpmCheck.limited) {
        lastError = { status: 429, body: { error: { message: rpmCheck.reason, type: 'rate_limit_error' } }, retryable: false };
        if (hasMore && lastError.retryable) continue;
        return res.status(429).json(lastError.body);
      }
      const tpmKey = `tpm:${req.apiUser.userId}:${upModel}`;
      const tpmCheck = checkRateLimit(tpmKey, 0, effectiveTpm, Math.ceil(estimatedTokens));
      if (tpmCheck.limited) {
        lastError = { status: 429, body: { error: { message: tpmCheck.reason, type: 'rate_limit_error' } }, retryable: false };
        if (hasMore && lastError.retryable) continue;
        return res.status(429).json(lastError.body);
      }
    }

    const prov = await getProviderForRequest(cfg.provider);
    if (!prov) {
      lastError = { status: 500, body: { error: { message: 'Provider not configured', type: 'server_error' } }, retryable: true };
      if (hasMore && lastError.retryable) continue;
      return res.status(500).json(lastError.body);
    }

    // 流式：Responses 部分路径会先 flush headers，仅对「非流式」做完整顺序回退；
    // 流式仍会跳过不可用模型，选用队列中第一个可用模型。
    modelConfig = cfg;
    upstreamModel = upModel;
    model = queueModelId;
    provider = prov;
    currentProxyInfo = await proxyPool.getProxyAgent(provider, affinityKeyForRequest(req, req.body));
    // 主 Key 预置；非流式/流式实际调用会再走多 Key fallback
    const effectiveApiKey = await getEffectiveApiKey(provider);
    providerWithKey = { ...provider, api_key: effectiveApiKey };
    chatBody = {
      model: upstreamModel, messages, temperature, max_tokens: max_output_tokens, top_p,
      tools: chatTools, tool_choice, response_format: responseFormat, stream: !!stream
    };
    if (stream) chatBody.stream_options = { include_usage: true };
    if (modelConfig.forward_reasoning_effort) {
      if (body.reasoning_effort !== undefined) {
        chatBody.reasoning_effort = body.reasoning_effort;
      } else if (reasoning?.effort !== undefined) {
        chatBody.reasoning_effort = reasoning.effort;
      }
    }
    req.apiUser._inputPrice = modelConfig.input_price_per_1k_tokens || 0;
    req.apiUser._outputPrice = modelConfig.output_price_per_1k_tokens || 0;
    selectedQueueIndex = i;

    // 非流式：在此循环内直接尝试上游并支持回退
    if (!stream) {
      // === Responses 格式供应商直接透传（非流式）===
      if (provider.format === 'responses') {
        const baseUrl = cleanBaseUrl(provider.base_url);
        const url = upstreamUrl(baseUrl, '/responses');
        const headers = buildUpstreamHeaders(providerWithKey, req, { 'Content-Type': 'application/json' });
        if (providerWithKey.api_key) headers['Authorization'] = `Bearer ${providerWithKey.api_key}`;
        // 原样透传客户端请求，仅覆盖 model；不强制注入 max_output_tokens，交由上游/客户端决定。
        const upstreamBody = { ...body, model: upstreamModel };
        if (!modelConfig.forward_reasoning_effort) {
          delete upstreamBody.reasoning;
          delete upstreamBody.reasoning_effort;
        }
        if (!upstreamBody.input) {
          return res.status(400).json({ error: { message: 'input is required', type: 'invalid_request_error' } });
        }
        try {
          const upstreamResp = await proxyPool.proxyFetch(url, {
            method: 'POST', headers, body: JSON.stringify(upstreamBody),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
            agent: currentProxyInfo?.agent
          });
          const responseData = await upstreamResp.json();
          if (!upstreamResp.ok) {
            recordModelCall(modelConfig.id || model, false);
            recordLiveCallTest(modelConfig.id || model, { ok: false, error: `HTTP ${upstreamResp.status}` });
            lastError = { status: upstreamResp.status, body: responseData, retryable: isRetryableUpstreamStatus(upstreamResp.status) };
            const willRetry = hasMore && lastError.retryable;
            captureCallError(req, {
              modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'responses',
              status: upstreamResp.status, body: responseData, isFinal: !willRetry
            });
            if (willRetry) {
              Logger.warn(`[Responses] 队列回退 attempt=${i + 1}/${modelQueue.length} model=${queueModelId} status=${upstreamResp.status}`);
              continue;
            }
            return res.status(upstreamResp.status).json(responseData);
          }
          recordModelCall(modelConfig.id || model, true);
          const _pt = responseData.usage?.input_tokens || 0;
          const _ct = responseData.usage?.output_tokens || 0;
          recordLiveCallTest(modelConfig.id || model, { ok: true, promptTokens: _pt, completionTokens: _ct });
          // 注入提示词回显净化：直通响应同样剥离，且先于用量入库保证记录一致（仅启用注入的请求）
          if (req.apiUser?.injectPrompt) {
            scrubResponsesApiResult(responseData, req.apiUser.injectPrompt);
          }
          const usage = responseData.usage || {};
          const promptTokens = usage.input_tokens || 0;
          const completionTokens = usage.output_tokens || 0;
          const totalTokens = promptTokens + completionTokens;
          const cachedTokens = usage.cached_tokens || 0;
          const calculated = calculateCost(modelConfig, { promptTokens, completionTokens, cachedTokens });
          if (totalTokens > 0) {
            try {
              const pointsToDeduct = await adjustBillingCost(calculated.weightedTokens, calculated.pointsCost, {
                userId: req.apiUser.userId,
                groupId: req.apiUser.groupId,
                model: modelConfig.id || model,
                provider: provider?.id || null,
                requestType: 'responses',
              });
              const pluginMeta = await buildUsagePluginMeta({
                userId: req.apiUser.userId,
                model: modelConfig.id || model,
                provider: provider?.id || null,
                requestType: 'responses',
                apiKeyId: req.apiUser.keyId,
              }, req.body.messages ?? req.body.input, req.body.system ?? req.body.instructions, req);
              const localModelId = modelConfig.id || model;
              const usageResult = await recordUsageAndDeduct({ pool, usageQuery: `INSERT INTO usage_records (user_id, model_id, api_key_id, tokens_used, prompt_tokens, completion_tokens,
                 cached_tokens, weighted_tokens, provider_id, request_type, messages, response, cost, latency_ms, ip_address, request_source, user_agent, plugin_meta)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`, usageValues: [req.apiUser.userId, localModelId, req.apiUser.keyId, totalTokens,
                 promptTokens, completionTokens, cachedTokens, calculated.weightedTokens,
                 provider?.id || null, 'responses',
                 typeof input === 'string' ? input : JSON.stringify(input), responseData.output_text || null, pointsToDeduct,
                 null, clientIp(req), clientMetaFromReq(req).requestSource, clientMetaFromReq(req).userAgent,
                 pluginMeta], userId: req.apiUser.userId, pointsToDeduct });
        if (!usageResult.ok) throw new Error(usageResult.error || '用量记录与扣款失败');
              recordQuotaData(req.apiUser.userId, localModelId, totalTokens, calculated.weightedTokens, pointsToDeduct);
            } catch (err) {
              Logger.error('[Responses/Passthru] 用量记录错误:', err);
              if (err.billingFailure) {
                if (!res.headersSent) return res.status(500).json({ error: { message: 'Billing failed; request was not charged.', type: 'server_error' } });
                res.destroy(err);
                return;
              }
            }
          }
          return res.json(responseData);
        } catch (error) {
          lastError = buildUpstreamExceptionError(error, 'openai');
          captureCallError(req, {
            modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'responses',
            status: lastError.status, error, isFinal: !hasMore
          });
          if (hasMore) {
            Logger.warn(`[Responses] 队列回退 attempt=${i + 1}/${modelQueue.length} model=${queueModelId} reason=exception`);
            continue;
          }
          return res.status(lastError.status).json(lastError.body);
        }
      }

      // 非流式：OpenAI / Anthropic 转换（多 Key fallback）
      const liveCallStart = Date.now();
      try {
        let result;
        result = await runWithProviderKeyFallback(provider, res, hasMore, async (pwk, keyOpts) => {
          providerWithKey = pwk;
          const proxyOpts = { suppressErrorResponse: keyOpts.suppressErrorResponse };
          if (provider.format === 'anthropic') {
            return proxyAnthropicForResponses(pwk, upstreamModel, chatBody, res, req, respId, body, proxyOpts);
          }
          return proxyOpenAIForResponses(pwk, upstreamModel, chatBody, res, req, respId, body, proxyOpts);
        });

        if (isProxyErrorResult(result)) {
          recordModelCall(modelConfig.id || model, false);
          recordLiveCallTest(modelConfig.id || model, { ok: false, latency_ms: Date.now() - liveCallStart, error: `HTTP ${result.status}` });
          lastError = { status: result.status, body: result.body, retryable: result.retryable };
          const willRetry = hasMore && result.retryable;
          captureCallError(req, {
            modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'responses',
            status: result.status, body: result.body, latencyMs: Date.now() - liveCallStart, isFinal: !willRetry
          });
          if (willRetry) {
            Logger.warn(`[Responses] 队列回退 attempt=${i + 1}/${modelQueue.length} model=${queueModelId} status=${result.status}`);
            continue;
          }
          return res.status(result.status || 502).json(result.body);
        }

        if (!result) {
          recordModelCall(modelConfig.id || model, false);
          recordLiveCallTest(modelConfig.id || model, { ok: false, latency_ms: Date.now() - liveCallStart, error: 'upstream_error' });
          captureCallError(req, {
            modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'responses',
            status: 502, body: { error: { message: 'upstream_error', type: 'server_error' } },
            latencyMs: Date.now() - liveCallStart, isFinal: true
          });
          return;
        }

        recordModelCall(modelConfig.id || model, true);
        recordLiveCallTest(modelConfig.id || model, {
          ok: true,
          latency_ms: Date.now() - liveCallStart,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens
        });

        const totalTokens = (result.promptTokens || 0) + (result.completionTokens || 0);
        let weightedTokens = 0;
        let pointsCost = 0;
        if (totalTokens > 0) {
          const calculated = calculateCost(modelConfig, result);
          weightedTokens = calculated.weightedTokens;
          pointsCost = calculated.pointsCost;
        }

        if (pointsCost > 0 || totalTokens > 0) {
          try {
            const pointsToDeduct = await adjustBillingCost(weightedTokens, pointsCost, {
              userId: req.apiUser.userId,
              groupId: req.apiUser.groupId,
              model: modelConfig.id || model,
              provider: provider?.id || null,
              requestType: 'responses',
            });
            const pluginMeta = await buildUsagePluginMeta({
              userId: req.apiUser.userId,
              model: modelConfig.id || model,
              provider: provider?.id || null,
              requestType: 'responses',
              apiKeyId: req.apiUser.keyId,
            }, req.body.messages ?? req.body.input, req.body.system ?? req.body.instructions, req);
            const localModelId = modelConfig.id || model;
            const latencyMs = Date.now() - liveCallStart;
            const usageResult = await recordUsageAndDeduct({ pool, usageQuery: `INSERT INTO usage_records (user_id, model_id, api_key_id, tokens_used, prompt_tokens, completion_tokens,
               cached_tokens, weighted_tokens, provider_id, request_type, messages, response, cost, latency_ms, ip_address, request_source, user_agent, plugin_meta)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`, usageValues: [req.apiUser.userId, localModelId, req.apiUser.keyId, totalTokens,
               result.promptTokens || 0, result.completionTokens || 0,
               result.cachedTokens || 0, weightedTokens,
               provider?.id || null, 'responses',
               typeof input === 'string' ? input : JSON.stringify(input), result.content || null, pointsToDeduct,
               latencyMs, clientIp(req), clientMetaFromReq(req).requestSource, clientMetaFromReq(req).userAgent,
               pluginMeta], userId: req.apiUser.userId, pointsToDeduct });
        if (!usageResult.ok) throw new Error(usageResult.error || '用量记录与扣款失败');
            recordQuotaData(req.apiUser.userId, localModelId, totalTokens, weightedTokens, pointsToDeduct);
          } catch (err) {
            Logger.error('[Responses] 用量记录错误:', err);
            if (err.billingFailure) {
              if (!res.headersSent) return res.status(500).json({ error: { message: 'Billing failed; request was not charged.', type: 'server_error' } });
              res.destroy(err);
              return;
            }
          }
        }
        return;
      } catch (error) {
        Logger.error(`[Responses] 代理错误 attempt=${i + 1}/${modelQueue.length}: model=${model}, error=${error.message}`);
        recordModelCall(modelConfig.id || model, false);
        recordLiveCallTest(modelConfig.id || model, { ok: false, latency_ms: Date.now() - liveCallStart, error: error.message });
        lastError = buildUpstreamExceptionError(error, 'openai');
        const willRetry = hasMore && !res.headersSent;
        captureCallError(req, {
          modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'responses',
          status: lastError.status, error, latencyMs: Date.now() - liveCallStart, isFinal: !willRetry
        });
        if (res.headersSent) return;
        if (hasMore && lastError.retryable) continue;
        return res.status(lastError.status).json(lastError.body);
      }
    }

    // 流式：选中第一个可用模型后跳出，走下方原有流式逻辑
    break;
  }

  if (!modelConfig || !provider) {
    if (lastError && !res.headersSent) {
      return res.status(lastError.status || 502).json(lastError.body);
    }
    return res.status(400).json({ error: { message: 'No model selected. Please select a model from the model library first.', type: 'invalid_request_error' } });
  }

  if (!stream) {
    // 非流式已在循环内处理完毕
    if (lastError && !res.headersSent) {
      return res.status(lastError.status || 502).json(lastError.body);
    }
    return;
  }

  Logger.info(`[Responses] 流式使用队列模型 attempt=${selectedQueueIndex + 1}/${modelQueue.length}: ${model} -> ${upstreamModel}`);

  // === Responses 格式供应商直接透传 ===
  // 当上游原生支持 Responses API，直接透传请求体到 /v1/responses
  if (provider.format === 'responses') {
    const baseUrl = cleanBaseUrl(provider.base_url);
    const url = upstreamUrl(baseUrl, '/responses');
    const headers = buildUpstreamHeaders(providerWithKey, req, {
      'Content-Type': 'application/json'
    });
    if (providerWithKey.api_key) headers['Authorization'] = `Bearer ${providerWithKey.api_key}`;

    const upstreamBody = {
      ...body,
      model: upstreamModel,
    };
    // 未开启透传时去掉 reasoning / reasoning_effort，避免误传给上游
    if (!modelConfig.forward_reasoning_effort) {
      delete upstreamBody.reasoning;
      delete upstreamBody.reasoning_effort;
    }
    // 过滤 undefined 字段
    if (!upstreamBody.input) return res.status(400).json({ error: { message: 'input is required', type: 'invalid_request_error' } });

    if (stream) {
      // 流式直接透传
      const liveCallStart = Date.now();
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const upstreamResp = await proxyPool.proxyFetch(url, {
        method: 'POST', headers, body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(UPSTREAM_STREAM_TIMEOUT),
        agent: currentProxyInfo?.agent
      });
      if (!upstreamResp.ok) {
        const err = await upstreamResp.text();
        recordModelCall(modelConfig.id || model, false);
        recordLiveCallTest(modelConfig.id || model, { ok: false, error: `HTTP ${upstreamResp.status}` });
        captureCallError(req, {
          modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'responses',
          status: upstreamResp.status, body: err, isFinal: true
        });
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: respId, object: 'response', status: 'failed', error: { code: 'upstream_error', message: err, type: 'error' } } })}\n\n`);
        res.end();
        return;
      }
      const reader = upstreamResp.body.getReader();
      const decoder = new TextDecoder();
      let totalContent = '';
      let streamUsage = null; // { input_tokens, output_tokens, cached_tokens }
      const streamScrubber = createStreamScrubber(req.apiUser?.injectPrompt);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (!req.apiUser?.injectPrompt) {
            res.write(text);
          }
          for (const line of text.split('\n')) {
            if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
            try {
              const parsed = JSON.parse(line.slice(6));
              if (parsed.type === 'response.output_text.delta') {
                const delta = streamScrubber.feed(parsed.delta || '');
                parsed.delta = delta;
                totalContent += delta;
              }
              if (req.apiUser?.injectPrompt) {
                const eventText = `data: ${JSON.stringify(parsed)}\n\n`;
                res.write(eventText);
              }
              // 优先取上游 usage（response.completed 或带 usage 的事件）
              const u = parsed.response?.usage || parsed.usage || null;
              if (u && (u.input_tokens != null || u.output_tokens != null || u.prompt_tokens != null)) {
                streamUsage = u;
              }
            } catch { /* ignore parse errors in passthrough */ }
          }
        }
        const residual = streamScrubber.flush();
        if (residual && !res.writableEnded) {
          totalContent += residual;
          res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: residual })}\n\n`);
        }
      } finally {
        if (!res.writableEnded) res.end();
      }

      // 计费 + 写入调用记录（此前只扣积分不落库，导致列表/配额不准）
      // 约定：有上游 usage → 精确；无 usage 时 prompt=0、completion≈输出字符/4，并标记 estimated
      let promptTokens = 0;
      let completionTokens = 0;
      let cachedTokens = 0;
      let usageEstimated = false;
      if (streamUsage) {
        promptTokens = streamUsage.input_tokens || streamUsage.prompt_tokens || 0;
        completionTokens = streamUsage.output_tokens || streamUsage.completion_tokens || 0;
        cachedTokens = streamUsage.cached_tokens
          || streamUsage.input_tokens_details?.cached_tokens
          || 0;
      } else if (totalContent.length > 0) {
        // 无 usage 回退：completion-only 粗估（prompt 无法可靠还原，固定 0）
        completionTokens = Math.ceil(totalContent.length / 4);
        promptTokens = 0;
        usageEstimated = true;
      }
      const totalTokens = promptTokens + completionTokens;
      recordModelCall(modelConfig.id || model, true);
      recordLiveCallTest(modelConfig.id || model, {
        ok: true,
        latency_ms: Date.now() - liveCallStart,
        promptTokens,
        completionTokens
      });
      if (totalTokens > 0 || totalContent.length > 0) {
        try {
          const calculated = calculateCost(modelConfig, {
            promptTokens,
            completionTokens,
            cachedTokens
          });
          const localModelId = modelConfig.id || model;
          const pointsToDeduct = await adjustBillingCost(calculated.weightedTokens, calculated.pointsCost, {
            userId: req.apiUser.userId,
            groupId: req.apiUser.groupId,
            model: modelConfig.id || model,
            provider: provider?.id || null,
            requestType: 'responses',
          });
          const pluginMeta = await buildUsagePluginMeta({
            userId: req.apiUser.userId,
            model: modelConfig.id || model,
            provider: provider?.id || null,
            requestType: 'responses',
            apiKeyId: req.apiUser.keyId,
          }, req.body.messages ?? req.body.input, req.body.system ?? req.body.instructions, req);
          const requestParams = usageEstimated
            ? { estimated: true, estimate_method: 'output_chars/4', prompt_tokens_policy: 'zero_when_unknown' }
            : { estimated: false };
          const usageResult = await recordUsageAndDeduct({ pool, usageQuery: `INSERT INTO usage_records (user_id, model_id, api_key_id, tokens_used, prompt_tokens, completion_tokens,
             cached_tokens, weighted_tokens, provider_id, request_type, messages, response, cost, latency_ms, ip_address, request_params, request_source, user_agent, plugin_meta)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`, usageValues: [req.apiUser.userId, localModelId, req.apiUser.keyId, totalTokens,
             promptTokens, completionTokens, cachedTokens, calculated.weightedTokens,
             provider?.id || null, 'responses',
             typeof input === 'string' ? input : JSON.stringify(input), totalContent || null, pointsToDeduct,
             Date.now() - liveCallStart, clientIp(req), JSON.stringify(requestParams),
             clientMetaFromReq(req).requestSource, clientMetaFromReq(req).userAgent,
             pluginMeta], userId: req.apiUser.userId, pointsToDeduct });
        if (!usageResult.ok) throw new Error(usageResult.error || '用量记录与扣款失败');
          recordQuotaData(req.apiUser.userId, localModelId, totalTokens, calculated.weightedTokens, pointsToDeduct);
        } catch (err) {
          Logger.warn(`[Responses/Passthru] 计费/用量记录失败: ${err.message}`);
          if (err.billingFailure) {
            if (!res.headersSent) return res.status(500).json({ error: { message: 'Billing failed; request was not charged.', type: 'server_error' } });
            res.destroy(err);
            return;
          }
        }
      }
      return;
    }

    // 非流式直接透传
    const upstreamResp = await proxyPool.proxyFetch(url, {
      method: 'POST', headers, body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      agent: currentProxyInfo?.agent
    });
    const responseData = await upstreamResp.json();
    if (!upstreamResp.ok) {
      recordModelCall(modelConfig.id || model, false);
      recordLiveCallTest(modelConfig.id || model, { ok: false, error: `HTTP ${upstreamResp.status}` });
      captureCallError(req, {
        modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'responses',
        status: upstreamResp.status, body: responseData, isFinal: true
      });
      return res.status(upstreamResp.status).json(responseData);
    }
    recordModelCall(modelConfig.id || model, true);
    const _pt = responseData.usage?.input_tokens || 0;
    const _ct = responseData.usage?.output_tokens || 0;
    recordLiveCallTest(modelConfig.id || model, { ok: true, promptTokens: _pt, completionTokens: _ct });

    // 计费
    const usage = responseData.usage || {};
    const promptTokens = usage.input_tokens || 0;
    const completionTokens = usage.output_tokens || 0;
    const totalTokens = promptTokens + completionTokens;
    const cachedTokens = usage.cached_tokens || 0;
    const calculated = calculateCost(modelConfig, { promptTokens, completionTokens, cachedTokens });
    const weightedTokens = calculated.weightedTokens;
    const pointsCost = calculated.pointsCost;

    if (totalTokens > 0) {
      try {
        const pointsToDeduct = await adjustBillingCost(weightedTokens, pointsCost, {
          userId: req.apiUser.userId,
          groupId: req.apiUser.groupId,
          model: modelConfig.id || model,
          provider: provider?.id || null,
          requestType: 'responses',
        });
        const pluginMeta = await buildUsagePluginMeta({
          userId: req.apiUser.userId,
          model: modelConfig.id || model,
          provider: provider?.id || null,
          requestType: 'responses',
          apiKeyId: req.apiUser.keyId,
        }, req.body.messages ?? req.body.input, req.body.system ?? req.body.instructions, req);

        const localModelId = modelConfig.id || model;
        const usageResult = await recordUsageAndDeduct({ pool, usageQuery: `INSERT INTO usage_records (user_id, model_id, api_key_id, tokens_used, prompt_tokens, completion_tokens,
           cached_tokens, weighted_tokens, provider_id, request_type, messages, response, cost, latency_ms, ip_address, request_source, user_agent, plugin_meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`, usageValues: [req.apiUser.userId, localModelId, req.apiUser.keyId, totalTokens,
           promptTokens, completionTokens, cachedTokens, weightedTokens,
           provider?.id || null, 'responses',
           typeof input === 'string' ? input : JSON.stringify(input), responseData.output_text || null, pointsToDeduct,
           null, clientIp(req), clientMetaFromReq(req).requestSource, clientMetaFromReq(req).userAgent,
           pluginMeta], userId: req.apiUser.userId, pointsToDeduct });
        if (!usageResult.ok) throw new Error(usageResult.error || '用量记录与扣款失败');
        recordQuotaData(req.apiUser.userId, localModelId, totalTokens, weightedTokens, pointsToDeduct);
      } catch (err) {
        Logger.error('[Responses/Passthru] 用量记录错误:', err);
        if (err.billingFailure) {
          if (!res.headersSent) return res.status(500).json({ error: { message: 'Billing failed; request was not charged.', type: 'server_error' } });
          res.destroy(err);
          return;
        }
      }
    }

    res.json(responseData);
    return;
  }

  const liveCallStart = Date.now();
  try {
    let result;
    if (stream) {
      // 流式模式
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const writeWithDrain = (data) => {
        if (res.writableEnded) return false;
        const ok = res.write(data);
        return ok;
      };
      const waitForDrain = () => new Promise(resolve => {
        res.once('drain', resolve);
        req.once('close', resolve);
      });

      if (provider.format === 'anthropic') {
        // Anthropic 流式
        const baseUrl = cleanBaseUrl(provider.base_url);
        const url = upstreamUrl(baseUrl, '/messages');
        const headers = buildUpstreamHeaders(providerWithKey, req, {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        });
        if (providerWithKey.api_key) headers['x-api-key'] = providerWithKey.api_key;

        const systemMessage = messages.find(m => m.role === 'system');
        const nonSystemMessages = messages.filter(m => m.role !== 'system');
        const upstreamBody = {
          model: upstreamModel, max_tokens: max_output_tokens || 4096,
          messages: nonSystemMessages.map(m => ({ role: m.role, content: m.content })),
          stream: true
        };
        if (systemMessage) upstreamBody.system = systemMessage.content;
        if (temperature !== undefined) upstreamBody.temperature = temperature;
        if (top_p !== undefined) upstreamBody.top_p = top_p;
        if (chatBody.stop) upstreamBody.stop_sequences = Array.isArray(chatBody.stop) ? chatBody.stop : [chatBody.stop];
        if (chatTools) {
          upstreamBody.tools = chatTools.map(t => ({
            name: t.function?.name, description: t.function?.description, input_schema: t.function?.parameters
          }));
        }

        const response = await proxyPool.proxyFetch(url, {
          method: 'POST', headers, body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(UPSTREAM_STREAM_TIMEOUT),
          agent: currentProxyInfo?.agent
        });
        if (!response.ok) {
          const err = await response.text();
          Logger.error(`[Responses/Anthropic] 上游错误: status=${response.status}`);
          captureCallError(req, {
            modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'responses',
            status: response.status, body: err, isFinal: true
          });
          res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: respId, object: 'response', status: 'failed', error: { code: 'upstream_error', message: err, type: 'error' } } })}\n\n`);
          res.end();
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        result = await streamAnthropicAsResponses(reader, decoder, res, req, respId, upstreamModel, body, writeWithDrain, waitForDrain);
      } else {
        // OpenAI 流式
        const baseUrl = cleanBaseUrl(provider.base_url);
        const url = upstreamUrl(baseUrl, '/chat/completions');
        const headers = buildUpstreamHeaders(providerWithKey, req, {
          'Content-Type': 'application/json'
        });
        if (providerWithKey.api_key) headers['Authorization'] = `Bearer ${providerWithKey.api_key}`;

        const response = await proxyPool.proxyFetch(url, {
          method: 'POST', headers, body: JSON.stringify(chatBody),
          signal: AbortSignal.timeout(UPSTREAM_STREAM_TIMEOUT),
          agent: currentProxyInfo?.agent
        });
        if (!response.ok) {
          const err = await response.text();
          Logger.error(`[Responses/OpenAI] 上游错误: status=${response.status}`);
          captureCallError(req, {
            modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'responses',
            status: response.status, body: err, isFinal: true
          });
          res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: respId, object: 'response', status: 'failed', error: { code: 'upstream_error', message: err, type: 'error' } } })}\n\n`);
          res.end();
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        result = await streamOpenAIAsResponses(reader, decoder, res, req, respId, upstreamModel, body, writeWithDrain, waitForDrain);
      }

      res.end();
    } else {
      // 非流式模式
      if (provider.format === 'anthropic') {
        result = await proxyAnthropicForResponses(providerWithKey, upstreamModel, chatBody, res, req, respId, body);
      } else {
        result = await proxyOpenAIForResponses(providerWithKey, upstreamModel, chatBody, res, req, respId, body);
      }
    }

    if (!result) {
      recordModelCall(modelConfig.id || model, false);
      recordLiveCallTest(modelConfig.id || model, { ok: false, latency_ms: Date.now() - liveCallStart, error: 'upstream_error' });
      captureCallError(req, {
        modelId: modelConfig.id || model, providerId: provider?.id, requestType: 'responses',
        status: 502, body: { error: { message: 'upstream_error', type: 'server_error' } },
        latencyMs: Date.now() - liveCallStart, isFinal: true
      });
      return;
    }
    recordModelCall(modelConfig.id || model, true);
    recordLiveCallTest(modelConfig.id || model, {
      ok: true,
      latency_ms: Date.now() - liveCallStart,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens
    });

    // 记录使用量
    const totalTokens = (result.promptTokens || 0) + (result.completionTokens || 0);
    let weightedTokens = 0;
    let pointsCost = 0;
    if (totalTokens > 0) {
      const calculated = calculateCost(modelConfig, result);
      weightedTokens = calculated.weightedTokens || 0;
      pointsCost = calculated.pointsCost || 0;
    }

    if (pointsCost > 0 || totalTokens > 0) {
      try {
        const pointsToDeduct = await adjustBillingCost(weightedTokens, pointsCost, {
          userId: req.apiUser.userId,
          groupId: req.apiUser.groupId,
          model: modelConfig.id || model,
          provider: provider?.id || null,
          requestType: 'responses',
        });
        const pluginMeta = await buildUsagePluginMeta({
          userId: req.apiUser.userId,
          model: modelConfig.id || model,
          provider: provider?.id || null,
          requestType: 'responses',
          apiKeyId: req.apiUser.keyId,
        }, req.body.messages ?? req.body.input, req.body.system ?? req.body.instructions, req);

        const localModelId = modelConfig.id || model;
        const latencyMs = typeof liveCallStart === 'number' ? Date.now() - liveCallStart : null;
        const usageResult = await recordUsageAndDeduct({ pool, usageQuery: `INSERT INTO usage_records (user_id, model_id, api_key_id, tokens_used, prompt_tokens, completion_tokens,
           cached_tokens, weighted_tokens, provider_id, request_type, messages, response, cost, latency_ms, ip_address, request_source, user_agent, plugin_meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`, usageValues: [req.apiUser.userId, localModelId, req.apiUser.keyId, totalTokens,
           result.promptTokens || 0, result.completionTokens || 0,
           result.cachedTokens || 0, weightedTokens,
           provider?.id || null, 'responses',
           typeof input === 'string' ? input : JSON.stringify(input), result.content || null, pointsToDeduct,
           latencyMs, clientIp(req), clientMetaFromReq(req).requestSource, clientMetaFromReq(req).userAgent,
           pluginMeta], userId: req.apiUser.userId, pointsToDeduct });
        if (!usageResult.ok) throw new Error(usageResult.error || '用量记录与扣款失败');
        recordQuotaData(req.apiUser.userId, localModelId, totalTokens, weightedTokens, pointsToDeduct);
      } catch (err) {
        Logger.error('[Responses] 用量记录错误:', err);
        if (err.billingFailure) {
          if (!res.headersSent) return res.status(500).json({ error: { message: 'Billing failed; request was not charged.', type: 'server_error' } });
          res.destroy(err);
          return;
        }
      }
    }
  } catch (error) {
    Logger.error(`[Responses] 代理错误: provider=${provider.id}, model=${model}, error=${error.message}`);
    recordModelCall(modelConfig.id || model, false);
    recordLiveCallTest(modelConfig.id || model, {
      ok: false,
      latency_ms: typeof liveCallStart === 'number' ? Date.now() - liveCallStart : undefined,
      error: error.message
    });
    const mapped = buildUpstreamExceptionError(error, 'openai');
    captureCallError(req, {
      modelId: modelConfig?.id || model, providerId: provider?.id, requestType: 'responses',
      status: mapped.status, error,
      latencyMs: typeof liveCallStart === 'number' ? Date.now() - liveCallStart : undefined,
      isFinal: true
    });
    if (!res.headersSent) {
      res.status(mapped.status).json(mapped.body);
    }
  }
}

// 缓存状态 API
router.get('/cache/status', requireAuth, requireAdmin, (req, res) => {
  try {
    const status = getCacheStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    Logger.error(`[CacheStatus] 获取缓存状态失败: ${error.message}`);
    res.status(500).json({
      success: false,
      error: '获取缓存状态失败'
    });
  }
});

// 重置缓存统计
router.post('/cache/reset', requireAuth, requireAdmin, (req, res) => {
  try {
    resetCacheStats();
    Logger.info('[CacheStats] 缓存统计已重置');
    res.json({
      success: true,
      message: '缓存统计已重置'
    });
  } catch (error) {
    Logger.error(`[CacheStats] 重置缓存统计失败: ${error.message}`);
    res.status(500).json({
      success: false,
      error: '重置缓存统计失败'
    });
  }
});

// 导出缓存失效函数与路由解析供其他模块 / 测试使用
module.exports = router;
module.exports.invalidateUserApiKeyCache = invalidateUserApiKeyCache;
module.exports.invalidateApiKeyCacheByKeyId = invalidateApiKeyCacheByKeyId;
module.exports.resolveModelQueue = resolveModelQueue;
module.exports.resolveModelQueueForRequest = resolveModelQueueForRequest;
module.exports.validateApiKey = validateApiKey;
module.exports.affinityKeyForRequest = affinityKeyForRequest;
module.exports.addFourthCacheBreakpoint = addFourthCacheBreakpoint;
