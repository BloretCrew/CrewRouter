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
const Logger = require('./logger');
const pool = require('./models/database').pool;
const { validateUrl } = require('./utils/url-validator');

// 代理状态缓存：providerId -> proxyId -> 运行时状态
const runtimeState = new Map();

// 订阅地址缓存：providerId -> { proxies, fetchedAt }
const subscriptionCache = new Map();
const SUBSCRIPTION_CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存
const affinityRoutes = new Map();
const AFFINITY_MAX_KEYS = 1000;

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
    Logger.warn(`[ProxyPool] 订阅地址安全校验失败: ${urlCheck.error} (${subscriptionUrl})`);
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

    const response = await fetch(subscriptionUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      Logger.warn(`[ProxyPool] 订阅地址获取失败: HTTP ${response.status} (${subscriptionUrl})`);
      // 缓存失败时返回旧缓存（如果有）
      return cached ? cached.proxies : [];
    }

    // 限制响应体 1MB
    const MAX_BYTES = 1024 * 1024;
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_BYTES) {
        reader.cancel();
        Logger.warn(`[ProxyPool] 订阅内容过大，已截断 (${subscriptionUrl})`);
        break;
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
      Logger.info(`[ProxyPool] 订阅地址拉取成功: ${proxies.length} 个代理 (${subscriptionUrl})`);
    }
    return proxies;
  } catch (error) {
    Logger.warn(`[ProxyPool] 订阅地址拉取异常: ${error.message} (${subscriptionUrl})`);
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
    const selected = available[Math.floor(Math.random() * available.length)];
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
  const isHttps = url.startsWith('https://');
  if (options.requestContext) {
    options.requestContext.upstreamAttempts = (options.requestContext.upstreamAttempts || 0) + 1;
    if (options.requestContext.upstreamAttempts > 12) {
      const error = new Error('Upstream request attempt limit exceeded (12)');
      error.code = 'upstream_attempt_limit';
      throw error;
    }
  }
  const method = (options.method || 'GET').toLowerCase();

  const axiosConfig = {
    method,
    url,
    headers: { ...(options.headers || {}) },
    data: options.body,
    responseType: 'stream',
    validateStatus: () => true,
    signal: options.signal,
    httpAgent: !isHttps ? options.agent : undefined,
    httpsAgent: isHttps ? options.agent : undefined,
    // 禁用 axios 默认的转换，保持与 fetch 一致
    transformRequest: [(data) => data],
    transformResponse: [(data) => data]
  };

  let axiosResponse;
  try {
    axiosResponse = await axios(axiosConfig);
  } catch (err) {
    const isCanceled = axios.isCancel?.(err)
      || err.name === 'CanceledError'
      || err.name === 'AbortError'
      || err.name === 'TimeoutError'
      || err.code === 'ERR_CANCELED'
      || err.code === 'ECONNABORTED'
      || err.code === 'ETIMEDOUT'
      || (options.signal && options.signal.aborted);

    if (isCanceled) {
      // AbortSignal.timeout() 触发时 reason.name === 'TimeoutError'
      const reason = options.signal?.reason;
      const timedOut = err.name === 'TimeoutError'
        || err.code === 'ETIMEDOUT'
        || reason?.name === 'TimeoutError'
        || /timeout/i.test(String(err.message || ''))
        || /timeout/i.test(String(reason?.message || reason || ''));
      const abortErr = new Error(timedOut ? 'Upstream request timed out' : 'The operation was aborted');
      abortErr.name = timedOut ? 'TimeoutError' : 'AbortError';
      abortErr.code = timedOut ? 'ETIMEDOUT' : 'ERR_CANCELED';
      abortErr.cause = err;
      throw abortErr;
    }
    throw err;
  }

  let bodyBuffer = null;
  let consumed = false;

  const readBodyBuffer = async () => {
    if (bodyBuffer !== null) return bodyBuffer;
    const chunks = [];
    for await (const chunk of axiosResponse.data) {
      chunks.push(chunk);
    }
    bodyBuffer = Buffer.concat(chunks);
    return bodyBuffer;
  };

  const response = {
    ok: axiosResponse.status >= 200 && axiosResponse.status < 300,
    status: axiosResponse.status,
    statusText: axiosResponse.statusText,
    headers: axiosResponse.headers,
    url: axiosResponse.config.url,

    text: async () => {
      if (consumed) {
        throw new TypeError('Body has already been consumed');
      }
      consumed = true;
      const buf = await readBodyBuffer();
      return buf.toString('utf-8');
    },

    json: async () => {
      const text = await response.text();
      return JSON.parse(text);
    },

    body: {
      getReader: () => {
        if (consumed) {
          throw new TypeError('Body has already been consumed');
        }
        consumed = true;
        const webStream = Readable.toWeb(axiosResponse.data);
        return webStream.getReader();
      }
    }
  };

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
  markProxy429,
  markProxySuccess,
  createProxyEntry,
  parseProxyPool,
  selectBestProxy,
  createProxyAgent,
  getSystemProxyConfig,
  isValidProxyUrl
};
