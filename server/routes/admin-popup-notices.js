/**
 * 管理后台：弹窗通知 CRUD
 *
 * GET    /api/admin/popup-notices             列表（含已读人数）
 * POST   /api/admin/popup-notices             新建
 * PUT    /api/admin/popup-notices/:id         更新
 * PUT    /api/admin/popup-notices/:id/enabled 启停
 * POST   /api/admin/popup-notices/:id/reset   重置已读（改文案后重新触达）
 * DELETE /api/admin/popup-notices/:id         删除
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const Logger = require('../logger');
const { ACTIONS, auditMiddleware } = require('../utils/audit-log');
const {
  listForAdmin,
  createNotice,
  updateNotice,
  setNoticeEnabled,
  deleteNotice,
  resetSeen,
} = require('../utils/popup-notices');

function parseId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function auditDescription(req) {
  const title = String(req.body?.title || '').trim();
  return title ? `弹窗通知「${title.slice(0, 60)}」` : '弹窗通知';
}

const audit = auditMiddleware(ACTIONS.ADMIN_POPUP_NOTICE, {
  resourceType: 'popup_notice',
  descriptionFrom: auditDescription,
});

function sendError(res, error, fallbackMessage) {
  if (error?.statusCode === 400) return res.status(400).json({ error: error.message });
  Logger.error(`[弹窗通知] ${fallbackMessage}:`, error);
  return res.status(500).json({ error: fallbackMessage });
}

router.get('/popup-notices', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json({ items: await listForAdmin() });
  } catch (error) {
    sendError(res, error, '获取弹窗通知列表失败');
  }
});

router.post('/popup-notices', requireAuth, requireAdmin, audit, async (req, res) => {
  try {
    const item = await createNotice(req.body || {});
    res.json({ success: true, item });
  } catch (error) {
    sendError(res, error, '创建弹窗通知失败');
  }
});

router.put('/popup-notices/:id/enabled', requireAuth, requireAdmin, audit, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: '弹窗通知 ID 无效' });
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled 必须为布尔值' });
  }
  try {
    const item = await setNoticeEnabled(id, req.body.enabled);
    if (!item) return res.status(404).json({ error: '弹窗通知不存在' });
    res.json({ success: true, item });
  } catch (error) {
    sendError(res, error, '更新弹窗通知失败');
  }
});

router.post('/popup-notices/:id/reset', requireAuth, requireAdmin, audit, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: '弹窗通知 ID 无效' });
  try {
    const cleared = await resetSeen(id);
    res.json({ success: true, cleared });
  } catch (error) {
    sendError(res, error, '重置弹窗通知已读失败');
  }
});

router.put('/popup-notices/:id', requireAuth, requireAdmin, audit, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: '弹窗通知 ID 无效' });
  try {
    const item = await updateNotice(id, req.body || {});
    if (!item) return res.status(404).json({ error: '弹窗通知不存在' });
    res.json({ success: true, item });
  } catch (error) {
    sendError(res, error, '更新弹窗通知失败');
  }
});

router.delete('/popup-notices/:id', requireAuth, requireAdmin, audit, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: '弹窗通知 ID 无效' });
  try {
    const deleted = await deleteNotice(id);
    if (!deleted) return res.status(404).json({ error: '弹窗通知不存在' });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error, '删除弹窗通知失败');
  }
});

module.exports = router;
