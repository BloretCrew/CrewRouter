/**
 * 用户端：弹窗通知
 *
 * GET  /api/user/popup-notices        当前用户未读且已启用的弹窗
 * POST /api/user/popup-notices/seen   批量标记已读（幂等）
 *
 * 每用户隔离：全部查询强制 user_id = session 用户。
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const Logger = require('../logger');
const {
  listUnseenForUser,
  markSeenForUser,
  normalizeIds,
} = require('../utils/popup-notices');

router.get('/popup-notices', requireAuth, async (req, res) => {
  try {
    res.json(await listUnseenForUser(req.session.user.id));
  } catch (error) {
    Logger.error('[弹窗通知] 获取未读失败:', error);
    res.status(500).json({ error: '获取弹窗通知失败' });
  }
});

router.post('/popup-notices/seen', requireAuth, async (req, res) => {
  let ids;
  try {
    ids = normalizeIds(req.body?.ids);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const marked = await markSeenForUser(req.session.user.id, ids);
    res.json({ success: true, marked });
  } catch (error) {
    Logger.error('[弹窗通知] 标记已读失败:', error);
    res.status(500).json({ error: '标记弹窗通知已读失败' });
  }
});

module.exports = router;
