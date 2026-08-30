const { pool } = require('../models/database');
const { SendEmail, generateAlertEmailHtml } = require('./email');
const Logger = require('../logger');
const { notifyUser, NOTIFICATION_TYPES } = require('./notifications');

const ALERT_TYPES = {
  BALANCE_LOW: 'balance_low',
  DAILY_USAGE_HIGH: 'daily_usage_high',
  ABNORMAL_LOGIN: 'abnormal_login'
};

const ALERT_MESSAGES = {
  [ALERT_TYPES.BALANCE_LOW]: {
    title: '余额不足预警',
    message: '您的账户余额已低于预警阈值',
    details: (threshold, current) => `预警阈值：¥${threshold}，当前余额：¥${current}`
  },
  [ALERT_TYPES.DAILY_USAGE_HIGH]: {
    title: '日用量超标预警',
    message: '您今日的消费已超过预警阈值',
    details: (threshold, current) => `预警阈值：¥${threshold}，今日消费：¥${current}`
  },
  [ALERT_TYPES.ABNORMAL_LOGIN]: {
    title: '异常登录预警',
    message: '检测到您的账户在新设备上登录',
    details: (ip, userAgent) => `登录IP：${ip}，设备信息：${userAgent}`
  }
};

async function hasAlertBeenSent(userId, alertType, withinHours = 24) {
  try {
    const result = await pool.query(
      `SELECT id FROM balance_alerts 
       WHERE user_id = $1 AND alert_type = $2 
       AND sent_at > NOW() - INTERVAL '${withinHours} hours' 
       LIMIT 1`,
      [userId, alertType]
    );
    return result.rows.length > 0;
  } catch (error) {
    Logger.error('[预警] 检查预警记录失败:', error);
    return false;
  }
}

async function recordAlert(userId, alertType, message, details = null) {
  try {
    await pool.query(
      'INSERT INTO balance_alerts (user_id, alert_type, message, details) VALUES ($1, $2, $3, $4)',
      [userId, alertType, message, details]
    );
  } catch (error) {
    Logger.error('[预警] 记录预警失败:', error);
  }
}

async function sendAlertEmail(user, alertType, additionalDetails = null) {
  const alertInfo = ALERT_MESSAGES[alertType];
  if (!alertInfo) return;

  let details = '';
  if (additionalDetails) {
    if (typeof additionalDetails === 'function') {
      details = additionalDetails();
    } else {
      details = additionalDetails;
    }
  }

  const emailHtml = generateAlertEmailHtml(
    user.username,
    alertType,
    alertInfo.message,
    details
  );

  const result = await SendEmail({
    to: user.email,
    subject: `Crant AI Studio - ${alertInfo.title}`,
    text: `${alertInfo.message}\n${details}`,
    html: emailHtml
  });

  if (result.success) {
    Logger.success(`[预警] 邮件已发送给用户 ${user.username}: ${alertType}`);
  } else {
    Logger.error(`[预警] 邮件发送失败: ${result.error}`);
  }

  return result;
}

async function checkBalanceAlert(userId, currentBalance) {
  try {
    const userResult = await pool.query(
      'SELECT id, username, email, alert_enabled, alert_balance_threshold FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) return false;

    const user = userResult.rows[0];

    if (!user.alert_enabled) return false;

    const threshold = parseFloat(user.alert_balance_threshold) || 5;
    const balance = parseFloat(currentBalance) || 0;

    if (balance >= threshold) return false;

    if (await hasAlertBeenSent(userId, ALERT_TYPES.BALANCE_LOW)) {
      return false;
    }

    const details = ALERT_MESSAGES[ALERT_TYPES.BALANCE_LOW].details(threshold, balance.toFixed(4));
    const emailResult = await sendAlertEmail(user, ALERT_TYPES.BALANCE_LOW, details);
    if (!emailResult?.success) return false;
    await recordAlert(userId, ALERT_TYPES.BALANCE_LOW, ALERT_MESSAGES[ALERT_TYPES.BALANCE_LOW].message, details);
    await notifyUser(userId, NOTIFICATION_TYPES.QUOTA_INSUFFICIENT, details, { alertType: ALERT_TYPES.BALANCE_LOW });

    return true;
  } catch (error) {
    Logger.error('[预警] 余额预警检查失败:', error);
    return false;
  }
}

async function checkDailyUsageAlert(userId, dailyUsage) {
  try {
    const userResult = await pool.query(
      'SELECT id, username, email, alert_enabled, alert_daily_usage_threshold FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) return false;

    const user = userResult.rows[0];

    if (!user.alert_enabled) return false;

    const threshold = parseFloat(user.alert_daily_usage_threshold) || 50;
    const usage = parseFloat(dailyUsage) || 0;

    if (usage < threshold) return false;

    if (await hasAlertBeenSent(userId, ALERT_TYPES.DAILY_USAGE_HIGH)) {
      return false;
    }

    const details = ALERT_MESSAGES[ALERT_TYPES.DAILY_USAGE_HIGH].details(threshold, usage.toFixed(4));
    const emailResult = await sendAlertEmail(user, ALERT_TYPES.DAILY_USAGE_HIGH, details);
    if (!emailResult?.success) return false;
    await recordAlert(userId, ALERT_TYPES.DAILY_USAGE_HIGH, ALERT_MESSAGES[ALERT_TYPES.DAILY_USAGE_HIGH].message, details);

    return true;
  } catch (error) {
    Logger.error('[预警] 日用量预警检查失败:', error);
    return false;
  }
}

async function checkAbnormalLogin(userId, ip, userAgent) {
  try {
    const userResult = await pool.query(
      'SELECT id, username, email, alert_enabled FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) return false;

    const user = userResult.rows[0];

    if (!user.alert_enabled) return false;

    const ipCheck = await pool.query(
      `SELECT id FROM user_sessions 
       WHERE sess::json->>'user' IS NOT NULL 
       AND sess::json->>'user' LIKE '%"id":${userId}%' 
       AND ip_address = $1`,
      [ip]
    );

    if (ipCheck.rows.length > 0) {
      return false;
    }

    if (await hasAlertBeenSent(userId, ALERT_TYPES.ABNORMAL_LOGIN, 1)) {
      return false;
    }

    const details = ALERT_MESSAGES[ALERT_TYPES.ABNORMAL_LOGIN].details(ip, userAgent);
    await sendAlertEmail(user, ALERT_TYPES.ABNORMAL_LOGIN, details);
    await recordAlert(userId, ALERT_TYPES.ABNORMAL_LOGIN, ALERT_MESSAGES[ALERT_TYPES.ABNORMAL_LOGIN].message, details);

    return true;
  } catch (error) {
    Logger.error('[预警] 异常登录检查失败:', error);
    return false;
  }
}

async function getAlertHistory(userId, limit = 20) {
  try {
    const result = await pool.query(
      'SELECT * FROM balance_alerts WHERE user_id = $1 ORDER BY sent_at DESC LIMIT $2',
      [userId, limit]
    );
    return result.rows;
  } catch (error) {
    Logger.error('[预警] 获取预警历史失败:', error);
    return [];
  }
}

async function getUserAlertSettings(userId) {
  try {
    const result = await pool.query(
      'SELECT alert_enabled, alert_balance_threshold, alert_daily_usage_threshold FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return {
        alertEnabled: false,
        balanceThreshold: 5,
        dailyUsageThreshold: 50
      };
    }

    const user = result.rows[0];
    return {
      alertEnabled: user.alert_enabled || false,
      balanceThreshold: parseFloat(user.alert_balance_threshold) || 5,
      dailyUsageThreshold: parseFloat(user.alert_daily_usage_threshold) || 50
    };
  } catch (error) {
    Logger.error('[预警] 获取预警设置失败:', error);
    return {
      alertEnabled: false,
      balanceThreshold: 5,
      dailyUsageThreshold: 50
    };
  }
}

async function updateUserAlertSettings(userId, settings) {
  try {
    const { alertEnabled, balanceThreshold, dailyUsageThreshold } = settings;

    await pool.query(
      `UPDATE users SET 
        alert_enabled = $2, 
        alert_balance_threshold = $3, 
        alert_daily_usage_threshold = $4,
        updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1`,
      [
        userId,
        alertEnabled !== undefined ? alertEnabled : false,
        balanceThreshold !== undefined ? balanceThreshold : 5,
        dailyUsageThreshold !== undefined ? dailyUsageThreshold : 50
      ]
    );

    return true;
  } catch (error) {
    Logger.error('[预警] 更新预警设置失败:', error);
    return false;
  }
}

module.exports = {
  ALERT_TYPES,
  checkBalanceAlert,
  checkDailyUsageAlert,
  checkAbnormalLogin,
  getAlertHistory,
  getUserAlertSettings,
  updateUserAlertSettings
};
