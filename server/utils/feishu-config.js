/**
 * 飞书登录配置：settings 表优先，回退到 config.json / 环境变量
 */
const { pool } = require('../models/database');
const config = require('../config-loader');
const Logger = require('../logger');

const SETTINGS_KEY = 'feishu_login';
const MASKED_SECRET = '********';

// 应用级 Access Token 缓存（凭证变更时需失效）
let appAccessToken = null;
let tokenExpireTime = 0;

function buildRedirectUri() {
  const host = config.app?.host === 'localhost'
    ? `http://localhost:${config.app?.port || 20003}`
    : `https://${config.app?.host}`;
  return `${host}/auth/feishu/callback`;
}

function configFileFallback() {
  const appId = config.feishu?.appId || '';
  const appSecret = config.feishu?.appSecret || '';
  const tenantKey = config.feishu?.tenantKey || '';
  return {
    enabled: !!appId,
    appId,
    appSecret,
    tenantKey,
    source: 'config',
  };
}

/**
 * 读取飞书登录配置
 * @returns {Promise<{enabled:boolean, appId:string, appSecret:string, tenantKey:string, source:string}>}
 */
async function getFeishuConfig() {
  try {
    const result = await pool.query(
      'SELECT value FROM settings WHERE key = $1',
      [SETTINGS_KEY]
    );
    if (result.rows.length > 0) {
      let raw = result.rows[0].value;
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw);
        } catch {
          // keep string
        }
      }
      if (raw && typeof raw === 'object') {
        return {
          enabled: raw.enabled === true,
          appId: raw.appId || '',
          appSecret: raw.appSecret || '',
          tenantKey: raw.tenantKey || '',
          source: 'settings',
        };
      }
    }
  } catch (err) {
    Logger.warn(`[飞书配置] 读取 settings 失败，回退 config: ${err.message}`);
  }
  return configFileFallback();
}

/**
 * 是否可对外提供飞书登录（启用且配置了 appId）
 */
async function isFeishuLoginAvailable() {
  const cfg = await getFeishuConfig();
  return !!(cfg.enabled && cfg.appId);
}

/**
 * 保存飞书登录配置到 settings
 * @param {{enabled?:boolean, appId?:string, appSecret?:string, tenantKey?:string}} input
 * @param {{keepExistingSecret?:boolean}} options
 */
async function saveFeishuConfig(input, options = {}) {
  const current = await getFeishuConfig();
  let appSecret = input.appSecret;
  if (
    options.keepExistingSecret ||
    !appSecret ||
    appSecret === MASKED_SECRET
  ) {
    appSecret = current.appSecret || '';
  }

  const next = {
    enabled: input.enabled === true,
    appId: (input.appId || '').trim(),
    appSecret: appSecret || '',
    tenantKey: (input.tenantKey || '').trim(),
  };

  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [SETTINGS_KEY, JSON.stringify(next)]
  );

  invalidateAppAccessToken();
  Logger.info(
    `[飞书配置] 已保存: enabled=${next.enabled}, appId=${next.appId ? next.appId.slice(0, 8) + '…' : '(空)'}, ` +
    `hasSecret=${!!next.appSecret}, tenantKey=${next.tenantKey ? '已设置' : '未设置'}`
  );
  return next;
}

function invalidateAppAccessToken() {
  appAccessToken = null;
  tokenExpireTime = 0;
  Logger.info('[飞书配置] 已清空 App Access Token 缓存');
}

function getCachedAppAccessToken() {
  if (appAccessToken && Date.now() < tokenExpireTime) {
    return appAccessToken;
  }
  return null;
}

function setCachedAppAccessToken(token, expireSeconds) {
  appAccessToken = token;
  tokenExpireTime = Date.now() + (expireSeconds - 300) * 1000;
}

/**
 * 对外返回时脱敏
 */
function toPublicAdminView(cfg) {
  return {
    enabled: cfg.enabled === true,
    appId: cfg.appId || '',
    appSecret: cfg.appSecret ? MASKED_SECRET : '',
    hasAppSecret: !!cfg.appSecret,
    tenantKey: cfg.tenantKey || '',
    redirectUri: buildRedirectUri(),
    source: cfg.source || 'settings',
  };
}

module.exports = {
  SETTINGS_KEY,
  MASKED_SECRET,
  buildRedirectUri,
  getFeishuConfig,
  isFeishuLoginAvailable,
  saveFeishuConfig,
  invalidateAppAccessToken,
  getCachedAppAccessToken,
  setCachedAppAccessToken,
  toPublicAdminView,
};
