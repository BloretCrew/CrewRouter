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
const { extractZipSafe, findZipManifest, zipPayloadDir, collectDirEntries } = require('../plugins/zip');
const storeClient = require('../plugins/store-client');
const Logger = require('../logger');

function createPluginsRoutes() {
  const adminRouter = express.Router();
  const publicRouter = express.Router();

  const registry = () => require('../plugins/registry');

  // ---------- 管理端 ----------
  adminRouter.use(requireAdmin);

  // 从商店拉取插件包信息（供 /plugin-install 确认页渲染；仅管理员可查看）
  adminRouter.get('/store-package', async (req, res) => {
    try {
      const pluginId = String(req.query.plugin || '').trim();
      const source = String(req.query.source || '').trim();
      if (!pluginId) return res.status(400).json({ error: '缺少插件 id' });
      if (!storeClient.isAllowedSource(source)) return res.status(400).json({ error: '插件商店源不受信任' });
      const plugin = await storeClient.fetchPackageInfo(source, pluginId);
      res.json({ ok: true, plugin });
    } catch (err) {
      Logger.error('[plugins-api] store-package 失败', err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // 从商店一键安装：下载 → sha256 → 解压校验 → 放入 plugins/<id> → 自动启用
  adminRouter.post('/install-from-store', async (req, res) => {
    const reg = registry();
    const pluginsDir = reg.PLUGINS_DIR;
    try {
      const pluginId = String((req.body && req.body.plugin) || '').trim();
      const source = String((req.body && req.body.source) || '').trim();
      if (!pluginId) return res.status(400).json({ error: '缺少插件 id' });
      if (!storeClient.isAllowedSource(source)) return res.status(400).json({ error: '插件商店源不受信任' });

      // 服务端向商店拉取包信息（不信任客户端提供的 download/sha256）
      const info = await storeClient.fetchPackageInfo(source, pluginId);
      if (!info || !info.download || !String(info.download).startsWith('https://')) {
        return res.status(400).json({ error: '插件下载地址必须为 https:// 直链' });
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-store-install-'));
      const zipPath = path.join(tmpDir, 'plugin.zip');
      try {
        await storeClient.downloadPackage(info.download, zipPath, info.sha256 || '');
        const extractDir = path.join(tmpDir, 'extract');
        await extractZipSafe(zipPath, extractDir);
        const manifest = findZipManifest(extractDir);
        if (!manifest) return res.status(400).json({ error: '插件包缺少 plugin.json 或格式不合法' });
        const { validateManifest } = require('../plugins/host');
        const verr = validateManifest(manifest);
        if (verr) return res.status(400).json({ error: '插件清单校验失败: ' + verr });
        const id = manifest.id;
        const payloadDir = zipPayloadDir(extractDir, id);
        if (!payloadDir) return res.status(400).json({ error: '插件包根结构不合法' });
        const dest = path.join(pluginsDir, id);
        // 防路径穿越：逐文件校验目标路径
        const entries = collectDirEntries(payloadDir);
        for (const rel of entries) {
          const target = path.join(dest, rel);
          if (target !== dest && !target.startsWith(dest + path.sep)) {
            return res.status(400).json({ error: '插件包包含非法路径: ' + rel });
          }
        }
        // 覆盖升级：先备份旧目录，失败再回滚
        if (fs.existsSync(dest)) {
          const backup = dest + '.bak-' + Date.now();
          fs.renameSync(dest, backup);
          try {
            fs.mkdirSync(dest, { recursive: true });
            fs.cpSync(payloadDir, dest, { recursive: true });
            fs.rmSync(backup, { recursive: true, force: true });
          } catch (err) {
            try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) {}
            try { if (fs.existsSync(backup)) fs.renameSync(backup, dest); } catch (e) {}
            throw err;
          }
        } else {
          fs.mkdirSync(dest, { recursive: true });
          fs.cpSync(payloadDir, dest, { recursive: true });
        }

        await pool.query(
          `INSERT INTO plugins (id, name, version, description, author, permissions, enabled,
             store_id, store_source, store_download, store_sha256)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,true,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET
             name=EXCLUDED.name, version=EXCLUDED.version, description=EXCLUDED.description,
             author=EXCLUDED.author, permissions=EXCLUDED.permissions, enabled=true,
             store_id=EXCLUDED.store_id, store_source=EXCLUDED.store_source,
             store_download=EXCLUDED.store_download, store_sha256=EXCLUDED.store_sha256,
             store_latest_version=NULL, store_update_available=false, store_latest=NULL,
             updated_at=CURRENT_TIMESTAMP`,
          [id, manifest.name || id, manifest.version || '', manifest.description || '', manifest.author || '',
           JSON.stringify(manifest.permissions || []), info.id || id, source, info.download || '', info.sha256 || '']
        );
        try { await reg.reload(id); } catch (e) { Logger.warn('[plugins-api] 安装后 reload 失败', e.message); }

        logAction({
          userId: req.session.user.id,
          username: req.session.user.username,
          isAdmin: true,
          action: 'plugin.install',
          resourceType: 'plugin',
          resourceId: id,
          description: `从商店安装插件「${manifest.name || id}」v${manifest.version || ''}`,
          details: { source, download: info.download || '' },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        // 异步上报商店安装计数（失败不影响）
        try {
          await fetch(`${source.replace(/\/+$/, '')}/store/api/plugins/${encodeURIComponent(id)}/install-click`, { method: 'POST' });
        } catch (e) { /* 忽略 */ }
        Logger.info(`[plugins-api] 插件 ${id} 已从商店安装并启用（管理员 ${req.session.user?.username}）`);
        res.json({ ok: true, id, name: manifest.name || id, version: manifest.version || '', reloadRequired: true });
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
      }
    } catch (err) {
      Logger.error('[plugins-api] 从商店安装失败', err.message);
      res.status(err.status || 500).json({ error: '插件安装失败: ' + err.message });
    }
  });

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

module.exports = { createPluginsRoutes };
