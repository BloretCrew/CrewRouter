const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const Logger = require('../logger');
const {
  NOTIFICATION_TYPES,
  getNotificationSettings,
  updateNotificationSettings,
  sendBark,
  listNotifications,
  markNotificationRead,
  deleteNotification,
  clearNotifications,
} = require('../utils/notifications');

router.get('/notification-settings', requireAuth, async (req, res) => {
  try {
    res.json(await getNotificationSettings(req.session.user.id));
  } catch (error) {
    Logger.error('[通知设置] 获取失败:', error);
    res.status(500).json({ error: '获取通知设置失败' });
  }
});

router.put('/notification-settings', requireAuth, async (req, res) => {
  try {
    await updateNotificationSettings(req.session.user.id, req.body || {});
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message || '保存通知设置失败' });
  }
});

router.post('/notification-settings/test', requireAuth, async (req, res) => {
  try {
    const result = await sendBark(req.session.user.id, 'CrewRouter Bark 测试通知', 'Bark 通知配置已生效。');
    if (result.success) return res.json({ success: true });
    if (result.skipped) return res.status(400).json({ error: '请先启用 Bark 通知并填写 Server Key' });
    res.status(502).json({ error: result.error || 'Bark 发送失败' });
  } catch (error) {
    res.status(500).json({ error: '发送测试通知失败' });
  }
});

router.get('/notifications', requireAuth, async (req, res) => {
  try { res.json(await listNotifications(req.session.user.id, req.query.limit)); }
  catch (error) { res.status(500).json({ error: '获取通知失败' }); }
});

router.put('/notifications/:id/read', requireAuth, async (req, res) => {
  try { res.json({ success: await markNotificationRead(req.session.user.id, req.params.id) }); }
  catch (error) { res.status(500).json({ error: '更新通知失败' }); }
});

router.delete('/notifications/:id', requireAuth, async (req, res) => {
  try { res.json({ success: await deleteNotification(req.session.user.id, req.params.id) }); }
  catch (error) { res.status(500).json({ error: '删除通知失败' }); }
});

router.delete('/notifications', requireAuth, async (req, res) => {
  try { await clearNotifications(req.session.user.id); res.json({ success: true }); }
  catch (error) { res.status(500).json({ error: '清空通知失败' }); }
});

module.exports = router;
