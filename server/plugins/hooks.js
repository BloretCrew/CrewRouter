/**
 * 插件钩子总线
 *
 * 所有插件通过 subscribe() 注册钩子；宿主代码（网关、模型列表等）通过 apply()
 * 触发钩子管线。约定：
 *  - 钩子处理器收到 (payload, meta)，返回非 undefined 的对象即视为修改后的 payload；
 *    也可以直接原地修改 payload 后不返回值。
 *  - 单个插件抛错只记录并计入熔断，不影响其他插件与主流程。
 *  - 无订阅者时 hasSubscribers() 为 false，调用方应完全旁路（零开销）。
 */

// hookName -> [{ pluginId, handler, priority }]
const subscribers = new Map();

// 熔断配置：连续失败 N 次后摘除该插件的全部钩子
const ERROR_THRESHOLD = 5;
// 连续成功次数足以清零错误计数
const consecutiveErrors = new Map(); // pluginId -> count

let errorReporter = null; // (pluginId, hookName, err) => void，由 registry 注入

function setErrorReporter(fn) {
  errorReporter = fn;
}

/**
 * 是否有插件订阅了某个钩子（热路径快速判空用）
 */
function hasSubscribers(hookName) {
  const list = subscribers.get(hookName);
  return !!(list && list.length > 0);
}

/**
 * 注册钩子
 * @param {string} pluginId
 * @param {string} hookName
 * @param {Function} handler async (payload, meta) => payload|undefined
 * @param {number} priority 数字越小越先执行（默认 100）
 */
function subscribe(pluginId, hookName, handler, priority = 100) {
  if (typeof handler !== 'function') {
    throw new Error(`[plugins] 钩子 ${hookName} 处理器必须是函数`);
  }
  if (!subscribers.has(hookName)) subscribers.set(hookName, []);
  const list = subscribers.get(hookName);
  // 同插件同名钩子幂等注册
  const idx = list.findIndex(s => s.pluginId === pluginId && s.handler === handler);
  if (idx >= 0) return;
  list.push({ pluginId, handler, priority });
  list.sort((a, b) => a.priority - b.priority);
}

/**
 * 摘除某插件的全部钩子（禁用/卸载/熔断时调用）
 */
function unsubscribePlugin(pluginId) {
  for (const [name, list] of subscribers.entries()) {
    const next = list.filter(s => s.pluginId !== pluginId);
    if (next.length === 0) subscribers.delete(name);
    else subscribers.set(name, next);
  }
  consecutiveErrors.delete(pluginId);
}

/**
 * 执行钩子管线
 * @param {string} hookName
 * @param {object} payload 可修改的数据载荷
 * @param {object} meta 只读上下文（provider/model/requestType 等）
 * @returns {Promise<object>} 最终 payload
 */
async function apply(hookName, payload, meta = {}) {
  const list = subscribers.get(hookName);
  if (!list || list.length === 0) return payload;

  let current = payload;
  for (const sub of list) {
    try {
      const result = await sub.handler(current, meta);
      if (result !== undefined && result !== null) current = result;
      consecutiveErrors.set(sub.pluginId, 0);
    } catch (err) {
      reportError(sub.pluginId, hookName, err);
    }
  }
  return current;
}

/**
 * 流式 chunk 改写：无订阅者时同步直返，有订阅者时走异步管线
 */
function maybeRewriteChunk(chunkText, meta = {}) {
  if (!hasSubscribers('gateway:responseChunk')) return chunkText;
  return apply('gateway:responseChunk', { chunkText }, meta).then(out =>
    typeof out?.chunkText === 'string' ? out.chunkText : chunkText
  );
}

/**
 * 响应头追加：finalResponse 钩子的便捷封装，把返回的 headers 应用到 res 上
 */
async function applyFinalResponseHeaders(res, meta = {}) {
  if (!hasSubscribers('gateway:finalResponse')) return;
  try {
    const out = await apply('gateway:finalResponse', { statusCode: res.statusCode, headers: {} }, meta);
    if (out?.headers && typeof out.headers === 'object') {
      for (const [k, v] of Object.entries(out.headers)) {
        if (v === null || v === undefined) continue;
        try { res.setHeader(k, String(v)); } catch { /* 非法头名忽略 */ }
      }
    }
  } catch (err) {
    // 理论上 apply 已隔离单插件错误，这里兜底总线级异常
  }
}

function reportError(pluginId, hookName, err) {
  const prev = consecutiveErrors.get(pluginId) || 0;
  const now = prev + 1;
  consecutiveErrors.set(pluginId, now);
  if (errorReporter) {
    try { errorReporter(pluginId, hookName, err, now); } catch { /* 报告器异常忽略 */ }
  }
}

/**
 * 用量落库前的统计元数据钩子（stats:record 便捷封装）
 * 调用方把拟写入 usage_records.plugin_meta 的 meta 传入；无订阅者时同步直返（零开销）。
 */
async function applyStatsRecord(meta, ctxMeta = {}) {
  if (!hasSubscribers('stats:record')) return meta;
  const out = await apply('stats:record', { meta }, ctxMeta);
  const m = out?.meta;
  return (m && typeof m === 'object' && !Array.isArray(m)) ? m : meta;
}

module.exports = {
  setErrorReporter,
  hasSubscribers,
  subscribe,
  unsubscribePlugin,
  apply,
  maybeRewriteChunk,
  applyFinalResponseHeaders,
  applyStatsRecord,
  ERROR_THRESHOLD,
};
