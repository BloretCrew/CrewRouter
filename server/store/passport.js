/**
 * Bloret PassPort OAuth helpers（插件商店专用）
 * 文档：OauthAPI.md —— passport.bloret.net /app/oauth + /app/verify
 *
 * 商店身份独立于 CrewRouter 自身 session：登录仅获得「商店身份」（提交者/评分者），
 * 管理员判定复用 PassPort 的 admin 字段或本地白名单（adminUsernames）。
 * 未配置时 getPassportConfig().isConfigured === false，调用方据此优雅降级。
 */

const Logger = require('../logger');
const { hasPassportCredentials } = require('../utils/passport-credentials');
const { verifyPassportCode } = require('../utils/passport-verifier');
const { isStoreSessionSecretValid } = require('../utils/store-session-secret');

function firstConfigured(...values) {
  return values.find(value => value !== undefined);
}

function getPassportConfig(config = {}) {
  const s = (config.store) || {};
  const p = s.passport || {};
  const baseUrl = String(
    process.env.PASSPORT_BASE_URL || process.env.CR_STORE_PASSPORT_BASE_URL || p.baseUrl || 'https://passport.bloret.net'
  ).replace(/\/$/, '');
  const appId = firstConfigured(process.env.PASSPORT_APP_ID, process.env.CR_STORE_PASSPORT_APP_ID, p.appId, '');
  const appSecret = firstConfigured(process.env.PASSPORT_APP_SECRET, process.env.CR_STORE_PASSPORT_APP_SECRET, p.appSecret, '');
  const redirectUri = process.env.PASSPORT_REDIRECT_URI || process.env.CR_STORE_PASSPORT_REDIRECT_URI || p.redirectUri || '';
  const selectedSessionSecret = firstConfigured(
    process.env.CR_STORE_SESSION_SECRET,
    process.env.PASSPORT_SESSION_SECRET,
    p.sessionSecret,
    s.sessionSecret,
    config.app?.sessionSecret,
    ''
  );
  // An explicitly configured weak value disables sessions. It must never
  // silently select a different signing key from a lower-priority source.
  const sessionSecret = isStoreSessionSecretValid(selectedSessionSecret) ? selectedSessionSecret : '';
  const adminUsernames = Array.isArray(p.adminUsernames) ? p.adminUsernames.slice() : [];
  return {
    baseUrl,
    appId,
    appSecret,
    redirectUri,
    sessionSecret,
    adminUsernames,
    // 是否已具备发起 OAuth 所需的最少配置
    isConfigured: hasPassportCredentials({ appId, appSecret }) && Boolean(sessionSecret),
    // 是否在商店为空时填充演示数据（可关闭）
    seedDemo: s.seedDemo !== false,
  };
}

/**
 * 构建 OAuth 授权跳转 URL
 */
function buildAuthorizeUrl(passportCfg, redirectUri, state) {
  const params = new URLSearchParams({
    app_id: passportCfg.appId,
    redirect_uri: redirectUri,
  });
  if (state) params.set('state', state);
  Logger.info('[store-passport] 构建授权 URL');
  return `${passportCfg.baseUrl}/app/oauth?${params.toString()}`;
}

/**
 * 用授权码换用户信息
 * @returns {Promise<object>} 已校验的商店身份字段，不返回密码或 apptoken
 */
async function verifyCode(passportCfg, code) {
  // Preserve the historical GET contract until the provider's POST support is
  // independently confirmed. The shared helper never retries or falls back.
  return verifyPassportCode(passportCfg, code, { method: 'GET', requireAppToken: false });
}

/**
 * 解析当前请求应使用的 redirect_uri（优先显式配置，否则按请求宿主推导）
 */
function resolveRedirectUri(passportCfg, req) {
  if (passportCfg.redirectUri) return passportCfg.redirectUri;
  const proto = req.protocol || 'https';
  const host = req.get('host') || 'localhost:20003';
  return `${proto}://${host}/store/auth/callback`;
}

/**
 * 是否管理员：PassPort admin 字段为真，或命中本地白名单
 */
function isAdminUser(username, passportAdminFlag, passportCfg) {
  if (passportAdminFlag === true) return true;
  const list = passportCfg.adminUsernames || [];
  return list.includes(username);
}

module.exports = {
  getPassportConfig,
  buildAuthorizeUrl,
  verifyCode,
  resolveRedirectUri,
  isAdminUser,
};
