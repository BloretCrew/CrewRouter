const { t, middleware: i18nMiddleware, htmlLang, currentLang } = require('./i18n');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
const BPemail = require('./email');
const passkeyManager = require('./PassKey');
const setupMinecraft = require('./minecraft');
const aiRouter = require('./ai');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

// 解析cookie的辅助函数
function parseCookies(cookieHeader) {
    return require('./security').parseCookieHeader(cookieHeader);
}

const crypto = require('crypto');
const db = require('./database');
const { hashPassword, verifyPassword, rehashIfNeeded, sha256 } = require('./password');
const { createRateLimiter, getClientIp, getAppAuthParams, safeEqualString, escapeHtml, redactSensitiveUrl, scriptJson, safeImageUrl } = require('./security');
const { matchManagementUserRow, getSelectedUsernames } = require('./management-user-filter');
const { csrfMiddleware, CSRF_CLIENT_JS, csrfClientScriptTag } = require('./csrf');
const { resolveLogin } = require('./lib/login-resolver');
const usernameCompat = require('./lib/username-compat');
const { displayName, displayNameForUsername } = require('./lib/display-name');
const { themeBootScript } = require('./lib/blora-theme-boot');
const { renderOAuthUserPreview } = require('./lib/oauth-user-preview');
const { buildScopedUserInfo } = require('./lib/app-verify-user-info');
const { buildUsernameMappingPayload } = require('./lib/map-payload');
const { isValidUsername, isRegistrableUsername, normalizeUsername } = require('./lib/username-rule');

// 读取配置文件（提前，供 trust proxy / OAuth 使用）
const config = require('./config-loader').loadConfig();
const port = config.port || 20000;

// Only explicit proxy addresses/CIDRs may supply client IP information.
if (typeof config.trustProxy === 'string' || Array.isArray(config.trustProxy)) {
    app.set('trust proxy', config.trustProxy);
}
app.disable('x-powered-by');

// 安全响应头（不引入 helmet 依赖，手写基础防护）
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "base-uri 'none'; object-src 'none'; frame-ancestors 'self'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
});

app.use((req, res, next) => {
    const start = Date.now();
    const ip = getClientIp(req);

    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        // 优先使用会话中间件解析出的用户名（不信任可伪造的 username Cookie）
        const username = req.authUsername || 'Guest';
        
        // ANSI 颜色定义
        const RESET = '\x1b[0m';
        const GREEN = '\x1b[32m';
        const YELLOW = '\x1b[33m';
        const MAGENTA = '\x1b[35m';
        const CYAN = '\x1b[36m';
        const RED = '\x1b[31m';
        const GRAY = '\x1b[90m';
        const WHITE = '\x1b[37m';

        // 方法颜色
        let methodColor = WHITE;
        if (req.method === 'GET') methodColor = GREEN;
        else if (req.method === 'POST') methodColor = YELLOW;
        else if (req.method === 'DELETE') methodColor = RED;
        else if (req.method === 'PUT') methodColor = CYAN;

        // 状态码颜色
        let statusColor = GREEN;
        if (status >= 400) statusColor = RED;
        else if (status >= 300) statusColor = YELLOW;

        // 用户名颜色 (Guest 为灰色，登录用户为紫色)
        let userColor = (username === 'Guest') ? GRAY : MAGENTA;

        // 格式: METHOD URL STATUS [Username] DURATION [IP]
        // 示例: GET / 200 [MCBig_mountain] 6ms [223.88.64.106]
        // 脱敏：遮罩 query 中的敏感参数，防止 access log 泄漏 token/secret
        const safeUrl = redactSensitiveUrl(req.url || '');
        console.log(`${methodColor}${req.method}${RESET} ${safeUrl} ${statusColor}${status}${RESET} ${userColor}[${username}]${RESET} ${CYAN}${duration}ms${RESET} ${GRAY}[${ip}]${RESET}`);
    });

    next();
});

// 登录/注册限流（按 IP）
const loginRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyFn: (req) => `login:${getClientIp(req)}`
});
const registerRateLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyFn: (req) => `register:${getClientIp(req)}`
});
const twoFaRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyFn: (req) => `2fa:${getClientIp(req)}`
});
const twoFaSettingsRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyFn: (req) => `2fa-settings:${getClientIp(req)}:${req.authUsername || 'anonymous'}`
});
const passkeyRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 40,
    keyFn: (req) => `passkey:${getClientIp(req)}`
});
const forgotPasswordRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyFn: (req) => `forgot-password:${getClientIp(req)}`
});
const forgotPasswordEmailRateLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    max: 3,
    keyFn: (req) => {
        const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        return `forgot-password-email:${email || getClientIp(req)}`;
    }
});
const resetPasswordRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyFn: (req) => `reset-password:${getClientIp(req)}`
});

// 废弃文件读写，改为数据库操作
// const USER_FILE = path.join(__dirname, 'data/user.json');
// let users = {};
// ...

// 读取邮箱验证中的用户数据 (这个暂时保留在内存或也迁移到Redis/DB，这里暂时保持内存因为是临时的)
let emailVerifying = {};
// if (fs.existsSync(path.join(__dirname, 'data/emailVerifying.json'))) { ... }
// 实际上 emailVerifying 也可以不用持久化，或者用数据库。
// 为了简化，先保留 emailVerifying 的逻辑，但是不持久化到文件了，或者持久化到DB。
// 用户说 "data 数据全部迁移"，emailVerifying 也是 data。
// 但是 emailVerifying 是临时的。
// 让我们先只处理 users, oauthApps, authorizations, userLogs.

// 存储 Mobile App 2FA 验证请求（带 TTL 扫表，防泄漏）
const mobileAuthRequests = new Map();
const MOBILE_AUTH_TTL_MS = 2 * 60 * 1000;
function cleanExpiredMobileAuthRequests() {
    const now = Date.now();
    for (const [id, reqData] of mobileAuthRequests.entries()) {
        if (!reqData || !reqData.timestamp || now - reqData.timestamp > MOBILE_AUTH_TTL_MS) {
            mobileAuthRequests.delete(id);
        }
    }
}
setInterval(cleanExpiredMobileAuthRequests, 60 * 1000).unref?.();

// 中间件
// AI 多模态（base64 图片）请求体远超默认 100kb；过小会在 body-parser 阶段直接
// PayloadTooLargeError，并被全局错误处理成含糊的 500。
app.use(express.urlencoded({ extended: false, limit: '128kb', parameterLimit: 100 }));
const identityJsonParser = express.json({ limit: '128kb' });
const aiJsonParser = express.json({ limit: '20mb' });
app.use((req, res, next) => {
    const aiChat = req.path.toLowerCase().replace(/\/$/, '') === '/v1/chat/completions';
    return (aiChat ? aiJsonParser : identityJsonParser)(req, res, next);
});
// i18n：?lang= / cookie bp_lang / Accept-Language；请求内 t() 自动跟语言
app.use(i18nMiddleware());

// --- 会话 / 安全辅助 ---
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 天
const SESSION_COOKIE = '__Host-bp_session';
const SAFE_REDIRECT_HOSTS = new Set([
    'passport.bloret.net',
    'localhost',
    '127.0.0.1'
]);

function getSessionCookieOptions(maxAgeMs = SESSION_MAX_AGE_MS) {
    return {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: true,
        maxAge: maxAgeMs
    };
}

/** 建立服务端会话并写入 httpOnly Cookie；清除旧的可伪造 username Cookie */
async function establishSession(res, username, maxAgeMs = SESSION_MAX_AGE_MS, cookieOverrides = {}, expectedUser) {
    const { token } = await db.createSession(username, maxAgeMs, expectedUser);
    res.cookie(SESSION_COOKIE, token, { ...getSessionCookieOptions(maxAgeMs), ...cookieOverrides });
    res.clearCookie('username', { path: '/' });
    return token;
}

/** 销毁当前会话 */
async function clearSession(req, res) {
    const token = req.sessionToken || parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
    if (token) {
        await db.deleteSession(token);
    }
    res.clearCookie(SESSION_COOKIE, { path: '/', secure: true, sameSite: 'lax' });
    res.clearCookie('username', { path: '/', secure: true, sameSite: 'lax' });
}

function normalizeOAuthRedirectUri(uri) {
    if (!uri || typeof uri !== 'string') return '';
    let value = uri.trim();
    if (!value) return '';
    try {
        value = decodeURIComponent(value);
    } catch {
        // 保持原值，后续按绝对 URL 或自定义协议解析
    }
    // CrewRouter 等客户端可能把 http:// 编成 http%2F%2F，还原协议分隔符。
    value = value.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*)%3A%2F%2F/i, (_, proto) => `${proto}://`);
    value = value.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*)%2F%2F/i, (_, proto) => `${proto}://`);
    value = value.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*)\/\//, (_, proto) => `${proto}://`);
    return value;
}

function parseAbsoluteHttpUrl(uri) {
    const normalized = normalizeOAuthRedirectUri(uri);
    if (!normalized) return null;
    try {
        const parsed = new URL(normalized);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        if (parsed.username || parsed.password) return null;
        return parsed;
    } catch {
        return null;
    }
}

function isPassPortHost(hostname) {
    return SAFE_REDIRECT_HOSTS.has(hostname);
}

/**
 * 登录后跳转是否安全：仅允许本站相对路径，或指向本站 /app/oauth 的绝对 URL。
 * 第三方应用回调必须等 /app/oauth 完成授权后再跳，不能在登录成功时直接拼到 /app/ 后面。
 * 注意：OAuth 应用自己的 redirect_uri 白名单校验见 isOAuthRedirectAllowed。
 */
function isSafeLoginRedirect(uri) {
    if (!uri || typeof uri !== 'string') return false;
    const trimmed = uri.trim();
    if (!trimmed || trimmed.includes('\\') || trimmed.includes('\n') || trimmed.includes('\r')) return false;
    // 相对路径（禁止 //evil.com 协议相对 URL）
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
        const pathname = trimmed.split(/[?#]/)[0];
        return ['/app/oauth', '/oauth/authorize'].includes(pathname);
    }
    const parsed = parseAbsoluteHttpUrl(trimmed);
    if (!parsed) return false;
    if (!isPassPortHost(parsed.hostname) || parsed.protocol !== 'https:') return false;
    return ['/app/oauth', '/oauth/authorize'].includes(parsed.pathname);
}

function appendQueryParams(uri, params = {}) {
    const trimmed = String(uri || '').trim();
    const hashIndex = trimmed.indexOf('#');
    const withoutHash = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
    const hash = hashIndex === -1 ? '' : trimmed.slice(hashIndex);
    const joiner = withoutHash.includes('?') ? '&' : '?';
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            query.set(key, String(value));
        }
    }
    const encoded = query.toString();
    return encoded ? `${withoutHash}${joiner}${encoded}${hash}` : `${withoutHash}${hash}`;
}

function appendOAuthCallbackParams(redirectUri, params = {}) {
    const trimmed = normalizeOAuthRedirectUri(redirectUri);
    if (!isSafeOAuthCallback(trimmed)) {
        const err = new Error('OAuth redirect_uri is invalid');
        err.code = 'INVALID_OAUTH_REDIRECT';
        throw err;
    }
    const parsed = parseAbsoluteHttpUrl(trimmed);
    if (parsed) {
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null && value !== '') {
                parsed.searchParams.set(key, String(value));
            }
        }
        return parsed.toString();
    }
    // 空白名单应用可使用自定义协议回调，例如 myapp://oauth/callback
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.startsWith('/') && !trimmed.startsWith('//')) {
        return appendQueryParams(trimmed, params);
    }
    const err = new Error('OAuth redirect_uri must be an absolute URL');
    err.code = 'INVALID_OAUTH_REDIRECT';
    throw err;
}

function getOAuthRedirectUris(oauthApp) {
    if (!oauthApp) return [];
    const raw = oauthApp.redirect_uri;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return raw ? [raw] : [];
        }
    }
    return [];
}

function isOAuthRedirectAllowed(oauthApp, redirectUri) {
    if (!isSafeOAuthCallback(redirectUri)) return false;
    const redirectUris = getOAuthRedirectUris(oauthApp).filter(uri => typeof uri === 'string' && uri.trim());
    return redirectUris.includes(redirectUri);
}

function isSafeOAuthCallback(uri) {
    if (typeof uri !== 'string' || !uri || /[\s\\]/.test(uri)) return false;
    try {
        const parsed = new URL(uri);
        if (parsed.username || parsed.password || parsed.hash) return false;
        if (parsed.protocol === 'https:') return Boolean(parsed.hostname);
        if (parsed.protocol === 'http:') return ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname);
        // Native application callbacks require a hierarchical custom scheme.
        return /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) &&
            !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'].includes(parsed.protocol);
    } catch { return false; }
}

/** 解析登录后跳转目标；不安全则回首页 */
function resolveLoginRedirect(uri) {
    if (!uri || typeof uri !== 'string') return '/';
    let decoded = uri;
    try {
        decoded = decodeURIComponent(uri);
    } catch {
        decoded = uri;
    }
    return isSafeLoginRedirect(decoded) ? decoded : '/';
}

/** 过滤禁止的 OAuth 权限（普通应用不可申请） */
const FORBIDDEN_OAUTH_PERMISSIONS = new Set(['user:password', 'user:admin']);

function sanitizeOAuthPermissions(permissions, allowAdmin = false) {
    const list = Array.isArray(permissions) ? permissions : (permissions ? [permissions] : []);
    return list.filter(p => {
        if (!p) return false;
        if (p === 'user:admin' && allowAdmin) return true; // 管理员保留
        return !FORBIDDEN_OAUTH_PERMISSIONS.has(p);
    });
}

// 会话解析中间件：只信任 __Host-bp_session，不再信任可伪造的 username Cookie
app.use(async (req, res, next) => {
    try {
        const cookies = parseCookies(req.headers.cookie || '');
        req.sessionToken = cookies[SESSION_COOKIE] || null;
        req.authUsername = null;
        if (req.sessionToken) {
            req.authUsername = await db.getSessionUsername(req.sessionToken);
            if (!req.authUsername) {
                // 过期/无效 token
                res.clearCookie(SESSION_COOKIE, { path: '/', secure: true, sameSite: 'lax' });
                req.sessionToken = null;
            }
        }
        next();
    } catch (err) {
        next(err);
    }
});

// 已删除的背景操作保持明确的 404 兼容响应，不重新启用该功能。
app.post('/api/user/:action', (req, res, next) => {
    if (req.params.action === 'update_' + 'background') return res.sendStatus(404);
    next();
});

// CSRF：确保 Cookie；保护已登录相关的状态变更 POST（登录/注册/App API 已白名单）
app.use(csrfMiddleware());
require('./lib/recent-auth').installRecentAuth(app, { db, passkeyManager, logUserAction });
app.get('/webauthn-browser.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js')));

// AI API 路由（OpenAI 兼容格式，/v1/chat/completions, /v1/models, /v1/billing）
app.use('/', aiRouter);

// 仅暴露必要静态资源，禁止把应用根目录（含源码/配置）整站托管
app.use('/icons', express.static(path.join(__dirname, 'icons')));
app.get('/index.css', (req, res) => {
    res.type('text/css').sendFile(path.join(__dirname, 'index.css'));
});

// Blora Design 2.0 assets are served from the installed package so every page uses the same runtime.
const bloraDist = path.join(__dirname, 'node_modules', '@bloret-crew', 'blora-design', 'dist');
const bloraVersion = require('@bloret-crew/blora-design/package.json').version;
app.use('/blora', express.static(bloraDist, { maxAge: '1h' }));
const bloraThemingDist = path.join(__dirname, 'node_modules', '@bloret-crew', 'blora-design-theming', 'dist');
app.use('/blora-theming', express.static(bloraThemingDist, { maxAge: '1h' }));

function bloraAssetTags() {
    // Use the synchronous boot script shipped by the installed theming add-on.
    // It must run before Blora CSS so SSR pages do not flash the OS theme.
    // icons-full must run before auto.js so SSR timelines/buttons can resolve
    // Lucide names that are not in the compact icon set.
    return `
    <script>${themeBootScript}</script>
    <link rel="stylesheet" href="/blora/blora.css?v=${bloraVersion}">
    <link rel="stylesheet" href="/blora/tokens.dark.css?v=${bloraVersion}">
    <link rel="stylesheet" href="/blora-theming/theming.css?v=${bloraVersion}">
    <script type="module" src="/blora/icons-full.js?v=${bloraVersion}"></script>
    <script type="module" src="/blora/auto.js?v=${bloraVersion}"></script>
    <script type="module" src="/blora-theming/theming.global.js?v=${bloraVersion}"></script>`;
}
app.get('/BL.png', (req, res) => {
    res.type('image/png');
    res.sendFile(path.join(__dirname, 'BL.png'));
});
app.get('/favicon.ico', (req, res) => {
    res.type('image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'BL.png'));
});
app.get('/csrf-client.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-store').send(CSRF_CLIENT_JS);
});
app.get('/blora-message-layer.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'lib/blora-message-layer.js'));
});
// fluent-web 若页面引用可按需放开；默认不暴露其它根目录文件

function generateCode() {
    return crypto.randomBytes(32).toString('hex');
}

const pendingLogins = require('./lib/pending-login').createPendingLoginStore();
const PENDING_LOGIN_COOKIE = '__Host-bp_2fa_pending';
function beginPendingLogin(req, res, user, redirectUri, notice = null) {
    const oldToken = parseCookies(req.headers.cookie || '')[PENDING_LOGIN_COOKIE];
    pendingLogins.delete(oldToken);
    const token = pendingLogins.create(user,
        typeof redirectUri === 'string' && isSafeLoginRedirect(redirectUri) ? redirectUri : '', notice);
    res.cookie(PENDING_LOGIN_COOKIE, token, {
        httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 300000
    });
    for (const name of ['2fa_pending_username', '2fa_redirect_uri', 'bp_rename_notice']) {
        res.clearCookie(name, { path: '/', secure: true, sameSite: 'lax' });
    }
}
function readPendingLogin(req) {
    const token = parseCookies(req.headers.cookie || '')[PENDING_LOGIN_COOKIE];
    const record = pendingLogins.get(token);
    return record ? { token, ...record } : null;
}
function consumePendingLogin(pending, res) {
    if (!pending || !pendingLogins.consume(pending.token)) return false;
    res.clearCookie(PENDING_LOGIN_COOKIE, { path: '/', secure: true, sameSite: 'lax' });
    return true;
}
function isMobileApprovalApp(appId) {
    return typeof appId === 'string' && Array.isArray(config.twoFactorApprovalAppIds) &&
        config.twoFactorApprovalAppIds.includes(appId);
}
function issuePasskeyBrowserBinding(res) {
    const binding = crypto.randomBytes(32).toString('hex');
    res.cookie('__Host-bp_webauthn', binding, {
        httpOnly: true, sameSite: 'strict', secure: true, path: '/', maxAge: 300000
    });
    return binding;
}
function readPasskeyBrowserBinding(req) {
    return parseCookies(req.headers.cookie || '')['__Host-bp_webauthn'] || '';
}

// 飞书 OAuth 授权 URL（使用官方入口 open.feishu.cn，直接访问 accounts.feishu.cn 会丢失 app_id）
function getLarkAuthorizeUrl(state) {
    const lark = (config.oauth && config.oauth.lark) || {};
    const redirectUri = getLarkOAuthRedirectUri();
    const appId = lark.client_id || '';
    const params = new URLSearchParams({
        app_id: appId,
        redirect_uri: redirectUri
    });
    if (state) params.set('state', state);
    return `https://open.feishu.cn/open-apis/authen/v1/authorize?${params.toString()}`;
}

const LARK_OAUTH_STATE_COOKIE = '__Host-lark_oauth_state';
const LARK_OAUTH_REDIRECT_COOKIE = '__Host-lark_oauth_redirect_uri';
const LARK_OAUTH_MAX_AGE_MS = 10 * 60 * 1000;
const larkOAuthStates = new Map();

function cleanLarkOAuthStates() {
    const now = Date.now();
    for (const [nonce, issuedAt] of larkOAuthStates) {
        if (now - issuedAt > LARK_OAUTH_MAX_AGE_MS) larkOAuthStates.delete(nonce);
    }
}

function getLarkOAuthStateSecret() {
    const configured = config.oauth && config.oauth.lark && config.oauth.lark.client_secret;
    return typeof configured === 'string' && configured ? configured : null;
}

function encodeBase64Url(value) {
    return Buffer.from(value).toString('base64url');
}

function getLarkOAuthRedirectUri() {
    const lark = (config.oauth && config.oauth.lark) || {};
    return lark.redirect_uri || 'https://passport.bloret.net/oauth/lark';
}

function createLarkOAuthState(redirectUri) {
    const payload = encodeBase64Url(JSON.stringify({
        purpose: 'lark_oauth',
        nonce: crypto.randomBytes(32).toString('hex'),
        issuedAt: Date.now(),
        redirectUri: redirectUri || '',
        callbackUri: getLarkOAuthRedirectUri()
    }));
    const secret = getLarkOAuthStateSecret();
    if (!secret) throw new Error('Feishu OAuth state secret is not configured');
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    cleanLarkOAuthStates();
    larkOAuthStates.set(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).nonce, Date.now());
    return `${payload}.${signature}`;
}

function verifyLarkOAuthState(state) {
    if (typeof state !== 'string') return null;
    const parts = state.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const secret = getLarkOAuthStateSecret();
    if (!secret) return null;
    const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
    if (!safeEqualString(parts[1], expected)) return null;
    try {
        const parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const age = Date.now() - parsed.issuedAt;
        if (!parsed || parsed.purpose !== 'lark_oauth' ||
            parsed.callbackUri !== getLarkOAuthRedirectUri() ||
            typeof parsed.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.nonce) ||
            !Number.isFinite(parsed.issuedAt) || age < 0 || age > LARK_OAUTH_MAX_AGE_MS) return null;
        if (parsed.redirectUri && !isSafeLoginRedirect(parsed.redirectUri)) return null;
        cleanLarkOAuthStates();
        if (!larkOAuthStates.has(parsed.nonce)) return null;
        larkOAuthStates.delete(parsed.nonce);
        return parsed;
    } catch (_) {
        return null;
    }
}

function getLarkOAuthCookieOptions() {
    return {
        httpOnly: true,
        // Feishu's Android in-app browser treats the authorization hop as
        // cross-site and may omit SameSite=Lax cookies on the callback.
        // SameSite=None is safe here because the cookie is Secure, HttpOnly,
        // short-lived, and the callback still requires an exact state match.
        sameSite: 'none',
        path: '/',
        secure: true,
        maxAge: LARK_OAUTH_MAX_AGE_MS
    };
}

function clearLarkOAuthCookies(res) {
    res.clearCookie(LARK_OAUTH_STATE_COOKIE, { path: '/', secure: true, sameSite: 'none' });
    res.clearCookie(LARK_OAUTH_REDIRECT_COOKIE, { path: '/', secure: true, sameSite: 'none' });
}

function getLarkOAuthError(message) {
    return { status: 'error', message: t(message) };
}

// 记录用户操作日志
async function logUserAction(username, actionType, message, ip) {
    try {
        await db.logUserAction(username, actionType, message, ip || 'unknown');
    } catch (e) {
        console.error(t('记录用户日志失败:'), e);
    }
}

// 处理首页请求
app.get('/', async (req, res) => {
    // 检查cookie中的username
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;

    // 获取redirect_uri参数
    const redirectUri = req.query.redirect_uri;
    
    // 如果用户未登录
    if (!username) {
        const simpleLoginHref = redirectUri && isSafeLoginRedirect(redirectUri)
            ? `/plain-login?redirect_uri=${encodeURIComponent(redirectUri)}`
            : '/plain-login';
        return res.send(generateLoginHtml(redirectUri, null, 'login', simpleLoginHref));
    }

    const user = await db.getUser(username);
    if (!user) {
        const simpleLoginHref = redirectUri && isSafeLoginRedirect(redirectUri)
            ? `/plain-login?redirect_uri=${encodeURIComponent(redirectUri)}`
            : '/plain-login';
        return res.send(generateLoginHtml(redirectUri, null, 'login', simpleLoginHref));
    } else {
        let recentLogs = [];
        try {
            recentLogs = await db.getUserLogs(username, 5);
        } catch (e) {
            console.error(t('加载操作日志失败:'), e);
        }
        res.send(generateUserPageHtml(user, recentLogs));
    }
});

// 简单原生登录页：供不兼容 Blora Custom Elements 的浏览器使用
app.get('/plain-login', (req, res) => {
    const redirectUri = typeof req.query.redirect_uri === 'string' && isSafeLoginRedirect(req.query.redirect_uri)
        ? req.query.redirect_uri
        : null;
    res.send(generatePlainLoginHtml(redirectUri, null, req.csrfToken));
});

// 简单原生 2FA 页面
app.get('/login/2fa/simple', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const pending = readPendingLogin(req);
    const pendingUsername = pending && pending.username;
    if (!pendingUsername) return res.redirect('/plain-login');
    const user = await db.getUser(pendingUsername);
    if (!pendingLogins.matches(pending, user)) return res.redirect('/plain-login');
    res.send(generatePlain2FALoginHtml(pendingUsername, null, req.csrfToken));
});

// 处理登录请求
app.post('/login', loginRateLimit, async (req, res) => {
    const { username, password } = req.body;
    const redirect_uri = req.body.redirect_uri;
    const clientIp = getClientIp(req);

    // 大小写不敏感命中优先（永久机制，无弹窗）；
    // 未命中时为旧用户名兼容（临时模块，登录后弹窗确认）；
    // 均未命中则登录失败。
    const resolved = await resolveLogin(username, {
        findUser: (u) => db.getUserByLower(u),
        compatGet: (u) => usernameCompat.compatGet(u)
    });
    const user = resolved.status === 'ok' ? resolved.user : null;
    const check = user ? await verifyPassword(password, user.password) : { ok: false };

    if (user && check.ok) {
        // 旧哈希成功登录后升级为 bcrypt
        const newHash = await rehashIfNeeded(check);
        if (newHash) {
            await db.updateUser(user.username, { password: newHash }).catch(e => console.error(t('密码升级失败:'), e));
        }

        // 检查是否开启了 2FA
        if (user.twoFactorEnabled) {
            // Only a server-side record proves completion of the first factor.
            if (newHash) user.password = newHash;
            beginPendingLogin(req, res, user, redirect_uri, resolved.notice || null);

            await logUserAction(user.username, 'login_2fa_pending', t('密码验证通过，等待二次验证'), clientIp);
            return res.redirect(req.body && req.body.simple_login === '1' ? '/login/2fa/simple' : '/login/2fa');
        }

        // 未开启 2FA，直接登录成功
        await establishSession(res, user.username, SESSION_MAX_AGE_MS, {}, user);

        // 记录登录成功日志
        await logUserAction(user.username, 'login', t('登录成功'), clientIp);

        const target = resolveLoginRedirect(redirect_uri);
        if (resolved.notice) {
            return res.send(usernameCompat.generateRenameNoticeHtml({ ...resolved.notice, redirectUri: target }));
        }
        res.redirect(target);
    } else {
        // 登录失败：统一文案，避免用户名枚举
        if (user) {
            await db.logUserAction(user.username, 'login_failed', t('密码错误'), clientIp);
        } else {
            console.log(`[Login Failed] User not found: ${username} (IP: ${clientIp})`);
        }
        if (req.body && req.body.simple_login === '1') {
            const safeRedirect = typeof redirect_uri === 'string' && isSafeLoginRedirect(redirect_uri) ? redirect_uri : null;
            return res.send(generatePlainLoginHtml(safeRedirect, t('用户名或密码错误'), req.csrfToken));
        }
        res.send(generateLoginHtml(redirect_uri, t('用户名或密码错误')));
    }
});

// 2FA 登录页面
app.get('/login/2fa', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const pending = readPendingLogin(req);
    const pendingUsername = pending && pending.username;

    if (!pendingUsername) {
        return res.redirect('/');
    }
    
    const user = await db.getUser(pendingUsername);
    if (!pendingLogins.matches(pending, user)) {
        return res.redirect('/');
    }

    res.send(generate2FALoginHtml(pendingUsername));
});

// 2FA TOTP 验证接口
app.post('/login/2fa/verify', twoFaRateLimit, async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const pending = readPendingLogin(req);
    const pendingUsername = pending && pending.username;
    const redirectUri = pending && pending.redirectUri;
    const { token } = req.body;
    const clientIp = getClientIp(req);

    if (!pendingUsername) {
        return res.status(401).send(t('会话已过期，请重新登录'));
    }
    
    const user = await db.getUser(pendingUsername);
    if (!pendingLogins.matches(pending, user)) {
        return res.status(401).send(t('用户不存在'));
    }

    if (!pendingLogins.attempt(pending.token) || typeof token !== 'string' || !/^\d{6}$/.test(token)) {
        return res.status(400).send(t('验证码错误或已过期'));
    }

    const secret = user.totpSecret ? user.totpSecret.base32 : null;
    
    if (!secret) {
        return res.status(400).send(t('未配置 2FA'));
    }

    const verified = speakeasy.totp.verify({
        secret: secret,
        encoding: 'base32',
        token: token,
        window: 1 // 允许前后 30 秒的误差
    });

    if (verified) {
        if (!consumePendingLogin(pending, res)) return res.status(401).send(t('会话已过期，请重新登录'));

        await establishSession(res, pendingUsername, SESSION_MAX_AGE_MS, {}, user);

        await logUserAction(pendingUsername, 'login_2fa_success', t('二次验证(TOTP)成功'), clientIp);

        const target = resolveLoginRedirect(redirectUri);
        if (pending.notice) {
            return res.send(usernameCompat.generateRenameNoticeHtml({ ...pending.notice, redirectUri: target }));
        }
        res.redirect(target);
    } else {
        await logUserAction(pendingUsername, 'login_2fa_failed', t('TOTP 令牌无效'), clientIp);
        if (req.body && req.body.simple_login === '1') {
            return res.send(generatePlain2FALoginHtml(pendingUsername, t('验证码错误或已过期'), req.csrfToken));
        }
        res.send(generate2FALoginHtml(pendingUsername, t('验证码错误或已过期')));
    }
});

// 2FA PassKey 验证接口 (作为第二步验证)
app.post('/api/passkey/2fa/verify', twoFaRateLimit, async (req, res) => {
    try {
        const cookies = parseCookies(req.headers.cookie || '');
        const pending = readPendingLogin(req);
        const pendingUsername = pending && pending.username;
        const redirectUri = pending && pending.redirectUri;

        if (!pendingUsername) {
            return res.status(401).json({ error: t('会话已过期，请重新登录') });
        }

        const user = await db.getUser(pendingUsername);
        if (!pendingLogins.matches(pending, user)) {
            return res.status(401).json({ error: t('用户不存在') });
        }

        const { response, challenge } = req.body;

        // 查找匹配的 key
        // user.passkeys is now available from db
        const passkey = user.passkeys ? user.passkeys.find(k => k.credentialID === response.id) : null;
        if (!passkey) return res.status(400).json({ error: t('此设备未绑定该账号') });

        if (!pendingLogins.attempt(pending.token)) return res.status(401).json({ error: t('会话已过期') });
        const info = await passkeyManager.verifyAuthentication(passkey, response, challenge, `mfa:${pending.token}`);

        await db.mutatePasskey(pendingUsername, { operation: 'counter', credentialID: passkey.credentialID,
            expectedCounter: passkey.counter, newCounter: info.newCounter }, user);

        if (!consumePendingLogin(pending, res)) return res.status(401).json({ error: t('会话已过期') });

        await establishSession(res, pendingUsername, SESSION_MAX_AGE_MS, {}, user);

        const clientIp = getClientIp(req);
        await logUserAction(pendingUsername, 'login_2fa_passkey_success', t('二次验证(通行密钥)成功'), clientIp);

        res.json({ success: true, redirect: resolveLoginRedirect(redirectUri) });
    } catch (e) {
        console.error('PassKey 2FA Verify Error:', e);
        res.status(400).json({ error: e.message });
    }
});

// --- Mobile App 验证 API 开始 ---

// 1. 网页端：初始化 App 验证请求
app.post('/api/2fa/app/init', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const pending = readPendingLogin(req);
    const pendingUsername = pending && pending.username;
    const clientIp = getClientIp(req);

    if (!pendingUsername) {
        return res.status(401).json({ error: t('会话已过期') });
    }
    
    const user = await db.getUser(pendingUsername);
    if (!pendingLogins.matches(pending, user)) {
        return res.status(401).json({ error: t('用户不存在') });
    }

    // 清理该用户旧的请求
    for (const [key, val] of mobileAuthRequests.entries()) {
        if (val.username === pendingUsername) {
            mobileAuthRequests.delete(key);
        }
    }

    // 生成新请求 ID
    const requestId = crypto.randomBytes(16).toString('hex');
    mobileAuthRequests.set(requestId, {
        username: pendingUsername,
        pendingToken: pending.token,
        status: 'pending',
        timestamp: Date.now(),
        ip: clientIp,
        device: req.headers['user-agent'] // 记录设备信息供 App 展示
    });

    // 2分钟后自动过期
    setTimeout(() => {
        if (mobileAuthRequests.has(requestId)) {
            mobileAuthRequests.delete(requestId);
        }
    }, 120000).unref?.();

    res.json({ success: true, requestId: requestId });
});

// 2. 网页端：轮询验证状态
app.get('/api/2fa/app/status', async (req, res) => {
    cleanExpiredMobileAuthRequests();
    const pending = readPendingLogin(req);
    const { requestId } = req.query;
    const request = mobileAuthRequests.get(requestId);
    if (!pending || !request || request.pendingToken !== pending.token || request.username !== pending.username) {
        return res.json({ status: 'expired' });
    }
    const user = await db.getUser(pending.username);
    if (!pendingLogins.matches(pending, user)) return res.json({ status: 'expired' });
    if (request.status === 'approved') {
        if (!consumePendingLogin(pending, res)) return res.json({ status: 'expired' });
        mobileAuthRequests.delete(requestId);
        await establishSession(res, pending.username, SESSION_MAX_AGE_MS, {}, user);
        await logUserAction(pending.username, 'login_2fa_app_success', t('二次验证(手机应用)成功'), getClientIp(req));
        return res.json({ status: 'approved', redirect: resolveLoginRedirect(pending.redirectUri) });
    }
    if (request.status === 'rejected') {
        mobileAuthRequests.delete(requestId);
        return res.json({ status: 'rejected' });
    }
    res.json({ status: 'pending' });
});

// 3. App 端：获取待处理的请求 (需要 App 端提供鉴权信息，这里演示使用 app_id + user token)
app.get('/api/2fa/app/pending', async (req, res) => {
    // 假设 App 发送 headers: { 'x-app-id': '...', 'x-user-token': '...', 'x-username': '...' }
    // 或者 query 参数。这里为了通用性，检查 query 或 body 中的认证信息
    cleanExpiredMobileAuthRequests();
    const { user: username, app_id, usertoken: token } = getAppAuthParams(req);
    if (!isMobileApprovalApp(app_id)) return res.status(403).json({ error: t('App 认证失败') });

    if (!username) {
        return res.status(401).json({ error: t('缺少用户名') });
    }
    
    const user = await db.getUser(username);
    if (!user) {
        return res.status(401).json({ error: t('用户不存在') });
    }

    // App 鉴权：多令牌表 + 旧字段兼容（重新授权后旧令牌仍应有效）
    if (!(await db.validateAppToken(username, app_id, token))) {
        return res.status(403).json({ error: t('App 认证失败') });
    }

    // 查找该用户的 pending 请求
    const pendingRequests = [];
    for (const [id, reqData] of mobileAuthRequests.entries()) {
        if (reqData.username === username && reqData.status === 'pending') {
            pendingRequests.push({
                requestId: id,
                timestamp: reqData.timestamp,
                ip: reqData.ip,
                device: reqData.device,
                location: t('未知位置') // 如果有 IP 库可解析
            });
        }
    }

    res.json({ success: true, requests: pendingRequests });
});

// 4. App 端：批准或拒绝请求
app.post('/api/2fa/app/approve', async (req, res) => {
    cleanExpiredMobileAuthRequests();
    const { user: username, app_id, usertoken: token } = getAppAuthParams(req);
    const { requestId, action } = req.body;
    if (!isMobileApprovalApp(app_id)) return res.status(403).json({ error: t('App 认证失败') });
    if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: t('无效操作') });

    if (!username) return res.status(401).json({ error: t('缺少用户名') });
    
    const user = await db.getUser(username);
    if (!user) return res.status(401).json({ error: t('用户不存在') });

    // App 鉴权：多令牌表 + 旧字段兼容
    if (!(await db.validateAppToken(username, app_id, token))) {
        return res.status(403).json({ error: t('App 认证失败') });
    }

    const request = mobileAuthRequests.get(requestId);
    if (!request || request.username !== username || request.status !== 'pending' || !pendingLogins.get(request.pendingToken)) {
        return res.status(404).json({ error: t('请求不存在或已过期') });
    }

    if (action === 'approve') {
        request.status = 'approved';
        await logUserAction(username, '2fa_app_action', `手机应用批准了登录请求 ${requestId}`, req.ip);
    } else {
        request.status = 'rejected';
        await logUserAction(username, '2fa_app_action', `手机应用拒绝了登录请求 ${requestId}`, req.ip);
    }

    res.json({ success: true });
});

// --- Mobile App 验证 API 结束 ---

// 获取 2FA PassKey 登录选项 (复用现有的，但是针对 pendingUser)
app.post('/api/passkey/2fa/options', async (req, res) => {
    try {
        const cookies = parseCookies(req.headers.cookie || '');
        const pending = readPendingLogin(req);
        const pendingUsername = pending && pending.username;

        if (!pendingUsername) {
            return res.status(401).json({ error: t('会话已过期') });
        }
        
        const user = await db.getUser(pendingUsername);
        if (!pendingLogins.matches(pending, user)) {
            return res.status(401).json({ error: t('用户不存在') });
        }

        if (!user.passkeys || user.passkeys.length === 0) {
            return res.status(404).json({ error: t('该账号未绑定通行密钥') });
        }

        const options = await passkeyManager.getAuthenticationOptions(user.passkeys, `mfa:${pending.token}`);
        res.json(options);
    } catch (e) {
        console.error('Login Options Error:', e);
        res.status(500).json({ error: e.message });
    }
});



// 处理登出请求
app.get('/logout', (req, res) => {
    res.send(`<!doctype html><meta charset="utf-8"><title>退出登录</title><form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escapeHtml(req.csrfToken)}"><button type="submit">确认退出登录</button></form>`);
});
app.post('/logout', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    const clientIp = getClientIp(req);

    // 记录登出日志
    if (username) {
        await logUserAction(username, 'logout', t('已退出登录'), clientIp);
    }

    await clearSession(req, res);
    res.redirect('/');
});

// 2FA 设置已改为首页弹窗
app.get('/user/2fa/setup', async (req, res) => {
    if (!req.authUsername) return res.redirect('/');
    return res.redirect('/?security=1');
});

// 生成 2FA 密钥
app.post('/api/2fa/generate', twoFaSettingsRateLimit, async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    if (!username) return res.status(401).json({ error: t('未登录') });

    const user = await db.getUser(username);
    if (!user) return res.status(401).json({ error: t('用户不存在') });

    if (user.twoFactorEnabled) return res.status(409).json({ error: t('请先关闭当前双重认证') });

    // 生成密钥
    const secret = speakeasy.generateSecret({
        length: 20,
        name: `BloretPassPort (${username})`,
        issuer: 'Bloret PassPort'
    });

    // 生成二维码
    try {
        const data_url = await qrcode.toDataURL(secret.otpauth_url);

        // 临时存储 secret 到数据库
        await db.updateUser(username, { tempTotpSecret: secret });

        res.json({
            secret: secret.base32,
            qrcode: data_url
        });
    } catch (err) {
        res.status(500).json({ error: t('生成二维码失败') });
    }
});

// 启用或恢复 2FA
app.post('/api/2fa/enable', twoFaSettingsRateLimit, async (req, res) => {
    const username = req.authUsername;
    const { token, password } = req.body || {};
    const clientIp = getClientIp(req);

    if (!username) return res.status(401).json({ error: t('未登录') });

    const user = await db.getUser(username);
    if (!user) return res.status(401).json({ error: t('用户不存在') });

    if (user.twoFactorEnabled) return res.status(409).json({ error: t('双重认证已开启') });

    // 已保存的密钥只需密码确认即可恢复，不重新生成或要求重新扫描二维码。
    if (user.totpSecret && !user.twoFactorEnabled) {
        const check = await verifyPassword(password, user.password);
        if (!check.ok) {
            await logUserAction(username, '2fa_enable_failed', t('恢复双重认证失败：密码错误'), clientIp);
            return res.json({ success: false, error: t('密码错误') });
        }
        const newHash = await rehashIfNeeded(check);
        if (newHash) await db.updateUser(username, { password: newHash }).catch(() => {});

        await db.updateUser(username, { twoFactorEnabled: true });
        await logUserAction(username, '2fa_enabled', t('双重认证已恢复'), clientIp);
        return res.json({ success: true, restored: true });
    }

    if (!user.tempTotpSecret) {
        return res.status(400).json({ error: t('请先生成二维码') });
    }

    const verified = speakeasy.totp.verify({
        secret: user.tempTotpSecret.base32,
        encoding: 'base32',
        token: String(token || '').replace(/\s/g, ''),
        window: 1
    });

    if (!verified) return res.status(400).json({ error: t('验证码错误') });

    await db.updateUser(username, {
        twoFactorEnabled: true,
        totpSecret: user.tempTotpSecret,
        tempTotpSecret: null
    });

    await logUserAction(username, '2fa_enabled', t('双重认证已开启'), clientIp);
    res.json({ success: true });
});

// 暂时关闭 2FA：只切换启用状态，保留原 TOTP 配置。
app.post('/api/2fa/disable', twoFaSettingsRateLimit, async (req, res) => {
    const username = req.authUsername;
    const { password } = req.body || {};
    const clientIp = getClientIp(req);

    if (!username) return res.status(401).json({ error: t('未登录') });
    const user = await db.getUser(username);
    if (!user) return res.status(401).json({ error: t('用户不存在') });

    const check = await verifyPassword(password, user.password);
    if (!check.ok) {
        await logUserAction(username, '2fa_disable_failed', t('暂时关闭双重认证失败：密码错误'), clientIp);
        return res.json({ success: false, error: t('密码错误') });
    }
    const newHash = await rehashIfNeeded(check);
    if (newHash) await db.updateUser(username, { password: newHash }).catch(() => {});

    await db.updateUser(username, { twoFactorEnabled: false });
    await logUserAction(username, '2fa_disabled', t('双重认证已暂时关闭，原验证器配置已保留'), clientIp);
    res.json({ success: true });
});

// 处理修改密码请求
app.post('/change-password', twoFaSettingsRateLimit, async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    const { currentPassword, newPassword } = req.body;
    const clientIp = getClientIp(req);

    // 检查用户是否已登录
    if (!username) {
        return res.status(401).json({ success: false, message: t('用户未登录') });
    }
    const user = await db.getUser(username);
    if (!user) {
        return res.status(401).json({ success: false, message: t('用户不存在') });
    }

    const check = await verifyPassword(currentPassword, user.password);
    if (!check.ok) {
        await db.logUserAction(username, 'change_password_failed', t('当前密码错误'), clientIp);
        return res.status(400).json({ success: false, message: t('当前密码错误') });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 6 || Buffer.byteLength(newPassword, 'utf8') > 72) {
        return res.status(400).json({ success: false, message: t('新密码长度至少为6位') });
    }

    // 新密码统一 bcrypt 存储
    try {
        const hashedNewPassword = await hashPassword(newPassword);
        const updatedUsername = await db.updatePasswordAndRevokeCredentials(username, hashedNewPassword, {
            expectedPasswordHash: user.password
        });
        if (!updatedUsername) return res.status(409).json({ success: false, message: t('会话已过期，请重新登录') });

        await establishSession(res, username, SESSION_MAX_AGE_MS, {}, { ...user, password: hashedNewPassword });

        await db.logUserAction(username, 'change_password', t('密码修改成功'), clientIp);

        res.json({ success: true, message: t('密码修改成功') });
    } catch (error) {
        console.error(t('保存用户数据失败:'), error);
        await db.logUserAction(username, 'change_password_failed', t('保存用户数据失败'), clientIp);
        res.status(500).json({ success: false, message: t('保存密码失败，请稍后重试') });
    }
});

// 忘记密码：申请重置链接
app.get('/forgot-password', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.send(generateForgotPasswordHtml({ csrfToken: req.csrfToken }));
});

app.post('/forgot-password', forgotPasswordRateLimit, forgotPasswordEmailRateLimit, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const clientIp = getClientIp(req);

    // 无论邮箱是否存在都返回同一结果，避免账户枚举
    try {
        const user = email ? await db.getUserByEmailLower(email) : null;
        if (user && user.email) {
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
            await db.createPasswordResetToken({
                username: user.username,
                tokenHash: sha256(token),
                expiresAt,
                ipAddress: clientIp
            });

            const resetUrl = `${getCanonicalOAuthOrigin(req)}/reset-password?token=${token}`;
            const mailResult = await BPemail.SendEmail({
                to: user.email,
                subject: t('Bloret PassPort - 重置密码'),
                text: `${t('您正在重置 Bloret PassPort 账户的密码。请打开以下链接设置新密码：')}\n${resetUrl}\n\n${t('此链接将在30分钟后过期。如果您没有请求重置密码，请忽略此邮件。')}`,
                html: generatePasswordResetEmailHtml(resetUrl)
            });
            if (!mailResult || !mailResult.success) {
                console.error('password reset email failed:', mailResult && mailResult.error);
            } else {
                await logUserAction(user.username, 'password_reset_requested', t('请求重置密码'), clientIp);
            }
        }
    } catch (error) {
        console.error(t('发送重置密码邮件失败:'), error);
    }

    res.send(generateForgotPasswordHtml({ sent: true, email, csrfToken: req.csrfToken }));
});

// 重置密码：校验链接并展示表单
app.get('/reset-password', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!isValidPasswordResetToken(token)) {
        return res.status(400).send(generateResetPasswordHtml({ invalid: true, csrfToken: req.csrfToken }));
    }
    try {
        const record = await db.getPasswordResetToken(sha256(token));
        if (!record) {
            return res.status(400).send(generateResetPasswordHtml({ invalid: true, csrfToken: req.csrfToken }));
        }
        res.send(generateResetPasswordHtml({ token, csrfToken: req.csrfToken }));
    } catch (error) {
        console.error(t('读取重置令牌失败:'), error);
        res.status(500).send(generateResetPasswordHtml({
            invalid: true,
            error: t('服务器错误，请稍后重试。'),
            csrfToken: req.csrfToken
        }));
    }
});

// 重置密码：写入新密码并吊销旧会话
app.post('/reset-password', resetPasswordRateLimit, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = req.body && typeof req.body.token === 'string' ? req.body.token : '';
    const newPassword = req.body && typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    const confirmPassword = req.body && typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';
    const clientIp = getClientIp(req);

    if (!isValidPasswordResetToken(token)) {
        return res.status(400).send(generateResetPasswordHtml({ invalid: true, csrfToken: req.csrfToken }));
    }
    if (newPassword !== confirmPassword) {
        return res.status(400).send(generateResetPasswordHtml({
            token,
            error: t('两次输入的密码不一致'),
            csrfToken: req.csrfToken
        }));
    }
    if (!newPassword || newPassword.length < 6 || Buffer.byteLength(newPassword, 'utf8') > 72) {
        return res.status(400).send(generateResetPasswordHtml({
            token,
            error: t('新密码长度至少为6位'),
            csrfToken: req.csrfToken
        }));
    }

    let hashed;
    try {
        hashed = await hashPassword(newPassword);
    } catch (error) {
        console.error(t('重置密码哈希失败:'), error);
        return res.status(500).send(generateResetPasswordHtml({
            token,
            error: t('密码重置失败，请重新获取重置链接。'),
            csrfToken: req.csrfToken
        }));
    }

    try {
        // Consume the reset token, change the password and revoke credentials in one transaction.
        const username = await db.updatePasswordAndRevokeCredentials(null, hashed, { resetTokenHash: sha256(token) });
        if (!username) {
            return res.status(400).send(generateResetPasswordHtml({ invalid: true, csrfToken: req.csrfToken }));
        }

        await logUserAction(username, 'password_reset_completed', t('密码重置成功'), clientIp);
        res.send(generateResetPasswordSuccessHtml());
    } catch (error) {
        console.error(t('重置密码失败:'), error);
        res.status(500).send(generateResetPasswordHtml({
            invalid: true,
            error: t('密码重置失败，请重新获取重置链接。'),
            csrfToken: req.csrfToken
        }));
    }
});


// 处理管理员编辑用户信息
app.get('/edit/user/:username', async (req, res) => {
    const username = req.authUsername;
    if (!username) return res.redirect('/');

    const currentUser = await db.getUser(username);
    if (!currentUser || !currentUser.admin) return res.redirect('/');

    res.redirect('/management?edit=' + encodeURIComponent(req.params.username));
});

app.post('/edit/user/:username', async (req, res) => {
    const username = req.authUsername;
    if (!username) return res.status(403).send(t('无权操作'));

    const currentUser = await db.getUser(username);
    if (!currentUser || !currentUser.admin) return res.status(403).send(t('无权操作'));

    res.status(410).send(t('此编辑入口已停用，请返回用户管理页面重新操作'));
});

// 管理员群发邮件页面
app.get('/admin/email', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    if (!username) return res.redirect('/');
    
    const currentUser = await db.getUser(username);
    if (!currentUser || !currentUser.admin) return res.redirect('/');

    res.send(generateAdminEmailHtml(currentUser));
});

// 管理员发送邮件接口 (支持群发和指定收件人)
app.post('/api/admin/send-email', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    const clientIp = getClientIp(req);

    if (!username) return res.status(403).json({ success: false, message: t('无权操作') });
    
    const currentUser = await db.getUser(username);
    if (!currentUser || !currentUser.admin) {
        return res.status(403).json({ success: false, message: t('无权操作') });
    }

    const { subject, content, recipients } = req.body;
    if (!subject || !content) {
        return res.status(400).json({ success: false, message: t('标题和内容不能为空') });
    }

    let targetEmails = [];
    if (recipients && Array.isArray(recipients) && recipients.length > 0) {
        // 发送给指定用户
        for (const recipientUsername of recipients) {
             const u = await db.getUser(recipientUsername);
             if (u && u.email) targetEmails.push(u.email);
        }
    } else {
        // 如果没有指定收件人，则默认为广播给所有用户
        const allUsers = await db.getAllUsers();
        targetEmails = allUsers.filter(u => u.email).map(u => u.email);
    }

    // 去重
    targetEmails = [...new Set(targetEmails)];

    if (targetEmails.length === 0) {
        return res.json({ success: false, message: t('没有找到有效的收件人邮箱') });
    }

    // 异步发送邮件
    (async () => {
        try {
            console.log(`Starting email to ${targetEmails.length} users via BCC...`);
            const result = await BPemail.SendEmail({
                to: currentUser.email || 'admin@passport.bloret.net', // 主收件人
                bcc: targetEmails, // 密送给所有目标用户
                subject: subject,
                html: content,
                text: content.replace(/<[^>]+>/g, '')
            });

            if (result.success) {
                await logUserAction(currentUser.username, 'admin_send_email', `向 ${targetEmails.length} 位用户发送了邮件「${subject}」`, clientIp);
            } else {
                console.error(`Email send failed: ${result.error}`);
            }
        } catch (e) {
            console.error(`Email send error:`, e);
        }
    })();

    // 立即返回，告知任务已开始
    res.json({ success: true, message: t('邮件发送任务已提交，正在发送给 {count} 位用户...', { count: targetEmails.length }) });
});


// 处理更新用户头像请求
app.post('/api/user/update_avatar', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    const { avatarUrl } = req.body;
    const clientIp = getClientIp(req);

    if (!username) {
        return res.status(401).json({ success: false, message: t('用户未登录') });
    }
    
    const user = await db.getUser(username);
    if (!user) {
        return res.status(401).json({ success: false, message: t('用户不存在') });
    }

    if (typeof avatarUrl !== 'string' || avatarUrl.length > 2048 || !safeImageUrl(avatarUrl)) {
        return res.status(400).json({ success: false, message: t('缺少头像链接') });
    }

    try {
        await db.updateUser(username, { avatar: avatarUrl });
        await logUserAction(username, 'update_avatar', t('更新了头像'), clientIp);
        res.json({ success: true });
    } catch (error) {
        console.error(t('保存头像失败:'), error);
        res.status(500).json({ success: false, message: t('保存失败') });
    }
});

// 处理用户注册请求
app.get('/register/user', (req, res) => {
    res.send(generateUserRegisterHtml());
});

// 处理用户注册表单提交
app.post('/register/user', registerRateLimit, async (req, res) => {
    const { username, email, password, confirmPassword } = req.body;
    const nickname = (typeof req.body.nickname === 'string' ? req.body.nickname.trim() : '') || null;
    const clientIp = getClientIp(req);

    // 用户名格式：仅允许小写字母、数字、下划线（用户名是先例化的唯一键）
    if (!isValidUsername(username || '')) {
        await logUserAction(String(username || ''), 'register_failed', t('用户名仅允许小写字母、数字和下划线'), clientIp);
        res.send(generateUserRegisterHtml(t('用户名仅允许小写字母、数字和下划线')));
        return;
    }

    if (!isRegistrableUsername(username)) {
        await logUserAction(username, 'register_failed', t('用户名不能以 hermes_ 开头'), clientIp);
        res.send(generateUserRegisterHtml(t('用户名不能以 hermes_ 开头')));
        return;
    }

    // 检查用户是否已存在（包括已验证和待验证；忽略大小写）
    const existingUser = await db.getUserByLower(username);
    const verifyingUser = await db.getEmailVerifying(username);

    if (existingUser || verifyingUser) {
        // 用户已存在，重定向回注册页面
        await logUserAction(username, 'register_failed', t('用户名已存在'), clientIp);
        res.send(generateUserRegisterHtml(t('用户名已存在，请选择其他用户名')));
        return;
    }

    // 检查邮箱是否已被使用（包括已验证和待验证）
    const existingEmailUser = await db.getUserByEmail(email);
    const verifyingEmailUser = await db.getEmailVerifyingByEmail(email);

    if (existingEmailUser || verifyingEmailUser) {
        await logUserAction(username, 'register_failed', t('邮箱已被注册'), clientIp);
        res.send(generateUserRegisterHtml(t('该邮箱已被注册，请使用其他邮箱')));
        return;
    }

    // 检查密码是否匹配
    if (password !== confirmPassword) {
        // 密码不匹配，重定向回注册页面
        logUserAction(username, 'register_failed', t('两次密码不一致'), clientIp);
        res.send(generateUserRegisterHtml(t('两次输入的密码不一致')));
        return;
    }

    // 检查密码强度（至少6位）
    if (typeof password !== 'string' || password.length < 6 || Buffer.byteLength(password, 'utf8') > 72) {
        logUserAction(username, 'register_failed', t('密码长度不足'), clientIp);
        res.send(generateUserRegisterHtml(t('密码长度至少为6位')));
        return;
    }

    // 检查邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (typeof email !== 'string' || email.length > 254 || !emailRegex.test(email)) {
        logUserAction(username, 'register_failed', t('邮箱格式无效'), clientIp);
        res.send(generateUserRegisterHtml(t('请输入有效的邮箱地址')));
        return;
    }

    // 生成邮箱验证令牌
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');

    // 服务端 bcrypt 哈希后再进入待验证队列
    let hashed;
    try {
        hashed = await hashPassword(password);
    } catch (e) {
        console.error(t('注册密码哈希失败:'), e);
        return res.send(generateUserRegisterHtml(t('注册失败，请稍后重试')));
    }

    // 创建新用户（待验证状态）
    const newUser = {
        username: username,
        password: hashed,
        email: email,
        nickname: nickname || username,
        admin: false,
        createdAt: new Date().toISOString(),
        emailVerificationToken: emailVerificationToken,
        emailVerified: false
    };

    // 保存用户到数据库
    await db.saveEmailVerifying(username, newUser);

    // 发送验证邮件
    const verificationUrl = `https://passport.bloret.net/verify-email?token=${emailVerificationToken}&username=${username}`;
    const emailContent = `
    <!DOCTYPE html>
    <html lang="${htmlLang()}">
    <head>
        <link rel="icon" href="/BL.png" type="image/png">
        <link rel="apple-touch-icon" href="/BL.png">
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${t('Bloret PassPort - 邮箱验证')}</title>
        <style>
            .verification-button {
                display: inline-block;
                padding: 12px 24px;
                background-color: #0078d4;
                color: white !important;
                text-decoration: none;
                border-radius: 4px;
                font-weight: bold;
                margin: 16px 0;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            }
            .verification-button:hover {
                background-color: #106ebe;
            }
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                line-height: 1.6;
                color: #323130;
                max-width: 600px;
                margin: 0 auto;
                padding: 20px;
            }
            h2 {
                color: #0078d4;
            }
            .footer {
                margin-top: 30px;
                padding-top: 20px;
                border-top: 1px solid #e1e1e1;
                color: #605e5c;
                font-size: 14px;
            }
        </style>
    ${bloraAssetTags()}</head>
    <body class="blora-page blora-scope">
        <h2>${t('欢迎注册 Bloret PassPort！')}</h2>
        <p>${t('请点击下面的按钮完成邮箱验证：')}</p>
        <a href="${verificationUrl}" class="verification-button">${t('验证邮箱')}</a>
        <p>${t('如果按钮无法点击，也可以复制以下链接到浏览器地址栏：')}</p>
        <p><a href="${verificationUrl}">${verificationUrl}</a></p>
        <div class="footer">
            <p>${t('此链接将在24小时后过期。')}</p>
            <p>${t('如果您没有注册过 Bloret PassPort，请忽略此邮件。')}</p>
        </div>
    </body>
    </html>
  `;

    BPemail.SendEmail({
        to: email,
        subject: t('Bloret PassPort - 邮箱验证'),
        text: t('欢迎注册 Bloret PassPort！请点击链接完成邮箱验证：') + verificationUrl,
        html: emailContent
    })
        .then(async result => {
            if (result.success) {
                // 记录注册成功日志
                await logUserAction(username, 'register', t('注册成功，验证邮件已发送'), clientIp);

                res.send(`
          <!DOCTYPE html>
          <html lang="${htmlLang()}">
          <head>
              <link rel="icon" href="/BL.png" type="image/png">
              <link rel="apple-touch-icon" href="/BL.png">
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>${t('注册成功 - Bloret PassPort')}</title>
                            <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
              <style>
                  body.blora-page.register-success-page {
                      display: block;
                      width: 100%;
                      min-width: 0;
                  }
                  .register-success-page .center-container {
                      display: flex;
                      justify-content: center;
                      align-items: center;
                      width: 100%;
                      min-height: 100vh;
                      padding: 20px;
                      box-sizing: border-box;
                  }
                  .register-success-page .post.blora-card {
                      width: min(100%, 500px);
                      min-width: 0;
                      padding: 30px;
                      text-align: center;
                      overflow-wrap: anywhere;
                  }
                  .register-success-page .post.blora-card p {
                      line-height: 1.6;
                  }
                  .register-success-page .post.blora-card strong {
                      overflow-wrap: anywhere;
                  }
              </style>
          ${bloraAssetTags()}</head>
          <body class="blora-page blora-scope register-success-page">
              <div class="center-container">
                  <div class="post blora-card">
                      <h2>${t('注册成功！')}</h2>
                      <p>${t('我们已向您的邮箱')} <strong>${escapeHtml(email)}</strong> ${t('发送了验证邮件。')}</p>
                      <p>${t('请查收邮件并点击验证链接完成注册。')}</p>
                      <button type="button" class="blora-button" data-variant="primary" onclick="window.location.href='/'" >${t('返回首页')}</button>
                  </div>
              </div>
          </body>
          </html>
        `);
            } else {
                // 邮件发送失败，删除待验证用户
                await db.deleteEmailVerifying(username);
                res.send(generateUserRegisterHtml(t('邮件发送失败，请稍后重试')));
            }
        })
        .catch(async err => {
            console.error(t('发送验证邮件失败:'), err);
            // 邮件发送失败，删除待验证用户
            await db.deleteEmailVerifying(username);
            await logUserAction(username, 'register_failed', t('邮件发送失败'), clientIp);
            res.send(generateUserRegisterHtml(t('邮件发送失败，请稍后重试')));
        });
});

// 处理邮箱验证
app.get('/verify-email', async (req, res) => {
    const { token, username } = req.query;
    const clientIp = getClientIp(req);

    // 检查参数
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || typeof username !== 'string' || !isValidUsername(username)) {
        if (username) {
            await logUserAction(username, 'email_verification_failed', t('缺少验证参数'), clientIp);
        }
        return res.status(400).send(t('缺少必要的验证参数'));
    }

    // 查找待验证用户
    const verifyingUser = await db.getEmailVerifying(username);
    if (!verifyingUser) {
        await db.logUserAction(username, 'email_verification_failed', t('验证链接已过期或用户不存在'), clientIp);
        return res.status(404).send(t('验证链接已过期或用户不存在'));
    }

    // 验证令牌
    if (!safeEqualString(verifyingUser.emailVerificationToken, token) || !Number.isFinite(Date.parse(verifyingUser.createdAt)) || Date.now() - Date.parse(verifyingUser.createdAt) > 86400000) {
        await db.logUserAction(username, 'email_verification_failed', t('验证令牌无效'), clientIp);
        return res.status(400).send(t('验证令牌无效'));
    }

    // 验证成功，将用户转移到正式用户列表
    const newUser = {
        username: verifyingUser.username,
        password: verifyingUser.password,
        email: verifyingUser.email,
        nickname: verifyingUser.nickname || verifyingUser.username,
        admin: verifyingUser.admin,
        createdAt: verifyingUser.createdAt,
        emailVerified: true
    };

    // 添加到正式用户
    await db.createUser(newUser);

    // 从待验证列表中删除
    await db.deleteEmailVerifying(username);

    // 记录邮箱验证成功日志
    await db.logUserAction(username, 'email_verified', t('邮箱验证成功'), clientIp);

    // 发送验证成功页面
    res.send(`
    <!DOCTYPE html>
    <html lang="${htmlLang()}">
    <head>
        <link rel="icon" href="/BL.png" type="image/png">
        <link rel="apple-touch-icon" href="/BL.png">
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${t('验证成功 - Bloret PassPort')}</title>
                <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
        <style>
            .center-container {
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                padding: 20px;
            }
            .card {
                max-width: 500px;
                padding: 30px;
                text-align: center;
            }
        </style>
    ${bloraAssetTags()}</head>
    <body class="blora-page blora-scope">
        <div class="center-container">
            <div class="post blora-card">
                <h2>${t('邮箱验证成功！')}</h2>
                <p>${t('您的邮箱')} <strong>${escapeHtml(verifyingUser.email)}</strong> ${t('已成功验证。')}</p>
                <p>${t('现在您可以使用用户名')} <strong>${escapeHtml(username)}</strong> ${t('登录了。')}</p>
                <button type="button" class="blora-button" data-variant="primary" onclick="window.location.href='/'" >${t('立即登录')}</button>
            </div>
        </div>
    </body>
    </html>
  `);
});

const oauthTokenRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 60,
    keyFn: (req) => `oauth-token:${getClientIp(req)}`
});

function oauthParam(value) {
    return typeof value === 'string' ? value : '';
}

function oauthError(res, error, description, status = 400) {
    return res.status(status).json({ error, error_description: description });
}

function oauthRedirectError(res, redirectUri, state, error, description) {
    try {
        return res.redirect(appendOAuthCallbackParams(redirectUri, { error, error_description: description, state }));
    } catch (_) {
        return oauthError(res, error, description);
    }
}

const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600;
function oauthAccessTokenTtl(clientId) {
    return OAUTH_ACCESS_TOKEN_TTL_SECONDS;
}

function hashOAuthValue(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function calculatePkceChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function isValidPkceVerifier(verifier) {
    return typeof verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
}

function parseBearerToken(header) {
    const match = /^Bearer\s+([A-Za-z0-9._~+\/-]+={0,2})$/i.exec(String(header || ''));
    return match ? match[1] : null;
}

function generateOAuthUserCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let value = '';
    for (let i = 0; i < 8; i++) value += alphabet[crypto.randomInt(alphabet.length)];
    return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function getCanonicalOAuthOrigin(req) {
    const configured = config.publicOrigin || (config.oauth && config.oauth.issuer);
    if (typeof configured === 'string' && /^https:\/\/[^/?#]+$/i.test(configured.trim())) return configured.trim().replace(/\/$/, '');
    return 'https://passport.bloret.net';
}

function getOAuthScope(app, requested) {
    const permissions = sanitizeOAuthPermissions(app && app.permissions);
    const requestedScopes = oauthParam(requested).trim().split(/\s+/).filter(Boolean);
    if (requestedScopes.length === 0) return '';
    const uniqueScopes = [...new Set(requestedScopes)];
    if (uniqueScopes.some(scope => !permissions.includes(scope))) return null;
    return uniqueScopes.join(' ');
}

function isStandardOAuthRedirectAllowed(app, redirectUri) {
    const registered = getOAuthRedirectUris(app).filter(uri => typeof uri === 'string' && uri.trim());
    if (!isSafeOAuthCallback(redirectUri)) return false;
    return registered.some(uri => {
        const registeredUri = uri.trim();
        if (registeredUri === redirectUri) return true;
        try {
            const callback = new URL(redirectUri);
            const allowed = new URL(registeredUri);
            if (allowed.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(allowed.hostname)) return false;
            if (callback.username || callback.password || callback.hash || allowed.username || allowed.password || allowed.hash) return false;
            callback.port = '';
            allowed.port = '';
            return callback.toString() === allowed.toString();
        } catch {
            return false;
        }
    });
}

function generateStandardOAuthPage(appInfo, params) {
    const appName = escapeHtml(appInfo.name || '应用');
    const appDescription = escapeHtml(appInfo.description || '此应用希望访问您的账户信息');
    const permissions = String(params.scope || '').split(/\s+/).filter(Boolean);
    const scopeLabels = {
        'user:name': ['访问您的用户名', 'person.fill'],
        'user:head': ['访问您的头像', 'person.crop.circle'],
        'minecraft:accounts': ['读取 Minecraft 档案及游戏登录凭据（用于启动游戏）', 'gamecontroller.fill'],
        'user:email': ['访问您的邮箱', 'envelope.fill'],
        'user:admin': ['访问您的管理员权限', 'shield.fill'],
        'user:tags': ['访问您的用户标签', 'tag.fill'],
        'user:password': ['访问您的密码', 'lock.fill'],
        'app:usertoken': ['生成长期用户令牌 (仅此应用可用)', 'ticket.fill'],
        'ai:use': ['使用您的 AI 调用额度', 'sparkles'],
        'bbbs:session': ['以您的身份登录 BBBS 论坛', 'globe']
    };
    const permissionItems = permissions.length
        ? permissions.map(scope => {
            const [label, icon] = scopeLabels[scope] || [scope, 'lock.fill'];
            return `<li class="permission-item"><span class="permission-icon"><img src="https://img.bloret.net/SF/${icon}?color=242424" alt=""></span><span class="permission-text">${escapeHtml(label)}</span></li>`;
        }).join('')
        : '<li class="permission-item"><span class="permission-text">无额外权限</span></li>';
    const appIcon = appInfo.icon ? `<img src="${escapeHtml(appInfo.icon)}" alt="">` : appName.charAt(0);
    const userPreview = `<div class="standard-oauth-user"><span>当前登录：</span><strong>${escapeHtml(params.username || '')}</strong></div>`;
    return `<!doctype html>
<html lang="${htmlLang()}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Bloret PassPort - 授权</title>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
    <style>
        body { margin: 0; font-family: var(--font-family); background: var(--blora-color-surface-canvas); color: var(--blora-color-text-primary); display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        .auth-card { background: var(--blora-color-surface-default); border: 1px solid var(--blora-color-border-subtle); border-radius: 12px; box-shadow: var(--blora-shadow-1); width: calc(100% - 32px); max-width: 440px; padding: 32px; box-sizing: border-box; }
        .auth-brand { color: var(--blora-color-text-primary); margin: 0 0 24px; display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; }
        .app-header { display: flex; align-items: center; margin-bottom: 24px; }
        .app-icon { width: 64px; height: 64px; flex: 0 0 64px; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: 12px; background: var(--blora-color-surface-raised); color: var(--blora-color-text-primary); font-size: 28px; font-weight: 600; margin-right: 16px; box-shadow: var(--blora-shadow-1); }
        .app-icon img { width: 64px; height: 64px; max-width: none; object-fit: cover; }
        .app-info { min-width: 0; flex: 1; }
        .app-info h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
        .app-info p { margin: 0; color: var(--blora-color-text-secondary); font-size: 14px; line-height: 1.4; }
        .official-badge { display: inline-flex; padding: 2px 8px; border-radius: 4px; background: var(--blora-color-action-primary-tint); color: var(--blora-color-action-primary-default); font-size: 11px; vertical-align: middle; }
        .permissions-section { margin-bottom: 24px; }
        .section-label { display: block; margin-bottom: 12px; font-size: 14px; font-weight: 600; }
        .permission-list { list-style: none; padding: 0; margin: 0; }
        .permission-item { display: flex; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--blora-color-border-subtle); font-size: 14px; line-height: 20px; }
        .permission-item:last-child { border-bottom: 0; }
        .permission-icon { width: 24px; height: 24px; flex: 0 0 24px; display: flex; align-items: center; justify-content: center; margin-right: 12px; }
        .permission-icon img { width: 20px; height: 20px; }
        .permission-text { flex: 1; }
        .standard-oauth-user { display: flex; align-items: center; gap: 8px; padding: 12px; margin-bottom: 24px; border: 1px solid var(--blora-color-border-subtle); border-radius: 8px; background: var(--blora-color-surface-raised); font-size: 13px; }
        .standard-oauth-user strong { font-size: 14px; }
        .action-group { display: flex; gap: 12px; }
        .action-group button { flex: 1; }
        @media (max-width: 480px) { body { align-items: flex-start; background: var(--blora-color-surface-default); } .auth-card { width: 100%; box-shadow: none; border: 0; padding: 20px; } }
    </style>
    ${bloraAssetTags()}
</head>
<body class="blora-page blora-scope">
    <main class="auth-card">
        <h2 class="auth-brand"><img src="/BL.png" width="24" height="24" alt="" style="border-radius: 6px;">Bloret PassPort</h2>
        <div class="app-header">
            <div class="app-icon">${appIcon}</div>
            <div class="app-info"><h1>${appName}${appInfo.official ? '<span class="official-badge">官方</span>' : ''}</h1><p>${appDescription}</p></div>
        </div>
        <div class="permissions-section"><span class="section-label">请求权限</span><ul class="permission-list">${permissionItems}</ul></div>
        ${userPreview}
        <form method="post" action="/oauth/authorize/consent">
            <input type="hidden" name="transaction_id" value="${escapeHtml(params.transactionId)}">
            <div class="action-group">
                <button class="blora-button" data-variant="outline" type="submit" name="decision" value="deny">拒绝</button>
                <button class="blora-button" data-variant="primary" type="submit" name="decision" value="allow">授权</button>
            </div>
        </form>
    </main>
</body>
</html>`;
}

function generateDeviceAuthorizationPage(appInfo, userCode, scope) {
    const appName = escapeHtml(appInfo.name || '应用');
    const description = escapeHtml(appInfo.description || '此应用希望访问您的账户信息');
    const safeUserCode = escapeHtml(userCode);
    const permissions = String(scope || '').split(/\s+/).filter(Boolean);
    const scopeLabels = {
        'user:name': ['访问您的用户名', 'person.fill'],
        'user:head': ['访问您的头像', 'person.crop.circle'],
        'minecraft:accounts': ['读取 Minecraft 档案及游戏登录凭据（用于启动游戏）', 'gamecontroller.fill'],
        'user:email': ['访问您的邮箱', 'envelope.fill'],
        'user:admin': ['访问您的管理员权限', 'shield.fill'],
        'user:tags': ['访问您的用户标签', 'tag.fill'],
        'user:password': ['访问您的密码', 'lock.fill'],
        'app:usertoken': ['生成长期用户令牌 (仅此应用可用)', 'ticket.fill'],
        'ai:use': ['使用您的 AI 调用额度', 'sparkles'],
        'bbbs:session': ['以您的身份登录 BBBS 论坛', 'globe']
    };
    const permissionItems = permissions.length
        ? permissions.map(permission => {
            const [label, icon] = scopeLabels[permission] || [permission, 'lock.fill'];
            return `<li class="permission-item"><span class="permission-icon"><img src="https://img.bloret.net/SF/${icon}?color=242424" alt=""></span><span class="permission-text">${escapeHtml(label)}</span></li>`;
        }).join('')
        : '<li class="permission-item"><span class="permission-text">无额外权限</span></li>';
    const appIcon = appInfo.icon ? `<img src="${escapeHtml(appInfo.icon)}" alt="">` : appName.charAt(0);
    const form = `
        <form method="post" action="/oauth/device/authorize">
            <input type="hidden" name="user_code" value="${safeUserCode}">
            <div class="action-group">
                <button class="blora-button" data-variant="outline" type="submit" name="decision" value="deny">拒绝</button>
                <button class="blora-button" data-variant="primary" type="submit" name="decision" value="allow">授权</button>
            </div>
        </form>`;
    return `<!doctype html>
<html lang="${htmlLang()}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Bloret PassPort - 设备授权</title>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
    <style>
        body { margin: 0; font-family: var(--font-family); background: var(--blora-color-surface-canvas); color: var(--blora-color-text-primary); display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        .auth-card { background: var(--blora-color-surface-default); border: 1px solid var(--blora-color-border-subtle); border-radius: 12px; box-shadow: var(--blora-shadow-1); width: calc(100% - 32px); max-width: 440px; padding: 32px; box-sizing: border-box; }
        .auth-brand { color: var(--blora-color-text-primary); margin: 0 0 24px; display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 600; }
        .app-header { display: flex; align-items: center; margin-bottom: 24px; }
        .app-icon { width: 64px; height: 64px; flex: 0 0 64px; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: 12px; background: var(--blora-color-surface-raised); color: var(--blora-color-text-primary); font-size: 28px; font-weight: 600; margin-right: 16px; box-shadow: var(--blora-shadow-1); }
        .app-icon img { width: 64px; height: 64px; max-width: none; object-fit: cover; }
        .app-info { min-width: 0; flex: 1; }
        .app-info h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; }
        .app-info p { margin: 0; color: var(--blora-color-text-secondary); font-size: 14px; line-height: 1.4; }
        .official-badge { display: inline-flex; padding: 2px 8px; border-radius: 4px; background: var(--blora-color-action-primary-tint); color: var(--blora-color-action-primary-default); font-size: 11px; vertical-align: middle; }
        .permissions-section { margin-bottom: 24px; }
        .section-label { display: block; margin-bottom: 12px; font-size: 14px; font-weight: 600; }
        .permission-list { list-style: none; padding: 0; margin: 0; }
        .permission-item { display: flex; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--blora-color-border-subtle); font-size: 14px; line-height: 20px; }
        .permission-item:last-child { border-bottom: 0; }
        .permission-icon { width: 24px; height: 24px; flex: 0 0 24px; display: flex; align-items: center; justify-content: center; margin-right: 12px; }
        .permission-icon img { width: 20px; height: 20px; }
        .permission-text { flex: 1; }
        .device-authorization-code { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; margin: -8px 0 24px; border: 1px solid var(--blora-color-border-subtle); border-radius: 8px; background: var(--blora-color-surface-raised); }
        .device-authorization-code strong { font-family: var(--blora-font-mono); font-size: 18px; letter-spacing: .12em; }
        .action-group { display: flex; gap: 12px; }
        .action-group button { flex: 1; }
        @media (max-width: 480px) { body { align-items: flex-start; background: var(--blora-color-surface-default); } .auth-card { width: 100%; box-shadow: none; border: 0; padding: 20px; } }
    </style>
    ${bloraAssetTags()}
</head>
<body class="blora-page blora-scope">
    <main class="auth-card">
        <h2 class="auth-brand"><img src="/BL.png" width="24" height="24" alt="" style="border-radius: 6px;">Bloret PassPort</h2>
        <div class="app-header">
            <div class="app-icon">${appIcon}</div>
            <div class="app-info"><h1>${appName}${appInfo.official ? '<span class="official-badge">官方</span>' : ''}</h1><p>${description}</p></div>
        </div>
        <div class="device-authorization-code"><span>用户码</span><strong>${safeUserCode}</strong></div>
        <div class="permissions-section"><span class="section-label">请求权限</span><ul class="permission-list">${permissionItems}</ul></div>
        ${form}
    </main>
</body>
</html>`;
}

function generateDeviceCodeEntryPage(userCode = '', error = '') {
    return `<!doctype html>
<html lang="${htmlLang()}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>设备授权 - Bloret PassPort</title>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="stylesheet" href="/index.css">
    ${bloraAssetTags()}
    <style>
        .device-entry-page { width: 100%; min-width: 0; display: grid; place-items: center; min-height: 100vh; min-height: 100svh; padding: 24px 16px; box-sizing: border-box; }
        .device-entry-card { width: 100%; max-width: 440px; padding: 32px; box-sizing: border-box; }
        .device-entry-brand { display: flex; align-items: center; gap: 10px; font-weight: 600; margin-bottom: 24px; }
        .device-entry-card h1 { font-size: 24px; margin: 0 0 12px; }
        .device-entry-card p { color: var(--blora-color-text-secondary); line-height: 1.6; }
        .device-entry-card label { display: block; margin: 24px 0 8px; }
        .device-entry-card input { width: 100%; box-sizing: border-box; }
        .device-entry-card button { width: 100%; margin-top: 20px; }
        .device-entry-error { color: var(--blora-color-text-primary); margin-top: 16px; }
        @media (max-width: 480px) { .device-entry-card { padding: 24px 20px; } }
    </style>
</head>
<body class="blora-page blora-scope">
    <main class="device-entry-page">
        <section class="blora-card device-entry-card" aria-labelledby="device-entry-title">
            <div class="device-entry-brand"><img src="/BL.png" width="24" height="24" alt="">Bloret PassPort</div>
            <h1 id="device-entry-title">连接您的设备</h1>
            <p>请输入发起登录的设备上显示的用户码，继续查看应用及其请求的权限。</p>
            ${error ? `<div id="device-code-error" class="device-entry-error" role="alert">${escapeHtml(error)}</div>` : ''}
            <form method="get" action="/oauth/device">
                <label for="device-user-code">用户码</label>
                <input class="blora-input" id="device-user-code" name="user_code" value="${escapeHtml(userCode)}" placeholder="ABCD-EFGH" autocomplete="off" autocapitalize="characters" spellcheck="false" required ${error ? 'aria-invalid="true" aria-describedby="device-code-error"' : ''}>
                <button class="blora-button" data-variant="primary" type="submit">继续</button>
            </form>
            <p>用户码有效期为 10 分钟。若已过期，请在设备上重新发起登录。</p>
        </section>
    </main>
</body>
</html>`;
}

function generateDeviceAuthorizationResultPage(decision, userCode) {
    const approved = decision === 'allow';
    const title = approved ? '授权成功' : '已拒绝授权';
    const description = approved
        ? '设备已获得授权，请返回发起请求的设备继续操作。'
        : '您已拒绝此次请求，设备未获得访问您账户的权限。';
    return `<!doctype html>
<html lang="${htmlLang()}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} - Bloret PassPort</title>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <link rel="stylesheet" href="/index.css">
    ${bloraAssetTags()}
    <style>
        .device-result-page { width: 100%; display: grid; place-items: center; min-height: 100vh; min-height: 100svh; padding: 32px 16px; box-sizing: border-box; }
        .device-result-card { width: 100%; max-width: 480px; padding: 32px; box-sizing: border-box; }
        .device-result-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; font-size: 16px; font-weight: 600; }
        .device-result-brand img { border-radius: 6px; }
        .device-result-code { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 16px; margin-block: 24px; border: 1px solid var(--blora-color-border-subtle); border-radius: 8px; background: var(--blora-color-surface-raised); }
        .device-result-code span { color: var(--blora-color-text-secondary); font-size: 14px; }
        .device-result-code strong { font-family: var(--blora-font-mono); letter-spacing: .12em; overflow-wrap: anywhere; }
        .device-result-actions { display: flex; justify-content: center; margin-top: 24px; }
        .device-result-footer { margin: 16px 0 0; text-align: center; color: var(--blora-color-text-secondary); font-size: 13px; }
        @media (max-width: 480px) { .device-result-page { padding: 20px 16px; } .device-result-card { padding: 24px 20px; } .device-result-actions .blora-button { width: 100%; } }
    </style>
</head>
<body class="blora-page blora-scope">
    <main class="device-result-page">
        <section class="blora-card device-result-card" aria-label="设备授权结果">
            <div class="device-result-brand"><img src="/BL.png" width="24" height="24" alt="">Bloret PassPort</div>
            <blora-result variant="${approved ? 'success' : 'info'}" title="${title}" description="${description}"></blora-result>
            <div class="device-result-code"><span>用户码</span><strong>${escapeHtml(userCode)}</strong></div>
            <blora-alert variant="info" title="${approved ? '下一步' : '重新授权'}" description="${approved ? '可以关闭此页面，设备将自动继续登录。' : '如需继续登录，请在设备上重新发起授权请求。'}"></blora-alert>
            <div class="device-result-actions"><a href="/" class="blora-button" data-variant="primary">返回首页</a></div>
            <p class="device-result-footer">由 Bloret PassPort 安全连接您的账户与设备</p>
        </section>
    </main>
</body>
</html>`;
}

app.get('/.well-known/oauth-authorization-server', (req, res) => {
    res.json({
        issuer: getCanonicalOAuthOrigin(req),
        authorization_endpoint: `${getCanonicalOAuthOrigin(req)}/oauth/authorize`,
        token_endpoint: `${getCanonicalOAuthOrigin(req)}/oauth/token`,
        device_authorization_endpoint: `${getCanonicalOAuthOrigin(req)}/oauth/device/code`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'],
        code_challenge_methods_supported: ['S256']
    });
});

app.get('/oauth/authorize', async (req, res) => {
    const responseType = oauthParam(req.query.response_type);
    const clientId = oauthParam(req.query.client_id);
    const redirectUri = oauthParam(req.query.redirect_uri);
    const state = req.query.state == null ? undefined : oauthParam(req.query.state);
    if (responseType !== 'code' || !clientId || !redirectUri || !oauthParam(req.query.code_challenge) || oauthParam(req.query.code_challenge_method) !== 'S256') {
        return oauthError(res, 'invalid_request', 'response_type, client_id, redirect_uri, code_challenge and S256 code_challenge_method are required');
    }
    const appInfo = await db.getOAuthApp(clientId);
    if (!appInfo) return oauthError(res, 'invalid_client', 'Unknown client', 401);
    if (!isStandardOAuthRedirectAllowed(appInfo, redirectUri)) return oauthError(res, 'invalid_request', 'Invalid redirect_uri');
    const scope = getOAuthScope(appInfo, req.query.scope);
    if (scope === null) return oauthRedirectError(res, redirectUri, state, 'invalid_scope', 'Requested scope is not allowed');
    const challenge = oauthParam(req.query.code_challenge);
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return oauthRedirectError(res, redirectUri, state, 'invalid_request', 'Invalid code_challenge');
    if (!req.authUsername) {
        const currentUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        return res.redirect(`/?redirect_uri=${encodeURIComponent(currentUrl)}`);
    }
    const user = await db.getUser(req.authUsername);
    if (!user) return res.redirect(`/?redirect_uri=${encodeURIComponent(`${req.protocol}://${req.get('host')}${req.originalUrl}`)}`);
    const transactionId = crypto.randomBytes(32).toString('base64url');
    await db.createOAuthAuthorizationTransaction({
        transactionHash: hashOAuthValue(transactionId), clientId, username: user.username,
        sessionToken: req.sessionToken, redirectUri, scope, state,
        codeChallenge: challenge, codeChallengeMethod: 'S256', ttlSeconds: 300
    });
    return res.send(generateStandardOAuthPage(appInfo, { username: user.username, transactionId, scope }));
});

function escapeOAuthHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function generateProtocolCallbackPage(callbackUrl, appName) {
    const safeName = escapeOAuthHtml(appName || '应用');
    const href = escapeOAuthHtml(callbackUrl);
    const jsUrl = JSON.stringify(callbackUrl).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>授权完成 - Bloret PassPort</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f5f5f7; color: #1d1d1f; }
  main { width: min(440px, calc(100% - 40px)); background: #fff; border-radius: 16px; padding: 32px; box-sizing: border-box; text-align: center; box-shadow: 0 12px 40px rgba(0,0,0,.08); }
  .icon { width: 56px; height: 56px; margin: 0 auto 18px; border-radius: 50%; background: #e8f5e9; color: #1b8a3a; font-size: 32px; line-height: 56px; }
  h1 { margin: 0 0 12px; font-size: 22px; }
  p { margin: 0 0 20px; color: #6e6e73; line-height: 1.6; font-size: 14px; }
  .button { display: inline-block; padding: 12px 22px; border-radius: 10px; background: #605ed2; color: #fff; text-decoration: none; font-weight: 600; }
  .hint { margin-top: 18px; margin-bottom: 0; font-size: 12px; color: #8e8e93; }
</style>
</head>
<body>
<main>
  <div class="icon">✓</div>
  <h1>授权完成</h1>
  <p>即将返回 ${safeName}。如果没有自动打开，请点击下面的按钮。</p>
  <a class="button" href="${href}" rel="noopener">打开 ${safeName}</a>
  <p class="hint">如果按钮无效，请确认 ${safeName} 已安装，并允许浏览器打开应用链接。</p>
</main>
<script>
setTimeout(function () {
  try { window.location.href = ${jsUrl}; } catch (error) {}
}, 250);
</script>
</body>
</html>`;
}

app.post('/oauth/authorize/consent', async (req, res) => {
    const transactionId = oauthParam(req.body && req.body.transaction_id);
    const decision = oauthParam(req.body && req.body.decision);
    if (!transactionId || !req.authUsername || !req.sessionToken || !['allow', 'deny'].includes(decision)) return oauthError(res, 'invalid_request', 'Invalid authorization transaction');
    const transaction = await db.consumeOAuthAuthorizationTransaction(hashOAuthValue(transactionId), req.authUsername, req.sessionToken);
    if (!transaction) return oauthError(res, 'invalid_request', 'Invalid or expired authorization transaction');
    const appInfo = await db.getOAuthApp(transaction.client_id);
    if (!appInfo || !isStandardOAuthRedirectAllowed(appInfo, transaction.redirect_uri)) return oauthError(res, 'invalid_request', 'Invalid authorization transaction');
    if (decision !== 'allow') return oauthRedirectError(res, transaction.redirect_uri, transaction.state, 'access_denied', 'The resource owner denied the request');
    const code = crypto.randomBytes(32).toString('base64url');
    await db.createOAuthAuthorizationCode({ codeHash: hashOAuthValue(code), clientId: transaction.client_id, username: transaction.username, redirectUri: transaction.redirect_uri, scope: transaction.scope, codeChallenge: transaction.code_challenge, codeChallengeMethod: transaction.code_challenge_method, sessionToken: req.sessionToken, ttlSeconds: 300 });
    const callbackUrl = appendOAuthCallbackParams(transaction.redirect_uri, { code, state: transaction.state });
    if (!/^https?:/i.test(transaction.redirect_uri)) {
        res.set('Cache-Control', 'no-store');
        return res.send(generateProtocolCallbackPage(callbackUrl, appInfo.name));
    }
    return res.redirect(callbackUrl);
});

app.post('/oauth/device/code', oauthTokenRateLimit, async (req, res) => {
    const p = req.body || {};
    const clientId = oauthParam(p.client_id);
    const appInfo = clientId ? await db.getOAuthApp(clientId) : null;
    if (!clientId) return oauthError(res, 'invalid_request', 'client_id is required');
    if (!appInfo) return oauthError(res, 'invalid_client', 'Unknown client', 401);
    const scope = getOAuthScope(appInfo, p.scope);
    if (scope === null) return oauthError(res, 'invalid_scope', 'Requested scope is not allowed');
    const deviceCode = crypto.randomBytes(32).toString('base64url');
    let userCode = generateOAuthUserCode();
    for (let attempt = 0; attempt < 5; attempt++) {
        if (!(await db.getOAuthDeviceCodeByUserCode(userCode))) break;
        userCode = generateOAuthUserCode();
    }
    await db.createOAuthDeviceCode({
        deviceCodeHash: hashOAuthValue(deviceCode), userCode, clientId, scope,
        ttlSeconds: 600, intervalSeconds: 5
    });
    const verificationUri = `${getCanonicalOAuthOrigin(req)}/oauth/device`;
    return res.status(200).json({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
        expires_in: 600,
        interval: 5
    });
});

app.get(['/oauth/device', '/oauth/device/authorize'], async (req, res) => {
    const userCode = oauthParam(req.query.user_code).toUpperCase();
    if (!userCode) return res.send(generateDeviceCodeEntryPage());
    const device = await db.getOAuthDeviceCodeByUserCode(userCode);
    if (!device || device.status !== 'pending') return res.status(400).send(generateDeviceCodeEntryPage(userCode, '用户码无效、已过期或已使用。请在设备上重新发起登录，输入新的用户码。'));
    if (!req.authUsername) {
        const currentUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        return res.redirect(`/?redirect_uri=${encodeURIComponent(currentUrl)}`);
    }
    const appInfo = await db.getOAuthApp(device.client_id);
    if (!appInfo) return res.status(400).send('应用不存在');
    return res.send(generateDeviceAuthorizationPage(appInfo, userCode, device.scope));
});

app.post('/oauth/device/authorize', async (req, res) => {
    const userCode = oauthParam(req.body && req.body.user_code).toUpperCase();
    const decision = oauthParam(req.body && req.body.decision);
    if (!userCode || !req.authUsername || !['allow', 'deny'].includes(decision)) return oauthError(res, 'invalid_request', 'Invalid device authorization request');
    const device = await db.getOAuthDeviceCodeByUserCode(userCode);
    if (!device || device.status !== 'pending') return oauthError(res, 'invalid_request', 'Invalid or expired user code');
    const authorized = await db.authorizeOAuthDeviceCode(userCode, req.authUsername, decision === 'allow' ? 'approved' : 'denied');
    if (!authorized) return oauthError(res, 'invalid_request', 'Invalid or expired user code');
    return res.send(generateDeviceAuthorizationResultPage(decision, userCode));
});

app.post('/oauth/token', oauthTokenRateLimit, async (req, res) => {
    const p = req.body || {};
    const grantType = oauthParam(p.grant_type);
    const clientId = oauthParam(p.client_id);
    if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
        const deviceCode = oauthParam(p.device_code);
        if (!clientId || !deviceCode) return oauthError(res, 'invalid_request', 'client_id and device_code are required');
        const appInfo = await db.getOAuthApp(clientId);
        if (!appInfo) return oauthError(res, 'invalid_client', 'Unknown client', 401);
        const device = await db.getOAuthDeviceCode(hashOAuthValue(deviceCode));
        if (!device || device.client_id !== clientId) return oauthError(res, 'expired_token', 'The device code has expired');
        if (device.last_polled_at) {
            const elapsed = Date.now() - new Date(device.last_polled_at).getTime();
            if (elapsed < (device.interval_seconds || 5) * 1000) {
                return oauthError(res, 'slow_down', 'Polling too frequently');
            }
        }
        await db.markOAuthDeviceCodePolled(hashOAuthValue(deviceCode));
        if (device.status === 'pending') return oauthError(res, 'authorization_pending', 'The user has not completed authorization');
        if (device.status === 'denied') return oauthError(res, 'access_denied', 'The user denied the request');
        if (device.status !== 'approved' || !device.username) return oauthError(res, 'invalid_grant', 'Invalid device authorization');
        const accessToken = crypto.randomBytes(32).toString('base64url');
        const consumed = await db.exchangeOAuthGrant({ grantType: 'device_code', grantHash: hashOAuthValue(deviceCode), clientId, tokenHash: hashOAuthValue(accessToken), ttlSeconds: oauthAccessTokenTtl(clientId) });
        if (!consumed) return oauthError(res, 'invalid_grant', 'The device code has already been used');
        return res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: oauthAccessTokenTtl(clientId), scope: consumed.scope });
    }
    const code = oauthParam(p.code);
    const redirectUri = oauthParam(p.redirect_uri);
    const verifier = oauthParam(p.code_verifier);
    if (grantType !== 'authorization_code') return oauthError(res, grantType ? 'unsupported_grant_type' : 'invalid_request', 'grant_type must be authorization_code');
    if (!clientId || !code || !redirectUri || !verifier) return oauthError(res, 'invalid_request', 'Missing required parameter');
    const appInfo = await db.getOAuthApp(clientId);
    if (!appInfo) return oauthError(res, 'invalid_client', 'Unknown client', 401);
    const basic = String(req.headers.authorization || '');
    const basicSecret = basic.startsWith('Basic ') ? Buffer.from(basic.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
    const suppliedSecret = p.client_secret || basicSecret;
    if (suppliedSecret && !safeEqualString(String(appInfo.app_secret || ''), String(suppliedSecret))) return oauthError(res, 'invalid_client', 'Client authentication failed', 401);
    if (!isValidPkceVerifier(verifier)) return oauthError(res, 'invalid_grant', 'Invalid code_verifier');
    const authorization = await db.getOAuthAuthorizationCode(hashOAuthValue(code), clientId);
    if (!authorization) return oauthError(res, 'invalid_grant', 'Invalid or expired authorization code');
    if (authorization.redirect_uri !== redirectUri) return oauthError(res, 'invalid_grant', 'redirect_uri does not match');
    const expected = calculatePkceChallenge(verifier);
    if (!safeEqualString(expected, authorization.code_challenge)) return oauthError(res, 'invalid_grant', 'Invalid code_verifier');
    const accessToken = crypto.randomBytes(32).toString('base64url');
    const consumed = await db.exchangeOAuthGrant({ grantType: 'authorization_code', grantHash: hashOAuthValue(code), clientId, redirectUri, codeChallenge: expected, tokenHash: hashOAuthValue(accessToken), ttlSeconds: oauthAccessTokenTtl(clientId) });
    if (!consumed) return oauthError(res, 'invalid_grant', 'Invalid or expired authorization code');
    return res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: oauthAccessTokenTtl(clientId), scope: authorization.scope });
});

app.get('/oauth/userinfo', async (req, res) => {
    const bearerToken = parseBearerToken(req.headers.authorization);
    if (!bearerToken) return oauthError(res, 'invalid_token', 'Bearer token required', 401);
    const token = await db.getOAuthAccessToken(hashOAuthValue(bearerToken));
    if (!token) return oauthError(res, 'invalid_token', 'Invalid or expired access token', 401);
    const user = await db.getUser(token.username);
    if (!user) return oauthError(res, 'invalid_token', 'User no longer exists', 401);
    const scopes = token.scope.split(/\s+/).filter(Boolean);
    const userInfo = buildScopedUserInfo(user, scopes);
    if (scopes.includes('bbbs:session')) {
        try {
            const bbbsResponse = await axios.post(
                `${config.BBBS.url}/api/passport/session`,
                { user: user.username, secret: config.BBBS.PassPortSecret },
                { timeout: 10000, maxRedirects: 0, maxContentLength: 1024 * 1024 }
            );
            if (bbbsResponse.data && bbbsResponse.data.success) {
                userInfo.bbbs_session = bbbsResponse.data.session;
                userInfo['bbbs_session.sig'] = bbbsResponse.data['session.sig'];
                userInfo.bbbs_csrf_token = bbbsResponse.data.csrf_token || '';
            }
        } catch (error) {
            console.error('BBBS session request failed:', error.message);
        }
    }
    return res.json(userInfo);
});

const legacyConsentSecret = crypto.randomBytes(32);
function legacyConsentSignature(oauthApp, username, sessionToken, redirectUri) {
    return crypto.createHmac('sha256', legacyConsentSecret).update(JSON.stringify([
        oauthApp.id, oauthApp.app_secret, oauthApp.permissions, oauthApp.redirect_uri,
        username, sessionToken, redirectUri
    ])).digest('hex');
}

// OAuth 授权页面
app.get('/app/oauth', async (req, res) => {
    const { app_id } = req.query;
    const redirect_uri = normalizeOAuthRedirectUri(req.query.redirect_uri);
    const clientIp = getClientIp(req);

    // 检查用户是否已登录
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;

    // 如果用户未登录，跳转到主页并附带当前地址作为redirect_uri参数
    if (!username) {
        const currentUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        return res.redirect(`/?redirect_uri=${encodeURIComponent(currentUrl)}`);
    }

    const user = await db.getUser(username);
    if (!user) {
        const currentUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        return res.redirect(`/?redirect_uri=${encodeURIComponent(currentUrl)}`);
    }

    // 检查参数是否存在
    if (!app_id || !redirect_uri) {
        return res.status(400).send(t('缺少必要的参数'));
    }

    // 查找应用信息
    const oauthApp = await db.getOAuthApp(app_id);
    if (!oauthApp) {
        return res.status(404).send(t('应用不存在'));
    }

    // 检查 redirect_uri 是否存在于应用的 redirect_uri 列表中
    if (!isOAuthRedirectAllowed(oauthApp, redirect_uri)) {
        return res.status(400).send(t('无效的 redirect_uri'));
    }

    // 检查是否存在有效的自动授权记录
    try {
        const autoAuth = await db.getAutoAuth(username, app_id, clientIp);
        if (autoAuth) {
            // 自动授权记录存在且未过期，直接进行授权
            const code = generateCode();
            await db.saveAuthorization(code, {
                app_id: app_id,
                username: username,
                ip_address: clientIp,
                redirect_uri: redirect_uri,
                scope: (oauthApp.permissions || []).join(' '),
                auto_auth: true,
                created_at: new Date().toISOString()
            });
            
            // 记录自动授权日志
            await db.logUserAction(username, 'oauth_auto_authorize', `自动授权应用: ${app_id}`, clientIp);
            
            try {
                return res.redirect(appendOAuthCallbackParams(redirect_uri, { code }));
            } catch (redirectErr) {
                return res.status(400).send(t('无效的 redirect_uri'));
            }
        }
    } catch (e) {
        console.error(t('检查自动授权时发生错误:'), e);
    }

    // 渲染授权页面
    res.send(generateOAuthPage(oauthApp, app_id, user, redirect_uri, legacyConsentSignature(oauthApp, username, req.sessionToken, redirect_uri)));
});

// 处理 OAuth 授权拒绝（改为 POST，防 CSRF 恶意拒绝）
app.post('/app/oauth/deny', async (req, res) => {
    const { app_id } = req.body;
    const redirect_uri = normalizeOAuthRedirectUri(req.body.redirect_uri);
    const clientIp = getClientIp(req);

    const username = req.authUsername;

    // 记录OAuth授权拒绝日志
    if (username) {
        await db.logUserAction(username, 'oauth_deny', t('OAuth 授权已拒绝'), clientIp);
    }

    if (!redirect_uri) {
        return res.redirect('/');
    }

    // 仅当 redirect 属于该应用白名单时才回跳，防止 open redirect
    if (app_id) {
        const oauthApp = await db.getOAuthApp(app_id);
        if (oauthApp && isOAuthRedirectAllowed(oauthApp, redirect_uri)) {
            return res.redirect(redirect_uri);
        }
    }
    return res.redirect('/');
});

// 处理 OAuth 授权接受（改为 POST，防 CSRF 预取触发授权码生成）
app.post('/app/oauth/accept', async (req, res) => {
    const { app_id, auto_auth } = req.body;
    const redirect_uri = normalizeOAuthRedirectUri(req.body.redirect_uri);
    const clientIp = getClientIp(req);

    const username = req.authUsername;

    // 如果用户未登录，跳转到主页
    if (!username) {
        return res.redirect('/');
    }

    const user = await db.getUser(username);
    if (!user) {
        return res.redirect('/');
    }

    // 检查参数是否存在
    if (!app_id || !redirect_uri) {
        return res.status(400).send(t('缺少必要的参数'));
    }

    // 查找应用信息
    const oauthApp = await db.getOAuthApp(app_id);
    if (!oauthApp) {
        return res.status(404).send(t('应用不存在'));
    }

    // 关键：必须与 /app/oauth 一样校验 redirect_uri，防止授权码落到攻击者域名
    if (!isOAuthRedirectAllowed(oauthApp, redirect_uri)) {
        return res.status(400).send(t('无效的 redirect_uri'));
    }

    if (!safeEqualString(req.body.consent_signature, legacyConsentSignature(oauthApp, username, req.sessionToken, redirect_uri))) {
        return res.status(409).send(t('授权配置已改变，请刷新授权页面'));
    }

    // 生成随机代码
    const code = generateCode();

    // 保存授权信息
    await db.saveAuthorization(code, {
        app_id: app_id,
        username: username,
        created_at: new Date().toISOString(),
        ip_address: clientIp,
        redirect_uri: redirect_uri,
        scope: (oauthApp.permissions || []).join(' '),
        auto_auth: auto_auth === 'true'
    });

    // 如果启用自动授权，保存自动授权记录
    if (auto_auth === 'true') {
        const autoAuthKey = `auto_auth:${username}:${app_id}:${clientIp}`;
        const autoAuthData = {
            username: username,
            app_id: app_id,
            ip_address: clientIp,
            redirect_uri: redirect_uri,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30天后过期
        };
        await db.saveAutoAuth(autoAuthKey, autoAuthData);
        await db.logUserAction(username, 'oauth_auto_auth_enabled', `已开启应用自动授权: ${app_id}`, clientIp);
    }

    // 记录OAuth授权成功日志
    await db.logUserAction(username, 'oauth_authorize', `已授权应用: ${app_id}`, clientIp);

    try {
        res.redirect(appendOAuthCallbackParams(redirect_uri, { code }));
    } catch (redirectErr) {
        return res.status(400).send(t('无效的 redirect_uri'));
    }
});

// OAuth 应用身份验证接口（仅验证应用凭据；优先 Header/Body，兼容 Query）
async function oauthAppValidateHandler(req, res) {
    const p = getAppAuthParams(req);
    const appname = p.appname || p.app_id;
    const appsecret = p.appsecret || p.app_secret;

    if (!appname || !appsecret) {
        return res.status(400).json({
            status: 'error',
            valid: false,
            message: t('缺少必要参数 appname 或 appsecret')
        });
    }

    try {
        const normalizedAppName = String(appname).trim();
        const normalizedAppSecret = String(appsecret);

        let oauthApp = await db.getOAuthApp(normalizedAppName);
        if (!oauthApp) {
            oauthApp = await db.getOAuthAppByName(normalizedAppName);
        }

        const isValid = !!(oauthApp && safeEqualString(oauthApp.app_secret, normalizedAppSecret));

        if (!isValid) {
            return res.json({
                status: 'success',
                valid: false,
                message: t('应用不存在或密钥不正确')
            });
        }

        return res.json({
            status: 'success',
            valid: true,
            app_id: oauthApp.id,
            app_name: oauthApp.name,
            official: !!oauthApp.official
        });
    } catch (error) {
        console.error(t('OAuth 应用身份验证失败:'), error);
        return res.status(500).json({
            status: 'error',
            valid: false,
            message: t('服务器错误')
        });
    }
}
app.get('/app/oauthapp/validate', oauthAppValidateHandler);
app.post('/app/oauthapp/validate', oauthAppValidateHandler);

// OAuth 验证（换取用户信息）：优先 Header/Body，兼容 Query
async function appVerifyHandler(req, res) {
    const p = getAppAuthParams(req);
    // 兼容仅 query 的旧调用；code 也允许从 query 直接取，避免被其它字段覆盖
    const app_id = p.app_id || req.query.app_id;
    const app_secret = p.app_secret || req.query.app_secret;
    const code = p.code || req.query.code;

    // 检查参数是否存在
    if (!app_id || !app_secret || !code) {
        console.warn('[app/verify] missing params', { hasAppId: !!app_id, hasSecret: !!app_secret, hasCode: !!code });
        return res.status(400).json({ error: t('缺少必要的参数') });
    }

    // 查找应用信息
    const oauthApp = await db.getOAuthApp(app_id);
    if (!oauthApp) {
        console.warn('[app/verify] app not found', app_id);
        return res.status(404).json({ error: t('应用不存在') });
    }

    // 验证应用密钥（恒定时间比较）
    if (!safeEqualString(oauthApp.app_secret, app_secret)) {
        console.warn('[app/verify] bad app_secret', app_id);
        return res.status(401).json({ error: t('应用密钥不正确') });
    }

    // 原子消费已绑定应用的授权码，再签发任何用户凭据。
    const authorization = await db.exchangeLegacyAuthorization({ code, appId: app_id, appSecret: app_secret, userToken: crypto.randomBytes(32).toString('hex'), ipAddress: getClientIp(req) });
    if (!authorization) {
        console.warn('[app/verify] code invalid or expired', {
            app_id
        });
        return res.status(404).json({ error: t('授权码无效或已过期') });
    }

    // 验证应用ID是否匹配
    if (authorization.app_id !== app_id) {
        console.warn('[app/verify] app_id mismatch', { expected: authorization.app_id, got: app_id });
        return res.status(401).json({ error: t('应用ID不匹配') });
    }

    // 获取用户信息
    const user = await db.getUser(authorization.username);
    if (!user) {
        return res.status(404).json({ error: t('用户不存在') });
    }

    // 构造返回的用户信息（根据权限过滤；user:name 同时返回 username 与 nickname）
    const userInfo = buildScopedUserInfo(user, oauthApp.permissions);

    if (authorization.userToken) userInfo.apptoken = authorization.userToken;

    if (oauthApp.permissions.includes('bbbs:session')) {
        try {
            const bbbsResponse = await axios.post(
                `${config.BBBS.url}/api/passport/session`,
                { user: user.username, secret: config.BBBS.PassPortSecret },
                { timeout: 10000, maxRedirects: 0, maxContentLength: 1024 * 1024 }
            );
            if (bbbsResponse.data && bbbsResponse.data.success) {
                userInfo.bbbs_session = bbbsResponse.data.session;
                userInfo['bbbs_session.sig'] = bbbsResponse.data['session.sig'];
                userInfo.bbbs_csrf_token = bbbsResponse.data.csrf_token || '';
            }
        } catch (e) {
            console.error('BBBS session request failed:', e.message);
        }
    }

    // 返回用户信息
    res.json(userInfo);
}
app.get('/app/verify', appVerifyHandler);
app.post('/app/verify', appVerifyHandler);

// 新旧用户名映射 API（应用密钥鉴权，供第三方应用迁移本地存储的用户名）
app.post('/app/oauthapp/username-mapping', async (req, res) => {
    const p = getAppAuthParams(req);
    const app_id = p.app_id || req.query.app_id;
    const app_secret = p.app_secret || req.query.app_secret;

    if (!app_id || !app_secret) {
        return res.status(400).json({ error: t('缺少必要的参数') });
    }
    const oauthApp = await db.getOAuthApp(app_id);
    if (!oauthApp) {
        return res.status(404).json({ error: t('应用不存在') });
    }
    if (!safeEqualString(oauthApp.app_secret, app_secret)) {
        return res.status(401).json({ error: t('应用密钥不正确') });
    }

    const { usernames } = req.body || {};
    if (!Array.isArray(usernames) || usernames.length === 0) {
        return res.status(400).json({ error: t('请提供 usernames 数组') });
    }
    if (usernames.length > 1000) {
        return res.status(400).json({ error: t('单次最多查询 1000 个用户名') });
    }

    const userNames = usernames.map(u => String(u));
    const { rows, deleted } = await db.getUsernameMapping(userNames);
    const rowsByOld = new Map(rows.map(r => [r.old_username, { new_username: r.new_username, nickname: r.nickname }]));
    res.json(buildUsernameMappingPayload(userNames, rowsByOld, deleted));
});

// Provider login transactions are single-use, browser-bound, and also bind an
// existing session when the user starts an account-linking flow.
const providerLoginTransactions = new Map();
const PROVIDER_LOGIN_TTL_MS = 10 * 60 * 1000;
function rememberProviderLogin(provider, state, req, redirectUri = '') {
    const now = Date.now();
    for (const [key, entry] of providerLoginTransactions) {
        if (entry.expiresAt <= now) providerLoginTransactions.delete(key);
    }
    if (providerLoginTransactions.size >= 10000) return false;
    providerLoginTransactions.set(`${provider}:${state}`, {
        username: req.authUsername || null, sessionToken: req.sessionToken || null,
        redirectUri, expiresAt: now + PROVIDER_LOGIN_TTL_MS
    });
    return true;
}
function consumeProviderLogin(provider, state, cookieState, req) {
    if (typeof state !== 'string' || !state || typeof cookieState !== 'string' || !safeEqualString(state, cookieState)) return null;
    const key = `${provider}:${state}`;
    const entry = providerLoginTransactions.get(key);
    if (!entry || entry.expiresAt <= Date.now() ||
        entry.username !== (req.authUsername || null) || entry.sessionToken !== (req.sessionToken || null)) return null;
    providerLoginTransactions.delete(key);
    return entry;
}
const GITHUB_STATE_COOKIE = '__Host-github_oauth_state';
const githubStateCookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: PROVIDER_LOGIN_TTL_MS };

app.get('/oauth/github/start', loginRateLimit, (req, res) => {
    const github = (config.oauth && config.oauth.github) || {};
    if (!github.client_id || !github.client_secret) return res.status(503).send(t('GitHub 登录暂不可用'));
    const redirectUri = typeof req.query.redirect_uri === 'string' && isSafeLoginRedirect(req.query.redirect_uri) ? req.query.redirect_uri : '';
    const state = crypto.randomBytes(32).toString('base64url');
    if (!rememberProviderLogin('github', state, req, redirectUri)) return res.status(503).send(t('请稍后再试'));
    res.cookie(GITHUB_STATE_COOKIE, state, githubStateCookieOptions);
    const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
    authorizeUrl.searchParams.set('client_id', github.client_id);
    authorizeUrl.searchParams.set('redirect_uri', github.redirect_uri || `${getCanonicalOAuthOrigin(req)}/oauth/github`);
    authorizeUrl.searchParams.set('state', state);
    res.redirect(authorizeUrl.toString());
});

app.get('/oauth/github', loginRateLimit, async (req, res) => {
    const { code, state } = req.query;
    const cookies = parseCookies(req.headers.cookie || '');
    const transaction = consumeProviderLogin('github', state, cookies[GITHUB_STATE_COOKIE], req);
    res.clearCookie(GITHUB_STATE_COOKIE, { path: '/', secure: true, sameSite: 'lax' });
    if (!transaction || typeof code !== 'string' || !code) {
        return res.status(400).json({ status: 'error', message: t('GitHub 登录状态校验失败，请重新登录') });
    }
    const github = (config.oauth && config.oauth.github) || {};
    try {
        const response = await axios.post('https://github.com/login/oauth/access_token', {
            client_id: github.client_id, client_secret: github.client_secret, code,
            redirect_uri: github.redirect_uri || `${getCanonicalOAuthOrigin(req)}/oauth/github`
        }, { headers: { Accept: 'application/json' }, timeout: 10000, maxRedirects: 0, maxContentLength: 1024 * 1024 });
        const accessToken = response.data.access_token;
        if (!accessToken) return res.status(400).json({ status: 'error', message: t('未能获取 access_token') });
        const userResponse = await axios.get('https://api.github.com/user', {
            headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000, maxRedirects: 0, maxContentLength: 1024 * 1024
        });
        const providerId = userResponse.data && userResponse.data.id;
        if (!Number.isSafeInteger(providerId) || providerId <= 0) return res.status(502).json({ status: 'error', message: t('GitHub 用户信息无效') });
        const users = await db.getAllUsers();
        const matchedUser = users.find(candidate => candidate.github === String(providerId));
        const user = matchedUser ? await db.getUser(matchedUser.username) : null;
        if (user && user.github !== String(providerId)) return res.status(409).json({ error: 'identity_changed' });
        if (transaction.username) {
            if (user && user.username !== transaction.username) return res.status(409).json({ status: 'error', message: t('此 GitHub 账户已绑定其他用户') });
            if (!await db.getUser(transaction.username)) return res.status(401).json({ status: 'error' });
            await db.updateUser(transaction.username, { github: String(providerId) });
            await logUserAction(transaction.username, 'github_link', t('GitHub 账户已绑定'), getClientIp(req));
            return res.redirect(resolveLoginRedirect(transaction.redirectUri));
        }
        if (!user) return res.status(404).json({ status: 'error', message: t('未找到对应的 GitHub 用户，请先登录后绑定') });
        if (user.twoFactorEnabled) {
            beginPendingLogin(req, res, user, transaction.redirectUri);
            await logUserAction(user.username, 'github_login_2fa_pending', t('GitHub 验证通过，等待二次验证'), getClientIp(req));
            return res.redirect('/login/2fa');
        }
        await establishSession(res, user.username, SESSION_MAX_AGE_MS, {}, user);
        await logUserAction(user.username, 'github_login', t('GitHub 登录成功'), getClientIp(req));
        return res.redirect(resolveLoginRedirect(transaction.redirectUri));
    } catch (error) {
        console.error('GitHub login failed:', error.code || 'provider_error');
        return res.status(502).json({ status: 'error', message: t('GitHub 登录失败，请稍后重试') });
    }
});

// 开始飞书 OAuth 登录：为每次登录生成一次性 state，并保存安全的返回地址。
app.get('/oauth/lark/start', loginRateLimit, (req, res) => {
    const redirectUri = typeof req.query.redirect_uri === 'string' && isSafeLoginRedirect(req.query.redirect_uri)
        ? req.query.redirect_uri
        : '';
    const state = createLarkOAuthState(redirectUri);
    if (!rememberProviderLogin('lark', state, req, redirectUri)) return res.status(503).send(t('请稍后再试'));
    const cookieOptions = getLarkOAuthCookieOptions();
    res.cookie(LARK_OAUTH_STATE_COOKIE, state, cookieOptions);
    if (redirectUri) {
        res.cookie(LARK_OAUTH_REDIRECT_COOKIE, redirectUri, cookieOptions);
    } else {
        res.clearCookie(LARK_OAUTH_REDIRECT_COOKIE, { path: '/', secure: true, sameSite: 'none' });
    }
    res.redirect(getLarkAuthorizeUrl(state));
});

// 处理 飞书 登录
app.get('/oauth/lark', loginRateLimit, async (req, res) => {
    const { code, state } = req.query;
    const cookies = parseCookies(req.headers.cookie || '');

    if (!code) {
        clearLarkOAuthCookies(res);
        return res.status(400).json(getLarkOAuthError('缺少 code 参数'));
    }
    const transaction = consumeProviderLogin('lark', state, cookies[LARK_OAUTH_STATE_COOKIE], req);
    const verifiedState = transaction && verifyLarkOAuthState(state);
    if (!verifiedState) {
        clearLarkOAuthCookies(res);
        return res.status(400).json(getLarkOAuthError('飞书登录状态校验失败，请重新登录'));
    }
    const redirectUri = verifiedState.redirectUri || cookies[LARK_OAUTH_REDIRECT_COOKIE] || '';
    clearLarkOAuthCookies(res);

    const larkOAuth = (config.oauth && config.oauth.lark) || {};
    const url = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
    const data = {
        grant_type: 'authorization_code',
        client_id: larkOAuth.client_id,
        client_secret: larkOAuth.client_secret,
        code: code,
        redirect_uri: getLarkOAuthRedirectUri()
    };

    try {
        const response = await axios.post(url, data, {
            headers: {
                Accept: 'application/json'
            }, timeout: 10000, maxRedirects: 0, maxContentLength: 1024 * 1024
        });

        const accessToken = response.data.access_token;

        if (response.data.code != 0) {
            return res.status(400).json({ status: 'error', message: t('请求失败。') });
        }

        if (!accessToken) {
            return res.status(400).json({ status: 'error', message: t('未能获取 access_token') });
        }

        const userResponse = await axios.get('https://open.feishu.cn/open-apis/authen/v1/user_info', {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }, timeout: 10000, maxRedirects: 0, maxContentLength: 1024 * 1024
        });

        // 查找与 lark id 对应的用户
        const users = await db.getAllUsers();
        const matchedUser = users.find(user => user.lark === userResponse.data.data.open_id);
        const user = matchedUser ? await db.getUser(matchedUser.username) : null;
        if (user && user.lark !== userResponse.data.data.open_id) return res.status(409).json({ error: 'identity_changed' });

        if (transaction.username) {
            if (user && user.username !== transaction.username) return res.status(409).json(getLarkOAuthError('此飞书账户已绑定其他用户'));
            if (!await db.getUser(transaction.username)) return res.status(401).json(getLarkOAuthError('请重新登录'));
            const providerId = userResponse.data && userResponse.data.data && userResponse.data.data.open_id;
            if (typeof providerId !== 'string' || !providerId) return res.status(502).json(getLarkOAuthError('飞书用户信息无效'));
            await db.updateUser(transaction.username, { lark: providerId });
            await logUserAction(transaction.username, 'lark_link', t('飞书账户已绑定'), getClientIp(req));
            return res.redirect(resolveLoginRedirect(redirectUri));
        }
        if (user) {
            const clientIp = getClientIp(req);

            // 检查是否开启了 2FA
            if (user.twoFactorEnabled) {
                beginPendingLogin(req, res, user, redirectUri);
                await logUserAction(user.username, 'lark_login_2fa_pending', t('飞书验证通过，等待二次验证'), clientIp);
                return res.redirect('/login/2fa');
            }

            // 未开启 2FA，直接登录并回到 OAuth 流程或首页。
            await establishSession(res, user.username, SESSION_MAX_AGE_MS, { sameSite: 'none' }, user);
            // res.cookie('password', user.password, { expires: expireDate });
            // res.cookie('admin', user.admin, { expires: expireDate });

            // 记录飞书登录成功日志
            await logUserAction(user.username, 'lark_login', t('飞书登录成功'), clientIp);
            res.redirect(resolveLoginRedirect(redirectUri));
        } else {
            return res.status(404).json(getLarkOAuthError('未找到对应的飞书用户，请先登录后绑定'));
        }
    } catch (error) {
        console.error('Lark login failed:', error.code || 'provider_error');
        clearLarkOAuthCookies(res);
        res.status(502).json(getLarkOAuthError('飞书登录失败，请稍后重试'));
    }
});

// Minecraft 相关路由和函数已迁移至 minecraft.js


// 处理注册OAuth应用表单页面请求
app.get('/register/oauthapp', async (req, res) => {
    // 检查cookie中的username
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;

    // 如果用户未登录，跳转到主页
    const currentUser = await db.getUser(username);
    if (!username || !currentUser) {
        return res.redirect('/');
    }

    res.send(generateRegisterOAuthAppHtml(currentUser));
});

// 处理编辑 OAuth 应用页面请求
app.get('/edit/oauthapp/:app_id', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    const currentUser = await db.getUser(username);

    if (!currentUser) {
        return res.redirect('/');
    }

    const appId = req.params.app_id;
    const oauthApp = await db.getOAuthApp(appId);

    if (!oauthApp) {
        return res.status(404).send(t('应用不存在'));
    }

    // 管理员或所有者可以编辑
    if (oauthApp.owner !== currentUser.username && !currentUser.admin) {
        return res.status(403).send(t('您没有权限编辑此应用'));
    }

    res.send(generateEditOAuthAppHtml(currentUser, appId, oauthApp));
});

// OAuth App 详情页
app.get('/oauthapp/:app_id', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    const currentUser = await db.getUser(username);

    if (!currentUser) {
        return res.redirect('/');
    }

    const appId = req.params.app_id;
    const oauthApp = await db.getOAuthApp(appId);

    if (!oauthApp) {
        return res.status(404).send(t('应用不存在'));
    }

    // 管理员或所有者可以查看
    if (oauthApp.owner !== currentUser.username && !currentUser.admin) {
        return res.status(403).send(t('您没有权限查看此应用'));
    }

    const stats = await db.getOAuthAppStats(appId);
    res.send(generateOAuthAppDetailHtml(currentUser, oauthApp, stats));
});

// 处理编辑 OAuth 应用提交
app.post('/edit/oauthapp/:app_id', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;

    const currentUser = await db.getUser(username);
    if (!username || !currentUser) {
        return res.redirect('/');
    }

    const appId = req.params.app_id;
    const app = await db.getOAuthApp(appId);

    if (!app || (app.owner !== currentUser.username && !currentUser.admin)) {
        return res.status(403).send(t('无权编辑'));
    }

    const {
        name,
        description,
        icon,
        app_secret,
        permissions,
        redirect_uri
    } = req.body;
    const permissionList = Array.isArray(permissions) ? permissions : (permissions ? [permissions] : []);

    if (!name || !description || !icon || !app_secret || permissionList.length === 0) {
        return res.send(generateEditOAuthAppHtml(currentUser, appId, app, t('请填写所有必填字段并至少选择一个权限')));
    }

    // 准备更新数据
    const updateData = {
        name,
        description,
        icon,
        app_secret,
        permissions: sanitizeOAuthPermissions(permissionList, currentUser.admin === true)
    };

    if (typeof redirect_uri === 'string') {
        updateData.redirect_uri = redirect_uri.split('\n').map(uri => uri.trim()).filter(uri => uri.length > 0);
    } else if (Array.isArray(redirect_uri)) {
        updateData.redirect_uri = redirect_uri;
    } else {
        updateData.redirect_uri = [];
    }

    try {
        await db.updateOAuthApp(appId, updateData);
        
        const clientIp = getClientIp(req);
        await db.logUserAction(username, 'edit_oauth_app', `已更新 OAuth 应用: ${appId}`, clientIp);
        res.redirect(`/edit/oauthapp/${encodeURIComponent(appId)}`);
    } catch (error) {
        console.error(t('保存OAuth应用失败:'), error);
        res.send(generateEditOAuthAppHtml(currentUser, appId, app, t('保存失败，请重试')));
    }
});

// 重新生成 OAuth 应用密钥
app.post('/api/oauthapp/:app_id/regenerate-secret', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    const currentUser = await db.getUser(username);
    if (!currentUser) return res.status(401).json({ success: false, message: t('未登录') });

    const appId = req.params.app_id;
    const oauthApp = await db.getOAuthApp(appId);
    if (!oauthApp) return res.status(404).json({ success: false, message: t('应用不存在') });

    // 管理员或所有者可以重新生成
    if (oauthApp.owner !== currentUser.username && !currentUser.admin) {
        return res.status(403).json({ success: false, message: t('无权操作') });
    }

    const newSecret = 'bs_' + crypto.randomBytes(24).toString('hex');
    await db.updateOAuthApp(appId, { app_secret: newSecret });

    const clientIp = getClientIp(req);
    await db.logUserAction(username, 'edit_oauth_app', `已重新生成 OAuth 应用密钥: ${appId}`, clientIp);

    res.json({ success: true, data: { app_secret: newSecret } });
});

// 处理注册OAuth应用表单提交
app.post('/register/oauthapp', async (req, res) => {
    // 检查cookie中的username
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;

    // 如果用户未登录，跳转到主页
    const currentUser = await db.getUser(username);
    if (!username || !currentUser) {
        return res.redirect('/');
    }

    // 获取表单数据（app_id 和 app_secret 由系统自动生成）
    const {
        name,
        description,
        icon,
        permissions,
        redirect_uri
    } = req.body;

    // 检查必填字段；redirect_uri 为空时表示不限制回调地址
    if (!name || !description || !icon) {
        return res.send(generateRegisterOAuthAppHtml(currentUser, t('请填写所有必填字段')));
    }

    // 检查权限字段
    if (!permissions) {
        return res.send(generateRegisterOAuthAppHtml(currentUser, t('请至少选择一个权限')));
    }

    // 自动生成 app_id 和 app_secret
    const app_id = 'bp_' + crypto.randomBytes(8).toString('hex');
    const app_secret = 'bs_' + crypto.randomBytes(24).toString('hex');

    // 处理权限数组（过滤禁止项如 user:password）
    let permissionArray = sanitizeOAuthPermissions(permissions);

    // 处理重定向URI数组
    let redirectUriArray = [];
    if (redirect_uri) {
        if (typeof redirect_uri === 'string') {
            redirectUriArray = redirect_uri.split('\n').map(uri => uri.trim()).filter(uri => uri.length > 0);
        } else if (Array.isArray(redirect_uri)) {
            redirectUriArray = redirect_uri;
        }
    }

    const newApp = {
        id: app_id,
        name: name,
        description: description,
        icon: icon,
        official: false,
        app_secret: app_secret,
        permissions: permissionArray,
        redirect_uri: redirectUriArray,
        owner: username
    };

    try {
        await db.createOAuthApp(newApp);

        const clientIp = getClientIp(req);
        await db.logUserAction(username, 'register_oauth_app', `已注册 OAuth 应用: ${app_id}`, clientIp);

        // 显示成功页面，展示生成的 app_id 和 app_secret
        res.send(generateRegisterOAuthAppSuccessHtml(currentUser, app_id, app_secret));
    } catch (error) {
        console.error(t('保存OAuth应用失败:'), error);

        const clientIp = getClientIp(req);
        await db.logUserAction(username, 'register_oauth_app_failed', `注册 OAuth 应用失败`, clientIp);

        res.send(generateRegisterOAuthAppHtml(currentUser, t('保存失败，请重试')));
    }
});

function generateRegisterOAuthAppHtml(currentUser, error = null) {
    const safeError = error ? escapeHtml(String(error)) : '';
    const sf = (name, color = '0071e3') => `https://img.bloret.net/SF/${name}?color=%23${color}`;

    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('注册 OAuth App - Bloret PassPort')}</title>
        <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope">
    ${generateSidebarHtml(currentUser, 'open-platform')}

    <div class="main-content-apple">
        <h1 class="page-title">${t('注册新应用')}</h1>

        <div class="user-info-card blora-card">
            <div class="post-title">${t('应用信息')}</div>
            <div class="post-content">
                ${safeError ? `<div style="color: #ff4444; margin-bottom: 20px;">${safeError}</div>` : ''}

                <form action="/register/oauthapp" method="POST">
                    <div style="margin-bottom: 20px;">
                        <label class="form-label" style="font-weight:bold; display:block; margin-bottom:8px;">${t('应用名称 *')}</label>
                        <input class="blora-input" name="name" type="text" required style="width:100%" >
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label class="form-label" style="font-weight:bold; display:block; margin-bottom:8px;">${t('应用描述 *')}</label>
                        <input class="blora-input" name="description" type="text" required style="width:100%" >
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label class="form-label" style="font-weight:bold; display:block; margin-bottom:8px;">${t('图标 URL *')}</label>
                        <input class="blora-input" name="icon" type="text" required style="width:100%" >
                    </div>

                    <div style="margin-bottom: 24px;">
                        <label class="form-label" style="font-weight:bold; display:block; margin-bottom:10px;">${t('所需权限 *')}</label>
                        <div style="display: flex; flex-direction: column; gap: 10px; background: rgba(0,0,0,0.02); padding: 15px; border-radius: 12px; border: 1px solid var(--border-color);">
                            <label style="display:flex; align-items:center; gap:8px;"><blora-checkbox name="permissions" value="user:name">${t('用户名称 (user:name)')}</blora-checkbox></label>
                            <label style="display:flex; align-items:center; gap:8px;"><blora-checkbox name="permissions" value="user:head">${t('用户头像 (user:head)')}</blora-checkbox></label>
                            <label style="display:flex; align-items:center; gap:8px;"><blora-checkbox name="permissions" value="user:email">${t('用户邮箱 (user:email)')}</blora-checkbox></label>
                            <div style="color:var(--text-secondary); font-size: 13px; padding: 6px 0;">${t('* 管理员权限 (user:admin) 需联系管理员申请')}</div>
                            <label style="display:flex; align-items:center; gap:8px;"><blora-checkbox name="permissions" value="app:usertoken">${t('生成长期令牌 (app:usertoken)')}</blora-checkbox></label>
                            <label style="display:flex; align-items:center; gap:8px;"><blora-checkbox name="permissions" value="user:tags">${t('用户标签 (user:tags)')}</blora-checkbox></label>
                            <label><blora-checkbox name="permissions" value="ai:use">${t('使用用户 AI 额度 (ai:use)')}</blora-checkbox></label>
                            <label><blora-checkbox name="permissions" value="minecraft:accounts">${t('读取 Minecraft 游戏凭据 (minecraft:accounts)')}</blora-checkbox></label>
                            <label style="display:flex; align-items:center; gap:8px;"><blora-checkbox name="permissions" value="bbbs:session">${t('以用户身份登录 BBBS (bbbs:session)')}</blora-checkbox></label>
                        </div>
                    </div>

                    <div style="margin-bottom: 24px;">
                        <label class="form-label" style="font-weight:bold; display:block; margin-bottom:8px;">${t('重定向 URI (每行一个)')}</label>
                        <textarea class="blora-textarea" name="redirect_uri" style="width:100%" ></textarea>
                    </div>

                    <div style="display: flex; gap: 12px;">
                        <button class="blora-button" data-variant="primary" type="submit" >${t('注册应用')}</button>
                        <button type="button" class="blora-button" data-variant="outline" onclick="window.location.href='/open-platform'" >${t('返回平台')}</button>
                    </div>
                </form>
            </div>
        </div>
    </div>
    <script>${sidebarScript}</script>
</body>
</html>
  `;
}

function generateRegisterOAuthAppSuccessHtml(currentUser, appId, appSecret) {
    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('注册成功 - Bloret PassPort')}</title>
    <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
    <style>
        .passport-secret-stack { display: flex; flex-direction: column; gap: var(--blora-space-4); text-align: start; }
        .passport-secret-stack .form-label { margin: 0; }
        .passport-oauth-success-actions { display: flex; flex-wrap: wrap; gap: var(--blora-space-3); justify-content: center; margin-top: var(--blora-space-5); }
    </style>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope">
    ${generateSidebarHtml(currentUser, 'open-platform')}

    <div class="main-content-apple">
        <h1 class="page-title">${t('注册成功')}</h1>

        <section class="blora-card">
            <blora-result variant="success" title="${t('应用创建成功')}" description="${t('请妥善保管以下凭证，密钥仅显示一次。')}"></blora-result>
            <div class="passport-secret-stack">
                <label class="form-label">${t('应用 ID')}</label>
                <blora-copy text="${escapeHtml(String(appId || ''))}" label="${t('复制应用 ID')}">${escapeHtml(String(appId || ''))}</blora-copy>
                <label class="form-label">${t('应用密钥 (App Secret)')}</label>
                <blora-copy text="${escapeHtml(String(appSecret || ''))}" label="${t('复制应用密钥')}">${escapeHtml(String(appSecret || ''))}</blora-copy>
                <blora-alert variant="warning" title="${t('密钥仅显示一次')}" description="${t('应用密钥不会再次显示，请立即复制保存。如果遗失，可以在应用详情页重新生成。')}"></blora-alert>
            </div>
            <div class="passport-oauth-success-actions">
                <a href="/oauthapp/${encodeURIComponent(appId)}" class="blora-button" data-variant="primary">${t('查看应用详情')}</a>
                <a href="/open-platform" class="blora-button" data-variant="outline">${t('返回开放平台')}</a>
            </div>
        </section>
    </div>

    <script>${sidebarScript}</script>
</body>
</html>
    `;
}

function generateOAuthPage(oauthApp, app_id, user, redirectUri, consentSignature = '') {
    user = user || {};
    const username = escapeHtml(user.username || '');
    const appName = escapeHtml(oauthApp.name || '');
    const appDesc = escapeHtml(oauthApp.description || t('此应用希望访问您的账户信息'));
    const appIcon = escapeHtml(oauthApp.icon || '');
    const avatarUrl = escapeHtml(user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username || '')}&background=0078d4&color=fff&size=128`);
    const userPreview = renderOAuthUserPreview(user, escapeHtml, t('当前登录'));
    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('Bloret PassPort - 授权')}</title>
    <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
        <style>
        :root {
        }

        body {
            margin: 0;
            font-family: var(--font-family);
            background-color: var(--blora-color-surface-canvas);
            color: var(--blora-color-text-primary);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
        }

        .auth-card {
            background-color: var(--blora-color-surface-default);
            border-radius: 12px;
            box-shadow: var(--blora-shadow-1);
            width: 100%;
            max-width: 440px;
            padding: 32px;
            box-sizing: border-box;
            border: 1px solid var(--blora-color-border-subtle);
            position: relative;
        }

        /* App Header */
        .app-header {
            display: flex;
            align-items: center;
            margin-bottom: 24px;
        }
        .app-icon {
            width: 64px;
            height: 64px;
            border-radius: 12px;
            background-color: var(--blora-color-surface-raised);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            font-weight: 600;
            color: var(--blora-color-text-primary);
            margin-right: 16px;
            overflow: hidden;
            flex-shrink: 0;
            box-shadow: var(--blora-shadow-1);
        }
        .app-icon img { width: 64px; height: 64px; max-width: none; display: block; object-fit: cover; }
        .app-info { flex: 1; }
        .app-info h1 {
            margin: 0 0 4px 0;
            font-size: 20px;
            font-weight: 600;
        }
        .app-info p {
            margin: 0;
            font-size: 14px;
            color: var(--blora-color-text-secondary);
            line-height: 1.4;
        }
        .official-badge {
            display: inline-flex;
            align-items: center;
            padding: 2px 8px;
            background-color: var(--blora-color-action-primary-tint);
            color: var(--blora-color-action-primary-default);
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
            margin-left: 8px;
            vertical-align: middle;
            text-transform: uppercase;
        }
        .auth-brand {
            color: var(--blora-color-text-primary);
            margin: 0 0 24px 0;
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 16px;
            font-weight: 600;
        }

        /* Permissions */
        .permissions-section {
            margin-bottom: 24px;
        }
        .section-label {
            font-size: 14px;
            font-weight: 600;
            color: var(--blora-color-text-primary);
            margin-bottom: 12px;
            display: block;
        }
        .permission-list {
            list-style: none;
            padding: 0;
            margin: 0;
        }
        .permission-item {
            display: flex;
            align-items: flex-start;
            padding: 8px 0;
            font-size: 14px;
            line-height: 20px;
            color: var(--blora-color-text-primary);
            border-bottom: 1px solid var(--blora-color-border-subtle);
        }
        .permission-item:last-child { border-bottom: none; }
        .permission-icon {
            width: 24px;
            height: 24px;
            margin-right: 12px;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .permission-icon img {
            width: 20px;
            height: 20px;
            display: block;
        }
        html[data-blora-color-scheme="dark"] .permission-icon img {
            filter: invert(1) brightness(1.15);
        }
        @media (prefers-color-scheme: dark) {
            html:not([data-blora-color-scheme="light"]) .permission-icon img {
                filter: invert(1) brightness(1.15);
            }
        }
        .permission-text {
            flex: 1;
        }

        /* User Info */
        .auth-card .user-preview {
            display: flex;
            align-items: center;
            padding: 12px;
            background-color: var(--blora-color-surface-raised);
            border: 1px solid var(--blora-color-border-subtle);
            border-radius: 8px;
            margin-bottom: 32px;
            color: var(--blora-color-text-primary);
        }
        .auth-card .user-preview .user-avatar {
            width: 32px;
            height: 32px;
            flex: 0 0 32px;
            border-radius: 50%;
            background-color: var(--blora-color-surface-sunken);
            color: var(--blora-color-text-primary);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: 600;
            margin-right: 12px;
            overflow: hidden;
        }
        .auth-card .user-preview .user-avatar img { width: 32px; height: 32px; max-width: none; display: block; object-fit: cover; }
        .auth-card .user-preview .user-details {
            font-size: 13px;
            color: var(--blora-color-text-muted);
        }
        .auth-card .user-preview .user-details strong {
            display: block;
            color: var(--blora-color-text-primary);
            font-size: 14px;
        }

        /* Actions */
        .action-group {
            display: flex;
            gap: 12px;
        }
        .action-group .blora-button {
            flex: 1;
        }

        /* Popover */
        .auth-popover {
            position: absolute;
            z-index: 1000;
            width: 300px;
            background: var(--blora-color-surface-default);
            border: 1px solid var(--blora-color-border-subtle);
            border-radius: 8px;
            box-shadow: var(--blora-shadow-3);
            padding: 20px;
            opacity: 0;
            transform: translateY(8px);
            transition: opacity 0.2s ease-out, transform 0.2s cubic-bezier(0.33, 1, 0.68, 1);
            pointer-events: none;
            visibility: hidden;
            font-size: 13px;
        }
        .auth-popover.visible {
            opacity: 1;
            transform: translateY(0);
            pointer-events: auto;
            visibility: visible;
        }
        .popover-header {
            font-weight: 600;
            margin-bottom: 8px;
            color: #D13438;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
        }
        .popover-content {
            color: var(--blora-color-text-secondary);
            line-height: 1.5;
            margin-bottom: 16px;
        }
        .popover-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }
        
        @media (max-width: 480px) {
            .auth-card {
                box-shadow: none;
                border: none;
                background: transparent;
                padding: 20px;
            }
            body {
                align-items: flex-start;
                background-color: var(--blora-color-surface-default);
            }
        }
    </style>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope">
    <div class="auth-card">
        <h5 class="auth-brand">
            <img src="/BL.png" width="24" height="24" alt="" style="border-radius: 6px;">
            Bloret PassPort
        </h5>
        <div class="app-header">
            <div class="app-icon">
                ${appIcon ? `<img src="${appIcon}" alt="">` : appName.charAt(0)}
            </div>
            <div class="app-info">
                <h1>
                    ${appName}
                    ${oauthApp.official ? `<span class="official-badge">${t('官方')}</span>` : ''}
                </h1>
                <p>${appDesc}</p>
            </div>
        </div>

        <div class="permissions-section">
            <span class="section-label">${t('请求权限')}</span>
            <ul class="permission-list">
                ${oauthApp.permissions.map(p => {
                    let text = p;
                    let iconName = 'lock.fill';
                    if(p === 'user:name') { text = t('访问您的用户名'); iconName = 'person.fill'; }
                    else if(p === 'user:head') { text = t('访问您的头像'); iconName = 'person.crop.circle'; }
                    else if(p === 'user:email') { text = t('访问您的邮箱'); iconName = 'envelope.fill'; }
                    else if(p === 'user:admin') { text = t('访问您的管理员权限'); iconName = 'shield.fill'; }
                    else if(p === 'user:tags') { text = t('访问您的用户标签'); iconName = 'tag.fill'; }
                    else if(p === 'user:password') { text = t('访问您的密码'); iconName = 'lock.fill'; }
                    else if(p === 'app:usertoken') { text = t('生成长期用户令牌 (仅此应用可用)'); iconName = 'ticket.fill'; }
                    else if(p === 'ai:use') { text = t('使用您的 AI 调用额度'); iconName = 'sparkles'; }
                    else if(p === 'minecraft:accounts') { text = t('读取 Minecraft 档案及游戏登录凭据'); iconName = 'gamecontroller'; }
                    else if(p === 'bbbs:session') { text = t('以您的身份登录 BBBS 论坛'); iconName = 'globe'; }
                    
                    return `<li class="permission-item"><span class="permission-icon"><img src="https://img.bloret.net/SF/${iconName}?color=242424" alt=""></span><span class="permission-text">${text}</span></li>`;
                }).join('')}
            </ul>
        </div>

        ${userPreview}

        <div class="action-group">
            <button type="button" class="blora-button" data-variant="outline" onclick="window.location.href='/'" >${t('取消')}</button>
            <button type="button" class="blora-button" data-variant="primary" id="allowBtn" onclick="toggleAuthPopover()" >${t('授权')}</button>
        </div>
    </div>

    <div id="authPopover" class="auth-popover">
        <div class="popover-header">${t('⚠️ 请注意核实此 App 是否与您当前正在登录的应用一致')}</div>
        <div class="popover-content">
            ${t('Bloret PassPort 无法校验本次请求是否真的来自 {appName}。', { appName })}<br>
            ${t('由于很多项目密钥并不能很好保证不被泄漏，即使是官方应用。')}<br>
            ${t('如果您正在登录的应用与现在显示的 App 不一致，请勿进行授权，一旦您进行授权，您在 Bloret PassPort 的隐私信息将被泄漏，并且恶意发起者可能会以您的身份操作。')}
        </div>
        <div class="popover-actions">
            <button type="button" class="blora-button" data-variant="outline" onclick="hideAuthPopover()" >${t('取消')}</button>
            <button type="button" class="blora-button" data-variant="primary" onclick="showAutoAuthPopover()" >${t('确认授权')}</button>
        </div>
    </div>

    <div id="autoAuthPopover" class="auth-popover">
        <div class="popover-header">${t('💡 启用自动授权')}</div>
        <div class="popover-content">
            ${t('在 30 天内，当以相同 IP 地址和授权参数重新授权此应用时，是否自动授权，无需再次确认？')}<br><br>
            <strong>${t('注意：')}</strong>${t('这是一个安全快捷选项，仅在您完全信任此应用时启用。')}
        </div>
        <div class="popover-actions">
            <button type="button" class="blora-button" data-variant="outline" onclick="proceedWithoutAutoAuth()" >${t('暂不启用')}</button>
            <button type="button" class="blora-button" data-variant="primary" onclick="proceedWithAutoAuth()" >${t('启用自动授权')}</button>
        </div>
    </div>

    <script>
        function toggleAuthPopover() {
            const btn = document.getElementById('allowBtn');
            const pop = document.getElementById('authPopover');
            
            if (pop.classList.contains('visible')) {
                hideAuthPopover();
            } else {
                showAuthPopover(btn, pop);
            }
        }

        function showAuthPopover(btn, pop) {
            pop.style.visibility = 'hidden';
            pop.style.display = 'block';
            
            // Calculate position
            const btnRect = btn.getBoundingClientRect();
            const popRect = pop.getBoundingClientRect(); 
            
            // Center horizontally relative to button
            let left = btnRect.left + (btnRect.width / 2) - (popRect.width / 2);
            // Position above button
            let top = window.scrollY + btnRect.top - popRect.height - 12;
            
            // Boundary checks
            if (left < 16) left = 16;
            if (left + popRect.width > window.innerWidth - 16) left = window.innerWidth - popRect.width - 16;
            if (top < 16) top = 16;

            pop.style.top = top + 'px';
            pop.style.left = left + 'px';
            
            // Show
            pop.style.visibility = 'visible';
            requestAnimationFrame(() => {
                pop.classList.add('visible');
            });
        }

        function hideAuthPopover() {
            const pop = document.getElementById('authPopover');
            pop.classList.remove('visible');
            setTimeout(() => {
                if (!pop.classList.contains('visible')) {
                    pop.style.display = 'none';
                }
            }, 200);
        }

        function showAutoAuthPopover() {
            hideAuthPopover();
            
            const btn = document.getElementById('allowBtn');
            const pop = document.getElementById('autoAuthPopover');
            
            pop.style.visibility = 'hidden';
            pop.style.display = 'block';
            
            // Calculate position
            const btnRect = btn.getBoundingClientRect();
            const popRect = pop.getBoundingClientRect(); 
            
            // Center horizontally relative to button
            let left = btnRect.left + (btnRect.width / 2) - (popRect.width / 2);
            // Position above button
            let top = window.scrollY + btnRect.top - popRect.height - 12;
            
            // Boundary checks
            if (left < 16) left = 16;
            if (left + popRect.width > window.innerWidth - 16) left = window.innerWidth - popRect.width - 16;
            if (top < 16) top = 16;

            pop.style.top = top + 'px';
            pop.style.left = left + 'px';
            
            // Show
            pop.style.visibility = 'visible';
            requestAnimationFrame(() => {
                pop.classList.add('visible');
            });
        }

        function hideAutoAuthPopover() {
            const pop = document.getElementById('autoAuthPopover');
            pop.classList.remove('visible');
            setTimeout(() => {
                if (!pop.classList.contains('visible')) {
                    pop.style.display = 'none';
                }
            }, 200);
        }

        function oauthAcceptPost(autoAuth) {
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = '/app/oauth/accept';
            const fields = {
                consent_signature: ${scriptJson(consentSignature)},
                app_id: ${scriptJson(app_id)},
                redirect_uri: ${scriptJson(redirectUri)},
                auto_auth: autoAuth ? 'true' : 'false'
            };
            Object.keys(fields).forEach(function (k) {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = k;
                input.value = fields[k];
                form.appendChild(input);
            });
            var token = window.getCsrfToken ? window.getCsrfToken() : '';
            if (token) {
                var csrf = document.createElement('input');
                csrf.type = 'hidden';
                csrf.name = '_csrf';
                csrf.value = token;
                form.appendChild(csrf);
            }
            document.body.appendChild(form);
            form.submit();
        }
        function proceedWithoutAutoAuth() { oauthAcceptPost(false); }
        function proceedWithAutoAuth() { oauthAcceptPost(true); }

        document.addEventListener('click', function(e) {
            const pop = document.getElementById('authPopover');
            const autoPop = document.getElementById('autoAuthPopover');
            const btn = document.getElementById('allowBtn');
            
            if (pop.classList.contains('visible') && !pop.contains(e.target) && !btn.contains(e.target)) {
                hideAuthPopover();
            }
            
            if (autoPop.classList.contains('visible') && !autoPop.contains(e.target) && !btn.contains(e.target)) {
                hideAutoAuthPopover();
            }
        });

        window.addEventListener('resize', function() {
            const pop = document.getElementById('authPopover');
            const autoPop = document.getElementById('autoAuthPopover');
            
            if (pop.classList.contains('visible')) {
                hideAuthPopover();
            }
            
            if (autoPop.classList.contains('visible')) {
                hideAutoAuthPopover();
            }
        });
    </script>
</body>
</html>
    `;
}

function generateUserRegisterHtml(error = null) {
    return generateLoginHtml(null, error, 'register');
}

function generateRegisterHtml(error = null) {
    const safeError = error ? escapeHtml(String(error)) : '';
    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('Bloret PassPort - 注册')}</title>
        <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
<style>
      /* 修改.input-group的布局方式为flex */
      .input-group {
          display: flex;
          align-items: center; /* 垂直居中 */
          margin-bottom: 20px; /* 保持原有间距 */
      }

      /* 调整输入框宽度使其与标签并排 */
      .input-group input {
          width: 80%; /* 从100%改为80% */
          padding: 8px 12px;
          margin: 4px 0;
          border: 1.5px solid rgba(255,255,255,0.45);
          border-radius: 8px;
          background-color: rgba(255,255,255,0.35);
          box-shadow: 0 4px 10px rgba(31, 38, 135, 0.2), 0 2px 12px 0 rgba(255, 255, 255, 0.2) inset;
          transition: box-shadow 0.18s, border 0.18s, background 0.18s;
          backdrop-filter: blur(14px) saturate(180%);
          -webkit-backdrop-filter: blur(14px) saturate(180%);
          color: black; /* 输入框内文字颜色为黑色 */
      }

      .input-group input:hover {
          background-color: rgba(255,255,255,0.55);
          border: 1.5px solid rgba(255,255,255,0.65);
          box-shadow: 0 6px 20px rgba(31, 38, 135, 0.35), 0 3px 16px 0 rgba(255, 255, 255, 0.35) inset;
      }

      .input-group input:focus {
          outline: none;
          background-color: rgba(255,255,255,0.55);
          border: 1.5px solid rgba(255,255,255,0.65);
          box-shadow: 0 6px 20px rgba(31, 38, 135, 0.35), 0 3px 16px 0 rgba(255, 255, 255, 0.35) inset;
      }

      /* 为表单标签添加右侧间距 */
      .input-group label {
          color: black;
          margin-right: 10px; /* 右侧间距 */
          min-width: 7ch; /* 确保至少7个字符宽度的空间 */
      }

      /* 新增表单标签文字颜色 */
      .input-group label {
          color: black; /* 表单标签文字颜色为黑色 */
      }
      
      /* 页面居中容器 */
      .center-container {
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          width: 100%;
          padding: 20px;
          box-sizing: border-box;
      }
      
      /* 卡片容器 */
      .cards-container {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: var(--blora-space-5);
          width: min(100%, 700px);
      }
      .post.blora-card {
          flex: 1 1 300px;
          min-width: 0;
          max-width: 300px;
          box-sizing: border-box;
      }
      
      @media (max-width: 768px) {
          .cards-container {
              flex-direction: column;
          }
          
          .card {
              min-width: unset;
              max-width: 100%;
          }
      }
      
      /* 错误消息样式 */
      .error-message {
          color: #ff4444;
          background-color: rgba(255, 255, 255, 0.35);
          padding: 10px;
          border-radius: 8px;
          margin-bottom: 20px;
          text-align: center;
      }
    </style>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope registration-page">
    <div class="center-container">
        <div class="cards-container">
            <div class="post blora-card">
                <h2 style="color: #fff; text-align: center; margin-top: 0;">${t('用户注册')}</h2>
                ${safeError ? `<div class="error-message">${safeError}</div>` : ''}
                <form id="registerForm" action="/register" method="POST">
                    <div class="input-group">
                        <label for="username">${t('用户名:')}</label>
                        <input class="blora-input" id="username" name="username" type="text" placeholder="${t('用户名')}" required >
                    </div>
                    <div class="input-group">
                        <label for="email">${t('邮箱:')}</label>
                        <input class="blora-input" id="email" name="email" type="email" placeholder="${t('邮箱')}" required >
                    </div>
                    <div class="input-group">
                        <label for="password">${t('密码:')}</label>
                        <input class="blora-input" id="password" name="password" type="password" placeholder="${t('密码')}" required >
                    </div>
                    <div class="input-group">
                        <label for="confirmPassword">${t('确认密码:')}</label>
                        <input class="blora-input" id="confirmPassword" name="confirmPassword" type="password" placeholder="${t('确认密码')}" required >
                    </div>
                    <button class="blora-button" data-variant="primary" type="submit" style="width: 100%;" >${t('注册')}</button>
                </form>
                <div style="text-align: center; margin-top: 20px;">
                    <a href="/" style="color: white; text-decoration: none;">${t('返回登录')}</a>
                </div>
            </div>
        </div>
    </div>
    
    <script>
      document.getElementById('registerForm').addEventListener('submit', function(e) {
        const password = document.getElementById('password').value;
        const confirmPassword = document.getElementById('confirmPassword').value;
        if (password !== confirmPassword) {
          e.preventDefault();
          alert(${scriptJson(t('密码和确认密码不匹配！'))});
          return;
        }
        // 明文提交，由服务端 bcrypt 哈希
      });
    </script>
</body>
</html>
  `;
}

function generatePlainLoginHtml(redirectUri = null, error = null, csrfToken = '') {
    const safeRedirectUri = typeof redirectUri === 'string' && isSafeLoginRedirect(redirectUri) ? redirectUri : '';
    const escapedRedirectUri = escapeHtml(safeRedirectUri);
    const escapedError = error ? escapeHtml(String(error)) : '';
    const escapedCsrf = escapeHtml(String(csrfToken || ''));
    const redirectInput = safeRedirectUri ? `<input type="hidden" name="redirect_uri" value="${escapedRedirectUri}">` : '';
    const larkHref = `/oauth/lark/start${safeRedirectUri ? `?redirect_uri=${encodeURIComponent(safeRedirectUri)}` : ''}`;
    return `<!doctype html>
<html lang="${htmlLang()}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${t('简洁登录 - Bloret PassPort')}</title>
    <style>
        :root { color-scheme: light dark; font-family: system-ui, sans-serif; background: #f5f7fa; color: #172033; }
        @media (prefers-color-scheme: dark) { :root { background: #111827; color: #f3f4f6; } }
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1rem; box-sizing: border-box; }
        main { width: min(100%, 26rem); background: Canvas; color: CanvasText; border: 1px solid #d1d5db; border-radius: .75rem; padding: 2rem; box-sizing: border-box; }
        h1 { margin: 0 0 .5rem; font-size: 1.5rem; } p { color: GrayText; line-height: 1.5; }
        label { display: block; margin: 1rem 0 .35rem; font-weight: 600; } input { display: block; width: 100%; box-sizing: border-box; padding: .75rem; border: 1px solid #9ca3af; border-radius: .4rem; font: inherit; }
        button { width: 100%; margin-top: 1.25rem; padding: .75rem 1rem; border: 0; border-radius: .4rem; background: #2563eb; color: white; font: inherit; font-weight: 700; cursor: pointer; }
        .error { padding: .75rem; border-radius: .4rem; background: #fee2e2; color: #991b1b; } .links { display: grid; gap: .75rem; margin-top: 1.25rem; text-align: center; } a { color: #2563eb; }
    </style>
</head>
<body><main>
    <h1>Bloret PassPort</h1>
    <p>${t('使用简洁登录页')}</p>
    ${escapedError ? `<p class="error" role="alert">${escapedError}</p>` : ''}
    <form action="/login" method="POST">
        ${redirectInput}
        <input type="hidden" name="simple_login" value="1">
        <input type="hidden" name="_csrf" value="${escapedCsrf}">
        <label for="plain-username">${t('用户名')}</label>
        <input id="plain-username" name="username" type="text" autocomplete="username" required>
        <label for="plain-password">${t('密码')}</label>
        <input id="plain-password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">${t('登录')}</button>
    </form>
    <div class="links"><a href="${escapeHtml(larkHref)}">${t('飞书登录')}</a><a href="/forgot-password">${t('忘记密码？')}</a><a href="/">${t('返回标准登录页')}</a></div>
</main></body>
</html>`;
}

function generatePlain2FALoginHtml(username, error = null, csrfToken = '') {
    const escapedError = error ? escapeHtml(String(error)) : '';
    const escapedCsrf = escapeHtml(String(csrfToken || ''));
    return `<!doctype html>
<html lang="${htmlLang()}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${t('简洁双重认证 - Bloret PassPort')}</title>
    <style>
        :root { font-family: system-ui, sans-serif; background: #f5f7fa; color: #172033; } body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1rem; box-sizing: border-box; }
        main { width: min(100%, 26rem); background: Canvas; color: CanvasText; border: 1px solid #d1d5db; border-radius: .75rem; padding: 2rem; box-sizing: border-box; } h1 { margin: 0 0 .5rem; font-size: 1.5rem; } p { color: GrayText; line-height: 1.5; }
        label { display: block; margin: 1rem 0 .35rem; font-weight: 600; } input { width: 100%; box-sizing: border-box; padding: .75rem; border: 1px solid #9ca3af; border-radius: .4rem; font: inherit; text-align: center; letter-spacing: .4rem; font-size: 1.4rem; } button { width: 100%; margin-top: 1.25rem; padding: .75rem; border: 0; border-radius: .4rem; background: #2563eb; color: white; font: inherit; font-weight: 700; } .error { padding: .75rem; border-radius: .4rem; background: #fee2e2; color: #991b1b; }
    </style>
</head>
<body><main>
    <h1>${t('双重认证')}</h1><p>${t('请验证您的身份')}</p>
    ${escapedError ? `<p class="error" role="alert">${escapedError}</p>` : ''}
    <form id="plainTwoFaVerifyForm" action="/login/2fa/verify" method="POST">
        <input type="hidden" name="simple_login" value="1"><input type="hidden" name="_csrf" value="${escapedCsrf}">
        <label for="plain-token">${t('六位验证码')}</label>
        <input id="plain-token" name="token" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>
        <button type="submit">${t('验证令牌')}</button>
    </form>
    <p><a href="/logout">${t('取消登录')}</a></p>
</main>
<script>
const form = document.getElementById('plainTwoFaVerifyForm');
const token = document.getElementById('plain-token');
let submitted = false;
token.addEventListener('input', () => {
    if (!submitted && /^[0-9]{6}$/.test(token.value)) { submitted = true; form.submit(); }
});
</script>
</body></html>`;
}

// --- 忘记密码 / 重置密码 ---
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const PASSWORD_RESET_TOKEN_RE = /^[a-f0-9]{64}$/i;

function isValidPasswordResetToken(token) {
    return typeof token === 'string' && PASSWORD_RESET_TOKEN_RE.test(token);
}

function generateAuthFooter(langPath, extraParams = {}) {
    const langLabels = { zh: '中文', en: 'English', ru: 'Русский' };
    const langHref = (code) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(extraParams)) {
            if (value) params.set(key, value);
        }
        params.set('lang', code);
        return `${langPath}?${params.toString()}`;
    };
    return `
            <footer class="auth-card__footer">
                <blora-palette-picker button-variant="ghost" size="sm" icon-only></blora-palette-picker>
                <blora-dropdown class="auth-lang" label="${langLabels[currentLang()] || '中文'}" align="center" aria-label="${t('选择语言')}">
                    <blora-dropdown-item value="zh" href="${escapeHtml(langHref('zh'))}">中文</blora-dropdown-item>
                    <blora-dropdown-item value="en" href="${escapeHtml(langHref('en'))}">English</blora-dropdown-item>
                    <blora-dropdown-item value="ru" href="${escapeHtml(langHref('ru'))}">Русский</blora-dropdown-item>
                </blora-dropdown>
                <blora-color-scheme-toggle button-variant="ghost" size="sm"></blora-color-scheme-toggle>
            </footer>`;
}

function generateAuthPageDocument({ title, description, content, footerPath, footerParams = {}, noReferrer = false }) {
    return `<!doctype html>
<html lang="${htmlLang()}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${noReferrer ? '<meta name="referrer" content="no-referrer">' : ''}
    <title>${escapeHtml(title)} - Bloret PassPort</title>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <link rel="stylesheet" href="/index.css">
${bloraAssetTags()}
</head>
<body class="blora-page blora-scope">
    <main class="auth-page">
        <section class="blora-card auth-card">
            <header class="auth-card__header">
                <span class="auth-card__logo" aria-hidden="true"><img src="/BL.png" alt=""></span>
                <h1>Bloret PassPort</h1>
                <p>${escapeHtml(description)}</p>
            </header>
            ${content}
            ${generateAuthFooter(footerPath, footerParams)}
        </section>
    </main>
</body>
</html>`;
}

function generateForgotPasswordHtml({ sent = false, email = '', error = '', csrfToken = '' } = {}) {
    const content = `
            ${sent ? `<blora-alert variant="success" title="${escapeHtml(t('邮件已发送'))}" description="${escapeHtml(t('如果该邮箱已注册，我们已发送重置链接。请检查收件箱和垃圾邮件。'))}"></blora-alert>` : ''}
            ${error ? `<blora-alert variant="danger" title="${escapeHtml(error)}"></blora-alert>` : ''}
            <form class="auth-form" action="/forgot-password" method="POST">
                <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
                <div class="blora-field">
                    <label class="blora-field__label" for="forgot-email">${t('注册邮箱')}</label>
                    <input class="blora-input" id="forgot-email" name="email" type="email" autocomplete="email" placeholder="${escapeHtml(t('请输入邮箱'))}" value="${escapeHtml(email)}" required>
                </div>
                <div class="auth-actions">
                    <button class="blora-button" data-variant="primary" type="submit">${t('发送重置链接')}</button>
                </div>
            </form>
            <p class="auth-simple-link"><a href="/">${t('返回登录')}</a></p>`;
    return generateAuthPageDocument({
        title: t('重置密码'),
        description: t('输入注册邮箱，我们会发送重置链接。'),
        content,
        footerPath: '/forgot-password'
    });
}

function generateResetPasswordHtml({ token = '', invalid = false, error = '', csrfToken = '' } = {}) {
    let content;
    if (invalid) {
        content = `
            <blora-alert variant="danger" title="${escapeHtml(t('重置链接无效或已过期'))}" description="${escapeHtml(error || t('请重新获取重置链接。'))}"></blora-alert>
            <div class="auth-actions">
                <a class="blora-button" data-variant="primary" href="/forgot-password">${t('重新获取重置链接')}</a>
                <a class="blora-button" data-variant="outline" href="/">${t('返回登录')}</a>
            </div>`;
    } else {
        content = `
            ${error ? `<blora-alert variant="danger" title="${escapeHtml(error)}"></blora-alert>` : ''}
            <form class="auth-form" action="/reset-password" method="POST">
                <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
                <input type="hidden" name="token" value="${escapeHtml(token)}">
                <div class="blora-field">
                    <label class="blora-field__label" for="reset-password-field">${t('新密码')}</label>
                    <input class="blora-input" id="reset-password-field" name="newPassword" type="password" autocomplete="new-password" placeholder="${escapeHtml(t('请输入密码'))}" minlength="6" required>
                    <span class="blora-field__help">${t('密码至少 6 位')}</span>
                </div>
                <div class="blora-field">
                    <label class="blora-field__label" for="reset-confirm-field">${t('确认新密码')}</label>
                    <input class="blora-input" id="reset-confirm-field" name="confirmPassword" type="password" autocomplete="new-password" placeholder="${escapeHtml(t('请再次输入密码'))}" minlength="6" required>
                </div>
                <div class="auth-actions">
                    <button class="blora-button" data-variant="primary" type="submit">${t('更新密码')}</button>
                </div>
            </form>`;
    }
    return generateAuthPageDocument({
        title: t('重置密码'),
        description: invalid ? t('此重置链接已无法使用。') : t('设置一个新密码。'),
        content,
        footerPath: '/reset-password',
        footerParams: invalid ? {} : { token },
        noReferrer: true
    });
}

function generateResetPasswordSuccessHtml() {
    const content = `
            <blora-result variant="success" title="${escapeHtml(t('密码已更新'))}" description="${escapeHtml(t('所有设备已退出登录，请使用新密码重新登录。'))}"></blora-result>
            <div class="auth-actions">
                <a class="blora-button" data-variant="primary" href="/">${t('前往登录')}</a>
            </div>`;
    return generateAuthPageDocument({
        title: t('密码已更新'),
        description: t('密码重置完成。'),
        content,
        footerPath: '/'
    });
}

function generatePasswordResetEmailHtml(resetUrl) {
    const escapedUrl = escapeHtml(resetUrl);
    return `<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('Bloret PassPort - 重置密码')}</title>
</head>
<body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #323130; max-width: 600px; margin: 0 auto; padding: 20px;">
    <h2 style="color: #0078d4;">${t('重置您的 Bloret PassPort 密码')}</h2>
    <p>${t('您正在重置 Bloret PassPort 账户的密码。请点击下面的按钮设置新密码：')}</p>
    <p><a href="${escapedUrl}" style="display: inline-block; padding: 12px 24px; background-color: #0078d4; color: #ffffff; text-decoration: none; border-radius: 4px; font-weight: bold;">${t('设置新密码')}</a></p>
    <p>${t('如果按钮无法点击，也可以复制以下链接到浏览器地址栏：')}</p>
    <p style="word-break: break-all;"><a href="${escapedUrl}">${escapedUrl}</a></p>
    <p style="color: #605e5c; font-size: 14px;">${t('此链接将在30分钟后过期。如果您没有请求重置密码，请忽略此邮件。')}</p>
</body>
</html>`;
}

function generateLoginHtml(redirectUri = null, error = null, mode = 'login', simpleLoginHref = '/plain-login') {
    const authMode = mode === 'register' ? 'register' : 'login';
    const escapedRedirectUri = escapeHtml(redirectUri || '');
    const escapedError = escapeHtml(error || '');
    const redirectInput = redirectUri ? `<input type="hidden" name="redirect_uri" id="passkey_redirect" value="${escapedRedirectUri}">` : '';
    const loginInvalid = authMode === 'login' && error;
    const githubClientId = (config.oauth && config.oauth.github && config.oauth.github.client_id) || '';
    const githubAuthUrl = '/oauth/github/start' + (redirectUri ? '?redirect_uri=' + encodeURIComponent(redirectUri) : '');
    const lang = currentLang();
    const langLabels = { zh: '中文', en: 'English', ru: 'Русский' };
    const langPath = authMode === 'register' ? '/register/user' : '/';
    const langHref = (code) => {
        const params = new URLSearchParams();
        params.set('lang', code);
        if (redirectUri) params.set('redirect_uri', redirectUri);
        return `${langPath}?${params.toString()}`;
    };
    const lucideIcon = (inner) =>
        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
    const keyIcon = lucideIcon('<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>');
    const buildingIcon = lucideIcon('<path d="M10 12h4"/><path d="M10 8h4"/><path d="M14 21v-3a2 2 0 0 0-4 0v3"/><path d="M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2"/><path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/>');
    const githubMark = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.207 10.387.6.113.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.5 11.5 0 0 1 12 5.8c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12 24 5.37 18.627 0 12 0z"/></svg>';

    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${authMode === 'register' ? t('Bloret PassPort - 用户注册') : 'Bloret PassPort'}</title>
    <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
    <script src="/webauthn-browser.js"></script>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope">
    <main class="auth-page">
        <section class="blora-card auth-card">
            <header class="auth-card__header">
                <span class="auth-card__logo" aria-hidden="true"><img src="/BL.png" alt=""></span>
                <h1>Bloret PassPort</h1>
                <p>${t('使用你的 Bloret 账户继续')}</p>
            </header>

            <div class="auth-mode auth-native-tabs" role="tablist" aria-label="${t('登录或注册')}">
                <button class="auth-native-tab" type="button" role="tab" aria-controls="loginPanel" aria-selected="${authMode === 'login' ? 'true' : 'false'}" data-auth-mode="login">${t('登录')}</button>
                <button class="auth-native-tab" type="button" role="tab" aria-controls="registerPanel" aria-selected="${authMode === 'register' ? 'true' : 'false'}" data-auth-mode="register">${t('注册')}</button>
            </div>
            <section id="loginPanel" role="tabpanel"${authMode === 'login' ? '' : ' hidden'}>
                ${loginInvalid ? `<blora-alert variant="danger" title="${escapedError}"></blora-alert>` : ''}
                <form id="loginForm" action="/login" method="POST">
                    ${redirectInput}
                    <div class="blora-field"><label class="blora-field__label" for="login-username-field">${t('用户名')}</label><input class="blora-input" id="login-username-field" name="username" type="text" autocomplete="username" placeholder="${t('请输入用户名')}" required></div>
                    <div class="blora-field"><label class="blora-field__label" for="login-password-field">${t('密码')}</label><input class="blora-input" id="login-password-field" name="password" type="password" autocomplete="current-password" placeholder="${t('请输入密码')}" required${loginInvalid ? ' aria-invalid="true"' : ''}></div>
                    <div class="auth-forgot"><a href="/forgot-password">${t('忘记密码？')}</a></div>
                    <div class="auth-actions">
                        <button class="blora-button" data-variant="primary" type="submit">${t('登录')}</button>
                        <button class="blora-button" data-variant="outline" type="button" onclick="loginWithPassKey()">${keyIcon}${t('使用通行密钥登录')}</button>
                    </div>
                </form>
            </section>
            <section id="registerPanel" role="tabpanel"${authMode === 'register' ? '' : ' hidden'}>
                ${authMode === 'register' && error ? `<blora-alert variant="danger" title="${escapedError}"></blora-alert>` : ''}
                <form id="registerForm" action="/register/user" method="POST">
                    <div class="blora-field"><label class="blora-field__label" for="register-username-field">${t('用户名')}</label><input class="blora-input" id="register-username-field" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="${t('请输入用户名')}" required pattern="[a-z0-9_]+" title="${t('仅允许小写字母、数字和下划线')}"><span class="blora-field__help">${t('仅允许小写字母、数字和下划线')}</span></div>
                    <div class="blora-field"><label class="blora-field__label" for="register-nickname-field">${t('昵称')}</label><input class="blora-input" id="register-nickname-field" name="nickname" type="text" autocomplete="nickname" placeholder="${t('留空则同用户名')}"></div>
                    <div class="blora-field"><label class="blora-field__label" for="register-email-field">${t('邮箱')}</label><input class="blora-input" id="register-email-field" name="email" type="email" autocomplete="email" placeholder="${t('请输入邮箱')}" required></div>
                    <div class="blora-field"><label class="blora-field__label" for="register-password-field">${t('密码')}</label><input class="blora-input" id="register-password-field" name="password" type="password" autocomplete="new-password" placeholder="${t('请输入密码')}" required minlength="6"></div>
                    <div class="blora-field"><label class="blora-field__label" for="register-confirm-field">${t('确认密码')}</label><input class="blora-input" id="register-confirm-field" name="confirmPassword" type="password" autocomplete="new-password" placeholder="${t('请再次输入密码')}" required minlength="6"></div>
                    <div class="auth-actions">
                        <button class="blora-button" data-variant="primary" type="submit">${t('注册')}</button>
                    </div>
                </form>
            </section>

            <div class="blora-divider" data-variant="text">${t('或使用其他方式')}</div>
            <div class="auth-oauth">
                <button class="blora-button" data-variant="outline" type="button" onclick="window.location.href='/oauth/lark/start${redirectUri ? `?redirect_uri=${encodeURIComponent(redirectUri)}` : ''}'">${buildingIcon}${t('飞书登录')}</button>
                <button class="blora-button" data-variant="outline" type="button" onclick="window.location.href='${githubAuthUrl}'">${githubMark}${t('GitHub 登录')}</button>
            </div>
            <p class="auth-simple-link"><a href="${escapeHtml(simpleLoginHref)}">${t('使用简洁登录页')}</a></p>
            <footer class="auth-card__footer">
                <blora-palette-picker button-variant="ghost" size="sm" icon-only></blora-palette-picker>
                <blora-dropdown class="auth-lang" label="${langLabels[lang] || '中文'}" align="center" aria-label="${t('选择语言')}">
                    <blora-dropdown-item value="zh" href="${escapeHtml(langHref('zh'))}">中文</blora-dropdown-item>
                    <blora-dropdown-item value="en" href="${escapeHtml(langHref('en'))}">English</blora-dropdown-item>
                    <blora-dropdown-item value="ru" href="${escapeHtml(langHref('ru'))}">Русский</blora-dropdown-item>
                </blora-dropdown>
                <blora-color-scheme-toggle button-variant="ghost" size="sm"></blora-color-scheme-toggle>
            </footer>
        </section>
    </main>
    <script>
        let isLoggingIn = false;
        const mismatchText = ${scriptJson(t('密码和确认密码不匹配！'))};

        async function loginWithPassKey() {
            if (isLoggingIn) return;
            isLoggingIn = true;
            try {
                // 通行密钥使用可发现凭据，完全独立于用户名和密码输入框。
                const resp = await fetch('/api/passkey/login/options', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                if (!resp.ok) {
                    const errorData = await resp.json().catch(() => ({}));
                    throw new Error(errorData.error || (${scriptJson(t('服务器错误: {status}'))}.replace('{status}', resp.status)));
                }
                const opts = await resp.json();
                if (opts.error) throw new Error(opts.error);
                const authResp = await SimpleWebAuthnBrowser.startAuthentication(opts);
                const verifyResp = await fetch('/api/passkey/login/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ response: authResp, challenge: opts.challenge })
                });
                const result = await verifyResp.json();
                if (result.success) {
                    window.location.href = document.getElementById('passkey_redirect')?.value || '/';
                } else {
                    alert(${scriptJson(t('验证失败: {message}'))}.replace('{message}', result.error));
                }
            } catch (err) {
                console.error(err);
                if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
                    alert(${scriptJson(t('登录失败: {message}'))}.replace('{message}', err.message));
                }
            } finally {
                isLoggingIn = false;
            }
        }

        document.querySelectorAll('[data-auth-mode]').forEach(function (tab) {
            tab.addEventListener('click', function () {
                const mode = tab.getAttribute('data-auth-mode');
                document.querySelectorAll('[data-auth-mode]').forEach(function (item) {
                    item.setAttribute('aria-selected', String(item === tab));
                });
                document.getElementById('loginPanel').hidden = mode !== 'login';
                document.getElementById('registerPanel').hidden = mode !== 'register';
            });
        });

        document.getElementById('registerForm').addEventListener('submit', function (e) {
            const passwordField = document.getElementById('register-password-field');
            const confirmField = document.getElementById('register-confirm-field');
            const password = passwordField.value;
            const confirmPassword = confirmField.value;
            if (password !== confirmPassword) {
                e.preventDefault();
                confirmField.setAttribute('aria-invalid', 'true');
                return;
            }
            confirmField.removeAttribute('aria-invalid');
        });
    </script>
</body>
</html>
  `;
}

function generateRegisterHtml(error = null) {
    const safeError = error ? escapeHtml(String(error)) : '';
    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('Bloret PassPort - 注册')}</title>
        <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
    <style>
      /* 修改.input-group的布局方式为flex */
      .input-group {
          display: flex;
          align-items: center; /* 垂直居中 */
          margin-bottom: 20px; /* 保持原有间距 */
      }

      /* 调整输入框宽度使其与标签并排 */
      .input-group input {
          width: 80%; /* 从100%改为80% */
          padding: 8px 12px;
          margin: 4px 0;
          border: 1.5px solid rgba(255,255,255,0.45);
          border-radius: 8px;
          background-color: rgba(255,255,255,0.35);
          box-shadow: 0 4px 10px rgba(31, 38, 135, 0.2), 0 2px 12px 0 rgba(255, 255, 255, 0.2) inset;
          transition: box-shadow 0.18s, border 0.18s, background 0.18s;
          backdrop-filter: blur(14px) saturate(180%);
          -webkit-backdrop-filter: blur(14px) saturate(180%);
          color: black; /* 输入框内文字颜色为黑色 */
      }

      .input-group input:hover {
          background-color: rgba(255,255,255,0.55);
          border: 1.5px solid rgba(255,255,255,0.65);
          box-shadow: 0 6px 20px rgba(31, 38, 135, 0.35), 0 3px 16px 0 rgba(255, 255, 255, 0.35) inset;
      }

      .input-group input:focus {
          outline: none;
          background-color: rgba(255,255,255,0.55);
          border: 1.5px solid rgba(255,255,255,0.65);
          box-shadow: 0 6px 20px rgba(31, 38, 135, 0.35), 0 3px 16px 0 rgba(255, 255, 255, 0.35) inset;
      }

      /* 为表单标签添加右侧间距 */
      .input-group label {
          color: black;
          margin-right: 10px; /* 右侧间距 */
          min-width: 7ch; /* 确保至少7个字符宽度的空间 */
      }

      /* 新增表单标签文字颜色 */
      .input-group label {
          color: black; /* 表单标签文字颜色为黑色 */
      }
      
      /* 页面居中容器 */
      .center-container {
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          width: 100%;
          padding: 20px;
          box-sizing: border-box;
      }
      
      /* 卡片容器 */
      .cards-container {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: var(--blora-space-5);
          width: min(100%, 700px);
      }
      .post.blora-card {
          flex: 1 1 300px;
          min-width: 0;
          max-width: 300px;
          box-sizing: border-box;
      }
      
      @media (max-width: 768px) {
          .cards-container {
              flex-direction: column;
          }
          
          .card {
              min-width: unset;
              max-width: 100%;
          }
      }
      
      /* 错误消息样式 */
      .error-message {
          color: #ff4444;
          background-color: rgba(255, 255, 255, 0.35);
          padding: 10px;
          border-radius: 8px;
          margin-bottom: 20px;
          text-align: center;
      }
    </style>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope">
    <div class="center-container">
        <div class="post blora-card">
            <h2 style="color: #fff; text-align: center; margin-top: 0;">${t('注册 OAuth App')}</h2>
            
            ${safeError ? `<div class="error-message">${safeError}</div>` : ''}
            
            <form action="/register/oauthapp" method="POST">
                <div class="form-group">
                    <label class="form-label" for="name">${t('应用名称 *')}</label>
                    <input class="blora-input form-input" id="name" name="name" type="text" required >
                </div>

                <div class="form-group">
                    <label class="form-label" for="description">${t('应用描述 *')}</label>
                    <input class="blora-input form-input" id="description" name="description" type="text" required >
                </div>

                <div class="form-group">
                    <label class="form-label" for="icon">${t('图标URL *')}</label>
                    <input class="blora-input form-input" id="icon" name="icon" type="text" required >
                </div>

                <!-- 隐藏官方应用选择框，直接设置为false -->
                <input type="hidden" id="official" name="official" value="false">

                <div class="form-group">
                    <label class="form-label">${t('权限 *')}</label>
                    <div class="permission-checkboxes">
                        <div class="permission-checkbox-item">
                            <blora-checkbox id="perm_name" name="permissions" value="user:name">${t('用户名称 (user:name)')}</blora-checkbox>
                        </div>
                        <div class="permission-checkbox-item">
                            <blora-checkbox id="perm_head" name="permissions" value="user:head">${t('用户头像 (user:head)')}</blora-checkbox>
                        </div>
                        <div class="permission-checkbox-item">                        </div>
                        <div class="permission-checkbox-item">
                            <blora-checkbox id="perm_email" name="permissions" value="user:email">${t('用户邮箱 (user:email)')}</blora-checkbox>
                        </div>
                        <div class="permission-checkbox-item">
                            <span style="color:#888; font-size: 13px;">${t('* 管理员权限 (user:admin) 需联系管理员申请')}</span>
                        </div>
                        <div class="permission-checkbox-item">
                            <blora-checkbox id="perm_app_usertoken" name="permissions" value="app:usertoken">${t('生成长期用户令牌 (仅此应用可用) (app:usertoken)')}</blora-checkbox>
                        </div>
                        <div class="permission-checkbox-item">
                            <blora-checkbox id="perm_tags" name="permissions" value="user:tags">${t('用户标签 (user:tags)')}</blora-checkbox>
                        </div>
                    </div>

                </div>
                
                <div class="form-group">
                    <label class="form-label" for="redirect_uri">${t('重定向URI (每行一个)')}</label>
                    <textarea class="blora-textarea form-textarea" id="redirect_uri" name="redirect_uri" style="width:100%" ></textarea>
                </div>
                
                <button class="blora-button" data-variant="primary" type="submit" style="width: 100%;" >${t('注册应用')}</button>
            </form>
            
            <div style="text-align: center; margin-top: 20px;">
                <a href="/" style="color: white; text-decoration: none;">${t('返回首页')}</a>
            </div>
        </div>
    </div>

</body>
</html>
  `;
}

function getActionTypeDisplay(actionType) {
    const actionTypeMap = {
        'login': t('用户登录'), 'login_failed': t('登录失败'), 'login_2fa_pending': t('登录二次验证(待验证)'),
        '2fa_enable_failed': t('恢复双重认证失败'), '2fa_disable_failed': t('暂时关闭双重认证失败'),
        'login_2fa_success': t('二次验证(TOTP)成功'), 'login_2fa_failed': t('二次验证(TOTP)失败'),
        'login_2fa_passkey_success': t('二次验证(通行密钥)成功'), 'login_2fa_app_success': t('二次验证(手机应用)成功'),
        '2fa_app_action': t('手机应用验证操作'), 'logout': t('退出登录'),
        '2fa_enabled': t('开启双重认证'), '2fa_disabled': t('关闭双重认证'),
        'change_password': t('修改密码'), 'change_password_failed': t('修改密码失败'),
        'update_avatar': t('更新头像'),
        'admin_send_email': t('群发邮件'), 'register': t('注册成功'), 'register_failed': t('注册失败'),
        'email_verified': t('邮箱验证成功'), 'email_verification_failed': t('邮箱验证失败'),
        'oauth_authorize': t('OAuth 授权'), 'oauth_auto_authorize': t('OAuth 自动授权'),
        'oauth_deny': t('OAuth 拒绝授权'), 'oauth_auto_auth_enabled': t('开启 OAuth 自动授权'),
        'github_login': t('GitHub 登录'), 'github_login_2fa_pending': t('GitHub 登录二次验证(待验证)'),
        'lark_login': t('飞书登录'), 'lark_login_2fa_pending': t('飞书登录二次验证(待验证)'),
        'register_oauth_app': t('注册 OAuth 应用'), 'register_oauth_app_failed': t('注册 OAuth 应用失败'),
        'edit_oauth_app': t('编辑 OAuth 应用'),
        'save_app_data': t('保存应用数据'), 'save_app_data_failed': t('保存应用数据失败'),
        'read_app_data': t('读取应用数据'), 'read_app_data_not_found': t('读取应用数据(未找到)'),
        'delete_app_data': t('删除应用数据'), 'delete_app_data_failed': t('删除应用数据失败'),
        'set_tags': t('修改用户标签'), 'delete_user': t('删除用户'), 'reset_ai_quota': t('重置 AI 额度'),
        'passkey_reg': t('注册通行密钥'), 'passkey_login': t('通行密钥登录'), 'passkey_delete': t('删除通行密钥'),
        'passkey_rename': t('重命名通行密钥'),
        'minecraft_bind': t('绑定 Minecraft 账号'), 'minecraft_bind_offline': t('绑定离线 Minecraft 账号'),
        'minecraft_remove': t('移除 Minecraft 账号'), 'read_minecraft_accounts': t('读取 Minecraft 账号列表')
    };
    return actionTypeMap[actionType] || actionType;
}

function formatProfileLogTime(ts) {
    const date = new Date(Number(ts));
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const locale = htmlLang();
    const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfThat = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayDiff = Math.round((startOfToday - startOfThat) / 86400000);
    if (dayDiff === 0) return t('今天 {time}', { time });
    if (dayDiff === 1) return t('昨天 {time}', { time });
    return date.toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function profileLogStatus(type) {
    const key = String(type || '');
    if (/fail|deny|not_found/i.test(key)) return { variant: 'danger', label: t('失败') };
    if (/pending/i.test(key)) return { variant: 'warning', label: t('待验证') };
    return { variant: 'success', label: t('成功') };
}

function profileLogIcon(type) {
    const key = String(type || '');
    if (/passkey/.test(key)) return 'key-round';
    if (/password/.test(key)) return 'lock-keyhole';
    if (/2fa/.test(key)) return 'shield-check';
    if (/oauth|github|lark/.test(key)) return 'link';
    if (/logout/.test(key)) return 'log-out';
    if (/login/.test(key)) return 'log-in';
    if (/avatar/.test(key)) return 'image';
    if (/minecraft/.test(key)) return 'gamepad';
    if (/email/.test(key)) return 'mail';
    return 'activity';
}

function renderLogTimelineItem(log, timeText) {
    const status = profileLogStatus(log.type);
    const title = escapeHtml(getActionTypeDisplay(log.type));
    const ip = log.ip ? escapeHtml(String(log.ip)) : '';
    const message = log.message ? escapeHtml(String(log.message)) : '';
    const time = timeText || formatProfileLogTime(log.time);
    const desc = [message, time, ip].filter(Boolean).join(' · ');
    return `<blora-timeline-item icon="${profileLogIcon(log.type)}" content-layout="block">
                <div class="passport-log">
                    <div class="passport-log__row">
                        <strong class="passport-log__title">${title}</strong>
                        <span class="blora-badge" data-variant="${status.variant}">${escapeHtml(status.label)}</span>
                    </div>
                    ${desc ? `<span class="passport-log__desc">${desc}</span>` : ''}
                </div>
            </blora-timeline-item>`;
}

function lucideStatusIcon(on) {
    const icon = on ? 'check' : 'x';
    const variant = on ? 'success' : 'danger';
    const label = on ? t('是') : t('否');
    return `<span class="passport-bool" data-icon="${icon}" data-variant="${variant}" role="img" aria-label="${escapeHtml(label)}"></span>`;
}

function renderProfileActivity(logs) {
    if (!Array.isArray(logs) || logs.length === 0) {
        return `<blora-empty title="${escapeHtml(t('暂无操作记录'))}" description="${escapeHtml(t('账户操作发生后，记录会显示在这里。'))}"></blora-empty>`;
    }
    return `<blora-timeline>${logs.slice(0, 5).map((log) => renderLogTimelineItem(log)).join('')}</blora-timeline>`;
}

function renderPasskeyList(user) {
    const passkeys = Array.isArray(user.passkeys) ? user.passkeys : [];
    if (!passkeys.length) {
        return `<p class="blora-text-muted passport-security-empty">${t('暂无绑定的通行密钥')}</p>`;
    }
    return `<div class="blora-card passkey-list-card" style="padding:0;overflow:hidden"><div class="blora-list passkey-list">${passkeys.map((pk) => {
        const id = String(pk.credentialID || '');
        const safeId = escapeHtml(id);
        const name = escapeHtml(pk.name || '');
        const shortId = id ? `${escapeHtml(id.substring(0, 12))}...` : 'Unknown';
        return `<div class="blora-list__item passkey-item" data-id="${safeId}" data-name="${name}">
            <div class="blora-list__meta pk-info">
                <div class="blora-list__title pk-name">${name || t('未命名通行密钥')}</div>
                <div class="blora-list__desc pk-id">ID: ${shortId}</div>
            </div>
            <div class="passkey-item__actions">
                <button type="button" class="blora-button" data-variant="outline" data-size="sm" onclick="renamePasskey('${safeId}')">${t('重命名')}</button>
                <button type="button" class="blora-button" data-variant="danger" data-size="sm" onclick="deletePasskey('${safeId}')">${t('删除')}</button>
            </div>
        </div>`;
    }).join('')}</div></div>`;
}

function renderTwoFaSetupDialog(user) {
    const isEnabled = Boolean(user.twoFactorEnabled);
    const hasSavedSecret = Boolean(user.totpSecret);
    const totpBody = isEnabled && hasSavedSecret ? `
        <div id="disable-flow">
            <p class="blora-text-muted">${t('双重认证已开启。您可以暂时关闭登录时的二次验证；原验证器配置会保留，之后恢复时无需重新扫描二维码。')}</p>
            <div class="passport-security-verify">
                <input class="blora-input" id="disable-pwd" type="password" autocomplete="current-password" placeholder="${t('输入当前密码')}">
                <blora-popconfirm id="disable2faConfirm" trigger="${t('暂时关闭 2FA')}" message="${t('确定要暂时关闭双重认证吗？这会降低账户安全性，但原验证器配置会保留，之后恢复无需重新配置。')}" confirm-label="${t('确认关闭')}" cancel-label="${t('取消')}"></blora-popconfirm>
            </div>
        </div>` : hasSavedSecret ? `
        <div id="restore-flow">
            <p class="blora-text-muted">${t('双重认证目前已暂时关闭。恢复时将使用之前保存的验证器配置，无需重新扫描二维码。')}</p>
            <div class="passport-security-verify">
                <input class="blora-input" id="restore-pwd" type="password" autocomplete="current-password" placeholder="${t('输入当前密码')}" aria-label="${t('输入当前密码')}">
                <button type="button" class="blora-button" data-variant="primary" id="restore-2fa-btn" onclick="restore2FA()">${t('恢复双重认证')}</button>
            </div>
        </div>` : `
        <div id="setup-intro">
            <p class="blora-text-muted">${t('使用 Google Authenticator、Microsoft Authenticator 或 iCloud 钥匙串生成一次性验证码，为您的账户增加一层保护。')}</p>
            <button type="button" class="blora-button" data-variant="primary" id="start-btn" onclick="startSetup()">${t('立即开启')}</button>
        </div>
        <div id="setup-steps" hidden>
            <div class="qr-section">
                <div class="qr-code">
                    <img id="qrcode-img" src="" width="150" height="150" alt="QR Code">
                </div>
                <div class="setup-instructions">
                    <div class="step-item">
                        <span class="step-num">1</span>
                        <span>${t('扫描左侧二维码，或手动输入密钥：')}</span>
                        <span id="secret-text" class="secret-key-box"></span>
                    </div>
                    <div class="step-item">
                        <span class="step-num">2</span>
                        <span>${t('输入应用生成的 6 位验证码：')}</span>
                        <div class="passport-security-verify">
                            <input class="blora-input" id="verify-token" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
                            <button type="button" class="blora-button" data-variant="primary" onclick="confirmEnable()">${t('验证并启用')}</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;

    return `<blora-dialog id="twoFaSetupDialog" size="lg">
        <span slot="title">${t('安全设置')}</span>
        <div class="passport-security-dialog">
            <section>
                <header class="blora-card__head">
                    <div>
                        <h3 class="blora-card__title">${t('双重认证')}</h3>
                    </div>
                    <span class="blora-badge" data-variant="${isEnabled ? 'success' : 'warning'}">${isEnabled ? t('已开启') : t('未开启')}</span>
                </header>
                ${totpBody}
            </section>
            <section>
                <header class="blora-card__head">
                    <div>
                        <h3 class="blora-card__title">${t('通行密钥')}</h3>
                        <p class="blora-card__description">${t('使用指纹、面部识别或硬件密钥登录，无需输入密码。')}</p>
                    </div>
                    <button type="button" class="blora-button" data-variant="outline" onclick="registerPassKey()">${t('添加新设备')}</button>
                </header>
                ${renderPasskeyList(user)}
            </section>
        </div>
    </blora-dialog>`;
}

// 生成用户页面的HTML
function generateUserPageHtml(user, recentLogs = []) {
    const avatarUrl = safeImageUrl(user.avatar, `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username || '')}&background=0078d4&color=fff&size=128`);
    const passkeyCount = user.passkeys ? user.passkeys.length : 0;
    const safeNickname = escapeHtml(displayName(user));
    const safeUsername = escapeHtml(String(user.username || ''));
    const safeEmail = user.email ? escapeHtml(String(user.email)) : '';
    const githubAuthUrl = '/oauth/github/start';
    const larkAuthUrl = '/oauth/lark/start';
    const tags = Array.isArray(user.tags) ? user.tags.filter(Boolean) : [];
    const tagHtml = tags.length
        ? tags.map((tag, index) => `<span class="blora-tag" data-variant="${index === 0 ? 'primary' : 'info'}">${escapeHtml(String(tag))}</span>`).join('')
        : `<span class="blora-text-muted">${t('无')}</span>`;
    const githubId = user.github ? String(user.github) : '';
    const larkId = user.lark ? String(user.lark) : '';

    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bloret PassPort</title>
    <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
    <script src="/blora-message-layer.js"></script>
        <script src="/webauthn-browser.js"></script>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope">
    ${generateSidebarHtml(user, 'home')}


    <div class="main-content-apple">
        <div class="user-info-row">
            <section class="blora-card passport-profile">
                <div class="passport-avatar" onclick="document.getElementById('avatar-upload').click()" title="${t('点击更换头像')}">
                    <span class="blora-avatar" data-size="xl">
                        <img src="${escapeHtml(avatarUrl)}" id="current-avatar" alt="${escapeHtml(t('{name} 的头像', { name: displayName(user) }))}">
                    </span>
                    <div class="avatar-overlay"><span>${t('更换头像')}</span></div>
                    <input type="file" id="avatar-upload" hidden accept="image/*" onchange="handleAvatarUpload(this)">
                </div>
                <div class="passport-profile__meta">
                    <h1>${safeNickname}</h1>
                    <p class="blora-text-muted">@${safeUsername}</p>
                    ${tags.length ? `<div class="passport-profile__tags">${tagHtml}</div>` : ''}
                    <div id="avatar-loading" class="blora-text-muted" style="display:none; margin-top: var(--blora-space-2);">${t('正在上传...')}</div>
                </div>
            </section>

            <section class="blora-card">
                <header class="blora-card__head">
                    <div>
                        <h2 class="blora-card__title">${t('基本信息')}</h2>
                    </div>
                </header>
                <table class="blora-descriptions">
                    <tr><th>${t('昵称')}</th><td>${safeNickname}</td></tr>
                    <tr><th>${t('用户名')}</th><td>${safeUsername}</td></tr>
                    <tr><th>${t('邮箱')}</th><td>${safeEmail || t('未提供')}</td></tr>
                    ${user.admin ? `<tr><th>${t('管理员')}</th><td><span class="blora-badge" data-variant="success">${t('是')}</span></td></tr>` : ''}
                </table>
            </section>

            <section class="blora-card">
                <header class="blora-card__head">
                    <div>
                        <h2 class="blora-card__title">${t('账户安全')}</h2>
                        <p class="blora-card__description">${t('管理密码、通行密钥和双重认证。')}</p>
                    </div>
                    <button type="button" class="blora-button" data-variant="outline" onclick="showTwoFaSetupDialog()">${t('管理安全')}</button>
                </header>
                <table class="blora-descriptions">
                    <tr>
                        <th>${t('通行密钥')}</th>
                        <td>
                            <span class="blora-badge" data-variant="${passkeyCount > 0 ? 'success' : 'warning'}">${passkeyCount > 0 ? t('已绑定') : t('未绑定')}</span>
                            <span class="blora-text-muted">${t('{count} 个设备', { count: passkeyCount })}</span>
                        </td>
                    </tr>
                    <tr>
                        <th>${t('双重认证')}</th>
                        <td><span class="blora-badge" data-variant="${user.twoFactorEnabled ? 'success' : 'warning'}">${user.twoFactorEnabled ? t('已开启') : t('未开启')}</span></td>
                    </tr>
                </table>
                <div class="blora-card__foot passport-actions">
                    <button type="button" class="blora-button" data-variant="primary" onclick="showChangePasswordDialog()">${t('修改密码')}</button>
                    <button type="button" class="blora-button" data-variant="outline" onclick="registerPassKey()">${t('绑定通行密钥')}</button>
                </div>
            </section>

            <section class="blora-card">
                <header class="blora-card__head">
                    <div>
                        <h2 class="blora-card__title">${t('关联账号')}</h2>
                    </div>
                </header>
                <table class="blora-descriptions">
                    <tr>
                        <th>${t('GitHub ID')}</th>
                        <td>${githubId
                            ? `<blora-copy class="passport-id" text="${escapeHtml(githubId)}" label="${t('复制 GitHub ID')}">${escapeHtml(githubId)}</blora-copy>`
                            : `<span class="blora-text-muted">${t('未绑定')}</span>`}</td>
                    </tr>
                    <tr>
                        <th>Lark ID</th>
                        <td>${larkId
                            ? `<blora-copy class="passport-id" text="${escapeHtml(larkId)}" label="${t('复制 Lark ID')}">${escapeHtml(larkId)}</blora-copy>`
                            : `<span class="blora-text-muted">${t('未绑定')}</span>`}</td>
                    </tr>
                </table>
                <div class="blora-card__foot passport-linked-actions">
                    <button type="button" class="blora-button" data-variant="outline" onclick="window.location.href='${githubAuthUrl}'">${githubId ? t('修改 GitHub') : t('绑定 Github')}</button>
                    <button type="button" class="blora-button" data-variant="outline" onclick="window.location.href='${escapeHtml(larkAuthUrl)}'">${larkId ? t('修改飞书') : t('绑定飞书')}</button>
                </div>
            </section>

            <section class="blora-card passport-activity">
                <header class="blora-card__head">
                    <div>
                        <h2 class="blora-card__title">${t('操作日志')}</h2>
                        <p class="blora-card__description">${t('查看账户最近的安全和登录活动。')}</p>
                    </div>
                    <a class="blora-button" data-variant="outline" href="/logs" data-icon="arrow-right" data-icon-position="end">${t('查看全部')}</a>
                </header>
                ${renderProfileActivity(recentLogs)}
            </section>
        </div>
    </div>

<blora-dialog id="changePasswordDialog"  >
    <div style="padding: 24px; min-width: min(400px, 100%); box-sizing: border-box;">
        <h3 style="margin-top: 0; margin-bottom: 20px;">${t('修改密码')}</h3>
        <form id="changePasswordForm">
            <blora-field id="current-password-field" label="${t('当前密码')}" name="currentPassword" type="password" autocomplete="current-password" placeholder="${t('请输入当前密码')}" required></blora-field>
            <blora-field id="new-password-field" label="${t('新密码')}" name="newPassword" type="password" autocomplete="new-password" placeholder="${t('请输入新密码')}" required minlength="6"></blora-field>
            <blora-field id="confirm-new-password-field" label="${t('确认新密码')}" name="confirmNewPassword" type="password" autocomplete="new-password" placeholder="${t('请再次输入新密码')}" required minlength="6"></blora-field>
            <div style="display: flex; gap: 12px; justify-content: flex-end;">
                <button type="button" class="blora-button" data-variant="outline" onclick="hideChangePasswordDialog()" >${t('取消')}</button>
                <button class="blora-button" data-variant="primary" type="submit" >${t('确认修改')}</button>
            </div>
        </form>
    </div>
</blora-dialog>

${renderTwoFaSetupDialog(user)}

<script>
${sidebarScript}

async function showBloraMessage(text, type) {
    const { message } = await import('/blora/index.js');
    if (type === 'error') message.error(String(text || ''));
    else message.success(String(text || ''));
    const promote = globalThis.BloraMessageLayer && globalThis.BloraMessageLayer.promoteBloraMessageLayer;
    if (typeof promote === 'function') promote(document);
}

// 通行密钥注册
async function registerPassKey() {
    const deviceName = (prompt(${scriptJson(t('为此通行密钥命名（可选）'))}) || '').trim();
    try {
        const resp = await fetch('/api/passkey/register/options');
        if (!resp.ok) throw new Error(${scriptJson(t('获取注册选项失败'))});
        const opts = await resp.json();
        
        // 调用浏览器 API
        const attResp = await SimpleWebAuthnBrowser.startRegistration(opts);
        
        const verifyResp = await fetch('/api/passkey/register/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...attResp, name: deviceName })
        });
        
        const result = await verifyResp.json();
        if (result.success) {
            alert(${scriptJson(t('通行密钥绑定成功！'))});
            location.reload();
        } else {
            alert(${scriptJson(t('服务器验证失败: {message}'))}.replace('{message}', result.error));
        }
    } catch (err) {
        console.error(err);
        // 如果用户点击了“取消”，不需要弹窗报错
        if (err.name !== 'NotAllowedError') {
            alert(${scriptJson(t('操作失败: {message}'))}.replace('{message}', err.message));
        }
    }
}

// 处理头像上传
async function handleAvatarUpload(input) {
    if (input.files && input.files[0]) {
        const file = input.files[0];
        
        // 限制文件大小 (例如 5MB)
        if (file.size > 5 * 1024 * 1024) {
            alert(${scriptJson(t('图片大小不能超过 5MB'))});
            return;
        }

        const loadingEl = document.getElementById('avatar-loading');
        loadingEl.style.display = 'block';

        const formData = new FormData();
        formData.append('image', file);

        try {
            // 1. 上传到图床 (改为请求本站代理接口)
            const uploadRes = await fetch('/api/proxy/upload_avatar', {
                method: 'POST',
                body: formData
            });
            
            const uploadData = await uploadRes.json();
            
            if (uploadData.success && uploadData.data && uploadData.data.url) {
                // 拼接完整的 URL
                const fullAvatarUrl = 'https://img.bloret.net' + uploadData.data.url;
                
                // 2. 将 URL 保存到后端
                const updateRes = await fetch('/api/user/update_avatar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ avatarUrl: fullAvatarUrl })
                });
                
                const updateResult = await updateRes.json();
                
                if (updateResult.success) {
                    // 更新页面上的图片
                    document.getElementById('current-avatar').src = fullAvatarUrl;
                    loadingEl.style.display = 'none';
                    // 可选：刷新页面以确保所有地方都更新
                    // location.reload(); 
                } else {
                    throw new Error(updateResult.message || ${scriptJson(t('保存头像链接失败'))});
                }
            } else {
                throw new Error(uploadData.message || ${scriptJson(t('图床上传失败'))});
            }
        } catch (error) {
            console.error(${scriptJson(t('头像上传流程错误:'))}, error);
            alert(${scriptJson(t('上传失败: {message}'))}.replace('{message}', error.message));
            loadingEl.style.display = 'none';
        }
    }
}

// 显示修改密码对话框
function showChangePasswordDialog() {
    const dialog = document.getElementById('changePasswordDialog');
    dialog.show();
    document.getElementById('current-password-field').focus();
}

// 隐藏修改密码对话框
function hideChangePasswordDialog() {
    const dialog = document.getElementById('changePasswordDialog');
    dialog.close();
    document.getElementById('changePasswordForm').reset();
}

function showTwoFaSetupDialog() {
    const dialog = document.getElementById('twoFaSetupDialog');
    if (dialog) dialog.show();
}

function hideTwoFaSetupDialog() {
    const dialog = document.getElementById('twoFaSetupDialog');
    if (dialog) dialog.close();
}

(function openSecurityDialogFromQuery() {
    const params = new URLSearchParams(location.search);
    if (params.get('security') !== '1' && location.hash !== '#security') return;
    const open = () => showTwoFaSetupDialog();
    if (window.customElements && customElements.whenDefined) {
        customElements.whenDefined('blora-dialog').then(open);
    } else {
        open();
    }
    params.delete('security');
    const qs = params.toString();
    history.replaceState({}, '', '/' + (qs ? '?' + qs : '') + (location.hash === '#security' ? '' : location.hash));
})();

async function startSetup() {
    const btn = document.getElementById('start-btn');
    try {
        if (btn) btn.setAttribute('disabled', '');
        const res = await fetch('/api/2fa/generate', { method: 'POST' });
        const data = await res.json();
        if (data.qrcode) {
            document.getElementById('qrcode-img').src = data.qrcode;
            document.getElementById('secret-text').textContent = data.secret;
            document.getElementById('setup-intro').hidden = true;
            document.getElementById('setup-steps').hidden = false;
        }
    } catch (e) {
        alert(${scriptJson(t('获取二维码失败'))});
        if (btn) btn.removeAttribute('disabled');
    }
}

async function confirmEnable() {
    const token = document.getElementById('verify-token').value;
    if (!token) return alert(${scriptJson(t('请输入验证码'))});
    try {
        const res = await fetch('/api/2fa/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        const result = await res.json();
        if (result.success) {
            alert(${scriptJson(t('2FA 已成功开启！'))});
            location.reload();
        } else {
            alert(${scriptJson(t('验证失败: {message}'))}.replace('{message}', (result.error || ${scriptJson(t('验证码错误'))})));
        }
    } catch (e) {
        alert(${scriptJson(t('请求失败'))});
    }
}

async function restore2FA() {
    const passwordInput = document.getElementById('restore-pwd');
    const button = document.getElementById('restore-2fa-btn');
    const password = passwordInput?.value || '';
    if (!password) {
        await showBloraMessage(${scriptJson(t('请输入密码'))}, 'error');
        return;
    }
    if (!confirm(${scriptJson(t('确定要恢复双重认证吗？将使用之前保存的验证器配置，无需重新扫描二维码。'))})) return;
    if (button) button.disabled = true;
    try {
        const res = await fetch('/api/2fa/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        const result = await res.json();
        if (result.success) {
            await showBloraMessage(${scriptJson(t('双重认证已恢复'))}, 'success');
            location.reload();
        } else {
            await showBloraMessage(${scriptJson(t('恢复失败: {message}'))}.replace('{message}', (result.error || ${scriptJson(t('密码错误'))})), 'error');
        }
    } catch (e) {
        await showBloraMessage(${scriptJson(t('请求失败'))}, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

let disable2FAInFlight = false;

async function disable2FA() {
    const passwordInput = document.getElementById('disable-pwd');
    const confirmControl = document.getElementById('disable2faConfirm');
    const button = confirmControl?.querySelector('.blora-popconfirm__trigger');
    const password = passwordInput?.value || '';
    if (disable2FAInFlight) return;
    if (!password) {
        await showBloraMessage(${scriptJson(t('请输入密码'))}, 'error');
        return;
    }
    disable2FAInFlight = true;
    confirmControl?.setAttribute('disabled', '');
    if (button) button.disabled = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch('/api/2fa/disable', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': typeof window.getCsrfToken === 'function' ? window.getCsrfToken() : ''
            },
            credentials: 'same-origin',
            signal: controller.signal,
            body: JSON.stringify({ password })
        });
        let result;
        try {
            result = await res.json();
        } catch (_) {
            throw new Error(${scriptJson(t('服务器返回了无效响应'))});
        }
        if (!res.ok) throw new Error(result.error || result.message || ${scriptJson(t('请求失败'))});
        if (result.success) {
            await showBloraMessage(${scriptJson(t('双重认证已暂时关闭，原验证器配置已保留'))}, 'success');
            location.reload();
        } else {
            await showBloraMessage(${scriptJson(t('暂时关闭失败: {message}'))}.replace('{message}', (result.error || ${scriptJson(t('密码错误'))})), 'error');
        }
    } catch (e) {
        const message = e?.name === 'AbortError' ? ${scriptJson(t('请求超时，请稍后重试'))} : (e?.message || ${scriptJson(t('请求失败'))});
        await showBloraMessage(message, 'error');
    } finally {
        clearTimeout(timeout);
        disable2FAInFlight = false;
        confirmControl?.removeAttribute('disabled');
        if (button) button.disabled = false;
    }
}

const disable2faConfirm = document.getElementById('disable2faConfirm');
if (disable2faConfirm) {
    const bindDisable2FA = () => {
        const trigger = disable2faConfirm.querySelector('.blora-popconfirm__trigger');
        if (trigger) trigger.id = 'disable-2fa-btn';
    };
    bindDisable2FA();
    if (window.customElements?.whenDefined) customElements.whenDefined('blora-popconfirm').then(bindDisable2FA);
    disable2faConfirm.addEventListener('blora-confirm', disable2FA);
}

async function renamePasskey(id) {
    const li = document.querySelector('.passkey-item[data-id="' + id + '"]');
    const current = li ? (li.dataset.name || '') : '';
    const newName = (prompt(${scriptJson(t('重命名通行密钥'))}, current) || '').trim();
    if (newName === current) return;
    try {
        const resp = await fetch('/api/passkey/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, name: newName })
        });
        const result = await resp.json();
        if (result.success) {
            alert(${scriptJson(t('通行密钥已重命名'))});
            location.reload();
        } else {
            alert(${scriptJson(t('重命名失败: {message}'))}.replace('{message}', (result.error || ${scriptJson(t('未知错误'))})));
        }
    } catch (e) {
        alert(${scriptJson(t('请求失败'))});
    }
}

async function deletePasskey(id) {
    if (!confirm(${scriptJson(t('确定要删除此通行密钥吗？'))})) return;
    try {
        const resp = await fetch('/api/passkey/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        const result = await resp.json();
        if (result.success) {
            alert(${scriptJson(t('通行密钥已删除'))});
            location.reload();
        } else {
            alert(${scriptJson(t('删除失败: {message}'))}.replace('{message}', (result.error || ${scriptJson(t('未知错误'))})));
        }
    } catch (e) {
        alert(${scriptJson(t('请求失败'))});
    }
}

// 处理修改密码表单提交
document.getElementById('changePasswordForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    
    const currentPassword = document.getElementById('current-password-field').value;
    const newPassword = document.getElementById('new-password-field').value;
    const confirmNewPassword = document.getElementById('confirm-new-password-field').value;
    
    // 验证输入
    if (!currentPassword || !newPassword || !confirmNewPassword) {
        alert(${scriptJson(t('请填写所有密码字段'))});
        return;
    }
    
    if (newPassword !== confirmNewPassword) {
        alert(${scriptJson(t('新密码与确认密码不一致'))});
        return;
    }
    
    if (newPassword.length < 6) {
        alert(${scriptJson(t('新密码长度至少为6位'))});
        return;
    }
    
    try {
        // 直接发送明文密码，后端会处理加密
        const response = await fetch('/change-password', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                currentPassword: currentPassword,
                newPassword: newPassword
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert(${scriptJson(t('密码修改成功！'))});
            hideChangePasswordDialog();
        } else {
            alert(result.message || ${scriptJson(t('密码修改失败'))});
        }
    } catch (error) {
        console.error(${scriptJson(t('修改密码失败:'))}, error);
        alert(${scriptJson(t('修改密码时发生错误，请稍后重试'))});
    }
});
</script>

</body >
</html >
    `;
}

function generate2FALoginHtml(username, error = null) {
    const safeError = error ? escapeHtml(String(error)) : '';
    const safeUsername = escapeHtml(String(username || ''));
    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('双重认证 - Bloret PassPort')}</title>
    <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
    <script src="/webauthn-browser.js"></script>
    <style>
      .twofa-login-page { display: block !important; }
      .twofa-login-page .center-container { display: flex; justify-content: center; align-items: center; min-height: 100vh; width: 100vw; padding: var(--blora-space-5); box-sizing: border-box; }
      .twofa-card { width: 400px; max-width: 100%; box-sizing: border-box; }
      .input-token { text-align: center; font-size: 24px; letter-spacing: 8px; height: 52px; }
      .error-message { color: #ff4444; background: rgba(255,68,68,0.08); padding: 10px; border-radius: 8px; margin-bottom: 15px; text-align: center; font-size: 14px; }
      .divider { display: flex; align-items: center; text-align: center; margin: 20px 0; color: var(--blora-color-text-muted); font-size: 13px; }
      .divider::before, .divider::after { content: ''; flex: 1; border-bottom: 1px solid var(--blora-color-border-subtle); }
      .divider:not(:empty)::before { margin-right: .5em; }
      .divider:not(:empty)::after { margin-left: .5em; }
    </style>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope twofa-login-page">
    <div class="center-container">
        <div class="twofa-card blora-card">
            <h2 style="text-align: center; margin: 0 0 8px; font-size: 22px; font-weight: 700;">${t('双重认证')}</h2>
            <p style="text-align: center; color: var(--blora-color-text-muted); margin: 0 0 20px;">${t('请验证您的身份')}</p>

            ${safeError ? `<div class="error-message">${safeError}</div>` : ''}

            <form id="twoFaVerifyForm" action="/login/2fa/verify" method="POST">
                <div style="margin-bottom: 16px;">
                    <input class="blora-input input-token" type="text" name="token" placeholder="000000" pattern="[0-9]{6}" inputmode="numeric" required autocomplete="one-time-code">
                </div>
                <button class="blora-button" data-variant="primary" data-size="lg" type="submit">${t('验证令牌')}</button>
            </form>

            <div class="divider">${t('或者')}</div>

            <button type="button" class="blora-button" data-variant="outline" onclick="verifyPasskey()" style="margin-bottom: 10px;">${t('使用通行密钥 (PassKey) 验证')}</button>
            <button type="button" class="blora-button" data-variant="outline" id="app-verify-btn" onclick="startAppVerification()">${t('使用 Bloret Launcher 或 Bloret Swift App 验证')}</button>

            <div id="app-verify-status" style="display: none; margin-top: 20px; text-align: center;">
                <div class="spinner"></div>
                <p style="margin: 12px 0 4px; font-size: 14px;">${t('请打开 Bloret Launcher 或 Bloret Swift App 确认登录...')}</p>
                <p style="font-size: 12px; color: var(--blora-color-text-muted); margin: 0;">${t('请求已发送，等待批准中')}</p>
            </div>

            <div style="text-align: center; margin-top: 20px;">
                <a href="/logout" style="color: var(--blora-color-text-muted); font-size: 14px; text-decoration: none;">${t('取消登录')}</a>
            </div>
        </div>
    </div>
    <script>
        let pollInterval;
        let twoFaSubmitting = false;

        (function setupTwoFaAutoSubmit() {
            const form = document.getElementById('twoFaVerifyForm');
            const tokenInput = form && form.querySelector('input[name="token"]');
            const submitButton = form && form.querySelector('button[type="submit"]');
            if (!form || !tokenInput) return;

            tokenInput.addEventListener('input', () => {
                const token = tokenInput.value;
                if (twoFaSubmitting || !/^[0-9]{6}$/.test(token)) return;

                // form.submit() intentionally bypasses browser validation; the regex above is the complete validation here.
                twoFaSubmitting = true;
                tokenInput.value = token;
                if (submitButton) submitButton.disabled = true;
                tokenInput.setAttribute('aria-busy', 'true');
                const status = document.createElement('p');
                status.className = 'twofa-submit-status';
                status.setAttribute('role', 'status');
                status.textContent = ${scriptJson(t('正在验证令牌...'))};
                form.appendChild(status);
                form.submit();
            });
        })();

        async function startAppVerification() {
            const btn = document.getElementById('app-verify-btn');
            const statusDiv = document.getElementById('app-verify-status');
            btn.disabled = true;
            try {
                const initRes = await fetch('/api/2fa/app/init', { method: 'POST' });
                const initData = await initRes.json();
                if (initData.success) {
                    btn.style.display = 'none';
                    statusDiv.style.display = 'block';
                    pollInterval = setInterval(async () => {
                        try {
                            const checkRes = await fetch(\`/api/2fa/app/status?requestId=\${initData.requestId}\`);
                            const checkData = await checkRes.json();
                            if (checkData.status === 'approved') {
                                clearInterval(pollInterval);
                                statusDiv.innerHTML = '<p style="color: #4CAF50;">' + ${scriptJson(t('验证成功！正在跳转...'))} + '</p>';
                                setTimeout(() => { window.location.href = checkData.redirect || '/'; }, 1000);
                            } else if (checkData.status === 'rejected') {
                                clearInterval(pollInterval);
                                statusDiv.innerHTML = '<p style="color: #ff4444;">' + ${scriptJson(t('请求已被手机端拒绝。'))} + '</p>';
                                btn.style.display = 'block'; btn.disabled = false;
                                setTimeout(() => { statusDiv.style.display = 'none'; }, 2000);
                            } else if (checkData.status === 'expired') {
                                clearInterval(pollInterval);
                                statusDiv.innerHTML = '<p style="color: #ff4444;">' + ${scriptJson(t('请求已过期。'))} + '</p>';
                                btn.style.display = 'block'; btn.disabled = false;
                            }
                        } catch (e) { console.error('Polling error', e); }
                    }, 2000);
                } else {
                    alert(${scriptJson(t('初始化失败: {message}'))}.replace('{message}', initData.error));
                    btn.disabled = false;
                }
            } catch (e) {
                console.error(e);
                alert(${scriptJson(t('网络请求失败'))});
                btn.disabled = false;
            }
        }

        async function verifyPasskey() {
            if (pollInterval) clearInterval(pollInterval);
            try {
                const resp = await fetch('/api/passkey/2fa/options', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                if (!resp.ok) {
                    const errorData = await resp.json().catch(() => ({}));
                    throw new Error(errorData.error || (${scriptJson(t('服务器错误: {status}'))}.replace('{status}', resp.status)));
                }
                const opts = await resp.json();
                const authResp = await SimpleWebAuthnBrowser.startAuthentication(opts);
                const verifyResp = await fetch('/api/passkey/2fa/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ response: authResp, challenge: opts.challenge })
                });
                const result = await verifyResp.json();
                if (result.success) {
                    window.location.href = result.redirect || '/';
                } else {
                    alert(${scriptJson(t('验证失败: {message}'))}.replace('{message}', (result.error || ${scriptJson(t('未知错误'))})));
                }
            } catch (err) {
                console.error(err);
                if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
                    alert(${scriptJson(t('PassKey 验证失败: {message}'))}.replace('{message}', err.message));
                }
            }
        }
    </script>
</body>
</html>
    `;
}

// --- 页面生成函数集 ---




function generateEditUserHtml(currentUser, targetUser) {
    return `
                                <!DOCTYPE html>
                                <html lang="${htmlLang()}">
                                    <head>
                                        <link rel="icon" href="/BL.png" type="image/png">
                                        <link rel="apple-touch-icon" href="/BL.png">
                                        <meta charset="UTF-8">
                                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                                <title>${t('编辑用户 - Bloret PassPort')}</title>
                                                <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
                                                                                                    ${bloraAssetTags()}</head>
                                                <body class="blora-page blora-scope">
                                                    ${generateSidebarHtml(currentUser, 'management')}
                                                    <div class="main-content-apple">
                                                        <h1 class="page-title">${escapeHtml(t('编辑用户：{username}', { username: targetUser.username }))}</h1>
                                                        <div class="user-info-card blora-card">
                                                            <form action="/edit/user/${escapeHtml(String(targetUser.username))}" method="POST">
                                                                <div class="form-group">
                                                                    <label class="form-label">${t('电子邮箱')}</label>
                                                                    <input class="blora-input" name="email" type="text" value="${escapeHtml(String(targetUser.email || ''))}" style="width:100%" >
                                                                </div>
                                                                <div class="form-group" style="margin:20px 0;">
                                                                    <label style="display:flex; align-items:center; gap:8px;"><blora-checkbox name="admin" value="true" checked>${t('管理员权限')}</blora-checkbox></label>
                                                                </div>
                                                                <div class="form-group">
                                                                    <label class="form-label">${t('标签 (逗号分隔)')}</label>
                                                                    <input class="blora-input" name="tags" type="text" value="${escapeHtml((targetUser.tags || []).join(', '))}" style="width:100%" >
                                                                </div>
                                                                <div style="margin-top:20px; display:flex; gap:10px;">
                                                                    <button class="blora-button" data-variant="primary" type="submit" >${t('保存修改')}</button>
                                                                    <button type="button" class="blora-button" data-variant="outline" onclick="window.location.href='/management'" >${t('取消')}</button>
                                                                </div>
                                                            </form>
                                                        </div>
                                                    </div>
                                                    <script>${sidebarScript}</script>
                                                </body>
                                            </html>`;
}

// 已移除重复且较简略的定义，保留并修正末尾带侧边栏的功能更全的定义。

// 验证用户 apptoken（兼容新表多令牌 + 旧字段）
async function validateAppToken(username, appId, token) {
    return db.validateAppToken(username, appId, token);
}

// 应用数据接口：优先 Header/Body 取凭据，仍兼容 Query（旧客户端）
function handleAppDataAuth(req) {
    const p = getAppAuthParams(req);
    return p;
}

// 处理应用数据保存请求
async function appDataSaveHandler(req, res) {
    const { app_id, app_secret, user, usertoken, key, data } = handleAppDataAuth(req);

    const oauthApp = await db.getOAuthApp(app_id);
    if (!oauthApp || !safeEqualString(oauthApp.app_secret, app_secret)) {
        return res.status(401).json({ status: 'error', message: t('应用ID或密钥不正确') });
    }

    const targetUser = await db.getUser(user);
    if (user != 'public') {
        if (!targetUser || !(await validateAppToken(user, app_id, usertoken))) {
            return res.status(401).json({ status: 'error', message: t('用户或用户令牌不正确') });
        }
    }

    try {
        await db.saveAppData(app_id, user, key, data);
        const clientIp = getClientIp(req);
        await logUserAction(user, 'save_app_data', `应用 ${app_id} 数据保存成功，键: ${key}`, clientIp);
        res.json({ status: 'success', message: t('数据保存成功') });
    } catch (error) {
        console.error(t('保存应用数据失败:'), error);
        const clientIp = getClientIp(req);
        await logUserAction(user, 'save_app_data_failed', `应用 ${app_id} 数据保存失败，键: ${key}`, clientIp);
        res.status(500).json({ status: 'error', message: t('服务器错误') });
    }
}
app.get('/app/data/save', (req, res) => res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' }));
app.post('/app/data/save', appDataSaveHandler);

// 处理应用数据读取请求
async function appDataReadHandler(req, res) {
    const { app_id, app_secret, user, usertoken, key } = handleAppDataAuth(req);

    const oauthApp = await db.getOAuthApp(app_id);
    if (!oauthApp || !safeEqualString(oauthApp.app_secret, app_secret)) {
        return res.status(401).json({ status: 'error', message: t('应用ID或密钥不正确') });
    }

    const targetUser = await db.getUser(user);
    if (user != 'public') {
        if (!targetUser || !(await validateAppToken(user, app_id, usertoken))) {
            return res.status(401).json({ status: 'error', message: t('用户或用户令牌不正确') });
        }
    }

    const userData = await db.getAppData(app_id, user, key);
    const clientIp = getClientIp(req);

    if (userData !== null) {
        await logUserAction(user, 'read_app_data', `应用 ${app_id} 数据读取成功，键: ${key}`, clientIp);
        res.json({ status: 'success', data: userData });
    } else {
        await logUserAction(user, 'read_app_data_not_found', `应用 ${app_id} 数据未找到，键: ${key}`, clientIp);
        res.status(404).json({ status: 'error', message: t('未找到对应数据') });
    }
}
app.get('/app/data/read', appDataReadHandler);
app.post('/app/data/read', appDataReadHandler);

// 处理应用数据删除请求
async function appDataDeleteHandler(req, res) {
    const { app_id, app_secret, user, usertoken, key } = handleAppDataAuth(req);

    const oauthApp = await db.getOAuthApp(app_id);
    if (!oauthApp || !safeEqualString(oauthApp.app_secret, app_secret)) {
        return res.status(401).json({ status: 'error', message: t('应用ID或密钥不正确') });
    }

    const targetUser = await db.getUser(user);
    if (!targetUser || !(await validateAppToken(user, app_id, usertoken))) {
        return res.status(401).json({ status: 'error', message: t('用户或用户令牌不正确') });
    }

    try {
        await db.deleteAppData(app_id, user, key);
        const clientIp = getClientIp(req);
        await logUserAction(user, 'delete_app_data', `应用 ${app_id} 数据删除成功，键: ${key}`, clientIp);
        res.json({ status: 'success', message: t('数据删除成功') });
    } catch (error) {
        console.error(t('删除应用数据失败:'), error);
        const clientIp = getClientIp(req);
        await logUserAction(user, 'delete_app_data_failed', `应用 ${app_id} 数据删除失败，键: ${key}`, clientIp);
        res.status(500).json({ status: 'error', message: t('服务器错误') });
    }
}
app.get('/app/data/delete', (req, res) => res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' }));
app.post('/app/data/delete', appDataDeleteHandler);

// /app/MinecraftAccounts 路由已迁移至 minecraft.js


// 设置用户标签 (管理员/API)
app.post('/api/admin/set-user-tags', async (req, res) => {
    const { username, tags, type = 'cover', token } = req.body;
    const clientIp = getClientIp(req);

    // 鉴权逻辑：从配置文件读取特定的 feishubot token（恒定时间比较）
    const expectedToken = config.token ? config.token.feishubot : null;

    if (!expectedToken || !safeEqualString(token, expectedToken)) {
        return res.status(403).json({ success: false, message: t('权限不足：Token 错误或缺失') });
    }

    const operatorName = 'FeishuBot (Config Token)';

    // 参数校验
    if (!username || !tags || !Array.isArray(tags)) {
        return res.status(400).json({ success: false, message: t('参数错误: username 和 tags (数组) 为必填项') });
    }

    const targetUser = await db.getUser(username);

    if (!targetUser) {
        return res.status(404).json({ success: false, message: t('目标用户不存在') });
    }

    // 初始化 tags 数组
    if (!Array.isArray(targetUser.tags)) {
        targetUser.tags = [];
    }

    const oldTags = JSON.stringify(targetUser.tags);

    try {
        let newTags = targetUser.tags;
        if (type === 'cover') {
            // 覆盖模式
            newTags = tags;
        } else if (type === 'add') {
            // 追加模式 (去重)
            const combined = [...targetUser.tags, ...tags];
            newTags = [...new Set(combined)];
        } else if (type === 'remove') {
            // 删除模式
            newTags = targetUser.tags.filter(t => !tags.includes(t));
        } else {
            return res.status(400).json({ success: false, message: t('不支持的操作类型 (type 应为 cover, add 或 remove)') });
        }

        await db.updateUser(username, { tags: newTags });
        await db.logUserAction(username, 'set_tags', `${operatorName} 将标签从 ${oldTags} 修改为 ${scriptJson(newTags)} (类型: ${type})`, clientIp);

        res.json({ success: true, tags: newTags });
    } catch (error) {
        console.error(t('修改标签失败:'), error);
        res.status(500).json({ success: false, message: t('服务器内部错误') });
    }
});

// 删除用户 (管理员)
app.post('/api/admin/delete-user', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    const clientIp = getClientIp(req);

    if (!username) {
        return res.status(403).json({ success: false, message: t('权限不足') });
    }
    const operator = await db.getUser(username);

    if (!operator || !operator.admin) {
        return res.status(403).json({ success: false, message: t('权限不足') });
    }

    const { username: targetUsername } = req.body;
    if (!targetUsername) {
        return res.status(400).json({ success: false, message: t('用户名不能为空') });
    }

    if (targetUsername === operator.username) {
        return res.status(400).json({ success: false, message: t('不能删除自己') });
    }

    const userToDelete = await db.getUser(targetUsername);
    if (!userToDelete) {
        return res.status(404).json({ success: false, message: t('用户不存在') });
    }

    await db.deleteUser(targetUsername);
    
    await db.logUserAction(operator.username, 'delete_user', `已删除用户: ${targetUsername}`, clientIp);
    res.json({ success: true, message: t('用户已删除') });
});

// 开放平台仪表盘路由
app.get('/open-platform', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    if (!username) return res.redirect('/');
    const user = await db.getUser(username);
    if (!user) return res.redirect('/');
    const allApps = await db.getAllOAuthApps();
    res.send(generateOpenPlatformHtml(user, allApps));
});



// Minecraft 档案路由已迁移至 minecraft.js

// 应用注册表单页面
app.get('/app/register', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    if (!username) return res.redirect('/');
    const currentUser = await db.getUser(username);
    if (!currentUser) return res.redirect('/');
    res.send(generateRegisterOAuthAppHtml(currentUser));
});

// 用户管理页面路由
app.get('/management', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    if (!username) return res.redirect('/');
    const user = await db.getUser(username);
    if (!user || !user.admin) return res.redirect('/');
    
    // 获取所有用户和应用供管理页面使用
    const allUsers = await db.getAllUsers();
    const allApps = await db.getAllOAuthApps();
    
    res.send(generateManagementPageHtml(user, allUsers, allApps));
});

// 管理员用户详情改为管理面板浮窗；保留旧链接兼容
app.get('/management/user/:username', async (req, res) => {
    const username = req.authUsername;
    if (!username) return res.redirect('/');
    const currentUser = await db.getUser(username);
    if (!currentUser || !currentUser.admin) return res.redirect('/');
    res.redirect('/management?edit=' + encodeURIComponent(req.params.username));
});

// --- UI 生成辅助函数 ---

const sidebarScript = `
function openMobileSidebar() {
    document.body.classList.add('sidebar-open');
    const btn = document.getElementById('mobile-menu-btn');
    if (btn) btn.setAttribute('aria-expanded', 'true');
}

function closeMobileSidebar() {
    document.body.classList.remove('sidebar-open');
    const btn = document.getElementById('mobile-menu-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    const dropdown = document.getElementById('user-popover');
    if (dropdown) dropdown.close();
}

function toggleMobileSidebar(event) {
    if (event) event.stopPropagation();
    if (document.body.classList.contains('sidebar-open')) {
        closeMobileSidebar();
    } else {
        openMobileSidebar();
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMobileSidebar();
});

document.addEventListener('DOMContentLoaded', () => {
    const userMenu = document.getElementById('user-popover');
    if (userMenu) {
        userMenu.addEventListener('blora-select', (event) => {
            if (event.detail && event.detail.value === 'logout') {
                window.location.href = '/logout';
            }
        });
    }
    const overlay = document.getElementById('sidebar-overlay');
    if (overlay) {
        overlay.addEventListener('click', closeMobileSidebar);
    }
    // 点击侧栏内导航后自动收起（手机）
    document.querySelectorAll('.sidebar blora-sidebar-nav a, .sidebar a.nav-link-apple').forEach((link) => {
        link.addEventListener('click', () => {
            if (window.matchMedia('(max-width: 1024px)').matches) {
                closeMobileSidebar();
            }
        });
    });
});
`;

// ================= 操作日志页面 =================
app.get('/logs', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    if (!username) return res.redirect('/');
    const user = await db.getUser(username);
    if (!user) return res.redirect('/');
    res.send(generateLogsPageHtml(user));
});

app.get('/api/logs', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    if (!username) return res.status(401).json({ error: t('未登录') });

    const { type, keyword, page = 1 } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);

    const result = await db.getUserLogsFiltered(username, { type, keyword, page: pageNum });
    res.json(result);
});

function generateLogsPageHtml(user) {
    const sf = (name, color = '0071e3') => `https://img.bloret.net/SF/${name}?color=%23${color}`;

    const actionTypes = [
        'all', 'login', 'login_failed', 'login_2fa_pending', 'login_2fa_success', 'login_2fa_failed',
        'login_2fa_passkey_success', 'login_2fa_app_success', '2fa_app_action', 'logout',
        '2fa_enabled', '2fa_disabled', 'change_password', 'change_password_failed',
        'update_avatar', 'admin_send_email', 'register', 'register_failed',
        'email_verified', 'email_verification_failed', 'oauth_authorize', 'oauth_auto_authorize',
        'oauth_deny', 'oauth_auto_auth_enabled', 'github_login', 'github_login_2fa_pending',
        'lark_login', 'lark_login_2fa_pending', 'register_oauth_app', 'register_oauth_app_failed',
        'edit_oauth_app', 'save_app_data', 'save_app_data_failed', 'read_app_data',
        'read_app_data_not_found', 'delete_app_data', 'delete_app_data_failed',
        'set_tags', 'delete_user', 'reset_ai_quota', 'passkey_reg', 'passkey_login', 'passkey_delete', 'passkey_rename',
        'minecraft_bind', 'minecraft_bind_offline', 'minecraft_remove', 'read_minecraft_accounts'
    ];

    const typeOptionsHtml = actionTypes.map(atype => `<blora-option value="${atype}">${!atype || atype === 'all' ? t('全部类型') : getActionTypeDisplay(atype)}</blora-option>`).join('');

    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('操作日志 - Bloret PassPort')}</title>
    <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
    <style>
        .logs-toolbar { display: flex; gap: var(--blora-space-3); flex-wrap: wrap; align-items: flex-end; margin-bottom: var(--blora-space-6); }
        .logs-toolbar .form-group { margin-bottom: 0; }
        .log-list { min-height: 200px; }
        .pagination { display: flex; justify-content: center; margin-top: 24px; }
        .pagination .page-info { font-size: 13px; color: var(--blora-color-text-muted); }
        .log-username { font-size: 12px; color: var(--brand-blue); font-weight: 600; margin-bottom: 2px; }
    </style>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope">
    ${generateSidebarHtml(user, 'logs')}

    <div class="main-content-apple">
        <h1 class="page-title">${t('操作日志')}</h1>

        <div class="user-info-card blora-card">
            <div class="logs-toolbar">
                <div class="form-group">
                    <label class="form-label">${t('关键词')}</label>
                    <input class="blora-input" id="log-keyword" placeholder="${t('搜索日志内容...')}" style="width: 220px;">
                </div>
                <div class="form-group">
                    <label class="form-label">${t('类型')}</label>
                    <blora-select id="log-type" value="all" placeholder="${t('全部类型')}">
                        ${typeOptionsHtml}
                    </blora-select>
                </div>
                <div class="form-group" style="display:flex;align-items:flex-end;">
                    <button type="button" class="blora-button" data-variant="primary" onclick="loadLogs(1)">${t('搜索')}</button>
                </div>
            </div>

            <div class="log-list" id="log-list">
                <div class="no-logs">${t('加载中...')}</div>
            </div>

            <div class="pagination" id="log-pagination" aria-live="polite"></div>
        </div>
    </div>

    <script>
        let currentPage = 1;

        async function loadLogs(page) {
            currentPage = page || 1;
            const keyword = document.getElementById('log-keyword').value.trim();
            const type = document.getElementById('log-type').value;
            const listEl = document.getElementById('log-list');
            const paginationEl = document.getElementById('log-pagination');

            let url = \`/api/logs?page=\${currentPage}&\`;
            if (keyword) url += \`keyword=\${encodeURIComponent(keyword)}&\`;
            if (type && type !== 'all') url += \`type=\${encodeURIComponent(type)}&\`;

            try {
                const resp = await fetch(url);
                const data = await resp.json();

                if (!data.logs || data.logs.length === 0) {
                    listEl.innerHTML = '<blora-empty title="' + ${scriptJson(t('暂无操作记录'))} + '" description="' + ${scriptJson(t('账户操作发生后，记录会显示在这里。'))} + '"></blora-empty>';
                    paginationEl.innerHTML = '';
                    return;
                }

                listEl.innerHTML = '<blora-timeline>' + data.logs.map(log => {
                    const status = getLogStatusJS(log.type);
                    const title = escapeHtml(getActionTypeDisplayJS(log.type));
                    const message = log.message ? escapeHtml(log.message) : '';
                    const time = formatTime(log.time);
                    const ip = log.ip ? escapeHtml(String(log.ip)) : '';
                    const desc = [message, time, ip].filter(Boolean).join(' · ');
                    return '<blora-timeline-item icon="' + getLogIconJS(log.type) + '" content-layout="block">' +
                        '<div class="passport-log">' +
                            '<div class="passport-log__row">' +
                                '<strong class="passport-log__title">' + title + '</strong>' +
                                '<span class="blora-badge" data-variant="' + status.variant + '">' + escapeHtml(status.label) + '</span>' +
                            '</div>' +
                            (desc ? '<span class="passport-log__desc">' + desc + '</span>' : '') +
                        '</div>' +
                    '</blora-timeline-item>';
                }).join('') + '</blora-timeline>';

                // 分页
                paginationEl.innerHTML = data.totalPages > 1
                    ? '<blora-pagination page="' + currentPage + '" total="' + data.totalPages + '" max-visible="7" label="${t('日志分页')}"></blora-pagination>'
                    : '<span class="page-info">' + ${scriptJson(t('共 {total} 条记录'))}.replace('{total}', data.total) + '</span>';
                const pagination = paginationEl.querySelector('blora-pagination');
                if (pagination) pagination.addEventListener('blora-change', (event) => loadLogs(event.detail.page), { once: true });
            } catch (e) {
                listEl.innerHTML = '<div class="no-logs" style="color:var(--destructive);">' + ${scriptJson(t('加载失败'))} + '</div>';
            }
        }

        function escapeHtml(value) {
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        function getLogStatusJS(type) {
            const key = String(type || '');
            if (/fail|deny|not_found/i.test(key)) return { variant: 'danger', label: ${scriptJson(t('失败'))} };
            if (/pending/i.test(key)) return { variant: 'warning', label: ${scriptJson(t('待验证'))} };
            return { variant: 'success', label: ${scriptJson(t('成功'))} };
        }

        function getLogIconJS(type) {
            const key = String(type || '');
            if (/passkey/.test(key)) return 'key-round';
            if (/password/.test(key)) return 'lock-keyhole';
            if (/2fa/.test(key)) return 'shield-check';
            if (/oauth|github|lark/.test(key)) return 'link';
            if (/logout/.test(key)) return 'log-out';
            if (/login/.test(key)) return 'log-in';
            if (/avatar/.test(key)) return 'image';
            if (/minecraft/.test(key)) return 'gamepad';
            if (/email/.test(key)) return 'mail';
            return 'activity';
        }

        function getActionTypeDisplayJS(type) {
            const map = {
                'login':${scriptJson(t('用户登录'))},'login_failed':${scriptJson(t('登录失败'))},'login_2fa_pending':${scriptJson(t('登录二次验证(待验证)'))},
                'login_2fa_success':${scriptJson(t('二次验证(TOTP)成功'))},'login_2fa_failed':${scriptJson(t('二次验证(TOTP)失败'))},
                'login_2fa_passkey_success':${scriptJson(t('二次验证(通行密钥)成功'))},'login_2fa_app_success':${scriptJson(t('二次验证(手机应用)成功'))},
                '2fa_app_action':${scriptJson(t('手机应用验证操作'))},'logout':${scriptJson(t('退出登录'))},
                '2fa_enabled':${scriptJson(t('开启双重认证'))},'2fa_disabled':${scriptJson(t('关闭双重认证'))},
                'change_password':${scriptJson(t('修改密码'))},'change_password_failed':${scriptJson(t('修改密码失败'))},
                'update_avatar':${scriptJson(t('更新头像'))},
                'admin_send_email':${scriptJson(t('群发邮件'))},'register':${scriptJson(t('注册成功'))},'register_failed':${scriptJson(t('注册失败'))},
                'email_verified':${scriptJson(t('邮箱验证成功'))},'email_verification_failed':${scriptJson(t('邮箱验证失败'))},
                'oauth_authorize':${scriptJson(t('OAuth 授权'))},'oauth_auto_authorize':${scriptJson(t('OAuth 自动授权'))},
                'oauth_deny':${scriptJson(t('OAuth 拒绝授权'))},'oauth_auto_auth_enabled':${scriptJson(t('开启 OAuth 自动授权'))},
                'github_login':${scriptJson(t('GitHub 登录'))},'github_login_2fa_pending':${scriptJson(t('GitHub 登录二次验证(待验证)'))},
                'lark_login':${scriptJson(t('飞书登录'))},'lark_login_2fa_pending':${scriptJson(t('飞书登录二次验证(待验证)'))},
                'register_oauth_app':${scriptJson(t('注册 OAuth 应用'))},'register_oauth_app_failed':${scriptJson(t('注册 OAuth 应用失败'))},
                'edit_oauth_app':${scriptJson(t('编辑 OAuth 应用'))},'save_app_data':${scriptJson(t('保存应用数据'))},'save_app_data_failed':${scriptJson(t('保存应用数据失败'))},
                'read_app_data':${scriptJson(t('读取应用数据'))},'read_app_data_not_found':${scriptJson(t('读取应用数据(未找到)'))},
                'delete_app_data':${scriptJson(t('删除应用数据'))},'delete_app_data_failed':${scriptJson(t('删除应用数据失败'))},
                'set_tags':${scriptJson(t('修改用户标签'))},'delete_user':${scriptJson(t('删除用户'))},'reset_ai_quota':${scriptJson(t('重置 AI 额度'))},
                'passkey_reg':${scriptJson(t('注册通行密钥'))},'passkey_login':${scriptJson(t('通行密钥登录'))},'passkey_rename':${scriptJson(t('重命名通行密钥'))},
                'minecraft_bind':${scriptJson(t('绑定 Minecraft 账号'))},'minecraft_bind_offline':${scriptJson(t('绑定离线 Minecraft 账号'))},
                'minecraft_remove':${scriptJson(t('移除 Minecraft 账号'))},'read_minecraft_accounts':${scriptJson(t('读取 Minecraft 账号列表'))}
            };
            return map[type] || type;
        }

        function formatTime(ts) {
            const date = new Date(ts);
            const now = new Date();
            const diff = now - date;
            const mins = Math.floor(diff / 60000);
            const hours = Math.floor(diff / 3600000);
            const days = Math.floor(diff / 86400000);
            if (mins < 1) return ${scriptJson(t('刚刚'))};
            if (mins < 60) return mins + ${scriptJson(t('分钟前'))};
            if (hours < 24) return hours + ${scriptJson(t('小时前'))};
            if (days < 7) return days + ${scriptJson(t('天前'))};
            return date.toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
        }

        // 回车搜索
        document.getElementById('log-keyword').addEventListener('keydown', e => { if (e.key === 'Enter') loadLogs(1); });

        // 初始加载
        loadLogs(1);
    </script>
</body>
</html>
    `;
}

// 初始化 Minecraft 模块
const minecraft = setupMinecraft(app, db, config, parseCookies, logUserAction, generateSidebarHtml, sidebarScript, bloraAssetTags);

function generateSidebarHtml(user, activePage) {
    const avatarUrl = safeImageUrl(user.avatar, `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username || '')}&background=0078d4&color=fff&size=128`);
    const sf = (name, color = '0071e3') => `https://img.bloret.net/SF/${name}?color=%23${color}`;

    return `
                                            <div class="mobile-topbar" id="mobile-topbar">
                                                <button type="button" class="mobile-menu-btn" id="mobile-menu-btn" aria-label="${t('打开菜单')}" aria-expanded="false" aria-controls="app-sidebar" onclick="toggleMobileSidebar(event)">
                                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                                                        <line x1="4" y1="7" x2="20" y2="7"></line>
                                                        <line x1="4" y1="12" x2="20" y2="12"></line>
                                                        <line x1="4" y1="17" x2="20" y2="17"></line>
                                                    </svg>
                                                </button>
                                                <div class="mobile-topbar-brand">
                                                    <img src="/BL.png" width="22" height="22" style="border-radius: 6px;" alt="">
                                                    <span>Bloret PassPort</span>
                                                </div>
                                            </div>
                                            <div class="sidebar-overlay" id="sidebar-overlay" aria-hidden="true"></div>
                                            <div class="sidebar" id="app-sidebar">
                                                <div class="sidebar-header">
                                                    <div class="brand-wrap">
                                                        <img src="/BL.png" width="22" height="22" style="border-radius: 6px;">
                                                            <div class="brand-text">
                                                                Bloret <span class="brand-subtitle">PassPort</span>
                                                            </div>
                                                    </div>
                                                </div>

                                                <div class="search-wrap">
                                                    <div class="search-box-apple">
                                                        <blora-search id="sidebar-search" name="sidebar-search" placeholder="${t('搜索')}" label="${t('搜索')}"></blora-search>
                                                            </div>
                                                    </div>

                                                    <blora-sidebar-nav class="nav-group" label="${t('导航')}" value="${activePage}">
                                                        <blora-sidebar-nav-link label="${t('主页')}" href="/" value="home"${activePage === 'home' ? ' current' : ''}></blora-sidebar-nav-link>
                                                        <blora-sidebar-nav-link label="${t('开放平台')}" href="/open-platform" value="open-platform"${activePage === 'open-platform' ? ' current' : ''}></blora-sidebar-nav-link>
                                                        <blora-sidebar-nav-link label="Minecraft" href="/minecraft" value="minecraft"${activePage === 'minecraft' ? ' current' : ''}></blora-sidebar-nav-link>
                                                        <blora-sidebar-nav-link label="${t('操作日志')}" href="/logs" value="logs"${activePage === 'logs' ? ' current' : ''}></blora-sidebar-nav-link>
                                                        <blora-sidebar-nav-link label="${t('我的令牌')}" href="/my/tokens" value="my-tokens"${activePage === 'my-tokens' ? ' current' : ''}></blora-sidebar-nav-link>
                                                        <blora-sidebar-nav-link label="${t('AI 服务')}" href="/ai" value="ai"${activePage === 'ai' ? ' current' : ''}></blora-sidebar-nav-link>
                                                    </blora-sidebar-nav>

                                                    ${user.admin ? `
                                                    <div class="sidebar-title">${t('管理')}</div>
                                                    <blora-sidebar-nav class="nav-group" label="${t('管理')}" value="${activePage}">
                                                        <blora-sidebar-nav-link label="${t('管理面板')}" href="/management" value="management"${activePage === 'management' ? ' current' : ''}></blora-sidebar-nav-link>
                                                        <blora-sidebar-nav-link label="${t('群发邮件')}" href="/admin/email" value="admin-email"${activePage === 'admin-email' ? ' current' : ''}></blora-sidebar-nav-link>
                                                    </blora-sidebar-nav>
                                                    ` : ''}

                                                    <div class="sidebar-title">${t('服务')}</div>
                                                    <blora-sidebar-nav class="nav-group" label="${t('服务')}">
                                                        <blora-sidebar-nav-link label="${t('Bloret Launcher')}" href="https://launcher.bloret.net/" value="launcher"></blora-sidebar-nav-link>
                                                        <blora-sidebar-nav-link label="${t('Bloret BBS')}" href="https://bbs.bloret.net/" value="bbs"></blora-sidebar-nav-link>
                                                        <blora-sidebar-nav-link label="${t('Bloret Image')}" href="https://img.bloret.net/" value="image"></blora-sidebar-nav-link>
                                                        <blora-sidebar-nav-link label="${t('Bloret Wiki')}" href="https://wiki.bloret.net/" value="wiki"></blora-sidebar-nav-link>
                                                    </blora-sidebar-nav>

                                                    <div class="sidebar-footer bbs-sidebar__footer">
                                                        <blora-dropdown id="user-popover" class="user-profile-menu bbs-profile-menu" placement="top" align="start">
                                                            <button slot="trigger" type="button" class="user-profile-mini bbs-profile" id="user-mini-trigger" aria-label="${t('账户选项 · 管理')}">
                                                                <img src="${escapeHtml(avatarUrl)}" class="mini-avatar">
                                                                <span class="user-meta">
                                                                    <span class="mini-username">${escapeHtml(displayName(user))}</span>
                                                                </span>
                                                            </button>
                                                            <blora-dropdown-item value="logout" href="/logout">${escapeHtml(t('登出 {username}...', { username: displayName(user) }))}</blora-dropdown-item>
                                                        </blora-dropdown>
                                                        <div class="bbs-sidebar-tools">
                                                            <div class="bbs-theme-tools" aria-label="${t('界面外观')}">
                                                                <blora-palette-picker button-variant="ghost" size="sm" icon-only></blora-palette-picker>
                                                                <blora-color-scheme-toggle button-variant="ghost" size="sm"></blora-color-scheme-toggle>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div >
    <script>

    // Sidebar Search Functionality
    document.addEventListener('DOMContentLoaded', async function() {
        const iconMap = { home: 'home', 'open-platform': 'link', minecraft: 'gamepad', logs: 'file-text', 'my-tokens': 'ticket', ai: 'cpu', management: 'settings', 'admin-email': 'mail', launcher: 'rocket', bbs: 'message', image: 'image', wiki: 'book' };
        try {
            const { createBloraIcon } = await import('/blora/index.js');
            const addSidebarIcons = () => document.querySelectorAll('blora-sidebar-nav .blora-sidebar-nav__link').forEach((link) => {
                const icon = iconMap[link.dataset.value];
                if (!icon || link.querySelector('[data-blora-sidebar-icon]')) return;
                const svg = createBloraIcon(icon, 18);
                if (!svg) return;
                svg.dataset.bloraSidebarIcon = 'true';
                svg.setAttribute('aria-hidden', 'true');
                link.prepend(svg);
            });
            const addDataIcons = () => document.querySelectorAll('[data-icon]:not(.blora-button)').forEach((el) => {
                if (el.querySelector(':scope > svg[data-blora-icon]')) return;
                const name = el.getAttribute('data-icon');
                if (!name) return;
                const svg = createBloraIcon(name, 16);
                if (!svg) return;
                svg.setAttribute('aria-hidden', 'true');
                el.prepend(svg);
            });
            const waitForSidebar = () => {
                addSidebarIcons();
                addDataIcons();
                document.querySelectorAll('blora-sidebar-nav').forEach((nav) => {
                    new MutationObserver(addSidebarIcons).observe(nav, { childList: true, subtree: true });
                });
            };
            if (customElements.whenDefined) {
                await customElements.whenDefined('blora-sidebar-nav');
            }
            requestAnimationFrame(() => requestAnimationFrame(waitForSidebar));
        } catch (error) {
            console.error('Blora sidebar icon setup failed', error);
        }

        const searchInput = document.getElementById('sidebar-search');
        if (searchInput) {
            searchInput.addEventListener('input', function(e) {
                const term = e.target.value.toLowerCase();
                
                // Define searchable containers
                const selectors = [
                    '.settings-card',       // 2FA/Security pages
                    '.user-info-card',      // Home/Management pages
                    '.app-card',            // App lists
                    '.passport-log, .blora-timeline__item',
                    '.mc-account-item',     // MC accounts
                    '.permission-item',     // Permissions
                    '.passkey-item'         // Passkeys
                ];
                
                let hasResults = false;

                selectors.forEach(selector => {
                    const items = document.querySelectorAll(selector);
                    items.forEach(item => {
                        // If item is visible by default or was visible
                        if (item.textContent.toLowerCase().includes(term)) {
                            item.style.display = '';
                            hasResults = true;
                        } else {
                            item.style.display = 'none';
                        }
                    });
                });

                // Special handling for admin tables
                const tableRows = document.querySelectorAll('.admin-table tbody tr');
                if (tableRows.length > 0) {
                    tableRows.forEach(row => {
                        if (row.textContent.toLowerCase().includes(term)) {
                            row.style.display = '';
                            hasResults = true;
                        } else {
                            row.style.display = 'none';
                        }
                    });
                }
            });
        }
    });
    </script>
`;
}

function generateManagementPageHtml(user, allUsers, allAppsList) {
    if (!user.admin) return `<h1>${t('权限不足')}</h1>`;
    const userList = allUsers || [];
    const allApps = allAppsList || [];
    const aiModels = (config.ai && config.ai.models) || [];
    const aiModelOptionsHtml = aiModels.map(m => '<blora-option value="' + m.id + '">' + (m.name || m.id) + '</blora-option>').join('');

    return `
    <!DOCTYPE html>
    <html lang="${htmlLang()}">
        <head>
            <link rel="icon" href="/BL.png" type="image/png">
            <link rel="apple-touch-icon" href="/BL.png">
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${t('管理面板 - Bloret PassPort')}</title>
            <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
    <script src="/blora-message-layer.js"></script>
                        <style>
                .admin-table {width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; }
                .admin-table th, .admin-table td {padding: 12px; text-align: left; border-bottom: 1px solid var(--blora-color-border-subtle); color: var(--foreground); }
                .admin-table th {font-weight: 600; color: var(--text-secondary); }
                .admin-table tr {cursor: pointer; transition: background 0.2s; }
                .admin-table tr:hover {background: rgba(0,0,0,0.05); }
                .admin-toolbar { display: flex; gap: 10px; margin-bottom: 10px; }
                
                dialog { border: none; border-radius: 16px; box-shadow: 0 32px 110px -38px rgba(15,23,42,0.45); max-width: 500px; width: 90%; padding: 0; }
                dialog::backdrop { background: rgba(0,0,0,0.4); backdrop-filter: blur(4px); }
                .dialog-content { padding: 20px; color: var(--foreground); }
                .dialog-header { font-size: 18px; font-weight: bold; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; }
                .dialog-body { margin-bottom: 20px; }
                .dialog-footer { display: flex; justify-content: flex-end; gap: 10px; }
                
                .info-row { display: flex; margin-bottom: 8px; }
                .info-label { width: 100px; font-weight: bold; color: #666; flex-shrink: 0; }
                .info-value { flex: 1; word-break: break-all; }
                
                .form-group { margin-bottom: 12px; }
                .form-label { display: block; margin-bottom: 4px; font-weight: 500; }
                
                .user-list-item { display: flex; align-items: center; justify-content: space-between; padding: 8px; border-bottom: 1px solid #eee; }
                .user-list-item:last-child { border-bottom: none; }
            </style>
        ${bloraAssetTags()}</head>
        <body class="blora-page blora-scope">
            ${generateSidebarHtml(user, 'management-users')}

            <div class="main-content-apple content-wide">
                <h1 class="page-title">${t('管理面板')}</h1>

                <!-- 用户管理 -->
                <div class="user-info-card blora-card">
                    <div class="post-title">${t('用户管理 ({count})', { count: userList.length })}</div>
                    <div class="post-content">
                        <div class="admin-toolbar">
                            <button type="button" class="blora-button" data-variant="primary" onclick="batchEmail()" >${t('群发邮件')}</button>
                            <button type="button" class="blora-button" data-variant="outline" onclick="location.reload()" >${t('刷新')}</button>
                        </div>
                        <div class="blora-table-wrap" data-blora-selectable>
                            <table class="blora-table">
                                <thead>
                                    <tr>
                                        <th style="width: 40px;"><blora-checkbox id="selectAllUsers" data-select-all-users></blora-checkbox></th>
                                        <th>${t('用户名')}</th>
                                        <th>${t('昵称')}</th>
                                        <th>${t('邮箱')}</th>
                                        <th>${t('管理员')}</th>
                                        <th>2FA</th>
                                        <th>Passkeys</th>
                                        <th>${t('标签')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${userList.map(u => {
                                        const safeUserName = escapeHtml(String(u.username || ''));
                                        const safeNickname = escapeHtml(String(u.nickname || u.username || '-'));
                                        const safeUserEmail = escapeHtml(String(u.email || '-'));
                                        const safeUserTags = escapeHtml((u.tags || []).join(', '));
                                        return `
                                    <tr data-username="${encodeURIComponent(String(u.username || ''))}" onclick="openUserEditor(decodeURIComponent(this.dataset.username))">
                                        <td onclick="event.stopPropagation()"><blora-checkbox data-user-checkbox value="${safeUserName}"></blora-checkbox></td>
                                        <td>${safeUserName}</td>
                                        <td>${safeNickname}</td>
                                        <td>${safeUserEmail}</td>
                                        <td class="passport-bool-cell">${lucideStatusIcon(u.admin)}</td>
                                        <td class="passport-bool-cell">${lucideStatusIcon(u.twoFactorEnabled)}</td>
                                        <td class="passport-bool-cell">${lucideStatusIcon(u.passkeys && u.passkeys.length > 0)}</td>
                                        <td>${safeUserTags}</td>
                                    </tr>`;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- OAuth 应用管理 -->
                <div class="user-info-card blora-card">
                    <div class="post-title">${t('OAuth 应用管理 ({count})', { count: allApps.length })}</div>
                    <div class="post-content">
                        <div class="blora-table-wrap" data-blora-selectable>
                            <table class="blora-table">
                                <thead>
                                    <tr><th>ID</th><th>${t('名称')}</th><th>${t('所有者')}</th><th>${t('官方')}</th></tr>
                                </thead>
                                <tbody>
                                    ${allApps.map(a => {
                                        const ownerLabel = escapeHtml(displayNameForUsername(a.owner, userList) || '-');
                                        return `<tr data-app-id="${encodeURIComponent(String(a.id))}" onclick="showAppCard(decodeURIComponent(this.dataset.appId))" style="cursor:pointer"><td>${escapeHtml(String(a.id || ''))}</td><td>${escapeHtml(String(a.name || ''))}</td><td>${ownerLabel}</td><td class="passport-bool-cell">${lucideStatusIcon(a.official)}</td></tr>`;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Dialogs -->
            <blora-dialog id="appCardDialog"  >
                <div class="dialog-content">
                    <div class="dialog-header">
                        <span>${t('应用信息')}</span>
                        <button type="button" class="blora-button" data-variant="outline" onclick="closeDialog('appCardDialog')" >✕</button>
                    </div>
                    <div class="dialog-body" id="appCardBody"></div>
                    <div class="dialog-footer">
                        <button type="button" class="blora-button" data-variant="primary" onclick="viewAppDetail()" >${t('查看详情')}</button>
                        <button type="button" class="blora-button" data-variant="outline" onclick="editApp()" >${t('编辑')}</button>
                        <button type="button" class="blora-button" data-variant="outline" onclick="manageAppUsers()" >${t('管理授权用户')}</button>
                    </div>
                </div>
            </blora-dialog>

            <blora-dialog id="appEditDialog"  >
                <div class="dialog-content">
                    <div class="dialog-header">
                        <span>${t('编辑应用')}</span>
                        <button type="button" class="blora-button" data-variant="outline" onclick="closeDialog('appEditDialog')" >✕</button>
                    </div>
                    <div class="dialog-body" id="appEditBody"></div>
                    <div class="dialog-footer">
                        <button type="button" class="blora-button" data-variant="primary" onclick="saveAppEdit()" >${t('保存')}</button>
                        <button type="button" class="blora-button" data-variant="outline" onclick="closeDialog('appEditDialog')" >${t('取消')}</button>
                    </div>
                </div>
            </blora-dialog>
            
            <blora-dialog id="appUsersDialog"  >
                <div class="dialog-content">
                    <div class="dialog-header">
                        <span>${t('已授权用户')}</span>
                        <button type="button" class="blora-button" data-variant="outline" onclick="closeDialog('appUsersDialog')" >✕</button>
                    </div>
                    <div class="dialog-body" id="appUsersBody" style="max-height: 300px; overflow-y: auto;"></div>
                </div>
            </blora-dialog>

            <blora-dialog id="emailDialog"  >
                <div class="dialog-content">
                    <div class="dialog-header">
                        <span>${t('发送邮件')}</span>
                        <button type="button" class="blora-button" data-variant="outline" onclick="closeDialog('emailDialog')" >✕</button>
                    </div>
                    <div class="dialog-body">
                        <div class="form-group">
                            <label class="form-label">${t('收件人')}</label>
                            <input class="blora-input" id="emailTo" type="text" style="width: 100%; background: #eee;" >
                            <input type="hidden" id="emailToUsernames">
                        </div>
                        <div class="form-group">
                            <label class="form-label">${t('主题')}</label>
                            <input class="blora-input" id="emailSubject" type="text" style="width: 100%;" >
                        </div>
                        <div class="form-group">
                            <label class="form-label">${t('内容 (支持 HTML)')}</label>
                            <textarea class="blora-textarea" id="emailContent" style="width: 100%; height: 150px;" ></textarea>
                        </div>
                    </div>
                    <div class="dialog-footer">
                        <button type="button" class="blora-button" data-variant="primary" onclick="sendEmailSubmit()" >${t('发送')}</button>
                        <button type="button" class="blora-button" data-variant="outline" onclick="closeDialog('emailDialog')" >${t('取消')}</button>
                    </div>
                </div>
            </blora-dialog>

            <blora-dialog id="userEditDialog" size="lg" aria-label="${t('编辑用户')}">
                <span slot="title" id="user-edit-title">${t('编辑用户')}</span>
                <div class="user-edit-dialog-body">
                    <p class="user-edit-subtitle" id="user-edit-created"></p>
                    <blora-tabs id="user-edit-tabs" value="info">
                        <blora-tab value="info" label="${t('基本信息')}" selected>
                            <form id="user-edit-form" class="user-edit-form">
                                <fieldset class="blora-fieldset" data-variant="flat">
                                    <legend class="blora-fieldset__legend">${t('账号信息')}</legend>
                                    <div class="user-edit-grid">
                                        <div class="blora-field">
                                            <label class="blora-field__label" for="edit_username">${t('用户名')}</label>
                                            <input class="blora-input" id="edit_username" type="text" disabled>
                                        </div>
                                        <div class="blora-field">
                                            <label class="blora-field__label" for="edit_nickname">${t('昵称')}</label>
                                            <input class="blora-input" id="edit_nickname" type="text">
                                        </div>
                                        <div class="blora-field">
                                            <label class="blora-field__label" for="edit_email">${t('电子邮箱')}</label>
                                            <input class="blora-input" id="edit_email" type="email">
                                        </div>
                                        <div class="blora-field">
                                            <label class="blora-field__label" for="edit_password">${t('新密码')}</label>
                                            <input class="blora-input" id="edit_password" type="password" placeholder="${t('留空则不修改')}">
                                        </div>
                                        <div class="blora-field">
                                            <label class="blora-field__label" for="edit_tags">${t('标签')}</label>
                                            <input class="blora-input" id="edit_tags" type="text" placeholder="${t('逗号分隔')}">
                                        </div>
                                        <div class="blora-field">
                                            <span class="blora-field__label">${t('管理员权限')}</span>
                                            <blora-checkbox id="edit_admin">${t('授予管理员权限')}</blora-checkbox>
                                        </div>
                                    </div>
                                </fieldset>
                                <fieldset class="blora-fieldset" data-variant="flat">
                                    <legend class="blora-fieldset__legend">${t('关联信息')}</legend>
                                    <div class="user-edit-grid">
                                        <div class="blora-field">
                                            <label class="blora-field__label" for="edit_github">${t('GitHub ID')}</label>
                                            <input class="blora-input" id="edit_github" type="text">
                                        </div>
                                        <div class="blora-field">
                                            <label class="blora-field__label" for="edit_lark">Lark ID</label>
                                            <input class="blora-input" id="edit_lark" type="text">
                                        </div>
                                        <div class="blora-field full-width">
                                            <label class="blora-field__label" for="edit_avatar">${t('头像 URL')}</label>
                                            <input class="blora-input" id="edit_avatar" type="url">
                                        </div>
                                    </div>
                                </fieldset>
                            </form>
                        </blora-tab>
                        <blora-tab value="stats" label="${t('统计信息')}">
                            <section class="blora-card passport-quota-card">
                                <div>
                                    <h3 class="blora-card__title">${t('今日额度')}</h3>
                                    <strong class="passport-quota-card__value"><span id="today-ai-usage">0</span> / <span id="daily-ai-limit">200</span></strong>
                                    <p class="blora-text-muted">${t('今日已使用请求数。重置会清除该用户今天的 AI 用量记录，并立即恢复完整额度。')}</p>
                                </div>
                                <button type="button" class="blora-button" data-variant="outline" id="reset-ai-quota-btn">${t('重置今日额度')}</button>
                            </section>
                            <div class="user-edit-stats">
                                <div class="user-edit-stat"><div class="user-edit-stat-label">${t('OAuth 授权')}</div><div class="user-edit-stat-value" id="stat-oauth">0</div></div>
                                <div class="user-edit-stat"><div class="user-edit-stat-label">${t('应用令牌')}</div><div class="user-edit-stat-value" id="stat-tokens">0</div></div>
                                <div class="user-edit-stat"><div class="user-edit-stat-label">${t('活跃会话')}</div><div class="user-edit-stat-value" id="stat-sessions">0</div></div>
                                <div class="user-edit-stat"><div class="user-edit-stat-label">${t('今日 AI 请求')}</div><div class="user-edit-stat-value" id="stat-ai-today">0</div></div>
                                <div class="user-edit-stat"><div class="user-edit-stat-label">${t('累计 AI 请求')}</div><div class="user-edit-stat-value" id="stat-ai-all">0</div></div>
                            </div>
                        </blora-tab>
                        <blora-tab value="logs" label="${t('操作日志')}">
                            <div class="user-edit-logs-controls">
                                <blora-select id="log-type-filter" value="all" placeholder="${t('全部类型')}">
                                    <blora-option value="all">${t('全部类型')}</blora-option>
                                    <blora-option value="login">${t('登录')}</blora-option>
                                    <blora-option value="logout">${t('登出')}</blora-option>
                                    <blora-option value="oauth_authorize">${t('OAuth 授权')}</blora-option>
                                    <blora-option value="password_change">${t('修改密码')}</blora-option>
                                    <blora-option value="totp_enable">${t('启用 2FA')}</blora-option>
                                    <blora-option value="totp_disable">${t('禁用 2FA')}</blora-option>
                                </blora-select>
                                <input id="log-keyword-search" class="blora-input" type="text" placeholder="${t('搜索关键词...')}">
                                <button type="button" id="log-refresh-btn" class="blora-button" data-variant="outline">${t('刷新')}</button>
                            </div>
                            <div id="logs-container">
                                <div class="loading">${t('加载中...')}</div>
                            </div>
                            <div id="logs-pagination" class="pagination" aria-live="polite"></div>
                        </blora-tab>
                    </blora-tabs>
                </div>
                <div slot="footer" class="user-edit-footer">
                    <button class="blora-button" data-variant="primary" type="submit" form="user-edit-form" id="save-user-btn">${t('保存修改')}</button>
                    <button class="blora-button" data-variant="ghost" type="button" onclick="closeDialog('userEditDialog')">${t('取消')}</button>
                </div>
            </blora-dialog>

            <blora-dialog id="resetAiQuotaDialog" aria-label="${t('重置今日 AI 额度')}">
                <div class="revoke-dialog-body">
                    <h2>${t('重置今日 AI 额度')}</h2>
                    <p id="reset-ai-quota-message"></p>
                    <div class="revoke-dialog-actions">
                        <button type="button" class="blora-button" data-variant="outline" onclick="closeDialog('resetAiQuotaDialog')">${t('取消')}</button>
                        <button type="button" class="blora-button" data-variant="danger" id="confirm-reset-ai-quota">${t('确认重置')}</button>
                    </div>
                </div>
            </blora-dialog>


            <script>
                ${sidebarScript}

                let currentAppData = null;

                function closeDialog(id) { document.getElementById(id).close(); }
                function openDialog(id) { document.getElementById(id).show(); }

                function toggleSelectAll(checkbox) {
                    document.querySelectorAll('[data-user-checkbox]').forEach(cb => {
                        cb.checked = checkbox.checked;
                    });
                }

                let targetUsername = '';
                let logsLoaded = false;

                function setEditQuery(username) {
                    const url = new URL(window.location.href);
                    if (username) url.searchParams.set('edit', username);
                    else url.searchParams.delete('edit');
                    history.replaceState(null, '', url);
                }

                async function showBloraMessage(text, type) {
                    const { message } = await import('/blora/index.js');
                    if (type === 'error') message.error(String(text || ''));
                    else message.success(String(text || ''));
                    const promote = globalThis.BloraMessageLayer && globalThis.BloraMessageLayer.promoteBloraMessageLayer;
                    if (typeof promote === 'function') promote(document);
                }

                function escapeHtml(text) {
                    const div = document.createElement('div');
                    div.textContent = text;
                    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
                }

                async function openUserEditor(username) {
                    targetUsername = username;
                    logsLoaded = false;
                    setEditQuery(username);
                    try {
                        const response = await fetch('/api/admin/user/' + encodeURIComponent(username));
                        const result = await response.json();
                        if (!response.ok || !result.success) throw new Error(result.message || ${scriptJson(t('加载失败'))});
                        const user = result.data || {};
                        const stats = user.stats || {};
                        const display = user.nickname || user.username || username;
                        document.getElementById('user-edit-title').textContent = ${scriptJson(t('编辑用户：{username}'))}.replace('{username}', display);
                        document.getElementById('user-edit-created').textContent = user.createdAt
                            ? ${scriptJson(t('创建于 {time}'))}.replace('{time}', new Date(user.createdAt).toLocaleString())
                            : '';
                        document.getElementById('edit_username').value = user.username || username;
                        document.getElementById('edit_nickname').value = user.nickname || '';
                        document.getElementById('edit_email').value = user.email || '';
                        document.getElementById('edit_password').value = '';
                        document.getElementById('edit_tags').value = Array.isArray(user.tags) ? user.tags.join(', ') : (user.tags || '');
                        document.getElementById('edit_github').value = user.github || '';
                        document.getElementById('edit_lark').value = user.lark || '';
                        document.getElementById('edit_avatar').value = user.avatar || '';
                        document.getElementById('edit_admin').checked = Boolean(user.admin);
                        document.getElementById('today-ai-usage').textContent = user.todayAIUsage || 0;
                        document.getElementById('daily-ai-limit').textContent = user.dailyAILimit || 200;
                        document.getElementById('stat-oauth').textContent = stats.oauthApprovals || 0;
                        document.getElementById('stat-tokens').textContent = stats.appTokens || 0;
                        document.getElementById('stat-sessions').textContent = stats.activeSessions || 0;
                        document.getElementById('stat-ai-today').textContent = user.todayAIUsage || 0;
                        document.getElementById('stat-ai-all').textContent = stats.totalAIRequests || 0;
                        document.getElementById('logs-container').innerHTML = '<div class="loading">' + ${scriptJson(t('加载中...'))} + '</div>';
                        document.getElementById('logs-pagination').innerHTML = '';
                        const tabs = document.getElementById('user-edit-tabs');
                        if (tabs) tabs.setAttribute('value', 'info');
                        openDialog('userEditDialog');
                    } catch (error) {
                        alert(error.message || ${scriptJson(t('加载失败，请稍后重试'))});
                    }
                }

                async function loadLogs(page = 1) {
                    const type = document.getElementById('log-type-filter').value;
                    const keyword = document.getElementById('log-keyword-search').value;
                    const container = document.getElementById('logs-container');
                    container.innerHTML = '<div class="loading">' + ${scriptJson(t('加载中...'))} + '</div>';
                    try {
                        const params = new URLSearchParams({ page: page.toString() });
                        if (type && type !== 'all') params.append('type', type);
                        if (keyword) params.append('keyword', keyword);
                        const response = await fetch('/api/admin/user/' + encodeURIComponent(targetUsername) + '/logs?' + params.toString());
                        const data = await response.json();
                        if (!response.ok) throw new Error(data.message || ${scriptJson(t('加载失败'))});
                        const logs = data.logs || [];
                        if (logs.length === 0) {
                            container.innerHTML = '<div class="empty-state">' + ${scriptJson(t('暂无日志记录'))} + '</div>';
                        } else {
                            container.innerHTML = logs.map(log => {
                                const timestamp = new Date(log.time).toLocaleString();
                                return '<div class="user-edit-log-item">' +
                                    '<div class="log-time">' + escapeHtml(timestamp) + '</div>' +
                                    '<div class="log-type">' + escapeHtml(log.type || '-') + '</div>' +
                                    '<div class="log-detail">' + escapeHtml(log.message || '-') + '</div>' +
                                    '<div class="log-ip">' + escapeHtml(log.ip || '-') + '</div>' +
                                    '</div>';
                            }).join('');
                        }
                        renderPagination(data.page, data.totalPages);
                    } catch (error) {
                        container.innerHTML = '<div class="error-state">' + ${scriptJson(t('加载失败:'))} + ' ' + escapeHtml(error.message) + '</div>';
                    }
                }

                function renderPagination(currentPage, totalPages) {
                    const container = document.getElementById('logs-pagination');
                    if (totalPages <= 1) {
                        container.innerHTML = '';
                        return;
                    }
                    container.innerHTML = '<blora-pagination page="' + currentPage + '" total="' + totalPages + '" max-visible="7" label="${t('日志分页')}"></blora-pagination>';
                    const pagination = container.querySelector('blora-pagination');
                    if (pagination) pagination.addEventListener('blora-change', (event) => loadLogs(event.detail.page), { once: true });
                }

                document.addEventListener('DOMContentLoaded', () => {
                    const selectAll = document.querySelector('[data-select-all-users]');
                    if (selectAll) selectAll.addEventListener('change', () => toggleSelectAll(selectAll));

                    const userEditDialog = document.getElementById('userEditDialog');
                    if (userEditDialog) {
                        userEditDialog.addEventListener('close', () => setEditQuery(''));
                        userEditDialog.addEventListener('blora-close', () => setEditQuery(''));
                    }
                    const tabs = document.getElementById('user-edit-tabs');
                    if (tabs) tabs.addEventListener('blora-change', (event) => {
                        if (event.detail && event.detail.value === 'logs' && !logsLoaded) {
                            logsLoaded = true;
                            loadLogs(1);
                        }
                    });
                    document.getElementById('user-edit-form').addEventListener('submit', async function(event) {
                        event.preventDefault();
                        const button = document.getElementById('save-user-btn');
                        button.disabled = true;
                        try {
                            const response = await fetch('/api/admin/user/update', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    username: targetUsername,
                                    nickname: document.getElementById('edit_nickname').value,
                                    email: document.getElementById('edit_email').value,
                                    password: document.getElementById('edit_password').value,
                                    admin: document.getElementById('edit_admin').checked,
                                    tags: document.getElementById('edit_tags').value,
                                    github: document.getElementById('edit_github').value,
                                    lark: document.getElementById('edit_lark').value,
                                    avatar: document.getElementById('edit_avatar').value
                                })
                            });
                            const result = await response.json();
                            if (!response.ok || !result.success) throw new Error(result.message || ${scriptJson(t('保存失败'))});
                            document.getElementById('edit_password').value = '';
                            await showBloraMessage(${scriptJson(t('用户信息已保存'))}, 'success');
                        } catch (error) {
                            await showBloraMessage(error.message || ${scriptJson(t('保存失败，请稍后重试'))}, 'error');
                        } finally {
                            button.disabled = false;
                        }
                    });
                    document.getElementById('reset-ai-quota-btn').addEventListener('click', () => {
                        const usage = Number(document.getElementById('today-ai-usage').textContent) || 0;
                        const message = usage > 0
                            ? ${scriptJson(t('确定要重置用户 “{username}” 的今日 AI 额度吗？此操作会删除今天的 {usage} 条 AI 用量记录。'))}.replace('{username}', targetUsername).replace('{usage}', usage)
                            : ${scriptJson(t('该用户今日用量已经是 0，仍要执行重置吗？'))};
                        document.getElementById('reset-ai-quota-message').textContent = message;
                        openDialog('resetAiQuotaDialog');
                    });
                    document.getElementById('confirm-reset-ai-quota').addEventListener('click', async () => {
                        closeDialog('resetAiQuotaDialog');
                        const button = document.getElementById('reset-ai-quota-btn');
                        button.disabled = true;
                        button.textContent = ${scriptJson(t('正在重置…'))};
                        try {
                            const response = await fetch('/api/admin/user/' + encodeURIComponent(targetUsername) + '/reset-ai-quota', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({})
                            });
                            const result = await response.json();
                            if (!response.ok || !result.success) throw new Error(result.message || ${scriptJson(t('重置失败'))});
                            document.getElementById('today-ai-usage').textContent = '0';
                            document.getElementById('stat-ai-today').textContent = '0';
                            await showBloraMessage(${scriptJson(t('今日 AI 额度已重置，共清除 {count} 条用量记录。'))}.replace('{count}', result.data.resetCount), 'success');
                        } catch (error) {
                            await showBloraMessage(error.message || ${scriptJson(t('重置失败，请稍后重试'))}, 'error');
                        } finally {
                            button.disabled = false;
                            button.textContent = ${scriptJson(t('重置今日额度'))};
                        }
                    });
                    const typeFilter = document.getElementById('log-type-filter');
                    const reloadLogs = () => { if (logsLoaded) loadLogs(1); };
                    typeFilter.addEventListener('change', reloadLogs);
                    typeFilter.addEventListener('blora-change', reloadLogs);
                    let searchTimeout;
                    document.getElementById('log-keyword-search').addEventListener('input', () => {
                        if (!logsLoaded) return;
                        clearTimeout(searchTimeout);
                        searchTimeout = setTimeout(() => loadLogs(1), 500);
                    });
                    document.getElementById('log-refresh-btn').addEventListener('click', () => {
                        if (logsLoaded) loadLogs(1);
                    });
                    const pendingEdit = new URLSearchParams(window.location.search).get('edit');
                    if (pendingEdit) openUserEditor(pendingEdit);
                });

                function batchEmail() {
                    const selected = Array.from(document.querySelectorAll('.user-checkbox')).filter(cb => cb.checked).map(cb => cb.value);
                    if (selected.length === 0) return alert(${scriptJson(t('请先选择用户'))});
                    openEmailDialog(selected);
                }

                function openEmailDialog(usernames) {
                    document.getElementById('emailTo').value = ${scriptJson(t('{count} 位用户: {list}'))}.replace('{count}', usernames.length).replace('{list}', usernames.join(', '));
                    document.getElementById('emailToUsernames').value = JSON.stringify(usernames);
                    openDialog('emailDialog');
                }

                async function sendEmailSubmit() {
                    const subject = document.getElementById('emailSubject').value;
                    const content = document.getElementById('emailContent').value;
                    const recipients = JSON.parse(document.getElementById('emailToUsernames').value);
                    try {
                        const res = await fetch('/api/admin/send-email', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ subject, content, recipients }) });
                        const json = await res.json();
                        if (json.success) { alert(json.message); closeDialog('emailDialog'); } else { alert(${scriptJson(t('发送失败: {message}'))}.replace('{message}', json.message)); }
                    } catch(e) { alert(${scriptJson(t('请求出错: {message}'))}.replace('{message}', e.message)); }
                }

                async function showAppCard(appId) {
                    try {
                        const res = await fetch('/api/admin/oauthapp/' + appId);
                        const json = await res.json();
                        if (!json.success) return alert(json.message);
                        currentAppData = json.data;
                        const a = currentAppData;
                        const html = \`
                            <div class="info-row"><div class="info-label">ID:</div><div class="info-value">\${escapeHtml(a.id)}</div></div>
                            <div class="info-row"><div class="info-label">${t('名称:')}</div><div class="info-value">\${escapeHtml(a.name)}</div></div>
                            <div class="info-row"><div class="info-label">${t('所有者:')}</div><div class="info-value">\${escapeHtml(a.ownerDisplayName || a.owner || ${scriptJson(t('无'))})}</div></div>
                            <div class="info-row"><div class="info-label">${t('官方:')}</div><div class="info-value">\${a.official ? ${scriptJson(t('是'))} : ${scriptJson(t('否'))}}</div></div>
                            <div class="info-row"><div class="info-label">${t('描述:')}</div><div class="info-value">\${escapeHtml(a.description)}</div></div>
                            <div class="info-row"><div class="info-label">Secret:</div><div class="info-value">\${escapeHtml(a.app_secret)}</div></div>
                            <div class="info-row"><div class="info-label">${t('回调:')}</div><div class="info-value">\${(a.redirect_uri || []).map(escapeHtml).join('<br>')}</div></div>
                        \`;
                        document.getElementById('appCardBody').innerHTML = html;
                        openDialog('appCardDialog');
                    } catch(e) { alert(${scriptJson(t('加载失败: {message}'))}.replace('{message}', e.message)); }
                }

                function viewAppDetail() {
                    closeDialog('appCardDialog');
                    window.location.href = '/oauthapp/' + currentAppData.id;
                }

                function editApp() {
                    closeDialog('appCardDialog');
                    const a = currentAppData;
                    const modelOptions = '<blora-option value="">${t('未绑定')}</blora-option>${aiModelOptionsHtml}';
                    const maskedSecret = a.app_secret ? a.app_secret.substring(0, 8) + '•'.repeat(24) : '';
                    const html = \`
                        <div class="form-group"><label class="form-label">ID</label><input class="blora-input" type="text" value="\${escapeHtml(a.id)}" style="width: 100%; background: #eee;" readonly ></div>
                        <div class="form-group"><label class="form-label">${t('名称')}</label><input class="blora-input" id="edit_app_name" type="text" value="\${escapeHtml(a.name)}" style="width: 100%;" ></div>
                        <div class="form-group"><label class="form-label">${t('所有者')}</label><input class="blora-input" id="edit_app_owner" type="text" value="\${escapeHtml(a.owner || '')}" style="width: 100%;" ></div>
                        <div class="form-group"><blora-checkbox id="edit_app_official" \${a.official ? 'checked' : ''}>${t('官方应用')}</blora-checkbox></div>
                        <div class="form-group"><label class="form-label">${t('描述')}</label><input class="blora-input" id="edit_app_desc" type="text" value="\${escapeHtml(a.description)}" style="width: 100%;" ></div>
                        <div class="form-group"><label class="form-label">${t('应用密钥')}</label>
                            <div style="background: var(--secondary); border: 1px solid var(--blora-color-border-subtle); border-radius: 8px; padding: 10px 12px; font-family: monospace; font-size: 13px; word-break: break-all; position: relative;">
                                <span id="admin-secret-display">\${escapeHtml(maskedSecret)}</span>
                                <div style="position: absolute; top: 6px; right: 6px; display: flex; gap: 4px;">
                                    <button type="button" class="blora-button" data-variant="outline" style="font-size: 11px; padding: 2px 8px;" onclick="adminToggleSecret()">${t('显示')}</button>
                                    <button type="button" class="blora-button" data-variant="outline" style="font-size: 11px; padding: 2px 8px;" onclick="adminCopySecret()">${t('复制')}</button>
                                    <button type="button" class="blora-button" data-variant="outline" style="font-size: 11px; padding: 2px 8px; color: var(--destructive); border-color: var(--destructive);" onclick="adminRegenSecret()">${t('重置')}</button>
                                </div>
                            </div>
                            <input type="hidden" id="edit_app_secret" value="\${escapeHtml(a.app_secret)}">
                        </div>
                        <div class="form-group"><label class="form-label">Icon URL</label><input class="blora-input" id="edit_app_icon" type="text" value="\${escapeHtml(a.icon || '')}" style="width: 100%;" ></div>
                        <div class="form-group"><label class="form-label">${t('绑定 AI 模型 (用于 AI API)')}</label><blora-select class="blora-select" id="edit_app_bound_model" style="width: 100%;">\${modelOptions}</blora-select></div>
                        <div class="form-group"><label class="form-label">${t('回调地址 (每行一个)')}</label><textarea class="blora-textarea" id="edit_app_redirect" style="width: 100%; height: 80px;">\${escapeHtml((a.redirect_uri || []).join('\\n'))}</textarea></div>
                        <div class="form-group"><label class="form-label">${t('权限 (逗号分隔)')}</label><input class="blora-input" id="edit_app_perms" type="text" value="\${escapeHtml((a.permissions || []).join(','))}" style="width: 100%;" ></div>
                    \`;
                    document.getElementById('appEditBody').innerHTML = html;
                    if (a.bound_model) {
                        document.getElementById('edit_app_bound_model').value = a.bound_model;
                    }
                    // 存储原始密钥供 JS 使用
                    window._adminSecret = a.app_secret;
                    window._adminSecretVisible = false;
                    openDialog('appEditDialog');
                }

                function adminToggleSecret() {
                    const el = document.getElementById('admin-secret-display');
                    window._adminSecretVisible = !window._adminSecretVisible;
                    el.textContent = window._adminSecretVisible ? window._adminSecret : window._adminSecret.substring(0, 8) + '•'.repeat(24);
                    el.parentElement.querySelectorAll('button')[0].textContent = window._adminSecretVisible ? ${scriptJson(t('隐藏'))} : ${scriptJson(t('显示'))};
                }
                function adminCopySecret() {
                    navigator.clipboard.writeText(window._adminSecret).then(() => {
                        const btn = document.getElementById('admin-secret-display').parentElement.querySelectorAll('button')[1];
                        btn.textContent = ${scriptJson(t('已复制'))};
                        setTimeout(() => { btn.textContent = ${scriptJson(t('复制'))}; }, 2000);
                    });
                }
                async function adminRegenSecret() {
                    if (!confirm(${scriptJson(t('确定要重新生成此应用的密钥吗？\n旧密钥将立即失效。'))})) return;
                    try {
                        const res = await fetch('/api/oauthapp/' + currentAppData.id + '/regenerate-secret', { method: 'POST' });
                        const json = await res.json();
                        if (json.success) {
                            window._adminSecret = json.data.app_secret;
                            document.getElementById('edit_app_secret').value = json.data.app_secret;
                            document.getElementById('admin-secret-display').textContent = json.data.app_secret.substring(0, 8) + '•'.repeat(24);
                            window._adminSecretVisible = false;
                            alert(${scriptJson(t('新密钥: {secret}\n请立即保存。'))}.replace('{secret}', json.data.app_secret));
                        } else { alert(${scriptJson(t('操作失败: {message}'))}.replace('{message}', json.message)); }
                    } catch(e) { alert(${scriptJson(t('请求出错: {message}'))}.replace('{message}', e.message)); }
                }

                async function saveAppEdit() {
                    const data = {
                        id: currentAppData.id,
                        name: document.getElementById('edit_app_name').value,
                        owner: document.getElementById('edit_app_owner').value,
                        official: document.getElementById('edit_app_official').checked,
                        description: document.getElementById('edit_app_desc').value,
                        app_secret: document.getElementById('edit_app_secret').value,
                        icon: document.getElementById('edit_app_icon').value,
                        redirect_uri: document.getElementById('edit_app_redirect').value,
                        permissions: document.getElementById('edit_app_perms').value,
                        bound_model: document.getElementById('edit_app_bound_model').value || null
                    };
                    try {
                        const res = await fetch('/api/admin/oauthapp/update', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
                        const json = await res.json();
                        if (json.success) { alert(${scriptJson(t('保存成功'))}); location.reload(); } else { alert(${scriptJson(t('保存失败: {message}'))}.replace('{message}', json.message)); }
                    } catch(e) { alert(${scriptJson(t('请求出错: {message}'))}.replace('{message}', e.message)); }
                }

                async function manageAppUsers() {
                    closeDialog('appCardDialog');
                    try {
                        const res = await fetch('/api/admin/oauthapp/' + currentAppData.id + '/users');
                        const json = await res.json();
                        if (!json.success) return alert(json.message);
                        
                        const users = json.data;
                        const html = users.length ? users.map(u => \`
                            <div class="user-list-item">
                                <div style="display:flex; align-items:center; gap:8px;">
                                    <img src="\${escapeHtml(u.avatar || 'https://ui-avatars.com/api/?name='+encodeURIComponent(u.username))}" style="width:24px;height:24px;border-radius:50%;">
                                    <span>\${escapeHtml(u.username)}</span>
                                </div>
                                <button type="button" class="blora-button" data-variant="outline" data-username="\${escapeHtml(u.username)}" onclick="revokeUser(this.dataset.username)" style="color:red; border-color:red;" >${t('撤销授权')}</button>
                            </div>
                        \`).join('') : '<div style="text-align:center; color:#999;">${t('暂无授权用户')}</div>';
                        document.getElementById('appUsersBody').innerHTML = html;
                        openDialog('appUsersDialog');
                    } catch(e) { alert(${scriptJson(t('加载失败: {message}'))}.replace('{message}', e.message)); }
                }

                async function revokeUser(username) {
                    if (!confirm(${scriptJson(t('确定撤销用户 {username} 的授权吗？'))}.replace('{username}', username))) return;
                    try {
                        const res = await fetch('/api/admin/oauthapp/' + currentAppData.id + '/revoke', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username }) });
                        const json = await res.json();
                        if (json.success) { manageAppUsers(); } else { alert(${scriptJson(t('操作失败: {message}'))}.replace('{message}', json.message)); }
                    } catch(e) { alert(${scriptJson(t('请求出错: {message}'))}.replace('{message}', e.message)); }
                }

            </script>
        </body>
    </html>
    `;
}

function renderOpenPlatformAppCard(app) {
    const rawId = String(app.id || '');
    const id = escapeHtml(rawId);
    const name = escapeHtml(String(app.name || rawId || ''));
    const desc = app.description
        ? escapeHtml(String(app.description))
        : `<span class="blora-text-muted">${t('暂无')}</span>`;
    const initial = escapeHtml(String(app.name || rawId || '?').trim().slice(0, 1) || '?');
    const avatar = app.icon
        ? `<img src="${escapeHtml(String(app.icon))}" alt="">`
        : initial;
    const badge = app.official
        ? `<span class="blora-badge" data-variant="success">${t('官方')}</span>`
        : `<span class="blora-badge" data-variant="success">${t('已创建')}</span>`;
    const hrefId = encodeURIComponent(rawId);
    return `<section class="blora-card passport-app-card">
        <header class="blora-card__head">
            <div>
                ${badge}
                <h2 class="blora-card__title">${name}</h2>
            </div>
            <span class="blora-avatar" data-size="md" data-variant="primary">${avatar}</span>
        </header>
        <table class="blora-descriptions">
            <tr><th>${t('应用名称')}</th><td>${name}</td></tr>
            <tr><th>${t('应用 ID')}</th><td><code class="passport-id">${id}</code></td></tr>
            <tr><th>${t('描述')}</th><td>${desc}</td></tr>
        </table>
        <div class="blora-card__foot passport-actions">
            <a class="blora-button" data-variant="primary" href="/oauthapp/${hrefId}">${t('查看详情')}</a>
            <a class="blora-button" data-variant="outline" href="/edit/oauthapp/${hrefId}">${t('编辑应用')}</a>
        </div>
    </section>`;
}

function generateOpenPlatformHtml(user, allApps) {
    const ownerKey = String(user.username || '').toLowerCase();
    const userOAuthApps = (allApps || []).filter((app) => String(app.owner || '').toLowerCase() === ownerKey);
    const docsUrl = 'https://bbs.bloret.net/#post/Bloret%20Software%20Community/Bloret%20PassPort/1770907136954_si3o0.json';
    const appsHtml = userOAuthApps.length
        ? `<div class="passport-app-grid">${userOAuthApps.map((app) => renderOpenPlatformAppCard(app)).join('')}</div>`
        : `<blora-empty title="${escapeHtml(t('暂无创建的应用'))}" description="${escapeHtml(t('注册一个 OAuth 应用后，它会显示在这里。'))}"></blora-empty>`;

    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('开放平台 - Bloret PassPort')}</title>
    <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope">
    ${generateSidebarHtml(user, 'open-platform')}
    <div class="main-content-apple">
        <section class="blora-hero passport-open-hero" data-variant="surface" data-size="compact">
            <div class="blora-hero__content">
                <span class="blora-badge" data-variant="info">${t('OAuth 平台')}</span>
                <h1 class="blora-hero__title">${t('Bloret PassPort 开放平台')}</h1>
                <p class="blora-hero__description">${t('注册并管理您的 OAuth 应用，快速接入 Bloret Software Community。')}</p>
                <div class="passport-actions">
                    <a class="blora-button" data-variant="primary" href="/app/register">${t('注册 OAuth App')}</a>
                    <a class="blora-button" data-variant="outline" href="${docsUrl}">${t('OAuth API 文档')}</a>
                </div>
            </div>
            <div class="blora-hero__aside" aria-hidden="true" data-icon="shield-check"></div>
        </section>
        <section class="passport-app-list">
            <header class="passport-app-list__head">
                <h2 class="blora-card__title">${t('我的 OAuth 应用')}</h2>
                <p class="blora-card__description">${t('管理您注册的 OAuth 客户端和访问权限。')}</p>
            </header>
            ${appsHtml}
        </section>
    </div>
    <script>${sidebarScript}</script>
</body>
</html>
    `;
}

// generateMinecraftPageHtml 已迁移至 minecraft.js

// app.use((req, res) => {
//     res.status(404).send(`
// <!DOCTYPE html>
// <html lang="${htmlLang()}">
// <head>
//     <meta charset="UTF-8">
//     <meta name="viewport" content="width=device-width, initial-scale=1.0">
//     <title>404 Not Found - Bloret PassPort</title>
//     <link rel="stylesheet" href="/index.css">
//     <script src="/csrf-client.js"></script>
//     <style>
//         .center-container {
//             display: flex;
//             justify-content: center;
//             align-items: center;
//             min-height: 100vh;
//             width: 100%;
//             padding: 20px;
//             box-sizing: border-box;
//         }
//         .card {
//             width: 100%;
//             max-width: 500px;
//             padding: 30px;
//             text-align: center;
//         }
//         .error-code {
//             font-size: 100px;
//             color: #ff4444;
//             margin-bottom: 20px;
//         }
//         .error-message {
//             font-size: 24px;
//             color: black;
//             margin-bottom: 30px;
//         }
//         .home-link {
//             color: white;
//             text-decoration: none;
//             font-size: 18px;
//         }
//     </style>
// ${bloraAssetTags()}</head>
// <body class="blora-page blora-scope">
//     <div class="center-container">
//         <div class="post blora-card">
//             <div class="error-code">404</div>
//             <div class="error-message">页面未找到</div>
//             <a href="/" class="home-link">返回首页</a>
//         </div>
//     </div>
// </body>
// </html>
//     `);
// });

// 兼容旧链接 /passkey/register（曾错误跳转至此导致 Cannot GET）
app.get('/passkey/register', async (req, res) => {
    if (!req.authUsername) {
        return res.redirect('/?redirect_uri=' + encodeURIComponent('/?security=1'));
    }
    return res.redirect('/?security=1');
});

// --- 统一的 PassKey 路由处理 ---

app.get('/api/passkey/register/options', async (req, res) => {
    try {
        const cookies = parseCookies(req.headers.cookie || '');
        const username = req.authUsername;
        if (!username) return res.status(401).json({ error: t('未登录') });
        const user = await db.getUser(username);
        if (!user) return res.status(401).json({ error: t('未登录') });

        const options = await passkeyManager.getRegistrationOptions(user, req.sessionToken);
        res.json(options);
    } catch (e) {
        console.error('Passkey Options Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/passkey/register/verify', async (req, res) => {
    try {
        const cookies = parseCookies(req.headers.cookie || '');
        const username = req.authUsername;
        if (!username) return res.status(401).json({ error: t('未登录') });
        const user = await db.getUser(username);
        if (!user) return res.status(401).json({ error: t('未登录') });

        const info = await passkeyManager.verifyRegistration(username, req.body, req.sessionToken);

        // --- 关键修复：从 info.credential 中提取数据 ---
        // 根据你的日志，数据在 credential 子对象里
        const credData = info.credential || {};

        const credentialID = credData.id;
        const credentialPublicKey = credData.publicKey;
        const counter = credData.counter;
        const transports = credData.transports || [];

        // 这些通常在根级别
        const fmt = info.fmt;
        const credentialDeviceType = info.credentialDeviceType;

        if (!credentialID || !credentialPublicKey) {
            console.error('[PassKey Error] Missing Data. ID:', credentialID, 'PublicKey:', !!credentialPublicKey);
            throw new Error(t('验证返回数据不完整'));
        }

        if (!user.passkeys) user.passkeys = [];

        // 智能处理 ID：Base64URL 字符串无需转换
        let storedID;
        if (typeof credentialID === 'string') {
            storedID = credentialID;
        } else {
            storedID = Buffer.from(credentialID).toString('base64url');
        }

        // 处理公钥：它可能是一个 Buffer 或者是类数组对象
        let storedPublicKey;
        if (Buffer.isBuffer(credentialPublicKey) || credentialPublicKey instanceof Uint8Array) {
            storedPublicKey = Buffer.from(credentialPublicKey).toString('base64');
        } else {
            // 处理 {0: 164, 1: 1...} 这种对象格式
            storedPublicKey = Buffer.from(Object.values(credentialPublicKey)).toString('base64');
        }

        const newCredential = {
            credentialID: storedID,
            credentialPublicKey: storedPublicKey,
            counter: counter || 0,
            fmt: fmt,
            deviceType: credentialDeviceType || 'unknown',
            transports: transports,
            name: (typeof req.body.name === 'string' ? req.body.name.trim() : ''),
            createdAt: new Date().toISOString()
        };

        await db.mutatePasskey(username, { operation: 'add', credentialID: storedID, credential: newCredential }, user);
        await db.logUserAction(username, 'passkey_reg', t('成功绑定通行密钥'), req.ip);
        res.json({ success: true });
    } catch (e) {
        console.error('Passkey Verify Error:', e);
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/passkey/delete', async (req, res) => {
    try {
        const username = req.authUsername;
        if (!username) return res.status(401).json({ error: t('未登录') });
        const user = await db.getUser(username);
        if (!user) return res.status(401).json({ error: t('未登录') });

        const credentialID = req.body && req.body.id;
        if (!credentialID || typeof credentialID !== 'string') {
            return res.status(400).json({ error: t('缺少通行密钥 ID') });
        }

        const passkeys = Array.isArray(user.passkeys) ? user.passkeys : [];
        if (!passkeys.some(k => k && k.credentialID === credentialID)) {
            return res.status(404).json({ error: t('未找到该通行密钥') });
        }

        await db.mutatePasskey(username, { operation: 'remove', credentialID }, user);
        await db.logUserAction(username, 'passkey_delete', t('删除通行密钥'), req.ip);
        res.json({ success: true });
    } catch (e) {
        console.error('Passkey Delete Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/passkey/rename', async (req, res) => {
    try {
        const username = req.authUsername;
        if (!username) return res.status(401).json({ error: t('未登录') });
        const user = await db.getUser(username);
        if (!user) return res.status(401).json({ error: t('未登录') });

        const credentialID = req.body && req.body.id;
        const name = (req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '');
        if (!credentialID || typeof credentialID !== 'string') {
            return res.status(400).json({ error: t('缺少通行密钥 ID') });
        }

        const passkeys = Array.isArray(user.passkeys) ? user.passkeys : [];
        const target = passkeys.find(k => k && k.credentialID === credentialID);
        if (!target) {
            return res.status(404).json({ error: t('未找到该通行密钥') });
        }

        await db.mutatePasskey(username, { operation: 'rename', credentialID, name }, user);
        await db.logUserAction(username, 'passkey_rename', t('重命名通行密钥'), req.ip);
        res.json({ success: true });
    } catch (e) {
        console.error('Passkey Rename Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/passkey/login/options', passkeyRateLimit, async (req, res) => {
    try {
        // 登录选项始终使用可发现凭据，不依赖用户名或其它输入框。
        const options = await passkeyManager.getAuthenticationOptions(undefined, `login:${issuePasskeyBrowserBinding(res)}`);
        res.json(options);
    } catch (e) {
        console.error('Login Options Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/passkey/login/verify', passkeyRateLimit, async (req, res) => {
    try {
        const { response, challenge } = req.body;
        
        let user;
        let passkey;

        // 验证结果中的 credential ID 唯一确定账号，不读取用户名输入框。
        const allUsers = await db.getAllUsers();
        for (const u of allUsers) {
            if (u.passkeys) {
                const pk = u.passkeys.find(k => k.credentialID === response.id);
                if (pk) {
                    user = u;
                    passkey = pk;
                    break;
                }
            }
        }
        if (!user) return res.status(400).json({ error: t('未找到匹配的通行密钥') });
        user = await db.getUser(user.username);
        passkey = user?.passkeys?.find(k => k.credentialID === response.id);

        if (!passkey) return res.status(400).json({ error: t('此设备未绑定该账号') });

        const info = await passkeyManager.verifyAuthentication(passkey, response, challenge, `login:${readPasskeyBrowserBinding(req)}`);

        // 更新计数器
        await db.mutatePasskey(user.username, { operation: 'counter', credentialID: passkey.credentialID, expectedCounter: passkey.counter, newCounter: info.newCounter }, user);

        // 设置 3 个月有效期
        const threeMonths = 90 * 24 * 60 * 60 * 1000;
        await establishSession(res, user.username, SESSION_MAX_AGE_MS, {}, user);

        await db.logUserAction(user.username, 'passkey_login', t('通行密钥登录成功'), getClientIp(req));
        res.json({ success: true });
    } catch (e) {
        console.error('PassKey Login Verify Error:', e);
        res.status(400).json({ error: e.message });
    }
});

// 新增：代理头像上传接口，解决前端 CORS 跨域问题
app.post('/api/proxy/upload_avatar', require('./lib/avatar-proxy').createAvatarProxy({ db }));

function generateEditOAuthAppHtml(currentUser, appId, app, error = null) {
    // 此时参数顺序正确，app 指向实际的应用对象，error 为可选错误信息
    const permissions = Array.isArray(app.permissions) ? app.permissions : [];
    const redirectUris = getOAuthRedirectUris(app).join('\n');
    const permOptions = [
        ['user:name', t('用户名称 (user:name)')],
        ['user:head', t('用户头像 (user:head)')],
        ['user:email', t('用户邮箱 (user:email)')],
        ['user:admin', t('管理员权限 (user:admin)')],
        ['app:usertoken', t('生成长期令牌 (app:usertoken)')],
        ['user:tags', t('用户标签 (user:tags)')],
        ['ai:use', t('使用用户 AI 额度 (ai:use)')],
        ['minecraft:accounts', t('读取 Minecraft 游戏凭据 (minecraft:accounts)')],
        ['bbbs:session', t('以用户身份登录 BBBS (bbbs:session)')],
    ];
    const permissionFields = permOptions.map(([value, label]) => `
                                                                                        <div class="permission-checkbox-item">
                                                                                            <blora-checkbox name="permissions" value="${value}" ${permissions.includes(value) ? 'checked' : ''}>${label}</blora-checkbox>
                                                                                        </div>`).join('');
    const sf = (name, color = '0071e3') => `https://img.bloret.net/SF/${name}?color=%23${color}`;

    return `
                                            <!DOCTYPE html>
                                            <html lang="${htmlLang()}">
                                                <head>
                                                    <link rel="icon" href="/BL.png" type="image/png">
                                                    <link rel="apple-touch-icon" href="/BL.png">
                                                    <meta charset="UTF-8">
                                                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                                            <title>${t('编辑 OAuth App - Bloret PassPort')}</title>
                                                                                                                        <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
                                                            ${bloraAssetTags()}</head>
                                                            <body class="blora-page blora-scope">
                                                                ${generateSidebarHtml(currentUser, 'open-platform')}

                                                                <div class="main-content-apple">
                                                                    <h1 class="page-title">${t('编辑 OAuth App')}</h1>
                                                                    <div class="user-info-card blora-card">
                                                                        <div class="post-title">${escapeHtml(t('应用详情: {name}', { name: app.name }))}</div>
                                                                        <div class="post-content">
                                                                            <p style="color: var(--foreground); margin-bottom: 20px;">${t('应用 ID:')} <strong>${appId}</strong> ${t('(不可更改)')}</p>

                                                                            ${(error && typeof error === 'string') ? `<div style="color: #ff4444; margin-bottom: 15px;">${error}</div>` : ''}

                                                                            <form action="/edit/oauthapp/${appId}" method="POST">
                                                                                <div class="form-group">
                                                                                    <label class="form-label" for="name">${t('应用名称 *')}</label>
                                                                                    <input class="blora-input form-input" id="name" name="name" type="text" value="${escapeHtml(String(app.name))}" required >
                                                                                </div>

                                                                                <div class="form-group">
                                                                                    <label class="form-label" for="description">${t('应用描述 *')}</label>
                                                                                    <input class="blora-input form-input" id="description" name="description" type="text" value="${escapeHtml(String(app.description))}" required >
                                                                                </div>

                                                                                <div class="form-group">
                                                                                    <label class="form-label" for="icon">${t('图标URL *')}</label>
                                                                                    <input class="blora-input form-input" id="icon" name="icon" type="text" value="${escapeHtml(String(app.icon || ''))}" required >
                                                                                </div>

                                                                                <div class="form-group">
                                                                                    <label class="form-label">${t('应用密钥')}</label>
                                                                                    <div style="background: var(--secondary); border: 1px solid var(--blora-color-border-subtle); border-radius: 10px; padding: 14px 16px; font-family: monospace; font-size: 13px; word-break: break-all; position: relative;">
                                                                                        <span id="secret-display">${escapeHtml(String(app.app_secret.substring(0, 8)))}${'•'.repeat(24)}</span>
                                                                                        <div style="position: absolute; top: 8px; right: 8px; display: flex; gap: 6px;">
                                                                                            <button type="button" class="blora-button" data-variant="outline" style="font-size: 12px; padding: 3px 10px;" onclick="toggleEditSecret()">${t('显示')}</button>
                                                                                            <button type="button" class="blora-button" data-variant="outline" style="font-size: 12px; padding: 3px 10px;" onclick="copyEditSecret()">${t('复制')}</button>
                                                                                            <button type="button" class="blora-button" data-variant="outline" style="font-size: 12px; padding: 3px 10px; color: var(--destructive); border-color: var(--destructive);" onclick="regenerateSecret()">${t('重新生成')}</button>
                                                                                        </div>
                                                                                    </div>
                                                                                    <input type="hidden" id="app_secret" name="app_secret" value="${escapeHtml(String(app.app_secret))}">
                                                                                </div>

                                                                                <div class="form-group">
                                                                                    <label class="form-label">${t('权限 *')}</label>
                                                                                    <div class="permission-checkboxes">
                                                                                        ${permissionFields}
                                                                                    </div>
                                                                                </div>

                                                                                <div class="form-group">
                                                                                    <label class="form-label" for="redirect_uri">${t('重定向URI (每行一个)')}</label>
                                                                                    <textarea class="blora-textarea form-textarea" id="redirect_uri" name="redirect_uri"></textarea>
                                                                                </div>

                                                                                <button class="blora-button" data-variant="primary" type="submit" style="width: 100%;" >${t('保存修改')}</button>

                                                                                <script>
                                                                                    document.getElementById('redirect_uri').value = ${scriptJson(redirectUris)};
                                                                                    const _secret = ${scriptJson(app.app_secret)};
                                                                                    let _secretVisible = false;
                                                                                    function toggleEditSecret() {
                                                                                        const el = document.getElementById('secret-display');
                                                                                        _secretVisible = !_secretVisible;
                                                                                        el.textContent = _secretVisible ? _secret : _secret.substring(0, 8) + '•'.repeat(24);
                                                                                        el.parentElement.querySelectorAll('button')[0].textContent = _secretVisible ? ${scriptJson(t('隐藏'))} : ${scriptJson(t('显示'))};
                                                                                    }
                                                                                    function copyEditSecret() {
                                                                                        navigator.clipboard.writeText(_secret).then(() => {
                                                                                            const btn = document.getElementById('secret-display').parentElement.querySelectorAll('button')[1];
                                                                                            btn.textContent = ${scriptJson(t('已复制'))};
                                                                                            setTimeout(() => { btn.textContent = ${scriptJson(t('复制'))}; }, 2000);
                                                                                        });
                                                                                    }
                                                                                    async function regenerateSecret() {
                                                                                        if (!confirm(${scriptJson(t('确定要重新生成应用密钥吗？\n旧密钥将立即失效，所有使用旧密钥的集成需要更新。'))})) return;
                                                                                        try {
                                                                                            const res = await fetch('/api/oauthapp/${appId}/regenerate-secret', { method: 'POST' });
                                                                                            const json = await res.json();
                                                                                            if (json.success) {
                                                                                                document.getElementById('app_secret').value = json.data.app_secret;
                                                                                                alert(${scriptJson(t('新密钥已生成: {secret}\n请保存好新密钥，关闭后无法再次查看。'))}.replace('{secret}', json.data.app_secret));
                                                                                                location.reload();
                                                                                            } else { alert(${scriptJson(t('操作失败: {message}'))}.replace('{message}', json.message)); }
                                                                                        } catch(e) { alert(${scriptJson(t('请求出错: {message}'))}.replace('{message}', e.message)); }
                                                                                    }
                                                                                </script>
                                                                            </form>

                                                                            <div style="text-align: center; margin-top: 20px;">
                                                                                <a href="/" style="color: white; text-decoration: none;">${t('取消并返回')}</a>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                            </body>
                                                        </html>
                                                        `;
}

function generateOAuthAppDetailHtml(currentUser, app, stats) {
    const sf = (name, color = '0071e3') => `https://img.bloret.net/SF/${name}?color=%23${color}`;
    const permissions = Array.isArray(app.permissions) ? app.permissions : [];
    const redirectUris = getOAuthRedirectUris(app);
    const secretPreview = app.app_secret ? app.app_secret.substring(0, 8) + '••••••••' : '';

    // 权限中文名映射
    const permLabels = {
        'user:name': t('用户名称'),
        'user:head': t('用户头像'),        'user:email': t('用户邮箱'),
        'user:admin': t('管理员权限'),
        'user:tags': t('用户标签'),
        'app:usertoken': t('长期令牌'),
        'bbbs:session': t('BBBS 登录')
    };

    // 构建每日统计图表数据
    const dailyStats = stats.dailyStats || [];
    const maxCount = Math.max(...dailyStats.map(d => d.count), 1);
    const barChartHtml = dailyStats.length > 0 ? `
        <div class="bar-chart">
            ${dailyStats.map(d => `
                <div class="bar" style="height: ${Math.max((d.count / maxCount) * 100, 4)}%;">
                    <div class="bar-tooltip">${d.date}: ${t('{count} 次', { count: d.count })}</div>
                </div>
            `).join('')}
        </div>
        <div class="bar-labels">
            ${dailyStats.map(d => `<span>${d.date.substring(5)}</span>`).join('')}
        </div>
    ` : `<p style="color: var(--text-secondary); font-size: 14px; text-align: center; padding: 20px;">${t('暂无授权数据')}</p>`;

    // 最近授权记录
    const recentHtml = (stats.recentAuthorizations || []).length > 0 ? `
        <table class="blora-table">
            <thead>
                <tr>
                    <th>${t('用户')}</th>
                    <th>${t('IP 地址')}</th>
                    <th>${t('自动授权')}</th>
                    <th>${t('时间')}</th>
                </tr>
            </thead>
            <tbody>
                ${stats.recentAuthorizations.map(r => `
                    <tr>
                        <td>${escapeHtml(String(r.username || '-'))}</td>
                        <td style="font-family: monospace; font-size: 13px;">${escapeHtml(String(r.ip_address || '-'))}</td>
                        <td>${r.auto_auth ? `<span style="color: #4caf50;">${t('是')}</span>` : `<span style="color: var(--text-secondary);">${t('否')}</span>`}</td>
                        <td style="font-size: 13px; color: var(--text-secondary);">${r.created_at ? new Date(r.created_at).toLocaleString('zh-CN') : '-'}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    ` : `<p style="color: var(--text-secondary); font-size: 14px; text-align: center; padding: 20px;">${t('暂无授权记录')}</p>`;

    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(String(app.name))} - OAuth App - Bloret PassPort</title>
    <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
    <style>
        .app-header-card {
            display: flex;
            align-items: center;
            gap: 20px;
            margin-bottom: 24px;
        }
        .app-header-icon {
            width: 72px;
            height: 72px;
            border-radius: 16px;
            background: var(--muted);
            overflow: hidden;
            flex-shrink: 0;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        }
        .app-header-icon img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        .app-header-info h2 {
            margin: 0 0 4px 0;
            font-size: 22px;
            font-weight: 600;
            color: var(--text-primary);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .app-header-info p {
            margin: 0;
            font-size: 14px;
            color: var(--text-secondary);
        }
        .official-badge {
            display: inline-flex;
            align-items: center;
            padding: 2px 8px;
            background: rgba(0, 113, 227, 0.1);
            color: var(--blora-color-action-primary-default);
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .form-group {
            margin-bottom: 20px;
        }
        .form-label {
            display: block;
            font-size: 14px;
            font-weight: 500;
            color: var(--text-primary);
            margin-bottom: 6px;
        }
        .form-input, .form-textarea {
            width: 100%;
            box-sizing: border-box;
        }
        .permission-checkboxes {
            display: flex;
            flex-direction: column;
            gap: 10px;
            background: var(--muted);
            padding: 15px;
            border-radius: 12px;
            border: 1px solid var(--border-color);
        }
        .permission-checkbox-item {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            color: var(--text-primary);
        }
    </style>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope">
    ${generateSidebarHtml(currentUser, 'open-platform')}

    <div class="main-content-apple">
        <div class="app-header-card">
            <div class="app-header-icon">
                ${app.icon ? `<img src="${escapeHtml(String(app.icon))}" alt="">` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:600;color:var(--text-secondary);">${escapeHtml(String(app.name || '?').charAt(0)).toUpperCase()}</div>`}
            </div>
            <div class="app-header-info">
                <h2>${escapeHtml(String(app.name))} ${app.official ? '<span class="official-badge">Official</span>' : ''}</h2>
                <p>${escapeHtml(String(app.description || t('暂无描述')))}</p>
            </div>
        </div>

        <blora-tabs id="oauth-app-tabs" value="overview">
            <blora-tab value="overview" label="${t('基本信息')}" selected>
        <div id="tab-overview">
            <div class="user-info-card blora-card">
                <div class="post-title">${t('应用详情')}</div>
                <div class="post-content">
                    <div class="info-row">
                        <div class="info-label">${t('应用 ID')}</div>
                        <div class="info-value" style="font-family: monospace;">${escapeHtml(String(app.id))}</div>
                    </div>
                    <div class="info-row">
                        <div class="info-label">${t('应用名称')}</div>
                        <div class="info-value">${escapeHtml(String(app.name))}</div>
                    </div>
                    <div class="info-row">
                        <div class="info-label">${t('描述')}</div>
                        <div class="info-value">${escapeHtml(String(app.description || t('暂无')))}</div>
                    </div>
                    <div class="info-row">
                        <div class="info-label">${t('创建者')}</div>
                        <div class="info-value">${escapeHtml(String(app.owner || t('未知')))}</div>
                    </div>
                    <div class="info-row">
                        <div class="info-label">${t('官方应用')}</div>
                        <div class="info-value">${app.official ? `<span style="color: #4caf50;">${t('是')}</span>` : t('否')}</div>
                    </div>
                    <div class="info-row">
                        <div class="info-label">${t('创建时间')}</div>
                        <div class="info-value">${app.created_at ? new Date(app.created_at).toLocaleString('zh-CN') : t('未知')}</div>
                    </div>
                    <div class="info-row">
                        <div class="info-label">${t('应用密钥')}</div>
                        <div class="info-value">
                            <div class="secret-mask">
                                <span class="secret-text" id="secret-display">${secretPreview}</span>
                                <button type="button" class="secret-toggle" onclick="toggleSecret()" id="secret-btn">${t('显示')}</button>
                                <button type="button" class="copy-btn" onclick="copySecret()">${t('复制')}</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="user-info-card blora-card" style="margin-top: 16px;">
                <div class="post-title">${t('权限列表')}</div>
                <div class="post-content">
                    <div class="permission-tags">
                        ${permissions.length > 0 ? permissions.map(p => `
                            <span class="permission-tag">${permLabels[p] || p} <span style="opacity:0.6;font-size:11px;">${p}</span></span>
                        `).join('') : `<span style="color: var(--text-secondary); font-size: 14px;">${t('暂无权限')}</span>`}
                    </div>
                </div>
            </div>

            <div class="user-info-card blora-card" style="margin-top: 16px;">
                <div class="post-title">${t('重定向 URI')}</div>
                <div class="post-content">
                    ${redirectUris.length > 0 ? redirectUris.map(uri => `
                        <div style="padding: 8px 0; border-bottom: 1px solid var(--border-color); font-family: monospace; font-size: 13px; color: var(--text-primary); word-break: break-all;">
                            ${uri}
                        </div>
                    `).join('') : `<span style="color: var(--text-secondary); font-size: 14px;">${t('暂无重定向 URI')}</span>`}
                </div>
            </div>
        </div>
            </blora-tab>

            <blora-tab value="stats" label="${t('统计数据')}">
        <div id="tab-stats">
            <div class="stat-cards">
                <div class="stat-card">
                    <div class="stat-value">${stats.totalUsers || 0}</div>
                    <div class="stat-label">${t('授权用户数')}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${(stats.recentAuthorizations || []).length}</div>
                    <div class="stat-label">${t('近期授权次数')}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${permissions.length}</div>
                    <div class="stat-label">${t('请求权限数')}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${redirectUris.length}</div>
                    <div class="stat-label">${t('重定向 URI 数')}</div>
                </div>
            </div>

            <div class="user-info-card blora-card">
                <div class="post-title">${t('近 7 天授权趋势')}</div>
                <div class="post-content">
                    ${barChartHtml}
                </div>
            </div>

            <div class="user-info-card blora-card" style="margin-top: 16px;">
                <div class="post-title">${t('最近授权记录')}</div>
                <div class="post-content" style="overflow-x: auto;">
                    ${recentHtml}
                </div>
            </div>
        </div>
            </blora-tab>

            <blora-tab value="settings" label="${t('编辑设置')}">
        <div id="tab-settings">
            <div class="user-info-card blora-card">
                <div class="post-title">${t('编辑应用信息')}</div>
                <div class="post-content">
                    <form id="edit-form" action="/edit/oauthapp/${escapeHtml(String(app.id))}" method="POST">
                        <div class="form-group">
                            <label class="form-label" for="name">${t('应用名称 *')}</label>
                            <input class="blora-input form-input" id="name" name="name" type="text" value="${escapeHtml(String(app.name))}" required>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="description">${t('应用描述 *')}</label>
                            <input class="blora-input form-input" id="description" name="description" type="text" value="${escapeHtml(String(app.description || ''))}" required>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="icon">${t('图标 URL *')}</label>
                            <input class="blora-input form-input" id="icon" name="icon" type="text" value="${escapeHtml(String(app.icon || ''))}" required>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="app_secret">${t('应用密钥 *')}</label>
                            <input class="blora-input form-input" id="app_secret" name="app_secret" type="text" value="${escapeHtml(String(app.app_secret))}" required>
                        </div>

                        <div class="form-group">
                            <label class="form-label">${t('权限 *')}</label>
                            <div class="permission-checkboxes">
                                ${Object.entries(permLabels).map(([val, label]) => `
                                    <div class="permission-checkbox-item">
                                        <blora-checkbox name="permissions" value="${val}" ${permissions.includes(val) ? 'checked' : ''}>${label} (${val})</blora-checkbox>
                                    </div>
                                `).join('')}
                            </div>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="redirect_uri">${t('重定向 URI (每行一个)')}</label>
                            <textarea class="blora-textarea form-textarea" id="redirect_uri" name="redirect_uri">${redirectUris.join('\n')}</textarea>
                        </div>

                        <button class="blora-button" data-variant="primary" type="submit" style="width: 100%;">${t('保存修改')}</button>
                    </form>
                </div>
            </div>

            <div class="danger-zone">
                <div class="danger-title">${t('危险区域')}</div>
                <div class="danger-desc">${t('删除应用是不可逆操作，所有授权记录和应用数据将被永久清除。')}</div>
                <button type="button" class="blora-button" data-variant="danger" onclick="confirmDelete()">${t('删除此应用')}</button>
            </div>
        </div>
            </blora-tab>
        </blora-tabs>
    </div>

    <script>
        ${sidebarScript}

        const appSecret = ${scriptJson(app.app_secret)};
        let secretVisible = false;

        function toggleSecret() {
            const display = document.getElementById('secret-display');
            const btn = document.getElementById('secret-btn');
            secretVisible = !secretVisible;
            if (secretVisible) {
                display.textContent = appSecret;
                btn.textContent = ${scriptJson(t('隐藏'))};
            } else {
                display.textContent = appSecret.substring(0, 8) + '••••••••';
                btn.textContent = ${scriptJson(t('显示'))};
            }
        }

        function copySecret() {
            navigator.clipboard.writeText(appSecret).then(() => {
                const btn = event.target;
                const orig = btn.textContent;
                btn.textContent = ${scriptJson(t('已复制'))};
                setTimeout(() => btn.textContent = orig, 1500);
            });
        }

        function confirmDelete() {
            if (!confirm(${scriptJson(t('确定要删除应用 "{name}" 吗？此操作不可逆！', { name: app.name }))})) return;
            if (!confirm(${scriptJson(t('再次确认：删除后所有数据将永久丢失，是否继续？'))})) return;

            fetch('/api/oauthapp/' + encodeURIComponent(${scriptJson(app.id)}) + '/delete', { method: 'POST' })
                .then(r => r.json())
                .then(data => {
                    if (data.success) {
                        alert(${scriptJson(t('应用已删除'))});
                        window.location.href = '/open-platform';
                    } else {
                        alert(${scriptJson(t('删除失败: '))} + (data.message || ${scriptJson(t('未知错误'))}));
                    }
                })
                .catch(() => alert(${scriptJson(t('请求失败'))}));
        }
    </script>
</body>
</html>
    `;
}

function generateMyTokensHtml(user, tokens) {
    const sf = (name, color = '0071e3') => `https://img.bloret.net/SF/${name}?color=%23${color}`;

    // 按应用分组
    const grouped = Object.create(null);
    tokens.forEach(t => {
        if (!grouped[t.app_id]) grouped[t.app_id] = [];
        grouped[t.app_id].push(t);
    });

    const appIds = Object.keys(grouped);

    const tokenListHtml = appIds.length > 0 ? appIds.map(appId => {
        const appTokens = grouped[appId];
        const appName = escapeHtml(String(appTokens[0].app_name || appId));
        const appIcon = escapeHtml(safeImageUrl(appTokens[0].app_icon));
        return `
            <div class="user-info-card blora-card" style="margin-bottom: 16px;">
                <div class="post-title" style="display: flex; align-items: center; gap: 10px;">
                    ${appIcon ? `<img src="${appIcon}" style="width:28px;height:28px;border-radius:6px;object-fit:cover;">` : `<div style="width:28px;height:28px;border-radius:6px;background:var(--muted);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:var(--text-secondary);">${appName.charAt(0).toUpperCase()}</div>`}
                    <span>${appName}</span>
                    <span style="font-size:12px;color:var(--text-secondary);font-weight:400;">(${t('{count} 个令牌', { count: appTokens.length })})</span>
                </div>
                <div class="post-content" style="padding:0;">
                    <table class="blora-table">
                        <thead>
                            <tr>
                                <th>${t('令牌')}</th>
                                <th>${t('创建时间')}</th>
                                <th>${t('IP 地址')}</th>
                                <th>${t('最近使用')}</th>
                                <th>${t('操作')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${appTokens.map(token => `
                                <tr>
                                    <td style="font-family: monospace; font-size: 13px;">${escapeHtml(String(token.token || '').substring(0, 8))}••••</td>
                                    <td style="font-size: 13px; color: var(--text-secondary);">${token.created_at ? new Date(token.created_at).toLocaleString('zh-CN') : '-'}</td>
                                    <td style="font-family: monospace; font-size: 13px;">${escapeHtml(String(token.ip_address || '-'))}</td>
                                    <td style="font-size: 13px; color: var(--text-secondary);">${token.last_used_at ? new Date(token.last_used_at).toLocaleString('zh-CN') : t('从未')}</td>
                                    <td><button type="button" class="blora-button" data-variant="danger" data-size="sm" onclick="revokeToken(${escapeHtml(scriptJson(String(token.id)))}, ${escapeHtml(scriptJson(String(appTokens[0].app_name || appId)))})">${t('撤销')}</button></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }).join('') : `
        <div class="user-info-card blora-card">
            <div class="post-content" style="text-align: center; padding: 40px 20px;">
                <img src="${sf('ticket', '86868b')}" width="48" style="opacity: 0.4; margin-bottom: 12px;">
                <p style="color: var(--text-secondary); font-size: 15px; margin: 0;">${t('暂无授权令牌')}</p>
                <p style="color: var(--text-secondary); font-size: 13px; margin: 8px 0 0 0;">${t('当您授权应用并授予"长期令牌"权限时，令牌将显示在这里')}</p>
            </div>
        </div>
    `;

    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('我的令牌 - Bloret PassPort')}</title>
    <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope">
    ${generateSidebarHtml(user, 'my-tokens')}

    <div class="main-content-apple">
        <h1 class="page-title">${t('我的授权令牌')}</h1>
        <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 24px;">
            ${t('管理您授权给各应用的长期令牌。撤销后该令牌将立即失效。')}
        </p>

        ${tokenListHtml}
    </div>

    <blora-dialog id="revokeTokenDialog" aria-label="${t('确认撤销令牌')}">
        <div class="revoke-dialog-body">
            <h2>${t('确认撤销令牌')}</h2>
            <p id="revokeTokenMessage"></p>
            <div class="revoke-dialog-actions">
                <button type="button" class="blora-button" data-variant="outline" onclick="document.getElementById('revokeTokenDialog').close()">${t('取消')}</button>
                <button type="button" class="blora-button" data-variant="danger" id="confirmRevokeTokenButton">${t('确认撤销')}</button>
            </div>
        </div>
    </blora-dialog>

    <script>
        ${sidebarScript}
        let pendingRevokeToken = null;

        function revokeToken(id, appName) {
            pendingRevokeToken = { id, appName };
            document.getElementById('revokeTokenMessage').textContent = ${scriptJson(t('确定要撤销此令牌吗？撤销后立即失效，相关应用将无法继续使用该令牌访问您的数据。'))};
            document.getElementById('revokeTokenDialog').show();
        }

        document.getElementById('confirmRevokeTokenButton').addEventListener('click', async () => {
            const request = pendingRevokeToken;
            if (!request) return;
            document.getElementById('revokeTokenDialog').close();
            pendingRevokeToken = null;

            try {
                const res = await fetch('/api/my/tokens/' + encodeURIComponent(request.id) + '/revoke', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    location.reload();
                } else {
                    alert(${scriptJson(t('撤销失败: '))} + (data.message || ${scriptJson(t('未知错误'))}));
                }
            } catch (e) {
                alert(${scriptJson(t('请求失败'))});
            }
        });
    </script>
</body>
</html>
    `;
}

// --- 用户令牌管理 API ---

// 获取当前用户所有令牌
app.get('/api/my/tokens', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const currentUser = await db.getUser(req.authUsername);
    if (!currentUser) return res.status(401).json({ success: false, message: t('未登录') });

    const tokens = await db.getUserAppTokens(currentUser.username);
    res.json({ success: true, data: tokens });
});

// 撤销指定令牌
app.post('/api/my/tokens/:id/revoke', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const currentUser = await db.getUser(req.authUsername);
    if (!currentUser) return res.status(401).json({ success: false, message: t('未登录') });

    const tokenId = req.params.id;
    if (/^oauth:[a-f0-9]{64}$/.test(tokenId)) {
        await db.revokeOAuthAccessToken(tokenId.slice(6), currentUser.username);
    } else if (/^[1-9][0-9]*$/.test(tokenId) && Number.isSafeInteger(Number(tokenId))) {
        await db.deleteUserAppToken(Number(tokenId), currentUser.username);
    } else return res.status(400).json({ success: false, message: t('无效的令牌 ID') });

    const clientIp = getClientIp(req);
    await db.logUserAction(currentUser.username, 'revoke_token', `撤销了授权令牌 #${tokenId}`, clientIp);

    res.json({ success: true });
});

// 我的令牌页面
app.get('/my/tokens', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    const currentUser = await db.getUser(username);

    if (!currentUser) {
        return res.redirect('/');
    }

    const tokens = await db.getUserAppTokens(currentUser.username);

    // 补充应用名称和图标
    const allApps = await db.getAllOAuthApps();
    const appMap = {};
    allApps.forEach(a => { appMap[a.id] = a; });
    tokens.forEach(t => {
        const app = appMap[t.app_id];
        if (app) {
            t.app_name = app.name;
            t.app_icon = app.icon;
        }
    });

    res.send(generateMyTokensHtml(currentUser, tokens));
});

// --- AI API 页面 ---
app.get('/ai', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const username = req.authUsername;
    const currentUser = await db.getUser(username);
    if (!currentUser) return res.redirect('/');

    const userKeys = await db.getUserAIKeys(currentUser.username);
    const todayCount = await db.getTodayRequestCount(currentUser.username);
    const dailyLimit = (config.ai && config.ai.dailyRequestLimit) ?? 200;

    res.send(generateAIPageHtml(currentUser, userKeys, todayCount, dailyLimit));
});

// --- OAuth App 详情页 API ---

// 获取 OAuth App 统计数据
app.get('/api/oauthapp/:app_id/stats', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const currentUser = await db.getUser(req.authUsername);
    if (!currentUser) return res.status(401).json({ success: false, message: t('未登录') });

    const oauthApp = await db.getOAuthApp(req.params.app_id);
    if (!oauthApp) return res.status(404).json({ success: false, message: t('应用不存在') });
    if (oauthApp.owner !== currentUser.username && !currentUser.admin) {
        return res.status(403).json({ success: false, message: t('无权操作') });
    }

    const stats = await db.getOAuthAppStats(req.params.app_id);
    res.json({ success: true, data: stats });
});

// 删除 OAuth App
app.post('/api/oauthapp/:app_id/delete', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const currentUser = await db.getUser(req.authUsername);
    if (!currentUser) return res.status(401).json({ success: false, message: t('未登录') });

    const oauthApp = await db.getOAuthApp(req.params.app_id);
    if (!oauthApp) return res.status(404).json({ success: false, message: t('应用不存在') });
    if (oauthApp.owner !== currentUser.username && !currentUser.admin) {
        return res.status(403).json({ success: false, message: t('无权操作') });
    }

    try {
        await db.deleteOAuthApp(req.params.app_id);
        const clientIp = getClientIp(req);
        await db.logUserAction(currentUser.username, 'delete_oauth_app', `已删除 OAuth 应用: ${req.params.app_id}`, clientIp);
        res.json({ success: true });
    } catch (error) {
        console.error(t('删除 OAuth 应用失败:'), error);
        res.status(500).json({ success: false, message: t('删除失败') });
    }
});

// --- 管理面板 API 扩展 ---

// 1. 获取用户完整信息
app.get('/api/admin/user/:username', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const currentUser = await db.getUser(req.authUsername);
    if (!currentUser || !currentUser.admin) return res.status(403).json({ success: false, message: t('无权操作') });

    const targetUser = await db.getUser(req.params.username);
    if (!targetUser) return res.status(404).json({ success: false, message: t('用户不存在') });

    const safeUser = { ...targetUser };
    delete safeUser.password;
    delete safeUser.totpSecret;
    delete safeUser.tempTotpSecret;
    delete safeUser.key;
    delete safeUser.apptoken;
    delete safeUser.MinecraftAccounts;
    delete safeUser.passkeys;
    const stats = await db.getUserStats(req.params.username);
    const todayAIUsage = await db.getTodayRequestCount(req.params.username);
    const dailyAILimit = (config.ai && config.ai.dailyRequestLimit) ?? 200;
    res.json({
        success: true,
        data: {
            ...safeUser,
            stats,
            todayAIUsage,
            dailyAILimit
        }
    });
});

// 1.5. 获取指定用户的操作日志（管理员）
app.get('/api/admin/user/:username/logs', async (req, res) => {
    const currentUser = await db.getUser(req.authUsername);
    if (!currentUser || !currentUser.admin) return res.status(403).json({ success: false, message: t('无权操作') });

    const targetUser = await db.getUser(req.params.username);
    if (!targetUser) return res.status(404).json({ success: false, message: t('用户不存在') });

    const { type, keyword, page = 1 } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);

    const result = await db.getUserLogsFiltered(req.params.username, { type, keyword, page: pageNum });
    res.json(result);
});

// 2. 更新用户所有信息
app.post('/api/admin/user/update', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const currentUser = await db.getUser(req.authUsername);
    if (!currentUser || !currentUser.admin) return res.status(403).json({ success: false, message: t('无权操作') });

    const { username, nickname, email, admin, tags, password, avatar, github, lark } = req.body;
    const targetUser = await db.getUser(username);
    if (!targetUser) return res.status(404).json({ success: false, message: t('用户不存在') });
    if (password !== undefined && (typeof password !== 'string' || (password.trim() !== '' && (password.length < 6 || Buffer.byteLength(password, 'utf8') > 72)))) {
        return res.status(400).json({ success: false, message: t('密码长度至少为 6 位') });
    }

    const updateData = {};
    if (nickname !== undefined) {
        updateData.nickname = String(nickname).trim() || null;
    }
    if (email !== undefined) {
        const normalizedEmail = String(email || '').trim();
        // 管理员改邮箱时做唯一性校验：不能改成其他用户/验证中用户已占用的邮箱
        if (normalizedEmail && normalizedEmail.toLowerCase() !== String(targetUser.email || '').toLowerCase()) {
            const emailTaken = await db.isEmailInUseByOther(normalizedEmail, username);
            if (emailTaken) {
                return res.status(409).json({ success: false, message: t('该邮箱已被其他用户使用') });
            }
        }
        updateData.email = normalizedEmail || null;
    }
    if (admin !== undefined) updateData.admin = admin === true || admin === 'true';
    if (tags !== undefined) updateData.tags = Array.isArray(tags) ? tags : (tags ? tags.split(',').map(tag => tag.trim()).filter(Boolean) : []);
    
    // 如果提供了新密码，则更新（服务端 bcrypt）
    if (password && password.trim() !== '') {
        updateData.password = await hashPassword(password);
    }
    if (avatar !== undefined) updateData.avatar = avatar;
    if (github !== undefined) updateData.github = github;
    if (lark !== undefined) updateData.lark = lark;

    const passwordHash = updateData.password;
    delete updateData.password;
    try {
        await db.updateUser(username, updateData);
        if (passwordHash) {
            const updated = await db.updatePasswordAndRevokeCredentials(username, passwordHash, { expectedPasswordHash: targetUser.password });
            if (!updated) return res.status(409).json({ success: false, message: t('账户已改变，请刷新后重试') });
        }
    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(409).json({ success: false, message: t('该邮箱已被其他用户使用') });
        }
        console.error('[admin user update]', error);
        return res.status(500).json({ success: false, message: t('保存失败') });
    }

    await logUserAction(currentUser.username, 'admin_user_update', `更新用户 ${username}${passwordHash ? ' 并撤销其全部凭据' : ''}`, getClientIp(req));

    res.json({ success: true });
});

// 重置指定用户今日 AI 请求额度
app.post('/api/admin/user/:username/reset-ai-quota', async (req, res) => {
    const currentUser = await db.getUser(req.authUsername);
    if (!currentUser || !currentUser.admin) {
        return res.status(403).json({ success: false, message: t('无权操作') });
    }

    const targetUsername = req.params.username;
    const targetUser = await db.getUser(targetUsername);
    if (!targetUser) {
        return res.status(404).json({ success: false, message: t('用户不存在') });
    }

    try {
        const clientIp = getClientIp(req);
        const resetCount = await db.resetTodayAIUsage(targetUsername, {
            username: currentUser.username,
            type: 'reset_ai_quota',
            ip: clientIp,
            message: count => t('重置了用户 {username} 的今日 AI 额度（清除 {count} 条用量记录）', { username: targetUsername, count })
        });
        res.json({
            success: true,
            message: t('今日 AI 额度已重置'),
            data: { resetCount, todayCount: 0 }
        });
    } catch (error) {
        console.error(`重置用户 ${targetUsername} 的今日 AI 额度失败:`, error);
        res.status(500).json({ success: false, message: t('重置失败，请稍后重试') });
    }
});

// 3. 获取 OAuth 应用信息
app.get('/api/admin/oauthapp/:id', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const currentUser = await db.getUser(req.authUsername);
    if (!currentUser || !currentUser.admin) return res.status(403).json({ success: false, message: t('无权操作') });

    const app = await db.getOAuthApp(req.params.id);
    if (!app) return res.status(404).json({ success: false, message: t('应用不存在') });
    const ownerUser = app.owner ? await db.getUserByLower(app.owner) : null;
    res.json({
        success: true,
        data: {
            ...app,
            ownerDisplayName: displayName(ownerUser) || app.owner || ''
        }
    });
});

// 4. 更新 OAuth 应用信息
app.post('/api/admin/oauthapp/update', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const currentUser = await db.getUser(req.authUsername);
    if (!currentUser || !currentUser.admin) return res.status(403).json({ success: false, message: t('无权操作') });

    const { id, name, description, icon, app_secret, redirect_uri, owner, official, permissions, bound_model } = req.body;
    const app = await db.getOAuthApp(id);
    if (!app) return res.status(404).json({ success: false, message: t('应用不存在') });

    const updateData = {
        name,
        description,
        icon,
        app_secret,
        redirect_uri: Array.isArray(redirect_uri) ? redirect_uri : (redirect_uri ? redirect_uri.split('\n').map(u => u.trim()) : []),
        owner,
        official: official === true || official === 'true',
        permissions: sanitizeOAuthPermissions(
            Array.isArray(permissions) ? permissions : (permissions ? permissions.split(',').map(p => p.trim()) : []),
            true // 管理员可以设置 user:admin
        ),
        bound_model: bound_model || null
    };

    await db.updateOAuthApp(id, updateData);
    res.json({ success: true });
});

// 5. 获取 OAuth 应用授权用户
app.get('/api/admin/oauthapp/:id/users', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const currentUser = await db.getUser(req.authUsername);
    if (!currentUser || !currentUser.admin) return res.status(403).json({ success: false, message: t('无权操作') });

    const appId = req.params.id;
    const authorizedUsers = [];
    const allUsers = await db.getAllUsers();
    
    allUsers.forEach(u => {
        if (u.apptoken && u.apptoken[appId]) {
            authorizedUsers.push({ username: u.username, avatar: u.avatar });
        }
    });
    res.json({ success: true, data: authorizedUsers });
});

// 6. 撤销 OAuth 应用授权
app.post('/api/admin/oauthapp/:id/revoke', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const currentUser = await db.getUser(req.authUsername);
    if (!currentUser || !currentUser.admin) return res.status(403).json({ success: false, message: t('无权操作') });

    const { username } = req.body;
    const appId = req.params.id;
    const targetUser = await db.getUser(username);
    
    // 清除旧字段中的令牌
    if (targetUser && targetUser.apptoken && targetUser.apptoken[appId]) {
        const newAppTokens = { ...targetUser.apptoken };
        delete newAppTokens[appId];
        await db.updateUser(username, { apptoken: newAppTokens });
    }
    // 同时清除多令牌表中该用户对该应用的所有令牌
    if (username && appId) {
        await db.deleteUserAppTokensForUserApp(username, appId);
    }
    res.json({ success: true });
});

// Express 全局错误处理：不向客户端返回 stack
app.use((err, req, res, next) => {
    console.error('[express error]', err && err.stack ? err.stack : err);
    if (res.headersSent) return next(err);
    const wantsJson =
        req.xhr ||
        (req.headers.accept && req.headers.accept.includes('application/json')) ||
        (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) ||
        (req.path && (req.path.startsWith('/api/') || req.path.startsWith('/app/') || req.path.startsWith('/v1/')));

    // body-parser: 请求体过大（常见于 AI 接口 base64 图片）
    if (err && (err.type === 'entity.too.large' || err.name === 'PayloadTooLargeError' || err.status === 413 || err.statusCode === 413)) {
        if (wantsJson || (req.path && req.path.startsWith('/v1/'))) {
            return res.status(413).json({
                error: {
                    message: 'Request body too large. For images, prefer HTTPS image URLs, or keep base64 payloads under the server limit (20mb).',
                    type: 'payload_too_large'
                }
            });
        }
        return res.status(413).type('html').send(`<!DOCTYPE html><html><body class="blora-page blora-scope"><h1>${t('请求体过大')}</h1><p>${t('请缩小上传内容后重试')}</p></body></html>`);
    }

    if (err && err.code === 'AUTH_STATE_CHANGED') {
        return res.status(401).send(t('账户认证状态已改变，请重新登录'));
    }

    if (wantsJson) {
        return res.status(500).json({ success: false, message: t('服务器内部错误') });
    }
    res.status(500).type('html').send(`<!DOCTYPE html><html><body class="blora-page blora-scope"><h1>${t('服务器错误')}</h1><p>${t('请稍后重试')}</p></body></html>`);
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, closing...`);
    const forceTimer = setTimeout(() => {
        console.error('[shutdown] force exit after timeout');
        process.exit(1);
    }, 10000);
    forceTimer.unref?.();
    try {
        await new Promise((resolve) => server.close(() => resolve()));
    } catch (e) {
        console.error('[shutdown] server.close error:', e);
    }
    try {
        await db.closePool();
    } catch (e) {
        console.error('[shutdown] pool end error:', e);
    }
    clearTimeout(forceTimer);
    process.exit(0);
}

let server;

async function startServer() {
    db.assertCredentialEncryption();
    await db.initDB();
    await db.migrateCredentialEncryption();
    await db.migrateLegacyAppTokens();
    await db.cleanExpiredSessions();
    await db.cleanExpiredPasswordResetTokens();
    server = app.listen(port, config.listenHost || '127.0.0.1', () => {
    console.log(`Server running at http://localhost:${port}/`);
    
    // 定期清理过期的自动授权记录 (每小时执行一次)
    setInterval(async () => {
        try {
            await db.cleanExpiredAutoAuth();
        } catch (e) {
            console.error(t('清理过期自动授权记录失败:'), e);
        }
    }, 60 * 60 * 1000); // 60分钟

    // 定期清理过期会话
    setInterval(async () => {
        try {
            await db.cleanExpiredSessions();
        } catch (e) {
            console.error(t('清理过期会话失败:'), e);
        }
    }, 60 * 60 * 1000);

    // 定期自动刷新 Microsoft Token (每6小时检查一次)
    minecraft.autoRefreshAllMicrosoftTokens();
    setInterval(async () => {
        try {
            await minecraft.autoRefreshAllMicrosoftTokens();
        } catch (e) {
            console.error(t('[Token AutoRefresh] 自动刷新任务失败:'), e);
        }
    }, minecraft.MC_TOKEN_AUTO_REFRESH_INTERVAL_MS);
});

    server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`端口 ${port} 已被占用，请检查是否已有程序在运行。你可以尝试使用 lsof -i :${port} 找到进程并 kill 它。`);
    } else {
        console.error(t('服务器启动失败:'), err);
    }
    process.exit(1);
    });
}

if (require.main === module) {
    startServer().catch(async error => {
        console.error('Passport startup failed:', error.code || 'initialization_failed');
        await db.closePool();
        process.exitCode = 1;
    });
}

let unhandledRejectionCount = 0;
process.on('unhandledRejection', (reason) => {
    unhandledRejectionCount += 1;
    console.error(t('未处理的 Promise 拒绝:'), reason);
    if (unhandledRejectionCount >= 20) {
        console.error('[fatal] too many unhandled rejections, exiting');
        process.exit(1);
    }
});

process.on('uncaughtException', (err) => {
    console.error(t('未捕获的异常:'), err);
    // 半死进程不宜继续接流量；由进程管理器重启
    setTimeout(() => process.exit(1), 500).unref?.();
});

if (require.main === module) {
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

function generateAIPageHtml(user, userKeys, todayCount, dailyLimit) {
    const serverUrl = 'https://passport.bloret.net';
    const dailyPercent = dailyLimit > 0 ? Math.min(100, Math.round((todayCount / dailyLimit) * 100)) : 0;
    return `
<!DOCTYPE html>
<html lang="${htmlLang()}">
<head>
    <link rel="icon" href="/BL.png" type="image/png">
    <link rel="apple-touch-icon" href="/BL.png">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI 服务 - Bloret PassPort</title>
    <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
    <script src="/blora-message-layer.js"></script>
    <style>
        .passport-code-mockup { margin: var(--blora-space-4) 0 0; }
        .main-content-apple > .blora-card { margin-block-end: var(--blora-space-6); }
        .passport-ai-key-copy { flex: 0 1 min(100%, 28rem); min-width: 0; max-width: min(100%, 28rem); }
        .passport-ai-key-copy .blora-code { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .passport-ai-create { display: flex; flex-wrap: wrap; gap: var(--blora-space-3); align-items: center; margin-bottom: var(--blora-space-4); }
        .passport-ai-create .blora-input { width: 16rem; max-width: 100%; }
        .passport-ai-keys { margin: 0; }
        .passport-ai-keys .blora-list__item { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; }
        .passport-ai-keys .blora-button[data-variant="danger"] { align-self: center; }
        .passport-ai-key-name { display: inline-flex; align-items: center; gap: var(--blora-space-2); min-width: 0; }
        .passport-ai-key-name__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .passport-ai-key-name__edit { display: inline-flex; align-items: center; justify-content: center; flex: none; padding: 0.15em; border: 0; border-radius: var(--blora-radius-sm); background: transparent; color: var(--blora-color-text-subtle); opacity: 0; cursor: pointer; transition: opacity var(--blora-duration-fast) var(--blora-easing-standard), color var(--blora-duration-fast) var(--blora-easing-standard), background var(--blora-duration-fast) var(--blora-easing-standard); }
        .blora-list__item:hover .passport-ai-key-name__edit, .passport-ai-key-name__edit:focus-visible { opacity: 1; }
        .passport-ai-key-name__edit:hover { color: var(--blora-color-action-primary-default); background: color-mix(in srgb, var(--blora-color-action-primary-default) 12%, transparent); }
        .passport-ai-key-name__edit svg { width: 14px; height: 14px; }
        .passport-ai-key-name__input { width: min(10rem, 100%); }
        @media (max-width: 640px) {
            .passport-ai-keys .blora-list__item { grid-template-columns: minmax(0, 1fr) auto; }
            .passport-ai-keys .blora-list__meta { grid-column: 1 / -1; }
            .passport-ai-keys .passport-ai-key-copy { grid-column: 1; }
            .passport-ai-keys .blora-button[data-variant="danger"] { grid-column: 2; grid-row: 2; }
        }
    </style>
${bloraAssetTags()}</head>
<body class="blora-page blora-scope">
    ${generateSidebarHtml(user, 'ai')}

    <div class="main-content-apple">
        <h1 class="page-title">AI 服务</h1>

        <section class="blora-card passport-ai-quota">
            <blora-statistic label="${t('今日免费请求')}" value="${Number(todayCount) || 0}" suffix=" / ${Number(dailyLimit) || 0}"></blora-statistic>
            <blora-progress value="${dailyPercent}" label="${t('今日用量')}" variant="${dailyPercent >= 90 ? 'danger' : dailyPercent >= 70 ? 'warning' : 'success'}"></blora-progress>
            <p class="blora-text-muted">${t('每日 0 点（UTC+8）重置，用完即止')}</p>
        </section>

        <section class="blora-card">
            <header class="blora-card__head">
                <div>
                    <h2 class="blora-card__title">${t('API Key 管理')}</h2>
                    <p class="blora-card__description">${t('密钥仅创建时显示，请立即复制保存。重新打开页面只能查看前缀。')}</p>
                </div>
            </header>
            <div class="passport-ai-create">
                <input class="blora-input" id="newKeyName" type="text" placeholder="${t('Key 名称（可选）')}">
                <button type="button" class="blora-button" data-variant="primary" onclick="createKey()">${t('创建新 Key')}</button>
            </div>
            <div class="blora-card passport-ai-keys-card" style="padding:0;overflow:hidden">
                <div id="keyList">
                    ${userKeys.length ? `<div class="blora-list passport-ai-keys">${userKeys.map((k) => {
                    const name = escapeHtml(k.name || t('未命名 Key'));
                    const created = escapeHtml(t('创建于 {time}', { time: new Date(k.created_at).toLocaleString('zh-CN') }));
                    const keyPreview = escapeHtml(k.api_key);
                    return `<div class="blora-list__item" id="key-${k.id}">
                        <div class="blora-list__meta">
                            <div class="blora-list__title passport-ai-key-name">
                                <span class="passport-ai-key-name__text">${name}</span>
                                <button type="button" class="passport-ai-key-name__edit" onclick="editKeyName(${k.id}, this)" aria-label="${t('编辑 Key 名称')}" title="${t('编辑 Key 名称')}"><span data-icon="pencil" aria-hidden="true"></span></button>
                            </div>
                            <div class="blora-list__desc">${created}</div>
                        </div>
                        <code class="passport-ai-key-copy">${keyPreview}</code>
                        <button type="button" class="blora-button" data-variant="danger" data-size="sm" onclick="deleteKey(${k.id})">${t('删除')}</button>
                    </div>`;
                }).join('')}</div>` : `<blora-empty title="${escapeHtml(t('暂无 API Key'))}" description="${escapeHtml(t('点击上方按钮创建一个 Key。'))}"></blora-empty>`}
                </div>
            </div>
        </section>

        <section class="blora-card">
            <header class="blora-card__head">
                <div>
                    <h2 class="blora-card__title">${t('使用说明')}</h2>
                </div>
            </header>
            <blora-steps current="0" clickable="false">
                <blora-step title="${t('创建 API Key')}" description="${t('在上方「API Key 管理」区域创建一个 Key，复制保存。')}"></blora-step>
                <blora-step title="${t('调用 API')}" description="${t('使用以下格式发送请求：')}"></blora-step>
                <blora-step title="${t('请求限额')}" description="${t('每位用户每天最多 {limit} 次请求，每日 0 点（UTC+8）重置。', { limit: dailyLimit })}"></blora-step>
            </blora-steps>
            <blora-mockup class="passport-code-mockup" variant="code" label="curl">
                <blora-mockup-line prefix="$">curl ${escapeHtml(serverUrl)}/v1/chat/completions \\</blora-mockup-line>
                <blora-mockup-line>  -H "Authorization: Bearer sk-your-api-key" \\</blora-mockup-line>
                <blora-mockup-line>  -H "Content-Type: application/json" \\</blora-mockup-line>
                <blora-mockup-line>  -d '{"messages":[{"role":"user","content":"Hello"}]}'</blora-mockup-line>
            </blora-mockup>
        </section>

    </div>

    <script>
        ${sidebarScript}

        async function showBloraMessage(text, type) {
            const { message } = await import('/blora/index.js');
            if (type === 'error') message.error(String(text || ''));
            else message.success(String(text || ''));
            const promote = globalThis.BloraMessageLayer && globalThis.BloraMessageLayer.promoteBloraMessageLayer;
            if (typeof promote === 'function') promote(document);
        }

        async function appendKeyItem(key) {
            const list = document.getElementById('keyList');
            if (!list) return;
            let container = list.querySelector('.blora-list');
            if (!container) {
                list.innerHTML = '';
                container = document.createElement('div');
                container.className = 'blora-list passport-ai-keys';
                list.appendChild(container);
            }
            const item = document.createElement('div');
            item.className = 'blora-list__item';
            item.id = 'key-' + key.id;

            const meta = document.createElement('div');
            meta.className = 'blora-list__meta';
            const title = document.createElement('div');
            title.className = 'blora-list__title passport-ai-key-name';
            const titleText = document.createElement('span');
            titleText.className = 'passport-ai-key-name__text';
            titleText.textContent = key.name || ${scriptJson(t('未命名 Key'))};
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'passport-ai-key-name__edit';
            edit.setAttribute('aria-label', ${scriptJson(t('编辑 Key 名称'))});
            edit.title = ${scriptJson(t('编辑 Key 名称'))};
            edit.innerHTML = '<span data-icon="pencil" aria-hidden="true"></span>';
            const icon = edit.querySelector('[data-icon]');
            if (icon) {
                const { createBloraIcon } = await import('/blora/index.js');
                const svg = createBloraIcon('pencil', 14);
                if (svg) { icon.replaceChildren(svg); }
            }
            edit.addEventListener('click', () => editKeyName(key.id, edit));
            title.append(titleText, edit);
            const desc = document.createElement('div');
            desc.className = 'blora-list__desc';
            desc.textContent = ${scriptJson(t('创建于 {time}'))}.replace('{time}', new Date(key.created_at).toLocaleString('zh-CN'));
            meta.append(title, desc);

            const copy = document.createElement('blora-copy');
            copy.className = 'passport-ai-key-copy';
            copy.setAttribute('text', key.api_key);
            copy.setAttribute('masked', '');
            copy.setAttribute('label', ${scriptJson(t('复制 API Key'))});

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'blora-button';
            del.dataset.variant = 'danger';
            del.dataset.size = 'sm';
            del.textContent = ${scriptJson(t('删除'))};
            del.addEventListener('click', () => deleteKey(key.id));

            item.append(meta, copy, del);
            container.appendChild(item);
        }

        async function editKeyName(id, button) {
            const title = button.closest('.passport-ai-key-name');
            if (!title || title.querySelector('.passport-ai-key-name__input')) return;
            const text = title.querySelector('.passport-ai-key-name__text');
            const current = text ? text.textContent : '';
            const input = document.createElement('input');
            input.className = 'blora-input passport-ai-key-name__input';
            input.dataset.size = 'sm';
            input.type = 'text';
            input.maxLength = 100;
            input.value = current === ${scriptJson(t('未命名 Key'))} ? '' : current;
            title.replaceChildren(input);
            input.focus();
            input.select();

            let finished = false;
            const finish = async (save) => {
                if (finished) return;
                finished = true;
                const name = input.value.trim();
                if (!save) {
                    title.replaceChildren(text);
                    title.append(button);
                    return;
                }
                try {
                    const res = await fetch('/v1/keys/' + id, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name })
                    });
                    const data = await res.json();
                    if (!res.ok || !data.success) throw new Error(data.message || ${scriptJson(t('修改失败'))});
                    text.textContent = name || ${scriptJson(t('未命名 Key'))};
                    title.replaceChildren(text);
                    title.append(button);
                    await showBloraMessage(${scriptJson(t('Key 名称已更新'))}, 'success');
                } catch (e) {
                    title.replaceChildren(text);
                    title.append(button);
                    await showBloraMessage(e.message, 'error');
                }
            };
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') { event.preventDefault(); finish(true); }
                if (event.key === 'Escape') { event.preventDefault(); finish(false); }
            });
            input.addEventListener('blur', () => finish(true));
        }

        async function createKey() {
            const name = document.getElementById('newKeyName').value.trim();
            try {
                const res = await fetch('/v1/keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
                const data = await res.json();
                if (data.success) {
                    appendKeyItem(data.key);
                    document.getElementById('newKeyName').value = '';
                    await showBloraMessage(${scriptJson(t('Key 已创建，请立即复制保存'))}, 'success');
                } else {
                    await showBloraMessage(data.message || ${scriptJson(t('未知错误'))}, 'error');
                }
            } catch (e) {
                await showBloraMessage(${scriptJson(t('创建失败: '))} + e.message, 'error');
            }
        }

        async function deleteKey(id) {
            if (!confirm(${scriptJson(t('确定删除此 API Key？删除后无法恢复。'))})) return;
            try {
                const res = await fetch('/v1/keys/' + id, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    const el = document.getElementById('key-' + id);
                    if (el) el.remove();
                    const container = document.querySelector('#keyList .blora-list');
                    if (container && !container.querySelector('.blora-list__item')) {
                        document.getElementById('keyList').innerHTML = '<blora-empty title="${escapeHtml(t('暂无 API Key'))}" description="${escapeHtml(t('点击上方按钮创建一个 Key。'))}"></blora-empty>';
                    }
                } else {
                    await showBloraMessage(data.message || ${scriptJson(t('未知错误'))}, 'error');
                }
            } catch (e) {
                await showBloraMessage(${scriptJson(t('删除失败: '))} + e.message, 'error');
            }
        }

    </script>
</body>
</html>`;
}

function generateAdminEmailHtml(user) {
    const activePage = 'admin-email';
    const sf = (name, color = '0071e3') => `https://img.bloret.net/SF/${name}?color=%23${color}`;
    const avatarUrl = safeImageUrl(user.avatar, `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username || '')}&background=0078d4&color=fff&size=128`);

    return `
                                                        <!DOCTYPE html>
                                                        <html lang="${htmlLang()}">
                                                            <head>
                                                                <link rel="icon" href="/BL.png" type="image/png">
                                                                <link rel="apple-touch-icon" href="/BL.png">
                                                                <meta charset="UTF-8">
                                                                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                                                        <title>${t('群发邮件 - Bloret PassPort')}</title>
                                                                        <link rel="stylesheet" href="/index.css">
    <script src="/csrf-client.js"></script>
                                                                                                                                                        <style>
        /* 复用 generateUserPageHtml 中的样式 */
                                                                                .status-error {
                                                                                    background-color: rgba(255, 0, 0, 0.1);
                                                                                color: red;
                                                                                }
                                                                            </style>
                                                                        ${bloraAssetTags()}</head>
                                                                        <body class="blora-page blora-scope">
                                                                            ${generateSidebarHtml(user, 'admin-email')}


                                                                                <div class="main-content-apple">
                                                                                    <h1 class="page-title">${t('群发邮件 (管理员)')}</h1>

                                                                                    <div class="email-editor-card">
                                                                                        <div class="form-group">
                                                                                            <label class="form-label">${t('邮件标题')}</label>
                                                                                            <input class="blora-input" id="emailSubject" type="text" placeholder="${t('请输入邮件标题')}" style="width: 100%;" >
                                                                                        </div>

                                                                                        <div class="form-group">
                                                            <label class="form-label">${t('邮件内容 (支持HTML)')}</label>
                                                            <textarea class="blora-textarea" id="emailContent" style="width: 100%; height: 300px; display: block;" ></textarea>
                                                        </div>

                                                                                        <div style="display: flex; gap: 15px; align-items: center;">
                                                                                            <button type="button" class="blora-button" data-variant="primary" onclick="sendEmail()" >${t('发送给所有用户')}</button>
                                                                                            <span id="statusMsg" class="status-message"></span>
                                                                                        </div>
                                                                                    </div>

                                                                                    <div class="user-info-card blora-card">
                                                                                        <div class="post-title">${t('提示')}</div>
                                                                                        <div class="post-content">
                                                                                            <ul style="color: #555; font-size: 14px; line-height: 1.6;">
                                                                                                <li>${t('此功能将向数据库中所有已验证邮箱的用户发送邮件。')}</li>
                                                                                                <li>${t('发送过程在后台进行，点击发送后请勿重复点击。')}</li>
                                                                                                <li>${t('建议在内容中包含退订链接或说明。')}</li>
                                                                                            </ul>
                                                                                        </div>
                                                                                    </div>
                                                                                </div>

                                                                                <script>
                                                                                    ${sidebarScript}

                                                                                    async function sendEmail() {
            const subject = document.getElementById('emailSubject').value;
                                                                                    const content = document.getElementById('emailContent').value;
                                                                                    const statusEl = document.getElementById('statusMsg');

                                                                                    if (!subject || !content) {
                                                                                        statusEl.textContent = ${scriptJson(t('标题和内容不能为空'))};
                                                                                    statusEl.className = 'status-message status-error';
                                                                                    statusEl.style.display = 'block';
                                                                                    return;
            }

                                                                                    if (!confirm(${scriptJson(t('确定要向所有用户发送此邮件吗？此操作不可撤销。'))})) {
                return;
            }

                                                                                    statusEl.textContent = ${scriptJson(t('正在提交请求...'))};
                                                                                    statusEl.className = 'status-message';
                                                                                    statusEl.style.display = 'block';

                                                                                    try {
                const response = await fetch('/api/admin/send-email', {
                                                                                        method: 'POST',
                                                                                    headers: {
                                                                                        'Content-Type': 'application/json'
                    },
                                                                                    body: JSON.stringify({subject, content})
                });

                                                                                    const result = await response.json();

                                                                                    if (result.success) {
                                                                                        statusEl.textContent = result.message;
                                                                                    statusEl.className = 'status-message status-success';
                } else {
                                                                                        statusEl.textContent = ${scriptJson(t('发送失败: {message}'))}.replace('{message}', result.message);
                                                                                    statusEl.className = 'status-message status-error';
                }
            } catch (error) {
                                                                                        statusEl.textContent = ${scriptJson(t('请求出错: {message}'))}.replace('{message}', error.message);
                                                                                    statusEl.className = 'status-message status-error';
            }
                                                                                    statusEl.style.display = 'block';
        }
                                                                                </script>
                                                                        </body>
                                                                    </html>
                                                                    `;
}

module.exports = {
    app,
    generateLoginHtml,
    generatePlainLoginHtml,
    generateForgotPasswordHtml,
    generateResetPasswordHtml,
    generateResetPasswordSuccessHtml,
    generate2FALoginHtml,
    generatePlain2FALoginHtml,
    generateUserPageHtml,
    generateManagementPageHtml,
    generateEditOAuthAppHtml,
    generateOAuthAppDetailHtml,
    generateMyTokensHtml,
    generateAIPageHtml,
    getOAuthRedirectUris,
    isOAuthRedirectAllowed,
    isSafeLoginRedirect,
    resolveLoginRedirect,
    appendOAuthCallbackParams,
    getOAuthScope,
    isStandardOAuthRedirectAllowed,
    calculatePkceChallenge,
    isValidPkceVerifier,
    parseBearerToken,
};
