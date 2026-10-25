/**
 * 代理池管理模块
 *
 * 功能：
 * - 管理每个供应商的代理池（HTTP/SOCKS5 代理）
 * - 支持两种模式：静态列表 + 订阅地址实时拉取
 * - 智能选择最佳代理（排除最近 429 的代理）
 * - 429 限速时自动标记并切换
 */

const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { Readable } = require('stream');
const net = require('node:net');
const Logger = require('./logger');
const pool = require('./models/database').pool;
const { validateUrl } = require('./utils/url-validator');
const { createPinnedHttpAgents } = require('./utils/pinned-http-agents');
const { combineAbortSignals, releaseCombinedAbortSignal } = require('./utils/request-lifecycle');

// 代理状态缓存：providerId -> proxyId -> 运行时状态
const runtimeState = new Map();

// 订阅地址缓存：providerId -> { proxies, fetchedAt }
const subscriptionCache = new Map();
const SUBSCRIPTION_CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存
const affinityRoutes = new Map();
const AFFINITY_MAX_KEYS = 1000;

function redactSubscriptionUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}/…`;
  } catch {
    return '[invalid URL]';
  }
}

function affinityRouteKey(providerId, affinityKey) {
  return `${providerId}:${affinityKey}`;
}

function rememberAffinity(key, proxyIndex) {
  if (affinityRoutes.has(key)) affinityRoutes.delete(key);
  affinityRoutes.set(key, proxyIndex);
  while (affinityRoutes.size > AFFINITY_MAX_KEYS) {
    affinityRoutes.delete(affinityRoutes.keys().next().value);
  }
}

/**
 * 解析代理池 JSON
 */
function parseProxyPool(proxyPoolJson) {
  try {
    if (Array.isArray(proxyPoolJson)) return proxyPoolJson;
    if (typeof proxyPoolJson === 'string') return JSON.parse(proxyPoolJson);
    return [];
  } catch {
    return [];
  }
}

/**
 * 获取运行时状态
 */
function getRuntimeState(providerId, proxyId) {
  if (!runtimeState.has(providerId)) {
    runtimeState.set(providerId, new Map());
  }
  const providerState = runtimeState.get(providerId);
  if (!providerState.has(proxyId)) {
    providerState.set(proxyId, {
      failCount: 0,
      last429At: null
    });
  }
  return providerState.get(proxyId);
}

/**
 * 从订阅地址拉取代理列表（带缓存）
 *
 * @param {string} subscriptionUrl - 订阅地址
 * @param {string} providerId - 供应商 ID（用于缓存 key）
 * @returns {Array} 代理列表 [{ id, url, enabled }]
 */
async function fetchSubscriptionProxies(subscriptionUrl, providerId) {
  // SSRF 校验
  const urlCheck = await validateUrl(subscriptionUrl);
  if (!urlCheck.ok) {
    Logger.warn(`[ProxyPool] 订阅地址安全校验失败: ${urlCheck.error} (${redactSubscriptionUrl(subscriptionUrl)})`);
    return [];
  }

  // 检查缓存是否有效
  const cached = subscriptionCache.get(providerId);
  if (cached && (Date.now() - cached.fetchedAt) < SUBSCRIPTION_CACHE_TTL) {
    return cached.proxies;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await pinnedFetchValidated(urlCheck, { signal: controller.signal, redirect: 'manual' });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        Logger.warn(`[ProxyPool] 订阅地址获取失败: HTTP ${response.status} (${redactSubscriptionUrl(subscriptionUrl)})`);
        return cached ? cached.proxies : [];
      }

      // 限制响应体 1MB，并让同一超时覆盖响应头和完整响应体读取。
      const MAX_BYTES = 1024 * 1024;
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      if (contentLength > MAX_BYTES) {
        await response.body?.cancel().catch(() => {});
        Logger.warn(`[ProxyPool] 订阅内容超过 1 MiB (${redactSubscriptionUrl(subscriptionUrl)})`);
        return cached ? cached.proxies : [];
      }
      if (!response.body) return cached ? cached.proxies : [];

      const reader = response.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_BYTES) {
          await reader.cancel().catch(() => {});
          Logger.warn(`[ProxyPool] 订阅内容超过 1 MiB (${redactSubscriptionUrl(subscriptionUrl)})`);
          return cached ? cached.proxies : [];
        }
        chunks.push(value);
      }
      const text = new TextDecoder().decode(Buffer.concat(chunks));

      const proxies = text.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && l.match(/^(https?|socks[45]?h?):\/\//i))
        .map(url => ({ id: uuidv4(), url, enabled: true }));

      // 更新缓存
      subscriptionCache.set(providerId, { proxies, fetchedAt: Date.now() });

      if (proxies.length > 0) {
        Logger.info(`[ProxyPool] 订阅地址拉取成功: ${proxies.length} 个代理 (${redactSubscriptionUrl(subscriptionUrl)})`);
      }
      return proxies;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    Logger.warn(`[ProxyPool] 订阅地址拉取异常: ${error.message} (${redactSubscriptionUrl(subscriptionUrl)})`);
    return cached ? cached.proxies : [];
  }
}

/**
 * 从全局设置读取代理池配置
 */
async function getGlobalProxyPoolConfig() {
  try {
    const result = await pool.query("SELECT key, value FROM settings WHERE key IN ('proxy_pool_subscription_url', 'proxy_pool_manual_proxies')");
    const config = { subscriptionUrl: '', manualProxies: [] };
    for (const row of result.rows) {
      try {
        if (row.key === 'proxy_pool_subscription_url') {
          config.subscriptionUrl = JSON.parse(row.value) || '';
        } else if (row.key === 'proxy_pool_manual_proxies') {
          config.manualProxies = JSON.parse(row.value) || [];
        }
      } catch {
        if (row.key === 'proxy_pool_subscription_url') config.subscriptionUrl = row.value;
      }
    }
    return config;
  } catch (err) {
    Logger.warn(`[ProxyPool] 读取全局代理池设置失败: ${err.message}`);
    return { subscriptionUrl: '', manualProxies: [] };
  }
}

/**
 * 从全局设置读取系统单代理配置
 * settings:
 * - system_proxy_url: 系统代理地址（始终可保存；供应商「使用系统代理」只依赖此地址）
 * - system_proxy_enabled: 为所有连接强制使用该代理（默认 false）
 *   关闭时不影响供应商单独启用的代理配置
 */
async function getSystemProxyConfig() {
  try {
    const result = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('system_proxy_enabled', 'system_proxy_url')"
    );
    // applyAll: 是否对所有上游连接强制使用系统代理
    const config = { applyAll: false, url: '' };
    for (const row of result.rows) {
      try {
        if (row.key === 'system_proxy_enabled') {
          const v = JSON.parse(row.value);
          config.applyAll = v === true || v === 'true' || v === 1;
        } else if (row.key === 'system_proxy_url') {
          const v = JSON.parse(row.value);
          config.url = typeof v === 'string' ? v.trim() : '';
        }
      } catch {
        if (row.key === 'system_proxy_enabled') {
          config.applyAll = row.value === 'true' || row.value === '1';
        } else if (row.key === 'system_proxy_url') {
          config.url = (row.value || '').trim();
        }
      }
    }
    // 兼容旧字段名 enabled
    config.enabled = config.applyAll;
    return config;
  } catch (err) {
    Logger.warn(`[ProxyPool] 读取系统代理设置失败: ${err.message}`);
    return { applyAll: false, enabled: false, url: '' };
  }
}

/**
 * 构造系统单代理列表项
 */
function systemProxyEntry(url) {
  return { id: 'system:global', url, enabled: true };
}

/**
 * 校验代理 URL 协议是否受支持
 */
function isValidProxyUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^(https?|socks4|socks5h?):\/\//i.test(url.trim());
}

/**
 * 合并手动代理和订阅代理，按 URL 去重
 */
function mergeProxyLists(manualProxies, subscriptionProxies) {
  if (subscriptionProxies.length === 0) return manualProxies;
  if (manualProxies.length === 0) return subscriptionProxies;

  const seen = new Set(manualProxies.map(p => p.url));
  const merged = [...manualProxies];
  for (const sp of subscriptionProxies) {
    if (!seen.has(sp.url)) {
      merged.push(sp);
      seen.add(sp.url);
    }
  }
  return merged;
}

/**
 * 从全局设置读取代理池配置
 */
async function getGlobalProxies() {
  const { subscriptionUrl, manualProxies } = await getGlobalProxyPoolConfig();

  if (!subscriptionUrl && manualProxies.length === 0) {
    return [];
  }

  if (!subscriptionUrl) {
    return manualProxies;
  }

  const subscriptionProxies = await fetchSubscriptionProxies(subscriptionUrl, '__global__');
  return mergeProxyLists(manualProxies, subscriptionProxies);
}

/**
 * 获取代理列表（仅返回实际会使用的代理）
 * - 供应商启用 + single：自定义地址或系统代理地址
 * - 供应商启用 + pool：供应商级列表/订阅，否则全局代理池
 * - 供应商未启用：若系统开启「为所有连接使用代理」，返回系统代理
 */
async function getProxies(provider) {
  if (provider?.proxy_enabled) {
    const mode = (provider.proxy_mode || 'pool').toLowerCase();

    if (mode === 'single') {
      const useSystem = provider.proxy_use_system === true
        || provider.proxy_use_system === 'true'
        || provider.proxy_use_system === 1;
      let url = (provider.proxy_url || '').trim();
      if (useSystem) {
        const sys = await getSystemProxyConfig();
        // 使用系统地址不要求「为所有连接使用代理」开启，只要配置了地址即可
        if (!sys.url) return [];
        url = sys.url;
      }
      if (!url || !isValidProxyUrl(url)) return [];
      return [{ id: `single:${provider.id}`, url, enabled: true }];
    }

    // 代理池模式：供应商级配置优先，否则回退到全局代理池
    const perProviderManual = parseProxyPool(provider?.proxy_pool);
    const perProviderSub = provider?.proxy_subscription_url;

    if (perProviderManual.length > 0 || perProviderSub) {
      const subProxies = perProviderSub
        ? await fetchSubscriptionProxies(perProviderSub, provider.id)
        : [];
      return mergeProxyLists(perProviderManual, subProxies);
    }

    return getGlobalProxies();
  }

  // 供应商未单独启用：全局强制代理
  const sys = await getSystemProxyConfig();
  if (sys.applyAll && isValidProxyUrl(sys.url)) {
    return [systemProxyEntry(sys.url)];
  }
  return [];
}

/**
 * 选择最佳代理
 *
 * 策略：
 * 1. 只考虑 enabled=true 的代理
 * 2. 排除最近 60 秒内收到 429 的代理
 * 3. 如果所有代理都被限速，选择最早收到 429 的那个
 */
function selectBestProxy(proxies, providerId, affinityKey = null) {
  const enabledProxies = proxies.filter(p => p.enabled !== false);
  if (enabledProxies.length === 0) return null;

  const now = Date.now();
  const COOLDOWN_429 = 60 * 1000; // 429 冷却时间 60 秒

  // 获取每个代理的运行时状态
  const candidates = enabledProxies.map((proxy, index) => {
    const state = getRuntimeState(providerId, proxy.id);
    return { proxy, state, index };
  });

  if (affinityKey) {
    const routeKey = affinityRouteKey(providerId, affinityKey);
    const pinnedIndex = affinityRoutes.get(routeKey);
    const pinned = pinnedIndex === undefined ? null : candidates.find(candidate => candidate.index === pinnedIndex);
    if (pinned && !pinned.state.last429At) {
      rememberAffinity(routeKey, pinned.index);
      return pinned.proxy;
    }
  }

  // 排除最近 429 的代理
  const available = candidates.filter(({ state }) => {
    return !state.last429At || (now - state.last429At > COOLDOWN_429);
  });

  // 如果有可用的，随机选择一个
  if (available.length > 0) {
    const { selectHealthyWeighted } = require('./utils/provider-selector');
    const selected = selectHealthyWeighted(available.map(item => ({ ...item, weight: item.proxy.weight || 1 })), `proxy:${providerId}`);
    if (affinityKey) rememberAffinity(affinityRouteKey(providerId, affinityKey), selected.index);
    return selected.proxy;
  }

  // 所有代理都被限速，选择最早 429 的那个（可能已恢复）
  candidates.sort((a, b) => {
    const timeA = a.state.last429At || 0;
    const timeB = b.state.last429At || 0;
    return timeA - timeB;
  });
  const selected = candidates[0];
  if (affinityKey) rememberAffinity(affinityRouteKey(providerId, affinityKey), selected.index);
  return selected.proxy;
}

/**
 * 根据代理 URL 创建 fetch 可用的 agent
 */
function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;

  const url = proxyUrl.toLowerCase();
  if (url.startsWith('socks4://') || url.startsWith('socks5://') || url.startsWith('socks5h://')) {
    return new SocksProxyAgent(proxyUrl);
  }
  // 默认使用 HTTP/HTTPS 代理
  return new HttpsProxyAgent(proxyUrl);
}

function createPinnedProxyAgent(agent, validation, attempt = 0) {
  const host = String(validation?.url?.hostname || '').replace(/^\[|\]$/g, '');
  if (!host || net.isIP(host)) return null;
  const proxyUrl = agent?.proxyUrl || agent?.proxy?.href;
  if (!proxyUrl) throw new Error('代理无法固定已校验的上游地址');
  const addresses = validation.addresses || [];
  if (!addresses.length) throw new Error('代理请求缺少已校验的 DNS 地址');
  const attemptNumber = Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
  const candidate = addresses[attemptNumber % addresses.length];
  const family = net.isIP(candidate.address);
  if (!family || (candidate.family && candidate.family !== family)) throw new Error('代理请求的已校验 DNS 地址无效');

  if (/^socks(?:4|5|5h)?:/i.test(proxyUrl)) {
    return new class extends SocksProxyAgent {
      constructor() {
        super(proxyUrl);
        this.pinnedAddress = candidate.address;
        this.pinnedServername = host;
      }
      connect(req, options) {
        return super.connect(req, { ...options, host: this.pinnedAddress, servername: this.pinnedServername });
      }
    }();
  }
  return new class extends HttpsProxyAgent {
    constructor() {
      super(proxyUrl);
      this.pinnedAddress = candidate.address;
      this.pinnedServername = host;
    }
    connect(req, options) {
      return super.connect(req, { ...options, host: this.pinnedAddress, servername: this.pinnedServername });
    }
  }();
}

/**
 * 基于 axios 的 fetch 兼容包装层
 *
 * 原因：Node.js 内置 fetch() 的 `agent` 选项不接受 Node 原生的 http.Agent/https.Agent，
 * 导致 HttpsProxyAgent / SocksProxyAgent 被静默忽略，代理请求实际不经过代理服务器。
 * axios 原生支持 httpAgent/httpsAgent，因此用 axios 发送请求并包装成 fetch-like Response。
 *
 * @param {string} url - 目标 URL
 * @param {object} options - 与 fetch 类似的选项 { method, headers, body, signal, agent }
 * @returns {object} 兼容 Response 的对象 { ok, status, statusText, headers, url, text, json, body }
 */
async function proxyFetch(url, options = {}) {
  if ((options.requestContext?.upstreamAttempts || 0) >= 12 || options.signal?.aborted || options.requestContext?.signal?.aborted) {
    return proxyFetchTransport(url, options);
  }
  const { quotaFetch } = require('./utils/quota-request-context');
  return quotaFetch(url, options, proxyFetchTransport);
}

/**
 * 经过 URL 校验并固定 DNS 结果的直连 fetch 包装。
 * 该接口不走 HTTP/SOCKS 代理；需要代理的供应商继续使用 proxyFetch + agent。
 */
async function pinnedFetch(url, options = {}) {
  const check = await validateUrl(String(url), { allowPrivate: false });
  if (!check.ok) throw new Error(`出站 URL 安全校验失败: ${check.error}`);
  return pinnedFetchValidated(check, options);
}

async function pinnedFetchValidated(validation, options = {}) {
  if (!validation?.ok || !validation.url) throw new Error('缺少已校验的出站 URL');
  if (options.agent) throw new Error('固定 DNS 的直连请求不能使用代理 agent');
  const initialUrl = validation.url instanceof URL ? validation.url : new URL(validation.url);
  if (initialUrl.username || initialUrl.password) throw new TypeError('出站 URL 不得包含用户凭据');
  initialUrl.hash = '';
  const redirect = options.redirect || 'follow';
  if (!['follow', 'manual', 'error'].includes(redirect)) throw new TypeError('redirect 选项无效');
  const headers = new Headers(options.headers || undefined);
  let method = String(options.method || 'GET').toUpperCase();
  let body = options.body;
  if (body === null) body = undefined;
  if (body instanceof URLSearchParams) {
    body = body.toString();
    if (!headers.has('content-type')) headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
  }
  if (body !== undefined && ['GET', 'HEAD'].includes(method)) throw new TypeError('GET/HEAD 请求不能包含 body');
  let currentValidation = validation;
  let currentUrl = initialUrl;

  for (let redirects = 0; ; redirects++) {
    const response = await proxyFetchTransport(currentUrl.toString(), {
      ...options,
      method,
      headers: Object.fromEntries(headers.entries()),
      body,
      redirect: 'manual',
      agent: undefined,
      pinnedTarget: currentValidation,
    });
    if (![301, 302, 303, 307, 308].includes(response.status) || redirect === 'manual') return response;
    if (redirect === 'error') {
      await response.body?.cancel().catch(() => {});
      throw new TypeError('出站请求收到重定向响应');
    }
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects >= 20) {
      await response.body?.cancel().catch(() => {});
      throw new TypeError('出站请求重定向次数超限');
    }
    let nextUrl;
    try { nextUrl = new URL(location, currentUrl); }
    catch {
      await response.body?.cancel().catch(() => {});
      throw new TypeError('出站请求重定向地址无效');
    }
    if (nextUrl.username || nextUrl.password) {
      await response.body?.cancel().catch(() => {});
      throw new TypeError('出站重定向 URL 不得包含用户凭据');
    }
    if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') {
      await response.body?.cancel().catch(() => {});
      throw new TypeError('出站请求拒绝从 HTTPS 降级到非 HTTPS');
    }
    nextUrl.hash = '';
    await response.body?.cancel().catch(() => {});
    if (nextUrl.origin !== currentUrl.origin) {
      for (const name of ['authorization', 'proxy-authorization', 'cookie', 'cookie2']) headers.delete(name);
    }
    if ((response.status === 303 && method !== 'HEAD')
        || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      for (const name of ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length']) headers.delete(name);
    }
    currentUrl = nextUrl;
    currentValidation = await validateUrl(currentUrl.toString(), { allowPrivate: false });
    if (!currentValidation.ok) throw new Error(`重定向目标未通过安全校验: ${currentValidation.error}`);
  }
}

async function proxyFetchTransport(url, options = {}) {
  const context = options.requestContext;
  const signal = options.signal || context?.signal
    ? combineAbortSignals(options.signal, context?.signal)
    : undefined;
  const normalizeError = (err) => {
    const canceled = signal?.aborted || axios.isCancel?.(err)
      || ['CanceledError', 'AbortError', 'TimeoutError'].includes(err.name)
      || ['ERR_CANCELED', 'ECONNABORTED', 'ETIMEDOUT'].includes(err.code);
    if (!canceled) return err;
    const timedOut = err.name === 'TimeoutError' || err.code === 'ETIMEDOUT'
      || err.code === 'ECONNABORTED' || signal?.reason?.name === 'TimeoutError';
    const error = new Error(timedOut ? 'Upstream request timed out' : 'The operation was aborted');
    error.name = timedOut ? 'TimeoutError' : 'AbortError';
    error.code = timedOut ? 'ETIMEDOUT' : 'ERR_CANCELED';
    error.cause = err;
    return error;
  };
  let pinnedAgents;
  let pinnedProxyAgent;
  const cleanupSignal = () => {
    if (signal && signal !== options.signal && signal !== context?.signal) {
      releaseCombinedAbortSignal(signal);
    }
    if (pinnedAgents) {
      pinnedAgents.destroy();
      pinnedAgents = null;
    }
    if (pinnedProxyAgent) {
      pinnedProxyAgent.destroy();
      pinnedProxyAgent = null;
    }
  };
  if (signal?.aborted) {
    cleanupSignal();
    throw normalizeError(new Error('The operation was aborted'));
  }
  if ((context?.upstreamAttempts || 0) >= 12) {
    cleanupSignal();
    const error = new Error('Upstream request attempt limit exceeded (12)');
    error.code = 'upstream_attempt_limit';
    throw error;
  }
  const isHttps = url.startsWith('https://');
  const method = (options.method || 'GET').toLowerCase();
  try {
    if (options.agent && options.pinnedTarget) {
      pinnedProxyAgent = createPinnedProxyAgent(options.agent, options.pinnedTarget, context?.upstreamAttempts || 0);
    } else if (options.pinnedTarget) {
      pinnedAgents = createPinnedHttpAgents(options.pinnedTarget);
    }
  } catch (error) {
    cleanupSignal();
    throw error;
  }
  const requestAgent = pinnedProxyAgent || options.agent;
  const axiosConfig = {
    method,
    url,
    headers: { ...(options.headers || {}) },
    data: options.body,
    responseType: 'stream',
    maxRedirects: 0,
    validateStatus: () => true,
    signal,
    httpAgent: !isHttps ? (requestAgent || pinnedAgents?.httpAgent) : undefined,
    httpsAgent: isHttps ? (requestAgent || pinnedAgents?.httpsAgent) : undefined,
    ...(pinnedAgents || requestAgent ? { proxy: false } : {}),
    transformRequest: [(data) => data],
    transformResponse: [(data) => data]
  };
  const attempt = {
    number: (context?.upstreamAttempts || 0) + 1,
    responseStarted: false,
    status: null,
    phase: 'sending'
  };
  const logAttempt = () => {
    if (typeof Logger !== 'undefined') {
      const requestId = /^[a-zA-Z0-9-]{1,64}$/.test(context?.requestId || '') ? context.requestId : 'untracked';
      const purpose = ['user_request', 'session_summary', 'provider_parse', 'model_test', 'model_trace', 'fusion'].includes(context?.purpose) ? context.purpose : 'unspecified';
      Logger.info(`[UpstreamAttempt] request=${requestId} purpose=${purpose} number=${attempt.number} phase=${attempt.phase} status=${attempt.status ?? 'none'} responseStarted=${attempt.responseStarted}`);
    }
  };
  let axiosResponse;
  try {
    // 在实际发送前同步占用预算，避免并发超额。
    if (signal?.aborted) throw normalizeError(new Error('The operation was aborted'));
    if (context) {
      context.upstreamAttempts = attempt.number;
      context.lastAttempt = attempt;
    }
    logAttempt();
    axiosResponse = await axios(axiosConfig);
  } catch (err) {
    attempt.phase = 'failed';
    logAttempt();
    cleanupSignal();
    const failure = normalizeError(err);
    failure.upstreamAttempt = attempt;
    throw failure;
  }
  attempt.status = axiosResponse.status;
  attempt.responseStarted = true;
  attempt.phase = 'headers';
  logAttempt();
  const stream = axiosResponse.data;
  const onEnd = () => {
    attempt.phase = 'completed';
    logAttempt();
    cleanupSignal();
  };
  const onError = (error) => {
    attempt.phase = 'failed';
    logAttempt();
    cleanupSignal();
    options.quotaOnTerminal?.(signal?.aborted ? (signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled') : 'failed', error);
  };
  const onClose = () => {
    stream.removeListener('end', onEnd);
    stream.removeListener('error', onError);
    if (attempt.phase === 'headers') {
      attempt.phase = stream.readableEnded ? 'completed' : 'failed';
      if (!stream.readableEnded) options.quotaOnTerminal?.(signal?.aborted ? (signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled') : 'failed');
      logAttempt();
    }
    cleanupSignal();
  };
  stream.once('end', onEnd);
  stream.once('error', onError);
  stream.once('close', onClose);

  const responseHeaders = new Headers();
  const rawHeaders = axiosResponse.headers.toJSON?.() || axiosResponse.headers;
  for (const [name, rawValue] of Object.entries(rawHeaders)) {
    if (rawValue == null) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) responseHeaders.append(name, String(value));
  }
  const bodyless = [204, 205, 304].includes(axiosResponse.status);
  let response;
  try {
    response = new Response(bodyless ? null : Readable.toWeb(axiosResponse.data), {
      status: axiosResponse.status,
      statusText: axiosResponse.statusText,
      headers: responseHeaders,
    });
    Object.defineProperty(response, 'url', { value: axiosResponse.config.url, enumerable: true });
  } catch (error) {
    axiosResponse.data.destroy?.();
    cleanupSignal();
    throw error;
  }
  if (bodyless) axiosResponse.data.resume?.();
  return response;
}

/**
 * 获取供应商的代理 agent
 *
 * 优先级：
 * 1. 供应商单独启用代理（proxy_enabled）
 *    - pool：代理池
 *    - single + proxy_use_system：使用系统设置中的代理地址（不要求全局强制开启）
 *    - single + 自定义 proxy_url
 * 2. 系统开启「为所有连接使用代理」时，所有供应商走系统代理地址
 *
 * 返回 { agent, proxyId, proxyUrl } 或 null
 */
async function getProxyAgent(provider, affinityKey = null) {
  // 供应商单独配置优先
  if (provider?.proxy_enabled) {
    const mode = (provider.proxy_mode || 'pool').toLowerCase();

    if (mode === 'single') {
      const useSystem = provider.proxy_use_system === true
        || provider.proxy_use_system === 'true'
        || provider.proxy_use_system === 1;
      let proxyUrl = (provider.proxy_url || '').trim();

      if (useSystem) {
        const sys = await getSystemProxyConfig();
        if (!sys.url) {
          Logger.warn(`[ProxyPool] 供应商 ${provider.id} 选择系统代理，但系统代理地址未配置`);
          return null;
        }
        proxyUrl = sys.url;
      }

      if (!proxyUrl) {
        Logger.warn(`[ProxyPool] 供应商 ${provider.id} 单代理模式未配置地址`);
        return null;
      }

      if (!isValidProxyUrl(proxyUrl)) {
        Logger.warn(`[ProxyPool] 供应商 ${provider.id} 代理地址无效: ${proxyUrl}`);
        return null;
      }

      const agent = createProxyAgent(proxyUrl);
      return {
        agent,
        proxyId: `single:${provider.id}`,
        proxyUrl
      };
    }

    // 代理池模式
    const proxies = await getProxies(provider);
    if (proxies.length === 0) return null;

    const selected = selectBestProxy(proxies, provider.id, affinityKey);
    if (!selected) return null;

    const agent = createProxyAgent(selected.url);
    return {
      agent,
      proxyId: selected.id,
      proxyUrl: selected.url
    };
  }

  // 全局：为所有连接使用系统代理
  const sys = await getSystemProxyConfig();
  if (sys.applyAll && isValidProxyUrl(sys.url)) {
    return {
      agent: createProxyAgent(sys.url),
      proxyId: 'system:global',
      proxyUrl: sys.url
    };
  }

  return null;
}

/**
 * 标记代理收到 429
 */
function markProxy429(providerId, proxyId) {
  const state = getRuntimeState(providerId, proxyId);
  state.last429At = Date.now();
  state.failCount++;
  Logger.info(`[ProxyPool] 代理 ${proxyId} 收到 429，进入冷却期`);
}

/**
 * 标记代理请求成功
 */
function markProxySuccess(providerId, proxyId) {
  const state = getRuntimeState(providerId, proxyId);
  state.failCount = 0;
  state.last429At = null; // 清除 429 冷却
}

/**
 * 添加代理到供应商代理池
 */
function createProxyEntry(url) {
  return {
    id: uuidv4(),
    url,
    enabled: true
  };
}

module.exports = {
  getProxyAgent,
  getProxies,
  proxyFetch,
  pinnedFetch,
  pinnedFetchValidated,
  markProxy429,
  markProxySuccess,
  createProxyEntry,
  parseProxyPool,
  selectBestProxy,
  createProxyAgent,
  getSystemProxyConfig,
  isValidProxyUrl
};
