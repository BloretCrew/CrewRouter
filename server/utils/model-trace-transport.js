'use strict';

const { upstreamUrl, validateUrl } = require('./url-validator');
const { normalizeUsageTokens } = require('./token-normalize');
const MAX_BODY = 256 * 1024;

function requestSpec(target, prompt, key) {
  const format = target.protocol;
  const headers = { 'Content-Type': 'application/json' };
  let path;
  let body;
  if (format === 'anthropic') {
    path = '/messages';
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    body = { model: target.upstream_model_id, messages: [{ role: 'user', content: prompt }], max_tokens: target.max_output_tokens, stream: false };
  } else {
    headers.Authorization = `Bearer ${key}`;
    path = format === 'responses' ? '/responses' : '/chat/completions';
    body = format === 'responses'
      ? { model: target.upstream_model_id, input: prompt, max_output_tokens: target.max_output_tokens, stream: false }
      : { model: target.upstream_model_id, messages: [{ role: 'user', content: prompt }], max_tokens: target.max_output_tokens, stream: false };
  }
  return { path, headers, body };
}

function responseModel(value, secrets = []) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(name)
      || /(?:sk-|bearer|api[_-]?key|token|secret|password)/i.test(name)
      || secrets.some(secret => typeof secret === 'string' && secret && name.includes(secret))) return null;
  return name;
}

function parseResponse(data, format, secrets = []) {
  const text = format === 'anthropic' ? (data.content || []).map(item => item.text || '').join('')
    : format === 'responses' ? (data.output_text || (data.output || []).flatMap(item => item.content || []).map(item => item.text || '').join(''))
      : data.choices?.[0]?.message?.content;
  let usage = null;
  if (data.usage && typeof data.usage === 'object') {
    const input = data.usage.prompt_tokens ?? data.usage.input_tokens;
    const output = data.usage.completion_tokens ?? data.usage.output_tokens;
    if ([input, output].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 10000000)) {
      const raw = format === 'responses'
        ? { ...data.usage, cached_tokens: data.usage.input_tokens_details?.cached_tokens ?? data.usage.cached_tokens }
        : data.usage;
      const normalized = normalizeUsageTokens(raw, format);
      if ([normalized.promptTokens, normalized.completionTokens, normalized.cachedTokens].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 10000000)) {
        usage = normalized;
      }
    }
  }
  let error = null;
  if (format === 'anthropic') {
    if (data.stop_reason === 'max_tokens') error = '上游回答因输出 Token 上限截断';
    if (data.stop_reason === 'refusal' || (data.content || []).some(item => item.type === 'refusal')) error = '上游拒绝回答';
  } else if (format === 'responses') {
    if (data.status === 'incomplete' || data.incomplete_details || (data.output || []).some(item => item.status === 'incomplete')) error = '上游回答未完整生成';
    if ((data.output || []).some(item => item.type === 'refusal' || (item.content || []).some(part => part.type === 'refusal' || part.refusal))) error = '上游拒绝回答';
    if (data.status === 'failed' || data.error) error = '上游生成失败';
  } else {
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') error = '上游回答因输出 Token 上限截断';
    if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) error = '上游拒绝回答或内容被过滤';
  }
  return { text: typeof text === 'string' ? text : '', usage, error, response_model: responseModel(data.model, secrets) };
}

async function transport({ target, model, key, prompt, signal, beforeSend }) {
  const proxyPool = require('../proxy-pool');
  const spec = requestSpec(target, prompt, key);
  const userAgent = String(model.test_user_agent || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, 500);
  if (userAgent) spec.headers['User-Agent'] = userAgent;
  const url = upstreamUrl(model.base_url, spec.path);
  const checked = await validateUrl(url, { allowPrivate: false });
  if (!checked.ok) throw new Error('供应商 URL 未通过安全校验');
  const proxy = await proxyPool.getProxyAgent(model);
  if (!await beforeSend()) throw new Error('检测已取消');
  const response = await proxyPool.proxyFetch(checked.url.toString(), {
    method: 'POST', headers: spec.headers, body: JSON.stringify(spec.body), signal, agent: proxy?.agent,
    requestContext: { requestId: require('crypto').randomUUID(), purpose: 'model_trace', upstreamAttempts: 0, signal }
  });
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error('上游响应超过体积限制');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let data;
  try { data = JSON.parse(raw); }
  catch (_) {
    if (!response.ok) return { text: '', usage: null, error: `上游 HTTP ${response.status}`, response_model: null,
      definite_rejection: [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status) };
    throw new Error('上游响应不是有效 JSON');
  }
  const parsed = parseResponse(data, target.protocol, [key]);
  if (!response.ok) {
    parsed.text = '';
    parsed.error = `上游 HTTP ${response.status}`;
    parsed.definite_rejection = !parsed.usage && [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status);
  }
  if (parsed.usage && (parsed.usage.promptTokens > 4096 || parsed.usage.completionTokens > target.max_output_tokens)) {
    parsed.usage = null;
    parsed.error = '上游报告用量超过确认预算，用量无法可靠结算';
  }
  return parsed;
}

module.exports = { transport, requestSpec, parseResponse };
