/**
 * 插件商店路由 —— 挂载于 /store
 *
 *  OAuth（/store/auth）：login / callback / logout（Bloret PassPort）
 *  API（/store/api）：me / plugins CRUD / ratings / review / install-click / install-link
 *
 * 商店身份独立：登录态存于独立签名 cookie `bl_store_session`，不写 req.session，
 * 不影响 CrewRouter 核心权限体系。未配置 PassPort 时优雅降级（可浏览，写操作提示未配置）。
 */

const express = require('express');
const config = require('../config-loader');
const Logger = require('../logger');
const passportLib = require('../store/passport');
const sessionLib = require('../store/session');
const store = require('../store/store');

function createStoreRoutes() {
  const router = express.Router();

  const getPassportCfg = () => passportLib.getPassportConfig(config);
  const isSecureReq = (req) => req.secure || req.get('x-forwarded-proto') === 'https';

  const storeStore = () => store;

  // 附加商店登录态到 req.storeUser（与 Core 的 req.session.user 无关）
  router.use((req, res, next) => {
    try {
      const cfg = getPassportCfg();
      req.storeUser = sessionLib.readSessionFromReq(req, cfg.sessionSecret);
      req.storePassportCfg = cfg;
    } catch (e) {
      Logger.warn('[store-routes] 读取商店会话失败', e.message);
      req.storeUser = null;
      req.storePassportCfg = getPassportCfg();
    }
    next();
  });

  function requireLogin(req, res, next) {
    if (!req.storePassportCfg.isConfigured) {
      return res.status(503).json({ success: false, error: 'PassPort 尚未配置，无法登录或提交', code: 'PASSPORT_NOT_CONFIGURED' });
    }
    if (!req.storeUser) {
      return res.status(401).json({ success: false, error: '请先登录', code: 'NOT_LOGIN' });
    }
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.storePassportCfg.isConfigured) {
      return res.status(503).json({ success: false, error: 'PassPort 尚未配置', code: 'PASSPORT_NOT_CONFIGURED' });
    }
    if (!req.storeUser) {
      return res.status(401).json({ success: false, error: '请先登录', code: 'NOT_LOGIN' });
    }
    if (!req.storeUser.admin) {
      return res.status(403).json({ success: false, error: '需要管理员权限', code: 'NOT_ADMIN' });
    }
    next();
  }

  function sendError(res, e, fallbackStatus = 500) {
    const map = { NOT_FOUND: 404, FORBIDDEN: 403, VALIDATION: 400, DUPLICATE: 400, 'PASSPORT_NOT_CONFIGURED': 503 };
    const status = map[e.code] || (e.status || fallbackStatus);
    const payload = { success: false, error: e.message };
    if (e.code) payload.code = e.code;
    res.status(status).json(payload);
  }

  // ---------- OAuth ----------

  router.get('/auth/login', (req, res) => {
    try {
      const cfg = getPassportCfg();
      const missing = [];
      if (!cfg.appId) missing.push('appId');
      if (!cfg.appSecret) missing.push('appSecret');
      if (!cfg.sessionSecret) missing.push('sessionSecret');
      if (missing.length || !cfg.isConfigured) {
        Logger.error('[store-routes] 登录被阻断：缺少', missing.join(', '));
        return res.redirect('/store?auth=unconfigured');
      }
      const redirectUri = passportLib.resolveRedirectUri(cfg, req);
      const returnTo = (req.query.return_to && String(req.query.return_to)) || '/store';
      // state = base64url(JSON) —— 仅接受相对路径，防开放重定向
      const safeReturnTo = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/store';
      const state = Buffer.from(JSON.stringify({ return_to: safeReturnTo }), 'utf8').toString('base64url');
      const url = passportLib.buildAuthorizeUrl(cfg, redirectUri, state);
      Logger.info('[store-routes] 跳转 OAuth，return_to=', safeReturnTo);
      res.redirect(url);
    } catch (e) {
      Logger.error('[store-routes] 登录初始化失败', e);
      res.redirect('/store?auth=error');
    }
  });

  router.get('/auth/callback', async (req, res) => {
    try {
      const cfg = getPassportCfg();
      const code = req.query.code;
      if (!code) {
        Logger.warn('[store-routes] callback 无 code（用户拒绝？）');
        return res.redirect('/store?auth=denied');
      }

      let returnTo = '/store';
      if (req.query.state) {
        try {
          const st = JSON.parse(Buffer.from(String(req.query.state), 'base64url').toString('utf8'));
          if (st.return_to && String(st.return_to).startsWith('/') && !String(st.return_to).startsWith('//')) {
            returnTo = String(st.return_to);
          }
        } catch (e) {
          Logger.warn('[store-routes] state 解析失败', e.message);
        }
      }

      const profile = await passportLib.verifyCode(cfg, String(code));
      const username = profile.username;
      if (!username) {
        Logger.error('[store-routes] verify 缺少 username', profile);
        return res.redirect('/store?auth=error');
      }
      const admin = passportLib.isAdminUser(username, profile.admin, cfg);
      sessionLib.setSessionCookie(res, {
        username,
        nickname: profile.nickname || username,
        avatar: profile.avatar || '',
        admin,
      }, cfg.sessionSecret, isSecureReq(req));
      Logger.info('[store-routes] 登录成功', username, 'admin=', admin, '->', returnTo);
      res.redirect(returnTo.includes('?') ? `${returnTo}&auth=ok` : `${returnTo}?auth=ok`);
    } catch (e) {
      Logger.error('[store-routes] callback 失败', e.message, e.code || '');
      res.redirect('/store?auth=error');
    }
  });

  const logout = (req, res) => {
    const cfg = getPassportCfg();
    sessionLib.clearSessionCookie(res, isSecureReq(req));
    if (req.path === '/auth/logout' && req.method === 'GET') {
      return res.redirect('/store?auth=logout');
    }
    res.json({ success: true });
  };
  router.get('/auth/logout', logout);
  router.post('/auth/logout', logout);

  // ---------- API：me ----------

  router.get('/api/me', (req, res) => {
    const cfg = getPassportCfg();
    if (!req.storeUser) {
      return res.json({ success: true, loggedIn: false, user: null, config: { configured: cfg.isConfigured } });
    }
    res.json({
      success: true,
      loggedIn: true,
      user: {
        username: req.storeUser.username,
        nickname: req.storeUser.nickname || req.storeUser.username,
        avatar: req.storeUser.avatar,
        admin: !!req.storeUser.admin,
      },
      config: { configured: cfg.isConfigured },
    });
  });

  // ---------- API：可安装的目标实例 ----------

  // 按访问者终端 IP 查询其登录过的 CrewRouter 实例（弱关联：IP + 设备码 + 域名）
  router.get('/api/install-targets', requireLogin, async (req, res) => {
    try {
      const clientIp = req.ip || (req.connection && req.connection.remoteAddress) || '';
      const targets = await storeStore().listInstallTargets(clientIp);
      res.json({ success: true, targets });
    } catch (e) {
      Logger.error('[store-api] install-targets 失败', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ---------- API：plugins ----------

  router.get('/api/plugins', async (req, res) => {
    try {
      const scope = req.query.scope; // public | mine | admin
      const opts = {
        username: req.storeUser ? req.storeUser.username : null,
        admin: req.storeUser ? !!req.storeUser.admin : false,
        q: req.query.q ? String(req.query.q) : undefined,
        tag: req.query.tag ? String(req.query.tag) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        scope: scope === 'mine' || scope === 'admin' ? scope : undefined,
        sort: ['rating', 'installs', 'updated'].includes(String(req.query.sort || '')) ? String(req.query.sort) : undefined,
      };

      if (scope === 'mine' && !req.storeUser) return res.status(401).json({ success: false, error: '请先登录' });
      if (scope === 'admin' && (!req.storeUser || !req.storeUser.admin)) return res.status(403).json({ success: false, error: '需要管理员权限' });

      let result = await storeStore().listPlugins(opts);
      if (!scope) {
        result = result.filter((p) => {
          if (p.status === 'approved') return true;
          if (req.storeUser && (req.storeUser.admin || req.storeUser.username === p.authorUsername)) return true;
          return false;
        });
        if (req.query.public === '1') result = result.filter((p) => p.status === 'approved');
      }
      res.json({ success: true, plugins: result });
    } catch (e) {
      Logger.error('[store-api] 列表失败', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.get('/api/plugins/:id/manifest.json', async (req, res) => {
    try {
      const plugin = await storeStore().getPlugin(req.params.id);
      if (!plugin || plugin.status !== 'approved') return res.status(404).json({ error: '插件不存在或未上架' });
      const manifest = storeStore().toLauncherManifest(plugin);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.json(manifest);
    } catch (e) {
      Logger.error('[store-api] manifest 失败', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // 公开插件包信息（实例/商店详情/确认框用）：仅上架插件，CORS 允许跨域拉取，无需登录
  router.get('/api/plugins/:id/package-info', async (req, res) => {
    try {
      const info = await storeStore().getPluginPackageInfo(req.params.id);
      if (!info) return res.status(404).json({ success: false, error: '插件不存在或未上架' });
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.json({ success: true, plugin: info });
    } catch (e) {
      Logger.error('[store-api] package-info 失败', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.get('/api/plugins/:id', async (req, res) => {
    try {
      const plugin = await storeStore().getPlugin(req.params.id);
      if (!plugin || !storeStore().canViewPlugin(plugin, req.storeUser)) {
        return res.status(404).json({ success: false, error: '插件不存在' });
      }
      const includePending = storeStore().canSeePending(plugin, req.storeUser);
      const view = storeStore().publicView(plugin, { includePending });
      if (req.storeUser && req.storeUser.username) {
        view.myRating = await storeStore().getUserRating(plugin.id, req.storeUser.username);
      }
      const include = String(req.query.include || '');
      if (include.includes('related') || req.query.related === '1') {
        view.related = await storeStore().listRelated(plugin, { limit: 6 });
      }
      res.json({ success: true, plugin: view });
    } catch (e) {
      Logger.error('[store-api] 详情失败', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.post('/api/plugins', requireLogin, async (req, res) => {
    try {
      const created = await storeStore().createPlugin(req.body || {}, req.storeUser.username);
      res.status(201).json({ success: true, plugin: created });
    } catch (e) {
      Logger.error('[store-api] 提交失败', e.message, e.code);
      sendError(res, e, 500);
    }
  });

  router.patch('/api/plugins/:id', requireLogin, async (req, res) => {
    try {
      const updated = await storeStore().updatePlugin(req.params.id, req.body || {}, req.storeUser);
      res.json({ success: true, plugin: updated });
    } catch (e) {
      Logger.error('[store-api] 更新失败', e.message, e.code);
      sendError(res, e, 500);
    }
  });

  router.post('/api/plugins/:id/review', requireAdmin, async (req, res) => {
    try {
      const action = req.body && req.body.action;
      const reason = req.body && req.body.reason;
      const updated = await storeStore().reviewPlugin(req.params.id, action, reason, req.storeUser.username);
      res.json({ success: true, plugin: updated });
    } catch (e) {
      Logger.error('[store-api] 审核失败', e.message, e.code);
      sendError(res, e, 500);
    }
  });

  router.post('/api/plugins/:id/install-click', async (req, res) => {
    try {
      const result = await storeStore().incrementInstall(req.params.id);
      res.json({ success: true, ...result });
    } catch (e) {
      sendError(res, e, 500);
    }
  });

  router.get('/api/plugins/:id/install-link', async (req, res) => {
    try {
      const plugin = await storeStore().getPlugin(req.params.id);
      if (!plugin || plugin.status !== 'approved') return res.status(404).json({ success: false, error: '插件不存在或未上架' });
      if (!plugin.download || !String(plugin.download).startsWith('https://')) {
        return res.status(400).json({ success: false, error: 'download 必须是 https:// ZIP 直链' });
      }
      const install_url = storeStore().buildBloretInstallUrl(plugin);
      const propose = storeStore().toStoreProposePayload(plugin);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.json({ success: true, install_url, download: plugin.download, sha256: plugin.sha256 || '', propose });
    } catch (e) {
      Logger.error('[store-api] install-link 失败', e.message);
      sendError(res, e, 500);
    }
  });

  // ---------- API：ratings ----------

  router.get('/api/plugins/:id/ratings', async (req, res) => {
    try {
      const plugin = await storeStore().getPlugin(req.params.id);
      if (!plugin || !storeStore().canViewPlugin(plugin, req.storeUser)) return res.status(404).json({ success: false, error: '插件不存在' });
      const data = await storeStore().listRatings(plugin.id, { limit: req.query.limit, offset: req.query.offset });
      let myRating = null;
      if (req.storeUser && req.storeUser.username) myRating = await storeStore().getUserRating(plugin.id, req.storeUser.username);
      res.json({ success: true, ...data, myRating });
    } catch (e) {
      Logger.error('[store-api] 评分列表失败', e.message);
      sendError(res, e, 500);
    }
  });

  router.put('/api/plugins/:id/ratings', requireLogin, async (req, res) => {
    try {
      const result = await storeStore().upsertRating(req.params.id, req.storeUser.username, req.body || {});
      res.json({ success: true, ...result });
    } catch (e) {
      Logger.error('[store-api] 评分失败', e.message, e.code);
      sendError(res, e, 500);
    }
  });

  router.delete('/api/plugins/:id/ratings', requireLogin, async (req, res) => {
    try {
      const result = await storeStore().deleteRating(req.params.id, req.storeUser.username);
      res.json({ success: true, ...result });
    } catch (e) {
      Logger.error('[store-api] 删除评分失败', e.message, e.code);
      sendError(res, e, 500);
    }
  });

  router.post('/api/plugins/:id/ratings/:ratingUser/replies', requireLogin, async (req, res) => {
    try {
      const body = (req.body && (req.body.body != null ? req.body.body : req.body.comment)) || '';
      const reply = await storeStore().createRatingReply(req.params.id, decodeURIComponent(req.params.ratingUser), req.storeUser.username, body);
      res.json({ success: true, reply });
    } catch (e) {
      Logger.error('[store-api] 回复失败', e.message, e.code);
      sendError(res, e, 500);
    }
  });

  router.delete('/api/plugins/:id/ratings/replies/:replyId', requireLogin, async (req, res) => {
    try {
      const result = await storeStore().deleteRatingReply(req.params.id, req.params.replyId, req.storeUser);
      res.json({ success: true, ...result });
    } catch (e) {
      Logger.error('[store-api] 删除回复失败', e.message, e.code);
      sendError(res, e, 500);
    }
  });

  return router;
}

module.exports = { createStoreRoutes };
