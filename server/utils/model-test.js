const crypto = require('crypto');
const { pool } = require('../models/database');
const { calculateCost } = require('./billing');
const { deductPoints } = require('./balance');
const { recordQuotaData } = require('./quota-data');
const Logger = require('../logger');
const { buildKeyAttemptOrder, getPrimaryApiKey } = require('./provider-keys');
const { cleanBaseUrl, validateUrl } = require('./url-validator');
const proxyPool = require('../proxy-pool');

/** 模型测试用 UA：去换行、截断，避免请求头注入 */
function normalizeTestUserAgent(value) {
  if (value == null) return '';
  return String(value).replace(/[\r\n\0]/g, ' ').trim().slice(0, 500);
}

function buildTestUrl(baseUrl, format) {
  const root = cleanBaseUrl(baseUrl);
  if (format === 'anthropic') return `${root}/v1/messages`;
  if (format === 'responses') return `${root}/v1/responses`;
  return `${root}/v1/chat/completions`;
}

function buildTestBody(upstreamModel, format) {
  if (format === 'anthropic') {
    return {
      model: upstreamModel,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5,
      stream: false
    };
  }
  if (format === 'responses') {
    return {
      model: upstreamModel,
      input: 'Hi',
      max_output_tokens: 5,
      stream: false
    };
  }
  return {
    model: upstreamModel,
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 5,
    stream: false
  };
}

function extractTestUsage(data, format) {
  const usage = data?.usage || {};
  if (format === 'anthropic') {
    return {
      promptTokens: usage.input_tokens || 0,
      completionTokens: usage.output_tokens || 0,
      cachedTokens: usage.cache_read_input_tokens || 0,
      hasUsage: !!data?.usage
    };
  }
  if (format === 'responses') {
    const input = usage.input_tokens || usage.prompt_tokens || 0;
    const output = usage.output_tokens || usage.completion_tokens || 0;
    return {
      promptTokens: input,
      completionTokens: output,
      cachedTokens: usage.input_tokens_details?.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0,
      hasUsage: !!data?.usage
    };
  }
  return {
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens || 0,
    hasUsage: !!data?.usage
  };
}

function extractTestContent(data, format) {
  if (format === 'anthropic') {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    return blocks.map(b => b?.text || '').join('');
  }
  if (format === 'responses') {
    if (typeof data?.output_text === 'string') return data.output_text;
    const items = Array.isArray(data?.output) ? data.output : [];
    return items.flatMap(item => Array.isArray(item?.content) ? item.content : [])
      .map(part => part?.text || '').join('');
  }
  return data?.choices?.[0]?.message?.content || '';
}

function summarizeUpstreamError(status, text, url) {
  const raw = String(text || '').trim();
  if (/^<!DOCTYPE|<html/i.test(raw)) {
    return `HTTP ${status}: 上游返回了 HTML 页面（路径通常不正确） url=${url}`;
  }
  return `HTTP ${status}: ${raw.slice(0, 200)}`;
}

function isOpenCodeZenUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)opencode\.ai$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function applyOpenCodeTestHeaders(headers, testUserAgent) {
  if (!headers['x-opencode-client']) headers['x-opencode-client'] = 'cli';
  if (!headers['x-opencode-session']) headers['x-opencode-session'] = `cr-test-${crypto.randomUUID()}`;
  if (!headers['x-opencode-request']) headers['x-opencode-request'] = `cr-test-${crypto.randomUUID()}`;
  if (!headers['User-Agent']) {
    headers['User-Agent'] = testUserAgent || 'opencode/latest/cli';
  }
}

async function saveTestResult(modelId, result) {
  try {
    await pool.query(`
      INSERT INTO model_test_results (model_id, ok, latency_ms, tokens_per_second, total_tokens, error, tested_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (model_id) DO UPDATE SET
        ok = EXCLUDED.ok,
        latency_ms = EXCLUDED.latency_ms,
        tokens_per_second = EXCLUDED.tokens_per_second,
        total_tokens = EXCLUDED.total_tokens,
        error = EXCLUDED.error,
        tested_at = NOW()
    `, [modelId, result.ok, result.latency_ms || null, result.tokens_per_second || null, result.total_tokens || null, result.error || null]);
  } catch (err) {
    Logger.warn(`[模型测试] 保存测试结果失败: ${err.message}`);
  }
}

/**
 * 将真实代理调用结果计入 model_test_results（与手动「测试」共用同一表）
 * fire-and-forget，不抛错、不阻塞主请求
 * @param {string} modelId
 * @param {{ ok: boolean, latency_ms?: number, promptTokens?: number, completionTokens?: number, totalTokens?: number, error?: string }} opts
 */
function recordLiveCallTest(modelId, opts = {}) {
  if (!modelId || typeof modelId !== 'string') return;
  const ok = !!opts.ok;
  const latencyMs = opts.latency_ms != null ? Math.max(0, Math.round(opts.latency_ms)) : null;
  const completionTokens = Math.max(0, parseInt(opts.completionTokens, 10) || 0);
  const promptTokens = Math.max(0, parseInt(opts.promptTokens, 10) || 0);
  const totalTokens = opts.totalTokens != null
    ? Math.max(0, parseInt(opts.totalTokens, 10) || 0)
    : (promptTokens + completionTokens) || null;
  let tps = null;
  if (ok && latencyMs != null && latencyMs > 0 && completionTokens > 0) {
    tps = Math.round((completionTokens / (latencyMs / 1000)) * 10) / 10;
  }
  // 不 await
  saveTestResult(modelId, {
    ok,
    latency_ms: latencyMs,
    tokens_per_second: tps,
    total_tokens: totalTokens,
    error: ok ? null : (opts.error || 'upstream_error')
  });
}

function failResult(modelMeta, error) {
  return {
    ok: false,
    error,
    model: modelMeta?.name || modelMeta?.id || null,
    provider: modelMeta?.provider_name || null,
    provider_id: modelMeta?.provider_id || null,
    provider_url: modelMeta?.base_url ? String(modelMeta.base_url).replace(/\/+$/, '') : null,
  };
}

async function testModel(modelId, userId) {
  // 先查模型元信息（不限 enabled），失败时也能返回模型名
  const metaResult = await pool.query(
    `SELECT m.id, m.name, m.upstream_model_id, m.enabled AS model_enabled, m.model_multiplier,
            p.id AS provider_id, p.name AS provider_name, p.enabled AS provider_enabled,
            p.base_url, p.api_key, p.api_keys, p.api_key_select_mode, p.format,
            p.test_user_agent, p.proxy_enabled, p.proxy_mode, p.proxy_url, p.proxy_use_system, p.proxy_pool
     FROM models m
     LEFT JOIN providers p ON m.provider = p.id
     WHERE m.id = $1`,
    [modelId]
  );

  if (metaResult.rows.length === 0) {
    const r = failResult({ id: modelId, name: modelId }, '模型不存在或已禁用');
    await saveTestResult(modelId, r);
    return r;
  }

  const model = metaResult.rows[0];
  const baseUrl = model.base_url?.replace(/\/+$/, '') || '';
  const modelMeta = {
    id: model.id,
    name: model.name || model.id,
    provider_name: model.provider_name || null,
    provider_id: model.provider_id || null,
    base_url: baseUrl || null,
  };

  if (!model.model_enabled) {
    const r = failResult(modelMeta, '模型已禁用');
    await saveTestResult(modelId, r);
    return r;
  }
  if (!model.provider_id) {
    const r = failResult(modelMeta, '模型未关联供应商');
    await saveTestResult(modelId, r);
    return r;
  }
  if (!model.provider_enabled) {
    const r = failResult(modelMeta, '供应商已禁用');
    await saveTestResult(modelId, r);
    return r;
  }

  const testUserAgent = normalizeTestUserAgent(model.test_user_agent);
  const format = String(model.format || 'openai').toLowerCase();
  const upstreamModel = model.upstream_model_id || model.name || model.id;
  const url = baseUrl ? buildTestUrl(baseUrl, format) : '';
  Logger.info(`[模型测试] modelId=${modelId} name=${model.name} upstream=${upstreamModel} provider=${model.provider_name}(${model.provider_id}) format=${format} url=${url} ua=${testUserAgent ? 'custom' : 'default'} userId=${userId}`);

  if (!baseUrl) {
    const r = failResult(modelMeta, '供应商未配置 Base URL');
    await saveTestResult(modelId, r);
    return r;
  }

  const urlCheck = await validateUrl(url, { allowPrivate: false });
  if (!urlCheck.ok) {
    const r = failResult(modelMeta, `URL 校验失败: ${urlCheck.error}`);
    await saveTestResult(modelId, r);
    return r;
  }

  const testBody = buildTestBody(upstreamModel, format);
  let proxyInfo = null;
  try {
    proxyInfo = await proxyPool.getProxyAgent(model);
  } catch (e) {
    Logger.warn(`[模型测试] 获取代理失败，改为直连: ${e.message}`);
  }
  const doFetch = (reqUrl, opts) => (proxyInfo?.agent
    ? proxyPool.proxyFetch(reqUrl, { ...opts, agent: proxyInfo.agent })
    : fetch(reqUrl, opts));

  const start = Date.now();
  const keyAttempts = buildKeyAttemptOrder(model);
  const keys = keyAttempts.length ? keyAttempts : (getPrimaryApiKey(model) ? [getPrimaryApiKey(model)] : ['']);

  let response = null;
  let lastFetchError = null;
  for (let ki = 0; ki < keys.length; ki++) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${keys[ki]}`
    };
    if (format === 'anthropic') {
      headers['x-api-key'] = keys[ki];
      headers['anthropic-version'] = '2023-06-01';
    }
    if (testUserAgent) headers['User-Agent'] = testUserAgent;
    if (isOpenCodeZenUrl(url)) applyOpenCodeTestHeaders(headers, testUserAgent);
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(testBody),
        signal: AbortSignal.timeout(30000)
      });
      lastFetchError = null;
    } catch (e) {
      lastFetchError = e;
      response = null;
      if (ki < keys.length - 1) {
        Logger.warn(`[模型测试] Key ${ki + 1}/${keys.length} 连接失败，切换: ${e.message}`);
        continue;
      }
      break;
    }
    if (response.ok) break;
    if (ki < keys.length - 1 && (response.status === 429 || response.status >= 500 || response.status === 401 || response.status === 403)) {
      Logger.warn(`[模型测试] Key ${ki + 1}/${keys.length} HTTP ${response.status}，切换下一 Key`);
      continue;
    }
    break;
  }

  if (!response) {
    const elapsed = Date.now() - start;
    const r = failResult(modelMeta, `连接失败 (${elapsed}ms): ${lastFetchError?.message || 'unknown'}`);
    await saveTestResult(modelId, r);
    return r;
  }

  const latency = Date.now() - start;

  if (!response.ok) {
    let errorText = '';
    try { errorText = await response.text(); } catch (_) {}
    const r = failResult(modelMeta, summarizeUpstreamError(response.status, errorText, url));
    await saveTestResult(modelId, r);
    return r;
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    const r = failResult(modelMeta, `响应解析失败: ${e.message}`);
    await saveTestResult(modelId, r);
    return r;
  }

  const usageInfo = extractTestUsage(data, format);
  const content = extractTestContent(data, format);
  if (!usageInfo.hasUsage && !String(content || '').trim()) {
    const r = failResult(modelMeta, '响应缺少 usage 信息，且没有返回内容');
    await saveTestResult(modelId, r);
    return r;
  }

  const promptTokens = usageInfo.promptTokens;
  const completionTokens = usageInfo.completionTokens;
  const totalTokens = promptTokens + completionTokens;
  const cachedTokens = usageInfo.cachedTokens;

  const durationSec = latency / 1000;
  const tokensPerSecond = durationSec > 0 ? (completionTokens / durationSec) : 0;

  const modelConfig = { model_multiplier: model.model_multiplier };
  const tokenUsage = { promptTokens, completionTokens, cachedTokens };
  const costInfo = calculateCost(modelConfig, tokenUsage);

  const deductResult = await deductPoints(userId, costInfo.pointsCost);
  if (!deductResult.ok) {
    const r = failResult(modelMeta, deductResult.error || '积分不足');
    await saveTestResult(modelId, r);
    return r;
  }

  recordQuotaData(userId, model.name, totalTokens, costInfo.weightedTokens, costInfo.pointsCost);

  const r = {
    ok: true,
    model: model.name,
    provider: model.provider_name,
    provider_id: model.provider_id,
    provider_url: baseUrl,
    latency_ms: latency,
    tokens_per_second: Math.round(tokensPerSecond * 10) / 10,
    total_tokens: totalTokens,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    content_preview: content.slice(0, 100),
    cost: Math.round(costInfo.pointsCost * 1000000) / 1000000
  };

  await saveTestResult(modelId, r);
  return r;
}

async function testModelsBatch(modelIds, userId) {
  const results = [];
  const concurrency = 10;

  for (let i = 0; i < modelIds.length; i += concurrency) {
    const batch = modelIds.slice(i, i + concurrency);
    const promises = batch.map(id =>
      testModel(id, userId).then(r => ({ modelId: id, ...r }))
    );
    const settled = await Promise.allSettled(promises);
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      const id = batch[j];
      if (s.status === 'fulfilled') {
        results.push(s.value);
      } else {
        results.push({
          modelId: id,
          ok: false,
          model: id,
          error: s.reason?.message || '未知错误'
        });
      }
    }
  }

  return results;
}

module.exports = { testModel, testModelsBatch, saveTestResult, recordLiveCallTest, normalizeTestUserAgent, cleanBaseUrl, buildTestUrl };
