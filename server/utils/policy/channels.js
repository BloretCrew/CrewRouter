'use strict';

const axios = require('axios');
const { validateUrl } = require('../url-validator');
const { encryptSecret, decryptSecret } = require('../secret-crypto');
const { SendEmail } = require('../email');
const Logger = require('../../logger');

const MASK = '********';
const TYPES = new Set(['webhook', 'feishu', 'wecom', 'dingtalk', 'slack', 'telegram', 'email', 'bark']);

function publicChannel(row) {
  if (!row) return row;
  const config = { ...(row.config || {}) };
  for (const key of ['secret', 'token', 'key']) {
    if (config[key]) config[key] = MASK;
  }
  return { ...row, config };
}

async function safeUrl(url) {
  const result = await validateUrl(url);
  if (!result.ok) throw new Error(result.error || 'URL 校验失败');
  return result.url || url;
}

async function postJson(url, body, headers = {}) {
  const target = await safeUrl(url);
  const response = await axios.post(target, body, {
    timeout: 10000,
    maxRedirects: 0,
    proxy: false,
    headers: { 'Content-Type': 'application/json', ...headers },
    validateStatus: status => status >= 200 && status < 300,
  });
  return response.data;
}

async function dispatchChannel(channel, message) {
  const config = { ...(channel.config || {}) };
  if (config.secret) {
    try { config.secret = decryptSecret(config.secret); } catch (_) { /* keep */ }
  }
  if (config.token) {
    try { config.token = decryptSecret(config.token); } catch (_) { /* keep */ }
  }
  if (config.key) {
    try { config.key = decryptSecret(config.key); } catch (_) { /* keep */ }
  }
  const text = String(message.text || '');
  const title = String(message.title || 'CrewRouter 策略告警');
  switch (channel.type) {
    case 'webhook':
      return postJson(config.url, {
        event: message.event || 'policy',
        title, text,
        severity: message.severity || 'warning',
        policy: message.policy || null,
        user: message.user || null,
        at: new Date().toISOString(),
      }, config.secret ? { 'X-Webhook-Secret': config.secret } : {});
    case 'feishu':
      return postJson(config.url, { msg_type: 'text', content: { text: `${title}\n${text}` } });
    case 'wecom':
      return postJson(config.url, { msgtype: 'text', text: { content: `${title}\n${text}` } });
    case 'dingtalk':
      return postJson(config.url, { msgtype: 'text', text: { content: `${title}\n${text}` } });
    case 'slack':
      return postJson(config.url, { text: `${title}\n${text}` });
    case 'telegram': {
      if (!config.token || !config.chat_id) throw new Error('Telegram 需要 token 与 chat_id');
      return postJson(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        chat_id: config.chat_id,
        text: `${title}\n${text}`,
      });
    }
    case 'email': {
      if (!config.to) throw new Error('邮件渠道需要收件人');
      await SendEmail({ to: config.to, subject: title, text });
      return { ok: true };
    }
    case 'bark': {
      const endpoint = config.endpoint || 'https://api.day.app';
      if (!config.key) throw new Error('Bark 渠道需要 Server Key');
      return postJson(`${endpoint.replace(/\/$/, '')}/${encodeURIComponent(config.key)}`, { title, body: text, group: 'CrewRouter' });
    }
    default:
      throw new Error(`不支持的渠道类型: ${channel.type}`);
  }
}

async function createChannel(db, input, userId) {
  const type = String(input?.type || '');
  if (!TYPES.has(type)) throw Object.assign(new Error('不支持的渠道类型'), { status: 400 });
  const name = String(input?.name || '').trim();
  if (!name) throw Object.assign(new Error('渠道名称不能为空'), { status: 400 });
  const config = input.config && typeof input.config === 'object' ? { ...input.config } : {};
  for (const field of ['secret', 'token', 'key']) {
    if (config[field] && config[field] !== MASK) config[field] = encryptSecret(String(config[field]));
  }
  const result = await db.query(
    `INSERT INTO policy_channels (type, name, config, enabled, min_severity, created_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING *`,
    [type, name, JSON.stringify(config), input.enabled !== false, input.min_severity || 'warning', userId || null]
  );
  return publicChannel(result.rows[0]);
}

async function updateChannel(db, id, input) {
  const current = await db.query('SELECT * FROM policy_channels WHERE id = $1', [id]);
  if (!current.rows.length) throw Object.assign(new Error('渠道不存在'), { status: 404 });
  const existing = current.rows[0];
  const config = input.config && typeof input.config === 'object' ? { ...input.config } : { ...(existing.config || {}) };
  for (const field of ['secret', 'token', 'key']) {
    if (config[field] === MASK) config[field] = existing.config?.[field] || '';
    else if (config[field]) config[field] = encryptSecret(String(config[field]));
  }
  const result = await db.query(
    `UPDATE policy_channels SET type = $2, name = $3, config = $4::jsonb, enabled = $5,
       min_severity = $6, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [
      id,
      input.type || existing.type,
      input.name != null ? String(input.name).trim() : existing.name,
      JSON.stringify(config),
      input.enabled != null ? input.enabled !== false : existing.enabled,
      input.min_severity || existing.min_severity,
    ]
  );
  return publicChannel(result.rows[0]);
}

async function listChannels(db) {
  const result = await db.query('SELECT * FROM policy_channels ORDER BY id DESC');
  return result.rows.map(publicChannel);
}

async function testChannel(db, id) {
  const result = await db.query('SELECT * FROM policy_channels WHERE id = $1', [id]);
  if (!result.rows.length) throw Object.assign(new Error('渠道不存在'), { status: 404 });
  const channel = result.rows[0];
  const started = Date.now();
  try {
    await dispatchChannel(channel, {
      event: 'test', title: 'CrewRouter 渠道测试',
      text: `这是一条来自 CrewRouter 策略平台的测试消息。渠道：${channel.name}`,
      severity: 'info',
    });
    return { ok: true, latency_ms: Date.now() - started };
  } catch (error) {
    Logger.warn(`[策略] 渠道测试失败 ${channel.id}: ${error.message}`);
    return { ok: false, error: error.message, latency_ms: Date.now() - started };
  }
}

module.exports = {
  TYPES,
  MASK,
  publicChannel,
  createChannel,
  updateChannel,
  listChannels,
  testChannel,
  dispatchChannel,
};
