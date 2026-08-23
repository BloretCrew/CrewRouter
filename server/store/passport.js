/**
 * Bloret PassPort OAuth helpers（插件商店专用）
 * 文档：OauthAPI.md —— passport.bloret.net /app/oauth + /app/verify
 *
 * 商店身份独立于 CrewRouter 自身 session：登录仅获得「商店身份」（提交者/评分者），
 * 管理员判定复用 PassPort 的 admin 字段或本地白名单（adminUsernames）。
 * 未配置时 getPassportConfig().isConfigured === false，调用方据此优雅降级。
 */

const Logger = require('../logger');

function getPassportConfig(config = {}) {
  const s = (config.store) || {};
  const p = s.passport || {};
  const baseUrl = String(
    process.env.PASSPORT_BASE_URL || process.env.CR_STORE_PASSPORT_BASE_URL || p.baseUrl || 'https://passport.bloret.net'
  ).replace(/\/$/, '');
  const appId = process.env.PASSPORT_APP_ID || process.env.CR_STORE_PASSPORT_APP_ID || p.appId || '';
  const appSecret = process.env.PASSPORT_APP_SECRET || process.env.CR_STORE_PASSPORT_APP_SECRET || p.appSecret || '';
  const redirectUri = process.env.PASSPORT_REDIRECT_URI || process.env.CR_STORE_PASSPORT_REDIRECT_URI || p.redirectUri || '';
  const sessionSecret =
    process.env.CR_STORE_SESSION_SECRET ||
    process.env.PASSPORT_SESSION_SECRET ||
    p.sessionSecret ||
    s.sessionSecret ||
    (config.app && config.app.sessionSecret) ||
    '';
  const adminUsernames = Array.isArray(p.adminUsernames) ? p.adminUsernames.slice() : [];
  return {
    baseUrl,
    appId,
    appSecret,
    redirectUri,
    sessionSecret,
    adminUsernames,
    // 是否已具备发起 OAuth 所需的最少配置
    isConfigured: Boolean(appId && appSecret && sessionSecret),
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
  Logger.info('[store-passport] 构建授权 URL，redirect_uri=', redirectUri);
  return `${passportCfg.baseUrl}/app/oauth?${params.toString()}`;
}

/**
 * 用授权码换用户信息
 * @returns {Promise<object>} PassPort 返回的用户字段（username/avatar/admin/email/apptoken…）
 */
async function verifyCode(passportCfg, code) {
  if (!passportCfg.appId || !passportCfg.appSecret) {
    const err = new Error('PassPort appId/appSecret 未配置');
    err.code = 'PASSPORT_NOT_CONFIGURED';
    throw err;
  }
  if (!code) {
    const err = new Error('缺少授权码 code');
    err.code = 'MISSING_CODE';
    throw err;
  }

  const params = new URLSearchParams({
    app_id: passportCfg.appId,
    app_secret: passportCfg.appSecret,
    code,
  });
  const url = `${passportCfg.baseUrl}/app/verify?${params.toString()}`;

  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    Logger.error('[store-passport] verify 非 JSON 响应', res.status, text.slice(0, 200));
    const err = new Error('PassPort 返回了非 JSON 响应');
    err.code = 'PASSPORT_BAD_RESPONSE';
    err.status = res.status;
    throw err;
  }

  if (!res.ok) {
    Logger.error('[store-passport] verify 失败', res.status, data);
    const err = new Error((data && (data.error || data.message)) || '授权验证失败');
    err.code = 'PASSPORT_VERIFY_FAILED';
    err.status = res.status;
    err.payload = data;
    throw err;
  }

  Logger.info('[store-passport] verify 成功，username=', data.username, 'admin=', data.admin);
  return data;
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
  if (passportAdminFlag === true || passportAdminFlag === 'true' || passportAdminFlag === '1') return true;
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
