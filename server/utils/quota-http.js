'use strict';

const proxyPool = require('../proxy-pool');

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isLikelyBlockedOfficialHost(url) {
  const host = hostnameOf(url);
  return /(^|\.)chatgpt\.com$|(^|\.)auth\.openai\.com$|(^|\.)chat\.openai\.com$/.test(host);
}

function isNetworkError(err) {
  if (!err) return false;
  const name = err.name || '';
  const code = err.code || err.cause?.code || '';
  const message = `${err.message || ''} ${err.cause?.message || ''}`;
  return name === 'TimeoutError'
    || name === 'AbortError'
    || ['ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)
    || /fetch failed|timeout|timed out|aborted|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(message);
}

function describeNetworkError(err, url) {
  const host = hostnameOf(url) || url;
  const raw = err?.cause?.message || err?.message || String(err || '网络错误');
  if (/timeout|ETIMEDOUT|aborted/i.test(raw) || err?.name === 'TimeoutError') {
    return `无法连接 ${host}（连接超时）。官方额度接口需要能访问该站点，请为供应商启用代理或配置可用的系统代理`;
  }
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i.test(raw)) {
    return `无法连接 ${host}（${raw}）。请检查网络，或为该供应商启用代理 / 配置系统代理`;
  }
  return raw;
}

async function listQuotaProxies(provider) {
  const seen = new Set();
  const list = [];
  const push = (item) => {
    if (!item?.agent || !item.proxyUrl || seen.has(item.proxyUrl)) return;
    seen.add(item.proxyUrl);
    list.push(item);
  };

  push(await proxyPool.getProxyAgent(provider));

  const sys = await proxyPool.getSystemProxyConfig();
  if (proxyPool.isValidProxyUrl(sys.url)) {
    push({
      agent: proxyPool.createProxyAgent(sys.url),
      proxyId: 'system:quota',
      proxyUrl: sys.url,
    });
  }
  return list;
}

async function sendOnce(url, init, agent) {
  if (agent) {
    return proxyPool.proxyFetch(url, { ...init, agent });
  }
  return fetch(url, init);
}

/**
 * 官方额度接口请求：直连优先（Grok 等可达站点），chatgpt.com 这类常被墙的域名
 * 若已配置供应商/系统代理则先走代理，避免空等超时。
 */
async function quotaRequest(url, init, provider = {}) {
  const proxies = await listQuotaProxies(provider);
  const preferProxy = isLikelyBlockedOfficialHost(url) && proxies.length > 0;
  const attempts = preferProxy
    ? [...proxies.map((item) => item.agent), null]
    : [null, ...proxies.map((item) => item.agent)];

  let lastError;
  for (const agent of attempts) {
    try {
      return await sendOnce(url, init, agent);
    } catch (err) {
      lastError = err;
      if (!isNetworkError(err)) throw err;
    }
  }
  throw Object.assign(new Error(describeNetworkError(lastError, url)), {
    cause: lastError,
    code: lastError?.code,
  });
}

module.exports = {
  quotaRequest,
  isNetworkError,
  describeNetworkError,
  isLikelyBlockedOfficialHost,
};
