/**
 * 管理端自动更新 API
 *
 * GET  /check  — 检查官方是否有新版本
 * GET  /status — 当前更新任务状态
 * POST /apply  — 一键下载安装并重启
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Logger = require('../logger');
const updater = require('../utils/updater');

// 检查更新
router.get('/check', requireAuth, requireAdmin, async (req, res) => {
  try {
    Logger.info(
      `[update/api] 管理员检查更新: user=${req.session.user?.username || req.session.user?.id}`
    );
    const result = await updater.checkForUpdate();
    res.json(result);
  } catch (err) {
    Logger.error('[update/api] check 失败:', err.message);
    const status = err.statusCode || 500;
    res.status(status).json({
      error: err.message || '检查更新失败',
      status: updater.getStatus(),
    });
  }
});

// 当前状态（不触发网络检查）
router.get('/status', requireAuth, requireAdmin, (req, res) => {
  res.json(updater.getStatus());
});

// 运行环境信息（不请求官方）
router.get('/runtime', requireAuth, requireAdmin, (req, res) => {
  const runtime = updater.getRuntimeInfo();
  res.json({
    ...runtime,
    status: updater.getStatus(),
    versionUrl: updater.UPDATE_VERSION_URL,
    packageUrl: updater.UPDATE_PACKAGE_URL,
  });
});

// 一键更新
router.post('/apply', requireAuth, requireAdmin, async (req, res) => {
  try {
    Logger.info(
      `[update/api] 管理员触发一键更新: user=${req.session.user?.username || req.session.user?.id}`
    );
    const result = await updater.applyUpdate();
    res.json(result);
  } catch (err) {
    Logger.error('[update/api] apply 失败:', err.message);
    const status = err.statusCode || 500;
    res.status(status).json({
      error: err.message || '应用更新失败',
      status: updater.getStatus(),
    });
  }
});

module.exports = router;
