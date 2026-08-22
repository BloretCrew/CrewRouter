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
const { pool } = require('../models/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Logger = require('../logger');

function createPluginsRoutes() {
  const adminRouter = express.Router();
  const publicRouter = express.Router();

  const registry = () => require('../plugins/registry');

  // ---------- 管理端 ----------
  adminRouter.use(requireAdmin);

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

  adminRouter.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const r = await pool.query('SELECT enabled FROM plugins WHERE id = $1', [id]);
      if (!r.rows.length) return res.status(404).json({ error: '插件不存在' });
      if (r.rows[0].enabled) return res.status(400).json({ error: '请先禁用插件再卸载' });
      await pool.query('DELETE FROM plugins WHERE id = $1', [id]);
      Logger.info(`[plugins-api] 插件 ${id} 记录已卸载（管理员 ${req.session.user?.username}）`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- 通用 ----------
  publicRouter.get('/runtime', requireAuth, (req, res) => {
    res.json(registry().getRuntimeManifest());
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
