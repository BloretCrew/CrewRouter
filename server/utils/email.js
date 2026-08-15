const nodemailer = require('nodemailer');
const config = require('../config-loader');
const Logger = require('../logger');

let transporter = null;

function createTransporter() {
  const emailConfig = config.email;
  if (!emailConfig || !emailConfig.SMTP) {
    throw new Error('配置文件中缺少邮箱 SMTP 配置');
  }

  // 飞书邮箱配置：
  // 端口 465: 隐式 SSL (secure: true)
  // 端口 587: STARTTLS (secure: false, requireTLS: true)
  // 其他端口(如38025): 明文连接 (secure: false, ignoreTLS: true)
  const port = emailConfig.SMTP.port;
  const useSSL = emailConfig.SMTP.SSL === true;

  const transportConfig = {
    host: emailConfig.SMTP.host,
    port: port,
    secure: false, // 默认不使用隐式 SSL
    auth: {
      user: emailConfig.address,
      pass: emailConfig.password
    },
    tls: {
      rejectUnauthorized: false
    }
  };

  // 根据端口和配置决定连接方式
  if (port === 465 && useSSL) {
    // 端口 465: 隐式 SSL
    transportConfig.secure = true;
  } else if (port === 587) {
    // 端口 587: STARTTLS
    transportConfig.requireTLS = true;
  } else {
    // 其他端口: 明文连接，忽略 TLS
    transportConfig.ignoreTLS = true;
  }

  Logger.info(`[邮件] 创建 SMTP 连接: ${emailConfig.SMTP.host}:${port} (SSL: ${transportConfig.secure}, STARTTLS: ${transportConfig.requireTLS || false}, IgnoreTLS: ${transportConfig.ignoreTLS || false})`);
  
  return nodemailer.createTransport(transportConfig);
}

function getTransporter() {
  if (transporter) return transporter;
  transporter = createTransporter();
  return transporter;
}

// 重置 transporter（配置变更后调用）
function resetTransporter() {
  if (transporter) {
    transporter.close();
    transporter = null;
  }
}

async function SendEmail(options) {
  try {
    if (!options || !options.to || !options.subject) {
      throw new Error('缺少必要的邮件参数: to, subject');
    }

    const emailConfig = config.email;
    if (!emailConfig) {
      throw new Error('配置文件中缺少邮箱配置');
    }

    const transport = getTransporter();
    await transport.verify();

    const mailOptions = {
      from: options.from || emailConfig.address,
      to: options.to,
      bcc: options.bcc,
      subject: options.subject,
      text: options.text,
      html: options.html
    };

    Logger.info(`[邮件] 正在发送邮件到: ${options.to}`);
    const result = await transport.sendMail(mailOptions);

    Logger.success(`[邮件] 发送成功: ${result.messageId}`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    Logger.error('[邮件] 发送失败:', error);
    return { success: false, error: error.message };
  }
}

async function sendSimpleEmail(to, subject, text, html) {
  return await SendEmail({ to, subject, text, html });
}

function getBaseUrl() {
  const host = config.app?.host || 'localhost';
  const port = config.app?.port || 20002;
  if (host === 'localhost' || host === '127.0.0.1') {
    return `http://localhost:${port}`;
  }
  return `https://${host}`;
}

function generateVerifyEmailHtml(token, username) {
  const baseUrl = getBaseUrl();
  const verifyUrl = `${baseUrl}/auth/verify-email?token=${token}`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; margin: 0; padding: 40px 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #1456f0, #6366f1); padding: 40px 32px; text-align: center; }
    .header h1 { color: white; margin: 0; font-size: 24px; font-weight: 600; }
    .header p { color: rgba(255,255,255,0.8); margin: 8px 0 0; font-size: 14px; }
    .content { padding: 40px 32px; }
    .content h2 { color: #1f2937; font-size: 20px; margin: 0 0 16px; }
    .content p { color: #4b5563; font-size: 15px; line-height: 1.6; margin: 0 0 24px; }
    .btn { display: inline-block; background: #1456f0; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px; }
    .btn:hover { background: #124ce0; }
    .info { background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 24px 0; }
    .info p { margin: 4px 0; font-size: 13px; color: #6b7280; }
    .footer { padding: 24px 32px; border-top: 1px solid #e5e7eb; text-align: center; }
    .footer p { margin: 0; font-size: 12px; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Crant AI Studio</h1>
      <p>AI Platform</p>
    </div>
    <div class="content">
      <h2>欢迎注册，${username || '用户'}！</h2>
      <p>感谢您注册 Crant AI Studio 账号。请点击下方按钮完成邮箱验证：</p>
      <a href="${verifyUrl}" class="btn">验证邮箱</a>
      <div class="info">
        <p>如果按钮无法点击，请复制以下链接到浏览器打开：</p>
        <p style="word-break: break-all; color: #1456f0;">${verifyUrl}</p>
        <p>验证链接有效期：24 小时</p>
      </div>
    </div>
    <div class="footer">
      <p>此邮件由系统自动发送，请勿直接回复。</p>
    </div>
  </div>
</body>
</html>`;
}

function generateAlertEmailHtml(username, alertType, message, details) {
  const alertTitles = {
    balance_low: '余额不足预警',
    daily_usage_high: '日用量超标预警',
    abnormal_login: '异常登录预警'
  };

  const title = alertTitles[alertType] || '系统预警';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; margin: 0; padding: 40px 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #ef4444, #f97316); padding: 32px; text-align: center; }
    .header h1 { color: white; margin: 0; font-size: 20px; font-weight: 600; }
    .content { padding: 32px; }
    .content h2 { color: #1f2937; font-size: 18px; margin: 0 0 16px; }
    .content p { color: #4b5563; font-size: 14px; line-height: 1.6; margin: 0 0 16px; }
    .alert-box { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 16px 0; }
    .alert-box p { margin: 4px 0; color: #991b1b; font-size: 13px; }
    .footer { padding: 24px 32px; border-top: 1px solid #e5e7eb; text-align: center; }
    .footer p { margin: 0; font-size: 12px; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${title}</h1>
    </div>
    <div class="content">
      <p>尊敬的 ${username}，您好：</p>
      <div class="alert-box">
        <p><strong>${message}</strong></p>
        ${details ? `<p>${details}</p>` : ''}
      </div>
      <p>请及时处理，以免影响正常使用。</p>
    </div>
    <div class="footer">
      <p>此邮件由系统自动发送，请勿直接回复。</p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  SendEmail,
  sendSimpleEmail,
  getBaseUrl,
  generateVerifyEmailHtml,
  generateAlertEmailHtml,
  resetTransporter
};
