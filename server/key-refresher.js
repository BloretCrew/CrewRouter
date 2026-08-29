/**
 * Key Refresher — 动态密钥刷新模块
 *
 * 支持供应商 API Key 设为 "script" 模式，通过 JS 脚本定时刷新密钥。
 * 脚本格式：async function(ctx) { return 'key-string'; }
 *   或返回 { key: 'xxx', expiresIn: 3600 }
 *
 * ctx 提供：
 *   - baseUrl, providerId, providerName
 *   - currentKey（当前缓存的密钥）
 *   - fetch（全局 fetch，仅在沙箱中安全注入）
 *
 * 注意：出于安全考虑，不支持 require/module.exports 格式的脚本。
 * 需要使用 async function(ctx) { ... } 格式。
 */

const Logger = require('./logger');
const { pool } = require('./models/database');
const { safeExecuteKeyScript } = require('./utils/sandbox');
const { encryptSecret, decryptSecret } = require('./utils/secret-crypto');

/**
 * 从语法错误信息中提取出错行号，并展示对应代码片段
 */
function extractErrorLine(errMsg, scriptBody) {
  // Node.js 语法错误通常包含 "at line X" 或位置信息
  // 例如: "Unexpected token } in JSON at position 0"
  // V8: "Unexpected token '}'" + 堆栈中有 <anonymous>:line:col

  // 尝试从错误信息中提取行号
  const lineMatch = errMsg.match(/(?:at line |line )(\d+)/i)
    || errMsg.match(/<anonymous>:(\d+):(\d+)/);
  if (!lineMatch) return '';

  const lineNum = parseInt(lineMatch[1]);
  const colNum = lineMatch[2] ? parseInt(lineMatch[2]) : null;

  // 将脚本按行分割，展示错误行及上下文
  const lines = scriptBody.split('\n');
  const startLine = Math.max(0, lineNum - 3); // 偏移 2 行（因为包装后第 1 行是函数头）
  const endLine = Math.min(lines.length, lineNum + 1);

  if (startLine >= lines.length) return '';

  const snippet = [];
  for (let i = startLine; i < endLine; i++) {
    const marker = i === lineNum - 1 ? ' >>> ' : '     ';
    snippet.push(`${marker}${i + 1} | ${lines[i]}`);
    if (i === lineNum - 1 && colNum) {
      snippet.push('       ' + ' '.repeat(colNum + String(i + 1).length) + '^');
    }
  }

  return snippet.length > 0 ? '\n\n出错位置:\n' + snippet.join('\n') : '';
}

// 内存缓存：providerId → { key, expiresAt, lastRefreshAt, lastError, timer }
const keyCache = new Map();

// 默认刷新间隔（秒）
const DEFAULT_REFRESH_INTERVAL = 3600;
// 刷新失败后重试间隔（秒）
const RETRY_INTERVAL = 60;
// 提前刷新余量（秒）：在过期前 30 秒刷新
const REFRESH_AHEAD = 30;

/**
 * 执行密钥脚本
 * @param {object} provider - 供应商记录
 * @returns {object} { key: string, expiresIn?: number }
 */
async function executeKeyScript(provider) {
  const rawScript = (provider.key_script || '').trim();
  if (!rawScript) {
    throw new Error('密钥脚本为空');
  }

  // 预处理脚本：去掉 shebang
  let scriptBody = rawScript.replace(/^#!.*$/m, '').trim();

  // 构建执行上下文（仅注入安全上下文）
  const ctx = {
    baseUrl: (provider.base_url || '').replace(/\/+$/, ''),
    providerId: provider.id,
    providerName: provider.name || '',
    currentKey: provider.api_key || '',
    // 注入安全的 fetch 封装，不影响全局
  };

  let result;
  try {
    // 使用安全沙箱执行脚本
    result = await safeExecuteKeyScript(scriptBody, ctx, {
      timeout: 10000,
      filename: `key-script-${provider.id}.js`
    });
    return normalizeScriptResult(result);
  } catch (err) {
    const errLine = extractErrorLine(err.message, scriptBody);
    throw new Error(`脚本执行失败: ${err.message}${errLine}`);
  }
}

/**
 * 规范化脚本返回值
 */
function normalizeScriptResult(result) {
  if (typeof result === 'string') {
    return { key: result, expiresIn: null };
  }
  if (result && typeof result === 'object') {
    const key = result.key || result.access_token || result.token || '';
    if (!key) {
      throw new Error('脚本返回值中未找到密钥（期望 result.key / result.access_token / result.token）');
    }
    return { key, expiresIn: result.expiresIn || result.expires_in || null };
  }
  throw new Error('脚本返回值格式错误，期望 string 或 { key, expiresIn }');
}

/**
 * 刷新单个供应商的密钥
 * @param {string} providerId
 * @returns {object} { success, key, expiresAt, error }
 */
async function refreshProviderKey(providerId) {
  // 从数据库获取最新供应商数据
  const result = await pool.query('SELECT * FROM providers WHERE id = $1', [providerId]);
  if (result.rows.length === 0) {
    return { success: false, error: '供应商不存在' };
  }
  const provider = result.rows[0];
  provider.api_key = decryptSecret(provider.api_key);

  if (provider.key_mode !== 'script') {
    return { success: false, error: '供应商非脚本模式' };
  }

  const startTime = Date.now();
  try {
    const { key, expiresIn } = await executeKeyScript(provider);
    const interval = provider.key_refresh_interval || DEFAULT_REFRESH_INTERVAL;
    const ttl = expiresIn || interval;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    // 更新数据库
    await pool.query(
      `UPDATE providers SET
        api_key = $1,
        key_expires_at = $2,
        key_last_refresh_at = NOW(),
        key_last_error = NULL
      WHERE id = $3`,
      [encryptSecret(key), expiresAt, providerId]
    );

    // 更新内存缓存
    keyCache.set(providerId, {
      key,
      expiresAt: expiresAt.getTime(),
      lastRefreshAt: Date.now(),
      lastError: null,
      timer: keyCache.get(providerId)?.timer || null
    });

    // 重新调度下次刷新
    scheduleRefresh(providerId, ttl);

    const elapsed = Date.now() - startTime;
    Logger.info(`[KeyRefresher] 密钥刷新成功: provider=${providerId}, 耗时=${elapsed}ms, 过期时间=${expiresAt.toISOString()}`);
    return { success: true, key, expiresAt };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const errorMsg = err.message || String(err);

    // 记录错误但保留旧密钥
    try {
      await pool.query(
        `UPDATE providers SET
          key_last_refresh_at = NOW(),
          key_last_error = $1
        WHERE id = $2`,
        [errorMsg, providerId]
      );
    } catch (dbErr) {
      Logger.error(`[KeyRefresher] 记录错误信息到数据库失败: ${dbErr.message}`);
    }

    // 更新缓存中的错误信息
    const cached = keyCache.get(providerId);
    if (cached) {
      cached.lastError = errorMsg;
      cached.lastRefreshAt = Date.now();
    }

    // 失败后安排重试
    scheduleRefresh(providerId, RETRY_INTERVAL);

    Logger.error(`[KeyRefresher] 密钥刷新失败: provider=${providerId}, 耗时=${elapsed}ms, 错误=${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

/**
 * 调度下一次刷新
 */
function scheduleRefresh(providerId, intervalSeconds) {
  const cached = keyCache.get(providerId);
  if (cached?.timer) {
    clearTimeout(cached.timer);
  }

  const ms = Math.max(intervalSeconds * 1000, 5000); // 最少 5 秒
  const timer = setTimeout(async () => {
    Logger.info(`[KeyRefresher] 定时刷新: provider=${providerId}`);
    await refreshProviderKey(providerId);
  }, ms);

  // 允许进程正常退出
  if (timer.unref) timer.unref();

  if (cached) {
    cached.timer = timer;
  } else {
    keyCache.set(providerId, {
      key: null,
      expiresAt: 0,
      lastRefreshAt: 0,
      lastError: null,
      timer
    });
  }
}

/**
 * 确保密钥新鲜（惰性刷新）
 * 在请求代理时调用，如果密钥过期则立即刷新
 * @param {object} provider - 供应商记录（来自 getProvider 查询）
 * @returns {string} 有效的 API Key
 */
async function ensureFreshKey(provider) {
  const providerId = provider.id;
  provider.api_key = decryptSecret(provider.api_key);
  const cached = keyCache.get(providerId);

  // 缓存中有未过期的密钥
  if (cached?.key && cached.expiresAt > Date.now() + REFRESH_AHEAD * 1000) {
    return cached.key;
  }

  // 数据库中有未过期的密钥（缓存未命中）
  if (provider.api_key && provider.key_expires_at) {
    const dbExpires = new Date(provider.key_expires_at).getTime();
    if (dbExpires > Date.now() + REFRESH_AHEAD * 1000) {
      // 回填缓存
      if (cached) {
        cached.key = provider.api_key;
        cached.expiresAt = dbExpires;
      } else {
        keyCache.set(providerId, {
          key: provider.api_key,
          expiresAt: dbExpires,
          lastRefreshAt: 0,
          lastError: null,
          timer: null
        });
      }
      // 调度到过期时刷新
      const remaining = Math.max(5, (dbExpires - Date.now()) / 1000 - REFRESH_AHEAD);
      scheduleRefresh(providerId, remaining);
      return provider.api_key;
    }
  }

  // 密钥过期或不存在，立即刷新
  Logger.info(`[KeyRefresher] 密钥过期/缺失，立即刷新: provider=${providerId}`);
  const refreshResult = await refreshProviderKey(providerId);
  if (refreshResult.success) {
    return refreshResult.key;
  }

  // 刷新失败，降级使用旧密钥
  if (provider.api_key) {
    Logger.warn(`[KeyRefresher] 刷新失败，降级使用旧密钥: provider=${providerId}`);
    return provider.api_key;
  }

  throw new Error(`供应商 ${providerId} 密钥刷新失败且无可用旧密钥: ${refreshResult.error}`);
}

/**
 * 启动时初始化所有 script 模式的供应商
 */
async function initAll() {
  try {
    const result = await pool.query(
      `SELECT * FROM providers WHERE key_mode = 'script' AND enabled = TRUE`
    );

    Logger.info(`[KeyRefresher] 初始化: 发现 ${result.rows.length} 个脚本模式供应商`);

    for (const provider of result.rows) {
      provider.api_key = decryptSecret(provider.api_key);
      // 检查是否有未过期的密钥
      const cached = keyCache.get(provider.id);
      if (cached?.key && cached.expiresAt > Date.now()) {
        // 已有缓存密钥，只调度刷新
        const remaining = Math.max(5, (cached.expiresAt - Date.now()) / 1000 - REFRESH_AHEAD);
        scheduleRefresh(provider.id, remaining);
        continue;
      }

      if (provider.api_key && provider.key_expires_at) {
        const dbExpires = new Date(provider.key_expires_at).getTime();
        if (dbExpires > Date.now()) {
          // DB 中有未过期密钥，回填缓存并调度
          keyCache.set(provider.id, {
            key: provider.api_key,
            expiresAt: dbExpires,
            lastRefreshAt: new Date(provider.key_last_refresh_at || 0).getTime(),
            lastError: provider.key_last_error || null,
            timer: null
          });
          const remaining = Math.max(5, (dbExpires - Date.now()) / 1000 - REFRESH_AHEAD);
          scheduleRefresh(provider.id, remaining);
          continue;
        }
      }

      // 无可用密钥，立即刷新
      refreshProviderKey(provider.id);
    }
  } catch (err) {
    Logger.error(`[KeyRefresher] 初始化失败: ${err.message}`);
  }
}

/**
 * 获取所有 script 模式供应商的刷新状态
 */
async function getRefreshStatus() {
  try {
    const result = await pool.query(
      `SELECT id, name, key_expires_at, key_last_refresh_at, key_last_error, key_refresh_interval
       FROM providers WHERE key_mode = 'script' AND enabled = TRUE`
    );

    return result.rows.map(p => {
      const cached = keyCache.get(p.id);
      return {
        providerId: p.id,
        providerName: p.name,
        hasKey: !!(cached?.key || p.key_expires_at),
        expiresAt: cached?.expiresAt ? new Date(cached.expiresAt).toISOString() : (p.key_expires_at || null),
        lastRefreshAt: cached?.lastRefreshAt ? new Date(cached.lastRefreshAt).toISOString() : (p.key_last_refresh_at || null),
        lastError: cached?.lastError || p.key_last_error || null,
        refreshInterval: p.key_refresh_interval || DEFAULT_REFRESH_INTERVAL,
        isExpired: (cached?.expiresAt || 0) < Date.now()
      };
    });
  } catch (err) {
    Logger.error(`[KeyRefresher] 获取状态失败: ${err.message}`);
    return [];
  }
}

/**
 * 注册/更新供应商的刷新计划
 * 当供应商配置变更时调用
 */
function registerProvider(provider) {
  if (provider.key_mode !== 'script') {
    // 非 script 模式，清除已有定时器
    const cached = keyCache.get(provider.id);
    if (cached?.timer) {
      clearTimeout(cached.timer);
    }
    keyCache.delete(provider.id);
    return;
  }

  // script 模式：调度刷新
  const interval = provider.key_refresh_interval || DEFAULT_REFRESH_INTERVAL;
  scheduleRefresh(provider.id, interval);
}

/**
 * 注销供应商
 */
function unregisterProvider(providerId) {
  const cached = keyCache.get(providerId);
  if (cached?.timer) {
    clearTimeout(cached.timer);
  }
  keyCache.delete(providerId);
}

module.exports = {
  ensureFreshKey,
  refreshProviderKey,
  getRefreshStatus,
  registerProvider,
  unregisterProvider,
  initAll
};
