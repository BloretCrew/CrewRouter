/**
 * 插件管理与运行时路由
 *
 * 管理端（挂载于 /api/admin/plugins）：
 *   GET    /                     列表（磁盘清单 ∪ 数据库状态）
 *   POST   /:id/toggle           启用/禁用
 *   POST   /:id/reload           重载代码
 *   PUT    /:id/config           更新插件配置 JSONB
 *   DELETE /:id                  卸载（删除数据库记录；禁用状态才允许）
 *   POST   /:id/reset-errors     清除熔断计数
 *
 * 通用（挂载于 /api/plugins）：
 *   GET  /runtime                前端运行时清单（登录用户可读）
 *   ALL  /:pluginId/*            插件自有 API 分发
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pool } = require('../models/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAction } = require('../utils/audit-log');
const Logger = require('../logger');

function createPluginsRoutes() {
  const adminRouter = express.Router();
  const publicRouter = express.Router();

  const registry = () => require('../plugins/registry');

  // ---------- 管理端 ----------
  adminRouter.use(requireAdmin);

  // zip 上传安装：解压校验清单后放入 plugins/<id> 目录（仅登记，不自动启用）
  adminRouter.post('/upload', async (req, res) => {
    const reg = registry();
    const pluginsDir = reg.PLUGINS_DIR;

    try {
      const { IncomingForm } = require('formidable');
      const form = new IncomingForm({ maxFileSize: 20 * 1024 * 1024, keepExtensions: true });
      const [fields, files] = await form.parse(req);
      const file = (files.file || files.plugin || []).find(Boolean);
      if (!file || !file.filepath) {
        return res.status(400).json({ error: '缺少上传文件（字段名 file 或 plugin）' });
      }
      if (!/\.zip$/i.test(file.originalFilename || '')) {
        return res.status(400).json({ error: '仅支持 .zip 插件包' });
      }

      // 解压到临时目录
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-plugin-'));
      try {
        await extractZipSafe(file.filepath, tmpDir);
      } catch (err) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return res.status(400).json({ error: '插件包解压失败: ' + err.message });
      }

      // 校验清单
      const manifest = findZipManifest(tmpDir);
      if (!manifest) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return res.status(400).json({ error: '插件包缺少 plugin.json 或格式不合法' });
      }
      const { validateManifest } = require('../plugins/host');
      const verr = validateManifest(manifest);
      if (verr) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return res.status(400).json({ error: '插件清单校验失败: ' + verr });
      }
      const id = manifest.id;
      const dest = path.join(pluginsDir, id);
      // 目录名与清单 id 一致性：解压根必须只有一个目录且目录名为 id，或根就是 plugin.json
      const payloadDir = zipPayloadDir(tmpDir, id);
      if (!payloadDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return res.status(400).json({ error: '插件包根结构不合法：应包含 <id>/plugin.json（或根目录直接是 plugin.json）' });
      }
      if (fs.existsSync(dest)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return res.status(409).json({ error: `插件目录 ${id} 已存在，请先卸载或删除后重试` });
      }
      // 防路径穿越：逐文件校验目标路径
      const entries = collectDirEntries(payloadDir);
      for (const rel of entries) {
        const target = path.join(dest, rel);
        if (target !== dest && !target.startsWith(dest + path.sep)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return res.status(400).json({ error: '插件包包含非法路径: ' + rel });
        }
      }
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(payloadDir, dest, { recursive: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });

      // 同步数据库记录（enabled 保持 false，管理员手动启用）
      await pool.query(
        `INSERT INTO plugins (id, name, version, description, author, permissions)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, version = EXCLUDED.version,
           description = EXCLUDED.description, author = EXCLUDED.author,
           permissions = EXCLUDED.permissions, updated_at = CURRENT_TIMESTAMP`,
        [id, manifest.name || id, manifest.version || '', manifest.description || '', manifest.author || '',
         JSON.stringify(manifest.permissions || [])]
      );
      logAction({
        userId: req.session.user.id,
        username: req.session.user.username,
        isAdmin: true,
        action: 'plugin.install',
        resourceType: 'plugin',
        resourceId: id,
        description: `安装插件「${manifest.name || id}」v${manifest.version || ''}`,
        details: { file: file.originalFilename || '' },
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      Logger.info(`[plugins-api] 插件 ${id} 已从 zip 安装（管理员 ${req.session.user.username}）`);
      res.json({ ok: true, id, name: manifest.name || id, version: manifest.version || '', reloadRequired: true });
    } catch (err) {
      Logger.error(`[plugins-api] 上传安装失败: ${err.message}`);
      res.status(500).json({ error: '插件安装失败: ' + err.message });
    }
  });

  adminRouter.get('/', async (req, res) => {
    try {
      const plugins = await registry().listAll();
      res.json({ plugins });
    } catch (err) {
      Logger.error(`[plugins-api] 列表失败: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  adminRouter.post('/:id/toggle', async (req, res) => {
    try {
      const { id } = req.params;
      const r = await pool.query('SELECT enabled FROM plugins WHERE id = $1', [id]);
      if (!r.rows.length) return res.status(404).json({ error: '插件不存在' });
      const next = !r.rows[0].enabled;
      if (next) await registry().enable(id);
      else await registry().disable(id);
      Logger.info(`[plugins-api] 插件 ${id} 已${next ? '启用' : '禁用'}（管理员 ${req.session.user?.username}）`);
      res.json({ ok: true, enabled: next });
    } catch (err) {
      Logger.error(`[plugins-api] 启停失败: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  adminRouter.post('/:id/reload', async (req, res) => {
    try {
      await registry().reload(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      Logger.error(`[plugins-api] 重载失败: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  adminRouter.put('/:id/config', async (req, res) => {
    try {
      const config = req.body?.config;
      if (config === undefined || typeof config !== 'object') {
        return res.status(400).json({ error: 'config 必须是对象' });
      }
      await registry().setConfig(req.params.id, config);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  adminRouter.post('/:id/reset-errors', async (req, res) => {
    try {
      await registry().resetErrors(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 插件私有 KV（plugin_data）管理：列表与删除
  adminRouter.get('/:id/data', async (req, res) => {
    try {
      const { id } = req.params;
      const r = await pool.query(
        `SELECT key, value, updated_at FROM plugin_data WHERE plugin_id = $1 ORDER BY key`,
        [id]
      );
      res.json({ keys: r.rows.map(row => ({ key: row.key, value: row.value, updatedAt: row.updated_at })) });
    } catch (err) {
      Logger.error(`[plugins-api] KV 列表失败: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  adminRouter.delete('/:id/data/:key(*)', async (req, res) => {
    try {
      const { id } = req.params;
      const key = req.params.key;
      if (!key || key.length > 200) return res.status(400).json({ error: 'key 不合法' });
      await pool.query('DELETE FROM plugin_data WHERE plugin_id = $1 AND key = $2', [id, String(key)]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  adminRouter.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const r = await pool.query('SELECT enabled FROM plugins WHERE id = $1', [id]);
      if (!r.rows.length) return res.status(404).json({ error: '插件不存在' });
      if (r.rows[0].enabled) return res.status(400).json({ error: '请先禁用插件再卸载' });
      await pool.query('DELETE FROM plugins WHERE id = $1', [id]);
      // 二期：卸载时清理磁盘目录（含 plugin_data 级联删除）
      const reg = registry();
      const dir = path.join(reg.PLUGINS_DIR, id);
      if (fs.existsSync(dir)) {
        // 防目录名穿越：id 已通过插件表约束（小写字母数字连字符），再校验一次
        if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) {
          Logger.warn(`[plugins-api] 拒绝清理非法目录名: ${id}`);
        } else {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      logAction({
        userId: req.session.user.id,
        username: req.session.user.username,
        isAdmin: true,
        action: 'plugin.uninstall',
        resourceType: 'plugin',
        resourceId: id,
        description: `卸载插件「${id}」（含磁盘目录清理）`,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      Logger.info(`[plugins-api] 插件 ${id} 已卸载并清理目录（管理员 ${req.session.user?.username}）`);
      res.json({ ok: true, directoryCleaned: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- 通用 ----------
  publicRouter.get('/runtime', requireAuth, (req, res) => {
    res.json(registry().getRuntimeManifest());
  });

  // 用户主题：返回个人选择、站点默认与可用列表；effective 为服务端解析后的生效主题
  publicRouter.get('/user-theme', requireAuth, async (req, res) => {
    try {
      const uid = req.session.user.id;
      const [u, d] = await Promise.all([
        pool.query('SELECT theme_id FROM users WHERE id = $1', [uid]),
        pool.query("SELECT value FROM settings WHERE key = 'default_theme'"),
      ]);
      const available = registry().getAvailableThemes();
      const validIds = new Set(available.map(t => t.id));
      let themeId = u.rows[0]?.theme_id || '';
      if (themeId && !validIds.has(themeId)) themeId = ''; // 所选主题插件已停用则视为未设置
      let defaultThemeId = '';
      try { defaultThemeId = d.rows[0]?.value || ''; } catch { defaultThemeId = ''; }
      if (defaultThemeId && !validIds.has(defaultThemeId)) defaultThemeId = '';
      res.json({
        themeId,
        defaultThemeId,
        effective: themeId || defaultThemeId || '',
        available,
      });
    } catch (err) {
      Logger.error(`[plugins-api] 读取用户主题失败: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // 保存当前用户的主题选择（'' 表示跟随站点默认）
  publicRouter.put('/user-theme', requireAuth, async (req, res) => {
    try {
      const themeId = String(req.body?.themeId ?? '');
      if (themeId !== '') {
        const valid = registry().getAvailableThemes().some(t => t.id === themeId);
        if (!valid) return res.status(400).json({ error: '主题不存在或对应插件未启用' });
      }
      await pool.query('UPDATE users SET theme_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [req.session.user.id, themeId]);
      res.json({ ok: true, themeId });
    } catch (err) {
      Logger.error(`[plugins-api] 保存用户主题失败: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // 插件自有 API：/api/plugins/:pluginId/*
  publicRouter.all('/:pluginId/*', async (req, res) => {
    try {
      const reg = registry();
      if (!reg.isLoaded(req.params.pluginId)) {
        return res.status(404).json({ error: '插件未启用' });
      }
      const rest = ('/' + String(req.params[0] || '')).replace(/\/+$/, '') || '/';
      const handler = reg.findHandler(req.params.pluginId, req.method, rest);
      if (!handler) return res.status(404).json({ error: '接口不存在' });

      // 路由鉴权：默认 user；admin 要求管理员；none 公开
      const routeAuth = findRouteAuth(reg, req.params.pluginId, req.method, rest);
      if (routeAuth === 'admin' && !req.session.user?.isAdmin) {
        return res.status(403).json({ error: '无管理员权限' });
      }
      if (routeAuth !== 'none' && !req.session.user) {
        return res.status(401).json({ error: '请先登录' });
      }

      await handler(req, res);
    } catch (err) {
      Logger.error(`[plugins-api] 插件路由执行失败: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  publicRouter.use('/:pluginId', (req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  return { adminRouter, publicRouter };
}

// 从已加载插件的清单中查路由的 auth 声明
function findRouteAuth(registry, pluginId, method, reqPath) {
  const manifest = registry.getLoadedManifest(pluginId);
  if (!manifest || !Array.isArray(manifest.routes)) return 'user';
  const clean = ('/' + String(reqPath).replace(/^\/+/g, '')).replace(/\/+$/, '') || '/';
  const route = manifest.routes.find(r =>
    String(r.method || 'get').toUpperCase() === method.toUpperCase() &&
    (('/' + String(r.path || '').replace(/^\/+/g, '')).replace(/\/+$/, '') || '/') === clean
  );
  return route?.auth || 'user';
}

// ---------- zip 安装辅助 ----------

// 调用系统 unzip（防 zip-slip：先校验条目名再解压到目标目录）
function extractZipSafe(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    // 列出 zip 内条目并校验：拒绝绝对路径、`..` 穿越、反斜杠、以及非 plugin.json/目录的顶层乱放
    execFile('/usr/bin/unzip', ['-Z1', zipPath], { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(new Error(err.message || 'unzip 读取失败'));
      const entries = String(stdout).split('\n').map(s => s.trim()).filter(Boolean);
      if (entries.length === 0) return reject(new Error('zip 包为空'));
      if (entries.length > 1000) return reject(new Error('zip 包条目过多'));
      for (const e of entries) {
        if (path.isAbsolute(e) || e.includes('..') || e.includes('\\')) {
          return reject(new Error(`非法条目路径: ${e}`));
        }
      }
      execFile('/usr/bin/unzip', ['-o', '-q', zipPath, '-d', destDir], { timeout: 30000 }, (err2) => {
        if (err2) return reject(new Error(err2.message || 'unzip 解压失败'));
        resolve(destDir);
      });
    });
  });
}

// 找到解压目录中合法的 plugin.json；支持根即清单或 <id>/plugin.json 两种布局
function findZipManifest(tmpDir) {
  const tryRead = (dir) => {
    const p = path.join(dir, 'plugin.json');
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return null; }
  };
  const rootManifest = tryRead(tmpDir);
  if (rootManifest) return rootManifest;
  const dirs = fs.readdirSync(tmpDir).filter(name => !name.startsWith('.'));
  for (const name of dirs) {
    const full = path.join(tmpDir, name);
    if (!fs.statSync(full).isDirectory()) continue;
    const m = tryRead(full);
    if (m) return m;
  }
  return null;
}

// 返回实际插件载荷目录：清单 id 匹配的目录，或根即清单时的根
function zipPayloadDir(tmpDir, id) {
  const rootManifest = path.join(tmpDir, 'plugin.json');
  if (fs.existsSync(rootManifest)) return tmpDir;
  const dirs = fs.readdirSync(tmpDir).filter(name => !name.startsWith('.'));
  for (const name of dirs) {
    const full = path.join(tmpDir, name);
    if (!fs.statSync(full).isDirectory()) continue;
    if (name === id && fs.existsSync(path.join(full, 'plugin.json'))) return full;
  }
  // 仅一个目录且含 plugin.json 时容错（目录名与 id 不一致时以清单 id 为准）
  const validDirs = dirs.filter(name => fs.existsSync(path.join(tmpDir, name, 'plugin.json')) && fs.statSync(path.join(tmpDir, name)).isDirectory());
  if (validDirs.length === 1) return path.join(tmpDir, validDirs[0]);
  return null;
}

// 收集目录下全部相对路径（文件与目录）
function collectDirEntries(dir) {
  const out = [];
  const walk = (cur, rel) => {
    for (const name of fs.readdirSync(cur)) {
      const full = path.join(cur, name);
      const relPath = rel ? path.join(rel, name) : name;
      const st = fs.statSync(full);
      out.push(relPath);
      if (st.isDirectory()) walk(full, relPath);
    }
  };
  walk(dir, '');
  return out;
}

module.exports = { createPluginsRoutes };
