const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  getUserAlertSettings,
  updateUserAlertSettings,
  getAlertHistory,
  sendAlertEmail,
  ALERT_TYPES
} = require('../utils/balance-alert');
const Logger = require('../logger');

// 获取预警设置
router.get('/alert-settings', requireAuth, async (req, res) => {
  try {
    const settings = await getUserAlertSettings(req.session.user.id);
    res.json(settings);
  } catch (error) {
    Logger.error('[预警设置] 获取失败:', error);
    res.status(500).json({ error: '获取设置失败' });
  }
});

// 更新预警设置
router.put('/alert-settings', requireAuth, async (req, res) => {
  try {
    const { alertEnabled, balanceThreshold, dailyUsageThreshold } = req.body;

    if (balanceThreshold !== undefined && (typeof balanceThreshold !== 'number' || balanceThreshold < 0)) {
      return res.status(400).json({ error: '余额预警阈值必须是非负数' });
    }

    if (dailyUsageThreshold !== undefined && (typeof dailyUsageThreshold !== 'number' || dailyUsageThreshold < 0)) {
      return res.status(400).json({ error: '日用量预警阈值必须是非负数' });
    }

    const success = await updateUserAlertSettings(req.session.user.id, {
      alertEnabled,
      balanceThreshold,
      dailyUsageThreshold
    });

    if (success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: '更新设置失败' });
    }
  } catch (error) {
    Logger.error('[预警设置] 更新失败:', error);
    res.status(500).json({ error: '更新设置失败' });
  }
});

// 获取预警历史
router.get('/alert-history', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const history = await getAlertHistory(req.session.user.id, limit);
    res.json(history);
  } catch (error) {
    Logger.error('[预警历史] 获取失败:', error);
    res.status(500).json({ error: '获取历史记录失败' });
  }
});

// 发送测试预警邮件
router.post('/alert-settings/test', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;
    const { type = 'balance_low' } = req.body;

    let details = '';
    let alertType = ALERT_TYPES.BALANCE_LOW;

    switch (type) {
      case 'balance_low':
        alertType = ALERT_TYPES.BALANCE_LOW;
        details = '预警阈值：¥5.00，当前余额：¥3.50';
        break;
      case 'daily_usage_high':
        alertType = ALERT_TYPES.DAILY_USAGE_HIGH;
        details = '预警阈值：¥50.00，今日消费：¥65.30';
        break;
      case 'abnormal_login':
        alertType = ALERT_TYPES.ABNORMAL_LOGIN;
        details = '登录IP：192.168.1.100，设备信息：Chrome/120.0.0.0';
        break;
      default:
        return res.status(400).json({ error: '无效的预警类型' });
    }

    const result = await sendAlertEmail(
      {
        id: user.id,
        username: user.username,
        email: user.email
      },
      alertType,
      details
    );

    if (result.success) {
      res.json({ success: true, message: '测试邮件已发送' });
    } else {
      res.status(500).json({ error: result.error || '发送失败' });
    }
  } catch (error) {
    Logger.error('[测试邮件] 发送失败:', error);
    res.status(500).json({ error: '发送测试邮件失败' });
  }
});

module.exports = router;
