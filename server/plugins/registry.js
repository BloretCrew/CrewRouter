/**
 * 插件注册中心
 *
 * 职责：
 *  - 扫描插件目录，校验清单并同步到 plugins 表（不改变 enabled 状态）
 *  - 加载已启用插件：vm 沙箱初始化 + 钩子注册 + 前端运行时清单收集
 *  - 提供 启用/禁用/重载/卸载 与错误熔断
 *  - 提供插件自有 HTTP API 的动态分发（避免反复增删 Express 路由）
 */

const fs = require('fs');
const path = require('path');
const { pool } = require('../models/database');
const Logger = require('../logger');
const hooksBus = require('./hooks');
const host = require('./host');

// 插件目录：开发在项目根 plugins/；构建后在 dist/plugins/ 或上级
const PLUGINS_DIR = (() => {
  const candidates = [
    path.join(__dirname, '../../plugins'),
    path.join(__dirname, '../plugins'),
    path.join(process.cwd(), 'plugins'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
  }
  return candidates[0];
})();

// 已加载的运行中插件：id -> { id, dir, manifest, config, frontendEntries: Set }
const loaded = new Map();

// 已同步到 DB 的磁盘清单：id -> manifest（含未启用的）
const knownManifests = new Map();

// 插件自定义的定时任务：id -> [{ expr, handler, nextTimeout }]
const cronJobs = new Map();
const CRON_CHECK_MS = 60000; // 每分钟对下一触发做一次调度精度校正

let initialized = false;

function listPluginDirs() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  return fs.readdirSync(PLUGINS_DIR)
    .filter(name => !name.startsWith('.'))
    .map(name => path.join(PLUGINS_DIR, name))
    .filter(p => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'plugin.json')));
}

function readManifest(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    const err = host.validateManifest(raw);
    if (err) {
      Logger.warn(`[plugins] 清单无效 ${dir}: ${err}`);
      return null;
    }
    // 目录名与清单 id 必须一致，避免路由歧义
    if (path.basename(dir) !== raw.id) {
      Logger.warn(`[plugins] 目录名与清单 id 不一致，跳过: ${dir} ≠ ${raw.id}`);
      return null;
    }
    return raw;
  } catch (e) {
    Logger.warn(`[plugins] 读取清单失败 ${dir}: ${e.message}`);
    return null;
  }
}

/**
 * 把磁盘清单同步进 plugins 表（首次发现即建行；enabled 保持既有值或默认 false）
 */
async function syncDbRecords() {
  for (const [id, m] of knownManifests.entries()) {
    await pool.query(
      `INSERT INTO plugins (id, name, version, description, author, permissions)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         version = EXCLUDED.version,
         description = EXCLUDED.description,
         author = EXCLUDED.author,
         permissions = EXCLUDED.permissions,
         updated_at = CURRENT_TIMESTAMP`,
      [id, m.name || id, m.version || '', m.description || '', m.author || '', JSON.stringify(m.permissions || [])]
    );
  }
}

async function loadOne(id, manifest, rowConfig) {
  unloadOne(id);
  const dir = path.join(PLUGINS_DIR, id);
  const plugin = { id, dir, manifest, config: rowConfig || {} };

  const entryPath = path.join(dir, 'main.js');
  if (fs.existsSync(entryPath)) {
    const factory = await host.loadPluginMain(plugin);
    const perms = new Set(manifest.permissions || []);
    const logPrefix = `plugin:${id}`;
    const ctx = host.buildContext(plugin, hooksBus, logPrefix);
    await factory(ctx); // 初始化：内部调用 ctx.on(...) 注册钩子
    // provider:registerFormats 钩子：插件可在启动时声明式注册客户端格式/上游适配器/协议转换器
    if (hooksBus.hasSubscribers('provider:registerFormats')) {
      await hooksBus.apply('provider:registerFormats', { pluginId: id }, { pluginId: id }).catch(err =>
        Logger.warn(`[plugins] ${id} provider:registerFormats 钩子异常: ${err.message}`)
      );
    }
    Logger.info(`[plugins] 已加载插件 ${id}${perms.has('gateway:modify') ? '（网关钩子）' : ''}`);
  }

  loaded.set(id, plugin);
  // 定时任务：基于清单 cron 重建（仅 cron:register 权限）
  rebuildCron(id, manifest);
}

function unloadOne(id) {
  hooksBus.unsubscribePlugin(id);
  clearPluginCron(id);
  loaded.delete(id);
}

// ---------- 定时任务（cron 表达式由 host 调度） ----------

// 五段 cron 展开：秒固定为 0，支持 */n、固定数字、数字列表与范围
function expandCronField(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    const p = part.trim();
    if (!p) continue;
    let step = 1;
    let range = null;
    if (p === '*') {
      range = [min, max];
      step = 1;
    } else if (p.includes('/')) {
      const [base, st] = p.split('/');
      step = parseInt(st, 10) || 1;
      if (base === '*' || base === '') range = [min, max];
      else if (base.includes('-')) {
        const [a, b] = base.split('-').map(Number);
        range = [Math.min(a, b), Math.max(a, b)];
      } else range = [parseInt(base, 10), parseInt(base, 10)];
    } else if (p.includes('-')) {
      const [a, b] = p.split('-').map(Number);
      range = [Math.min(a, b), Math.max(a, b)];
      step = 1;
    } else {
      range = [parseInt(p, 10), parseInt(p, 10)];
      step = 1;
    }
    if (!Number.isFinite(range[0]) || !Number.isFinite(range[1])) continue;
    for (let v = range[0]; v <= range[1]; v += step) {
      if (v >= min && v <= max) out.add(v);
    }
  }
  return out;
}

function matchCron(expr, date) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dom, month, dow] = parts;
  const nowMinute = date.getMinutes();
  const nowHour = date.getHours();
  const nowDay = date.getDate();
  const nowMonth = date.getMonth() + 1;
  const nowDow = date.getDay();
  return (
    expandCronField(minute, 0, 59).has(nowMinute) &&
    expandCronField(hour, 0, 23).has(nowHour) &&
    expandCronField(dom, 1, 31).has(nowDay) &&
    expandCronField(month, 1, 12).has(nowMonth) &&
    expandCronField(dow, 0, 6).has(nowDow)
  );
}

function schedulePluginCron(pluginId, expr, handler) {
  const list = cronJobs.get(pluginId) || [];
  // 同插件同表达式幂等：替换旧 handler
  const idx = list.findIndex(j => j.expr === expr);
  const job = { expr, handler, nextTimeout: null };
  if (idx >= 0) {
    clearTimeout(list[idx].nextTimeout);
    list[idx] = job;
  } else {
    list.push(job);
  }
  cronJobs.set(pluginId, list);
  scheduleNextCron(pluginId, job);
  Logger.info(`[plugins] 插件 ${pluginId} 已注册定时任务 "${expr}"`);
}

// 为单个任务安排下一次触发：精确到分钟，与精确触发之间的误差由 CRON_CHECK_MS 兜底校正
function scheduleNextCron(pluginId, job) {
  clearTimeout(job.nextTimeout);
  const now = new Date();
  const target = new Date(now);
  target.setSeconds(0, 0);
  target.setMinutes(target.getMinutes() + 1);
  // 向前探测至多 60 分钟内的匹配窗口
  let found = null;
  for (let i = 0; i < 60; i++) {
    if (matchCron(job.expr, target)) { found = target; break; }
    target.setMinutes(target.getMinutes() + 1);
  }
  if (!found) {
    // 60 分钟窗口内无匹配：以整点窗口检查兜底，每分钟校一次
    job.nextTimeout = setTimeout(() => {
      const now2 = new Date();
      if (matchCron(job.expr, now2)) fireCron(pluginId, job);
      scheduleNextCron(pluginId, job);
    }, CRON_CHECK_MS);
    return;
  }
  const delay = Math.max(1000, found.getTime() - Date.now());
  job.nextTimeout = setTimeout(() => {
    fireCron(pluginId, job);
    scheduleNextCron(pluginId, job);
  }, delay);
}

async function fireCron(pluginId, job) {
  const p = loaded.get(pluginId);
  if (!p) return;
  try {
    await Promise.race([
      Promise.resolve(job.handler()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('cron 任务执行超时')), host.HOOK_TIMEOUT_MS * 5)),
    ]);
  } catch (err) {
    Logger.error(`[plugins] 插件 ${pluginId} cron "${job.expr}" 执行失败: ${err.message}`);
  }
}

function clearPluginCron(pluginId) {
  const list = cronJobs.get(pluginId);
  if (list) {
    for (const j of list) clearTimeout(j.nextTimeout);
    cronJobs.delete(pluginId);
  }
}

// 重建某插件的 cron：禁用/重载后以 manifest.cron 重新注册（仅 cron:register 权限）
function rebuildCron(pluginId, manifest) {
  clearPluginCron(pluginId);
  const p = loaded.get(pluginId);
  if (!p) return;
  const perms = new Set(manifest.permissions || []);
  if (!perms.has('cron:register')) return;
  for (const c of manifest.cron || []) {
    // handler 名解析到插件沙箱上下文中的函数（由 host 在 ctx.scheduleCron 中注册）
    const fn = p.cronHandlers?.[c.handler];
    if (typeof fn === 'function') schedulePluginCron(pluginId, c.expr, fn);
  }
}

/**
 * 服务启动时调用（非 demo 模式）
 */
async function init() {
  if (initialized) return;
  initialized = true;

  hooksBus.setErrorReporter(reportPluginError);

  const manifests = {};
  for (const dir of listPluginDirs()) {
    const m = readManifest(dir);
    if (m) manifests[m.id] = m;
  }
  knownManifests.clear();
  Object.entries(manifests).forEach(([id, m]) => knownManifests.set(id, m));

  await syncDbRecords();

  // 加载所有已启用插件
  try {
    const r = await pool.query('SELECT id, config FROM plugins WHERE enabled = TRUE');
    for (const row of r.rows) {
      const m = knownManifests.get(row.id);
      if (!m) {
        Logger.warn(`[plugins] 数据库中启用的插件在磁盘上不存在: ${row.id}`);
        continue;
      }
      try {
        await loadOne(row.id, m, row.config);
      } catch (e) {
        Logger.error(`[plugins] 加载插件失败 ${row.id}: ${e.message}`);
        await markError(row.id, e.message, true);
      }
    }
  } catch (e) {
    Logger.warn(`[plugins] 已启用插件加载跳过: ${e.message}`);
  }

  Logger.info(`[plugins] 插件系统就绪（磁盘 ${knownManifests.size} 个，运行中 ${loaded.size} 个）`);
}

async function reportPluginError(pluginId, hookName, err, consecutive) {
  const msg = `钩子 ${hookName} 连续第 ${consecutive} 次报错: ${err.message}`;
  if (consecutive >= hooksBus.ERROR_THRESHOLD && loaded.has(pluginId)) {
    // 熔断：摘除钩子并在管理界面可见
    unloadOne(pluginId);
    Logger.error(`[plugins] 插件 ${pluginId} 触发熔断，已停用其钩子`);
    await markError(pluginId, `熔断：${msg}`, true).catch(() => {});
    return;
  }
  Logger.warn(`[plugins] 插件 ${pluginId} ${msg}`);
  await markError(pluginId, msg, false).catch(() => {});
}

async function markError(pluginId, message, disabledHooks) {
  await pool.query(
    `UPDATE plugins SET last_error = $2,
       error_count = CASE WHEN $3 THEN 0 ELSE error_count + 1 END,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [pluginId, String(message).slice(0, 2000), !!disabledHooks]
  );
}

async function resetErrors(pluginId) {
  await pool.query('UPDATE plugins SET error_count = 0, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [pluginId]);
}

/**
 * 启用插件（管理员操作）
 */
async function enable(id) {
  const m = knownManifests.get(id);
  if (!m) throw new Error(`插件不存在: ${id}`);
  const r = await pool.query('SELECT config FROM plugins WHERE id = $1', [id]);
  await loadOne(id, m, r.rows[0]?.config);
  await pool.query(
    'UPDATE plugins SET enabled = TRUE, error_count = 0, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
    [id]
  );
  return true;
}

/**
 * 禁用插件（管理员操作）
 */
async function disable(id) {
  unloadOne(id);
  await pool.query('UPDATE plugins SET enabled = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  return true;
}

/**
 * 重载插件代码（管理员操作）：仅在启用状态下重新加载
 */
async function reload(id) {
  const st = await pool.query('SELECT enabled, config FROM plugins WHERE id = $1', [id]);
  if (!st.rows.length) throw new Error(`插件不存在: ${id}`);
  // 重新读磁盘清单（可能已更新）
  const dir = path.join(PLUGINS_DIR, id);
  const m = readManifest(dir);
  if (!m) throw new Error('清单读取失败');
  knownManifests.set(id, m);
  delete require.cache[path.join(dir, 'main.js')];

  if (st.rows[0].enabled) {
    await loadOne(id, m, st.rows[0].config);
  }
  await pool.query(
    'UPDATE plugins SET version = $2, description = $3, author = $4, permissions = $5::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
    [id, m.version || '', m.description || '', m.author || '', JSON.stringify(m.permissions || [])]
  );
  return true;
}

async function setConfig(id, config) {
  await pool.query('UPDATE plugins SET config = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id, JSON.stringify(config || {})]);
  // 运行中的插件热更新内存里的 config 引用
  const p = loaded.get(id);
  if (p) p.config = config || {};
  return true;
}

/**
 * 管理列表：磁盘已知清单 ∪ 数据库状态（含数据库有但磁盘缺的）
 */
async function listAll() {
  const rows = (await pool.query('SELECT * FROM plugins ORDER BY id')).rows;
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    author: row.author,
    enabled: row.enabled,
    permissions: row.permissions || [],
    config: row.config || {},
    errorCount: row.error_count || 0,
    lastError: row.last_error || null,
    onDisk: knownManifests.has(row.id),
    loaded: loaded.has(row.id),
    pages: (knownManifests.get(row.id)?.pages || []),
    slots: (knownManifests.get(row.id)?.slots || []),
    routes: (knownManifests.get(row.id)?.routes || []),
    cron: (knownManifests.get(row.id)?.cron || []),
  }));
}

/**
 * 前端运行时清单：仅已启用且声明 pages:register 权限的插件。
 * pages/slots 原样下发（带 area 字段），由前端按所在区域自行过滤；
 * themes 仅对声明 themes:register 权限的插件下发，id 为全局唯一的 `<pluginId>/<themeId>`。
 */
function getRuntimeManifest() {
  const out = [];
  for (const [id, p] of loaded.entries()) {
    const perms = p.manifest.permissions || [];
    const themes = perms.includes('themes:register')
      ? (p.manifest.themes || []).map(th => ({
          id: `${id}/${th.id}`,
          name: th.name || th.id,
          url: `/plugins/${id}/${String(th.entry).replace(/^\/+/, '')}?v=${encodeURIComponent(p.manifest.version || '')}`,
        }))
      : [];
    out.push({
      id,
      name: p.manifest.name,
      version: p.manifest.version || '',
      pages: (p.manifest.pages || []),
      slots: (p.manifest.slots || []),
      themes,
      assetsBase: `/plugins/${id}`,
    });
  }
  return { plugins: out };
}

/**
 * 当前可用主题扁平列表（跨插件汇总）
 */
function getAvailableThemes() {
  return getRuntimeManifest().plugins.flatMap(p => p.themes || []);
}

/**
 * 插件自有 HTTP API 分发（挂在 /api/plugins/:pluginId 下）
 * manifest.routes: [{ method, path, auth: 'user'|'admin'|'none', handler? }]
 * handler 在 main.js 求值后通过 ctx.expose(routePath, fn) 登记；
 * 未登记 handler 的路由返回 501。
 */
const exposedHandlers = new Map(); // `${id} ${METHOD} ${path}` -> async fn(req, res)

function exposeHandler(pluginId, method, routePath, fn) {
  exposedHandlers.set(`${pluginId} ${String(method).toUpperCase()} ${routePath}`, fn);
}

function findHandler(pluginId, method, reqPath) {
  const clean = ('/' + String(reqPath).replace(/^\/+/g, '')).replace(/\/+$/, '') || '/';
  return exposedHandlers.get(`${pluginId} ${String(method).toUpperCase()} ${clean}`) || null;
}

module.exports = {
  PLUGINS_DIR,
  init,
  enable,
  disable,
  reload,
  setConfig,
  listAll,
  getRuntimeManifest,
  getAvailableThemes,
  resetErrors,
  exposeHandler,
  findHandler,
  schedulePluginCron,
  clearPluginCron,
  isLoaded: id => loaded.has(id),
  getLoadedManifest: id => loaded.get(id)?.manifest || null,
};
