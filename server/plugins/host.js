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
 *  - provider:register 允许注册新的客户端格式/上游适配器/协议转换器（provider:registerFormats）
 *  - apikey:modify    允许注册 apikey:validate / apikey:created 钩子
 *  - billing:modify   允许注册 billing:calculate 钩子（调整计费/配额）
 *  - cron:register    允许在清单中声明 cron 定时任务（由 host 调度）
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
  'stats:record',
]);

// 各钩子所需权限
const HOOK_PERMISSIONS = {
  'apikey:validate': 'apikey:modify',
  'apikey:created': 'apikey:modify',
  'billing:calculate': 'billing:modify',
  'provider:select': 'provider:register',
  'provider:registerFormats': 'provider:register',
};

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
  if (manifest.cron !== undefined) {
    if (!Array.isArray(manifest.cron)) return 'cron 必须是数组';
    for (const c of manifest.cron) {
      if (!c || typeof c.expr !== 'string' || !c.expr.trim()) return 'cron[].expr 缺失';
      if (!c.handler || typeof c.handler !== 'string') return 'cron[].handler 缺失';
    }
  }
  if (manifest.themes !== undefined) {
    if (!Array.isArray(manifest.themes)) return 'themes 必须是数组';
    for (const th of manifest.themes) {
      if (!th || !th.id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(th.id)) return 'themes[].id 缺失或不合法';
      if (!th.entry || typeof th.entry !== 'string' || th.entry.includes('..')) return `主题 ${th.id} 的 entry 必须是插件目录内的相对路径`;
    }
  }
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
      const need = HOOK_PERMISSIONS[hookName];
      if (need && !perms.has(need)) {
        throw new Error(`[plugins:${id}] 注册 ${hookName} 需要 ${need} 权限`);
      }
      hooksBus.subscribe(id, hookName, handler, priority);
    },
  };

  // 供应商格式注册：声明 provider:register 权限后，插件可新增客户端格式/上游适配器/协议转换器
  if (perms.has('provider:register')) {
    const providerRegistry = require('../providers');
    ctx.registerProviderFormat = (format, AdapterClass) => {
      if (!format || typeof format !== 'string') throw new Error(`[plugins:${id}] registerProviderFormat 需要格式名`);
      if (typeof AdapterClass !== 'function') throw new Error(`[plugins:${id}] registerProviderFormat 需要适配器类`);
      providerRegistry.registerAdapter(format, AdapterClass);
      Logger.info(`[plugins] ${id} 注册了上游格式 ${format}`);
    };
    ctx.registerTransform = (sourceFormat, targetFormat, transform) => {
      if (!sourceFormat || !targetFormat) throw new Error(`[plugins:${id}] registerTransform 需要源/目标格式`);
      if (!transform || typeof transform.request !== 'function' || typeof transform.response !== 'function') {
        throw new Error(`[plugins:${id}] registerTransform 需要 { request, response } 转换函数`);
      }
      providerRegistry.registerTransform(sourceFormat, targetFormat, transform);
      Logger.info(`[plugins] ${id} 注册了协议转换 ${sourceFormat}->${targetFormat}`);
    };
  }

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

  // 定时任务：清单 cron 字段 + cron:register 权限时，由 registry 调度（见 registry.schedulePluginCron）
  const registry = require('./registry');
  if (!plugin.cronHandlers) plugin.cronHandlers = {};
  ctx.cronHandler = (name, fn) => {
    if (!perms.has('cron:register')) {
      throw new Error(`[plugins:${id}] 声明 cron 定时任务需要 cron:register 权限`);
    }
    if (typeof fn !== 'function') throw new Error(`[plugins:${id}] cronHandler 需要回调函数`);
    plugin.cronHandlers[name] = fn;
  };
  ctx.scheduleCron = (expr, handler) => {
    if (!perms.has('cron:register')) {
      throw new Error(`[plugins:${id}] 声明 cron 定时任务需要 cron:register 权限`);
    }
    if (typeof handler !== 'function') throw new Error(`[plugins:${id}] scheduleCron 需要回调函数`);
    registry.schedulePluginCron(id, expr, handler);
  };

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
  HOOK_PERMISSIONS,
  HOOK_TIMEOUT_MS,
};
