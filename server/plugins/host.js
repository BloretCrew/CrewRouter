/**
 * 插件宿主
 *
 * 负责把磁盘上的插件 main.js 加载进 vm 沙箱，并构建权限受限的插件上下文（ctx）。
 * 权限模型（plugin.json 的 permissions 数组）：
 *  - storage        允许读写 plugin_data KV 存储
 *  - network        允许通过 ctx.fetch 访问外部地址（过 SSRF 校验）
 *  - gateway:modify 允许注册网关钩子（beforeUpstream / upstreamResponse 等）
 *  - pages:register 清单中声明的页面/插槽才会暴露给前端
 *  - routes:register 允许挂载自有 HTTP API
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pool } = require('../models/database');
const Logger = require('../logger');

// 网关类钩子统一要求 gateway:modify 权限
const GATEWAY_HOOKS = new Set([
  'gateway:requestReceived',
  'gateway:beforeUpstream',
  'gateway:upstreamResponse',
  'gateway:responseChunk',
  'gateway:finalResponse',
  'models:list',
]);

// 钩子执行超时（毫秒）
const HOOK_TIMEOUT_MS = 2000;
// ctx.fetch 单次请求超时（毫秒）
const PLUGIN_FETCH_TIMEOUT_MS = 10000;

/**
 * 校验清单结构，返回错误信息或 null
 */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'plugin.json 缺失或不是对象';
  if (!manifest.id || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(manifest.id)) {
    return 'plugin.json 缺少合法 id（小写字母数字与连字符）';
  }
  if (!manifest.name) return 'plugin.json 缺少 name';
  const perms = manifest.permissions || [];
  if (!Array.isArray(perms)) return 'permissions 必须是数组';
  if (manifest.pages && !Array.isArray(manifest.pages)) return 'pages 必须是数组';
  if (manifest.slots && !Array.isArray(manifest.slots)) return 'slots 必须是数组';
  if (manifest.routes && !Array.isArray(manifest.routes)) return 'routes 必须是数组';
  return null;
}

/**
 * 构建插件存储 API（plugin_data 表 KV）
 */
function buildStorage(pluginId, enabled) {
  return {
    async get(key) {
      const r = await pool.query('SELECT value FROM plugin_data WHERE plugin_id = $1 AND key = $2', [pluginId, String(key)]);
      return r.rows.length ? r.rows[0].value : null;
    },
    async set(key, value) {
      await pool.query(
        `INSERT INTO plugin_data (plugin_id, key, value) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (plugin_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [pluginId, String(key), JSON.stringify(value === undefined ? null : value)]
      );
    },
    async del(key) {
      await pool.query('DELETE FROM plugin_data WHERE plugin_id = $1 AND key = $2', [pluginId, String(key)]);
    },
  };
}

/**
 * 受控网络访问：声明 network 权限 + SSRF 校验 + 超时
 */
function buildFetch(pluginId) {
  return async function pluginFetch(url, options = {}) {
    const { validateUrl } = require('../utils/url-validator');
    const check = validateUrl(String(url), { allowPrivate: false });
    if (!check.ok) {
      throw new Error(`[plugins:${pluginId}] fetch 目标被 SSRF 校验拒绝: ${check.error}`);
    }
    const opts = { ...options, signal: AbortSignal.timeout(PLUGIN_FETCH_TIMEOUT_MS) };
    return fetch(url, opts);
  };
}

/**
 * 构建插件上下文
 */
function buildContext(plugin, hooksBus, logPrefix) {
  const { id, manifest, config } = plugin;
  const perms = new Set(manifest.permissions || []);
  const ctx = {
    pluginId: id,
    version: manifest.version || '',
    config: Object.freeze(JSON.parse(JSON.stringify(config || {}))),
    manifest: manifest,
    log: {
      info: (...a) => Logger.info(`[${logPrefix}]`, ...a),
      warn: (...a) => Logger.warn(`[${logPrefix}]`, ...a),
      error: (...a) => Logger.error(`[${logPrefix}]`, ...a),
    },
    // 钩子注册：按权限收口
    on(hookName, handler, priority) {
      if (GATEWAY_HOOKS.has(hookName) && !perms.has('gateway:modify')) {
        throw new Error(`[plugins:${id}] 注册 ${hookName} 需要 gateway:modify 权限`);
      }
      hooksBus.subscribe(id, hookName, handler, priority);
    },
  };

  // 插件自有 HTTP API：声明 routes:register 权限后可登记处理器
  if (perms.has('routes:register')) {
    const registry = require('./registry');
    ctx.expose = (method, routePath, fn) => {
      if (typeof fn !== 'function') throw new Error(`[plugins:${id}] expose 需要 async (req, res) 处理器`);
      registry.exposeHandler(id, method, routePath, async (req, res) => {
        // 沙箱外执行但限时，防插件挂死连接
        return await Promise.race([
          Promise.resolve(fn(req, res)),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`[plugins:${id}] 路由 ${routePath} 执行超时`)), HOOK_TIMEOUT_MS * 5)
          ),
        ]);
      });
    };
  }

  if (perms.has('storage')) ctx.storage = buildStorage(id);
  if (perms.has('network')) ctx.fetch = buildFetch(id);

  return ctx;
}

/**
 * 在 vm 沙箱中编译并初始化插件入口
 * main.js 约定：整个文件是一个 JS 表达式，求值为 async (ctx) => {...}
 */
async function loadPluginMain(plugin) {
  const mainPath = path.join(plugin.dir, 'main.js');
  if (!fs.existsSync(mainPath)) {
    return null; // 纯前端插件允许没有后端入口
  }
  const source = fs.readFileSync(mainPath, 'utf8');
  const safeGlobals = {};
  for (const name of ['Object', 'Array', 'String', 'Number', 'Boolean', 'Map', 'Set', 'Promise', 'Symbol',
    'JSON', 'Math', 'Date', 'RegExp', 'Error', 'TypeError', 'parseInt', 'parseFloat', 'isNaN',
    'encodeURIComponent', 'decodeURIComponent', 'structuredClone']) {
    if (global[name] !== undefined) safeGlobals[name] = global[name];
  }
  const context = vm.createContext(safeGlobals);
  const script = new vm.Script(`(${source})`, { filename: `plugin:${plugin.id}/main.js` });
  const factory = script.runInContext(context, { timeout: HOOK_TIMEOUT_MS });
  if (typeof factory !== 'function') {
    throw new Error('main.js 必须求值为函数（约定：async (ctx) => { ... }）');
  }
  return factory; // 由调用方传入 ctx 后执行
}

module.exports = {
  validateManifest,
  buildContext,
  loadPluginMain,
  GATEWAY_HOOKS,
  HOOK_TIMEOUT_MS,
};
